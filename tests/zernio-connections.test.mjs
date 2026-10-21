import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import * as design from '@ten98/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { handleZernioConnections } from '../server/zernio-connections.ts';
import { handleIntegration } from '../server/integrations.ts';
import { IntegrationError } from '../server/provider-core.ts';
import { postgresSkip, testDatabase } from './postgres.mjs';

const pg = { skip: postgresSkip };
const profileId = 'profile-a';
async function setup(t) {
  const { db, sql } = await testDatabase(t), calls = [], state = { accounts: [], accountActivity: true, malformed: false, receipt: null, failure: null, status: 'pending', authUrl: 'https://provider.example.test/authorize' };
  const api = async (path, query = {}, body, key, method = body === undefined ? 'GET' : 'POST') => {
    calls.push({ path, query, body: structuredClone(body), key, method });
    if (path === '/accounts') { assert.deepEqual(query, { profileId }); return { accounts: state.accounts }; }
    if (path === '/users') return { currentUserId: 'api-user', users: [{ email: 'private@example.test' }] };
    if (path === '/connect/telegram' && method === 'GET') return { code: 'ZRN-ABC123', botUsername: 'ZernioTestBot', expiresAt: new Date(Date.now() + 15 * 60000).toISOString(), instructions: ['Add the bot as an administrator.', 'Send the code with your channel name.'] };
    if (path === '/connect/telegram' && method === 'PATCH') return { status: state.status, ...(state.status === 'connected' ? { account: { _id: 'telegram-a', platform: 'telegram' } } : {}) };
    if (method === 'GET') return { authUrl: state.authUrl };
    if (state.failure) throw state.failure;
    const platform = path.includes('bluesky') ? 'bluesky' : path.includes('wordpress') ? 'wordpress' : path.includes('shopify') ? 'shopify' : path.includes('whop') ? 'whopads' : 'telegram';
    const row = { _id: platform + '-a', platform, profileId, username: platform === 'bluesky' ? body.identifier : platform === 'wordpress' ? new URL(body.siteUrl).hostname : platform === 'shopify' ? body.shop : platform === 'telegram' ? body.chatId.replace('@', '') : 'whop-brand', displayName: 'Campaign brand', ...(state.accountActivity === undefined ? {} : { isActive: state.accountActivity }) };
    state.accounts = [row]; return state.malformed ? {} : state.receipt || { account: { ...row, secret: 'never-return' }, ...(platform === 'whopads' ? { accountId: row._id } : {}) };
  };
  let count = 0;
  async function request(action, { body, role = 'owner', key = `connection-key-${++count}`, query = '' } = {}) {
    let response; const context = { db, project: { id: 'project-a', zernioProfileId: profileId }, role, req: { method: action.endsWith('/oauth') ? 'GET' : 'POST', headers: { 'idempotency-key': key } }, url: new URL(`https://campaign.example.test/api/projects/project-a/integrations/connections/${action}${query}`), body: body || {}, config: { appUrl: 'https://campaign.example.test' }, send(status, data) { response = { status, data }; } };
    try { await handleZernioConnections(context, api, profileId, action); return response; } catch (error) { if (!(error instanceof IntegrationError)) throw error; return { status: error.status, data: { error: { code: error.code, message: error.message } } }; }
  }
  return { db, sql, calls, state, request };
}

test('credential connections derive profile/state server-side, verify returned identity and never return secrets', pg, async t => {
  const { calls, request } = await setup(t);
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
});

