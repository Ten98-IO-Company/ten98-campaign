import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createLinks } from '../server/links.ts';
import { postgresSkip, testDatabase } from './postgres.mjs';

async function fixture(t) {
  const { db, pool } = await testDatabase(t);
  await pool.query(`INSERT INTO workspaces (id, name) VALUES ('workspace', 'Workspace');
    INSERT INTO projects (id, workspace_id, name) VALUES ('one', 'workspace', 'One'), ('two', 'workspace', 'Two');
    INSERT INTO records (id, project_id, collection, data) VALUES ('campaign-one', 'one', 'campaigns', '{}'), ('campaign-two', 'two', 'campaigns', '{}');
    INSERT INTO direct_campaigns (id, project_id, data) VALUES ('direct-one', 'one', '{}');`);
  const query = async (text, params) => (await pool.query(text, params)).rows;
  let links, base;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base), send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      if (await links.publicHandle({ req, res, url })) return;
      const route = url.pathname.match(/^\/api\/projects\/(one|two)\/links(?:\/|$)/); if (!route) return send(404, {});
      let body = ''; for await (const chunk of req) body += chunk;
      await links.handle({ req, res, url, body: body ? JSON.parse(body) : {}, project: { id: route[1] }, role: req.headers['x-role'] || 'owner', user: { isOperator: req.headers['x-operator'] !== 'false' }, send });
    } catch (error) { send(error.status || 500, { error: error.message }); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; links = createLinks({ db, appUrl: base });
  async function request(path = '', method = 'GET', body, headers = {}) {
    return new Promise((resolve, reject) => {
      const outgoing = httpRequest(base + path, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers } }, response => {
        let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, headers: new Headers(response.headers), text, data: response.headers['content-type']?.includes('json') && text ? JSON.parse(text) : undefined }));
      }); outgoing.on('error', reject); outgoing.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  const api = (path = '', method = 'GET', body, headers) => request('/api/projects/one/links' + path, method, body, headers);
  return { query, base, request, api, close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

test('short links scope campaigns, preserve destinations, reuse active links and enforce edit roles', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    const created = await f.api('', 'POST', { name: 'Launch', destination: 'https://www.example.com/offer?utm_campaign=launch#details', campaignId: 'campaign-one' });
    assert.equal(created.status, 201); const link = created.data.link; assert.match(link.code, /^[\w-]{12}$/); assert.equal(link.shortUrl, f.base + '/s/' + link.code);
    assert.equal((await f.api('', 'POST', { name: 'Another name', destination: link.destination, campaignId: 'campaign-one' })).data.link.id, link.id);
    assert.equal((await f.api('', 'POST', { name: 'SMS offer', destination: 'https://example.com/sms', campaignId: 'direct-one' })).status, 201);
    assert.equal((await f.api('', 'POST', { name: 'Foreign', destination: 'https://example.com', campaignId: 'campaign-two' })).status, 400);
    assert.equal((await f.api('', 'POST', { name: 'Read only', destination: 'https://example.com' }, { 'X-Role': 'viewer' })).status, 403);
    assert.equal((await f.api('/' + link.id, 'PATCH', { destination: 'https://example.org' })).status, 400);
    assert.equal((await f.request('/api/projects/two/links/' + link.id, 'PATCH', { archived: true })).status, 404);
    assert.equal((await f.api('/' + link.id, 'PATCH', { name: 'Updated' })).data.link.name, 'Updated');
    for (const destination of ['http://example.com', 'https://localhost/x', 'https://127.0.0.1/x', 'https://2130706433/x', 'https://[::1]/x', 'https://10.0.0.1/x', 'https://metadata.google.internal/x', 'https://user:secret@example.com/x', 'javascript:alert(1)']) assert.equal((await f.api('', 'POST', { name: 'Invalid', destination })).status, 400, destination);
  } finally { await f.close(); }
});

