// Regression tests for the queries in server/links.ts: the conflict, lock, limit and aggregation paths, one assertion
// per query, over a real PostgreSQL database. links.test.mjs covers the end-to-end link and tracking scenarios.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import type { PublicUser } from '../server/auth.ts';
import { createLinks } from '../server/links.ts';
import { blockWrites, lockWaiters, postgresSkip, testDatabase } from './postgres.mjs';
import { seedAccounts } from './fixtures/accounts.ts';

const daysAgo = (count: number) => new Date(Date.now() - count * 86400000).toISOString().slice(0, 10);
const origin = { Origin: 'https://www.example.com' };
type Reply = { status: number; text: string; data: any };

async function fixture(t: TestContext) {
  const { db, pool } = await testDatabase(t);
  await seedAccounts(pool, { workspaces: [{ id: 'workspace', name: 'Workspace' }] });
  await pool.query(`INSERT INTO projects (id, workspace_id, name) VALUES ('one', 'workspace', 'One'), ('two', 'workspace', 'Two');
    INSERT INTO records (id, project_id, collection, data) VALUES ('campaign-one', 'one', 'campaigns', '{}'), ('campaign-two', 'two', 'campaigns', '{}'), ('post-one', 'one', 'posts', '{}');
    INSERT INTO direct_campaigns (id, project_id, data) VALUES ('direct-one', 'one', '{}'), ('direct-two', 'two', '{}')`);
  let links!: ReturnType<typeof createLinks>, base = '';
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, base), send = (status: number, body: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      if (await links.publicHandle({ req, res, url })) return;
      const route = url.pathname.match(/^\/api\/projects\/(one|two)\/links(?:\/|$)/); if (!route) return send(404, {});
      let body = ''; for await (const chunk of req) body += chunk;
      await links.handle({ req, res, url, body: body ? JSON.parse(body) : {}, project: { id: route[1] }, role: String(req.headers['x-role'] || 'owner'), user: { isOperator: req.headers['x-operator'] !== 'false' } as PublicUser, send });
    } catch (error: any) { send(error.status || 500, { error: error.message }); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; links = createLinks({ db, appUrl: base });
  async function request(path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const response = await fetch(base + path, { method, redirect: 'manual', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, text, data: response.headers.get('content-type')?.includes('json') && text ? JSON.parse(text) : undefined };
  }
  const api = (path = '', method = 'GET', body?: unknown, headers?: Record<string, string>) => request('/api/projects/one/links' + path, method, body, headers);
  // Creates a link and returns it; `project` is 'one' or 'two'.
  async function create(project: string, name: string, destination: string, campaignId?: string) {
    const reply = await request(`/api/projects/${project}/links`, 'POST', { name, destination, ...(campaignId ? { campaignId } : {}) });
    assert.ok([200, 201].includes(reply.status), `${name}: ${reply.text}`); return reply.data.link as { id: string; code: string; name: string; clicks: number; qrScans: number; totalVisits: number };
  }
  // Turns website tracking on for a project and returns its intake endpoint and site token.
  async function track(project: string) {
    const reply = await request(`/api/projects/${project}/links/settings`, 'PUT', { allowedWebsiteOrigins: [origin.Origin] });
    assert.equal(reply.status, 200, reply.text); const siteToken = reply.data.settings.siteToken as string;
    return { siteToken, send: (name: string, path: string, eventId: string = randomUUID()) => request(`/api/tracking/${siteToken}/events`, 'POST', { eventId, name, path }, origin) };
  }
  const rows = async (text: string, values: unknown[] = []) => (await pool.query(text, values)).rows;
  return { pool, api, request, create, track, rows, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('link totals and reports sum the right rows: window edge, project and campaign scope, newest link first, no traffic reads zero', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    const a = await f.create('one', 'A', 'https://example.com/a', 'campaign-one'), b = await f.create('one', 'B', 'https://example.com/b', 'campaign-one'), c = await f.create('one', 'C', 'https://example.com/c');
    await f.create('one', 'D', 'https://example.com/d'); const other = await f.create('two', 'Other', 'https://example.com/a');
    const traffic = (link: { id: string }, day: string, clicks: number, scans: number) => f.pool.query('INSERT INTO campaign_link_daily (link_id, day, clicks, qr_scans) VALUES ($1, $2, $3, $4)', [link.id, day, clicks, scans]);
    await traffic(a, daysAgo(0), 2, 1); await traffic(a, daysAgo(6), 4, 0); await traffic(b, daysAgo(0), 3, 2); await traffic(b, daysAgo(7), 8, 8); await traffic(c, daysAgo(0), 50, 0); await traffic(other, daysAgo(0), 100, 100);
    // Website events: one day outside the seven-day window, and another project's views.
    const hits = (project: string, day: string, path: string, name: string, count: number) => f.pool.query('INSERT INTO website_daily VALUES ($1, $2, $3, $4, $5)', [project, day, path, name, count]);
    await hits('one', daysAgo(0), '/a', 'pageview', 3); await hits('one', daysAgo(6), '/a', 'pageview', 1); await hits('one', daysAgo(7), '/a', 'pageview', 9); await hits('one', daysAgo(0), '/a', 'signup', 2); await hits('two', daysAgo(0), '/a', 'pageview', 20);
    const totals = (link: { clicks: number; qrScans: number; totalVisits: number }) => [link.clicks, link.qrScans, link.totalVisits], names = (links: { name: string }[]) => links.map(link => link.name);
    const listed = (await f.api('')).data.links;
    assert.deepEqual(names(listed), ['D', 'C', 'B', 'A'], 'Newest link first.');
    assert.deepEqual(listed.map(totals), [[0, 0, 0], [50, 0, 50], [11, 10, 21], [6, 1, 7]], 'The list totals all time; a link without traffic reads zero.');
    const week = (await f.api('/analytics?days=7')).data;
    assert.equal(week.from, daysAgo(6)); assert.deepEqual(week.daily.map((row: { day: string }) => row.day), [6, 5, 4, 3, 2, 1, 0].map(daysAgo));
    assert.deepEqual([week.daily[0].clicks, week.daily[0].qrScans], [4, 0]); assert.deepEqual([week.daily[6].clicks, week.daily[6].qrScans], [55, 3], 'A day sums every link of the project, not the other project.');
    assert.deepEqual(week.totals, { clicks: 59, qrScans: 3, pageviews: 4, events: 2 }, 'The seven-day window starts six days ago and keeps its first day.');
    assert.deepEqual(week.links.map(totals), [[0, 0, 0], [50, 0, 50], [3, 2, 5], [6, 1, 7]], 'Link totals in a report follow the same window.');
    assert.deepEqual(week.pages, [{ path: '/a', count: 4 }]); assert.deepEqual(week.events, [{ name: 'signup', count: 2 }]);
    const campaign = (await f.api('/analytics?days=7&campaignId=campaign-one')).data;
    assert.deepEqual(names(campaign.links), ['B', 'A']); assert.deepEqual(campaign.totals, { clicks: 9, qrScans: 3, pageviews: 0, events: 0 }, 'A campaign report counts its own links and no website events.');
    assert.deepEqual([campaign.daily[6].clicks, campaign.daily[6].qrScans], [5, 3]);
    const today = (await f.api('/analytics?days=1')).data;
    assert.deepEqual(today.daily.map((row: { day: string }) => row.day), [daysAgo(0)]); assert.deepEqual(today.totals, { clicks: 55, qrScans: 3, pageviews: 3, events: 2 });
    const two = (await f.request('/api/projects/two/links/analytics?days=7')).data;
    assert.deepEqual(names(two.links), ['Other']); assert.deepEqual(two.totals, { clicks: 100, qrScans: 100, pageviews: 20, events: 0 });
  } finally { await f.close(); }
});

test('every ordinary request and QR scan adds to its day, and a new day starts its own row', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    const link = await f.create('one', 'Visit', 'https://example.com/visit', 'campaign-one'), path = '/s/' + link.code;
    await f.pool.query('INSERT INTO campaign_link_daily VALUES ($1, $2, 7, 5)', [link.id, daysAgo(1)]);
    for (let visit = 0; visit < 3; visit++) assert.equal((await f.request(path)).status, 302);
    for (let scan = 0; scan < 2; scan++) assert.equal((await f.request(path + '?source=qr')).status, 302);
    assert.deepEqual(await f.rows('SELECT day, clicks, qr_scans FROM campaign_link_daily WHERE link_id = $1 ORDER BY day', [link.id]), [{ day: daysAgo(1), clicks: 7, qr_scans: 5 }, { day: daysAgo(0), clicks: 3, qr_scans: 2 }]);
  } finally { await f.close(); }
});

