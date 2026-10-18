import { randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import qrcode from 'qrcode-generator';
import { HttpError } from './auth.mjs';
import { transaction } from './database.mjs';

const fail = (status, message) => { throw new HttpError(status, message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const token = () => randomBytes(24).toString('base64url');
const day = () => new Date().toISOString().slice(0, 10);
function fields(body, allowed) { if (!object(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'Use only the fields shown in the link form.'); }
function label(value) { if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) fail(400, 'Use a link name of at most 120 characters.'); return value.trim(); }
function publicUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) fail(400, 'Use a public HTTPS URL without credentials.');
  let url; try { url = new URL(value); } catch { fail(400, 'Use a public HTTPS URL.'); }
  const hostname = url.hostname.replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || isIP(hostname) || hostname.includes(':') || !hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|invalid|home\.arpa)$/.test(hostname) || hostname.split('.').some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) fail(400, 'Use a public HTTPS domain without credentials or private addresses.');
  return url;
}
function origin(value, appOrigin) {
  if (value === appOrigin) return appOrigin;
  const url = publicUrl(value);
  if (url.pathname !== '/' || url.search || url.hash) fail(400, 'Use an HTTPS origin without a path, query or fragment.');
  return url.origin;
}
function hostMatches(req, value) { return typeof req.headers.host === 'string' && req.headers.host.toLowerCase() === new URL(value).host.toLowerCase(); }
function respond(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}
async function eventBody(req) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) fail(415, 'Send JSON events.');
  if (Number(req.headers['content-length']) > 2048) { req.resume(); fail(413, 'This event is too large.'); }
  const chunks = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) { size += chunk.length; if (size > 2048) { req.resume(); fail(413, 'This event is too large.'); } chunks.push(chunk); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { fail(400, 'Send a valid JSON event.'); }
}
function websiteScript(endpoint) {
  return `(()=>{if(window.ten98Track)return;const disabled=()=>navigator.doNotTrack==='1'||window.doNotTrack==='1'||navigator.globalPrivacyControl===true;let last='';function track(name){if(disabled()||typeof name!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(name)||!crypto.randomUUID)return;const path=location.pathname;if(name==='pageview'&&last===path)return;if(name==='pageview')last=path;fetch(${JSON.stringify(endpoint)},{method:'POST',mode:'cors',credentials:'omit',referrerPolicy:'no-referrer',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({eventId:crypto.randomUUID(),name,path})}).catch(()=>{});}window.ten98Track=track;track('pageview');addEventListener('popstate',()=>track('pageview'));for(const method of ['pushState','replaceState']){const original=history[method];history[method]=function(...args){const result=original.apply(this,args);track('pageview');return result;};}})();`;
}

