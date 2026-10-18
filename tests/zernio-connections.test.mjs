import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { handleZernioConnections } from '../server/zernio-connections.mjs';
import { handleIntegration, IntegrationError } from '../server/integrations.mjs';

const profileId = 'profile-a';
function setup() {
  const db = new DatabaseSync(':memory:'), calls = [], state = { accounts: [], malformed: false, receipt: null, failure: null, status: 'pending', authUrl: 'https://provider.example.test/authorize' };
  const api = async (path, query = {}, body, key, method = body === undefined ? 'GET' : 'POST') => {
    calls.push({ path, query, body: structuredClone(body), key, method });
    if (path === '/accounts') { assert.deepEqual(query, { profileId }); return { accounts: state.accounts }; }
    if (path === '/users') return { currentUserId: 'api-user', users: [{ email: 'private@example.test' }] };
    if (path === '/connect/telegram' && method === 'GET') return { code: 'ZRN-ABC123', botUsername: 'ZernioTestBot', expiresAt: new Date(Date.now() + 15 * 60000).toISOString(), instructions: ['Add the bot as an administrator.', 'Send the code with your channel name.'] };
    if (path === '/connect/telegram' && method === 'PATCH') return { status: state.status, ...(state.status === 'connected' ? { account: { _id: 'telegram-a', platform: 'telegram' } } : {}) };
    if (method === 'GET') return { authUrl: state.authUrl };
    if (state.failure) throw state.failure;
    const platform = path.includes('bluesky') ? 'bluesky' : path.includes('wordpress') ? 'wordpress' : path.includes('shopify') ? 'shopify' : path.includes('whop') ? 'whopads' : 'telegram';
    const row = { _id: platform + '-a', platform, profileId, username: platform === 'bluesky' ? body.identifier : platform === 'wordpress' ? new URL(body.siteUrl).hostname : platform === 'shopify' ? body.shop : platform === 'telegram' ? body.chatId.replace('@', '') : 'whop-brand', displayName: 'Campaign brand', isActive: true };
    state.accounts = [row]; return state.malformed ? {} : state.receipt || { account: { ...row, secret: 'never-return' }, ...(platform === 'whopads' ? { accountId: row._id } : {}) };
  };
  let count = 0;
  async function request(action, { body, role = 'owner', key = `connection-key-${++count}`, query = '' } = {}) {
    let response; const context = { db, project: { id: 'project-a', zernioProfileId: profileId }, role, req: { method: action.endsWith('/oauth') ? 'GET' : 'POST', headers: { 'idempotency-key': key } }, url: new URL(`https://campaign.example.test/api/projects/project-a/integrations/connections/${action}${query}`), body: body || {}, config: { appUrl: 'https://campaign.example.test' }, send(status, data) { response = { status, data }; } };
    try { await handleZernioConnections(context, api, profileId, action); return response; } catch (error) { if (!(error instanceof IntegrationError)) throw error; return { status: error.status, data: { error: { code: error.code, message: error.message } } }; }
  }
  return { db, calls, state, request };
}