test('cleanup removes only expired intake counters and old daily rows', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    const link = await f.create('one', 'Old traffic', 'https://example.com/old'), now = Date.now(), minute = Math.floor(now / 60000), cutoff = daysAgo(365);
    await f.pool.query("INSERT INTO website_event_ids VALUES ('one', 'expired', $1), ('one', 'recent', $2)", [now - 86400000 - 60000, now - 82800000]);
    await f.pool.query("INSERT INTO website_event_limits VALUES ('stale', $1, 1), ('previous', $2, 1), ('current', $3, 1)", [minute - 2, minute - 1, minute]);
    await f.pool.query("INSERT INTO website_daily VALUES ('one', $1, '/old', 'pageview', 1), ('one', $2, '/kept', 'pageview', 1)", [daysAgo(366), cutoff]);
    await f.pool.query('INSERT INTO campaign_link_daily VALUES ($1, $2, 1, 1), ($1, $3, 1, 1)', [link.id, daysAgo(366), cutoff]);
    assert.equal((await f.api('')).status, 200, 'Listing runs the cleanup.');
    assert.deepEqual((await f.rows('SELECT event_id FROM website_event_ids')).map(row => row.event_id), ['recent']);
    assert.deepEqual((await f.rows('SELECT bucket FROM website_event_limits ORDER BY bucket')).map(row => row.bucket), ['current', 'previous']);
    assert.deepEqual((await f.rows('SELECT path FROM website_daily')).map(row => row.path), ['/kept']);
    assert.deepEqual((await f.rows('SELECT day FROM campaign_link_daily')).map(row => row.day), [cutoff]);
  } finally { await f.close(); }
});

