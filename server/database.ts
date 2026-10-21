import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
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

// Ported from ten98-discover (MIT) src/server/db.ts and cli.ts migrate at e36503c: versioned SQL files and a
// checksum ledger. Planned to move into @ten98/runtime so both apps share one implementation.
const migrationFiles = ['0001_baseline.sql', '0002_insertion_order.sql'] as const;
type Migration = Readonly<{ version: string; filename: string; sql: string; checksum: string }>;
type AppliedMigration = Readonly<{ version: string; checksum: string }>;
let migrations: Promise<readonly Migration[]> | undefined;

export function migrationSources(): Promise<readonly Migration[]> {
  if (!migrations) migrations = Promise.all(migrationFiles.map(async filename => {
    // Git line-ending conversion must not change a migration's identity across host operating systems.
    const sql = (await readFile(join(import.meta.dirname, '..', 'migrations', filename), 'utf8')).replace(/\r\n?/g, '\n');
    return Object.freeze({ version: filename.slice(0, 4), filename, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  })).then(sources => Object.freeze(sources)).catch(error => { migrations = undefined; throw error; });
  return migrations;
}

function schemaMismatch() {
  return Object.assign(new Error('Database schema is incompatible with this application. Use the matching image and migrations.'), { code: 'SCHEMA_MISMATCH' });
}

// Applied rows must be an unmodified prefix of the shipped migrations; anything else is a different schema.
export async function pendingMigrations(applied: readonly AppliedMigration[]): Promise<readonly Migration[]> {
  const sources = await migrationSources();
  if (applied.length > sources.length || applied.some((row, index) => row.version !== sources[index].version || row.checksum !== sources[index].checksum)) throw schemaMismatch();
  return sources.slice(applied.length);
}

export async function assertSchema(pool = getDatabase().pool) {
  // A database that was never migrated has no ledger (42P01); report it as the same mismatch.
  const { rows } = await pool.query<AppliedMigration>('SELECT version, checksum FROM schema_version ORDER BY version').catch(error => { throw error?.code === '42P01' ? schemaMismatch() : error; });
  if ((await pendingMigrations(rows)).length !== 0) throw schemaMismatch();
}

// One transaction under an advisory lock, so concurrent starts apply each migration exactly once.
export async function migrate(pool = getDatabase().pool): Promise<string[]> {
  await migrationSources();
  const client = await pool.connect(), applied: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [109858, 1]);
    await client.query('CREATE TABLE IF NOT EXISTS schema_version (version text PRIMARY KEY, checksum text NOT NULL)');
    const current = await client.query<AppliedMigration>('SELECT version, checksum FROM schema_version ORDER BY version');
    for (const migration of await pendingMigrations(current.rows)) {
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_version (version, checksum) VALUES ($1, $2)', [migration.version, migration.checksum]);
      applied.push(migration.version);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return applied;
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
