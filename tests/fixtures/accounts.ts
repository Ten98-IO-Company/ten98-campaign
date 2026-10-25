// Shared account fixtures. Tests create people, workspaces, memberships and instance operators only through these
// helpers, never with raw INSERTs, so the identity and workspace migration onto @ten98/runtime (better-auth and
// createWorkspaceTeam, code-system #97) changes this one file instead of every test.

/** A pg Pool or PoolClient (or anything with the same query method). */
export interface Queryable { query(text: string, values?: unknown[]): Promise<unknown> }
export type SeedUser = { id: string; name: string; email: string; password?: string | null };
export type SeedRole = 'owner' | 'admin' | 'editor' | 'viewer';
export type SeedAccounts = {
  users?: SeedUser[];
  workspaces?: { id: string; name: string }[];
  /** [workspaceId, userId, role] */
  memberships?: [string, string, SeedRole][];
  /** User ids granted instance operator authority. */
  operators?: string[];
};

export async function addUsers(db: Queryable, users: SeedUser[]): Promise<void> {
  for (const user of users) await db.query('INSERT INTO users (id, name, email, password) VALUES ($1, $2, $3, $4)', [user.id, user.name, user.email, user.password ?? null]);
}

export async function addWorkspaces(db: Queryable, workspaces: { id: string; name: string }[]): Promise<void> {
  for (const workspace of workspaces) await db.query('INSERT INTO workspaces (id, name) VALUES ($1, $2)', [workspace.id, workspace.name]);
}

export async function addMemberships(db: Queryable, memberships: [string, string, SeedRole][]): Promise<void> {
  for (const [workspaceId, userId, role] of memberships) await db.query('INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, $3)', [workspaceId, userId, role]);
}

export async function grantOperators(db: Queryable, userIds: string[]): Promise<void> {
  for (const userId of userIds) await db.query('INSERT INTO instance_operators (user_id) VALUES ($1)', [userId]);
}

/** Creates users, then workspaces, then memberships, then operators, in that order. */
export async function seedAccounts(db: Queryable, seed: SeedAccounts): Promise<void> {
  await addUsers(db, seed.users ?? []);
  await addWorkspaces(db, seed.workspaces ?? []);
  await addMemberships(db, seed.memberships ?? []);
  await grantOperators(db, seed.operators ?? []);
}
