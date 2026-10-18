import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, relative, extname, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes } from 'node:crypto';
import { openDatabase, createStore, collections, transaction } from './database.mjs';
import { createAuth, sessionSecret, hashPassword, HttpError, publicUser } from './auth.mjs';
import { seedSample } from './seed.mjs';
import { handleIntegration, IntegrationError, mediaUrl } from './integrations.mjs';
import { createIntegrationSettings } from './integration-settings.mjs';
import { handleInvitations } from './invitations.mjs';
import { handleOperationRecovery } from './operation-recovery.mjs';
import { handleEngagement } from './engagement.mjs';
import { handleApprovals, assertPublishingApproval, assertProviderPostEdit } from './approvals.mjs';
import { createWebhookService, WEBHOOK_MAX_BYTES } from './webhooks.mjs';
import { handleCalendar } from './calendar.mjs';
import { handleAgent } from './agent.mjs';
import { handleOoh } from './ooh.mjs';

const roles = ['owner', 'admin', 'editor', 'viewer'];
const projectFields = 'p.id,p.workspace_id AS workspaceId,p.name,p.color,p.zernio_profile_id AS zernioProfileId,p.drive_folder_id AS driveFolderId';
const bad = message => { throw new HttpError(400, message || 'Check the submitted fields.'); };
function object(value) { if (!value || typeof value !== 'object' || Array.isArray(value)) bad('A JSON object is required.'); return value; }
function text(value, label, max = 120, optional = false) {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) bad(`${label} is required and must be at most ${max} characters.`);
  return value.trim();
}
function email(value) { const result = text(value, 'Email', 254).toLowerCase(); if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result)) bad('Enter a valid email address.'); return result; }
function password(value) { if (typeof value !== 'string' || value.length < 12 || value.length > 128) bad('Use a password between 12 and 128 characters.'); return value; }
function loginPassword(value) { if (typeof value !== 'string' || !value.length || value.length > 128) bad('Enter your password.'); return value; }
function choice(value, options, label) { if (!options.includes(value)) bad(`${label} is invalid.`); return value; }
function money(value, label) { if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12) bad(`${label} must be a nonnegative number.`); return value; }
function date(value, label) {
  if (value === undefined || value === '') return;
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value.slice(0, 10)).toISOString().slice(0, 10) !== value.slice(0, 10)) bad(`${label} must be a valid ISO date.`);
}
function strings(value, label, limit = 30) { if (!Array.isArray(value) || value.length > limit) bad(`${label} must be a list of at most ${limit} items.`); return value.map(item => text(item, label, 120)); }
function safeUrl(value) { let url; try { url = new URL(value); } catch { bad('Use an HTTPS asset URL.'); } if (url.protocol !== 'https:' || url.username || url.password || value.length > 4096) bad('Use an HTTPS asset URL without credentials.'); return url.href; }
function validateRecord(collection, raw) {
  const data = { ...object(raw) };
  for (const key of ['id', 'projectId', 'createdAt', 'updatedAt', 'sample']) delete data[key];
  for (const [key, value] of Object.entries(data)) if (typeof value === 'string' && value.length > 16000) bad(`${key} is too long.`);
  if (collection === 'campaigns') {
    data.name = text(data.name, 'Campaign name'); data.channel = choice(data.channel ?? 'mixed', ['social', 'paid', 'ooh', 'mixed'], 'Channel');
    data.status = choice(data.status ?? 'draft', ['draft', 'active', 'paused', 'completed'], 'Status'); data.budget = money(data.budget ?? 0, 'Budget'); data.spent = money(data.spent ?? 0, 'Spend');
  } else if (collection === 'posts') {
    data.content = text(data.content, 'Post content', 10000); data.platforms = strings(data.platforms ?? [], 'Platforms', 20);
    data.status = choice(data.status ?? 'draft', ['draft', 'scheduled', 'published', 'failed', 'cancelled'], 'Status');
    if (data.scheduledFor && !data.scheduledAt) data.scheduledAt = data.scheduledFor;
    date(data.scheduledAt, 'Scheduled time');
    if (data.status === 'scheduled' && (!data.scheduledAt || Date.parse(data.scheduledAt) <= Date.now())) bad('Scheduled posts need a future scheduled time.');
    if (data.accounts !== undefined) data.accounts = strings(data.accounts, 'Accounts', 20);
    if (data.mediaItems !== undefined) {
      if (!Array.isArray(data.mediaItems) || data.mediaItems.length > 10) bad('Use at most 10 media items.');
      data.mediaItems = data.mediaItems.map(item => ({ url: safeUrl(text(item?.url, 'Media URL', 4096)), type: choice(item.type, ['image', 'video'], 'Media type') }));
    }
  } else if (collection === 'placements') {
    data.name = text(data.name, 'Placement name'); data.type = choice(data.type ?? 'billboard', ['billboard', 'digital', 'transit', 'street'], 'Placement type');
    data.location = text(data.location, 'Location', 500); data.cost = money(data.cost ?? 0, 'Cost'); data.status = choice(data.status ?? 'draft', ['draft', 'requested', 'booked', 'live', 'completed', 'cancelled'], 'Status');
    if (data.latitude !== undefined || data.longitude !== undefined) { const { latitude, longitude } = data; if (!(latitude === null && longitude === null) && (typeof latitude !== 'number' || !Number.isFinite(latitude) || Math.abs(latitude) > 90 || typeof longitude !== 'number' || !Number.isFinite(longitude) || Math.abs(longitude) > 180)) bad('Enter both latitude (-90 to 90) and longitude (-180 to 180).'); }
    if (data.proofUrl) data.proofUrl = safeUrl(text(data.proofUrl, 'Proof URL', 4096));
  } else if (collection === 'assets') {
    data.name = text(data.name, 'Asset name', 250); data.kind = choice(data.kind ?? 'image', ['image', 'video', 'document'], 'Asset kind'); data.url = safeUrl(text(data.url, 'Asset URL', 4096)); data.approval = choice(data.approval ?? 'pending', ['pending', 'approved', 'rejected'], 'Approval');
    if (data.deliveryUrl !== undefined) data.deliveryUrl = data.deliveryUrl === '' ? '' : mediaUrl(text(data.deliveryUrl, 'Public delivery URL', 4096));
    if (data.tags !== undefined) data.tags = strings(data.tags, 'Tags');
  } else if (collection === 'providers') {
    data.name = text(data.name, 'Provider name'); data.type = choice(data.type ?? 'ooh', ['ooh', 'media'], 'Provider type'); data.contact = data.contact ? email(data.contact) : '';
  } else if (collection === 'conversations') {
    data.contact = text(data.contact, 'Contact'); data.platform = text(data.platform, 'Platform', 80); data.status = choice(data.status ?? 'open', ['open', 'resolved'], 'Status');
    if (!Array.isArray(data.messages) || data.messages.length > 500) bad('Messages must be a list of at most 500 entries.');
    data.messages = data.messages.map(item => { object(item); const message = { ...item, content: text(item.content || item.text, 'Message', 10000) }; if (message.createdAt) date(message.createdAt, 'Message date'); return message; });
  }
  for (const key of ['startDate', 'endDate', 'startAt', 'endAt']) date(data[key], key);
  for (const [start, end] of [['startDate', 'endDate'], ['startAt', 'endAt']]) if (data[start] && data[end] && Date.parse(data[start]) > Date.parse(data[end])) bad('The end date must be after the start date.');
  for (const key of ['campaignId', 'providerId', 'assetId']) if (data[key] !== undefined && data[key] !== '') data[key] = text(data[key], key, 100);
  if (data.currency !== undefined) data.currency = choice(data.currency, ['AED', 'USD', 'EUR', 'GBP'], 'Currency');
  for (const key of ['impressions', 'clicks', 'conversions', 'inventory']) if (data[key] !== undefined) { money(data[key], key); if (!Number.isSafeInteger(data[key])) bad(`${key} must be a whole number.`); }
  return data;
}
async function readRawBody(req, maximum) {
  if (Number(req.headers['content-length']) > maximum) { req.resume(); throw new HttpError(413, 'Request is too large.'); }
  const chunks = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) { size += chunk.length; if (size > maximum) { req.resume(); throw new HttpError(413, 'Request is too large.'); } chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function readBody(req, maximum = 65536) {
  if (req.headers['content-length'] === '0' || (!req.headers['content-length'] && !req.headers['transfer-encoding'])) return {};
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Send JSON content.');
  const raw = await readRawBody(req, maximum);
  try { return object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))); } catch (error) { if (error instanceof HttpError) throw error; bad('Send valid UTF-8 JSON.'); }
}

