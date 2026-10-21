import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashPassword } from '../server/auth.ts';
import { blockWrites, postgresSkip, testApp } from './postgres.mjs';

const origin = 'http://127.0.0.1:3018';
async function owners(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-team-races-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const app = await testApp(t, { dataDir, env: {}, appUrl: origin, directScheduler: false }), { pool } = app.database;
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const request = async (path, { method = 'GET', body, cookie } = {}) => {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/api${path}`, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  };
  const password = 'team race fixture password';
  const setup = await request('/auth/setup', { method: 'POST', body: { token: app.config.bootstrapToken, name: 'First', email: 'first@example.test', password, sample: false } });
  const workspaceId = (await request('/state', { cookie: setup.cookie })).data.workspaces[0].id;
  await pool.query('INSERT INTO users VALUES ($1, $2, $3, $4)', ['second', 'Second', 'second@example.test', await hashPassword(password)]);
  await pool.query("INSERT INTO memberships VALUES ($1, 'second', 'owner')", [workspaceId]);
  const second = await request('/auth/login', { method: 'POST', body: { email: 'second@example.test', password } });
  return { pool, request, workspaceId, first: { id: setup.data.user.id, cookie: setup.cookie }, second: { id: 'second', cookie: second.cookie } };
}
const ownerCount = async (pool, workspaceId) => (await pool.query("SELECT count(*) AS count FROM memberships WHERE workspace_id = $1 AND role = 'owner'", [workspaceId])).rows[0].count;

test('two owners demoting each other at once leave exactly one owner', { skip: postgresSkip }, async t => {
  const { pool, request, workspaceId, first, second } = await owners(t);
  const demote = (actor, target) => request(`/workspaces/${workspaceId}/members/${target.id}`, { method: 'PATCH', body: { role: 'editor' }, cookie: actor.cookie });
  // Both demotions read two owners before either writes; only the workspace row lock (and the actor
  // re-check under it) stops the second from removing the last owner.
  const gate = await blockWrites(pool, 'memberships');
  const results = [demote(first, second), demote(second, first)];
  await gate.waiting(2); await gate.release();
  const statuses = (await Promise.all(results)).map(result => result.status).sort();
  assert.deepEqual(statuses, [200, 403]);
  assert.equal(await ownerCount(pool, workspaceId), 1);
});

test('two owners demoting themselves at once keep one owner', { skip: postgresSkip }, async t => {
  const { pool, request, workspaceId, first, second } = await owners(t);
  const demoteSelf = actor => request(`/workspaces/${workspaceId}/members/${actor.id}`, { method: 'PATCH', body: { role: 'editor' }, cookie: actor.cookie });
  const gate = await blockWrites(pool, 'memberships');
  const results = [demoteSelf(first), demoteSelf(second)];
  await gate.waiting(2); await gate.release();
  assert.deepEqual((await Promise.all(results)).map(result => result.status).sort(), [200, 409]);
  assert.equal(await ownerCount(pool, workspaceId), 1);
});