test('accepted malformed or contradictory connections stay uncertain and changed credentials cannot bypass review', pg, async t => {
  for (const receipt of [{}, { account: { _id: 'bluesky-a', platform: 'facebook' } }, { account: { _id: 'outside', platform: 'bluesky' } }, { account: { _id: 'bluesky-a', platform: 'bluesky', profileId: 'outside' } }]) {
    const { calls, state, request } = await setup(t);
    state.receipt = receipt; const result = await request('bluesky/credentials', { body: { identifier: 'brand.bsky.social', appPassword: 'fixture' } }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain');
    const writes = calls.filter(row => row.method === 'POST').length;
    assert.equal((await request('bluesky/credentials', { body: { identifier: 'brand.bsky.social', appPassword: 'replacement-fixture' } })).status, 409); assert.equal(calls.filter(row => row.method === 'POST').length, writes);
  }
});

test('provider credential errors cannot echo passwords into application receipts', pg, async t => {
  const { sql, state, request } = await setup(t);
  state.failure = new IntegrationError(401, 'INVALID_CREDENTIALS', 'Rejected fixture-secret-password'); const result = await request('bluesky/credentials', { body: { identifier: 'brand.bsky.social', appPassword: 'fixture-secret-password' } }); assert.equal(result.status, 401); assert.equal(JSON.stringify(result).includes('fixture-secret-password'), false); assert.equal((await sql.get('SELECT response FROM integration_operations')).response.includes('fixture-secret-password'), false);
});

test('store OAuth validates domains/callback URLs and exposes only a fresh secure handoff', pg, async t => {
  const { calls, state, request } = await setup(t);
  assert.equal((await request('shopify/oauth', { query: '?shop=brand-shop' })).status, 200); assert.equal(calls.at(-1).query.shop, 'brand-shop.myshopify.com'); assert.equal(new URL(calls.at(-1).query.redirect_url).searchParams.get('project'), 'project-a');
  for (const shop of ['https://brand.myshopify.com', 'brand.example.com', 'brand/path', '-bad']) assert.equal((await request('shopify/oauth', { query: '?shop=' + encodeURIComponent(shop) })).status, 400);
  for (const authUrl of ['http://provider.example.test', 'javascript:alert(1)', 'https://user:secret@provider.example.test']) { state.authUrl = authUrl; assert.equal((await request('wordpress/oauth')).status, 502); }
});

test('Telegram access codes are bound to a project/profile and connected status requires a scoped account readback', pg, async t => {
  const { sql, calls, state, request } = await setup(t);
  const result = await request('telegram/code', { body: {} }); assert.equal(result.status, 200); assert.equal(result.data.code, 'ZRN-ABC123');
  const before = calls.length; assert.equal((await request('telegram/status', { body: { code: 'ZRN-FOREIGN' } })).status, 403); assert.equal(calls.length, before);
  assert.equal((await request('telegram/status', { body: { code: result.data.code } })).data.status, 'pending'); state.status = 'connected';
  assert.equal((await request('telegram/status', { body: { code: result.data.code } })).status, 502);
  state.accounts = [{ _id: 'telegram-a', platform: 'telegram', profileId, isActive: true }]; const confirmed = await request('telegram/status', { body: { code: result.data.code } }); assert.equal(confirmed.data.account.accountId, 'telegram-a');
  await sql.run('UPDATE integration_telegram_codes SET profile_id=?', 'outside'); assert.equal((await request('telegram/status', { body: { code: result.data.code } })).status, 403);
  await sql.run('UPDATE integration_telegram_codes SET profile_id=?,expires_at=?', profileId, '2020-01-01'); const count = calls.length; assert.equal((await request('telegram/status', { body: { code: result.data.code } })).data.status, 'expired'); assert.equal(calls.length, count);
});

test('Telegram direct and code confirmation require positive scoped account activity', pg, async t => {
  for (const flow of ['direct', 'code']) for (const activity of [undefined, null, true]) {
    const { calls, state, request } = await setup(t), valid = activity === true;
    state.accountActivity = activity;
    const body = flow === 'direct' ? { chatId: '@brandchannel' } : { code: (await request('telegram/code', { body: {} })).data.code };
    if (flow === 'code') { state.status = 'connected'; state.accounts = [{ _id: 'telegram-a', platform: 'telegram', profileId, ...(activity === undefined ? {} : { isActive: activity }) }]; }
    const route = flow === 'direct' ? 'telegram/credentials' : 'telegram/status', key = 'telegram-activity-proof';
    const result = await request(route, { body, key });
    assert.equal(result.status, valid ? 200 : flow === 'direct' ? 409 : 502, flow + '/' + String(activity));
    assert.equal(result.data.account?.accountId, valid ? 'telegram-a' : undefined);
    if (flow === 'direct') {
      assert.equal(result.data.operation.status, valid ? 'complete' : 'uncertain');
      const beforeReplay = calls.length; state.accountActivity = true;
      assert.equal((await request(route, { body, key })).status, valid ? 200 : 409);
      assert.equal(calls.length, beforeReplay, 'A dispatched ambiguous connection cannot send again or become confirmed on replay.');
      assert.equal(calls.filter(row => row.path === '/connect/telegram' && row.method === 'POST').length, 1);
    } else {
      state.accounts[0].isActive = true;
      assert.equal((await request(route, { body })).data.account.accountId, 'telegram-a', 'A status poll may confirm after positive activity becomes readable.');
      assert.equal(calls.filter(row => row.path === '/connect/telegram' && row.method === 'POST').length, 0, 'Code status confirmation never reconnects the account.');
    }
  }
});

test('connection UI retains write identity after gateway/pending responses and ignores obsolete views', async () => {
  const source = await readFile(new URL('../src/ZernioConnection.tsx', import.meta.url), 'utf8'), start = source.indexOf('async function write('), code = stripTypeScriptTypes(source.slice(start, source.indexOf('  async function connect(', start)));
  const keys = { current: new Map() }, calls = []; let current = true, failure = Object.assign(new Error('Gateway'), { status: 502 });
  const context = { current: () => current, canManage: true, keys, crypto: { randomUUID: () => 'retained-key' }, requester: { current: async (...args) => { calls.push(args); throw failure; } } };
  const write = new Function(...Object.keys(context), `return (${code});`)(...Object.values(context));
  for (const next of [failure, Object.assign(new Error('Pending'), { status: 409, code: 'OPERATION_PENDING' }), Object.assign(new Error('Pending'), { status: 409, operation: { status: 'pending' } })]) { failure = next; await assert.rejects(write('/connections/bluesky/credentials', { identifier: 'brand', appPassword: 'fixture' })); }
  assert.equal(keys.current.size, 1); assert.equal(new Set(calls.map(row => row[3])).size, 1); current = false; await assert.rejects(write('/connections/bluesky/credentials', {}), { name: 'AbortError' }); assert.equal(calls.length, 3);
});

test('credential connection dispatch uses authenticated mapped-profile integration routing', pg, async t => {
  const { db, pool } = await testDatabase(t), previous = globalThis.fetch, calls = []; let response;
  await pool.query(`INSERT INTO workspaces (id, name) VALUES ('w', 'W'); INSERT INTO projects (id, workspace_id, name, zernio_profile_id) VALUES ('project-a', 'w', 'Project A', '${profileId}')`);
  try {
    globalThis.fetch = async (target, options = {}) => { const url = new URL(target); calls.push({ url, options }); assert.equal(options.headers.Authorization, 'Bearer synthetic-key'); const body = options.body && JSON.parse(options.body); return new Response(JSON.stringify(url.pathname.endsWith('/users') ? { currentUserId: 'api-user' } : url.pathname.endsWith('/accounts') ? { accounts: [{ _id: 'blue-a', platform: 'bluesky', username: 'brand.bsky.social', profileId, isActive: true }] } : { account: { _id: 'blue-a', platform: 'bluesky', username: body.identifier } })); };
    const dispatch = () => handleIntegration({ db, req: { method: 'POST', headers: { 'idempotency-key': 'router-connection' } }, url: new URL('https://campaign.example.test/api/projects/project-a/integrations/connections/bluesky/credentials'), project: { id: 'project-a', zernioProfileId: profileId }, config: { env: { ZERNIO_API_KEY: 'synthetic-key' } }, role: 'owner', body: { identifier: 'brand.bsky.social', appPassword: 'fixture' }, send(status, data) { response = { status, data }; } });
    await dispatch();
    assert.equal(response.status, 200); assert.equal(response.data.account.accountId, 'blue-a'); assert.equal(calls[0].url.pathname, '/api/v1/users');
    // A same-key retry replays the receipt: exactly one credential request reached the provider transport.
    const before = calls.length; await dispatch(); assert.equal(response.status, 200); assert.equal(calls.length, before);
    assert.equal(calls.filter(call => call.url.pathname === '/api/v1/connect/bluesky/credentials').length, 1);
  } finally { globalThis.fetch = previous; }
});

const connectionSource = await readFile(new URL('../src/ZernioConnection.tsx', import.meta.url), 'utf8');
const { code: connectionCode } = await transformWithOxc(connectionSource.replace(/^import .+;\r?\n/gm, '').replace('export default function ', 'function '), 'ConnectionInteraction.tsx', { jsx: { runtime: 'classic' } });
const nodes = node => !React.isValidElement(node) ? [] : [node, ...React.Children.toArray(node.props.children).flatMap(nodes)];
const nodeText = node => !React.isValidElement(node) ? String(node ?? '') : React.Children.toArray(node.props.children).map(nodeText).join('');
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const postingAccounts = [{ _id: 'x-a', platform: 'twitter', displayName: 'Posting A' }, { _id: 'x-b', platform: 'twitter', displayName: 'Posting B' }];

// Run the complete JSX and its real event handlers at the mocked request boundary.
async function connectionUi(respond = async path => path.endsWith('/accounts') ? { accounts: postingAccounts } : { authUrl: 'https://provider.example.test/authorize?target=' + encodeURIComponent(path) }) {
  const hooks = [], queued = [], calls = []; let cursor = 0, dirty = true, tree, unmounted = false, postUnmountUpdates = 0, connected = 0, props = {}, values = {};
  const state = initial => { const index = cursor++; if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, value => { if (unmounted) postUnmountUpdates++; const next = typeof value === 'function' ? value(hooks[index].value) : value; if (!Object.is(next, hooks[index].value)) { hooks[index].value = next; dirty = true; } }]; };
  const ref = initial => { const index = cursor++; return hooks[index] ||= { current: initial }; };
  const effect = (run, dependencies) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) { hooks[index] = { dependencies, close: old?.close }; queued.push(() => { hooks[index].close?.(); hooks[index].close = run(); }); } };
  const request = async (...args) => { calls.push(args); return respond(...args); };
  const Component = new Function('React', 'useState', 'useRef', 'useEffect', 'FormData', ...Object.keys(design), connectionCode + ';return ZernioConnection;')(React, state, ref, effect, class { constructor(form) { return Object.entries(form.values); } }, ...Object.values(design));
  function paint() { if (unmounted) return; for (let pass = 0; dirty; pass++) { assert.ok(pass < 25, 'Rendering settles.'); dirty = false; cursor = 0; tree = Component({ projectId: 'project-a', canManage: true, request, onConnected() { connected++; }, onCancel() {}, ...props }); while (queued.length) queued.shift()(); } }
  const tick = async () => { await new Promise(resolve => setImmediate(resolve)); paint(); };
  const form = () => nodes(tree).find(node => node.props?.as === 'form');
  const input = label => { const wrapper = nodes(tree).find(node => node.type === design.Field && node.props.label === label); return nodes(wrapper).find(node => [design.Input, design.Select].includes(node.type)); };
  const button = label => nodes(tree).find(node => node.type === design.Button && nodeText(node) === label);
  const event = (extra = {}) => ({ preventDefault() {}, currentTarget: { values: { ...Object.fromEntries(nodes(tree).filter(node => [design.Input, design.Select].includes(node.type) && node.props.name).map(node => [node.props.name, values[node.props.name] ?? node.props.value ?? node.props.defaultValue ?? ''])), ...extra }, reset() { values = {}; } } });
  const change = async (label, value) => { const field = input(label), parent = form(); assert.ok(field, label); if (label === 'Channel or store') values = {}; if (field.props.name) values[field.props.name] = value; const event = { target: { value, name: field.props.name } }; field.props.onChange?.(event); parent.props.onChange?.(event); paint(); await tick(); };
  const submit = (extra = {}) => { const pending = form().props.onSubmit(event(extra)); paint(); return pending; };
  const click = label => { const control = button(label); assert.ok(control, label); const pending = control.props.onClick(); paint(); return pending; };
  paint(); await tick();
  return { calls, tick, form, event, input, button, change, submit, click, html: () => renderToStaticMarkup(tree), link: () => nodes(tree).find(node => node.type === design.Link && nodeText(node) === 'Continue with provider'), get connected() { return connected; }, get postUnmountUpdates() { return postUnmountUpdates; }, scope: async next => { props = { ...props, ...next }; dirty = true; paint(); await tick(); }, unmount() { hooks.forEach(hook => hook.close?.()); unmounted = true; } };
}