export function createApp(options = {}) {
  const env = options.env || { ...process.env }, dataDir = resolve(options.dataDir || env.DATA_DIR || 'data');
  const appUrl = (options.appUrl || env.APP_URL || 'http://127.0.0.1:3018').replace(/\/$/, '');
  const parsed = new URL(appUrl);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== appUrl || parsed.username || parsed.password || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error('APP_URL must be an HTTPS origin, or HTTP loopback for local use.');
  const db = openDatabase(dataDir), store = createStore(db);
  const config = { ...options, env, dataDir, appUrl, sessionSecret: sessionSecret(dataDir, options.sessionSecret || env.SESSION_SECRET), oidcIssuer: env.OIDC_ISSUER || '', oidcClientId: env.OIDC_CLIENT_ID || '', oidcClientSecret: env.OIDC_CLIENT_SECRET || '', oidcAllowedEmails: (env.OIDC_ALLOWED_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean) };
  config.oidcEnabled = Boolean(config.oidcIssuer && config.oidcClientId);
  if (config.oidcEnabled && new URL(config.oidcIssuer).protocol !== 'https:') throw new Error('OIDC_ISSUER must use HTTPS.');
  const auth = createAuth(db, config), dist = resolve(options.distDir || 'dist');
  const integrationSettings = createIntegrationSettings({ db, env, secret: config.sessionSecret });
  const webhooks = createWebhookService({ db, store, env });
  const drainWebhooks = () => { try { webhooks.processPending(); } catch { console.error('Webhook processing deferred.'); } };
  drainWebhooks(); const webhookTimer = setInterval(drainWebhooks, 1000); webhookTimer.unref();
  function workspaceAccess(workspaceId, userId, write = false) {
    const membership = db.prepare('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?').get(workspaceId, userId);
    if (!membership || (write && membership.role === 'viewer')) throw new HttpError(404, 'Workspace not found or unavailable.');
    return membership.role;
  }
  function projectAccess(projectId, userId) {
    const project = db.prepare(`SELECT ${projectFields},m.role FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=? AND m.user_id=?`).get(projectId, userId);
    if (!project) throw new HttpError(404, 'Project not found or unavailable.');
    return project;
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', env.GOOGLE_MAPS_BROWSER_API_KEY ? 'strict-origin-when-cross-origin' : 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    const nonce = randomBytes(18).toString('base64');
    const mapsPolicy = env.GOOGLE_MAPS_BROWSER_API_KEY ? " 'unsafe-eval'" : '';
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'nonce-${nonce}' 'strict-dynamic' 'self'${mapsPolicy}; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; media-src 'self' https:; connect-src 'self' https://*.googleapis.com https://*.gstatic.com https://*.google.com; font-src 'self' https://fonts.gstatic.com; frame-src https://*.google.com; worker-src blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (parsed.protocol === 'https:') res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      const url = new URL(req.url, appUrl), path = url.pathname, mutating = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
      if (path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
        if (path === '/api/webhooks/zernio' && req.method === 'POST') { const result = webhooks.receive(await readRawBody(req, WEBHOOK_MAX_BYTES), req.headers); return send(result.status, result.body); }
        if (path === '/api/health' && req.method === 'GET') return send(200, { ok: true });
        if (mutating && req.headers.origin !== appUrl) throw new HttpError(403, 'A matching Origin header is required.');
        const body = mutating && req.method !== 'DELETE' ? await readBody(req, /^\/api\/projects\/[^/]+\/integrations\/drive\/upload$/.test(path) ? 7 * 1024 * 1024 : 65536) : {};
        if (path === '/api/session' && req.method === 'GET') return send(200, { user: publicUser(auth.user(req, res)), setupRequired: !db.prepare('SELECT id FROM users LIMIT 1').get(), oidcEnabled: config.oidcEnabled });
        if (path === '/api/auth/setup' && req.method === 'POST') {
          auth.limit('setup:' + req.socket.remoteAddress, 10);
          if (db.prepare('SELECT id FROM users LIMIT 1').get()) throw new HttpError(409, 'Setup is already complete. Sign in to continue.');
          const name = text(body.name, 'Name'), mail = email(body.email), hash = await hashPassword(password(body.password));
          if (body.sample !== undefined && typeof body.sample !== 'boolean') bad('Sample must be true or false.');
          const id = randomUUID(), workspaceId = randomUUID(), projectId = randomUUID();
          transaction(db, () => {
            if (db.prepare('SELECT id FROM users LIMIT 1').get()) throw new HttpError(409, 'Setup is already complete.');
            db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(id, name, mail, hash);
            db.prepare('INSERT INTO instance_operators VALUES(?)').run(id);
            db.prepare('INSERT INTO workspaces VALUES(?,?)').run(workspaceId, 'ten98 studio'); db.prepare("INSERT INTO memberships VALUES(?,?,'owner')").run(workspaceId, id);
            db.prepare('INSERT INTO projects(id,workspace_id,name) VALUES(?,?,?)').run(projectId, workspaceId, 'Brand launch');
            if (body.sample) seedSample(store, projectId);
          });
          auth.establish(res, id, req); return send(201, { user: { id, name, email: mail, isOperator: true }, projectId });
        }
        if (path === '/api/auth/login' && req.method === 'POST') return send(200, { user: await auth.login(req, res, { email: email(body.email), password: loginPassword(body.password) }) });
        if (path === '/api/auth/logout' && req.method === 'POST') { auth.logout(req, res); return send(200, { ok: true }); }
        if (path === '/api/auth/oidc/start' && req.method === 'GET') return await auth.oidcStart(req, res);
        if (path === '/api/auth/oidc/callback' && req.method === 'GET') return await auth.oidcCallback(req, res, url);
        if (await handleInvitations({ req, url, body, user: auth.user(req, res), db, auth, config, send, workspaceAccess, establish: id => auth.establish(res, id, req) })) return;
        const user = auth.user(req, res); if (!user) throw new HttpError(401, 'Sign in to continue.');
        if (path === '/api/account' && req.method === 'GET') return send(200, { user, ...auth.account(user.id) });
        if (path === '/api/account' && req.method === 'PATCH') { if (Object.keys(body).some(key => key !== 'name')) bad('Only your display name can be changed here.'); db.prepare('UPDATE users SET name=? WHERE id=?').run(text(body.name, 'Name'), user.id); return send(200, { user: auth.user(req, res) }); }
        if (path === '/api/account/password' && req.method === 'POST') { if (Object.keys(body).some(key => !['currentPassword', 'newPassword'].includes(key))) bad('Use the password fields.'); await auth.changePassword(req, res, user.id, loginPassword(body.currentPassword), password(body.newPassword)); return send(200, { changed: true }); }
        if (path === '/api/account/sessions/revoke' && req.method === 'POST') return send(200, { revoked: auth.revokeOtherSessions(req, user.id) });
        const settingsRoute = path.match(/^\/api\/settings\/integrations(?:\/([A-Za-z]+)(?:\/(test))?)?$/);
        if (settingsRoute) {
          if (!user.isOperator) throw new HttpError(403, 'Only instance operators can configure shared integrations.');
          const [, provider, action] = settingsRoute;
          if (!provider && req.method === 'GET') return send(200, integrationSettings.describe());
          if (provider && !action && req.method === 'PUT') { if (Object.keys(body).some(key => key !== 'fields')) bad('Use the integration settings fields.'); return send(200, integrationSettings.save(provider, body.fields)); }
          if (provider && !action && req.method === 'DELETE') return send(200, integrationSettings.reset(provider));
          if (provider && action === 'test' && req.method === 'POST') {
            if (Object.keys(body).some(key => key !== 'projectId')) bad('Choose a project to test its mapped connection.');
            auth.limit('integration-tests:' + user.id, 60);
            const mapped = body.projectId ? projectAccess(text(body.projectId, 'Project', 100), user.id) : null;
            const calendarTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='calendar_connections'").get();
            const calendar = mapped && calendarTable ? db.prepare('SELECT calendar_id FROM calendar_connections WHERE project_id=?').get(mapped.id) : null;
            const result = await integrationSettings.test(provider, { driveFolderId: mapped?.driveFolderId, calendarId: calendar?.calendar_id });
            if (mapped) {
              const current = projectAccess(mapped.id, user.id);
              const currentCalendar = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='calendar_connections'").get() ? db.prepare('SELECT calendar_id FROM calendar_connections WHERE project_id=?').get(mapped.id) : null;
              if ((provider === 'googleDrive' && current.driveFolderId !== mapped.driveFolderId) || (provider === 'googleCalendar' && currentCalendar?.calendar_id !== calendar?.calendar_id)) throw new HttpError(409, 'The project connection changed during this test. Test the current mapping again.');
            }
            return send(200, result);
          }
          throw new HttpError(405, 'This integration settings action is not available.');
        }
        if (path === '/api/state' && req.method === 'GET') {
          const workspaces = db.prepare('SELECT w.id,w.name,m.role FROM workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.user_id=? ORDER BY w.rowid').all(user.id);
          const projects = db.prepare(`SELECT ${projectFields} FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE m.user_id=? ORDER BY p.rowid`).all(user.id);
          const projectId = url.searchParams.get('projectId') || projects[0]?.id || null;
          if (projectId) projectAccess(projectId, user.id);
          const data = Object.fromEntries(collections.map(collection => [collection, projectId ? store.list(projectId, collection) : []]));
          const activity = projectId ? db.prepare('SELECT id,project_id AS projectId,message,created_at AS createdAt,sample FROM activity WHERE project_id=? ORDER BY rowid DESC LIMIT 50').all(projectId) : [];
          return send(200, { user, workspaces, projects, projectId, ...data, activity, connections: { zernio: Boolean(env.ZERNIO_API_KEY), drive: Boolean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY) } });
        }
        if (path === '/api/workspaces' && req.method === 'POST') {
          const workspace = { id: randomUUID(), name: text(body.name, 'Workspace name'), role: 'owner' };
          const projectId = randomUUID();
          transaction(db, () => { db.prepare('INSERT INTO workspaces VALUES(?,?)').run(workspace.id, workspace.name); db.prepare("INSERT INTO memberships VALUES(?,?,'owner')").run(workspace.id, user.id); db.prepare('INSERT INTO projects(id,workspace_id,name) VALUES(?,?,?)').run(projectId, workspace.id, 'My project'); store.activity(projectId, 'Workspace created.'); });
          return send(201, { workspace, projectId });
        }
        const memberRoute = path.match(/^\/api\/workspaces\/([^/]+)\/members(?:\/([^/]+))?$/);
        if (memberRoute && ['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) {
          const role = workspaceAccess(memberRoute[1], user.id);
          if (!['owner', 'admin'].includes(role)) throw new HttpError(403, 'Only workspace administrators can manage team members.');
          if (req.method === 'GET' && !memberRoute[2]) return send(200, { members: db.prepare('SELECT u.id,u.id AS userId,u.name,u.email,m.role FROM users u JOIN memberships m ON m.user_id=u.id WHERE m.workspace_id=? ORDER BY u.name').all(memberRoute[1]) });
          if ((req.method === 'POST' && memberRoute[2]) || (req.method !== 'POST' && !memberRoute[2]) || req.method === 'GET') throw new HttpError(404, 'Team route not found.');
          const requested = req.method === 'DELETE' ? null : choice(body.role, roles, 'Role');
          transaction(db, () => {
            const target = req.method === 'POST' ? db.prepare('SELECT id FROM users WHERE email=?').get(email(body.email)) : db.prepare('SELECT id FROM users WHERE id=?').get(memberRoute[2]);
            if (!target) throw new HttpError(400, 'This account does not exist. Ask the operator to create it first.');
            const previous = db.prepare('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?').get(memberRoute[1], target.id);
            if (req.method !== 'POST' && !previous) throw new HttpError(404, 'Workspace member not found.');
            if (role === 'admin' && (['owner', 'admin'].includes(requested) || ['owner', 'admin'].includes(previous?.role))) throw new HttpError(403, 'Only an owner can manage administrators and owners.');
            if (previous?.role === 'owner' && requested !== 'owner' && db.prepare("SELECT count(*) AS count FROM memberships WHERE workspace_id=? AND role='owner'").get(memberRoute[1]).count <= 1) throw new HttpError(409, 'A workspace must keep at least one owner.');
            if (req.method === 'DELETE') db.prepare('DELETE FROM memberships WHERE workspace_id=? AND user_id=?').run(memberRoute[1], target.id);
            else db.prepare('INSERT INTO memberships VALUES(?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET role=excluded.role').run(memberRoute[1], target.id, requested);
            for (const project of db.prepare('SELECT id FROM projects WHERE workspace_id=?').all(memberRoute[1])) store.activity(project.id, 'Workspace team membership updated.');
          });
          return send(200, { ok: true });
        }
        if (path === '/api/projects' && req.method === 'POST') {
          const workspaceId = text(body.workspaceId, 'Workspace', 100), role = workspaceAccess(workspaceId, user.id, true);
          if ((Object.hasOwn(body, 'zernioProfileId') || Object.hasOwn(body, 'driveFolderId')) && (!user.isOperator || !['owner', 'admin'].includes(role))) throw new HttpError(403, 'Only an instance operator with workspace administration access can map provider connections.');
          const project = projectInput(body); checkProfileMapping(db, project.zernioProfileId); project.id = randomUUID(); project.workspaceId = workspaceId;
          db.prepare('INSERT INTO projects VALUES(?,?,?,?,?,?)').run(project.id, workspaceId, project.name, project.color, project.zernioProfileId, project.driveFolderId);
          store.activity(project.id, 'Project created.'); return send(201, { project });
        }
        const projectRoute = path.match(/^\/api\/projects\/([^/]+)(?:\/(.*))?$/);
        if (projectRoute) {
          const project = projectAccess(projectRoute[1], user.id), role = project.role;
          if (mutating && role === 'viewer') throw new HttpError(403, 'Your workspace role is view only.');
          if (projectRoute[2] === 'sample-data' && req.method === 'DELETE') {
            if (!['owner', 'admin'].includes(role)) throw new HttpError(403, 'Only a workspace owner or administrator can remove sample data.');
            const samples = collections.flatMap(collection => store.list(project.id, collection).filter(record => record.sample).map(record => ({ collection, record })));
            for (const { collection, record } of samples) checkDependants(store, project.id, collection, record.id, true);
            let activityRemoved;
            transaction(db, () => { for (const { collection, record } of samples) store.remove(project.id, collection, record.id); activityRemoved = db.prepare('DELETE FROM activity WHERE project_id=? AND sample=1').run(project.id).changes; store.activity(project.id, 'Sample data removed.'); });
            return send(200, { removed: samples.length, activityRemoved });
          }
          if (projectRoute[2] === 'maps/config' && req.method === 'GET') return send(200, { configured: Boolean(env.GOOGLE_MAPS_BROWSER_API_KEY), browserKey: env.GOOGLE_MAPS_BROWSER_API_KEY || '', mapId: env.GOOGLE_MAPS_MAP_ID || '' });
          if (projectRoute[2] === 'inbox/cache' && req.method === 'GET') return send(200, { conversations: store.list(project.id, 'conversations') });
          const requestRevision = integrationSettings.revision;
          const assertIntegrationSettings = () => { if (integrationSettings.revision !== requestRevision) throw new HttpError(409, 'Integration credentials changed. Refresh this project before continuing.'); };
          const context = { req, res, url, body, user, project, role, db, send, store, config: { ...config, env: { ...env }, assertIntegrationSettings }, assertIntegrationSettings, assertProjectMapping: expected => { assertIntegrationSettings(); const current = db.prepare('SELECT zernio_profile_id FROM projects WHERE id=?').get(project.id); if (current?.zernio_profile_id !== expected) throw new HttpError(409, 'The provider mapping changed. Refresh this project.'); }, assertDriveMapping: expected => { assertIntegrationSettings(); const current = db.prepare('SELECT drive_folder_id FROM projects WHERE id=?').get(project.id); if (current?.drive_folder_id !== expected) throw new HttpError(409, 'The Drive mapping changed. Refresh this project.'); }, prepareDraft: (collection, fields) => { rejectProviderFields(fields, collection); const data = validateRecord(collection, { ...fields, status: 'draft' }); checkReferences(store, project.id, data); return data; } };
          context.assertPublishingApproval = post => assertPublishingApproval(context, post);
          context.assertProviderPostEdit = () => assertProviderPostEdit(context);
          if (projectRoute[2]?.startsWith('operations') && await handleOperationRecovery(context)) return;
          if (projectRoute[2]?.startsWith('approvals/') && await handleApprovals(context)) return;
          if (projectRoute[2]?.startsWith('engagement/') && await handleEngagement(context)) return;
          if (projectRoute[2]?.startsWith('calendar/') && await handleCalendar(context)) return;
          if (projectRoute[2]?.startsWith('agent/') && await handleAgent(context)) return;
          if (projectRoute[2]?.startsWith('ooh/') && await handleOoh(context)) return;
          if (projectRoute[2]?.startsWith('integrations/')) {
            if (await handleIntegration(context)) return;
          }
          if (!projectRoute[2] && req.method === 'PATCH') {
            if ((Object.hasOwn(body, 'zernioProfileId') || Object.hasOwn(body, 'driveFolderId')) && (!user.isOperator || !['owner', 'admin'].includes(role))) throw new HttpError(403, 'Only an instance operator with workspace administration access can map provider connections.');
            const updated = projectInput({ ...project, ...body }); checkProfileMapping(db, updated.zernioProfileId, project.id);
            db.prepare('UPDATE projects SET name=?,color=?,zernio_profile_id=?,drive_folder_id=? WHERE id=?').run(updated.name, updated.color, updated.zernioProfileId, updated.driveFolderId, project.id);
            store.activity(project.id, 'Project settings updated.'); return send(200, { project: { ...project, ...updated } });
          }
          const [collection, id, extra] = (projectRoute[2] || '').split('/');
          if (collections.includes(collection) && !extra) {
            if (!id && req.method === 'POST') {
              rejectProviderFields(body, collection);
              if (collection === 'posts' && body.status === 'published') bad('Publish through a connected provider to confirm publication.');
              const data = validateRecord(collection, collection === 'placements' && (Object.hasOwn(body, 'latitude') || Object.hasOwn(body, 'longitude')) ? { ...body, locationSource: 'manual' } : body); checkReferences(store, project.id, data);
              if (collection === 'assets' && data.approval !== 'pending' && !['owner', 'admin'].includes(role)) throw new HttpError(403, 'An owner or administrator must approve creative assets.');
              const record = store.create(project.id, collection, data); store.activity(project.id, `${collection.slice(0, -1)} created.`); return send(201, { record });
            }
            if (id && ['PATCH', 'DELETE'].includes(req.method)) {
              const previous = store.get(project.id, collection, id); if (!previous) throw new HttpError(404, 'Record not found.');
              if ((collection === 'conversations' && previous.source === 'zernio') || (collection === 'placements' && previous.source === 'broadsign') || (collection === 'campaigns' && previous.externalId) || (collection === 'posts' && (previous.externalId || previous.status === 'published'))) bad('Provider-managed records must be changed through their connected provider controls.');
              if (req.method === 'DELETE') { checkDependants(store, project.id, collection, id); store.remove(project.id, collection, id); store.activity(project.id, `${collection.slice(0, -1)} deleted.`); return send(200, { ok: true }); }
              rejectProviderFields(body, collection);
              if (collection === 'posts' && (body.status === 'published' || previous.status === 'published' || previous.externalId)) bad('Provider posts must be managed through their connected provider.');
              const data = validateRecord(collection, { ...previous, ...body, ...(collection === 'placements' && (Object.hasOwn(body, 'latitude') || Object.hasOwn(body, 'longitude')) ? { locationSource: 'manual' } : {}) }); checkReferences(store, project.id, data);
              if (collection === 'assets') {
                if (body.approval !== undefined && body.approval !== previous.approval && !['owner', 'admin'].includes(role)) throw new HttpError(403, 'An owner or administrator must approve creative assets.');
                if (['url', 'deliveryUrl', 'kind'].some(key => data[key] !== previous[key])) data.approval = 'pending';
              }
              const record = store.update(project.id, collection, id, data); store.activity(project.id, `${collection.slice(0, -1)} updated.`); return send(200, { record });
            }
          }
        }
        throw new HttpError(404, 'API route not found.');
      }
      if (!['GET', 'HEAD'].includes(req.method)) throw new HttpError(405, 'Method not allowed.');
      const decoded = decodeURIComponent(path); if (decoded.includes('\0') || decoded.includes('\\')) throw new HttpError(400, 'Invalid path.');
      let file = resolve(dist, '.' + decoded), rel = relative(dist, file);
      if (rel.startsWith('..' + sep) || rel === '..' || resolve(file) === sep) throw new HttpError(403, 'Invalid path.');
      try { if (!(await stat(file)).isFile()) file = join(dist, 'index.html'); } catch { if (extname(decoded)) throw new HttpError(404, 'File not found.'); file = join(dist, 'index.html'); }
      let contents; try { contents = await readFile(file); } catch { throw new HttpError(404, 'Build the frontend before starting the production server.'); }
      if (extname(file) === '.html') contents = Buffer.from(contents.toString('utf8').replace(/<script\b/g, `<script nonce="${nonce}"`));
      const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };
      res.writeHead(200, { 'Content-Type': (mime[extname(file)] || 'application/octet-stream') + (['.html', '.js', '.css'].includes(extname(file)) ? '; charset=utf-8' : ''), 'Cache-Control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' }); res.end(req.method === 'HEAD' ? undefined : contents);
    } catch (error) { if (!res.headersSent) send(error instanceof HttpError || error instanceof IntegrationError ? error.status : 500, { error: error instanceof HttpError ? error.message : error instanceof IntegrationError ? { code: error.code, message: error.message } : 'The request could not be completed.' }); else res.end(); }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000;
  return { server, db, store, config, webhooks, close: () => new Promise((resolveClose, reject) => { clearInterval(webhookTimer); if (!server.listening) { db.close(); resolveClose(); return; } server.close(error => { db.close(); error ? reject(error) : resolveClose(); }); server.closeIdleConnections(); }) };
}
function checkProfileMapping(db, profileId, projectId = '') { if (profileId && db.prepare('SELECT id FROM projects WHERE zernio_profile_id=? AND id<>?').get(profileId, projectId)) throw new HttpError(409, 'This Zernio profile is already mapped to another project. Use one profile per project for inbox routing.'); }
function projectInput(data) {
  const color = data.color || '#5943ce'; if (typeof color !== 'string' || !/^#[\da-f]{6}$/i.test(color)) bad('Use a six digit hex color.');
  return { name: text(data.name, 'Project name'), color, zernioProfileId: text(data.zernioProfileId, 'Zernio profile', 200, true), driveFolderId: text(data.driveFolderId, 'Drive folder', 200, true) };
}
function checkReferences(store, projectId, data) {
  for (const [key, collection] of [['campaignId', 'campaigns'], ['assetId', 'assets'], ['providerId', 'providers']]) if (data[key] && !store.get(projectId, collection, data[key])) bad(`${key} does not belong to this project.`);
}
function checkDependants(store, projectId, collection, id, realOnly = false) {
  const field = { campaigns: 'campaignId', assets: 'assetId', providers: 'providerId' }[collection];
  // ponytail: scan local project records for references; use indexed relationships if project size makes deletion checks slow.
  if (field && collections.some(name => store.list(projectId, name).some(record => record[field] === id && (!realOnly || !record.sample)))) throw new HttpError(409, `This ${collection.slice(0, -1)} is assigned to ${realOnly ? 'a real record' : 'another record'}. Remove its assignments before deleting it${realOnly ? ' or removing sample data' : ''}.`);
}
function rejectProviderFields(body, collection = '') {
  if (['externalId', 'zernioPostId', 'providerStatus', 'remoteId', 'publishedAt', 'syncedAt', 'driveFileId', 'externalConversationId', 'zernioProfileId', 'providerResults', 'platformCampaignId', 'driveId', 'source', 'accountId', 'profileId', 'isLive', 'zernioConversationId', 'locationSource', 'controlOwner', 'thumbnailUrl', 'mimeType', 'deliveryUrl', 'modifiedTime', 'md5Checksum', 'approvalStatus', 'approvedBy', 'reviewedBy', 'providerDeletedAt', 'proposalItemId', 'screenId', 'bookingId'].some(key => Object.hasOwn(body, key) && !(collection === 'assets' && key === 'deliveryUrl'))) bad('Provider identifiers and publication evidence are managed by integrations.');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = createApp();
  app.server.listen(Number(process.env.PORT || 3018), process.env.HOST || '127.0.0.1', () => console.log(`Campaign manager available at ${app.config.appUrl}`));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, async () => { await app.close(); process.exit(0); });
}