test('credential connections derive profile/state server-side, verify returned identity and never return secrets', async () => {
  const { db, calls, request } = setup();
  try {
    for (const [platform, body, upstream] of [
      ['bluesky', { identifier: 'brand.bsky.social', appPassword: 'fixture-app-password' }, '/connect/bluesky/credentials'],
      ['wordpress', { siteUrl: 'https://brand.example.test/blog', username: 'editor', applicationPassword: 'fixture application password' }, '/connect/wordpress/token'],
      ['shopify', { shop: 'Brand-Shop.myshopify.com', accessToken: 'fixture-admin-token' }, '/connect/shopify/token'],
      ['whop', { apiKey: 'fixture-whop-key' }, '/connect/whop-ads/credentials'],
      ['telegram', { chatId: '@brandchannel' }, '/connect/telegram'],
    ]) {
      const key = 'connect-' + platform, result = await request(platform + '/credentials', { body, key }); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.operation.status, 'complete'); assert.equal(JSON.stringify(result).includes('never-return'), false);
      const call = calls.findLast(row => row.path === upstream); assert.ok(call); assert.equal(call.key, key);
      if (platform === 'bluesky') { assert.equal(call.body.state, 'api-user-profile-a'); assert.equal(call.body.profileId, undefined); } else assert.equal(call.body.profileId, profileId);
      if (platform === 'shopify') assert.equal(call.body.shop, 'brand-shop.myshopify.com');
      const before = calls.length; assert.deepEqual(await request(platform + '/credentials', { body, key }), result); assert.equal(calls.length, before);
    }
    for (const role of ['editor', 'viewer']) { const before = calls.length; assert.equal((await request('bluesky/credentials', { body: { identifier: 'brand.bsky.social', appPassword: 'fixture' }, role })).status, 403); assert.equal(calls.length, before); }
    assert.equal((await request('bluesky/credentials', { body: { identifier: 'brand.bsky.social', appPassword: 'fixture', profileId: 'outside' } })).status, 400);
    for (const siteUrl of ['http://brand.example.test', 'https://127.0.0.1/', 'https://user:password@brand.example.test/', 'https://brand.example.test/?token=hidden']) assert.equal((await request('wordpress/credentials', { body: { siteUrl, username: 'user', applicationPassword: 'fixture' } })).status, 400);
  } finally { db.close(); }
});