test('connection authorization links remain valid unchanged and disappear immediately when the posting account or Shopify domain changes', async () => {
  const ui = await connectionUi();
  await ui.change('Channel or store', 'ads:twitter'); await ui.change('X posting account *', 'x-a'); await ui.submit(); await ui.tick();
  const original = ui.link().props.href; assert.match(decodeURIComponent(original), /accountId=x-a/); await ui.tick(); assert.equal(ui.link().props.href, original);
  await ui.change('X posting account *', 'x-b'); assert.equal(ui.link(), undefined); assert.doesNotMatch(ui.html(), /Continue with the provider, then return/);
  await ui.submit(); await ui.tick(); assert.match(decodeURIComponent(ui.link().props.href), /accountId=x-b/);
  await ui.change('Channel or store', 'store:shopify'); await ui.change('Store domain *', 'shop-a.myshopify.com'); await ui.submit(); await ui.tick(); assert.ok(decodeURIComponent(ui.link().props.href).includes('shop-a.myshopify.com'));
  await ui.change('Store domain *', 'shop-b.myshopify.com'); assert.equal(ui.link(), undefined); assert.doesNotMatch(ui.html(), /Continue with the provider, then return/);
  await ui.submit(); await ui.tick(); assert.ok(decodeURIComponent(ui.link().props.href).includes('shop-b.myshopify.com'));
});

