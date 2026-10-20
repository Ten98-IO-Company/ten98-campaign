import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import { transformWithOxc } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createWebhookService } from '../server/webhooks.mjs';
import { createContacts } from '../server/contacts.mjs';
import { handleZernioAdEvents } from '../server/zernio-ad-events.mjs';
import { IntegrationError } from '../server/provider-core.ts';
import { createApp } from '../server/index.mjs';

const secret = 'synthetic-paid-events-secret', profileId = 'profile-a';
const event = (name = 'ad.status_changed', extra = {}) => ({ id: randomUUID(), event: name, timestamp: '2026-10-18T12:00:00Z', profiles: [{ id: profileId, externalId: 'PRIVATE_EXTERNAL_ID' }], account: { accountId: 'meta-a', profileId, platform: 'metaads', username: 'PRIVATE_USERNAME', displayName: 'PRIVATE_NAME' }, ...(name === 'account.ads.initial_sync_completed' ? { sync: { status: 'success', totalAds: 10, synced: 9, failed: 1, error: 'PRIVATE_DIAGNOSTIC', errorCategory: 'permission_denied', errorCode: '10' } } : name === 'account.ads.sync_failed' ? { adAccount: { platformAdAccountId: 'act_123', name: 'PRIVATE_ADVERTISER_NAME' }, sync: { lastSuccessfulSyncAt: '2026-10-17T12:00:00Z', failureCount: 3, errorCategory: 'sync_error', error: 'PRIVATE_DIAGNOSTIC' } } : name === 'account.ads.sync_recovered' ? { adAccount: { platformAdAccountId: 'act_123', name: 'PRIVATE_ADVERTISER_NAME' }, sync: { lastSuccessfulSyncAt: '2026-10-18T12:00:00Z', failingSince: '2026-10-17T12:00:00Z' } } : name === 'ad.video.processed' ? { video: { id: '456', platformAdAccountId: 'act_123', status: 'ready', error: null, thumbnailUrl: 'https://cdn.example.test/PRIVATE_VIDEO' } } : name === 'lead.received' ? { account: { id: 'page-a', accountId: 'page-a', platform: 'facebook', profileId }, lead: { id: '000000000000000000000001', leadgenId: '901', formId: '801', formName: 'PRIVATE_FORM_NAME', adId: '701', campaignId: '601', fields: { PRIVATE_QUESTION: 'PRIVATE_ANSWER', email: 'private@example.test' }, isOrganic: false, createdAt: '2026-10-18T11:59:00Z' } } : { adObject: { level: 'AD', platformId: '701', platformAdAccountId: 'act_123' }, status: { raw: 'WITH_ISSUES' }, error: { code: '2643001', summary: 'PRIVATE_SUMMARY', message: 'PRIVATE_DIAGNOSTIC' } }), ...extra });
const sign = raw => createHmac('sha256', secret).update(raw).digest('hex');
const deliver = (service, payload, headers = {}) => { const bytes = Buffer.from(JSON.stringify(payload)); return service.receive(bytes, { 'x-zernio-signature': sign(bytes), ...headers }); };
function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec("PRAGMA foreign_keys=ON; CREATE TABLE projects(id TEXT PRIMARY KEY,zernio_profile_id TEXT NOT NULL); INSERT INTO projects VALUES('project-a','profile-a'),('project-b','profile-b')");
  const contacts = createContacts({ db }), posts = [{ id: 'post-a', projectId: 'project-a', externalId: 'remote-post', zernioProfileId: profileId, status: 'submitted' }, { id: 'post-b', projectId: 'project-b', externalId: 'remote-post', zernioProfileId: profileId, status: 'draft' }];
  const store = { list: (project, collection) => collection === 'posts' ? posts.filter(row => row.projectId === project) : [], update: (project, collection, id, changes) => Object.assign(posts.find(row => row.id === id && row.projectId === project), changes) };
  const service = createWebhookService({ db, store, contacts, env: { ZERNIO_WEBHOOK_SECRET: secret } }), calls = [], state = { accounts: [{ _id: 'meta-a', platform: 'metaads', profileId }, { _id: 'page-a', platform: 'facebook', profileId }, { _id: 'foreign-account', platform: 'metaads', profileId: 'foreign-profile' }], advertisers: [{ id: 'act_123', name: 'Reviewed advertiser', selectable: true }, { id: 'act_124', name: 'Sibling advertiser', selectable: false }], onRead: null };
  const api = async (path, query = {}) => { calls.push({ path, query }); state.onRead?.(path, query); if (path === '/accounts') return { accounts: structuredClone(state.accounts) }; assert.equal(path, '/ads/accounts'); assert.equal(query.accountId, 'meta-a'); assert.equal(query.inScopeOnly, true); return { accounts: structuredClone(state.advertisers), ...state.freshness }; };
  async function read(action = '', query = '?accountId=meta-a&adAccountId=act_123') {
    let response; const context = { db, project: { id: 'project-a', zernioProfileId: profileId }, req: { method: 'GET' }, url: new URL('http://localhost/api/projects/project-a/integrations/ads/events' + (action ? '/' + action : '') + query), config: { env: { ZERNIO_WEBHOOK_SECRET: secret } }, assertProjectMapping: expected => { if (db.prepare('SELECT zernio_profile_id FROM projects WHERE id=?').get('project-a').zernio_profile_id !== expected) throw new IntegrationError(409, 'MAPPING_CHANGED', 'Mapping changed'); }, send: (status, data) => { response = { status, data }; } };
    try { await handleZernioAdEvents(context, api, profileId, action); return response; } catch (error) { if (!(error instanceof IntegrationError)) throw error; return { status: error.status, data: { error: { code: error.code } } }; }
  }
  return { db, contacts, posts, service, api, calls, state, read };
}