test('two first reads of a project keep one settings row and one set of tokens', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    const gate = await blockWrites(f.pool, 'project_link_settings');
    const reads = [f.request('/api/projects/two/links/settings'), f.request('/api/projects/two/links/settings')];
    await gate.waiting(2); await gate.release();
    const [first, second] = await Promise.all(reads);
    assert.deepEqual([first.status, second.status], [200, 200]); assert.equal(first.data.settings.siteToken, second.data.settings.siteToken);
    assert.deepEqual((await f.rows("SELECT website_origins::text AS stored FROM project_link_settings WHERE project_id = 'two'")).map(row => row.stored), ['[]'], 'One row, with the default origins stored as JSON text.');
  } finally { await f.close(); }
});

test('a settings save waits for the row lock, so it cannot write back a stale short-link domain', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    await f.api('/settings');
    const holder = await f.pool.connect();
    try {
      await holder.query('BEGIN'); await holder.query("SELECT 1 FROM project_link_settings WHERE project_id = 'one' FOR UPDATE");
      // A workspace administrator who is not an instance operator saves origins only; the domain change below is already underway.
      const save = f.api('/settings', 'PUT', { allowedWebsiteOrigins: [origin.Origin] }, { 'X-Role': 'admin', 'X-Operator': 'false' });
      await lockWaiters(holder, 1);
      await holder.query("UPDATE project_link_settings SET short_base_url = 'https://go.example.com' WHERE project_id = 'one'"); await holder.query('COMMIT');
      const saved = await save;
      assert.equal(saved.status, 200, saved.text); assert.equal(saved.data.settings.shortBaseUrl, 'https://go.example.com'); assert.deepEqual(saved.data.settings.allowedWebsiteOrigins, [origin.Origin]);
      assert.deepEqual(await f.rows("SELECT short_base_url, website_origins::text AS stored FROM project_link_settings WHERE project_id = 'one'"), [{ short_base_url: 'https://go.example.com', stored: JSON.stringify([origin.Origin]) }], 'The origins are stored as the same JSON text as before.');
    } finally { await holder.query('ROLLBACK').catch(() => undefined); holder.release(); }
  } finally { await f.close(); }
});

test('creating a link reuses the active one for the same project, destination and campaign only', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    const destination = 'https://example.com/shared', first = await f.create('one', 'First', destination, 'campaign-one');
    assert.equal((await f.create('one', 'Again', destination, 'campaign-one')).id, first.id, 'The same destination and campaign reuse the link.');
    assert.notEqual((await f.create('one', 'No campaign', destination)).id, first.id, 'Another campaign gets its own link.');
    assert.notEqual((await f.create('two', 'Other project', destination)).id, first.id, 'Another project gets its own link.');
    assert.equal((await f.rows('SELECT * FROM campaign_links')).length, 3);
  } finally { await f.close(); }
});

test('parallel creates of one destination serialise on the project and save a single link', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    const gate = await blockWrites(f.pool, 'campaign_links'), body = { name: 'Race', destination: 'https://example.com/race', campaignId: 'campaign-one' };
    const racing = [f.api('', 'POST', body), f.api('', 'POST', body)];
    await gate.waiting(2); await gate.release();
    const replies = await Promise.all(racing);
    assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 201], JSON.stringify(replies.map(reply => reply.text)));
    assert.equal(replies[0].data.link.id, replies[1].data.link.id); assert.equal((await f.rows("SELECT * FROM campaign_links WHERE destination = 'https://example.com/race'")).length, 1);
  } finally { await f.close(); }
});

