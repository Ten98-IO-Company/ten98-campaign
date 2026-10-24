import test from 'node:test';
import assert from 'node:assert/strict';
import { handleInvitations } from '../server/invitations.ts';
import { HttpError, memberRole } from '../server/auth.ts';
import { blockWrites, postgresSkip, testDatabase } from './postgres.mjs';

async function fixture(t) {
  const { pool, db } = await testDatabase(t), established = [];
  await pool.query(`INSERT INTO users VALUES ('owner','Owner','owner@example.test','OWNER_HASH'),('admin','Admin','admin@example.test','ADMIN_HASH'),('viewer','Viewer','viewer@example.test','VIEWER_HASH'),('outside','Outside','outside@example.test','OUTSIDE_HASH'),('existing','Existing','existing@example.test','EXISTING_HASH');
    INSERT INTO workspaces (id, name) VALUES ('workspace-a','Studio A'),('workspace-b','Studio B');
    INSERT INTO memberships VALUES ('workspace-a','owner','owner'),('workspace-a','admin','admin'),('workspace-a','viewer','viewer'),('workspace-b','outside','owner');
    INSERT INTO instance_operators VALUES ('owner');`);
  const users = Object.fromEntries((await pool.query('SELECT id, name, email FROM users')).rows.map(user => [user.id, user]));
  const auth = { async limit() {}, clientKey: (req, scope) => scope + ':test-client' }, workspaceAccess = async (workspaceId, userId) => {
    const role = await memberRole(db, workspaceId, userId);
    if (!role) throw new HttpError(404, 'Workspace not available.'); return role;
  };
  async function request(path, { method = 'GET', body = {}, user = users.owner } = {}) {
    let response;
    try {
      const handled = await handleInvitations({ req: { method, socket: { remoteAddress: '127.0.0.1' } }, url: new URL('https://campaign.example/api' + path), body, user, db, auth, config: { appUrl: 'https://campaign.example' }, workspaceAccess, establish: async id => { established.push(id); }, send: (status, data) => { response = { status, data }; } });
      assert.equal(handled, true); return response;
    } catch (error) { if (error instanceof HttpError) return { status: error.status, data: { error: error.message } }; throw error; }
  }
  const create = (email, role = 'editor', options = {}) => request('/workspaces/workspace-a/invitations', { method: 'POST', body: { email, role }, ...options });
  const token = result => new URL(result.data.url).hash.slice('#invite='.length);
  const read = (result, options = {}) => request('/invitations/' + token(result), { user: null, ...options });
  const accept = (result, options = {}) => request('/invitations/' + token(result), { user: null, method: 'POST', body: { name: 'New colleague', password: 'a secure personal password' }, ...options });
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  return { pool, users, established, request, create, token, read, accept, one };
}