test('all six signed paid-ad events use durable dedupe and retain identifiers without lead answers or diagnostics', async () => {
  const f = fixture();
  try {
    for (const name of ['account.ads.initial_sync_completed', 'account.ads.sync_failed', 'account.ads.sync_recovered', 'lead.received', 'ad.status_changed', 'ad.video.processed']) {
      const payload = event(name); assert.equal(f.service.receive(Buffer.from(JSON.stringify(payload)), {}).status, 401); assert.equal(deliver(f.service, payload).status, 202); assert.equal(deliver(f.service, payload).status, 200); assert.equal(deliver(f.service, { ...payload, extra: 'different raw body' }).status, 409);
    }
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM webhook_ad_updates').get().n, 0); assert.deepEqual(f.service.processPending(), { processed: 6, pending: 0 });
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM webhook_ad_updates').get().n, 6); assert.equal(f.contacts.list('project-a').length, 0); assert.equal(f.posts[0].status, 'submitted');
    const stored = JSON.stringify(f.db.prepare('SELECT payload FROM webhook_events').all()) + JSON.stringify(f.db.prepare('SELECT data FROM webhook_ad_updates').all()); assert.doesNotMatch(stored, /PRIVATE_|private@example|thumbnailUrl|fields|username|displayName|error.summary|error.message/);
    let result = await f.read(); assert.equal(result.status, 200); assert.equal(result.data.updates.length, 5); assert.equal(result.data.updates.filter(row => row.scope === 'connection').length, 1); assert.equal(JSON.stringify(result.data).includes('PRIVATE_'), false);
    result = await f.read('', '?accountId=page-a'); assert.equal(result.status, 200); assert.equal(result.data.updates[0].lead.answerCount, 2); assert.equal(result.data.updates[0].scope, 'connection');
    deliver(f.service, event('ad.status_changed', { test: true })); assert.equal(f.service.processPending().processed, 0); assert.equal(f.db.prepare("SELECT count(*) AS n FROM webhook_events WHERE status='ignored'").get().n, 1);
  } finally { f.db.close(); }
});

test('malformed paid metadata and impossible timestamps fail at the common signed ingestion boundary', () => {
  const f = fixture();
  try {
    const base = event();
    for (const changes of [{ account: { ...base.account, id: 'another-account' } }, { account: { ...base.account, platform: 'googleads' } }, { profiles: [{ id: 'foreign-profile' }] }, { adObject: { ...base.adObject, platformAdAccountId: 'https://foreign.example/test' } }, { adObject: { ...base.adObject, platformId: 'someone@example.test' } }, { status: { raw: 'PRIVATE DIAGNOSTIC' } }, { error: { code: 'https://private.example.test' } }]) assert.equal(deliver(f.service, event('ad.status_changed', changes)).status, 400);
    const lead = event('lead.received'); assert.equal(deliver(f.service, { ...lead, lead: { ...lead.lead, fields: { email: { nested: 'bad' } } } }).status, 400);
    for (const name of ['post.published', 'message.received', 'ad.status_changed']) for (const timestamp of ['2026-02-30T12:00:00Z', '2026-10-18T24:00:00Z', '2026-10-18T12:60:00Z', '2026-10-18T12:00:00']) assert.equal(deliver(f.service, event(name, { timestamp })).status, 400);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM webhook_events').get().n, 0);
  } finally { f.db.close(); }
});