test('posting-account refresh withdraws the old authorization link before loading, including account removal', async () => {
  let rows = postingAccounts; const refresh = deferred(); let reads = 0;
  const ui = await connectionUi(async path => path.endsWith('/accounts') ? ++reads === 1 ? { accounts: rows } : refresh.promise : { authUrl: 'https://provider.example.test/old-account-a' });
  await ui.change('Channel or store', 'ads:twitter'); await ui.change('X posting account *', 'x-a'); await ui.submit(); await ui.tick(); assert.ok(ui.link());
  ui.click('Refresh posting accounts'); assert.equal(ui.link(), undefined); assert.doesNotMatch(ui.html(), /Continue with the provider, then return/);
  rows = [postingAccounts[1]]; refresh.resolve({ accounts: rows }); await ui.tick(); assert.doesNotMatch(ui.html(), /Posting A/); assert.match(ui.html(), /Posting B/); assert.equal(ui.link(), undefined);
});

test('a replacement authorization attempt clears the old link while pending and after request or URL failure', async () => {
  for (const failure of ['request', 'url']) {
    let next = false; const replacement = deferred();
    const ui = await connectionUi(async path => path.endsWith('/accounts') ? { accounts: postingAccounts } : next ? replacement.promise : { authUrl: 'https://provider.example.test/first' });
    await ui.submit(); await ui.tick(); assert.ok(ui.link()); next = true;
    const pending = ui.submit(); assert.equal(ui.link(), undefined); assert.doesNotMatch(ui.html(), /Continue with the provider, then return/);
    if (failure === 'request') replacement.reject(new Error('Authorization unavailable')); else replacement.resolve({ authUrl: 'http://provider.example.test/unsafe' });
    await pending; await ui.tick(); assert.equal(ui.link(), undefined); assert.match(ui.html(), failure === 'request' ? /Authorization unavailable/ : /authorization URL is invalid/);
  }
});