test('workspace invitations use hashed single-use links, enforce current authority, safely create users, and preserve existing accounts and membership', { skip: postgresSkip }, async t => {
  const { pool, users, established, request, create, token, read, accept, one } = await fixture(t);
  assert.equal((await create('blocked@example.test', 'editor', { user: users.viewer })).status, 403);
  assert.equal((await create('blocked@example.test', 'editor', { user: users.outside })).status, 404);
  assert.equal((await create('blocked@example.test', 'owner', { user: users.admin })).status, 403);
  assert.equal((await create('blocked@example.test', 'admin', { user: users.admin })).status, 403);
  assert.equal((await create('invalid-email')).status, 400);
  assert.equal((await create('new@example.test', 'superadmin')).status, 400);
  assert.equal((await create('viewer@example.test')).status, 409);
  const invitation = await create('  NEW@EXAMPLE.TEST  ', 'editor');
  assert.equal(invitation.status, 201); assert.equal(invitation.data.invitation.email, 'new@example.test'); assert.equal(token(invitation).length, 43);
  const raw = await one('SELECT * FROM workspace_invitations WHERE id = $1', [invitation.data.invitation.id]);
  assert.equal(raw.token_hash.length, 64); assert.equal(JSON.stringify(raw).includes(token(invitation)), false);
  assert.ok(Math.abs(raw.expires_at - raw.created_at - 7 * 86400000) < 100);
  let result = await read(invitation);
  assert.equal(result.status, 200); assert.deepEqual(Object.keys(result.data.invitation).sort(), ['email', 'expiresAt', 'role', 'workspaceName']);
  assert.equal(result.data.accountExists, false); assert.equal(result.data.requiresSignIn, false);
  assert.equal((await accept(invitation, { body: { name: 'New', password: 'short' } })).status, 400);
  assert.equal((await accept(invitation, { body: { name: 'New', password: 'long enough password', isOperator: true } })).status, 400);
  assert.equal((await accept(invitation, { user: users.outside })).status, 403);
  result = await accept(invitation); assert.equal(result.status, 200); assert.equal(result.data.user.isOperator, false); assert.equal(result.data.role, 'editor');
  assert.deepEqual(established, [result.data.user.id]); assert.equal((await one('SELECT role FROM memberships WHERE workspace_id = $1 AND user_id = $2', ['workspace-a', result.data.user.id])).role, 'editor');
  const joined = await one('SELECT * FROM users WHERE id = $1', [result.data.user.id]);
  assert.match(joined.password, /^scrypt\$/); assert.equal(joined.password.includes('a secure personal password'), false);
  assert.equal(await one('SELECT * FROM instance_operators WHERE user_id = $1', [joined.id]), undefined);
  assert.equal((await accept(invitation)).status, 410); assert.equal((await read(invitation)).status, 410);
  const existing = await create('existing@example.test', 'viewer');
  result = await read(existing); assert.equal(result.data.accountExists, true); assert.equal(result.data.requiresSignIn, true);
  assert.equal((await accept(existing)).status, 401);
  assert.equal((await accept(existing, { user: users.owner, body: {} })).status, 403);
  assert.equal((await accept(existing, { user: users.existing, body: { password: 'overwrite attempt password' } })).status, 400);
  result = await read(existing, { user: users.existing }); assert.equal(result.data.requiresSignIn, false);
  result = await accept(existing, { user: users.existing, body: {} }); assert.equal(result.status, 200); assert.equal(result.data.role, 'viewer');
  assert.equal((await one("SELECT password FROM users WHERE id = 'existing'")).password, 'EXISTING_HASH'); assert.equal(established.length, 1);
  const elevated = await create('elevated@example.test', 'owner');
  await pool.query("UPDATE memberships SET role = 'admin' WHERE workspace_id = 'workspace-a' AND user_id = 'owner'");
  assert.equal((await read(elevated)).status, 410); assert.equal((await accept(elevated)).status, 410);
  await pool.query("UPDATE memberships SET role = 'owner' WHERE workspace_id = 'workspace-a' AND user_id = 'owner'");
  assert.equal((await request('/workspaces/workspace-a/invitations/' + elevated.data.invitation.id, { method: 'DELETE', user: users.admin })).status, 403);
  const invitations = async () => (await one('SELECT count(*) AS count FROM workspace_invitations')).count;
  for (const granted of ['owner', 'admin']) {
    const mail = `replace-${granted}@example.test`, protectedInvite = await create(mail, granted);
    for (const requested of ['editor', 'viewer']) {
      const before = await invitations();
      assert.equal((await create(mail, requested, { user: users.admin })).status, 403, 'Replacing an invitation must require authority over its previous role.');
      assert.equal(await invitations(), before);
      assert.equal((await one('SELECT revoked_at FROM workspace_invitations WHERE id = $1', [protectedInvite.data.invitation.id])).revoked_at, null);
      assert.equal((await read(protectedInvite)).status, 200, 'A denied replacement must preserve the original invitation token.');
    }
    const replacement = await create(mail, 'viewer');
    assert.equal(replacement.status, 201); assert.equal((await read(protectedInvite)).status, 410); assert.equal((await read(replacement)).status, 200);
    const expiredMail = `expired-${granted}@example.test`, expiredInvite = await create(expiredMail, granted);
    await pool.query('UPDATE workspace_invitations SET expires_at = 0 WHERE id = $1', [expiredInvite.data.invitation.id]);
    assert.equal((await create(expiredMail, 'editor', { user: users.admin })).status, 403, 'Expired invitations still require authority before their pending rows can be revoked.');
    assert.equal((await one('SELECT revoked_at FROM workspace_invitations WHERE id = $1', [expiredInvite.data.invitation.id])).revoked_at, null);
    assert.equal((await create(expiredMail, 'editor')).status, 201);
  }
  for (const granted of ['editor', 'viewer']) {
    const mail = `replace-${granted}@example.test`, first = await create(mail, granted);
    const replacement = await create(mail, granted === 'editor' ? 'viewer' : 'editor', { user: users.admin });
    assert.equal(replacement.status, 201); assert.equal((await read(first)).status, 410); assert.equal((await read(replacement)).status, 200);
  }
  const low = await create('low@example.test', 'viewer', { user: users.admin });
  await pool.query("UPDATE memberships SET role = 'editor' WHERE workspace_id = 'workspace-a' AND user_id = 'admin'");
  assert.equal((await accept(low)).status, 410);
  await pool.query("UPDATE memberships SET role = 'admin' WHERE workspace_id = 'workspace-a' AND user_id = 'admin'");
  const revoked = await create('revoke@example.test');
  assert.equal((await request('/workspaces/workspace-b/invitations/' + revoked.data.invitation.id, { method: 'DELETE', user: users.outside })).status, 404);
  assert.equal((await request('/workspaces/workspace-a/invitations/' + revoked.data.invitation.id, { method: 'DELETE' })).status, 200);
  assert.equal((await accept(revoked)).status, 410);
  const expired = await create('expired@example.test'); await pool.query('UPDATE workspace_invitations SET expires_at = 0 WHERE id = $1', [expired.data.invitation.id]);
  assert.equal((await read(expired)).status, 410);
  const first = await create('replace@example.test'), replacement = await create('replace@example.test');
  assert.notEqual(token(first), token(replacement)); assert.equal((await read(first)).status, 410); assert.equal((await read(replacement)).status, 200);
  const race = await create('race@example.test'), pending = accept(race);
  await request('/workspaces/workspace-a/invitations/' + race.data.invitation.id, { method: 'DELETE' });
  assert.equal((await pending).status, 410); assert.equal(await one("SELECT * FROM users WHERE email = 'race@example.test'"), undefined);
  const eventualOwner = await create('outside@example.test', 'editor');
  await pool.query("INSERT INTO memberships VALUES ('workspace-a','outside','owner')");
  result = await accept(eventualOwner, { user: users.outside, body: {} }); assert.equal(result.status, 200); assert.equal(result.data.alreadyMember, true); assert.equal(result.data.role, 'owner');
  assert.equal((await one("SELECT count(*) AS count FROM memberships WHERE workspace_id = 'workspace-a' AND role = 'owner'")).count, 2);
  const ownerInvite = await create('new-owner@example.test', 'owner'); result = await accept(ownerInvite); assert.equal(result.status, 200); assert.equal(result.data.role, 'owner'); assert.equal(result.data.user.isOperator, false);
  const list = await request('/workspaces/workspace-a/invitations'); assert.equal(list.status, 200); assert.ok(list.data.invitations.some(row => row.status === 'accepted')); assert.ok(list.data.invitations.some(row => row.status === 'revoked'));
  assert.equal(JSON.stringify(list.data).includes('token_hash'), false); assert.equal(JSON.stringify(list.data).includes(token(replacement)), false);
  assert.equal((await request('/invitations/not-a-token', { user: null })).status, 404);
  assert.equal((await request('/workspaces/workspace-a/invitations', { user: null })).status, 401);
});

