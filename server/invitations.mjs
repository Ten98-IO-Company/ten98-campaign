import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hashPassword, HttpError, publicUser } from './auth.mjs';
import { transaction } from './database.mjs';

const initialized = new WeakSet(), roles = ['owner', 'admin', 'editor', 'viewer'];
const fail = (status, message) => { throw new HttpError(status, message); };
const digest = token => createHash('sha256').update(token).digest('hex');
function initialize(db) {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_invitations(id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,email TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('owner','admin','editor','viewer')),inviter_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,token_hash TEXT UNIQUE NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,accepted_at INTEGER,revoked_at INTEGER);
    CREATE INDEX IF NOT EXISTS workspace_invitations_workspace ON workspace_invitations(workspace_id,created_at);`);
  initialized.add(db);
}
function publicInvitation(row, now = Date.now()) {
  return { id: row.id, email: row.email, role: row.role, workspaceName: row.workspace_name, expiresAt: new Date(row.expires_at).toISOString(), createdAt: new Date(row.created_at).toISOString(), status: row.accepted_at ? 'accepted' : row.revoked_at ? 'revoked' : row.expires_at <= now ? 'expired' : 'pending' };
}
function find(db, token) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail(404, 'This invitation is unavailable.');
  const row = db.prepare('SELECT i.*,w.name AS workspace_name FROM workspace_invitations i JOIN workspaces w ON w.id=i.workspace_id WHERE token_hash=?').get(digest(token));
  if (!row || row.accepted_at || row.revoked_at || row.expires_at <= Date.now()) fail(410, 'This invitation has expired, was used, or was revoked. Ask for a new invitation.');
  const inviter = db.prepare('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?').get(row.workspace_id, row.inviter_id);
  if (!inviter || !['owner', 'admin'].includes(inviter.role) || (inviter.role === 'admin' && ['owner', 'admin'].includes(row.role))) fail(410, 'The person who invited you can no longer grant this access. Ask a workspace owner for a new invitation.');
  return row;
}
function object(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'Use only the fields shown in the invitation form.');
}
function email(value) {
  if (typeof value !== 'string' || value.length > 254) fail(400, 'Enter a valid email address.');
  const result = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result) || /[\u0000-\u001f\u007f]/.test(result)) fail(400, 'Enter a valid email address.');
  return result;
}
const account = (db, mail) => db.prepare('SELECT id,name,email,EXISTS(SELECT 1 FROM instance_operators o WHERE o.user_id=users.id) AS isOperator FROM users WHERE email=?').get(mail);

export async function handleInvitations(context) {
  const { req, url, body = {}, user, db, auth, config, send, workspaceAccess, establish } = context;
  const publicRoute = url.pathname.match(/^\/api\/invitations\/([^/]+)$/), teamRoute = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/invitations(?:\/([^/]+))?$/);
  if (!publicRoute && !teamRoute) return false;
  initialize(db);
  if (publicRoute) {
    if (!['GET', 'POST'].includes(req.method)) fail(405, 'This invitation action is unavailable.');
    auth.limit('invitation:' + req.method + ':' + (req.socket?.remoteAddress || 'local'), req.method === 'GET' ? 120 : 30);
    const token = publicRoute[1], invite = find(db, token), existing = account(db, invite.email), signedIn = user && existing && user.id === existing.id && user.email === invite.email;
    if (req.method === 'GET') {
      send(200, { invitation: { email: invite.email, role: invite.role, workspaceName: invite.workspace_name, expiresAt: new Date(invite.expires_at).toISOString() }, accountExists: Boolean(existing), requiresSignIn: Boolean(existing && !signedIn) });
      return true;
    }
    object(body, ['name', 'password']);
    if (user && !signedIn) fail(403, `Sign out and sign in as ${invite.email} to accept this invitation.`);
    if (existing && !signedIn) fail(401, 'Sign in with the invited account before accepting this invitation.');
    let name, hash;
    if (!existing) {
      if (typeof establish !== 'function') fail(500, 'The invitation sign-in service is unavailable.');
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120 || /[\u0000-\u001f\u007f]/.test(body.name)) fail(400, 'Enter your name using at most 120 characters.');
      if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) fail(400, 'Use a password between 12 and 128 characters.');
      name = body.name.trim(); hash = await hashPassword(body.password);
    } else if (Object.keys(body).length) fail(400, 'Accept with your existing account. Invitation links cannot change your name or password.');
    const accepted = transaction(db, () => {
      const current = find(db, token), target = account(db, current.email);
      if ((!existing && target) || (existing && (!target || target.id !== existing.id))) fail(409, 'The invited account changed. Sign in with that account and open the invitation again.');
      const joined = target || { id: randomUUID(), name, email: current.email, isOperator: false };
      if (!target) db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(joined.id, joined.name, joined.email, hash);
      const membership = db.prepare('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?').get(current.workspace_id, joined.id);
      if (!membership) db.prepare('INSERT INTO memberships VALUES(?,?,?)').run(current.workspace_id, joined.id, current.role);
      db.prepare('UPDATE workspace_invitations SET accepted_at=? WHERE id=?').run(Date.now(), current.id);
      return { user: publicUser(joined), workspaceId: current.workspace_id, role: membership?.role || current.role, alreadyMember: Boolean(membership), created: !target };
    });
    if (accepted.created) establish(accepted.user.id);
    send(200, accepted); return true;
  }
  if (!user) fail(401, 'Sign in to manage workspace invitations.');
  const workspaceId = teamRoute[1], role = workspaceAccess(workspaceId, user.id);
  if (!['owner', 'admin'].includes(role)) fail(403, 'Only workspace owners and administrators can invite team members.');
  if (req.method === 'GET' && !teamRoute[2]) {
    // ponytail: show the latest 200 invitations; add pagination if a workspace needs a longer audit trail.
    const rows = db.prepare('SELECT i.*,w.name AS workspace_name FROM workspace_invitations i JOIN workspaces w ON w.id=i.workspace_id WHERE workspace_id=? ORDER BY created_at DESC,i.rowid DESC LIMIT 200').all(workspaceId);
    send(200, { invitations: rows.map(row => publicInvitation(row)) }); return true;
  }
  if (req.method === 'POST' && !teamRoute[2]) {
    auth.limit('invitation-create:' + workspaceId + ':' + user.id, 30); object(body, ['email', 'role']);
    const mail = email(body.email), requested = body.role === undefined ? 'editor' : body.role;
    if (!roles.includes(requested)) fail(400, 'Choose an available workspace role.');
    if (role === 'admin' && ['owner', 'admin'].includes(requested)) fail(403, 'Only a workspace owner can invite owners or administrators.');
    const token = randomBytes(32).toString('base64url'), now = Date.now();
    const invite = transaction(db, () => {
      const target = account(db, mail);
      if (target && db.prepare('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?').get(workspaceId, target.id)) fail(409, 'This person already belongs to the workspace. Change their access in Team access.');
      db.prepare('UPDATE workspace_invitations SET revoked_at=? WHERE workspace_id=? AND email=? AND accepted_at IS NULL AND revoked_at IS NULL').run(now, workspaceId, mail);
      if (db.prepare('SELECT count(*) AS count FROM workspace_invitations WHERE workspace_id=? AND expires_at>? AND accepted_at IS NULL AND revoked_at IS NULL').get(workspaceId, now).count >= 100) fail(409, 'This workspace has 100 pending invitations. Revoke unused invitations before creating more.');
      const id = randomUUID(), expires = now + 7 * 86400000;
      db.prepare('INSERT INTO workspace_invitations VALUES(?,?,?,?,?,?,?,?,NULL,NULL)').run(id, workspaceId, mail, requested, user.id, digest(token), now, expires);
      return publicInvitation({ id, email: mail, role: requested, workspace_name: db.prepare('SELECT name FROM workspaces WHERE id=?').get(workspaceId).name, created_at: now, expires_at: expires });
    });
    send(201, { invitation: invite, url: `${config.appUrl}/?invite=${token}` }); return true;
  }
  if (req.method === 'DELETE' && teamRoute[2]) {
    const invite = db.prepare('SELECT * FROM workspace_invitations WHERE workspace_id=? AND id=?').get(workspaceId, teamRoute[2]);
    if (!invite) fail(404, 'Workspace invitation not found.');
    if (role === 'admin' && ['owner', 'admin'].includes(invite.role)) fail(403, 'Only an owner can revoke invitations for owners and administrators.');
    if (invite.accepted_at) fail(409, 'This invitation was already accepted. Manage the person in Team access.');
    db.prepare('UPDATE workspace_invitations SET revoked_at=COALESCE(revoked_at,?) WHERE id=?').run(Date.now(), invite.id);
    send(200, { ok: true }); return true;
  }
  fail(405, 'This workspace invitation action is unavailable.');
}