test('pending authorization results and retained callbacks cannot revive links after target cycles, refresh, scope changes or unmount', async () => {
  for (const transition of ['account', 'shop', 'refresh', 'project', 'role', 'unmount']) {
    const delayed = deferred(); let first = true;
    const ui = await connectionUi(async path => path.endsWith('/accounts') ? { accounts: postingAccounts } : first ? (first = false, delayed.promise) : { authUrl: 'https://provider.example.test/fresh' });
    await ui.change('Channel or store', transition === 'shop' ? 'store:shopify' : 'ads:twitter'); await ui.change(transition === 'shop' ? 'Store domain *' : 'X posting account *', transition === 'shop' ? 'shop-a' : 'x-a');
    const retainedSubmit = ui.form().props.onSubmit, retainedChange = ui.form().props.onChange, retainedRefresh = ui.button('Refresh posting accounts')?.props.onClick, pending = ui.submit();
    if (transition === 'account' || transition === 'shop') { const label = transition === 'shop' ? 'Store domain *' : 'X posting account *'; await ui.change(label, transition === 'shop' ? 'shop-b' : 'x-b'); await ui.change(label, transition === 'shop' ? 'shop-a' : 'x-a'); }
    if (transition === 'refresh') { ui.click('Refresh posting accounts'); await ui.tick(); }
    if (transition === 'project') { await ui.scope({ projectId: 'project-b' }); await ui.scope({ projectId: 'project-a' }); }
    if (transition === 'role') { await ui.scope({ canManage: false }); await ui.scope({ canManage: true }); }
    if (transition === 'unmount') ui.unmount();
    delayed.resolve({ authUrl: 'https://provider.example.test/stale', alreadyConnected: transition === 'account' }); await pending; await ui.tick(); assert.equal(ui.link(), undefined, transition); assert.equal(ui.connected, 0);
    const before = ui.calls.length; await retainedSubmit(ui.event({ accountId: 'x-a', shop: 'shop-a' })); retainedChange?.({ target: { value: 'stale' } }); retainedRefresh?.(); await ui.tick(); assert.equal(ui.calls.length, before, transition);
    if (transition === 'unmount') { assert.equal(ui.postUnmountUpdates, 0); continue; }
    await ui.submit(); await ui.tick(); assert.equal(ui.link().props.href, 'https://provider.example.test/fresh', transition);
  }
});

