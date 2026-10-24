// ten98-campaign#142: every member may leave a workspace by removing their own membership, except its last owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { hashPassword } from '../server/auth.ts';
import { postgresSkip, testApp } from './postgres.mjs';

const origin = 'http://127.0.0.1:3019', password = 'leave workspace fixture password';
type Member = { id: string; cookie: string };

async function team(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-leave-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const app = await testApp(t, { dataDir, env: {}, appUrl: origin, directScheduler: false }), { pool } = app.database;
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', () => resolve()));
  const request = async (path: string, { method = 'GET', body, cookie }: { method?: string; body?: unknown; cookie?: string } = {}) => {
    const response = await fetch(`http://127.0.0.1:${(app.server.address() as AddressInfo).port}/api${path}`, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() as Record<string, any>, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  };
  const setup = await request('/auth/setup', { method: 'POST', body: { token: app.config.bootstrapToken, name: 'First owner', email: 'first@example.test', password, sample: false } });
  const workspaceId: string = (await request('/state', { cookie: setup.cookie })).data.workspaces[0].id;
  const member = async (role: string): Promise<Member> => {
    await pool.query('INSERT INTO users VALUES ($1, $2, $3, $4)', [role, role, `${role}@example.test`, await hashPassword(password)]);
    await pool.query('INSERT INTO memberships VALUES ($1, $2, $3)', [workspaceId, role, role]);
    return { id: role, cookie: (await request('/auth/login', { method: 'POST', body: { email: `${role}@example.test`, password } })).cookie };
  };
  const leave = (actor: Member, target = actor) => request(`/workspaces/${workspaceId}/members/${target.id}`, { method: 'DELETE', cookie: actor.cookie });
  const isMember = async (id: string) => (await pool.query('SELECT 1 FROM memberships WHERE workspace_id = $1 AND user_id = $2', [workspaceId, id])).rowCount === 1;
  return { request, member, leave, isMember, owner: { id: setup.data.user.id as string, cookie: setup.cookie } };
}

for (const role of ['admin', 'editor', 'viewer']) {
  test(`a workspace ${role} can leave the workspace`, { skip: postgresSkip }, async t => {
    const { leave, isMember, member } = await team(t), actor = await member(role);
    assert.equal((await leave(actor)).status, 200);
    assert.equal(await isMember(actor.id), false);
  });
}

test('an owner can leave while another owner remains', { skip: postgresSkip }, async t => {
  const { leave, isMember, member, owner } = await team(t), second = await member('owner');
  assert.equal((await leave(second)).status, 200);
  assert.equal(await isMember(second.id), false); assert.equal(await isMember(owner.id), true);
});

test('the last owner cannot leave the workspace', { skip: postgresSkip }, async t => {
  const { leave, isMember, owner } = await team(t), refused = await leave(owner);
  assert.equal(refused.status, 409); assert.equal(refused.data.error, 'A workspace must keep at least one owner.');
  assert.equal(await isMember(owner.id), true);
});

test('leaving removes only your own membership: editors and viewers still cannot remove others', { skip: postgresSkip }, async t => {
  const { leave, isMember, member, owner } = await team(t), editor = await member('editor'), viewer = await member('viewer');
  assert.equal((await leave(editor, viewer)).status, 403); assert.equal((await leave(viewer, editor)).status, 403); assert.equal((await leave(editor, owner)).status, 403);
  assert.equal(await isMember(viewer.id), true); assert.equal(await isMember(editor.id), true);
});