test('custom domain settings require operator administration and saved QR codes survive domain changes', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    const settings = (await f.api('/settings')).data.settings;
    assert.equal(settings.domainStatus, 'app_origin'); assert.match(settings.siteToken, /^[\w-]{32}$/);
    assert.equal((await f.api('/settings', 'PUT', { allowedWebsiteOrigins: ['https://www.example.com'] }, { 'X-Role': 'editor' })).status, 403);
    assert.equal((await f.api('/settings', 'PUT', { shortBaseUrl: 'https://go.example.com' }, { 'X-Operator': 'false' })).status, 403);
    for (const shortBaseUrl of ['https://go.example.com/path', 'https://go.example.com/?token=x', 'https://go.example.com/#x', 'http://go.example.com', 'https://192.168.1.1']) assert.equal((await f.api('/settings', 'PUT', { shortBaseUrl })).status, 400);
    const configured = (await f.api('/settings', 'PUT', { shortBaseUrl: 'https://go.example.com', allowedWebsiteOrigins: ['https://www.example.com', 'https://www.example.com'] })).data.settings;
    assert.equal(configured.domainStatus, 'configured_unverified'); assert.deepEqual(configured.allowedWebsiteOrigins, ['https://www.example.com']);
    const link = (await f.api('', 'POST', { name: 'OOH QR', destination: 'https://example.com/landing' })).data.link;
    assert.equal(link.shortUrl, 'https://go.example.com/s/' + link.code); assert.equal(link.qrUrl, link.shortUrl + '?source=qr');
    const qr = await f.request(link.qrSvgUrl); assert.equal(qr.status, 200); assert.match(qr.headers.get('content-type'), /^image\/svg\+xml/); assert.match(qr.text, /^<svg/); assert.match(qr.text, /<path/); assert.doesNotMatch(qr.text, /<script|<foreignObject|https:\/\/example.com\/landing/);
    assert.equal((await f.request(new URL(configured.domainCheckUrl).pathname, 'GET', undefined, { Host: 'go.example.com' })).status, 200);
    assert.equal((await f.request(new URL(configured.domainCheckUrl).pathname)).status, 404);
    assert.equal((await f.api('', 'POST', { name: 'Loop', destination: link.shortUrl })).status, 400);
    await f.api('/settings', 'PUT', { shortBaseUrl: 'https://new.example.com' });
    assert.equal((await f.api('')).data.links[0].shortUrl, link.shortUrl);
    assert.equal((await f.request('/s/' + link.code, 'GET', undefined, { Host: 'go.example.com' })).status, 302);
    assert.equal((await f.request('/s/' + link.code, 'GET', undefined, { Host: 'attacker.example.com' })).status, 404);
  } finally { await f.close(); }
});

test('unresolvable overlong domains cannot create broken QR links or tracking settings', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    const maximumHost = [...Array(3).fill('a'.repeat(63)), 'b'.repeat(61)].join('.');
    assert.equal(maximumHost.length, 253);
    for (const host of [maximumHost + 'b', Array(40).fill('a'.repeat(60)).join('.') + '.com']) {
      const address = 'https://' + host;
      assert.equal((await f.api('/settings', 'PUT', { shortBaseUrl: address })).status, 400);
      assert.equal((await f.api('/settings', 'PUT', { allowedWebsiteOrigins: [address] })).status, 400);
      assert.equal((await f.api('', 'POST', { name: 'Invalid host', destination: address })).status, 400);
    }
    assert.equal((await f.api('/settings', 'PUT', { shortBaseUrl: 'https://' + maximumHost })).status, 200);
    const link = (await f.api('', 'POST', { name: 'Longest valid host', destination: 'https://example.com/offer' })).data.link;
    assert.equal((await f.request(link.qrSvgUrl)).status, 200);
  } finally { await f.close(); }
});

test('redirects count QR-tagged and ordinary requests separately, excluding HEAD and opt-outs', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    const link = (await f.api('', 'POST', { name: 'Visit', destination: 'https://example.com/offer?utm_source=ooh', campaignId: 'campaign-one' })).data.link, path = '/s/' + link.code;
    const redirect = await f.request(path); assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), link.destination); assert.equal(redirect.headers.get('cache-control'), 'no-store'); assert.equal(redirect.headers.get('set-cookie'), null);
    await f.request(path + '?source=qr'); await f.request(path, 'HEAD'); await f.request(path, 'GET', undefined, { DNT: '1' }); await f.request(path + '?source=qr', 'GET', undefined, { 'Sec-GPC': '1' });
    const stats = (await f.api('/analytics?days=7')).data; assert.deepEqual(stats.totals, { clicks: 1, qrScans: 1, pageviews: 0, events: 0 }); assert.equal(stats.daily.length, 7); assert.equal(stats.links[0].totalVisits, 2); assert.equal(stats.measurement, 'requests_and_events_not_unique_people');
    assert.equal((await f.api('/analytics?days=0')).status, 400);
    assert.equal((await f.api('/' + link.id, 'PATCH', { archived: true })).status, 200); assert.equal((await f.request(path)).status, 410);
    const replacement = (await f.api('', 'POST', { name: 'New visit', destination: link.destination, campaignId: 'campaign-one' })).data.link; assert.notEqual(replacement.id, link.id);
    assert.equal((await f.api('/' + link.id, 'PATCH', { archived: false })).status, 409);
  } finally { await f.close(); }
});

