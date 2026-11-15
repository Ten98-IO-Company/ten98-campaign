import { createTen98Auth, verifyLegacyScryptHash, type Ten98Auth, type Ten98AuthOptions } from '@ten98/runtime/auth';
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

export interface CampaignAuthOptions extends Ten98AuthOptions { transactionDatabase(tx: Transaction): Ten98AuthOptions['database'] }
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
  const { transactionDatabase: _bindings, ...presetOptions } = options;
  return Object.assign(surface(presetOptions), {
    withLockedAuth<T>(db: Database, userId: string, run: (auth: LockedTen98Auth, tx: Transaction) => Promise<T>): Promise<T> {
      return db.transaction(async tx => {
        if (!await lockAccount(tx, userId)) throw new LockedAuthUserNotFoundError();
        return run(bound(options, tx, userId), tx);
      });
    },
    // As #140: the email lock (normalised as the team controller's lockEmail), then the account row when there is one.
    withLockedAuthByEmail<T>(db: Database, email: string, run: (auth: LockedTen98Auth, tx: Transaction, userId: string | undefined) => Promise<T>): Promise<T> {
      const address = email.trim().toLowerCase();
      return db.transaction(async tx => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${emailLockKey}, hashtext(${address}))`);
        const userId = (await tx.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = lower(${address})`).for('no key update'))[0]?.id;
        return run(bound(options, tx, userId), tx, userId);
      });
    },
  });
}

// Replace with the #132 sign-in pre-check (ten98-code-system#132, follow-up to code-system PR #140).
// Sign-in in four steps, so a wrong password never holds a connection or the lock while it hashes:
//   1. a short pool read of the credential (the connection is released before hashing);
//   2. verification outside any transaction; a wrong password is refused here;
//   3. constant cost: unknown, legacy and modern accounts all run the legacy and the modern verifier once;
//   4. only a correct password goes on to withLockedAuthByEmail, which verifies again under the lock and creates the session.
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
export async function signInWithPassword<T>(auth: CampaignAuth, db: Database, email: string, password: string, run: (auth: LockedTen98Auth, tx: Transaction, userId: string | undefined) => Promise<T>): Promise<T | null> {
  const address = email.trim().toLowerCase();
  const [stored] = await db.select({ password: accounts.password }).from(users).leftJoin(accounts, and(eq(accounts.userId, users.id), eq(accounts.providerId, 'credential'))).where(sql`lower(${users.email}) = lower(${address})`);
  if (!await verifyStoredPassword(stored?.password, password)) return null;
  return auth.withLockedAuthByEmail(db, address, run);
}

/** Retires every outstanding reset link of the account. Matches the identifier prefix and the account, never the token, so it keeps working once #131 hashes identifiers. */
export const retireResetLinks = (tx: Executor, userId: string) => tx.delete(verifications).where(and(like(verifications.identifier, 'reset-password:%'), eq(verifications.value, userId)));
