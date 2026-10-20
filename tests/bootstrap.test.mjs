import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server/index.mjs';
import { hashPassword } from '../server/auth.mjs';

const origin = 'http://127.0.0.1:3018';
async function start(app) {
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  return async (path, body) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method: body ? 'POST' : 'GET', headers: { Origin: origin, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
}

test('host proof gates setup, failed claims roll back, and competing claims consume persistent setup once', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-bootstrap-'));
  const first = createApp({ dataDir, env: {}, appUrl: origin, directScheduler: false }), second = createApp({ dataDir, env: {}, appUrl: origin, directScheduler: false });
  try {
    const request = await start(first), competing = await start(second), token = (await readFile(join(dataDir, 'bootstrap-token'), 'utf8')).trim();
    assert.ok(token.length >= 32); assert.equal(second.config.bootstrapToken, token); assert.notEqual(token, first.config.sessionSecret);
    const body = { name: 'Owner', email: 'owner@example.test', password: 'host proof fixture password', sample: false };
    const session = await request('/session'); assert.equal(session.data.setupRequired, true); assert.equal(JSON.stringify(session).includes(token), false);
    for (const invalid of [undefined, '', 'incorrect-host-proof', 'x'.repeat(513)]) {
      const result = await request('/auth/setup', { ...body, ...(invalid === undefined ? {} : { token: invalid }) });
      assert.equal(result.status, 403); assert.equal(JSON.stringify(result).includes(token), false);
      assert.equal(first.db.prepare('SELECT count(*) AS count FROM users').get().count, 0);
    }
    first.db.exec("CREATE TRIGGER setup_failure BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT,'synthetic setup failure'); END;");
    assert.equal((await request('/auth/setup', { ...body, token })).status, 500);
    for (const table of ['users', 'instance_operators', 'workspaces', 'memberships', 'projects']) assert.equal(first.db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0);
    assert.equal(first.db.prepare('SELECT claimed FROM installation WHERE id=1').get().claimed, 0);
    first.db.exec('DROP TRIGGER setup_failure');
    const results = await Promise.all([request('/auth/setup', { ...body, token }), competing('/auth/setup', { ...body, email: 'other@example.test', token })]);
    assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
    for (const table of ['users', 'instance_operators', 'workspaces', 'memberships', 'projects']) assert.equal(first.db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 1);
    assert.equal(first.db.prepare('SELECT claimed FROM installation WHERE id=1').get().claimed, 1);
    assert.equal((await request('/session')).data.setupRequired, false);
    assert.equal((await request('/auth/setup', { ...body, token })).status, 409);
  } finally { await second.close(); await first.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('existing installations backfill claimed state, preserve login, and never reopen setup after account deletion', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-existing-')), password = 'existing installation password';
  const db = new DatabaseSync(join(dataDir, 'campaign.sqlite'));
  db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password TEXT)');
  db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('existing', 'Existing owner', 'existing@example.test', await hashPassword(password)); db.close();
  let app;
  try {
    app = createApp({ dataDir, env: {}, appUrl: origin, directScheduler: false });
    let request = await start(app);
    assert.equal((await request('/session')).data.setupRequired, false);
    await assert.rejects(readFile(join(dataDir, 'bootstrap-token')), { code: 'ENOENT' });
    assert.equal((await request('/auth/login', { email: 'existing@example.test', password })).status, 200);
    assert.equal((await request('/auth/setup', { token: 'x'.repeat(48), name: 'Uninvited', email: 'new@example.test', password })).status, 409);
    app.db.prepare('DELETE FROM users').run(); await app.close(); app = undefined;
    app = createApp({ dataDir, env: {}, appUrl: origin, directScheduler: false }); request = await start(app);
    assert.equal((await request('/session')).data.setupRequired, false);
    assert.equal((await request('/auth/setup', { name: 'Uninvited', email: 'new@example.test', password })).status, 409);
  } finally { await app?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