test('a project holds at most 1,000 links, archived ones included, and the count is per project', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    // 998 saved links, half of them archived; the project's own link below is the 999th.
    await f.pool.query(`INSERT INTO campaign_links (id, project_id, code, name, destination, campaign_id, short_origin, archived, created_at)
      SELECT 'bulk-' || n, 'one', 'bulk-code-' || n, 'Bulk', 'https://example.com/bulk/' || n, '', 'http://localhost', n % 2 = 0, 'now' FROM generate_series(1, 998) AS n`);
    const kept = await f.create('one', 'Kept', 'https://example.com/kept');
    assert.equal((await f.api('', 'POST', { name: 'Thousandth', destination: 'https://example.com/thousandth' })).status, 201, 'The 1,000th link is allowed.');
    const refused = await f.api('', 'POST', { name: 'Over', destination: 'https://example.com/over' });
    assert.equal(refused.status, 409); assert.match(refused.data.error, /1,000 saved links/);
    assert.equal((await f.api('', 'POST', { name: 'Existing', destination: 'https://example.com/kept' })).data.link.id, kept.id, 'An active destination is reused even at the limit.');
    assert.equal((await f.request('/api/projects/two/links', 'POST', { name: 'Other project', destination: 'https://example.com/over' })).status, 201, 'Another project has its own count.');
  } finally { await f.close(); }
});

test('restoring a link refuses only a clash with an active link of the same project, destination and campaign', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    const archive = async (link: { id: string }) => assert.equal((await f.api('/' + link.id, 'PATCH', { archived: true })).status, 200), restore = (link: { id: string }) => f.api('/' + link.id, 'PATCH', { archived: false });
    const sameCampaign = await f.create('one', 'Same', 'https://example.com/same'), otherCampaign = await f.create('one', 'Campaign', 'https://example.com/campaign', 'campaign-one'), otherProject = await f.create('one', 'Project', 'https://example.com/project');
    for (const link of [sameCampaign, otherCampaign, otherProject]) await archive(link);
    await f.create('one', 'Active same', 'https://example.com/same'); await f.create('one', 'Active no campaign', 'https://example.com/campaign'); await f.create('two', 'Active elsewhere', 'https://example.com/project');
    assert.equal((await restore(sameCampaign)).status, 409, 'An active link with this destination and campaign exists.');
    assert.equal((await restore(otherCampaign)).status, 200, 'Another campaign does not clash.');
    assert.equal((await restore(otherProject)).status, 200, 'Another project does not clash.');
  } finally { await f.close(); }
});

test('a link campaign must be a campaign or direct campaign record of the same project', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    for (const [campaignId, status] of [['campaign-one', 201], ['direct-one', 201], ['post-one', 400], ['campaign-two', 400], ['direct-two', 400], ['missing', 400]] as const) {
      assert.equal((await f.api('', 'POST', { name: campaignId, destination: 'https://example.com/' + campaignId, campaignId })).status, status, campaignId);
    }
  } finally { await f.close(); }
});

test('a destination may not be a short link of any project, or of a domain a link was saved under', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    assert.equal((await f.request('/api/projects/two/links/settings', 'PUT', { shortBaseUrl: 'https://two.example.com' })).status, 200);
    assert.equal((await f.api('', 'POST', { name: 'Loop', destination: 'https://two.example.com/s/AAAAAAAAAAAA' })).status, 400, "Another project's short-link domain.");
    assert.equal((await f.api('', 'POST', { name: 'Landing', destination: 'https://two.example.com/landing' })).status, 201, 'Only its short-link paths are refused.');
    assert.equal((await f.api('/settings', 'PUT', { shortBaseUrl: 'https://go.example.com' })).status, 200);
    await f.create('one', 'Saved under go', 'https://example.com/saved');
    assert.equal((await f.api('/settings', 'PUT', { shortBaseUrl: 'https://new.example.com' })).status, 200);
    assert.equal((await f.api('', 'POST', { name: 'Old domain', destination: 'https://go.example.com/s/BBBBBBBBBBBB' })).status, 400, 'A domain an existing link was saved under.');
  } finally { await f.close(); }
});

