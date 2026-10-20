import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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
