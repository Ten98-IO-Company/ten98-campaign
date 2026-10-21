import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { workspaceRoles as roles, mayGrantWorkspaceRole } from '@ten98/runtime';
import { advisoryLock, hashPassword, HttpError, lockWorkspace, memberRole, publicUser } from './auth.ts';
import type { Database, Executor } from './database.ts';
import type { ProviderRecord } from './provider-core.ts';

function fail(status: number, message: string): never { throw new HttpError(status, message); }
const digest = (token: string) => createHash('sha256').update(token).digest('hex');
const first = async (query: Promise<{ rows: unknown[] }>) => (await query).rows[0] as ProviderRecord | undefined;
function publicInvitation(row: ProviderRecord, now = Date.now()) {
  return { id: row.id, email: row.email, role: row.role, workspaceName: row.workspace_name, expiresAt: new Date(row.expires_at).toISOString(), createdAt: new Date(row.created_at).toISOString(), status: row.accepted_at ? 'accepted' : row.revoked_at ? 'revoked' : row.expires_at <= now ? 'expired' : 'pending' };
}
async function find(db: Executor, token: string, lock = false): Promise<ProviderRecord> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) fail(404, 'This invitation is unavailable.');
  const row = await first(db.execute(lock
    ? sql`SELECT i.*, w.name AS workspace_name FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id WHERE token_hash = ${digest(token)} FOR UPDATE OF i`
    : sql`SELECT i.*, w.name AS workspace_name FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id WHERE token_hash = ${digest(token)}`));
  if (!row || row.accepted_at || row.revoked_at || row.expires_at <= Date.now()) fail(410, 'This invitation has expired, was used, or was revoked. Ask for a new invitation.');
  if (!mayGrantWorkspaceRole(await memberRole(db, row.workspace_id, row.inviter_id), row.role)) fail(410, 'The person who invited you can no longer grant this access. Ask a workspace owner for a new invitation.');
  return row;
}
function object(body: any, allowed: string[]) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'Use only the fields shown in the invitation form.');
}
function email(value: unknown) {
  if (typeof value !== 'string' || value.length > 254) fail(400, 'Enter a valid email address.');
  const result = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result) || /[\u0000-\u001f\u007f]/.test(result)) fail(400, 'Enter a valid email address.');
  return result;
}
type AccountRow = { id: string; name: string; email: string; isOperator: unknown };
const account = async (db: Executor, mail: string) => await first(db.execute(sql`SELECT id, name, email, EXISTS (SELECT 1 FROM instance_operators o WHERE o.user_id = users.id) AS "isOperator" FROM users WHERE email = ${mail}`)) as AccountRow | undefined;
// Team changes re-read the actor's role under the workspace lock; the role read before the transaction may be stale.
async function lockedRole(tx: Executor, workspaceId: string, userId: string): Promise<string> {
  const role = await lockWorkspace(tx, workspaceId) ? await memberRole(tx, workspaceId, userId) : undefined;
  if (!role) fail(404, 'Workspace not found or unavailable.');
  if (!['owner', 'admin'].includes(role)) fail(403, 'Only workspace owners and administrators can invite team members.');
  return role;
}