test('sync notifications validate native advertiser identifiers across the available ads networks', () => {
  const f = fixture();
  try {
    for (const [platform, advertiser] of [['metaads', 'act_123'], ['googleads', '1234567890'], ['tiktokads', '1234567890123456'], ['linkedinads', '123456'], ['pinterestads', '123456789'], ['xads', '18ce54'], ['redditads', 't2_reddit123'], ['openaiads', 'dd88f3b9-bd94-4c63-9ec3-8ee07cdb455e']]) {
      const base = event('account.ads.sync_failed'), payload = { ...base, account: { ...base.account, platform }, adAccount: { platformAdAccountId: advertiser } };
      assert.equal(deliver(f.service, payload).status, 202); assert.equal(deliver(f.service, { ...payload, id: randomUUID(), adAccount: { platformAdAccountId: 'not an advertiser' } }).status, 400);
    }
    assert.deepEqual(f.service.processPending(), { processed: 8, pending: 0 }); assert.equal(f.db.prepare('SELECT count(*) AS n FROM webhook_ad_updates').get().n, 8);
  } finally { f.db.close(); }
});

test('late events remain history while latest timestamp determines reported sync health and ties remain ambiguous', async () => {
  const f = fixture();
  try {
    const incoming = [event('account.ads.sync_failed', { timestamp: '2026-10-18T12:00:00Z' }), event('account.ads.sync_recovered', { timestamp: '2026-10-18T14:00:00Z' }), event('account.ads.sync_failed', { timestamp: '2026-10-18T11:00:00Z' })];
    for (const payload of incoming) { deliver(f.service, payload); f.service.processPending(); }
    let result = await f.read(); assert.equal(result.data.updates[0].timestamp, '2026-10-18T11:00:00.000Z'); assert.equal(result.data.health.advertiserSync.event, 'account.ads.sync_recovered');
    result = await f.read('', '?accountId=meta-a&adAccountId=act_123&limit=1'); assert.equal(result.data.updates.length, 1); assert.equal(result.data.pagination.hasMore, true);
    const next = await f.read('', '?accountId=meta-a&adAccountId=act_123&limit=1&before=' + result.data.pagination.before); assert.notEqual(next.data.updates[0].id, result.data.updates[0].id);
    deliver(f.service, event('account.ads.sync_failed', { timestamp: '2026-10-18T14:00:00Z' })); f.service.processPending(); assert.equal((await f.read()).data.health.advertiserSync.event, 'conflicting');
    assert.equal((await f.read('', '?accountId=meta-a&adAccountId=act_124')).data.updates.length, 0); assert.equal((await f.read('', '?accountId=meta-a')).data.updates.length, 0);
    const initial = event('account.ads.initial_sync_completed'); deliver(f.service, initial); deliver(f.service, event('account.ads.initial_sync_completed', { sync: { ...initial.sync, status: 'failure', synced: 0, failed: 10 } })); f.service.processPending();
    const conflict = (await f.read()).data.health.initialSync; assert.equal(conflict.event, 'conflicting'); assert.equal(conflict.status, undefined); assert.equal(conflict.synced, undefined);
  } finally { f.db.close(); }
});

test('a first-known mapping survives failed legacy or initially unmapped effect work', () => {
  const f = fixture();
  try {
    const payload = event('post.published', { profiles: [{ id: 'profile-later' }], post: { id: 'not-linked-yet' } }); deliver(f.service, payload);
    f.db.prepare("UPDATE projects SET zernio_profile_id='profile-later' WHERE id='project-a'").run(); assert.deepEqual(f.service.processPending(), { processed: 0, pending: 1 }); assert.equal(f.db.prepare('SELECT last_error FROM webhook_events WHERE id=?').get(payload.id).last_error, 'POST_NOT_LINKED');
    assert.equal(f.db.prepare('SELECT project_id FROM webhook_project_bindings WHERE event_id=?').get(payload.id).project_id, 'project-a');
    f.db.prepare("UPDATE projects SET zernio_profile_id='replacement' WHERE id='project-a'").run(); f.db.prepare("UPDATE projects SET zernio_profile_id='profile-later' WHERE id='project-b'").run(); f.posts[1].externalId = 'not-linked-yet'; f.posts[1].zernioProfileId = 'profile-later';
    assert.deepEqual(f.service.processPending({ now: Date.now() + 61000 }), { processed: 0, pending: 1 }); assert.equal(f.db.prepare('SELECT last_error FROM webhook_events WHERE id=?').get(payload.id).last_error, 'PROFILE_MAPPING_CHANGED'); assert.equal(f.posts[1].status, 'draft');
  } finally { f.db.close(); }
});

