import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server/index.mjs';

test('HTTP feature wiring preserves signed bytes, project boundaries, protected records and public map configuration', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-features-http-')), distDir = join(dataDir, 'dist');
  await mkdir(distDir); await writeFile(join(distDir, 'index.html'), '<!doctype html><title>Campaign</title><script type="module" src="/app.js"></script><script>window.fixture=true;</script>');
  const env = { ZERNIO_WEBHOOK_SECRET: 'signed-webhook-fixture-secret', GOOGLE_MAPS_BROWSER_API_KEY: 'public-browser-fixture-key', GOOGLE_MAPS_MAP_ID: 'public-map-id', GOOGLE_PRIVATE_KEY: 'private-google-key-not-for-browser' };
  const origin = 'http://127.0.0.1:3000', app = createApp({ dataDir, distDir, env, appUrl: origin });
  const originalFetch = globalThis.fetch; let externalRequests = 0, ownerCookie;
  globalThis.fetch = async (target, options) => { const url = new URL(target); if (url.hostname !== '127.0.0.1') { externalRequests++; throw new Error('Unexpected external request in HTTP feature test.'); } return originalFetch(target, options); };
  const sign = body => createHmac('sha256', env.ZERNIO_WEBHOOK_SECRET).update(body).digest('hex');
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, { method = 'GET', body, cookie = ownerCookie, headers = {} } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function webhook(payload, signature) {
    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const response = await fetch(base + '/api/webhooks/zernio', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Zernio-Signature': signature ?? sign(raw) }, body: raw });
    return { status: response.status, data: await response.json() };
  }
  try {
    const home = await fetch(base + '/'), policy = home.headers.get('content-security-policy'), html = await home.text();
    const nonce = /'nonce-([^']+)'/.exec(policy)[1];
    assert.match(policy, /'strict-dynamic'/); assert.match(policy, /'unsafe-eval'/);
    assert.deepEqual([...html.matchAll(/<script nonce="([^"]+)"/g)].map(match => match[1]), [nonce, nonce]);
    delete env.GOOGLE_MAPS_BROWSER_API_KEY;
    const plainHome = await fetch(base + '/'), plainPolicy = plainHome.headers.get('content-security-policy');
    assert.equal(plainPolicy.includes("'unsafe-eval'"), false); assert.match(plainPolicy, /'strict-dynamic'/); assert.notEqual(/'nonce-([^']+)'/.exec(plainPolicy)[1], nonce);
    env.GOOGLE_MAPS_BROWSER_API_KEY = 'public-browser-fixture-key';
    const testEvent = { id: randomUUID(), event: 'webhook.test', timestamp: '2026-10-18T10:00:00Z', message: 'Endpoint connected' };
    assert.equal((await webhook(testEvent)).status, 202, 'A signed server webhook needs no browser Origin or session.');
    assert.equal((await webhook(testEvent, '0'.repeat(64))).status, 401);
    assert.equal((await webhook('x'.repeat(1024 * 1024 + 1))).status, 413);
    assert.equal((await request('/api/projects/unknown/maps/config', { cookie: null })).status, 401);
    const setup = await request('/api/auth/setup', { method: 'POST', body: { name: 'Owner', email: 'owner-http@example.test', password: 'a sufficiently long fixture password', sample: false } });
    assert.equal(setup.status, 201); ownerCookie = setup.cookie;
    const initialState = (await request('/api/state')).data, workspaceId = initialState.workspaces[0].id;
    const created = await request('/api/projects', { method: 'POST', body: { workspaceId, name: 'Live features', zernioProfileId: 'profile-http-a' } });
    assert.equal(created.status, 201); const projectId = created.data.project.id, project = `/api/projects/${projectId}`;
    assert.equal((await request('/api/projects', { method: 'POST', body: { workspaceId, name: 'Duplicate brand', zernioProfileId: 'profile-http-a' } })).status, 409);
    const maps = await request(project + '/maps/config');
    assert.deepEqual(maps.data, { configured: true, browserKey: env.GOOGLE_MAPS_BROWSER_API_KEY, mapId: env.GOOGLE_MAPS_MAP_ID });
    assert.equal(JSON.stringify(maps).includes(env.GOOGLE_PRIVATE_KEY), false); assert.equal(JSON.stringify(maps).includes(env.ZERNIO_WEBHOOK_SECRET), false);
    const passwordHash = app.db.prepare('SELECT password FROM users WHERE id=?').get(initialState.user.id).password, viewerId = randomUUID();
    app.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(viewerId, 'Other member', 'member-http@example.test', passwordHash);
    const viewerCookie = (await request('/api/auth/login', { method: 'POST', body: { email: 'member-http@example.test', password: 'a sufficiently long fixture password' } })).cookie;
    assert.equal((await request(project + '/maps/config', { cookie: viewerCookie })).status, 404);
    assert.equal((await request(project + '/inbox/cache', { cookie: viewerCookie })).status, 404);
    const privateWorkspace = await request('/api/workspaces', { method: 'POST', body: { name: 'Other workspace' }, cookie: viewerCookie });
    assert.equal((await request(`/api/projects/${privateWorkspace.data.projectId}/maps/config`)).status, 404);
    assert.equal((await request(`/api/projects/${privateWorkspace.data.projectId}/calendar/connection`, { method: 'POST', body: { calendarId: 'not-operator@example.test' }, cookie: viewerCookie })).status, 403);
    await request(`/api/workspaces/${workspaceId}/members`, { method: 'POST', body: { email: 'member-http@example.test', role: 'viewer' } });
    const agent = await request(project + '/agent/status', { cookie: viewerCookie }); assert.equal(agent.status, 200); assert.equal(agent.data.configured, false);
    assert.equal((await request(project + '/agent/run', { method: 'POST', body: { message: 'Prepare a campaign' }, cookie: viewerCookie })).status, 403);
    assert.equal((await request(project + '/calendar/status')).data.mapped, false);
    assert.equal((await request(project + '/calendar/connection', { method: 'POST', body: { calendarId: 'shared-http@example.test' } })).status, 200);
    assert.deepEqual((await request(project + '/calendar/status')).data, { configured: false, mapped: true, calendarId: 'shared-http@example.test' });
    assert.equal((await request(project + '/calendar/connection', { method: 'POST', body: { calendarId: '' }, cookie: viewerCookie })).status, 403);
    const ooh = await request(project + '/ooh/status', { cookie: viewerCookie }); assert.equal(ooh.status, 200); assert.equal(ooh.data.configured, false); assert.equal(ooh.data.connection, null);
    assert.deepEqual((await request(project + '/ooh/inventory')).data.inventory, []); assert.deepEqual((await request(project + '/ooh/bookings')).data.bookings, []);
    const placement = { name: 'Dubai launch screen', location: 'Dubai', type: 'digital', latitude: 25.2048, longitude: 55.2708 };
    for (const coordinates of [{ latitude: 91, longitude: 55 }, { latitude: 25, longitude: 181 }, { latitude: 25 }, { longitude: 55 }, { latitude: '25', longitude: 55 }]) assert.equal((await request(project + '/placements', { method: 'POST', body: { name: 'Bad coordinates', location: 'Dubai', ...coordinates } })).status, 400);
    assert.equal((await request(project + '/placements', { method: 'POST', body: { ...placement, locationSource: 'broadsign' } })).status, 400);
    const savedPlacement = await request(project + '/placements', { method: 'POST', body: placement }); assert.equal(savedPlacement.status, 201); assert.equal(savedPlacement.data.record.locationSource, 'manual');
    for (const field of ['proposalItemId', 'screenId', 'bookingId']) assert.equal((await request(project + '/placements', { method: 'POST', body: { ...placement, [field]: 'forged' } })).status, 400);
    const providerPlacement = app.store.create(projectId, 'placements', { ...placement, source: 'broadsign', externalId: 'provider-proposal' });
    const providerCampaign = app.store.create(projectId, 'campaigns', { name: 'Provider campaign', externalId: 'ad-campaign' });
    for (const [collection, record] of [['placements', providerPlacement], ['campaigns', providerCampaign]]) {
      assert.equal((await request(`${project}/${collection}/${record.id}`, { method: 'PATCH', body: { name: 'Local override' } })).status, 400);
      assert.equal((await request(`${project}/${collection}/${record.id}`, { method: 'DELETE' })).status, 400);
    }
    assert.equal((await request(`${project}/placements/${savedPlacement.data.record.id}`, { method: 'PATCH', body: { latitude: null } })).status, 400);
    const message = 'مرحباً دبي 👋 — café', payload = { id: randomUUID(), event: 'message.received', timestamp: '2026-10-18T10:02:00Z', profiles: [{ id: 'profile-http-a', externalId: privateWorkspace.data.projectId }], account: { id: 'account-http-a', accountId: 'account-http-a', profileId: 'profile-http-a', platform: 'facebook' }, conversation: { id: 'internal-http-a', platformConversationId: 'platform-http-a', participantName: 'Alex', status: 'active' }, message: { id: 'message-http-a', conversationId: 'internal-http-a', platformMessageId: 'native-http-a', direction: 'incoming', text: message, sentAt: '2026-10-18T10:01:59Z', sender: { id: 'contact-http-a', name: 'Alex' } } };
    const bytes = Buffer.from(JSON.stringify(payload)), split = bytes.indexOf(Buffer.from('👋')) + 1;
    const streamed = await new Promise((resolve, reject) => {
      const req = httpRequest(base + '/api/webhooks/zernio', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': bytes.length, 'X-Zernio-Signature': sign(bytes) } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks)) })); });
      req.on('error', reject); req.setNoDelay(true); req.write(bytes.subarray(0, split)); setImmediate(() => req.end(bytes.subarray(split)));
    });
    assert.equal(streamed.status, 202); app.webhooks.processPending();
    const cached = await request(project + '/inbox/cache'), conversation = cached.data.conversations[0];
    assert.equal(cached.data.conversations.length, 1); assert.equal(conversation.externalConversationId, 'platform-http-a'); assert.equal(conversation.messages[0].content, message);
    assert.equal((await webhook(payload)).status, 200); app.webhooks.processPending();
    assert.equal((await request(project + '/inbox/cache')).data.conversations[0].messages.length, 1);
    assert.deepEqual((await request(`/api/projects/${privateWorkspace.data.projectId}/inbox/cache`, { cookie: viewerCookie })).data.conversations, []);
    assert.equal((await request(`${project}/conversations/${conversation.id}`, { method: 'PATCH', body: { status: 'resolved' } })).status, 400);
    assert.equal((await request(`${project}/conversations/${conversation.id}`, { method: 'DELETE' })).status, 400);
    assert.equal((await request(project + '/conversations', { method: 'POST', body: { contact: 'Forged live message', platform: 'facebook', messages: [], source: 'zernio' } })).status, 400);
    assert.equal(externalRequests, 0, 'Status, mapping, cache, local drafts and webhook processing perform no paid or external provider requests.');
  } finally { globalThis.fetch = originalFetch; await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