export async function handleInvitations(context: ProviderRecord) {
  const { req, url, body = {}, user, auth, config, send, workspaceAccess, establish } = context, db: Database = context.db;
  const publicRoute = url.pathname.match(/^\/api\/invitations\/([^/]+)$/), teamRoute = url.pathname.match(/^\/api\/workspaces\/([^/]+)\/invitations(?:\/([^/]+))?$/);
  if (!publicRoute && !teamRoute) return false;
  if (publicRoute) {
    if (!['GET', 'POST'].includes(req.method)) fail(405, 'This invitation action is unavailable.');
    await auth.limit('invitation:' + req.method + ':' + (auth.clientAddress(req) || 'local'), req.method === 'GET' ? 120 : 30);
    const token = publicRoute[1], invite = await find(db, token), existing = await account(db, invite.email), signedIn = user && existing && user.id === existing.id && user.email === invite.email;
    if (req.method === 'GET') {
      send(200, { invitation: { email: invite.email, role: invite.role, workspaceName: invite.workspace_name, expiresAt: new Date(invite.expires_at).toISOString() }, accountExists: Boolean(existing), requiresSignIn: Boolean(existing && !signedIn) });
      return true;
    }
    object(body, ['name', 'password']);
    if (user && !signedIn) fail(403, `Sign out and sign in as ${invite.email} to accept this invitation.`);
    if (existing && !signedIn) fail(401, 'Sign in with the invited account before accepting this invitation.');
    let name: string | undefined, hash: string | undefined;
    if (!existing) {
      if (typeof establish !== 'function') fail(500, 'The invitation sign-in service is unavailable.');
      if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120 || /[\u0000-\u001f\u007f]/.test(body.name)) fail(400, 'Enter your name using at most 120 characters.');
      if (typeof body.password !== 'string' || body.password.length < 12 || body.password.length > 128) fail(400, 'Use a password between 12 and 128 characters.');
      name = body.name.trim(); hash = await hashPassword(body.password);
    } else if (Object.keys(body).length) fail(400, 'Accept with your existing account. Invitation links cannot change your name or password.');
    // Lock order: workspace → invitation → email; the invitation row lock makes acceptance single use.
    const accepted = await db.transaction(async tx => {
      await lockWorkspace(tx, invite.workspace_id);
      const current = await find(tx, token, true);
      await advisoryLock(tx, 'email:' + current.email);
      const target = await account(tx, current.email);
      if ((!existing && target) || (existing && (!target || target.id !== existing.id))) fail(409, 'The invited account changed. Sign in with that account and open the invitation again.');
      const joined = target || { id: randomUUID(), name: name!, email: current.email, isOperator: false };
      if (!target) await tx.execute(sql`INSERT INTO users VALUES (${joined.id}, ${joined.name}, ${joined.email}, ${hash})`);
      const role = await memberRole(tx, current.workspace_id, joined.id);
      if (!role) await tx.execute(sql`INSERT INTO memberships VALUES (${current.workspace_id}, ${joined.id}, ${current.role})`);
      await tx.execute(sql`UPDATE workspace_invitations SET accepted_at = ${Date.now()} WHERE id = ${current.id}`);
      if (!target) await establish(joined.id, tx);
      return { user: publicUser(joined), workspaceId: current.workspace_id, role: role || current.role, alreadyMember: Boolean(role), created: !target };
    });
    send(200, accepted); return true;
  }
  if (!user) fail(401, 'Sign in to manage workspace invitations.');
  const workspaceId = teamRoute[1], role = await workspaceAccess(workspaceId, user.id);
  if (!['owner', 'admin'].includes(role)) fail(403, 'Only workspace owners and administrators can invite team members.');
  if (req.method === 'GET' && !teamRoute[2]) {
    // ponytail: show the latest 200 invitations; add pagination if a workspace needs a longer audit trail.
    const { rows } = await db.execute(sql`SELECT i.*, w.name AS workspace_name FROM workspace_invitations i JOIN workspaces w ON w.id = i.workspace_id WHERE workspace_id = ${workspaceId} ORDER BY created_at DESC, i.seq DESC LIMIT 200`);
    send(200, { invitations: rows.map(row => publicInvitation(row as ProviderRecord)) }); return true;
  }
  if (req.method === 'POST' && !teamRoute[2]) {
    await auth.limit('invitation-create:' + workspaceId + ':' + user.id, 30); object(body, ['email', 'role']);
    const mail = email(body.email), requested = body.role === undefined ? 'editor' : body.role;
    if (!roles.includes(requested)) fail(400, 'Choose an available workspace role.');
    if (!mayGrantWorkspaceRole(role, requested)) fail(403, 'Only a workspace owner can invite owners or administrators.');
    const token = randomBytes(32).toString('base64url'), now = Date.now();
    const invite = await db.transaction(async tx => {
      const current = await lockedRole(tx, workspaceId, user.id);
      if (!mayGrantWorkspaceRole(current, requested)) fail(403, 'Only a workspace owner can invite owners or administrators.');
      const target = await account(tx, mail);
      if (target && await memberRole(tx, workspaceId, target.id)) fail(409, 'This person already belongs to the workspace. Change their access in Team access.');
      const { rows: pending } = await tx.execute(sql`SELECT role FROM workspace_invitations WHERE workspace_id = ${workspaceId} AND email = ${mail} AND accepted_at IS NULL AND revoked_at IS NULL`);
      if (pending.some(invitation => !mayGrantWorkspaceRole(current, (invitation as ProviderRecord).role))) fail(403, 'Only an owner can replace invitations for owners and administrators.');
      await tx.execute(sql`UPDATE workspace_invitations SET revoked_at = ${now} WHERE workspace_id = ${workspaceId} AND email = ${mail} AND accepted_at IS NULL AND revoked_at IS NULL`);
      if ((await first(tx.execute(sql`SELECT count(*) AS count FROM workspace_invitations WHERE workspace_id = ${workspaceId} AND expires_at > ${now} AND accepted_at IS NULL AND revoked_at IS NULL`)))!.count >= 100) fail(409, 'This workspace has 100 pending invitations. Revoke unused invitations before creating more.');
      const id = randomUUID(), expires = now + 7 * 86400000;
      await tx.execute(sql`INSERT INTO workspace_invitations (id, workspace_id, email, role, inviter_id, token_hash, created_at, expires_at) VALUES (${id}, ${workspaceId}, ${mail}, ${requested}, ${user.id}, ${digest(token)}, ${now}, ${expires})`);
      return publicInvitation({ id, email: mail, role: requested, workspace_name: (await first(tx.execute(sql`SELECT name FROM workspaces WHERE id = ${workspaceId}`)))!.name, created_at: now, expires_at: expires });
    });
    send(201, { invitation: invite, url: `${config.appUrl}/?invite=${token}` }); return true;
  }
  if (req.method === 'DELETE' && teamRoute[2]) {
    await db.transaction(async tx => {
      const current = await lockedRole(tx, workspaceId, user.id);
      const invite = await first(tx.execute(sql`SELECT * FROM workspace_invitations WHERE workspace_id = ${workspaceId} AND id = ${teamRoute[2]} FOR UPDATE`));
      if (!invite) fail(404, 'Workspace invitation not found.');
      if (!mayGrantWorkspaceRole(current, invite.role)) fail(403, 'Only an owner can revoke invitations for owners and administrators.');
      if (invite.accepted_at) fail(409, 'This invitation was already accepted. Manage the person in Team access.');
      await tx.execute(sql`UPDATE workspace_invitations SET revoked_at = COALESCE(revoked_at, ${Date.now()}) WHERE id = ${invite.id}`);
    });
    send(200, { ok: true }); return true;
  }
  fail(405, 'This workspace invitation action is unavailable.');
}