test('receipt ordering and pagination survive deferred earlier events processing after a later delivery', async () => {
  const f = fixture();
  try {
    f.db.prepare("UPDATE projects SET zernio_profile_id='temporarily-unmapped' WHERE id='project-a'").run();
    const earlier = event(), later = event('ad.video.processed'); deliver(f.service, earlier); assert.deepEqual(f.service.processPending(), { processed: 0, pending: 1 });
    f.db.prepare("UPDATE projects SET zernio_profile_id='profile-a' WHERE id='project-a'").run(); deliver(f.service, later); assert.deepEqual(f.service.processPending(), { processed: 1, pending: 0 });
    assert.deepEqual(f.service.processPending({ now: Date.now() + 61000 }), { processed: 1, pending: 0 });
    const first = await f.read('', '?accountId=meta-a&adAccountId=act_123&limit=1'); assert.equal(first.data.updates[0].id, later.id); assert.equal(first.data.updates[0].sequence, f.db.prepare('SELECT rowid FROM webhook_events WHERE id=?').get(later.id).rowid);
    const second = await f.read('', '?accountId=meta-a&adAccountId=act_123&limit=1&before=' + first.data.pagination.before); assert.equal(second.data.updates[0].id, earlier.id); assert.equal(second.data.pagination.hasMore, false);
  } finally { f.db.close(); }
});

test('known receipt mappings cannot move queued posts, inbox identities or ad notifications to another project', () => {
  const f = fixture();
  try {
    const incoming = event('message.received', { account: { accountId: 'page-a', profileId, platform: 'facebook' }, conversation: { id: 'conversation-a', participantId: 'participant-a' }, message: { id: 'message-a', direction: 'incoming', sender: { id: 'participant-a', name: 'Synthetic sender' } } }), post = event('post.published', { post: { id: 'remote-post' } });
    for (const payload of [incoming, post, event()]) assert.equal(deliver(f.service, payload).status, 202);
    f.db.prepare("UPDATE projects SET zernio_profile_id='replacement' WHERE id='project-a'").run(); f.db.prepare("UPDATE projects SET zernio_profile_id='profile-a' WHERE id='project-b'").run();
    assert.deepEqual(f.service.processPending(), { processed: 0, pending: 3 }); assert.ok(f.db.prepare('SELECT last_error FROM webhook_events').all().every(row => row.last_error === 'PROFILE_MAPPING_CHANGED'));
    assert.equal(f.contacts.list('project-b').length, 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM webhook_inbox_updates').get().n, 0); assert.equal(f.db.prepare('SELECT count(*) AS n FROM webhook_ad_updates').get().n, 0); assert.equal(f.posts[1].status, 'draft');
    f.db.prepare("UPDATE projects SET zernio_profile_id='profile-b' WHERE id='project-b'").run(); f.db.prepare("UPDATE projects SET zernio_profile_id='profile-a' WHERE id='project-a'").run(); assert.deepEqual(f.service.processPending({ now: Date.now() + 61000 }), { processed: 3, pending: 0 }); assert.equal(f.contacts.list('project-a').length, 1); assert.equal(f.posts[0].status, 'published');
  } finally { f.db.close(); }
});

test('read access rechecks current connection and native advertiser membership and hides remapped history', async () => {
  const f = fixture();
  try {
    deliver(f.service, event()); f.service.processPending(); assert.equal((await f.read('accounts', '')).data.accounts.length, 2); assert.equal((await f.read('ad-accounts', '?accountId=meta-a')).data.accounts.length, 2);
    assert.equal((await f.read('', '?accountId=foreign-account&adAccountId=act_123')).status, 403); assert.equal((await f.read('', '?accountId=meta-a&adAccountId=act_999')).status, 403); assert.equal((await f.read('', '?accountId=page-a&adAccountId=act_123')).status, 403);
    let advertiserReads = 0; f.state.onRead = path => { if (path === '/ads/accounts' && ++advertiserReads === 2) f.state.advertisers = []; }; assert.equal((await f.read()).status, 403);
    f.state.onRead = null; f.state.advertisers = [{ id: 'act_123', name: 'Reviewed' }]; let accountReads = 0; f.state.onRead = path => { if (path === '/accounts' && ++accountReads === 2) f.state.accounts[0].profileId = 'foreign-profile'; }; assert.equal((await f.read()).status, 403);
    f.state.onRead = null; f.state.accounts[0].profileId = profileId; f.db.prepare("UPDATE projects SET zernio_profile_id='changed-profile' WHERE id='project-a'").run(); assert.equal((await f.read()).status, 409);
  } finally { f.db.close(); }
});

test('provider update UI presents typed evidence and ignores responses from departed project/account views', async () => {
  const source = await readFile(new URL('../src/ZernioAdEvents.tsx', import.meta.url), 'utf8'), preview = source.slice(source.indexOf('const names:'), source.indexOf('export default function'));
  const { code } = await transformWithOxc(preview, 'AdEventEvidence.tsx', { jsx: { runtime: 'classic' } }); const Evidence = new Function('React', `${code}; return Evidence;`)(React);
  const html = renderToStaticMarkup(React.createElement(Evidence, { row: { adObject: { level: 'AD', platformId: '701' }, status: { raw: '<script>bad()</script>' }, error: { code: '10' } } })); assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/);
  const helper = stripTypeScriptTypes(source.slice(source.indexOf('  async function load('), source.indexOf('  return <section'))), resolvers = [], accepted = [];
  const context = { requester: { current: () => new Promise(resolve => resolvers.push(resolve)) }, path: '/projects/a/integrations/ads/events', accountId: 'meta-a', adAccountId: 'act_123', query: '?accountId=meta-a&adAccountId=act_123', pagination: null, current: () => false, setAdvertisers: row => accepted.push(row), setUpdates: row => accepted.push(row), setHealth: row => accepted.push(row), setPagination: row => accepted.push(row), setConfigured: row => accepted.push(row), setCheckedAt: row => accepted.push(row) };
  const load = new Function(...Object.keys(context), `return (${helper});`)(...Object.values(context)), pending = load(false); resolvers.forEach(resolve => resolve({ accounts: [], updates: [], health: {}, pagination: { hasMore: false } })); await pending; assert.equal(accepted.length, 0);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|window\.confirm|JSON\.parse/); assert.match(source, /Notifications do not change campaigns/);
});