// ten98-campaign#116: a browser following a disabled or unknown short link gets a small page; other clients keep JSON.
test('disabled and unknown short links show browsers a fixed page and keep JSON for other clients', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    const link = (await f.api('', 'POST', { name: 'Visit', destination: 'https://example.com/offer', campaignId: 'campaign-one' })).data.link, path = '/s/' + link.code;
    assert.equal((await f.api('/' + link.id, 'PATCH', { archived: true })).status, 200);
    const browser = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
    const policy = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
    const page = async (target, status, title) => {
      const response = await f.request(target, 'GET', undefined, browser);
      assert.equal(response.status, status, target); assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(response.headers.get('content-security-policy'), policy); assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff'); assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
      assert.ok(response.text.startsWith('<!doctype html><html lang="en">')); assert.ok(response.text.includes(`<title>${title}</title>`) && response.text.includes(`<h1>${title}</h1>`));
      assert.doesNotMatch(response.text, /<script|<link|<img|src=|href=/, 'The page loads nothing.');
      return response.text;
    };
    const disabled = await page(path, 410, 'This link is no longer active');
    assert.equal(disabled.includes(link.code), false, 'The page repeats nothing from the request.');
    await page('/s/AAAAAAAAAAAA', 404, "This link isn't available");
    const malformed = await page('/s/%3Cscript%3Ealert(1)%3C%2Fscript%3E', 404, "This link isn't available");
    assert.equal(malformed.includes('alert'), false);
    const head = await f.request(path, 'HEAD', undefined, browser); assert.equal(head.status, 410); assert.equal(head.text, '');
    // API and other non-HTML clients keep the JSON error.
    for (const headers of [{}, { Accept: 'application/json' }]) {
      const gone = await f.request(path, 'GET', undefined, headers), missing = await f.request('/s/AAAAAAAAAAAA', 'GET', undefined, headers);
      assert.equal(gone.status, 410); assert.equal(gone.headers.get('content-type'), 'application/json; charset=utf-8'); assert.deepEqual(gone.data, { error: 'This short link is no longer active.' });
      assert.equal(missing.status, 404); assert.deepEqual(missing.data, { error: 'This short link is unavailable.' });
    }
    assert.equal((await f.request(path)).headers.get('content-security-policy'), null, 'Only the page carries its own policy.');
  } finally { await f.close(); }
});

test('website intake uses exact origins, strips query/hash, deduplicates IDs and stores no visitor identity', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    const settings = (await f.api('/settings', 'PUT', { allowedWebsiteOrigins: ['https://www.example.com'] })).data.settings, endpoint = '/api/tracking/' + settings.siteToken + '/events', body = { eventId: randomUUID(), name: 'pageview', path: '/landing?email=private@example.com#secret' }, headers = { Origin: 'https://www.example.com' };
    assert.equal((await f.request(endpoint, 'POST', body)).status, 403); assert.equal((await f.request(endpoint, 'POST', body, { Origin: 'https://www.example.com.attacker.com' })).status, 403);
    const preflight = await f.request(endpoint, 'OPTIONS', undefined, headers); assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), headers.Origin); assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
    const accepted = await f.request(endpoint, 'POST', body, headers); assert.equal(accepted.status, 204); assert.equal(accepted.headers.get('set-cookie'), null); assert.equal(accepted.headers.get('access-control-allow-origin'), headers.Origin);
    await f.request(endpoint, 'POST', body, headers); await f.request(endpoint, 'POST', { eventId: randomUUID(), name: 'lead_submitted', path: '/thanks?token=secret' }, headers);
    await f.request(endpoint, 'POST', { ...body, eventId: randomUUID() }, { ...headers, DNT: '1' });
    const stats = (await f.api('/analytics')).data; assert.equal(stats.totals.pageviews, 1); assert.equal(stats.totals.events, 1); assert.deepEqual(stats.pages, [{ path: '/landing', count: 1 }]); assert.deepEqual(stats.events, [{ name: 'lead_submitted', count: 1 }]);
    assert.equal((await f.api('/analytics?campaignId=campaign-one')).data.totals.pageviews, 0);
    assert.equal((await f.request('/api/projects/two/links/analytics')).data.totals.pageviews, 0);
    const data = JSON.stringify(await f.query('SELECT * FROM website_daily')); assert.doesNotMatch(data, /private|secret|127\.0\.0\.1|Mozilla|email|referrer|user.agent/i);
    assert.deepEqual((await f.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'website_daily' ORDER BY ordinal_position")).map(row => row.column_name), ['project_id', 'day', 'path', 'name', 'count']);
    for (const invalid of [{ ...body, eventId: 'bad' }, { ...body, name: 'Email:person@example.com' }, { ...body, path: 'https://example.com/private' }, { ...body, path: '//example.com/private' }, { ...body, referrer: 'https://private.example.com' }]) assert.equal((await f.request(endpoint, 'POST', invalid, headers)).status, 400);
    assert.equal((await f.request(endpoint, 'POST', { ...body, path: '/x'.repeat(2000) }, headers)).status, 413);
    await f.query('INSERT INTO website_event_limits VALUES($1,$2,600) ON CONFLICT(bucket,minute) DO UPDATE SET count=600', [settings.siteToken, Math.floor(Date.now() / 60000)]);
    assert.equal((await f.request(endpoint, 'POST', { ...body, eventId: randomUUID() }, headers)).status, 429);
  } finally { await f.close(); }
});