test('accepted malformed or contradictory connections stay uncertain and changed credentials cannot bypass review', async () => {
  for (const receipt of [{}, { account: { _id: 'bluesky-a', platform: 'facebook' } }, { account: { _id: 'outside', platform: 'bluesky' } }, { account: { _id: 'bluesky-a', platform: 'bluesky', profileId: 'outside' } }]) {
    const { db, calls, state, request } = setup();
    try {
      state.receipt = receipt; const result = await request('bluesky/credentials', { body: { identifier: 'brand.bsky.social', appPassword: 'fixture' } }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain');
      const writes = calls.filter(row => row.method === 'POST').length;
      assert.equal((await request('bluesky/credentials', { body: { identifier: 'brand.bsky.social', appPassword: 'replacement-fixture' } })).status, 409); assert.equal(calls.filter(row => row.method === 'POST').length, writes);
    } finally { db.close(); }
  }
});

test('provider credential errors cannot echo passwords into application receipts', async () => {
  const { db, state, request } = setup();
  try { state.failure = new IntegrationError(401, 'INVALID_CREDENTIALS', 'Rejected fixture-secret-password'); const result = await request('bluesky/credentials', { body: { identifier: 'brand.bsky.social', appPassword: 'fixture-secret-password' } }); assert.equal(result.status, 401); assert.equal(JSON.stringify(result).includes('fixture-secret-password'), false); assert.equal(db.prepare('SELECT response FROM integration_operations').get().response.includes('fixture-secret-password'), false); }
  finally { db.close(); }
});

test('store OAuth validates domains/callback URLs and exposes only a fresh secure handoff', async () => {
  const { db, calls, state, request } = setup();
  try {
    assert.equal((await request('shopify/oauth', { query: '?shop=brand-shop' })).status, 200); assert.equal(calls.at(-1).query.shop, 'brand-shop.myshopify.com'); assert.equal(new URL(calls.at(-1).query.redirect_url).searchParams.get('project'), 'project-a');
    for (const shop of ['https://brand.myshopify.com', 'brand.example.com', 'brand/path', '-bad']) assert.equal((await request('shopify/oauth', { query: '?shop=' + encodeURIComponent(shop) })).status, 400);
    for (const authUrl of ['http://provider.example.test', 'javascript:alert(1)', 'https://user:secret@provider.example.test']) { state.authUrl = authUrl; assert.equal((await request('wordpress/oauth')).status, 502); }
  } finally { db.close(); }
});

test('Telegram access codes are bound to a project/profile and connected status requires a scoped account readback', async () => {
  const { db, calls, state, request } = setup();
  try {
    const result = await request('telegram/code', { body: {} }); assert.equal(result.status, 200); assert.equal(result.data.code, 'ZRN-ABC123');
    const before = calls.length; assert.equal((await request('telegram/status', { body: { code: 'ZRN-FOREIGN' } })).status, 403); assert.equal(calls.length, before);
    assert.equal((await request('telegram/status', { body: { code: result.data.code } })).data.status, 'pending'); state.status = 'connected';
    assert.equal((await request('telegram/status', { body: { code: result.data.code } })).status, 502);
    state.accounts = [{ _id: 'telegram-a', platform: 'telegram', profileId, isActive: true }]; const confirmed = await request('telegram/status', { body: { code: result.data.code } }); assert.equal(confirmed.data.account.accountId, 'telegram-a');
    db.prepare('UPDATE integration_telegram_codes SET profile_id=?').run('outside'); assert.equal((await request('telegram/status', { body: { code: result.data.code } })).status, 403);
    db.prepare('UPDATE integration_telegram_codes SET profile_id=?,expires_at=?').run(profileId, '2020-01-01'); const count = calls.length; assert.equal((await request('telegram/status', { body: { code: result.data.code } })).data.status, 'expired'); assert.equal(calls.length, count);
  } finally { db.close(); }
});

test('connection UI retains write identity after gateway/pending responses and ignores obsolete views', async () => {
  const source = await readFile(new URL('../src/ZernioConnection.tsx', import.meta.url), 'utf8'), start = source.indexOf('async function write('), code = stripTypeScriptTypes(source.slice(start, source.indexOf('  async function connect(', start)));
  const keys = { current: new Map() }, calls = []; let current = true, failure = Object.assign(new Error('Gateway'), { status: 502 });
  const context = { current: () => current, canManage: true, keys, crypto: { randomUUID: () => 'retained-key' }, requester: { current: async (...args) => { calls.push(args); throw failure; } } };
  const write = new Function(...Object.keys(context), `return (${code});`)(...Object.values(context));
  for (const next of [failure, Object.assign(new Error('Pending'), { status: 409, code: 'OPERATION_PENDING' }), Object.assign(new Error('Pending'), { status: 409, operation: { status: 'pending' } })]) { failure = next; await assert.rejects(write('/connections/bluesky/credentials', { identifier: 'brand', appPassword: 'fixture' })); }
  assert.equal(keys.current.size, 1); assert.equal(new Set(calls.map(row => row[3])).size, 1); current = false; await assert.rejects(write('/connections/bluesky/credentials', {}), { name: 'AbortError' }); assert.equal(calls.length, 3);
});

test('credential connection dispatch uses authenticated mapped-profile integration routing', async () => {
  const db = new DatabaseSync(':memory:'), previous = globalThis.fetch, calls = []; let response;
  try {
    globalThis.fetch = async (target, options = {}) => { const url = new URL(target); calls.push({ url, options }); assert.equal(options.headers.Authorization, 'Bearer synthetic-key'); const body = options.body && JSON.parse(options.body); return new Response(JSON.stringify(url.pathname.endsWith('/users') ? { currentUserId: 'api-user' } : url.pathname.endsWith('/accounts') ? { accounts: [{ _id: 'blue-a', platform: 'bluesky', username: 'brand.bsky.social', profileId, isActive: true }] } : { account: { _id: 'blue-a', platform: 'bluesky', username: body.identifier } })); };
    await handleIntegration({ db, req: { method: 'POST', headers: { 'idempotency-key': 'router-connection' } }, url: new URL('https://campaign.example.test/api/projects/project-a/integrations/connections/bluesky/credentials'), project: { id: 'project-a', zernioProfileId: profileId }, config: { env: { ZERNIO_API_KEY: 'synthetic-key' } }, role: 'owner', body: { identifier: 'brand.bsky.social', appPassword: 'fixture' }, send(status, data) { response = { status, data }; } });
    assert.equal(response.status, 200); assert.equal(response.data.account.accountId, 'blue-a'); assert.equal(calls[0].url.pathname, '/api/v1/users');
  } finally { globalThis.fetch = previous; db.close(); }
});
