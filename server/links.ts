import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { sql } from 'drizzle-orm';
import { workspaceRoles } from '@ten98/runtime';
import qrcode from 'qrcode-generator';
import { advisoryLock, HttpError } from './auth.ts';
import type { Database, Executor } from './database.ts';
import type { PublicUser } from './auth.ts';
import { reportObject as object, type ProviderRecord } from './provider-core.ts';

function fail(status: number, message: string): never { throw new HttpError(status, message); }
const rows = async (query: Promise<{ rows: unknown[] }>) => (await query).rows as ProviderRecord[];
const first = async (query: Promise<{ rows: unknown[] }>) => (await rows(query))[0] as ProviderRecord | undefined;
const token = () => randomBytes(24).toString('base64url');
const day = () => new Date().toISOString().slice(0, 10);
function fields(body: any, allowed: string[]) { if (!object(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'Use only the fields shown in the link form.'); }
function label(value: any) { if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\u0000-\u001f\u007f]/.test(value)) fail(400, 'Use a link name of at most 120 characters.'); return value.trim(); }
function publicUrl(value: any): URL {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) fail(400, 'Use a public HTTPS URL without credentials.');
  let url!: URL; try { url = new URL(value); } catch { fail(400, 'Use a public HTTPS URL.'); }
  const hostname = url.hostname.replace(/\.$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || hostname.length > 253 || isIP(hostname) || hostname.includes(':') || !hostname.includes('.') || /(?:^|\.)(?:localhost|local|internal|invalid|home\.arpa)$/.test(hostname) || hostname.split('.').some(part => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part))) fail(400, 'Use a public HTTPS domain without credentials or private addresses.');
  return url;
}
function origin(value: any, appOrigin: string) {
  if (value === appOrigin) return appOrigin;
  const url = publicUrl(value);
  if (url.pathname !== '/' || url.search || url.hash) fail(400, 'Use an HTTPS origin without a path, query or fragment.');
  return url.origin;
}
function hostMatches(req: IncomingMessage, value: string) { return typeof req.headers.host === 'string' && req.headers.host.toLowerCase() === new URL(value).host.toLowerCase(); }
function respond(res: ServerResponse, status: number, body?: string, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(body);
}
async function eventBody(req: IncomingMessage) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) fail(415, 'Send JSON events.');
  if (Number(req.headers['content-length']) > 2048) { req.resume(); fail(413, 'This event is too large.'); }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) { size += chunk.length; if (size > 2048) { req.resume(); fail(413, 'This event is too large.'); } chunks.push(chunk); }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); } catch { fail(400, 'Send a valid JSON event.'); }
}
function websiteScript(endpoint: string) {
  return `(()=>{if(window.ten98Track)return;const disabled=()=>navigator.doNotTrack==='1'||window.doNotTrack==='1'||navigator.globalPrivacyControl===true;let last='';function track(name){if(disabled()||typeof name!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(name)||!crypto.randomUUID)return;const path=location.pathname;if(name==='pageview'&&last===path)return;if(name==='pageview')last=path;fetch(${JSON.stringify(endpoint).replace(/</g, '\\u003c')},{method:'POST',mode:'cors',credentials:'omit',referrerPolicy:'no-referrer',keepalive:true,headers:{'Content-Type':'application/json'},body:JSON.stringify({eventId:crypto.randomUUID(),name,path})}).catch(()=>{});}window.ten98Track=track;track('pageview');addEventListener('popstate',()=>track('pageview'));for(const method of ['pushState','replaceState']){const original=history[method];history[method]=function(...args){const result=original.apply(this,args);track('pageview');return result;};}})();`;
}

