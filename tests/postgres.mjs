// One PostgreSQL database per test, cloned from a template that is migrated once per migration set.
// TEST_DATABASE_URL names a disposable server and a role allowed to create databases.
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { connect, migrate, migrationSources } from '../server/database.ts';

const adminUrl = process.env.TEST_DATABASE_URL;
export const postgresSkip = !adminUrl && 'TEST_DATABASE_URL is not set';

function databaseUrl(name) { const url = new URL(adminUrl); url.pathname = `/${name}`; return url.href; }

// Parallel test processes share the server: one session-level advisory lock serialises template builds and clones.
async function withAdmin(run) {
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  try { await admin.query('SELECT pg_advisory_lock(109858, 2)'); return await run(admin); }
  finally { await admin.end(); }
}

/** Returns { pool, db, url } for a fresh migrated database; registers cleanup on the test context when given. */
export async function testDatabase(t) {
  if (!adminUrl) throw new Error('Set TEST_DATABASE_URL to run PostgreSQL tests.');
  const fingerprint = (await migrationSources()).map(source => source.checksum.slice(0, 8)).join('').slice(0, 40);
  const template = `campaign_template_${fingerprint}`, name = `campaign_test_${randomBytes(6).toString('hex')}`;
  await withAdmin(async admin => {
    if (!(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [template])).rowCount) {
      // Build under a temporary name so an interrupted run never leaves a half-migrated template behind.
      const staging = `${template}_${randomBytes(4).toString('hex')}`;
      await admin.query(`CREATE DATABASE ${staging}`);
      const building = connect(databaseUrl(staging));
      try { await migrate(building.pool); } finally { await building.pool.end(); }
      await admin.query(`ALTER DATABASE ${staging} RENAME TO ${template}`);
    }
    await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
  });
  const connection = { ...connect(databaseUrl(name)), url: databaseUrl(name) };
  const close = async () => {
    await connection.pool.end().catch(() => undefined);
    const admin = new pg.Client({ connectionString: adminUrl });
    await admin.connect(); await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`); await admin.end();
  };
  if (t) t.after(close);
  return Object.assign(connection, { close });
}

/** createApp on a fresh database; the app closes before its database is dropped. */
export async function testApp(t, options = {}) {
  const database = await testDatabase(), { createApp } = await import('../server/index.ts');
  let app;
  try { app = await createApp({ ...options, database: { pool: database.pool, db: database.db } }); }
  catch (error) { await database.close(); throw error; }
  t.after(async () => { await app.close(); await database.close(); });
  return Object.assign(app, { database });
}

/**
 * Deterministic race harness: a separate session holds `LOCK TABLE <table> IN EXCLUSIVE MODE`, which lets reads
 * through but blocks writes. Parallel requests that lack their own lock all read the same state before they block.
 * `waiting(n)` resolves once n backends wait on a lock, and `release()` lets them run.
 */
export async function blockWrites(pool, table) {
  const client = await pool.connect();
  await client.query('BEGIN'); await client.query(`LOCK TABLE ${table} IN EXCLUSIVE MODE`);
  return {
    async waiting(count, timeout = 5000) {
      for (const deadline = Date.now() + timeout; ;) {
        const { rows: [row] } = await pool.query("SELECT count(*) AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
        if (row.waiting >= count) return;
        if (Date.now() > deadline) throw new Error(`Expected ${count} lock waiters, saw ${row.waiting}.`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    },
    async release() { await client.query('COMMIT'); client.release(); },
  };
}
