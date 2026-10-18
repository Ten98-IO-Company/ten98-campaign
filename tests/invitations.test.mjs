import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleInvitations } from '../server/invitations.mjs';
import { HttpError } from '../server/auth.mjs';

test('workspace invitations use hashed single-use links, enforce current authority, safely create users, and preserve existing accounts and membership', async () => {
  const db = new DatabaseSync(':memory:'), established = [];
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL,email TEXT UNIQUE NOT NULL,password TEXT);
    CREATE TABLE instance_operators(user_id TEXT PRIMARY KEY REFERENCES users(id));
    CREATE TABLE workspaces(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE memberships(workspace_id TEXT NOT NULL REFERENCES workspaces(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,PRIMARY KEY(workspace_id,user_id));
    INSERT INTO users VALUES('owner','Owner','owner@example.test','OWNER_HASH'),('admin','Admin','admin@example.test','ADMIN_HASH'),('viewer','Viewer','viewer@example.test','VIEWER_HASH'),('outside','Outside','outside@example.test','OUTSIDE_HASH'),('existing','Existing','existing@example.test','EXISTING_HASH');
    INSERT INTO workspaces VALUES('workspace-a','Studio A'),('workspace-b','Studio B');
    INSERT INTO memberships VALUES('workspace-a','owner','owner'),('workspace-a','admin','admin'),('workspace-a','viewer','viewer'),('workspace-b','outside','owner');
    INSERT INTO instance_operators VALUES('owner');`);
  const users = Object.fromEntries(db.prepare('SELECT id,name,email FROM users').all().map(user => [user.id, user]));
  const auth = { limit() {} }, workspaceAccess = (workspaceId, userId) => {
    const member = db.prepare('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?').get(workspaceId, userId);
    if (!member) throw new HttpError(404, 'Workspace not available.'); return member.role;
  };
  async function request(path, { method = 'GET', body = {}, user = users.owner } = {}) {
    let response;
    try {
      const handled = await handleInvitations({ req: { method, socket: { remoteAddress: '127.0.0.1' } }, url: new URL('https://campaign.example/api' + path), body, user, db, auth, config: { appUrl: 'https://campaign.example' }, workspaceAccess, establish: id => established.push(id), send: (status, data) => { response = { status, data }; } });
      assert.equal(handled, true); return response;
    } catch (error) { if (error instanceof HttpError) return { status: error.status, data: { error: error.message } }; throw error; }
  }
  const create = (email, role = 'editor', options = {}) => request('/workspaces/workspace-a/invitations', { method: 'POST', body: { email, role }, ...options });
  const token = result => new URL(result.data.url).searchParams.get('invite');
  const read = (result, options = {}) => request('/invitations/' + token(result), { user: null, ...options });
  const accept = (result, options = {}) => request('/invitations/' + token(result), { user: null, method: 'POST', body: { name: 'New colleague', password: 'a secure personal password' }, ...options });
  try {
    assert.equal((await create('blocked@example.test', 'editor', { user: users.viewer })).status, 403);
    assert.equal((await create('blocked@example.test', 'editor', { user: users.outside })).status, 404);
    assert.equal((await create('blocked@example.test', 'owner', { user: users.admin })).status, 403);
    assert.equal((await create('blocked@example.test', 'admin', { user: users.admin })).status, 403);
    assert.equal((await create('invalid-email')).status, 400);
    assert.equal((await create('new@example.test', 'superadmin')).status, 400);
    assert.equal((await create('viewer@example.test')).status, 409);
    const invitation = await create('  NEW@EXAMPLE.TEST  ', 'editor');
    assert.equal(invitation.status, 201); assert.equal(invitation.data.invitation.email, 'new@example.test'); assert.equal(token(invitation).length, 43);
    const raw = db.prepare('SELECT * FROM workspace_invitations WHERE id=?').get(invitation.data.invitation.id);
    assert.equal(raw.token_hash.length, 64); assert.equal(JSON.stringify(raw).includes(token(invitation)), false);
    assert.ok(Math.abs(raw.expires_at - raw.created_at - 7 * 86400000) < 100);
    let result = await read(invitation);
    assert.equal(result.status, 200); assert.deepEqual(Object.keys(result.data.invitation).sort(), ['email', 'expiresAt', 'role', 'workspaceName']);
    assert.equal(result.data.accountExists, false); assert.equal(result.data.requiresSignIn, false);
    assert.equal((await accept(invitation, { body: { name: 'New', password: 'short' } })).status, 400);
    assert.equal((await accept(invitation, { body: { name: 'New', password: 'long enough password', isOperator: true } })).status, 400);
    assert.equal((await accept(invitation, { user: users.outside })).status, 403);
    result = await accept(invitation); assert.equal(result.status, 200); assert.equal(result.data.user.isOperator, false); assert.equal(result.data.role, 'editor');
    assert.deepEqual(established, [result.data.user.id]); assert.equal(db.prepare('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?').get('workspace-a', result.data.user.id).role, 'editor');
    const joined = db.prepare('SELECT * FROM users WHERE id=?').get(result.data.user.id);
    assert.match(joined.password, /^scrypt\$/); assert.equal(joined.password.includes('a secure personal password'), false);
    assert.equal(db.prepare('SELECT * FROM instance_operators WHERE user_id=?').get(joined.id), undefined);
    assert.equal((await accept(invitation)).status, 410); assert.equal((await read(invitation)).status, 410);
    const existing = await create('existing@example.test', 'viewer');
    result = await read(existing); assert.equal(result.data.accountExists, true); assert.equal(result.data.requiresSignIn, true);
    assert.equal((await accept(existing)).status, 401);
    assert.equal((await accept(existing, { user: users.owner, body: {} })).status, 403);
    assert.equal((await accept(existing, { user: users.existing, body: { password: 'overwrite attempt password' } })).status, 400);
    result = await read(existing, { user: users.existing }); assert.equal(result.data.requiresSignIn, false);
    result = await accept(existing, { user: users.existing, body: {} }); assert.equal(result.status, 200); assert.equal(result.data.role, 'viewer');
    assert.equal(db.prepare('SELECT password FROM users WHERE id=?').get('existing').password, 'EXISTING_HASH'); assert.equal(established.length, 1);
    const elevated = await create('elevated@example.test', 'owner');
    db.prepare("UPDATE memberships SET role='admin' WHERE workspace_id='workspace-a' AND user_id='owner'").run();
    assert.equal((await read(elevated)).status, 410); assert.equal((await accept(elevated)).status, 410);
    db.prepare("UPDATE memberships SET role='owner' WHERE workspace_id='workspace-a' AND user_id='owner'").run();
    assert.equal((await request('/workspaces/workspace-a/invitations/' + elevated.data.invitation.id, { method: 'DELETE', user: users.admin })).status, 403);
    const low = await create('low@example.test', 'viewer', { user: users.admin });
    db.prepare("UPDATE memberships SET role='editor' WHERE workspace_id='workspace-a' AND user_id='admin'").run();
    assert.equal((await accept(low)).status, 410);
    db.prepare("UPDATE memberships SET role='admin' WHERE workspace_id='workspace-a' AND user_id='admin'").run();
    const revoked = await create('revoke@example.test');
    assert.equal((await request('/workspaces/workspace-b/invitations/' + revoked.data.invitation.id, { method: 'DELETE', user: users.outside })).status, 404);
    assert.equal((await request('/workspaces/workspace-a/invitations/' + revoked.data.invitation.id, { method: 'DELETE' })).status, 200);
    assert.equal((await accept(revoked)).status, 410);
    const expired = await create('expired@example.test'); db.prepare('UPDATE workspace_invitations SET expires_at=0 WHERE id=?').run(expired.data.invitation.id);
    assert.equal((await read(expired)).status, 410);
    const first = await create('replace@example.test'), replacement = await create('replace@example.test');
    assert.notEqual(token(first), token(replacement)); assert.equal((await read(first)).status, 410); assert.equal((await read(replacement)).status, 200);
    const race = await create('race@example.test'), pending = accept(race);
    await request('/workspaces/workspace-a/invitations/' + race.data.invitation.id, { method: 'DELETE' });
    assert.equal((await pending).status, 410); assert.equal(db.prepare('SELECT * FROM users WHERE email=?').get('race@example.test'), undefined);
    const eventualOwner = await create('outside@example.test', 'editor');
    db.prepare("INSERT INTO memberships VALUES('workspace-a','outside','owner')").run();
    result = await accept(eventualOwner, { user: users.outside, body: {} }); assert.equal(result.status, 200); assert.equal(result.data.alreadyMember, true); assert.equal(result.data.role, 'owner');
    assert.equal(db.prepare("SELECT count(*) AS count FROM memberships WHERE workspace_id='workspace-a' AND role='owner'").get().count, 2);
    const ownerInvite = await create('new-owner@example.test', 'owner'); result = await accept(ownerInvite); assert.equal(result.status, 200); assert.equal(result.data.role, 'owner'); assert.equal(result.data.user.isOperator, false);
    const list = await request('/workspaces/workspace-a/invitations'); assert.equal(list.status, 200); assert.ok(list.data.invitations.some(row => row.status === 'accepted')); assert.ok(list.data.invitations.some(row => row.status === 'revoked'));
    assert.equal(JSON.stringify(list.data).includes('token_hash'), false); assert.equal(JSON.stringify(list.data).includes(token(replacement)), false);
    assert.equal((await request('/invitations/not-a-token', { user: null })).status, 404);
    assert.equal((await request('/workspaces/workspace-a/invitations', { user: null })).status, 401);
  } finally { db.close(); }
});