test('new invitation links carry the token in #invite=, and inspect and accept take it in a POST body beside the earlier path routes', { skip: postgresSkip }, async t => {
  const { users, established, request, create, token, read } = await fixture(t);
  const invitation = await create('fragment@example.test'), link = new URL(invitation.data.url);
  assert.equal(link.pathname, '/'); assert.equal(link.search, ''); assert.match(link.hash, /^#invite=[A-Za-z0-9_-]{43}$/);
  const inspect = (body, options = {}) => request('/invitations/inspect', { method: 'POST', user: null, body, ...options });
  const accept = (body, options = {}) => request('/invitations/accept', { method: 'POST', user: null, body, ...options });
  let result = await inspect({ token: token(invitation) });
  assert.equal(result.status, 200); assert.equal(result.data.invitation.email, 'fragment@example.test'); assert.equal(result.data.accountExists, false);
  assert.deepEqual(result, await read(invitation), 'The body and path inspections agree.');
  assert.equal((await inspect({ token: token(invitation), name: 'Extra' })).status, 400);
  for (const body of [{}, { token: 42 }, { token: 'not-a-token' }]) assert.equal((await inspect(body)).status, 404, JSON.stringify(body));
  assert.equal((await accept({ token: token(invitation), name: 'Fragment', password: 'short' })).status, 400);
  assert.equal((await accept({ token: token(invitation), name: 'Fragment', password: 'a secure personal password', isOperator: true })).status, 400);
  result = await accept({ token: token(invitation), name: 'Fragment colleague', password: 'a secure personal password' });
  assert.equal(result.status, 200); assert.equal(result.data.created, true); assert.equal(result.data.role, 'editor'); assert.deepEqual(established, [result.data.user.id]);
  assert.equal((await accept({ token: token(invitation) })).status, 410); assert.equal((await read(invitation)).status, 410);
  // An existing account accepts with only the token; the body cannot carry a name or password for it.
  const existing = await create('existing@example.test', 'viewer');
  assert.equal((await accept({ token: token(existing) })).status, 401);
  assert.equal((await accept({ token: token(existing), password: 'overwrite attempt password' }, { user: users.existing })).status, 400);
  result = await accept({ token: token(existing) }, { user: users.existing }); assert.equal(result.status, 200); assert.equal(result.data.role, 'viewer');
  // Links issued before the move keep working through the token-in-path routes.
  const legacy = await create('legacy@example.test');
  assert.equal((await read(legacy)).status, 200);
  assert.equal((await request('/invitations/' + token(legacy), { user: null, method: 'POST', body: { name: 'Legacy colleague', password: 'a secure personal password' } })).status, 200);
});

test('an invitation accepted twice at once joins once, and one new address invited to two workspaces creates one account', { skip: postgresSkip }, async t => {
  const { pool, users, request, create, accept, one } = await fixture(t);
  // Both acceptances find the invitation valid before either writes; only the invitation row lock makes it single use.
  const twice = await create('existing@example.test', 'viewer'), gate = await blockWrites(pool, 'memberships');
  const acceptances = [accept(twice, { user: users.existing, body: {} }), accept(twice, { user: users.existing, body: {} })];
  await gate.waiting(2); await gate.release();
  assert.deepEqual((await Promise.all(acceptances)).map(result => result.status).sort(), [200, 410]);
  assert.equal((await one("SELECT count(*) AS count FROM memberships WHERE user_id = 'existing'")).count, 1);
  await pool.query("INSERT INTO memberships VALUES ('workspace-b','owner','owner')");
  const inA = await create('twice@example.test'), inB = await request('/workspaces/workspace-b/invitations', { method: 'POST', body: { email: 'twice@example.test', role: 'editor' } });
  // Without the email lock both acceptances see no account and race to create it.
  const users_ = await blockWrites(pool, 'users');
  const signups = [accept(inA), accept(inB)];
  await users_.waiting(2); await users_.release();
  const outcomes = await Promise.all(signups);
  assert.deepEqual(outcomes.map(result => result.status).sort(), [200, 409]);
  assert.equal((await one("SELECT count(*) AS count FROM users WHERE email = 'twice@example.test'")).count, 1);
});

test('parallel invitations for one address leave one pending invitation', { skip: postgresSkip }, async t => {
  const { pool, create, one } = await fixture(t);
  // Each create revokes earlier pending rows; without the workspace lock both inserts survive.
  const gate = await blockWrites(pool, 'workspace_invitations');
  const created = [create('parallel@example.test'), create('parallel@example.test')];
  await gate.waiting(2); await gate.release();
  assert.deepEqual((await Promise.all(created)).map(result => result.status), [201, 201]);
  assert.equal((await one("SELECT count(*) AS count FROM workspace_invitations WHERE email = 'parallel@example.test' AND revoked_at IS NULL")).count, 1);
});