test('provider update history rejects stale or malformed native membership, including a stale final access recheck', async () => {
  const f = fixture();
  try {
    deliver(f.service, event()); f.service.processPending();
    f.state.freshness = { stale: true, cachedAt: '2026-10-01T10:00:00Z' }; let result = await f.read(); assert.equal(result.status, 503); assert.equal(result.data.error.code, 'AD_ACCOUNT_MEMBERSHIP_STALE'); assert.equal(result.data.updates, undefined);
    assert.equal((await f.read('ad-accounts', '?accountId=meta-a')).status, 503);
    for (const freshness of [{ stale: 'false' }, { stale: false, cachedAt: '2026-02-30T10:00:00Z' }]) { f.state.freshness = freshness; assert.equal((await f.read()).status, 502); }
    f.state.freshness = { stale: false, cachedAt: '2026-10-18T10:00:00Z' }; let reads = 0; f.state.onRead = path => { if (path === '/ads/accounts' && ++reads === 2) f.state.freshness.stale = true; };
    result = await f.read(); assert.equal(result.status, 503); assert.equal(result.data.updates, undefined); assert.equal(reads, 2);
  } finally { f.db.close(); }
});

test('signed paid-ad HTTP delivery is minimized before acknowledgement and authenticated history stays project scoped', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-ad-events-')), originalFetch = globalThis.fetch, upstream = fixture(), app = createApp({ dataDir, appUrl: 'https://ad-events.example.test', env: { ZERNIO_API_KEY: 'synthetic-ad-events-key', ZERNIO_WEBHOOK_SECRET: secret }, directScheduler: false }); let origin, cookie;
  globalThis.fetch = async (target, options = {}) => { const url = new URL(target); if (url.origin === origin) return originalFetch(target, options); assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.method, 'GET'); return Response.json(await upstream.api(url.pathname.slice('/api/v1'.length), Object.fromEntries([...url.searchParams].map(([key, value]) => [key, value === 'true' ? true : value])))); };
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${app.server.address().port}`;
    const request = async (path, body, authenticated = true, method = body ? 'POST' : 'GET') => { const result = await originalFetch(origin + '/api' + path, { method, headers: { Origin: 'https://ad-events.example.test', ...(authenticated && cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); const next = result.headers.get('set-cookie'); if (next) cookie = next.split(';')[0]; return { status: result.status, data: await result.json() }; };
    const setup = await request('/auth/setup', { token: app.config.bootstrapToken, name: 'Paid event owner', email: 'ad-events@example.test', password: 'Synthetic paid event passphrase 2026!', sample: false }); assert.equal(setup.status, 201); const projectId = setup.data.projectId; app.db.prepare('UPDATE projects SET zernio_profile_id=? WHERE id=?').run(profileId, projectId);
    const payload = event(), raw = JSON.stringify(payload), url = origin + '/api/webhooks/zernio'; assert.equal((await originalFetch(url, { method: 'POST', body: raw })).status, 401);
    let result = await originalFetch(url, { method: 'POST', headers: { 'x-zernio-signature': sign(raw) }, body: raw }); assert.equal(result.status, 202); assert.doesNotMatch(app.db.prepare('SELECT payload FROM webhook_events WHERE id=?').get(payload.id).payload, /PRIVATE_/); app.webhooks.processPending();
    const path = `/projects/${projectId}/integrations/ads/events`; assert.equal((await request(path + '?accountId=meta-a&adAccountId=act_123', undefined, false)).status, 401);
    let page = await request(path + '?accountId=meta-a&adAccountId=act_123'); assert.equal(page.status, 200, JSON.stringify(page.data)); assert.equal(page.data.updates[0].id, payload.id); assert.equal(page.data.webhookConfigured, true);
    app.db.prepare("UPDATE memberships SET role='viewer'").run(); assert.equal((await request(path + '?accountId=meta-a&adAccountId=act_123')).status, 200); assert.equal((await request(path, { accountId: 'meta-a' })).status, 403);
    assert.equal((await request(path + '?accountId=meta-a&adAccountId=act_999')).status, 403); assert.equal((await request(path + '?accountId=foreign-account')).status, 403);
    result = await originalFetch(url, { method: 'POST', headers: { 'x-zernio-signature': sign(raw) }, body: raw }); assert.equal(result.status, 200); assert.equal(app.db.prepare('SELECT count(*) AS n FROM webhook_ad_updates').get().n, 1);
    app.db.prepare('UPDATE projects SET zernio_profile_id=? WHERE id=?').run('temporarily-unmapped', projectId);
    const earlier = event(), later = event('ad.video.processed'), send = async payload => { const raw = JSON.stringify(payload); return originalFetch(url, { method: 'POST', headers: { 'x-zernio-signature': sign(raw) }, body: raw }); };
    assert.equal((await send(earlier)).status, 202); assert.deepEqual(app.webhooks.processPending(), { processed: 0, pending: 1 }); app.db.prepare('UPDATE projects SET zernio_profile_id=? WHERE id=?').run(profileId, projectId);
    assert.equal((await send(later)).status, 202); assert.deepEqual(app.webhooks.processPending(), { processed: 1, pending: 0 }); assert.deepEqual(app.webhooks.processPending({ now: Date.now() + 61000 }), { processed: 1, pending: 0 });
    page = await request(path + '?accountId=meta-a&adAccountId=act_123&limit=1'); assert.equal(page.status, 200); assert.equal(page.data.updates[0].id, later.id);
    page = await request(path + '?accountId=meta-a&adAccountId=act_123&limit=1&before=' + page.data.pagination.before); assert.equal(page.status, 200); assert.equal(page.data.updates[0].id, earlier.id); assert.equal(page.data.pagination.hasMore, true);
    upstream.state.freshness = { stale: true, cachedAt: '2026-10-01T10:00:00Z' }; page = await request(path + '?accountId=meta-a&adAccountId=act_123'); assert.equal(page.status, 503); assert.equal(page.data.error.code, 'AD_ACCOUNT_MEMBERSHIP_STALE'); assert.equal(page.data.updates, undefined); upstream.state.freshness = { stale: false, cachedAt: null };
    app.db.prepare('UPDATE projects SET zernio_profile_id=? WHERE id=?').run('different-profile', projectId); upstream.state.accounts[0].profileId = 'different-profile'; page = await request(path + '?accountId=meta-a&adAccountId=act_123'); assert.equal(page.status, 200); assert.equal(page.data.updates.length, 0);
  } finally { globalThis.fetch = originalFetch; await app.close(); upstream.db.close(); assert.ok(resolve(dataDir).startsWith(resolve(tmpdir()) + sep)); await rm(dataDir, { recursive: true, force: true }); }
});
