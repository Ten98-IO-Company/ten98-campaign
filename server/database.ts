import { randomUUID } from 'node:crypto';
import { createMigrationLedger } from '@ten98/runtime';
import pg from 'pg';
import { and, desc, eq, sql } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema.ts';
import { activity, records } from './schema.ts';

// node-pg returns int8 (bigint columns, count(*), seq) as strings, which would silently break numeric
// comparisons. Every int8 here (epoch ms, seq, counts) fits a double; fail loudly if one ever does not.
export function parseInt8(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError('A bigint value is outside the safe integer range.');
  return number;
}
pg.types.setTypeParser(pg.types.builtins.INT8, parseInt8);

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Statements that may run on their own or inside a caller's transaction. */
export type Executor = Database | Transaction;
export type Connection = { pool: pg.Pool; db: Database };

export function connect(connectionString: string): Connection {
  const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, statement_timeout: 10000 });
  pool.on('error', () => console.error('Database connection failed; check database availability.'));
  return { pool, db: drizzle(pool, { schema }) };
}

let shared: Connection | undefined;
export function getDatabase(connectionString = process.env.DATABASE_URL): Connection {
  if (!shared) {
    if (!connectionString) throw new Error('Set DATABASE_URL to the PostgreSQL connection string.');
    shared = connect(connectionString);
  }
  return shared;
}
export async function closeDatabase() { if (shared) { const { pool } = shared; shared = undefined; await pool.end(); } }

// Versioned SQL with a checksum ledger: the shared @ten98/runtime implementation (ported from ten98-discover).
const ledger = createMigrationLedger({ directory: new URL('../migrations/', import.meta.url), files: ['0001_baseline.sql', '0002_insertion_order.sql'], lockKey: [109858, 1] });
export const migrationSources = ledger.sources, pendingMigrations = ledger.pending;

export async function assertSchema(pool = getDatabase().pool) {
  try { await ledger.assertCurrent(pool); }
  catch (error: any) {
    // A database that was never migrated has no ledger table (42P01); an empty ledger reports the same SCHEMA_MISMATCH.
    if (error?.code !== '42P01') throw error;
    await ledger.assertCurrent({ query: async () => ({ rows: [] }) });
  }
}

/** Applies pending migrations once, in one advisory-locked transaction on a dedicated connection. */
export async function migrate(pool = getDatabase().pool): Promise<string[]> {
  const client = await pool.connect();
  try { return [...await ledger.migrate(client)]; } finally { client.release(); }
}

export type ProjectRecord = { id: string; projectId: string; createdAt: string; updatedAt: string; [key: string]: any };
export type Store = ReturnType<typeof createStore>;
export const collections = ['campaigns', 'posts', 'placements', 'assets', 'providers'];

/** Project documents; pass a transaction to keep store writes inside the caller's critical section. */
export function createStore(db: Executor) {
  const scope = (projectId: string, collection: string) => and(eq(records.project_id, projectId), eq(records.collection, collection));
  return {
    async list(projectId: string, collection: string): Promise<ProjectRecord[]> {
      return (await db.select({ data: records.data }).from(records).where(scope(projectId, collection)).orderBy(desc(records.seq))).map(row => row.data as ProjectRecord);
    },
    async get(projectId: string, collection: string, id: string): Promise<ProjectRecord | null> {
      const [row] = await db.select({ data: records.data }).from(records).where(and(scope(projectId, collection), eq(records.id, id)));
      return row ? row.data as ProjectRecord : null;
    },
    async create(projectId: string, collection: string, data: Record<string, unknown>): Promise<ProjectRecord> {
      if (!collections.includes(collection)) throw new Error('Unknown collection.');
      const now = new Date().toISOString();
      const record = { ...data, id: randomUUID(), projectId, createdAt: now, updatedAt: now };
      await db.insert(records).values({ id: record.id, project_id: projectId, collection, data: record });
      return record;
    },
    // Read-modify-write under a row lock so concurrent partial updates cannot drop each other's fields.
    update(projectId: string, collection: string, id: string, data: Record<string, unknown>): Promise<ProjectRecord | null> {
      return db.transaction(async tx => {
        const [row] = await tx.select({ data: records.data }).from(records).where(and(scope(projectId, collection), eq(records.id, id))).for('update');
        if (!row) return null;
        const previous = row.data as ProjectRecord;
        const record = { ...previous, ...data, id, projectId, createdAt: previous.createdAt, updatedAt: new Date().toISOString() };
        await tx.update(records).set({ data: record }).where(eq(records.id, id));
        return record;
      });
    },
    async remove(projectId: string, collection: string, id: string): Promise<boolean> {
      return ((await db.delete(records).where(and(scope(projectId, collection), eq(records.id, id)))).rowCount ?? 0) > 0;
    },
    async activity(projectId: string, message: string, sample = false): Promise<void> {
      await db.insert(activity).values({ id: randomUUID(), project_id: projectId, message, created_at: new Date().toISOString(), sample });
      await db.execute(sql`DELETE FROM activity WHERE project_id = ${projectId} AND seq NOT IN (SELECT seq FROM activity WHERE project_id = ${projectId} ORDER BY seq DESC LIMIT 50)`);
    },
  };
}