test('Instagram connection offers both native login methods, submits the documented default and hides the field for other channels', async () => {
  const ui = await connectionUi(), method = ui.input('Instagram connection method');
  assert.equal(method.props.name, 'loginMethod'); assert.equal(method.props.defaultValue, 'instagram_login');
  assert.deepEqual(nodes(method).filter(node => node.type === design.Option).map(node => [node.props.value, nodeText(node)]), [['instagram_login', 'Instagram Login'], ['facebook_login', 'Facebook Login']]);
  assert.match(ui.html(), /professional Instagram account directly, without a Facebook Page/); assert.match(ui.html(), /Facebook Page linked to your professional Instagram account/);
  for (const loginMethod of [undefined, 'facebook_login', 'instagram_login']) {
    if (loginMethod) { await ui.change('Instagram connection method', loginMethod); assert.equal(ui.link(), undefined); }
    await ui.submit(); await ui.tick();
    assert.equal(ui.calls.at(-1)[0], '/projects/project-a/integrations/connect?platform=instagram&kind=social&loginMethod=' + (loginMethod || 'instagram_login'));
    assert.ok(ui.link());
  }
  for (const choice of ['social:facebook', 'ads:facebook', 'credentials:bluesky', 'credentials:telegram', 'store:shopify']) { await ui.change('Channel or store', choice); assert.equal(ui.input('Instagram connection method'), undefined, choice); assert.doesNotMatch(ui.html(), /name="loginMethod"/); }
});

test('Instagram login-method changes reject a pending old handoff across a method cycle', async () => {
  const delayed = deferred(); let first = true;
  const ui = await connectionUi(async path => path.endsWith('/accounts') ? { accounts: postingAccounts } : first ? (first = false, delayed.promise) : { authUrl: 'https://provider.example.test/facebook-login' });
  const pending = ui.submit(); await ui.change('Instagram connection method', 'facebook_login'); await ui.change('Instagram connection method', 'instagram_login');
  delayed.resolve({ authUrl: 'https://provider.example.test/stale-instagram-login' }); await pending; await ui.tick(); assert.equal(ui.link(), undefined);
  await ui.change('Instagram connection method', 'facebook_login'); await ui.submit(); await ui.tick(); assert.equal(ui.link().props.href, 'https://provider.example.test/facebook-login');
  assert.equal(ui.calls.at(-1)[0], '/projects/project-a/integrations/connect?platform=instagram&kind=social&loginMethod=facebook_login');
});
