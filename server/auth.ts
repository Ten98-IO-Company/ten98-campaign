import { randomBytes, timingSafeEqual, createHmac, createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { and, count, eq, gt, isNotNull, sql } from 'drizzle-orm';
import { hashPassword as hashWithBetterAuth } from 'better-auth/crypto';
import type { ResetPasswordMessage, Ten98Auth, Ten98AuthSession } from '@ten98/runtime/auth';
import { clientLimitKey, parseTrustedProxies, resolveClientAddress } from '@ten98/runtime';
import type { Database, Executor } from './database.ts';
import { joinInvitation, lockInvitation } from './invitations.ts';
import { advisoryLock } from './locks.ts';
import { authDatabase, createCampaignAuth, LockedAuthUserNotFoundError, retireResetLinks, type CampaignAuth, type SignInLimit } from './locked-auth.ts';
import { accounts, instanceOperators, sessions, users, verifications } from './schema.ts';

export { advisoryLock, lockUser, lockWorkspace } from './locks.ts';

// Identity runs on Better Auth through the shared preset @ten98/runtime/auth (ten98-code-system#97), bound per locked
// transaction by server/locked-auth.ts. Campaign keeps its routes and wording, its rate limits, the first-sign-up claim,
// the OIDC protocol and invitations. This is the only module that writes the users, accounts and sessions tables.
export interface AuthConfig { appUrl: string; sessionSecret: string; authSecret: string; oidcEnabled?: boolean; oidcIssuer: string; oidcClientId: string; oidcClientSecret?: string; oidcAllowedEmails: string[]; trustedProxies?: string | string[] }
export interface PublicUser { id: string; name: string; email: string; isOperator: boolean }
type UserRow = { id: string; name: string; email: string; isOperator?: unknown };
type OidcFlow = { state: string; verifier: string; nonce: string; invite_hash: string | null };

const oidcWindow = 600, callbackPath = '/api/auth/oidc/callback';
// Password sign-in attempts per 15 minutes. One client reaches at most 10 attempts per account in a window (20 across two
// overlapping windows), so only failures from several clients can reach the account-wide limit.
export const signInLimits = { client: 30, clientAccount: 10, account: 50 };
export class HttpError extends Error { status: number; code?: string; constructor(status: number, message: string, code?: string) { super(message); this.status = status; if (code) this.code = code; } }
export const publicUser = (user: UserRow | null | undefined): PublicUser | null => user ? { id: user.id, name: user.name, email: user.email, isOperator: Boolean(user.isOperator) } : null;
function storedSecret(dataDir: string, provided: string | undefined, filename: string, label: string): string {
  if (provided) { if (provided.length < 32) throw new Error(`${label} must contain at least 32 characters.`); return provided; }
  const path = join(dataDir, filename);
  try { const value = readFileSync(path, 'utf8').trim(); if (value.length < 32) throw new Error(`The saved ${filename} is invalid.`); return value; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const value = randomBytes(48).toString('base64url');
    try { writeFileSync(path, value, { flag: 'wx', mode: 0o600 }); return value; }
    catch (race) { if ((race as NodeJS.ErrnoException).code === 'EEXIST') return storedSecret(dataDir, undefined, filename, label); throw race; }
  }
}
/** Keys saved integration credentials, direct-campaign secrets, rate-limit keys and OIDC flow digests. Never changes here. */
export const sessionSecret = (dataDir: string, provided?: string) => storedSecret(dataDir, provided, 'session-secret', 'SESSION_SECRET');
/**
 * Better Auth's own secret (session cookie signatures, two-factor secrets): AUTH_SECRET, or the file AUTH_SECRET_FILE
 * names, or DATA_DIR/auth-secret generated on first start like session-secret. Rotating it ends every session, reset
 * link and enrolled second factor. Local stand-in for the runtime's readSecret('AUTH_SECRET') (#131), which is not in
 * runtime 0.27.1; the generation stays here either way.
 */
export function authSecret(dataDir: string, env: { AUTH_SECRET?: string; AUTH_SECRET_FILE?: string } = {}): string {
  if (env.AUTH_SECRET && env.AUTH_SECRET_FILE) throw new Error('Set AUTH_SECRET or AUTH_SECRET_FILE, not both.');
  // A named file must hold the secret: falling back to a generated one would split the secret across replicas silently.
  const fromFile = env.AUTH_SECRET_FILE ? readFileSync(env.AUTH_SECRET_FILE, 'utf8').trim() : undefined;
  if (fromFile !== undefined && fromFile.length < 32) throw new Error('The file AUTH_SECRET_FILE names must hold at least 32 characters.');
  return storedSecret(dataDir, env.AUTH_SECRET || fromFile, 'auth-secret', 'AUTH_SECRET');
}
declare const credentialBrand: unique symbol;
/** A password hash that only hashPassword makes; account writes accept nothing else, so this module owns the hash format. */
export type Credential = string & { readonly [credentialBrand]: true };
/** The only call to the password hasher (Better Auth's, the one the preset verifies). Callers hash before taking locks. */
export const hashPassword = async (password: string): Promise<Credential> => await hashWithBetterAuth(password) as Credential;
export function cookies(req: IncomingMessage): Record<string, string> {
  return Object.fromEntries((req.headers.cookie || '').split(';').map(part => part.trim().split(/=(.*)/s)).filter(part => part[0]).map(([key, value]) => [key, value || '']));
}
const first = async <T>(query: Promise<{ rows: unknown[] }>): Promise<T | undefined> => (await query).rows[0] as T | undefined;
export const memberRole = async (executor: Executor, workspaceId: string, userId: string) => (await first<{ role: string }>(executor.execute(sql`SELECT role FROM memberships WHERE workspace_id = ${workspaceId} AND user_id = ${userId}`)))?.role;
/**
 * Creates an account inside the caller's transaction: the user and, with a password, its Better Auth credential account.
 * One of the approved direct account writes (setup, invitation acceptance, CLI create-user); sessions come only from
 * Better Auth after commit. A null password is an SSO-only account.
 */
export async function insertAccount(tx: Executor, account: { id: string; name: string; email: string; passwordHash: Credential | null }): Promise<void> {
  const now = new Date();
  await tx.insert(users).values({ id: account.id, name: account.name, email: account.email, createdAt: now, updatedAt: now });
  if (account.passwordHash) await tx.insert(accounts).values({ id: randomUUID(), accountId: account.id, providerId: 'credential', userId: account.id, password: account.passwordHash, createdAt: now, updatedAt: now });
}
/** The account with this (normalised) email, and whether it holds instance operator authority. */
export const accountByEmail = (executor: Executor, email: string) => first<{ id: string; name: string; email: string; isOperator: boolean }>(executor.execute(sql`SELECT id, name, email, EXISTS (SELECT 1 FROM instance_operators o WHERE o.user_id = ${users}.id) AS "isOperator" FROM ${users} WHERE email = ${email}`));
export const hasAnyAccount = async (executor: Executor) => (await executor.select({ id: users.id }).from(users).limit(1)).length > 0;
export const updateDisplayName = (executor: Executor, userId: string, name: string) => executor.update(users).set({ name, updatedAt: new Date() }).where(eq(users.id, userId));
const credentialOf = (userId: string) => and(eq(accounts.userId, userId), eq(accounts.providerId, 'credential'));
export const hasLocalPassword = async (executor: Executor, userId: string) => (await executor.select({ id: accounts.id }).from(accounts).where(and(credentialOf(userId), isNotNull(accounts.password))).limit(1)).length > 0;
/** Host recovery (CLI reset-password): under the user lock, replaces the local password, retires every reset link and ends every session. */
export function setLocalPassword(identity: CampaignAuth, db: Database, userId: string, passwordHash: Credential): Promise<void> {
  return identity.withLockedAuth(db, userId, async (auth, tx) => {
    await tx.update(accounts).set({ password: passwordHash, updatedAt: new Date() }).where(credentialOf(userId));
    await retireResetLinks(tx, userId);
    await auth.revokeAllSessions();
  });
}
/**
 * The host CLI's Better Auth instance. It ends sessions but never issues a cookie, so it needs neither the app URL nor
 * the app's auth secret; a throwaway secret satisfies the preset.
 */
export const hostAuth = (db: Database) => createCampaignAuth({ database: authDatabase(db), transactionDatabase: authDatabase, appUrl: 'http://127.0.0.1', secret: randomBytes(32).toString('hex'), appName: 'ten98 Campaign', legacyPasswords: true });
/** A reset link to email, handed to the sendResetPassword seam only after the transaction that created it committed. */
export type ResetLinkMessage = { email: string; token: string };
// Collects the reset token Better Auth hands to the preset's sendResetPassword during one request's locked transaction.
const resetCapture = new AsyncLocalStorage<ResetPasswordMessage[]>();

type OpenIdClient = typeof import('openid-client');
// The OIDC client loader is injectable so tests can exercise the real flow without an identity provider. sendResetPassword
// delivers a reset link (the app's transactional email); without it the link is only returned to the caller.
export function createAuth(db: Database, config: AuthConfig, { openidClient = () => import('openid-client'), sendResetPassword }: { openidClient?: () => Promise<OpenIdClient>; sendResetPassword?: (message: ResetLinkMessage) => void | Promise<void> } = {}) {
  const digest = (value: string) => createHmac('sha256', config.sessionSecret).update(value).digest('hex');
  const proxies = (() => { try { return parseTrustedProxies([config.trustedProxies ?? ''].flat().join(',')); } catch { throw new Error('TRUSTED_PROXIES must be a comma-separated list of IP addresses or CIDR ranges.'); } })();
  // A rate-limit key per client and scope (ten98-code-system#76). The shared resolver ignores X-Forwarded-For unless the
  // peer is a trusted proxy; clientLimitKey derives the key with HMAC, groups IPv6 per /56, and gives an unresolved client
  // (an invalid peer, or a missing, malformed or all-trusted chain behind a trusted proxy) its own `<scope>:unresolved` key.
  const clientKey = (req: IncomingMessage, scope: string): string => clientLimitKey(scope, resolveClientAddress(req.socket?.remoteAddress, req.headers?.['x-forwarded-for'] as string | undefined, proxies), config.sessionSecret);
  // Cookies are shared across ports; the configured origin is part of every cookie name so local instances can coexist.
  const origin = new URL(config.appUrl).origin, secure = origin.startsWith('https:'), scope = createHash('sha256').update(origin).digest('hex').slice(0, 16);
  const oidcName = 'ten98_oidc_' + scope, inviteName = 'ten98_oidc_invite_' + scope;
  // Better Auth names the session cookie from this prefix (with __Secure- on https): the app and its origin, so neither
  // another instance on this host nor another Ten98 app behind the same origin shares it. Campaign's own pre-Better Auth
  // cookie is only recognised so a browser that still sends it is told its session ended and has it cleared (#97 session
  // reset). The unscoped `ten98_session` is left alone: any instance on this host may have set it, and with the old
  // sessions table gone this one can no longer tell whether it is its own.
  const prefix = 'ten98-campaign-' + scope, sessionCookie = `${secure ? '__Secure-' : ''}${prefix}.session_token`, retiredCookies = ['ten98_session_' + scope];
  const identity = createCampaignAuth({
    database: authDatabase(db), transactionDatabase: authDatabase, appUrl: config.appUrl, secret: config.authSecret, appName: 'ten98 Campaign',
    cookiePrefix: prefix, legacyPasswords: true, sendResetPassword: message => { resetCapture.getStore()?.push(message); },
  });
  function cookie(name: string, value: string, age: number, path = '/') {
    return `${name}=${value}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${age}${secure ? '; Secure' : ''}`;
  }
  function setCookie(res: ServerResponse, value: string) {
    const previous = res.getHeader?.('Set-Cookie'), name = value.slice(0, value.indexOf('='));
    const values = [value, ...(Array.isArray(previous) ? previous : previous ? [previous] : []).map(String).filter(item => !item.startsWith(name + '='))];
    res.setHeader('Set-Cookie', values.length === 1 ? values[0] : values);
  }
  const forward = (res: ServerResponse | undefined, response: Response) => { if (res) for (const value of response.headers.getSetCookie()) setCookie(res, value); };
  const headers = (req?: IncomingMessage) => {
    const values = new Headers({ origin, 'content-type': 'application/json' });
    if (req?.headers.cookie) values.set('cookie', req.headers.cookie);
    return values;
  };
  /** A Better Auth endpoint, called on the server through the handler; only the paths named in this module are reached. */
  const call = (auth: Ten98Auth, path: string, req: IncomingMessage | undefined, body?: unknown) => auth.handler(new Request(origin + '/api/auth' + path, { method: body === undefined ? 'GET' : 'POST', headers: headers(req), ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const errorCode = async (response: Response) => ((await response.json().catch(() => ({}))) as { code?: string }).code;
  const isOperator = async (executor: Executor, userId: string) => (await executor.select({ id: instanceOperators.user_id }).from(instanceOperators).where(eq(instanceOperators.user_id, userId))).length > 0;
  // The session each request resolved, so a guard can re-check it inside its own transaction.
  const resolved = new WeakMap<IncomingMessage, string>();
  const sessionCookieValue = (req: IncomingMessage) => cookies(req)[sessionCookie] ?? '';
  async function user(req: IncomingMessage, res?: ServerResponse): Promise<PublicUser | null> {
    if (!/^[A-Za-z0-9]+\.[A-Za-z0-9%+/=_-]+$/.test(sessionCookieValue(req))) return null;
    const response = await call(identity, '/get-session', req);
    forward(res, response);
    const found = response.ok ? await response.json() as Ten98AuthSession | null : null;
    if (!found) return null;
    resolved.set(req, found.session.token);
    return { id: found.user.id, name: found.user.name, email: found.user.email, isOperator: await isOperator(db, found.user.id) };
  }
  // One conditional upsert: parallel attempts cannot all pass a separate read before any of them increments.
  async function limit(key: string, maximum = 10): Promise<void> {
    const now = Date.now();
    await db.execute(sql`DELETE FROM login_limits WHERE expires_at <= ${now}`);
    const counted = await db.execute(sql`INSERT INTO login_limits VALUES (${key}, 1, ${now + 900000}) ON CONFLICT (key) DO UPDATE SET count = login_limits.count + 1 WHERE login_limits.count < ${maximum}`);
    if (!counted.rowCount) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
  }
  /**
   * Signs in with a password through the preset's signInWithPassword (verified outside any transaction, then again under
   * the account lock, where the session is created); null when the email or password is wrong. `allow` is the attempt's
   * rate limit.
   */
  async function signIn(req: IncomingMessage, res: ServerResponse, email: string, password: string, allow: SignInLimit): Promise<PublicUser | null> {
    const response = await identity.signInWithPassword(db, { email, password, headers: headers(req) }, allow);
    if (response.status === 429) throw new HttpError(429, 'Too many attempts. Try again in 15 minutes.');
    if (response.status === 503) throw new HttpError(503, 'Sign-in is busy. Try again shortly.');
    if (!response.ok) return null;
    const signedIn = await response.clone().json() as { twoFactorRedirect?: boolean; user?: { id?: string } };
    // Campaign offers no two-factor enrolment yet (#285), so no account can reach Better Auth's second-factor challenge.
    if (signedIn.twoFactorRedirect) throw new HttpError(403, 'Two-factor sign-in is not available in Campaign yet.');
    const userId = signedIn.user?.id;
    if (!userId) return null;
    // The account the new session belongs to, read before its cookie is sent: an account removed since the locked
    // transaction committed gets neither a user nor a cookie.
    const row = (await db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(eq(users.id, userId)))[0];
    if (!row) return null;
    forward(res, response);
    return publicUser({ ...row, isOperator: await isOperator(db, userId) });
  }
  /** Issues a session for an account the OIDC flow verified (after its transaction committed). */
  async function signInVerified(req: IncomingMessage, res: ServerResponse, userId: string): Promise<void> {
    const response = await identity.withLockedAuth(db, userId, auth => auth.api.completeOidcSession({ body: { oidcUserId: userId }, headers: headers(req), asResponse: true }));
    if (!response.ok) throw new HttpError(400, 'Identity sign-in could not be completed. Start again.');
    forward(res, response);
  }
  function clearSessionCookies(req: IncomingMessage, res: ServerResponse) {
    const present = cookies(req);
    for (const name of [sessionCookie, ...retiredCookies]) if (Object.hasOwn(present, name)) setCookie(res, cookie(name, '', 0));
  }
  let oidcConfig: import('openid-client').Configuration | undefined;
  async function oidc() {
    const client = await openidClient();
    // ID token signatures are checked against the issuer's JWKS rather than relying on the TLS channel alone.
    if (!oidcConfig) oidcConfig = await client.discovery(new URL(config.oidcIssuer), config.oidcClientId, config.oidcClientSecret || undefined, undefined, { execute: [client.enableNonRepudiationChecks] });
    return { client, provider: oidcConfig };
  }
  // The invitation token rides in a callback-scoped cookie as "<expiresAt>.<token>"; the database keeps only its keyed hash.
  function invitation(req: IncomingMessage, stored: string | null): string {
    const value = cookies(req)[inviteName] || '', [expires, token = ''] = value.split(/\.(.*)/s);
    if (!stored || !/^[A-Za-z0-9_-]{43}$/.test(token) || !(Number(expires) > Date.now())) return '';
    return timingSafeEqual(Buffer.from(digest(value)), Buffer.from(stored)) ? token : '';
  }
  return {
    user, limit, clientKey,
    /** Signs in an account that setup or invitation acceptance has just created and committed; no sign-in limit applies. */
    signInNewAccount: (req: IncomingMessage, res: ServerResponse, email: string, password: string) => signIn(req, res, email, password, () => true),
    /** Whether the request carries a session cookie of this installation, current or retired, so an ended session can be reported once. */
    carriesSession: (req: IncomingMessage) => /^[A-Za-z0-9]+\./.test(sessionCookieValue(req)) || retiredCookies.some(name => Object.hasOwn(cookies(req), name)),
    /** A SQL condition that holds while the session this request resolved is live for `userId`, for guards that read it with other state in one statement. */
    liveSession: (req: IncomingMessage, userId: string) => sql`EXISTS (${db.select({ one: sql`1` }).from(sessions).where(and(eq(sessions.token, identity.sessionTokenKey(resolved.get(req) ?? '')), eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())))})`,
    async account(userId: string) {
      const [{ active }] = await db.select({ active: count() }).from(sessions).where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, new Date())));
      return { localPassword: await hasLocalPassword(db, userId), activeSessions: active };
    },
    /**
     * Self-service password recovery (#284), as Discover offers it. A request for an account with a local password
     * replaces its reset link with a new one valid for one hour and returns the token to email after commit; any other
     * address returns null, and the route answers both the same way.
     */
    async requestPasswordReset(req: IncomingMessage, email: string): Promise<{ email: string; token: string } | null> {
      await limit(clientKey(req, 'password-recovery-request'), 20); await limit('password-recovery-email:' + digest(email), 3);
      const found = await accountByEmail(db, email);
      if (!found || !await hasLocalPassword(db, found.id)) return null;
      const captured: ResetPasswordMessage[] = [];
      await resetCapture.run(captured, () => identity.withLockedAuth(db, found.id, async (auth, tx) => {
        // Checked again under the lock: Better Auth would issue a link to an SSO-only account too.
        if (!await hasLocalPassword(tx, found.id)) return;
        await retireResetLinks(tx, found.id);
        const response = await call(auth, '/request-password-reset', undefined, { email: found.email });
        if (!response.ok) throw new HttpError(500, 'The reset link could not be created.');
      }));
      const message = captured.at(-1);
      if (!message) return null;
      // The sendResetPassword seam: the link goes out only after the transaction that created it committed.
      await sendResetPassword?.({ email: found.email, token: message.token });
      return { email: found.email, token: message.token };
    },
    /** Sets a new password from an unexpired reset link, which it uses up, and ends every session of that account. */
    async resetPassword(req: IncomingMessage, token: string, password: string): Promise<void> {
      await limit(clientKey(req, 'password-recovery-reset'), 60); await limit('password-recovery-token:' + digest(token), 5);
      const invalid = () => new HttpError(400, 'This link is invalid, expired or already used. Request a new link.');
      if (!/^[A-Za-z0-9]{24}$/.test(token)) throw invalid();
      // The link is only a hint for which account to lock; Better Auth checks and uses it up again under that lock.
      const link = (await db.select({ userId: verifications.value, expiresAt: verifications.expiresAt }).from(verifications).where(eq(verifications.identifier, identity.storedVerificationIdentifier('reset-password:' + token))))[0];
      const userId = link && link.expiresAt > new Date() ? link.userId : undefined;
      if (!userId) throw invalid();
      await identity.withLockedAuth(db, userId, async (auth, tx) => {
        // Better Auth's reset creates a credential when there is none, so an SSO-only account must never reach it.
        if (!await hasLocalPassword(tx, userId)) throw invalid();
        if (!(await call(auth, '/reset-password', undefined, { token, newPassword: password })).ok) throw invalid();
        await retireResetLinks(tx, userId);
      }).catch(error => { throw error instanceof LockedAuthUserNotFoundError ? invalid() : error; });
    },
    revokeOtherSessions(req: IncomingMessage, userId: string): Promise<number> {
      return identity.withLockedAuth(db, userId, async auth => {
        const current = await auth.api.getSession({ headers: headers(req), query: { disableRefresh: true } });
        if (current?.user.id !== userId) throw new HttpError(403, 'Your sign-in session ended. Sign in again.');
        return (await auth.api.revokeOtherSessions({ headers: headers(req) })).revoked;
      });
    },
    async changePassword(req: IncomingMessage, res: ServerResponse, userId: string, currentPassword: string, newPassword: string): Promise<void> {
      await limit('password:' + userId);
      await identity.withLockedAuth(db, userId, async (auth, tx) => {
        // Under the account lock, a session revoked before this point is refused and one revoked later waits for this commit.
        const current = await auth.api.getSession({ headers: headers(req), query: { disableRefresh: true } });
        if (current?.user.id !== userId) throw new HttpError(403, 'Your sign-in session ended. Sign in again before changing your password.');
        const response = await call(auth, '/change-password', req, { currentPassword, newPassword, revokeOtherSessions: true });
        if (!response.ok) throw await errorCode(response) === 'INVALID_PASSWORD' ? new HttpError(400, 'The current password is incorrect.') : new HttpError(400, 'Your password could not be changed.');
        // A new password retires any outstanding reset link (#284).
        await retireResetLinks(tx, userId);
        forward(res, response);
      });
    },
    async login(req: IncomingMessage, res: ServerResponse, body: { email: string; password: string }): Promise<PublicUser | null> {
      const client = clientKey(req, 'ip');
      let clientAccount = '';
      // Campaign's three buckets, which the preset counts before any read or hash; the first one that is full refuses (429).
      const allow: SignInLimit = async ({ email }) => {
        clientAccount = 'client-email:' + digest(JSON.stringify([client, email]));
        try {
          await limit(client, signInLimits.client);
          await limit(clientAccount, signInLimits.clientAccount);
          // When #140 adds knownDevice, a known device skips only this account-wide bucket: `if (!knownDevice)` here.
          await limit('email:' + digest(email), signInLimits.account);
          return true;
        } catch (error) { if (error instanceof HttpError && error.status === 429) return false; throw error; }
      };
      const signedIn = await signIn(req, res, body.email, body.password, allow);
      if (!signedIn) throw new HttpError(401, 'Email or password is incorrect.');
      await db.execute(sql`DELETE FROM login_limits WHERE key = ${clientAccount}`);
      return signedIn;
    },
    async logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const current = await user(req);
      if (current) forward(res, await identity.withLockedAuth(db, current.id, auth => call(auth, '/sign-out', req, {})));
      clearSessionCookies(req, res);
    },
    // The GET start and the callback are full-page navigations, so a failure redirects to the app with a fixed code (never
    // the message or an email address); the sign-in screen maps the code to its text. An invitation the browser already
    // holds is kept, in the #invite= fragment. GET start still reads ?invite= from clients made before the POST start.
    async oidcStart(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const held = new URL(req.url || '/api/auth/oidc/start', config.appUrl).searchParams.get('invite');
      try { const location = await startFlow(req, res, held); res.writeHead(302, { Location: location }); res.end(); }
      catch (error) { signInError(res, error, held && /^[A-Za-z0-9_-]{43}$/.test(held) ? held : ''); }
    },
    /** Invitation sign-in: the token comes in the POST body, and the caller returns the authorization URL as JSON. */
    oidcAuthorize(req: IncomingMessage, res: ServerResponse, invite: string | null): Promise<string> { return startFlow(req, res, invite); },
    async oidcCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
      const held = { invite: '' };
      try { await finishFlow(req, res, url, held); } catch (error) { signInError(res, error, held.invite); }
    },
  };
  function signInError(res: ServerResponse, error: unknown, invite: string) {
    const code = error instanceof HttpError && error.code ? error.code : error instanceof HttpError && error.status === 429 ? 'OIDC_RATE_LIMITED' : 'OIDC_SIGN_IN_FAILED';
    if (res.headersSent) { res.end(); return; }
    res.writeHead(302, { Location: `${config.appUrl}/?auth_error=${code}${invite ? '#invite=' + encodeURIComponent(invite) : ''}` }); res.end();
  }
  async function startFlow(req: IncomingMessage, res: ServerResponse, invite: string | null): Promise<string> {
      if (!config.oidcEnabled || !await hasAnyAccount(db)) throw new HttpError(400, 'Identity sign-in is unavailable.');
      await limit(clientKey(req, 'oidc'), 30);
      const { client, provider } = await oidc();
      if (invite && !/^[A-Za-z0-9_-]{43}$/.test(invite)) throw new HttpError(400, 'Use a valid invitation link before signing in.');
      const state = client.randomState(), nonce = client.randomNonce(), verifier = client.randomPKCECodeVerifier(), browser = randomBytes(32).toString('base64url'), expires = Date.now() + oidcWindow * 1000;
      const continuation = invite ? `${expires}.${invite}` : '';
      await db.transaction(async tx => {
        await tx.execute(sql`DELETE FROM oidc_flows WHERE expires_at <= ${Date.now()}`);
        await tx.execute(sql`INSERT INTO oidc_flows VALUES (${digest(state)}, ${digest(browser)}, ${verifier}, ${nonce}, ${expires})`);
        if (continuation) await tx.execute(sql`INSERT INTO oidc_return_targets VALUES (${digest(state)}, ${digest(continuation)})`);
      });
      const location = client.buildAuthorizationUrl(provider, { redirect_uri: config.appUrl + callbackPath, scope: 'openid email profile', state, nonce, code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256' });
      // Without an invitation no hash is stored, so a stale continuation cookie is ignored and cleared at the callback.
      if (continuation) setCookie(res, cookie(inviteName, continuation, oidcWindow, callbackPath));
      setCookie(res, cookie(oidcName, browser, oidcWindow));
      return location.href;
  }
  async function finishFlow(req: IncomingMessage, res: ServerResponse, url: URL, held: { invite: string }): Promise<void> {
      const values = cookies(req), scoped = Object.hasOwn(values, oidcName), state = url.searchParams.get('state'), browser = scoped ? values[oidcName] : values.ten98_oidc;
      setCookie(res, cookie(inviteName, '', 0, callbackPath));
      if (!state || !browser || url.searchParams.getAll('state').length !== 1) throw new HttpError(400, 'Identity sign-in expired. Start again.');
      // Single use: the DELETE claims the flow atomically; the CTE reads its return target before the cascade removes it.
      const flow = await first<OidcFlow>(db.execute(sql`WITH f AS (DELETE FROM oidc_flows WHERE state = ${digest(state)} AND browser = ${digest(browser)} AND expires_at > ${Date.now()} RETURNING state, verifier, nonce) SELECT f.state, f.verifier, f.nonce, r.invite_hash FROM f LEFT JOIN oidc_return_targets r ON r.state = f.state`));
      if (!flow) throw new HttpError(400, 'Identity sign-in expired or was already used.');
      if (!scoped) setCookie(res, cookie('ten98_oidc', '', 0));
      setCookie(res, cookie(oidcName, '', 0));
      const invite = invitation(req, flow.invite_hash); held.invite = invite;
      try {
        const { client, provider } = await oidc();
        const tokens = await client.authorizationCodeGrant(provider, url, { pkceCodeVerifier: flow.verifier, expectedState: state, expectedNonce: flow.nonce, idTokenExpected: true });
        const claims = tokens.claims();
        if (!claims?.sub || typeof claims.sub !== 'string' || claims.sub.length > 1024) throw new Error('Missing subject.');
        let joined = false;
        // Provisioning commits first; Better Auth then issues the session for the verified account.
        const userId = await db.transaction(async tx => {
          // A usable invitation (re-checked under its workspace and row locks) provisions its exact verified email into that
          // workspace only; an unusable one leaves the allowlist rules in place.
          const invited = invite ? await lockInvitation(tx, invite).catch(error => { if (error instanceof HttpError) return undefined; throw error; }) : undefined;
          await advisoryLock(tx, 'oidc:' + JSON.stringify([claims.iss, claims.sub]));
          const existing = await first<{ user_id: string }>(tx.execute(sql`SELECT user_id FROM oidc_identities WHERE issuer = ${claims.iss} AND subject = ${claims.sub}`));
          if (existing) return existing.user_id;
          const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
          if (claims.email_verified !== true) throw new HttpError(403, 'Verify this email address with your identity provider first.', 'OIDC_EMAIL_UNVERIFIED');
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new HttpError(403, 'This identity is not provisioned. Ask the operator for access.', 'OIDC_NOT_PROVISIONED');
          if (invited && invited.email !== email) throw new HttpError(403, `This invitation is for ${invited.email}. Sign in with that identity to accept it.`, 'OIDC_INVITE_EMAIL_MISMATCH');
          if (!invited && !config.oidcAllowedEmails.includes(email)) throw new HttpError(403, 'This identity is not provisioned. Ask the operator for access.', 'OIDC_NOT_PROVISIONED');
          await advisoryLock(tx, 'email:' + email);
          if (await accountByEmail(tx, email)) throw new HttpError(403, 'This email already has an account. Automatic identity linking is disabled.', 'OIDC_ACCOUNT_EXISTS');
          const id = randomUUID(), workspace = randomUUID();
          await insertAccount(tx, { id, name: typeof claims.name === 'string' ? claims.name.slice(0, 120) : email, email, passwordHash: null });
          await tx.execute(sql`INSERT INTO oidc_identities VALUES (${claims.iss}, ${claims.sub}, ${id})`);
          if (invited) { await joinInvitation(tx, invited, id); joined = true; return id; }
          await tx.execute(sql`INSERT INTO workspaces (id, name) VALUES (${workspace}, 'My workspace')`);
          await tx.execute(sql`INSERT INTO memberships VALUES (${workspace}, ${id}, 'owner')`);
          await tx.execute(sql`INSERT INTO projects (id, workspace_id, name) VALUES (${randomUUID()}, ${workspace}, 'My project')`);
          return id;
        });
        await signInVerified(req, res, userId);
        res.writeHead(302, { Location: config.appUrl + '/' + (invite && !joined ? '#invite=' + encodeURIComponent(invite) : '') }); res.end();
      } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Identity sign-in could not be verified. Start again.'); }
  }
}
