import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.ts';
import { hashPassword } from '../server/auth.ts';
import { blockWrites, postgresSkip, testDatabase } from './postgres.mjs';

const origin = 'http://127.0.0.1:3018';
async function start(app) {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  return async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
}
const count = async (pool, table) => (await pool.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count;
const claimed = async pool => (await pool.query('SELECT claimed FROM installation WHERE id = 1')).rows[0].claimed;
async function failInserts(pool, table, message) {
  await pool.query(`CREATE FUNCTION fail_${table}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION '${message}'; END $$`);
  await pool.query(`CREATE TRIGGER fail_${table} BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_${table}()`);
  return () => pool.query(`DROP TRIGGER fail_${table} ON ${table}; DROP FUNCTION fail_${table}()`);
}

test('host proof gates setup, failed claims roll back, and competing claims consume persistent setup once', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-bootstrap-')), { pool, db } = await testDatabase(t);
  // Two app processes on one database and data directory, as in a rolling restart.
  const first = await createApp({ dataDir, env: {}, appUrl: origin, directScheduler: false, database: { pool, db } }), second = await createApp({ dataDir, env: {}, appUrl: origin, directScheduler: false, database: { pool, db } });
  try {
    const request = await start(first), competing = await start(second), token = (await readFile(join(dataDir, 'bootstrap-token'), 'utf8')).trim();
    assert.ok(token.length >= 32); assert.equal(second.config.bootstrapToken, token); assert.notEqual(token, first.config.sessionSecret);
    const body = { name: 'Owner', email: 'owner@example.test', password: 'host proof fixture password', sample: false };
    const session = await request('/session'); assert.equal(session.data.setupRequired, true); assert.equal(JSON.stringify(session).includes(token), false);
    for (const invalid of [undefined, '', 'incorrect-host-proof', 'x'.repeat(513)]) {
      const result = await request('/auth/setup', { ...body, ...(invalid === undefined ? {} : { token: invalid }) });
      assert.equal(result.status, 403); assert.equal(JSON.stringify(result).includes(token), false);
      assert.equal(await count(pool, 'users'), 0);
    }
    const tables = ['users', 'instance_operators', 'instance_operator_audit', 'workspaces', 'memberships', 'projects', 'sessions'];
    for (const table of ['instance_operator_audit', 'projects']) {
      const restore = await failInserts(pool, table, 'synthetic setup failure');
      assert.equal((await request('/auth/setup', { ...body, token })).status, 500);
      for (const name of tables) assert.equal(await count(pool, name), 0, `${name} rolled back after a ${table} failure`);
      assert.equal(await claimed(pool), false);
      await restore();
    }
    // Both claims pass the unlocked pre-check; only the installation row lock stops the second from also setting up.
    const gate = await blockWrites(pool, 'users');
    const results = Promise.all([request('/auth/setup', { ...body, token }), competing('/auth/setup', { ...body, email: 'other@example.test', token })]);
    await gate.waiting(2); await gate.release();
    assert.deepEqual((await results).map(result => result.status).sort(), [201, 409]);
    for (const table of ['users', 'instance_operators', 'workspaces', 'memberships', 'projects']) assert.equal(await count(pool, table), 1);
    const audit = (await pool.query('SELECT user_id, action, source FROM instance_operator_audit')).rows;
    assert.equal(audit.length, 1); assert.deepEqual(audit[0], { user_id: (await pool.query('SELECT id FROM users')).rows[0].id, action: 'bootstrap', source: 'bootstrap' });
    assert.equal(await claimed(pool), true);
    assert.equal((await request('/session')).data.setupRequired, false);
    assert.equal((await request('/auth/setup', { ...body, token })).status, 409);
  } finally { await second.close(); await first.close(); await rm(dataDir, { recursive: true, force: true }); }
});

// The SQLite claimed-state backfill for pre-claim installations moves into the import (#25 step 4); a claimed
// PostgreSQL installation must keep login working and never reopen setup.
test('claimed installations preserve login, invent no operator history, and never reopen setup after account deletion', { skip: postgresSkip }, async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-existing-')), password = 'existing installation password', { pool, db } = await testDatabase(t);
  await pool.query('INSERT INTO users VALUES ($1, $2, $3, $4)', ['existing', 'Existing owner', 'existing@example.test', await hashPassword(password)]);
  await pool.query('UPDATE installation SET claimed = true');
  let app;
  try {
    app = await createApp({ dataDir, env: {}, appUrl: origin, directScheduler: false, database: { pool, db } });
    let request = await start(app);
    assert.equal((await request('/session')).data.setupRequired, false);
    await assert.rejects(readFile(join(dataDir, 'bootstrap-token')), { code: 'ENOENT' });
    assert.equal((await request('/auth/login', { email: 'existing@example.test', password })).status, 200);
    assert.equal(await count(pool, 'instance_operator_audit'), 0, 'Upgrading an installation must not invent operator history.');
    assert.equal((await request('/auth/setup', { token: 'x'.repeat(48), name: 'Uninvited', email: 'new@example.test', password })).status, 409);
    await pool.query('DELETE FROM users'); await app.close(); app = undefined;
    app = await createApp({ dataDir, env: {}, appUrl: origin, directScheduler: false, database: { pool, db } }); request = await start(app);
    assert.equal((await request('/session')).data.setupRequired, false);
    assert.equal((await request('/auth/setup', { name: 'Uninvited', email: 'new@example.test', password })).status, 409);
  } finally { await app?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