test('tracking browser script respects privacy signals, omits credentials and tracks SPA path changes', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    const settings = (await f.api('/settings')).data.settings, script = await f.request(new URL(settings.scriptUrl).pathname); assert.equal(script.status, 200); assert.match(script.headers.get('content-type'), /javascript/);
    const calls = [], events = {}, location = { pathname: '/landing', search: '?email=private', hash: '#secret' }, context = { window: {}, navigator: {}, crypto: { randomUUID }, location, fetch: (...args) => { calls.push(args); return Promise.resolve(); }, history: { pushState(_, __, path) { location.pathname = path; return 7; }, replaceState(_, __, path) { location.pathname = path; } }, addEventListener: (name, fn) => { events[name] = fn; } };
    runInNewContext(script.text, context); assert.equal(calls.length, 1); context.window.ten98Track('signup'); assert.equal(context.history.pushState(null, '', '/pricing'), 7); context.history.replaceState(null, '', '/pricing'); events.popstate(); assert.equal(calls.length, 3);
    for (const [endpoint, options] of calls) { assert.equal(endpoint, f.base + '/api/tracking/' + settings.siteToken + '/events'); assert.equal(options.credentials, 'omit'); assert.equal(options.referrerPolicy, 'no-referrer'); assert.equal(options.keepalive, true); assert.doesNotMatch(options.body, /private|secret|email/); }
    context.navigator.globalPrivacyControl = true; context.window.ten98Track('signup'); assert.equal(calls.length, 3);
    const optedOut = { ...context, window: {}, navigator: { doNotTrack: '1' } }; runInNewContext(script.text, optedOut); assert.equal(calls.length, 3);
    runInNewContext(script.text, context); assert.equal(calls.length, 3);
  } finally { await f.close(); }
});

test('campaign reports and public tokens remain isolated through archive and project deletion', { skip: postgresSkip }, async t => {
  const f = await fixture(t); try {
    const settings = (await f.api('/settings', 'PUT', { allowedWebsiteOrigins: ['https://www.example.com'] })).data.settings;
    const link = (await f.api('', 'POST', { name: 'One', destination: 'https://example.com/one', campaignId: 'campaign-one' })).data.link;
    const other = (await f.request('/api/projects/two/links', 'POST', { name: 'Two', destination: 'https://example.com/two', campaignId: 'campaign-two' })).data.link;
    await f.request('/s/' + link.code); await f.request('/s/' + other.code + '?source=qr');
    const event = '/api/tracking/' + settings.siteToken + '/events', origin = { Origin: 'https://www.example.com' };
    await f.request(event, 'POST', { eventId: randomUUID(), name: 'pageview', path: '/one' }, origin);
    const report = (await f.api('/analytics?campaignId=campaign-one')).data;
    assert.deepEqual(report.totals, { clicks: 1, qrScans: 0, pageviews: 0, events: 0 });
    assert.deepEqual(report.links.map(item => item.id), [link.id]);
    assert.equal((await f.api('/analytics?campaignId=campaign-two')).status, 400);
    assert.equal((await f.request('/api/projects/two/links/' + link.id + '/qr.svg')).status, 404);
    await f.api('/' + link.id, 'PATCH', { archived: true });
    assert.equal((await f.api('/analytics')).data.totals.clicks, 1);
    await f.query("DELETE FROM projects WHERE id='one'");
    assert.equal((await f.request('/s/' + link.code)).status, 404);
    assert.equal((await f.request(new URL(settings.scriptUrl).pathname)).status, 404);
    assert.equal((await f.request(event, 'POST', { eventId: randomUUID(), name: 'pageview', path: '/one' }, origin)).status, 404);
    assert.equal((await f.query('SELECT count(*) AS count FROM campaign_link_daily WHERE link_id=$1', [link.id]))[0].count, 0);
    assert.equal((await f.query("SELECT count(*) AS count FROM website_daily WHERE project_id='one'"))[0].count, 0);
    assert.equal((await f.query("SELECT count(*) AS count FROM website_event_ids WHERE project_id='one'"))[0].count, 0);
    assert.equal((await f.request('/s/' + other.code)).status, 302);
    assert.deepEqual((await f.request('/api/projects/two/links/analytics')).data.totals, { clicks: 1, qrScans: 1, pageviews: 0, events: 0 });
  } finally { await f.close(); }
});
