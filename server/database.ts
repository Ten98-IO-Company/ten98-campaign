import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema.ts';

// PostgreSQL (issue #25): modules move here from the SQLite functions below one by one until cutover.
// Ported from ten98-discover (MIT) src/server/db.ts and cli.ts migrate at e36503c: the pool, versioned SQL
// files and checksum ledger. Planned to move into @ten98/runtime so both apps share one implementation.
// node-pg returns int8 (bigint columns, count(*), seq) as strings, which would silently break numeric
// comparisons. Every int8 here (epoch ms, seq, counts) fits a double; fail loudly if one ever does not.
export function parseInt8(value: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new RangeError('A bigint value is outside the safe integer range.');
  return number;
}
pg.types.setTypeParser(pg.types.builtins.INT8, parseInt8);

let database: { pool: pg.Pool; db: ReturnType<typeof drizzle<typeof schema>> } | undefined;
export function getDatabase(connectionString = process.env.DATABASE_URL) {
  if (!database) {
    if (!connectionString) throw new Error('Set DATABASE_URL to the PostgreSQL connection string.');
    const pool = new pg.Pool({ connectionString, max: 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, statement_timeout: 10000 });
    pool.on('error', () => console.error('Database connection failed; check database availability.'));
    database = { pool, db: drizzle(pool, { schema }) };
  }
  return database;
}
export async function closeDatabase() { if (database) { const { pool } = database; database = undefined; await pool.end(); } }

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

export async function assertSchema() {
  const { rows } = await getDatabase().pool.query<AppliedMigration>('SELECT version, checksum FROM schema_version ORDER BY version');
  if ((await pendingMigrations(rows)).length !== 0) throw schemaMismatch();
}

// One transaction under an advisory lock, so concurrent starts apply each migration exactly once.
export async function migrate(): Promise<string[]> {
  await migrationSources();
  const client = await getDatabase().pool.connect(), applied: string[] = [];
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
export function openDatabase(dataDir: string): DatabaseSync {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dataDir, 'campaign.sqlite'));
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password TEXT);
    CREATE TABLE IF NOT EXISTS instance_operators(user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE);
    CREATE TABLE IF NOT EXISTS instance_operator_audit(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,action TEXT NOT NULL CHECK(action IN ('bootstrap','grant','revoke')),source TEXT NOT NULL CHECK(source IN ('bootstrap','host')),created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS memberships(workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN ('owner','admin','editor','viewer')),PRIMARY KEY(workspace_id,user_id));
    CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,name TEXT NOT NULL,color TEXT NOT NULL DEFAULT '#5943ce',zernio_profile_id TEXT NOT NULL DEFAULT '',drive_folder_id TEXT NOT NULL DEFAULT '');
    CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,collection TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS records_project ON records(project_id,collection);
    CREATE TABLE IF NOT EXISTS activity(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,message TEXT NOT NULL,created_at TEXT NOT NULL,sample INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS oidc_flows(state TEXT PRIMARY KEY,browser TEXT NOT NULL,verifier TEXT NOT NULL,nonce TEXT NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS oidc_return_targets(state TEXT PRIMARY KEY REFERENCES oidc_flows(state) ON DELETE CASCADE,invite_token TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oidc_identities(issuer TEXT NOT NULL,subject TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,PRIMARY KEY(issuer,subject));
    CREATE TABLE IF NOT EXISTS login_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS installation(id INTEGER PRIMARY KEY CHECK(id=1),claimed INTEGER NOT NULL CHECK(claimed IN (0,1)));
    INSERT OR IGNORE INTO installation VALUES(1,0);
    UPDATE installation SET claimed=1 WHERE id=1 AND EXISTS(SELECT 1 FROM users);`);
  return db;
}

export function transaction<T>(db: DatabaseSync, run: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const value = run(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

export function createStore(db: DatabaseSync) {
  const read = db.prepare('SELECT data FROM records WHERE project_id=? AND collection=? ORDER BY rowid DESC');
  const find = db.prepare('SELECT data FROM records WHERE project_id=? AND collection=? AND id=?');
  return {
    list(projectId: string, collection: string): ProjectRecord[] { return read.all(projectId, collection).map(row => JSON.parse(row.data as string)); },
    get(projectId: string, collection: string, id: string): ProjectRecord | null { const row = find.get(projectId, collection, id); return row ? JSON.parse(row.data as string) : null; },
    create(projectId: string, collection: string, data: Record<string, unknown>): ProjectRecord {
      if (!collections.includes(collection)) throw new Error('Unknown collection.');
      const now = new Date().toISOString();
      const record = { ...data, id: randomUUID(), projectId, createdAt: now, updatedAt: now };
      db.prepare('INSERT INTO records VALUES(?,?,?,?)').run(record.id, projectId, collection, JSON.stringify(record));
      return record;
    },
    update(projectId: string, collection: string, id: string, data: Record<string, unknown>): ProjectRecord | null {
      const previous = this.get(projectId, collection, id);
      if (!previous) return null;
      const record = { ...previous, ...data, id, projectId, createdAt: previous.createdAt, updatedAt: new Date().toISOString() };
      db.prepare('UPDATE records SET data=? WHERE project_id=? AND collection=? AND id=?').run(JSON.stringify(record), projectId, collection, id);
      return record;
    },
    remove(projectId: string, collection: string, id: string): boolean { return db.prepare('DELETE FROM records WHERE project_id=? AND collection=? AND id=?').run(projectId, collection, id).changes > 0; },
    activity(projectId: string, message: string, sample = false): void {
      db.prepare('INSERT INTO activity VALUES(?,?,?,?,?)').run(randomUUID(), projectId, message, new Date().toISOString(), Number(sample));
      db.prepare('DELETE FROM activity WHERE project_id=? AND id NOT IN (SELECT id FROM activity WHERE project_id=? ORDER BY rowid DESC LIMIT 50)').run(projectId, projectId);
    },
  };
}
