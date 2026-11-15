import { oidcProviderId } from '@ten98/runtime/auth';

// Shared account fixtures. Tests create people, workspaces, memberships and instance operators only through these
// helpers, never with raw INSERTs, so the identity and workspace migration onto @ten98/runtime (better-auth and
// createWorkspaceTeam, code-system #97) changes this one file instead of every test.

/** A pg Pool or PoolClient, or the tests' sql wrapper (run with ? placeholders). */
export interface Queryable { query(text: string, values?: unknown[]): Promise<unknown> }
export interface Runnable { run(text: string, ...values: unknown[]): Promise<unknown> }
export type Db = Queryable | Runnable;
const exec = (db: Db, text: string, values: unknown[]) => 'query' in db ? db.query(text, values) : db.run(text.replace(/\$\d+/g, '?'), ...values);
export type SeedUser = { id: string; name: string; email: string; password?: string | null };
// The memberships table's check constraint validates the role.
export type SeedRole = 'owner' | 'admin' | 'editor' | 'viewer' | (string & {});
export type SeedAccounts = {
  users?: SeedUser[];
  workspaces?: { id: string; name: string }[];
  /** [workspaceId, userId, role] */
  memberships?: [string, string, SeedRole][];
  /** User ids granted instance operator authority. */
  operators?: string[];
};

/** `password` is a stored hash (from hashPassword, or any fixture text); with one, the user gets a Better Auth credential account. */
export async function addUsers(db: Db, users: SeedUser[]): Promise<void> {
  for (const user of users) {
    await exec(db, 'INSERT INTO "user" (id, name, email) VALUES ($1, $2, $3)', [user.id, user.name, user.email]);
    // Each placeholder once: the tests' sql wrapper numbers `?` placeholders in order.
    if (user.password) await exec(db, "INSERT INTO account (id, \"accountId\", \"providerId\", \"userId\", password) VALUES ($1, $2, 'credential', $3, $4)", ['credential-' + user.id, user.id, user.id, user.password]);
  }
}
/** Links an OIDC issuer and subject to a user, as the preset stores it: an account row (provider oidcProviderId, the normalised issuer) with no tokens. */
export async function addOidcIdentity(db: Db, issuer: string, subject: string, userId: string): Promise<void> {
  await exec(db, 'INSERT INTO account (id, "accountId", "providerId", "userId") VALUES ($1, $2, $3, $4)', ['oidc-' + userId + '-' + subject, subject, oidcProviderId(issuer), userId]);
}
/** Stored OIDC identities as { issuer, subject, user_id } rows, for assertions. */
export const oidcIdentitiesSql = "SELECT substr(\"providerId\", 6) AS issuer, \"accountId\" AS subject, \"userId\" AS user_id, \"accessToken\" AS access_token, \"refreshToken\" AS refresh_token, \"idToken\" AS id_token FROM account WHERE \"providerId\" LIKE 'oidc:%'";

export async function addWorkspaces(db: Db, workspaces: { id: string; name: string }[]): Promise<void> {
  for (const workspace of workspaces) await exec(db, 'INSERT INTO workspaces (id, name) VALUES ($1, $2)', [workspace.id, workspace.name]);
}

export async function addMemberships(db: Db, memberships: [string, string, SeedRole][]): Promise<void> {
  for (const [workspaceId, userId, role] of memberships) await exec(db, 'INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)', [workspaceId, userId, role]);
}

export async function grantOperators(db: Db, userIds: string[]): Promise<void> {
  for (const userId of userIds) await exec(db, 'INSERT INTO instance_operators (user_id) VALUES ($1)', [userId]);
}

/** Creates users, then workspaces, then memberships, then operators, in that order. */
export async function seedAccounts(db: Db, seed: SeedAccounts): Promise<void> {
  await addUsers(db, seed.users ?? []);
  await addWorkspaces(db, seed.workspaces ?? []);
  await addMemberships(db, seed.memberships ?? []);
  await grantOperators(db, seed.operators ?? []);
}
