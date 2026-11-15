import { sql } from 'drizzle-orm';
import type { Executor } from './database.ts';
import { users } from './schema.ts';

// Transaction locks shared by every module. Lock order (issue #25): installation → workspaces → invitations → advisory
// (email:, oidc:, and the per-feature keys) → users row. They live apart from server/auth.ts so the identity move onto
// @ten98/runtime/auth (ten98-code-system#97) leaves their callers untouched.
export const advisoryLock = (tx: Executor, key: string) => tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
/** Locks the account row; credential, session and operator changes take it first. Undefined when there is no account. */
export const lockUser = async (tx: Executor, userId: string) => (await tx.execute(sql`SELECT id FROM ${users} WHERE id = ${userId} FOR UPDATE`)).rows[0] as { id: string } | undefined;
/** Per-workspace mutex for membership, ownership and invitation changes; returns false when the workspace is gone. */
export const lockWorkspace = async (tx: Executor, workspaceId: string) => Boolean((await tx.execute(sql`SELECT id FROM workspaces WHERE id = ${workspaceId} FOR UPDATE`)).rowCount);