export function createLinks({ db, appUrl }: { db: Database; appUrl: string }) {
  const appOrigin = new URL(appUrl).origin;
  let nextCleanup = 0;
  async function cleanup() {
    if (Date.now() < nextCleanup) return; nextCleanup = Date.now() + 60000;
    await db.execute(sql`DELETE FROM website_event_ids WHERE created_at<${Date.now() - 86400000}`);
    await db.execute(sql`DELETE FROM website_event_limits WHERE minute<${Math.floor(Date.now() / 60000) - 1}`);
    const before = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    await db.execute(sql`DELETE FROM website_daily WHERE day<${before}`); await db.execute(sql`DELETE FROM campaign_link_daily WHERE day<${before}`);
  }
  async function settings(projectId: string, executor: Executor = db): Promise<ProviderRecord> {
    const current = await first(executor.execute(sql`SELECT * FROM project_link_settings WHERE project_id=${projectId}`)); if (current) return current;
    // A concurrent first read may create the row first; keep that row instead of failing on the primary key.
    await executor.execute(sql`INSERT INTO project_link_settings VALUES(${projectId},${appOrigin},${'[]'},${token()},${token()},${new Date().toISOString()}) ON CONFLICT(project_id) DO NOTHING`);
    return (await first(executor.execute(sql`SELECT * FROM project_link_settings WHERE project_id=${projectId}`)))!;
  }
  const settingsView = (row: ProviderRecord) => ({ shortBaseUrl: row.short_base_url, allowedWebsiteOrigins: row.website_origins, siteToken: row.site_token, scriptUrl: `${appOrigin}/t/${row.site_token}.js`, domainCheckUrl: `${row.short_base_url}/s/domain-check/${row.domain_token}`, domainStatus: row.short_base_url === appOrigin ? 'app_origin' : 'configured_unverified', updatedAt: row.updated_at });
  const find = async (executor: Executor, projectId: string, id: string): Promise<ProviderRecord> => { const row = await first(executor.execute(sql`SELECT * FROM campaign_links WHERE project_id=${projectId} AND id=${id}`)); if (!row) fail(404, 'This link was not found in this project.'); return row; };
  async function linkView(row: ProviderRecord, from = '0000-00-00') {
    const totals = (await first(db.execute(sql`SELECT COALESCE(SUM(clicks),0) AS clicks,COALESCE(SUM(qr_scans),0) AS "qrScans" FROM campaign_link_daily WHERE link_id=${row.id} AND day>=${from}`))) as { clicks: number; qrScans: number }, shortUrl = `${row.short_origin}/s/${row.code}`;
    return { id: row.id, code: row.code, name: row.name, destination: row.destination, campaignId: row.campaign_id, shortUrl, qrUrl: shortUrl + '?source=qr', qrSvgUrl: `/api/projects/${encodeURIComponent(row.project_id)}/links/${row.id}/qr.svg`, archived: Boolean(row.archived), createdAt: row.created_at, ...totals, totalVisits: totals.clicks + totals.qrScans };
  }
  async function campaign(projectId: string, campaignId: any) {
    if (campaignId === undefined || campaignId === '') return '';
    if (typeof campaignId !== 'string' || campaignId.length > 100 || /\s/.test(campaignId)) fail(400, 'Choose a campaign in this project.');
    const generic = await first(db.execute(sql`SELECT id FROM records WHERE project_id=${projectId} AND collection='campaigns' AND id=${campaignId}`));
    const direct = !generic && await first(db.execute(sql`SELECT id FROM direct_campaigns WHERE project_id=${projectId} AND id=${campaignId}`));
    if (!generic && !direct) fail(400, 'Choose a campaign in this project.'); return campaignId;
  }
  async function destination(value: any) {
    const url = publicUrl(value), origins = new Set([appOrigin, ...(await rows(db.execute(sql`SELECT short_base_url FROM project_link_settings`))).map(row => row.short_base_url), ...(await rows(db.execute(sql`SELECT DISTINCT short_origin FROM campaign_links`))).map(row => row.short_origin)]);
    if (origins.has(url.origin) && /^\/s(?:\/|$)/.test(url.pathname)) fail(400, 'Use the final destination, not another short link from this app.');
    return url.href;
  }
  async function analytics(projectId: string, url: URL) {
    await cleanup(); const days = Number(url.searchParams.get('days') ?? 30);
    if (!Number.isInteger(days) || days < 1 || days > 365) fail(400, 'Choose a reporting period between 1 and 365 days.');
    const campaignId = await campaign(projectId, url.searchParams.get('campaignId') || ''), from = new Date(Date.now() - (days - 1) * 86400000).toISOString().slice(0, 10), linkRows = await rows(db.execute(sql`SELECT * FROM campaign_links WHERE project_id=${projectId} AND (${campaignId}='' OR campaign_id=${campaignId}) ORDER BY seq DESC`)), links = await Promise.all(linkRows.map(row => linkView(row, from)));
    const linkDays = await rows(db.execute(sql`SELECT d.day,SUM(d.clicks) AS clicks,SUM(d.qr_scans) AS "qrScans" FROM campaign_link_daily d JOIN campaign_links l ON l.id=d.link_id WHERE l.project_id=${projectId} AND d.day>=${from} AND (${campaignId}='' OR l.campaign_id=${campaignId}) GROUP BY d.day`));
    // Website events have no campaign identity; campaign-filtered reports include link traffic only.
    const website = campaignId ? [] : await rows(db.execute(sql`SELECT day,path,name,count FROM website_daily WHERE project_id=${projectId} AND day>=${from}`)), daily = new Map<string, ProviderRecord>(), pages = new Map<string, number>(), events = new Map<string, number>();
    for (let index = 0; index < days; index++) { const date = new Date(Date.parse(from) + index * 86400000).toISOString().slice(0, 10); daily.set(date, { day: date, clicks: 0, qrScans: 0, pageviews: 0, events: 0 }); }
    for (const row of linkDays) if (daily.has(row.day)) Object.assign(daily.get(row.day)!, row);
    for (const row of website) { if (!daily.has(row.day)) continue; const view = row.name === 'pageview'; daily.get(row.day)![view ? 'pageviews' : 'events'] += row.count; const bucket = view ? pages : events, key = view ? row.path : row.name; bucket.set(key, (bucket.get(key) || 0) + row.count); }
    const totals: Record<string, number> = { clicks: 0, qrScans: 0, pageviews: 0, events: 0 }; for (const row of daily.values()) for (const key of Object.keys(totals)) totals[key] += row[key];
    return { days, from, through: day(), campaignId, daily: [...daily.values()], pages: [...pages].map(([path, count]) => ({ path, count })).sort((a, b) => b.count - a.count), events: [...events].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count), links, totals, measurement: 'requests_and_events_not_unique_people' };
  }
  async function handle(context: { req: IncomingMessage; res: ServerResponse; url: URL; project: { id: string }; role: string; user?: PublicUser; send: (status: number, body: unknown) => void; body?: any }) {
    const { req, res, url, project, role, user, send, body = {} } = context, prefix = `/api/projects/${encodeURIComponent(project.id)}/links`;
    if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return false;
    if (!(workspaceRoles as readonly string[]).includes(role)) fail(403, 'Project access is required.');
    const path = url.pathname.slice(prefix.length), method = req.method;
    if (method !== 'GET' && !['owner', 'admin', 'editor'].includes(role)) fail(403, 'Your workspace role is view only.');
    if (path === '/settings' && method === 'GET') { send(200, { settings: settingsView(await settings(project.id)) }); return true; }
    if (path === '/settings' && method === 'PUT') {
      if (!['owner', 'admin'].includes(role)) fail(403, 'Only workspace administrators can change tracking settings.');
      fields(body, ['shortBaseUrl', 'allowedWebsiteOrigins']); await settings(project.id);
      const saved = await db.transaction(async tx => {
        // The row lock stops a concurrent save from changing the domain between the operator check and this write.
        const current = (await first(tx.execute(sql`SELECT * FROM project_link_settings WHERE project_id=${project.id} FOR UPDATE`)))!, base = Object.hasOwn(body, 'shortBaseUrl') ? origin(body.shortBaseUrl, appOrigin) : current.short_base_url;
        if (base !== current.short_base_url && !user?.isOperator) fail(403, 'Only an instance operator with workspace administration access can change the short-link domain.');
        let origins = current.website_origins;
        if (Object.hasOwn(body, 'allowedWebsiteOrigins')) { if (!Array.isArray(body.allowedWebsiteOrigins) || body.allowedWebsiteOrigins.length > 10) fail(400, 'Allow at most ten website origins.'); origins = [...new Set(body.allowedWebsiteOrigins.map((value: any) => origin(value, appOrigin)))]; }
        await tx.execute(sql`UPDATE project_link_settings SET short_base_url=${base},website_origins=${JSON.stringify(origins)},updated_at=${new Date().toISOString()} WHERE project_id=${project.id}`);
        return settings(project.id, tx);
      });
      send(200, { settings: settingsView(saved) }); return true;
    }
    if (path === '/analytics' && method === 'GET') { send(200, await analytics(project.id, url)); return true; }
    if (!path && method === 'GET') { await cleanup(); send(200, { links: await Promise.all((await rows(db.execute(sql`SELECT * FROM campaign_links WHERE project_id=${project.id} ORDER BY seq DESC`))).map(row => linkView(row))) }); return true; }
    if (!path && method === 'POST') {
      fields(body, ['name', 'destination', 'campaignId']); const name = label(body.name), target = await destination(body.destination), campaignId = await campaign(project.id, body.campaignId), shortOrigin = (await settings(project.id)).short_base_url;
      const created = await db.transaction(async tx => {
        // Serialises link writes per project so concurrent creates cannot duplicate an active link or pass the 1,000 limit.
        await advisoryLock(tx, 'campaign-links:' + project.id);
        const previous = await first(tx.execute(sql`SELECT * FROM campaign_links WHERE project_id=${project.id} AND destination=${target} AND campaign_id=${campaignId} AND NOT archived`));
        if (previous) return { status: 200, row: previous };
        if ((await first(tx.execute(sql`SELECT COUNT(*) AS count FROM campaign_links WHERE project_id=${project.id}`)))!.count >= 1000) fail(409, 'This project has reached its limit of 1,000 saved links.');
        const row = { id: randomUUID(), project_id: project.id, code: randomBytes(9).toString('base64url'), name, destination: target, campaign_id: campaignId, short_origin: shortOrigin, archived: false, created_at: new Date().toISOString() };
        await tx.execute(sql`INSERT INTO campaign_links(id,project_id,code,name,destination,campaign_id,short_origin,archived,created_at) VALUES(${row.id},${row.project_id},${row.code},${row.name},${row.destination},${row.campaign_id},${row.short_origin},${row.archived},${row.created_at})`);
        return { status: 201, row };
      });
      send(created.status, { link: await linkView(created.row) }); return true;
    }
    const match = path.match(/^\/([a-zA-Z0-9-]+)(\/qr\.svg)?$/);
    if (match && method === 'GET' && match[2]) {
      const link = await linkView(await find(db, project.id, match[1])), qr = qrcode(0, 'M'); qr.addData(link.qrUrl); qr.make();
      respond(res, 200, qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true }), { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Disposition': `inline; filename="campaign-${link.code}.svg"`, 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox" }); return true;
    }
    if (match && method === 'PATCH' && !match[2]) {
      fields(body, ['name', 'archived']);
      const row = await db.transaction(async tx => {
        // Same per-project lock as create, so a concurrent restore or create cannot leave two active links for one destination.
        await advisoryLock(tx, 'campaign-links:' + project.id);
        const row = await find(tx, project.id, match[1]);
        if (Object.hasOwn(body, 'name')) row.name = label(body.name);
        if (Object.hasOwn(body, 'archived')) { if (typeof body.archived !== 'boolean') fail(400, 'Choose whether this link is archived.'); row.archived = body.archived; }
        if (!row.archived && await first(tx.execute(sql`SELECT id FROM campaign_links WHERE project_id=${project.id} AND destination=${row.destination} AND campaign_id=${row.campaign_id} AND NOT archived AND id<>${row.id}`))) fail(409, 'An active link already exists for this destination and campaign.');
        await tx.execute(sql`UPDATE campaign_links SET name=${row.name},archived=${row.archived} WHERE id=${row.id} AND project_id=${project.id}`);
        return row;
      });
      send(200, { link: await linkView(row) }); return true;
    }
    fail(404, 'This links action was not found.');
  }
  async function publicHandle({ req, res, url }: { req: IncomingMessage; res: ServerResponse; url: URL }) {
    const challenge = url.pathname.match(/^\/s\/domain-check\/([A-Za-z0-9_-]{32})$/), redirect = url.pathname.match(/^\/s\/([A-Za-z0-9_-]{12})$/), script = url.pathname.match(/^\/t\/([A-Za-z0-9_-]{32})\.js$/), ingest = url.pathname.match(/^\/api\/tracking\/([A-Za-z0-9_-]{32})\/events$/);
    if (!challenge && !redirect && !script && !ingest) { if (/^\/(?:s|t|api\/tracking)(?:\/|$)/.test(url.pathname)) { respond(res, 404, 'This public link is unavailable.'); return true; } return false; }
    try {
      if (challenge) {
        if (req.method !== 'GET') fail(405, 'Use GET for the domain check.');
        const row = await first(db.execute(sql`SELECT * FROM project_link_settings WHERE domain_token=${challenge[1]}`));
        if (!row || !hostMatches(req, row.short_base_url)) fail(404, 'This domain check is unavailable.');
        respond(res, 200, JSON.stringify({ token: row.domain_token, configuredOrigin: row.short_base_url, message: 'This request reached the configured Ten98 instance. DNS ownership and TLS renewal are not independently verified.' }), { 'Content-Type': 'application/json; charset=utf-8' }); return true;
      }
      if (redirect) {
        if (!['GET', 'HEAD'].includes(req.method!)) fail(405, 'Use GET for short links.');
        const row = await first(db.execute(sql`SELECT * FROM campaign_links WHERE code=${redirect[1]}`));
        if (!row || !hostMatches(req, appOrigin) && !hostMatches(req, row.short_origin)) fail(404, 'This short link is unavailable.');
        if (row.archived) fail(410, 'This short link has been archived.');
        if (req.method === 'GET' && req.headers.dnt !== '1' && req.headers['sec-gpc'] !== '1') { await cleanup(); const qr = url.searchParams.get('source') === 'qr'; await db.execute(sql`INSERT INTO campaign_link_daily VALUES(${row.id},${day()},${qr ? 0 : 1},${qr ? 1 : 0}) ON CONFLICT(link_id,day) DO UPDATE SET clicks=campaign_link_daily.clicks+excluded.clicks,qr_scans=campaign_link_daily.qr_scans+excluded.qr_scans`); }
        respond(res, 302, undefined, { Location: row.destination }); return true;
      }
      const row = await first(db.execute(sql`SELECT * FROM project_link_settings WHERE site_token=${(script || ingest)![1]}`));
      if (!row || !hostMatches(req, appOrigin) && !hostMatches(req, row.short_base_url)) fail(404, 'This tracking endpoint is unavailable.');
      if (script) { if (req.method !== 'GET') fail(405, 'Use GET for the website script.'); respond(res, 200, websiteScript(`${appOrigin}/api/tracking/${row.site_token}/events`), { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300' }); return true; }
      const allowed = row.website_origins;
      if (typeof req.headers.origin !== 'string' || !allowed.includes(req.headers.origin)) fail(403, 'This website origin is not allowed.');
      res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary', 'Origin');
      if (req.method === 'OPTIONS') { respond(res, 204, undefined, { 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '600' }); return true; }
      if (req.method !== 'POST') fail(405, 'Use POST for website events.');
      if (req.headers.dnt === '1' || req.headers['sec-gpc'] === '1') { req.resume(); respond(res, 204); return true; }
      await cleanup(); const minute = Math.floor(Date.now() / 60000);
      for (const [bucket, limit] of [['*', 10000], [row.site_token, 600]] as [string, number][]) { const used = (await first(db.execute(sql`INSERT INTO website_event_limits VALUES(${bucket},${minute},1) ON CONFLICT(bucket,minute) DO UPDATE SET count=website_event_limits.count+1 RETURNING count`)))!; if (used.count > limit) fail(429, 'The event limit has been reached. Try later.'); }
      const body = await eventBody(req); fields(body, ['eventId', 'name', 'path']);
      if (typeof body.eventId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.eventId) || typeof body.name !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(body.name) || typeof body.path !== 'string' || body.path.length > 500 || !body.path.startsWith('/') || body.path.startsWith('//') || /[\u0000-\u0020\u007f\\]/.test(body.path)) fail(400, 'Use a UUID event ID, a short event name and a website path.');
      const path = new URL(body.path, 'https://tracking.invalid').pathname;
      await db.transaction(async tx => {
        // Serialises event writes per project so duplicate event IDs and the daily event and path limits are checked atomically.
        await advisoryLock(tx, 'website-events:' + row.project_id);
        const current = await first(tx.execute(sql`SELECT website_origins FROM project_link_settings WHERE project_id=${row.project_id} AND site_token=${row.site_token}`));
        if (!current || !current.website_origins.includes(req.headers.origin!)) fail(403, 'This website origin is no longer allowed.');
        if (await first(tx.execute(sql`SELECT event_id FROM website_event_ids WHERE project_id=${row.project_id} AND event_id=${body.eventId}`))) return;
        if ((await first(tx.execute(sql`SELECT COUNT(*) AS count FROM website_event_ids WHERE project_id=${row.project_id}`)))!.count >= 10000) fail(429, 'This project has reached its daily event limit.');
        if (!await first(tx.execute(sql`SELECT count FROM website_daily WHERE project_id=${row.project_id} AND day=${day()} AND path=${path} AND name=${body.name}`)) && (await first(tx.execute(sql`SELECT COUNT(*) AS count FROM website_daily WHERE project_id=${row.project_id} AND day=${day()}`)))!.count >= 2000) fail(429, 'This project has reached its daily path and event limit.');
        await tx.execute(sql`INSERT INTO website_event_ids VALUES(${row.project_id},${body.eventId},${Date.now()})`);
        await tx.execute(sql`INSERT INTO website_daily VALUES(${row.project_id},${day()},${path},${body.name},1) ON CONFLICT(project_id,day,path,name) DO UPDATE SET count=website_daily.count+1`);
      });
      respond(res, 204); return true;
    } catch (error) { respond(res, error instanceof HttpError ? error.status : 500, JSON.stringify({ error: error instanceof HttpError ? error.message : 'This request could not be completed.' }), { 'Content-Type': 'application/json; charset=utf-8' }); return true; }
  }
  return { handle, publicHandle };
}