export function createLinks({ db, appUrl }) {
  const appOrigin = new URL(appUrl).origin;
  db.exec(`CREATE TABLE IF NOT EXISTS project_link_settings(project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,short_base_url TEXT NOT NULL,website_origins TEXT NOT NULL,site_token TEXT UNIQUE NOT NULL,domain_token TEXT UNIQUE NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS campaign_links(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,code TEXT UNIQUE NOT NULL,name TEXT NOT NULL,destination TEXT NOT NULL,campaign_id TEXT NOT NULL DEFAULT '',short_origin TEXT NOT NULL,archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN(0,1)),created_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS campaign_links_project ON campaign_links(project_id);
    CREATE UNIQUE INDEX IF NOT EXISTS campaign_links_active_destination ON campaign_links(project_id,destination,campaign_id) WHERE archived=0;
    CREATE TABLE IF NOT EXISTS campaign_link_daily(link_id TEXT NOT NULL REFERENCES campaign_links(id) ON DELETE CASCADE,day TEXT NOT NULL,clicks INTEGER NOT NULL DEFAULT 0,qr_scans INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(link_id,day));
    CREATE TABLE IF NOT EXISTS website_daily(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,day TEXT NOT NULL,path TEXT NOT NULL,name TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(project_id,day,path,name));
    CREATE TABLE IF NOT EXISTS website_event_ids(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,event_id TEXT NOT NULL,created_at INTEGER NOT NULL,PRIMARY KEY(project_id,event_id));
    CREATE TABLE IF NOT EXISTS website_event_limits(bucket TEXT NOT NULL,minute INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(bucket,minute));`);
  let nextCleanup = 0;
  function cleanup() {
    if (Date.now() < nextCleanup) return; nextCleanup = Date.now() + 60000;
    db.prepare('DELETE FROM website_event_ids WHERE created_at<?').run(Date.now() - 86400000);
    db.prepare('DELETE FROM website_event_limits WHERE minute<?').run(Math.floor(Date.now() / 60000) - 1);
    const before = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    db.prepare('DELETE FROM website_daily WHERE day<?').run(before); db.prepare('DELETE FROM campaign_link_daily WHERE day<?').run(before);
  }
  function settings(projectId) {
    const current = db.prepare('SELECT * FROM project_link_settings WHERE project_id=?').get(projectId); if (current) return current;
    db.prepare('INSERT INTO project_link_settings VALUES(?,?,?,?,?,?)').run(projectId, appOrigin, '[]', token(), token(), new Date().toISOString());
    return db.prepare('SELECT * FROM project_link_settings WHERE project_id=?').get(projectId);
  }
  const settingsView = row => ({ shortBaseUrl: row.short_base_url, allowedWebsiteOrigins: JSON.parse(row.website_origins), siteToken: row.site_token, scriptUrl: `${appOrigin}/t/${row.site_token}.js`, domainCheckUrl: `${row.short_base_url}/s/domain-check/${row.domain_token}`, domainStatus: row.short_base_url === appOrigin ? 'app_origin' : 'configured_unverified', updatedAt: row.updated_at });
  const find = (projectId, id) => { const row = db.prepare('SELECT * FROM campaign_links WHERE project_id=? AND id=?').get(projectId, id); if (!row) fail(404, 'This link was not found in this project.'); return row; };
  function linkView(row, from = '0000-00-00') {
    const totals = db.prepare('SELECT COALESCE(SUM(clicks),0) AS clicks,COALESCE(SUM(qr_scans),0) AS qrScans FROM campaign_link_daily WHERE link_id=? AND day>=?').get(row.id, from), shortUrl = `${row.short_origin}/s/${row.code}`;
    return { id: row.id, code: row.code, name: row.name, destination: row.destination, campaignId: row.campaign_id, shortUrl, qrUrl: shortUrl + '?source=qr', qrSvgUrl: `/api/projects/${encodeURIComponent(row.project_id)}/links/${row.id}/qr.svg`, archived: Boolean(row.archived), createdAt: row.created_at, ...totals, totalVisits: totals.clicks + totals.qrScans };
  }
  function campaign(projectId, campaignId) {
    if (campaignId === undefined || campaignId === '') return '';
    if (typeof campaignId !== 'string' || campaignId.length > 100 || /\s/.test(campaignId)) fail(400, 'Choose a campaign in this project.');
    const generic = db.prepare("SELECT id FROM records WHERE project_id=? AND collection='campaigns' AND id=?").get(projectId, campaignId);
    const direct = !generic && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='direct_campaigns'").get() && db.prepare('SELECT id FROM direct_campaigns WHERE project_id=? AND id=?').get(projectId, campaignId);
    if (!generic && !direct) fail(400, 'Choose a campaign in this project.'); return campaignId;
  }
  function destination(value) {
    const url = publicUrl(value), origins = new Set([appOrigin, ...db.prepare('SELECT short_base_url FROM project_link_settings').all().map(row => row.short_base_url), ...db.prepare('SELECT DISTINCT short_origin FROM campaign_links').all().map(row => row.short_origin)]);
    if (origins.has(url.origin) && /^\/s(?:\/|$)/.test(url.pathname)) fail(400, 'Use the final destination, not another short link from this app.');
    return url.href;
  }
  function analytics(projectId, url) {
    cleanup(); const days = Number(url.searchParams.get('days') ?? 30);
    if (!Number.isInteger(days) || days < 1 || days > 365) fail(400, 'Choose a reporting period between 1 and 365 days.');
    const campaignId = campaign(projectId, url.searchParams.get('campaignId') || ''), from = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10), rows = db.prepare('SELECT * FROM campaign_links WHERE project_id=? AND (?=\'\' OR campaign_id=?) ORDER BY rowid DESC').all(projectId, campaignId, campaignId), links = rows.map(row => linkView(row, from));
    const linkDays = db.prepare('SELECT d.day,SUM(d.clicks) AS clicks,SUM(d.qr_scans) AS qrScans FROM campaign_link_daily d JOIN campaign_links l ON l.id=d.link_id WHERE l.project_id=? AND d.day>=? AND (?=\'\' OR l.campaign_id=?) GROUP BY d.day').all(projectId, from, campaignId, campaignId);
    // Website events have no campaign identity; campaign-filtered reports include link traffic only.
    const website = campaignId ? [] : db.prepare('SELECT day,path,name,count FROM website_daily WHERE project_id=? AND day>=?').all(projectId, from), daily = new Map(), pages = new Map(), events = new Map();
    for (let index = 0; index < days; index++) { const date = new Date(Date.parse(from) + index * 86400000).toISOString().slice(0, 10); daily.set(date, { day: date, clicks: 0, qrScans: 0, pageviews: 0, events: 0 }); }
    for (const row of linkDays) if (daily.has(row.day)) Object.assign(daily.get(row.day), row);
    for (const row of website) { if (!daily.has(row.day)) continue; const view = row.name === 'pageview'; daily.get(row.day)[view ? 'pageviews' : 'events'] += row.count; const bucket = view ? pages : events, key = view ? row.path : row.name; bucket.set(key, (bucket.get(key) || 0) + row.count); }
    const totals = { clicks: 0, qrScans: 0, pageviews: 0, events: 0 }; for (const row of daily.values()) for (const key of Object.keys(totals)) totals[key] += row[key];
    return { days, from, through: day(), campaignId, daily: [...daily.values()], pages: [...pages].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count), events: [...events].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count), links, totals, measurement: 'requests_and_events_not_unique_people' };
  }
  async function handle(context) {
    const { req, res, url, project, role, user, send, body = {} } = context, prefix = `/api/projects/${encodeURIComponent(project.id)}/links`;
    if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return false;
    if (!['owner', 'admin', 'editor', 'viewer'].includes(role)) fail(403, 'Project access is required.');
    const path = url.pathname.slice(prefix.length), method = req.method;
    if (method !== 'GET' && !['owner', 'admin', 'editor'].includes(role)) fail(403, 'Your workspace role is view only.');
    if (path === '/settings' && method === 'GET') { send(200, { settings: settingsView(settings(project.id)) }); return true; }
    if (path === '/settings' && method === 'PUT') {
      if (!['owner', 'admin'].includes(role)) fail(403, 'Only workspace administrators can change tracking settings.');
      fields(body, ['shortBaseUrl', 'allowedWebsiteOrigins']); const current = settings(project.id), base = Object.hasOwn(body, 'shortBaseUrl') ? origin(body.shortBaseUrl, appOrigin) : current.short_base_url;
      if (base !== current.short_base_url && !user?.isOperator) fail(403, 'Only an instance operator with workspace administration access can change the short-link domain.');
      let origins = JSON.parse(current.website_origins);
      if (Object.hasOwn(body, 'allowedWebsiteOrigins')) { if (!Array.isArray(body.allowedWebsiteOrigins) || body.allowedWebsiteOrigins.length > 10) fail(400, 'Allow at most ten website origins.'); origins = [...new Set(body.allowedWebsiteOrigins.map(value => origin(value, appOrigin)))]; }
      db.prepare('UPDATE project_link_settings SET short_base_url=?,website_origins=?,updated_at=? WHERE project_id=?').run(base, JSON.stringify(origins), new Date().toISOString(), project.id);
      send(200, { settings: settingsView(settings(project.id)) }); return true;
    }
    if (path === '/analytics' && method === 'GET') { send(200, analytics(project.id, url)); return true; }
    if (!path && method === 'GET') { cleanup(); send(200, { links: db.prepare('SELECT * FROM campaign_links WHERE project_id=? ORDER BY rowid DESC').all(project.id).map(row => linkView(row)) }); return true; }
    if (!path && method === 'POST') {
      fields(body, ['name', 'destination', 'campaignId']); const name = label(body.name), target = destination(body.destination), campaignId = campaign(project.id, body.campaignId);
      const previous = db.prepare('SELECT * FROM campaign_links WHERE project_id=? AND destination=? AND campaign_id=? AND archived=0').get(project.id, target, campaignId);
      if (previous) { send(200, { link: linkView(previous) }); return true; }
      if (db.prepare('SELECT COUNT(*) AS count FROM campaign_links WHERE project_id=?').get(project.id).count >= 1000) fail(409, 'This project has reached its limit of 1,000 saved links.');
      const row = { id: randomUUID(), project_id: project.id, code: randomBytes(9).toString('base64url'), name, destination: target, campaign_id: campaignId, short_origin: settings(project.id).short_base_url, archived: 0, created_at: new Date().toISOString() };
      db.prepare('INSERT INTO campaign_links VALUES(?,?,?,?,?,?,?,?,?)').run(row.id, row.project_id, row.code, row.name, row.destination, row.campaign_id, row.short_origin, row.archived, row.created_at); send(201, { link: linkView(row) }); return true;
    }
    const match = path.match(/^\/([a-zA-Z0-9-]+)(\/qr\.svg)?$/);
    if (match && method === 'GET' && match[2]) {
      const link = linkView(find(project.id, match[1])), qr = qrcode(0, 'M'); qr.addData(link.qrUrl); qr.make();
      respond(res, 200, qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true }), { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Disposition': `inline; filename="campaign-${link.code}.svg"`, 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" }); return true;
    }
    if (match && method === 'PATCH' && !match[2]) {
      fields(body, ['name', 'archived']); const row = find(project.id, match[1]);
      if (Object.hasOwn(body, 'name')) row.name = label(body.name);
      if (Object.hasOwn(body, 'archived')) { if (typeof body.archived !== 'boolean') fail(400, 'Choose whether this link is archived.'); row.archived = Number(body.archived); }
      if (!row.archived && db.prepare('SELECT id FROM campaign_links WHERE project_id=? AND destination=? AND campaign_id=? AND archived=0 AND id<>?').get(project.id, row.destination, row.campaign_id, row.id)) fail(409, 'An active link already exists for this destination and campaign.');
      db.prepare('UPDATE campaign_links SET name=?,archived=? WHERE id=? AND project_id=?').run(row.name, row.archived, row.id, project.id); send(200, { link: linkView(row) }); return true;
    }
    fail(404, 'This links action was not found.');
  }
  async function publicHandle({ req, res, url }) {
    const challenge = url.pathname.match(/^\/s\/domain-check\/([A-Za-z0-9_-]{32})$/), redirect = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{12})$/), script = url.pathname.match(/^\/t\/([A-Za-z0-9_-]{32})\.js$/), ingest = url.pathname.match(/^\/api\/tracking\/([A-Za-z0-9_-]{32})\/events$/);
    if (!challenge && !redirect && !script && !ingest) { if (/^\/(?:s|t|api\/tracking)(?:\/|$)/.test(url.pathname)) { respond(res, 404, 'This public link is unavailable.'); return true; } return false; }
    try {
      if (challenge) {
        if (req.method !== 'GET') fail(405, 'Use GET for the domain check.');
        const row = db.prepare('SELECT * FROM project_link_settings WHERE domain_token=?').get(challenge[1]);
        if (!row || !hostMatches(req, row.short_base_url)) fail(404, 'This domain check is unavailable.');
        respond(res, 200, JSON.stringify({ token: row.domain_token, configuredOrigin: row.short_base_url, message: 'This request reached the configured Ten98 instance. DNS ownership and TLS renewal are not independently verified.' }), { 'Content-Type': 'application/json; charset=utf-8' }); return true;
      }
      if (redirect) {
        if (!['GET', 'HEAD'].includes(req.method)) fail(405, 'Use GET for short links.');
        const row = db.prepare('SELECT * FROM campaign_links WHERE code=?').get(redirect[1]);
        if (!row || !hostMatches(req, appOrigin) && !hostMatches(req, row.short_origin)) fail(404, 'This short link is unavailable.');
        if (row.archived) fail(410, 'This short link has been archived.');
        if (req.method === 'GET' && req.headers.dnt !== '1' && req.headers['sec-gpc'] !== '1') { cleanup(); const qr = url.searchParams.get('source') === 'qr'; db.prepare('INSERT INTO campaign_link_daily VALUES(?,?,?,?) ON CONFLICT(link_id,day) DO UPDATE SET clicks=clicks+excluded.clicks,qr_scans=qr_scans+excluded.qr_scans').run(row.id, day(), qr ? 0 : 1, qr ? 1 : 0); }
        respond(res, 302, undefined, { Location: row.destination }); return true;
      }
      const row = db.prepare('SELECT * FROM project_link_settings WHERE site_token=?').get((script || ingest)[1]);
      if (!row || !hostMatches(req, appOrigin) && !hostMatches(req, row.short_base_url)) fail(404, 'This tracking endpoint is unavailable.');
      if (script) { if (req.method !== 'GET') fail(405, 'Use GET for the website script.'); respond(res, 200, websiteScript(`${appOrigin}/api/tracking/${row.site_token}/events`), { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' }); return true; }
      const allowed = JSON.parse(row.website_origins);
      if (typeof req.headers.origin !== 'string' || !allowed.includes(req.headers.origin)) fail(403, 'This website origin is not allowed.');
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') { respond(res, 204, undefined, { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' }); return true; }
      if (req.method !== 'POST') fail(405, 'Use POST for website events.');
      if (req.headers.dnt === '1' || req.headers['sec-gpc'] === '1') { req.resume(); respond(res, 204); return true; }
      cleanup(); const minute = Math.floor(Date.now() / 60000);
      for (const [bucket, limit] of [['*', 10000], [row.site_token, 600]]) { const used = db.prepare('INSERT INTO website_event_limits VALUES(?,?,1) ON CONFLICT(bucket,minute) DO UPDATE SET count=count+1 RETURNING count').get(bucket, minute); if (used.count > limit) fail(429, 'The event limit has been reached. Try later.'); }
      const body = await eventBody(req); fields(body, ['eventId', 'name', 'path']);
      if (typeof body.eventId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.eventId) || typeof body.name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(body.name) || typeof body.path !== 'string' || body.path.length > 500 || !body.path.startsWith('/') || body.path.startsWith('//') || /[\u0000-\u0020\u007f\\]/.test(body.path)) fail(400, 'Use a UUID event ID, a short event name and a website path.');
      const path = new URL(body.path, 'https://tracking.invalid').pathname;
      transaction(db, () => {
        const current = db.prepare('SELECT website_origins FROM project_link_settings WHERE project_id=? AND site_token=?').get(row.project_id, row.site_token);
        if (!current || !JSON.parse(current.website_origins).includes(req.headers.origin)) fail(403, 'This website origin is no longer allowed.');
        if (db.prepare('SELECT event_id FROM website_event_ids WHERE project_id=? AND event_id=?').get(row.project_id, body.eventId)) return;
        if (db.prepare('SELECT COUNT(*) AS count FROM website_event_ids WHERE project_id=?').get(row.project_id).count >= 10000) fail(429, 'This project has reached its daily event limit.');
        if (!db.prepare('SELECT count FROM website_daily WHERE project_id=? AND day=? AND path=? AND name=?').get(row.project_id, day(), path, body.name) && db.prepare('SELECT COUNT(*) AS count FROM website_daily WHERE project_id=? AND day=?').get(row.project_id, day()).count >= 2000) fail(429, 'This project has reached its daily path and event limit.');
        db.prepare('INSERT INTO website_event_ids VALUES(?,?,?)').run(row.project_id, body.eventId, Date.now());
        db.prepare('INSERT INTO website_daily VALUES(?,?,?,?,1) ON CONFLICT(project_id,day,path,name) DO UPDATE SET count=count+1').run(row.project_id, day(), path, body.name);
      });
      respond(res, 204); return true;
    } catch (error) { respond(res, error instanceof HttpError ? error.status : 500, JSON.stringify({ error: error instanceof HttpError ? error.message : 'This request could not be completed.' }), { 'Content-Type': 'application/json; charset=utf-8' }); return true; }
  }
  return { handle, publicHandle };
}
