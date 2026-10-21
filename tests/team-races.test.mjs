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

test('two projects mapped to one Zernio profile at once leave it mapped to exactly one', { skip: postgresSkip }, async t => {
  const { pool, request, workspaceId, first } = await owners(t);
  const created = await Promise.all(['Profile race A', 'Profile race B'].map(name => request('/projects', { method: 'POST', body: { workspaceId, name }, cookie: first.cookie })));
  assert.deepEqual(created.map(result => result.status), [201, 201]);
  const map = project => request(`/projects/${project.data.project.id}`, { method: 'PATCH', body: { zernioProfileId: 'profile-raced' }, cookie: first.cookie });
  // Both mappings pass the one-profile-per-project check before either writes; only the unique index stops the second.
  const gate = await blockWrites(pool, 'projects');
  const results = created.map(map);
  await gate.waiting(2); await gate.release();
  const settled = await Promise.all(results);
  assert.deepEqual(settled.map(result => result.status).sort(), [200, 409]);
  assert.match(settled.find(result => result.status === 409).data.error, /already mapped to another project/);
  assert.equal((await pool.query("SELECT count(*) AS count FROM projects WHERE zernio_profile_id = 'profile-raced'")).rows[0].count, 1);
});

// The second owner becomes an administrator who has invited a new editor.
async function pendingInvitation(t) {
  const team = await owners(t), { pool, request, workspaceId, first, second } = team;
  await pool.query("UPDATE memberships SET role = 'admin' WHERE user_id = 'second'");
  const created = await request(`/workspaces/${workspaceId}/invitations`, { method: 'POST', body: { email: 'invitee@example.test', role: 'editor' }, cookie: second.cookie });
  assert.equal(created.status, 201);
  const token = new URL(created.data.url).searchParams.get('invite'), id = created.data.invitation.id;
  const member = (target, role) => request(`/workspaces/${workspaceId}/members/${target}`, role ? { method: 'PATCH', body: { role }, cookie: first.cookie } : { method: 'DELETE', cookie: first.cookie });
  const accept = () => request('/invitations/' + token, { method: 'POST', body: { name: 'Invitee', password: 'invitee fixture password' } });
  const invitation = async () => (await pool.query('SELECT accepted_at, revoked_at FROM workspace_invitations WHERE id = $1', [id])).rows[0];
  return { ...team, token, id, member, accept, invitation };
}

test('demoting an inviter below the invite role revokes their pending invitations, and restoring the role does not revive them', { skip: postgresSkip }, async t => {
  const { member, accept, invitation, pool } = await pendingInvitation(t);
  assert.equal((await member('second', 'editor')).status, 200);
  assert.notEqual((await invitation()).revoked_at, null);
  assert.equal((await accept()).status, 410);
  assert.equal((await member('second', 'admin')).status, 200);
  assert.equal((await accept()).status, 410); assert.equal((await invitation()).accepted_at, null);
  assert.equal((await pool.query("SELECT * FROM users WHERE email = 'invitee@example.test'")).rowCount, 0);
});

test('an owner demoted to administrator keeps pending invitations an administrator may still grant', { skip: postgresSkip }, async t => {
  const { member, invitation, request, workspaceId, second, pool } = await pendingInvitation(t);
  await pool.query("UPDATE memberships SET role = 'owner' WHERE user_id = 'second'");
  const adminInvite = await request(`/workspaces/${workspaceId}/invitations`, { method: 'POST', body: { email: 'manager@example.test', role: 'admin' }, cookie: second.cookie });
  assert.equal((await member('second', 'admin')).status, 200);
  assert.equal((await invitation()).revoked_at, null, 'an editor invitation stays pending');
  assert.notEqual((await pool.query('SELECT revoked_at FROM workspace_invitations WHERE id = $1', [adminInvite.data.invitation.id])).rows[0].revoked_at, null);
});

test('removing an inviter revokes their pending invitations', { skip: postgresSkip }, async t => {
  const { member, accept, invitation } = await pendingInvitation(t);
  assert.equal((await member('second')).status, 200);
  assert.notEqual((await invitation()).revoked_at, null); assert.equal((await accept()).status, 410);
});

test('removing a member revokes pending invitations addressed to them', { skip: postgresSkip }, async t => {
  const { pool, workspaceId, member, first } = await pendingInvitation(t);
  // A member can hold a pending invitation created before they joined, for example from another administrator.
  await pool.query("INSERT INTO workspace_invitations (id, workspace_id, email, role, inviter_id, token_hash, created_at, expires_at) VALUES ('to-member', $1, 'second@example.test', 'admin', $2, 'to-member-hash', $3, $4)", [workspaceId, first.id, Date.now(), Date.now() + 86400000]);
  assert.equal((await member('second')).status, 200);
  assert.notEqual((await pool.query("SELECT revoked_at FROM workspace_invitations WHERE id = 'to-member'")).rows[0].revoked_at, null);
});

test('a demotion racing an acceptance either follows the acceptance or refuses it', { skip: postgresSkip }, async t => {
  // Demotion first: it holds the workspace lock while blocked on its membership write, and the acceptance waits for it.
  const late = await pendingInvitation(t);
  let gate = await blockWrites(late.pool, 'memberships');
  const demotion = late.member('second', 'editor'); await gate.waiting(1);
  const acceptance = late.accept(); await gate.waiting(2); await gate.release();
  assert.deepEqual([(await demotion).status, (await acceptance).status], [200, 410]);
  assert.equal((await late.invitation()).accepted_at, null);
  assert.equal((await late.pool.query("SELECT * FROM users WHERE email = 'invitee@example.test'")).rowCount, 0);
  // Acceptance first: the demotion waits, then finds nothing left to revoke.
  const early = await pendingInvitation(t);
  gate = await blockWrites(early.pool, 'memberships');
  const accepted = early.accept(); await gate.waiting(1);
  const demoted = early.member('second', 'editor'); await gate.waiting(2); await gate.release();
  assert.deepEqual([(await accepted).status, (await demoted).status], [200, 200]);
  const row = await early.invitation(); assert.notEqual(row.accepted_at, null); assert.equal(row.revoked_at, null);
});

test('an administrator manages editors and viewers but not owners or administrators', { skip: postgresSkip }, async t => {
  const { pool, request, workspaceId, first, second } = await owners(t);
  await pool.query("UPDATE memberships SET role = 'admin' WHERE user_id = 'second'");
  await pool.query("INSERT INTO users VALUES ('third', 'Third', 'third@example.test', NULL)"); await pool.query("INSERT INTO memberships VALUES ($1, 'third', 'editor')", [workspaceId]);
  const change = (target, body, method = 'PATCH') => request(`/workspaces/${workspaceId}/members/${target}`, { method, body, cookie: second.cookie });
  assert.equal((await change('third', { role: 'viewer' })).status, 200);
  assert.equal((await change('third', { role: 'admin' })).status, 403, 'An administrator cannot grant administrator.');
  assert.equal((await change(first.id, { role: 'editor' })).status, 403, 'An administrator cannot change an owner.');
  assert.equal((await change(first.id, undefined, 'DELETE')).status, 403, 'An administrator cannot remove an owner.');
  assert.equal((await change('third', undefined, 'DELETE')).status, 200);
  assert.deepEqual((await pool.query('SELECT user_id, role FROM memberships WHERE workspace_id = $1 ORDER BY user_id', [workspaceId])).rows.map(row => [row.user_id, row.role]).sort(), [[first.id, 'owner'], ['second', 'admin']].sort());
});
