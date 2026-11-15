import { createTen98Auth, ten98AuthPolicy, verifyLegacyScryptHash, type Ten98Auth, type Ten98AuthOptions } from '@ten98/runtime/auth';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { and, eq, like, sql } from 'drizzle-orm';
import type { Database, Executor, Transaction } from './database.ts';
import { accounts, sessions, twoFactors, users, verifications } from './schema.ts';

// Stand-in for the @ten98/runtime/auth release with keyed-hash token storage and locked transactions (ten98-code-system
// #131 and #132, built in code-system PR #140, not released yet). It keeps that release's names and signatures:
// createCampaignAuth takes createTen98Auth's options plus `transactionDatabase`, and returns the same withLockedAuth,
// withLockedAuthByEmail, sessionTokenKey, storedVerificationIdentifier and api.revokeOtherSessions. Adopting the release
// replaces createCampaignAuth with createTen98Auth and deletes this file's body. Until then tokens and identifiers are
// stored as Better Auth 1.7.7 stores them (in clear), which is why Campaign's auth core must not merge before #131.

/** Better Auth's models over Campaign's tables (migrations/0013_better_auth.sql). */
export const authSchema = { user: users, account: accounts, session: sessions, verification: verifications, twoFactor: twoFactors };
export const authDatabase = (executor: Executor) => drizzleAdapter(executor, { provider: 'pg', schema: authSchema });
/** The release's email lock key (the team controller's emailLockKey default). */
const emailLockKey = 109859;

export interface CampaignAuthOptions extends Ten98AuthOptions {
  transactionDatabase(tx: Transaction): Ten98AuthOptions['database'];
  /** As #140: concurrent password verifications in this process (2), waiting at most (100), each for at most waitMs (15000). */
  passwordVerification?: { concurrency?: number; queue?: number; waitMs?: number };
  /** As #140: how long a locked transaction's lock statements may wait, in milliseconds (5000). */
  lockTimeoutMs?: number;
}
type HeaderInput = Parameters<Ten98Auth['api']['getSession']>[0]['headers'];
type RevokeOtherSessions = (input: { headers: HeaderInput }) => Promise<{ status: true; revoked: number }>;
type Surface = Omit<Ten98Auth, 'api'> & {
  api: Ten98Auth['api'] & { revokeOtherSessions: RevokeOtherSessions };
  /** The stored session.token for a raw session token. The release stores a keyed hash; 1.7.7 stores the token itself. */
  sessionTokenKey(token: string): string;
  /** The stored verification.identifier for a raw identifier. The release stores a keyed hash; 1.7.7 stores it as given. */
  storedVerificationIdentifier(identifier: string): string;
};
/** The transaction-bound instance withLockedAuth hands out. */
export type LockedTen98Auth = Surface & { readonly userId: string | undefined; revokeAllSessions(): Promise<void> };
export type CampaignAuth = Surface & {
  withLockedAuth<T>(db: Database, userId: string, run: (auth: LockedTen98Auth, tx: Transaction) => Promise<T>): Promise<T>;
  withLockedAuthByEmail<T>(db: Database, email: string, run: (auth: LockedTen98Auth, tx: Transaction, userId: string | undefined) => Promise<T>): Promise<T>;
  signInWithPassword(db: Database, input: PasswordSignIn, limit: SignInLimit): Promise<Response>;
};
/** As the release: the user withLockedAuth was asked to lock does not exist. */
export class LockedAuthUserNotFoundError extends Error { readonly status = 404; readonly code = 'USER_NOT_FOUND'; constructor() { super('The account does not exist.'); } }

function surface(options: Ten98AuthOptions): Surface {
  const auth = createTen98Auth(options), base = new URL(options.appUrl).origin + '/api/auth';
  const call = (path: string, headers: HeaderInput, body?: string) => auth.handler(new Request(base + path, { method: body === undefined ? 'GET' : 'POST', headers: new Headers({ ...Object.fromEntries(new Headers(headers)), 'content-type': 'application/json' }), ...(body === undefined ? {} : { body }) }));
  // As the release: `revoked` counts the caller's other live sessions, which Better Auth 1.7.7's endpoint does not report.
  const revokeOtherSessions: RevokeOtherSessions = async ({ headers }) => {
    const listed = await call('/list-sessions', headers);
    if (!listed.ok) throw Object.assign(new Error('Sign in again.'), { status: listed.status });
    const live = (await listed.json() as unknown[]).length;
    const response = await call('/revoke-other-sessions', headers, '{}');
    if (!response.ok) throw Object.assign(new Error('Other sessions could not be signed out.'), { status: response.status });
    return { status: true, revoked: Math.max(0, live - 1) };
  };
  return Object.assign(auth, { api: Object.assign(auth.api, { revokeOtherSessions }), sessionTokenKey: (token: string) => token, storedVerificationIdentifier: (identifier: string) => identifier });
}