test('website intake counts every request in both buckets and adds repeat events to one daily row', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    const { siteToken, send } = await f.track('one'), repeated = randomUUID();
    for (const [name, path] of [['pageview', '/a'], ['pageview', '/a'], ['pageview', '/b'], ['signup', '/a']]) assert.equal((await send(name, path)).status, 204);
    assert.equal((await send('pageview', '/a', repeated)).status, 204); assert.equal((await send('pageview', '/a', repeated)).status, 204, 'A repeated event ID is acknowledged and counted once.');
    assert.deepEqual(await f.rows('SELECT path, name, count FROM website_daily ORDER BY path, name'), [{ path: '/a', name: 'pageview', count: 3 }, { path: '/a', name: 'signup', count: 1 }, { path: '/b', name: 'pageview', count: 1 }]);
    assert.equal((await f.rows('SELECT * FROM website_event_ids')).length, 5);
    const buckets = async () => Object.fromEntries((await f.rows('SELECT bucket, SUM(count)::int AS total FROM website_event_limits GROUP BY bucket')).map(row => [row.bucket, row.total]));
    assert.deepEqual(await buckets(), { '*': 6, [siteToken]: 6 }, 'Both buckets count every request, repeated events included.');
    await f.pool.query("INSERT INTO website_event_limits VALUES ('*', $1, 10000) ON CONFLICT (bucket, minute) DO UPDATE SET count = 10000", [Math.floor(Date.now() / 60000)]);
    const before = (await buckets())[siteToken];
    assert.equal((await send('pageview', '/c')).status, 429, 'The shared bucket stops intake first.');
    assert.equal((await buckets())[siteToken], before, 'The site bucket is not counted once the shared one refuses.');
  } finally { await f.close(); }
});

test('website intake stops at 10,000 event IDs a day but still acknowledges a known ID', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    const { send } = await f.track('one'), known = randomUUID();
    await f.pool.query("INSERT INTO website_event_ids VALUES ('one', $1, $2)", [known, Date.now()]);
    await f.pool.query("INSERT INTO website_event_ids SELECT 'one', 'bulk-' || n, $1::bigint FROM generate_series(1, 9998) AS n", [Date.now()]);
    assert.equal((await send('pageview', '/last')).status, 204, 'The 10,000th ID is allowed.');
    const refused = await send('pageview', '/over'); assert.equal(refused.status, 429); assert.match(refused.data.error, /daily event limit/);
    assert.equal((await send('pageview', '/last', known)).status, 204, 'A known ID is acknowledged at the limit.');
    assert.equal((await f.rows("SELECT * FROM website_event_ids WHERE project_id = 'one'")).length, 10000);
  } finally { await f.close(); }
});

test('website intake stops at 2,000 daily paths and event names but still counts an existing one', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    const { send } = await f.track('one'), counted = async (path: string, name: string) => (await f.rows('SELECT count FROM website_daily WHERE path = $1 AND name = $2', [path, name]))[0]?.count;
    await f.pool.query("INSERT INTO website_daily SELECT 'one', $1, '/bulk/' || n, 'pageview', 1 FROM generate_series(1, 1999) AS n", [daysAgo(0)]);
    assert.equal((await send('pageview', '/last')).status, 204, 'The 2,000th combination is allowed.');
    const refused = await send('pageview', '/over'); assert.equal(refused.status, 429); assert.match(refused.data.error, /daily path and event limit/);
    assert.equal((await send('signup', '/bulk/1')).status, 429, 'Another event name on a known path is a new combination.');
    assert.equal((await send('pageview', '/bulk/1')).status, 204); assert.equal(await counted('/bulk/1', 'pageview'), 2, 'An existing combination keeps counting at the limit.');
    assert.equal(await counted('/over', 'pageview'), undefined);
  } finally { await f.close(); }
});

test('an event whose origin is removed while it waits for the project lock is refused and not stored', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    const { send } = await f.track('one'), holder = await f.pool.connect();
    try {
      await holder.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', ['website-events:one']);
      const pending = send('pageview', '/late');
      await lockWaiters(holder, 1);
      await f.pool.query("UPDATE project_link_settings SET website_origins = '[]' WHERE project_id = 'one'");
      await holder.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', ['website-events:one']);
      const refused = await pending; assert.equal(refused.status, 403); assert.equal(refused.data.error, 'This website origin is no longer allowed.');
      assert.equal((await f.rows('SELECT * FROM website_daily')).length + (await f.rows('SELECT * FROM website_event_ids')).length, 0);
    } finally { await holder.query('SELECT pg_advisory_unlock_all()').catch(() => undefined); holder.release(); }
  } finally { await f.close(); }
});