function bound(options: CampaignAuthOptions, tx: Transaction, userId: string | undefined): LockedTen98Auth {
  const auth = surface({ ...options, database: options.transactionDatabase(tx) });
  // #132 gives the bound instance a typed revokeAllSessions(); this cast to Better Auth's internal adapter goes with the swap.
  const internal = (auth as unknown as { $context: Promise<{ internalAdapter: { deleteUserSessions(userId: string): Promise<void> } }> }).$context;
  return Object.assign(auth, { userId, revokeAllSessions: async () => { if (userId) await (await internal).internalAdapter.deleteUserSessions(userId); } });
}
// The release locks FOR NO KEY UPDATE, so foreign-key checks on other rows still pass; it still conflicts with lockUser.
const lockAccount = async (tx: Transaction, userId: string) => (await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for('no key update')).length > 0;

export function createCampaignAuth(options: CampaignAuthOptions): CampaignAuth {
  const { transactionDatabase: _bindings, passwordVerification, lockTimeoutMs = 5000, ...presetOptions } = options;
  const slots = boundedSlots(passwordVerification), origin = new URL(options.appUrl).origin;
  // As #140: every locked transaction first bounds how long its lock statements may wait.
  const limitLockWaits = (tx: Transaction) => tx.execute(sql`SELECT set_config('lock_timeout', ${`${lockTimeoutMs}ms`}, true)`);
  const byEmail = <T>(db: Database, address: string, run: (auth: LockedTen98Auth, tx: Transaction, userId: string | undefined) => Promise<T>) => db.transaction(async tx => {
    await limitLockWaits(tx);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${emailLockKey}, hashtext(${address}))`);
    const userId = (await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = lower(${address})`).for('no key update'))[0]?.id;
    return run(bound(options, tx, userId), tx, userId);
  });
  const auth: CampaignAuth = Object.assign(surface(presetOptions), {
    withLockedAuth<T>(db: Database, userId: string, run: (auth: LockedTen98Auth, tx: Transaction) => Promise<T>): Promise<T> {
      return db.transaction(async tx => {
        await limitLockWaits(tx);
        if (!await lockAccount(tx, userId)) throw new LockedAuthUserNotFoundError();
        return run(bound(options, tx, userId), tx);
      });
    },
    // As #140: the email lock (normalised as the team controller's lockEmail), then the account row when there is one.
    withLockedAuthByEmail<T>(db: Database, email: string, run: (auth: LockedTen98Auth, tx: Transaction, userId: string | undefined) => Promise<T>): Promise<T> {
      return byEmail(db, email.trim().toLowerCase(), run);
    },
    // Stand-in for #140's signInWithPassword at 7eb5d7e (ten98-code-system#132), in its order: cross-site refusal, the
    // app's limit, a bounded verification slot, one short pool read, both verifiers outside any transaction, and only for a
    // correct password the locked sign-in. Stricter than 7eb5d7e in step 4 (Campaign's security review, raised for #140):
    // no locked account row means no signInEmail, and a session for any other account is rolled back.
    async signInWithPassword(db: Database, input: PasswordSignIn, limit: SignInLimit): Promise<Response> {
      const { email, password, rememberMe, headers } = input;
      if (crossSite(headers, origin)) return refusal(403, 'CROSS_SITE_SIGN_IN', 'Sign in from this site.');
      const address = email.trim().toLowerCase();
      // 1. The app's limits, counted before any read or hash.
      if (await limit({ email: address }) !== true) return refusal(429, 'TOO_MANY_ATTEMPTS', 'Too many sign-in attempts. Try again later.');
      if (password.length > ten98AuthPolicy.password.maxLength) return refused();
      // 2. A verification slot, so concurrent guesses cannot queue without bound on the hashing threads.
      const release = await slots();
      if (!release) return refusal(503, 'SIGN_IN_BUSY', 'Sign-in is busy. Try again shortly.', { 'retry-after': '1' });
      let verified: boolean;
      try {
        // 3. One short pool read; its connection is back in the pool before any hashing starts.
        const [stored] = await db.select({ password: accounts.password }).from(users).leftJoin(accounts, and(eq(accounts.userId, users.id), eq(accounts.providerId, 'credential'))).where(sql`lower(${users.email}) = lower(${address})`).limit(1);
        verified = await verifyStoredPassword(stored?.password, password);
      } finally { release(); }
      if (!verified) return refused();
      // 4. Only a correct password takes the lock; Better Auth verifies again there and creates the session.
      const response = await byEmail(db, address, async (bound, _tx, userId) => {
        if (!userId) return refused();
        const signedIn = await bound.api.signInEmail({ body: { email: address, password, ...(rememberMe === undefined ? {} : { rememberMe }) }, ...(headers === undefined ? {} : { headers }), asResponse: true });
        const body = signedIn.ok ? await signedIn.clone().json() as { twoFactorRedirect?: boolean; user?: { id?: string } } : undefined;
        if (body && !body.twoFactorRedirect && body.user?.id !== userId) throw new SignInMismatch();
        return signedIn;
      }).catch(error => { if (error instanceof SignInMismatch) return refused(); throw error; });
      return response.status === 401 ? refused() : response;
    },
  });
  return auth;
}
export type PasswordSignIn = { email: string; password: string; rememberMe?: boolean; headers?: HeaderInput };
/** The app's sign-in limits for one attempt; anything but true answers 429. #140 will add `knownDevice`. */
export type SignInLimit = (attempt: { email: string }) => boolean | Promise<boolean>;
class SignInMismatch extends Error {}
const refusal = (status: number, code: string, message: string, headers: Record<string, string> = {}) => new Response(JSON.stringify({ code, message }), { status, headers: { 'content-type': 'application/json', ...headers } });
/** One answer for an unknown email, a wrong password and an account without a password. */
const refused = () => refusal(401, 'INVALID_EMAIL_OR_PASSWORD', 'Invalid email or password');
/** A browser request from another site: an Origin other than the app's, or Sec-Fetch-Site cross-site or same-site (as #140). */
function crossSite(headers: HeaderInput | undefined, origin: string): boolean {
  if (headers === undefined) return false;
  const given = new Headers(headers), from = given.get('origin'), site = given.get('sec-fetch-site');
  return (from !== null && from !== origin) || site === 'cross-site' || site === 'same-site';
}
/**
 * At most `concurrency` verifications at once and `queue` waiting, each for at most `waitMs`; past either bound the
 * attempt gets 503. Ported from #140 at 7eb5d7e (src/auth.mts boundedSlots, MIT, ten98-code-system), defaults included.
 */
function boundedSlots({ concurrency = 2, queue = 100, waitMs = 15_000 }: NonNullable<CampaignAuthOptions['passwordVerification']> = {}) {
  let active = 0;
  const waiting: (() => void)[] = [];
  const handOver = () => { const next = waiting.shift(); if (next) next(); else active--; };
  const once = () => { let done = false; return () => { if (!done) { done = true; handOver(); } }; };
  return (): Promise<(() => void) | undefined> => {
    if (active < concurrency) { active++; return Promise.resolve(once()); }
    if (waiting.length >= queue) return Promise.resolve(undefined);
    return new Promise(resolve => {
      const take = () => { clearTimeout(timer); resolve(once()); };
      const timer = setTimeout(() => { waiting.splice(waiting.indexOf(take), 1); resolve(undefined); }, waitMs);
      timer.unref();
      waiting.push(take);
    });
  };
}

// Both verifiers on every attempt, as #140: unknown, legacy and modern accounts all run the legacy and the modern verifier once.
const legacyFormat = /^scrypt\$[0-9a-f]{32}\$[0-9a-f]{128}$/, dummyLegacy = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;
let dummyModern: Promise<string> | undefined;
export interface PasswordVerifiers { legacy(hash: string, password: string): Promise<boolean>; modern(input: { hash: string; password: string }): Promise<boolean> }
const presetVerifiers: PasswordVerifiers = { legacy: verifyLegacyScryptHash, modern: verifyPassword };
/** Step 3: whether `password` matches the stored hash (undefined for no account or no local password), at constant cost. */
export async function verifyStoredPassword(hash: string | null | undefined, password: string, verifiers: PasswordVerifiers = presetVerifiers): Promise<boolean> {
  const legacy = Boolean(hash && legacyFormat.test(hash));
  const [legacyOk, modernOk] = await Promise.all([
    verifiers.legacy(legacy ? hash! : dummyLegacy, password),
    verifiers.modern({ hash: hash && !legacy ? hash : await (dummyModern ??= hashPassword('ten98-campaign-timing-equaliser')), password }),
  ]);
  return Boolean(hash) && (legacy ? legacyOk : modernOk);
}

/** Retires every outstanding reset link of the account. Matches the identifier prefix and the account, never the token, so it keeps working once #131 hashes identifiers. */
export const retireResetLinks = (tx: Executor, userId: string) => tx.delete(verifications).where(and(like(verifications.identifier, 'reset-password:%'), eq(verifications.value, userId)));
