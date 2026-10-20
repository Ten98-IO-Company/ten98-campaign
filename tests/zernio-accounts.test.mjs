import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { handleZernioAccounts } from '../server/zernio-accounts.ts';
import { handleIntegration } from '../server/integrations.mjs';
import { IntegrationError } from '../server/provider-core.ts';

const profileId = 'profile-a';
const account = (id = 'instagram-a', platform = 'instagram') => ({ _id: id, platform, profileId, isActive: true, displayName: 'Acme', username: '@acme' });
const healthy = row => ({ accountId: row._id, platform: row.platform, status: 'healthy', canPost: true, canFetchAnalytics: true, tokenValid: true, needsReconnect: false, issues: [] });

function whatsappNumberFixture() {
  const state = { row: { ...account('whatsapp/a', 'whatsapp'), platformUserId: 'native-phone', metadata: { phoneNumberId: 'phone-one', wabaId: 'waba-one', qualityRating: 'RED' } }, response: { phone: { display_phone_number: '+1 202 555 0101', verified_name: '<script>name</script>', name_status: 'FUTURE_NAME_STATUS', quality_rating: 'UNKNOWN', messaging_limit_tier: 'FUTURE_TIER', throughput: { level: 'FUTURE_LEVEL', secret: 'never-return' }, status: 'DISCONNECTED', is_official_business_account: false, platform_type: 'CLOUD_API', health_status: { secret: 'never-return' }, secret: 'never-return' }, waba: { name: 'Support', business_verification_status: 'pending', timezone_id: '37', health_status: { secret: 'never-return' } }, secret: 'never-return' }, access: true, mapping: true, credentials: true, accountReads: 0 }, calls = [];
  const api = async (path, query = {}, body, key, method = body === undefined ? 'GET' : 'POST') => {
    calls.push({ path, query, body, key, method });
    if (path === '/accounts') { assert.deepEqual(query, { profileId }); const result = { accounts: state.removed ? [] : [structuredClone(state.row)] }; state.onBoundary?.(`accounts-${++state.accountReads}`); return result; }
    assert.equal(path, '/whatsapp/number-info'); assert.deepEqual(query, { accountId: 'whatsapp/a' }); assert.equal(body, undefined); assert.equal(key, undefined); assert.equal(method, 'GET');
    state.onBoundary?.('number'); if (state.failure) throw state.failure; return structuredClone(state.response);
  };
  async function request({ method = 'GET', body = {}, search = '', accountId = 'whatsapp/a', role = 'viewer' } = {}) {
    let response;
    const context = { project: { id: 'project-a', zernioProfileId: profileId }, role, body, req: { method }, url: new URL(`https://app.example/api/projects/project-a/integrations/accounts/${encodeURIComponent(accountId)}/whatsapp-number-info${search}`), assertProjectMapping(expected) { if (!state.mapping || expected !== profileId) throw Object.assign(new Error('Mapping changed'), { status: 409 }); }, assertIntegrationSettings() { if (!state.access) throw Object.assign(new Error('Access changed'), { status: 403 }); if (!state.credentials) throw Object.assign(new Error('Credentials changed'), { status: 409 }); }, send(status, data) { response = { status, data }; } };
    try { await handleZernioAccounts(context, api, profileId, `${encodeURIComponent(accountId)}/whatsapp-number-info`); return response; }
    catch (error) { if (!(error instanceof IntegrationError)) throw error; return { status: error.status, data: { error: { code: error.code, message: error.message } } }; }
  }
  return { state, calls, request };
}

test('WhatsApp number status reads only scoped native GET scalars and preserves sparse, false and unfamiliar provider values', async () => {
  const { state, calls, request } = whatsappNumberFixture();
  state.row.isActive = false; state.row.needsReconnection = true;
  const loaded = await request(); assert.equal(loaded.status, 200); assert.equal(loaded.data.accountId, state.row._id); assert.equal(loaded.data.platform, 'whatsapp'); assert.ok(Number.isFinite(Date.parse(loaded.data.loadedAt)));
  assert.equal(loaded.data.phone.is_official_business_account, false); assert.equal(loaded.data.phone.quality_rating, 'UNKNOWN'); assert.equal(loaded.data.phone.name_status, 'FUTURE_NAME_STATUS'); assert.equal(loaded.data.phone.messaging_limit_tier, 'FUTURE_TIER'); assert.deepEqual(loaded.data.phone.throughput, { level: 'FUTURE_LEVEL' }); assert.equal(loaded.data.waba.timezone_id, '37'); assert.equal(JSON.stringify(loaded).includes('never-return'), false); assert.equal(loaded.data.operation, undefined);
  assert.deepEqual(calls.map(call => call.path), ['/accounts', '/whatsapp/number-info', '/accounts']); assert.ok(calls.every(call => call.method === 'GET'));
  for (const sparse of [{}, { phone: {} }, { phone: { throughput: {} } }, { waba: null }, { waba: {} }]) { state.response = sparse; const result = await request(); assert.equal(result.status, 200); const { accountId, platform, loadedAt, ...number } = result.data; assert.deepEqual(number, sparse); }
});

test('WhatsApp number status rejects unsupported scope, malformed scalars and provider failures without creating a mutation', async () => {
  const { state, calls, request } = whatsappNumberFixture();
  for (const options of [{ method: 'POST' }, { method: 'PATCH' }, { search: '?accountId=other' }, { search: '?refresh=1' }, { body: { phoneNumberId: 'other' } }]) { const before = calls.length; assert.ok([400, 405].includes((await request(options)).status)); assert.equal(calls.length, before); }
  assert.equal((await request({ accountId: 'outside' })).status, 403); assert.equal(calls.filter(call => call.path === '/whatsapp/number-info').length, 0);
  state.row.platform = 'instagram'; assert.equal((await request()).status, 400); state.row.platform = 'whatsapp';
  const malformed = [null, [], { phone: null }, { phone: [] }, { waba: [] }, { waba: { timezone_id: 37 } }, { phone: { quality_rating: null } }, { phone: { verified_name: 2 } }, { phone: { status: 'x'.repeat(2001) } }, { phone: { is_official_business_account: 'false' } }, { phone: { throughput: null } }, { phone: { throughput: [] } }, { phone: { throughput: { level: false } } }];
  for (const value of malformed) { state.response = value; const result = await request(); assert.equal(result.status, 502, JSON.stringify(value)); assert.equal(result.data.error.code, 'INVALID_PROVIDER_RESPONSE'); assert.equal(result.data.operation, undefined); }
  state.failure = new IntegrationError(429, 'PROVIDER_RATE_LIMIT', 'Retry later'); const unavailable = await request(); assert.equal(unavailable.status, 429); assert.equal(unavailable.data.operation, undefined);
});

test('WhatsApp number status rechecks access at every await and fences changed native identity without fencing refreshed quality metadata', async () => {
  for (const boundary of ['accounts-1', 'number', 'accounts-2']) for (const field of ['access', 'mapping', 'credentials']) {
    const { state, request, calls } = whatsappNumberFixture(); state.onBoundary = point => { if (point === boundary) state[field] = false; };
    const result = await request(); assert.equal(result.status, field === 'access' ? 403 : 409, `${boundary}/${field}`); assert.equal(result.data.phone, undefined); if (boundary === 'accounts-1') assert.equal(calls.length, 1);
  }
  for (const change of [row => { row.platform = 'facebook'; }, row => { row.username = 'new-number'; }, row => { row.platformUserId = 'new-phone'; }, row => { row.isActive = false; }, row => { row.needsReconnection = true; }, row => { row.metadata.phoneNumberId = 'other-phone'; }, row => { row.metadata.wabaId = 'other-waba'; }, row => { row.profileId = 'other-profile'; }, (_row, state) => { state.removed = true; }]) {
    const { state, request } = whatsappNumberFixture(); state.onBoundary = point => { if (point === 'number') change(state.row, state); };
    const result = await request(); assert.ok([403, 409].includes(result.status)); assert.equal(result.data.phone, undefined);
  }
  const { state, request } = whatsappNumberFixture(); state.onBoundary = point => { if (point === 'number') Object.assign(state.row.metadata, { qualityRating: 'GREEN', nameStatus: 'APPROVED', messagingLimitTier: 'TIER_1K', verifiedName: 'Fresh name' }); };
  assert.equal((await request()).status, 200);
});

test('WhatsApp number status real integration transport is authenticated, bodyless and account scoped with no operation or other endpoint', async () => {
  const db = new DatabaseSync(':memory:'), original = globalThis.fetch, row = { ...account('whatsapp/a', 'whatsapp'), metadata: { phoneNumberId: 'phone-one', wabaId: 'waba-one' } }, calls = []; let mode = 'good';
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); calls.push({ url, options }); assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.headers.Authorization, 'Bearer fixture-secret'); assert.equal(options.method, 'GET'); assert.equal(options.body, undefined); assert.equal(options.headers['Idempotency-Key'], undefined);
    if (url.pathname === '/api/v1/accounts') { assert.equal(url.searchParams.get('profileId'), profileId); return Response.json({ accounts: [row] }); }
    assert.equal(url.pathname, '/api/v1/whatsapp/number-info'); assert.deepEqual([...url.searchParams], [['accountId', row._id]]);
    if (mode === 'malformed') return new Response('{not json'); if (mode === 'missing') return new Response('', { status: 404 }); if (mode === 'lost') throw new Error('Unavailable');
    return Response.json({ phone: { quality_rating: 'RED', is_official_business_account: false }, waba: null });
  };
  const invoke = async () => { let response; await handleIntegration({ db, project: { id: 'project-a', zernioProfileId: profileId }, role: 'viewer', req: { method: 'GET', headers: {} }, body: {}, url: new URL('https://app.example/api/projects/project-a/integrations/accounts/whatsapp%2Fa/whatsapp-number-info'), config: { env: { ZERNIO_API_KEY: 'fixture-secret' } }, assertProjectMapping(expected) { assert.equal(expected, profileId); }, assertIntegrationSettings() {}, send(status, data) { response = { status, data }; } }); return response; };
  try {
    const result = await invoke(); assert.equal(result.status, 200); assert.equal(result.data.phone.is_official_business_account, false); assert.equal(result.data.waba, null); assert.equal(result.data.operation, undefined);
    for (const failure of ['malformed', 'missing', 'lost']) { mode = failure; const result = await invoke(); assert.equal(result.status, failure === 'missing' ? 400 : 502); assert.equal(result.data.operation, undefined); assert.equal(result.data.phone, undefined); }
    assert.ok(calls.every(call => call.options.method === 'GET')); assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), []);
  } finally { globalThis.fetch = original; db.close(); }
});

async function whatsappNumberUi(respond, initial = {}) {
  const source = await readFile(new URL('../src/ZernioAccounts.tsx', import.meta.url), 'utf8');
  const { code } = await transformWithOxc(source.replace(/^import .+;\r?\n/gm, '').replace(/export (?:default )?function /g, 'function '), 'WhatsAppNumberInteraction.tsx', { jsx: { runtime: 'classic' } });
  let hooks = [], queued = [], cursor = 0, dirty = true, tree, alive = true, updatesAfterUnmount = 0, props = { projectId: 'project/a', account: { ...account('whatsapp/a', 'whatsapp'), health: null }, canManage: false, ...initial };
  const calls = [], useState = initial => { const index = cursor++; if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, value => { if (!alive) updatesAfterUnmount++; const next = typeof value === 'function' ? value(hooks[index].value) : value; if (!Object.is(next, hooks[index].value)) { hooks[index].value = next; dirty = true; } }]; };
  const useRef = initial => { const index = cursor++; return hooks[index] ||= { current: initial }; };
  const useMemo = (compute, dependencies) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) hooks[index] = { dependencies, value: compute() }; return hooks[index].value; };
  const useEffect = (run, dependencies) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) { hooks[index] = { dependencies, close: old?.close }; queued.push(() => { hooks[index].close?.(); hooks[index].close = run(); }); } };
  const request = async (...args) => { calls.push(args); return respond(...args); };
  const Component = new Function('React', 'useState', 'useRef', 'useEffect', 'useLayoutEffect', 'useMemo', code + ';return WhatsAppNumberStatus;')(React, useState, useRef, useEffect, useEffect, useMemo);
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
  function paint(force = false) { if (!alive) return; dirty ||= force; for (let pass = 0; dirty; pass++) { assert.ok(pass < 20); dirty = false; cursor = 0; tree = Component({ request, ...props }); while (queued.length) queued.shift()(); } }
  const tick = async () => { await new Promise(resolve => setImmediate(resolve)); paint(); };
  const button = () => nodes(tree).find(node => node.type === 'button'), click = () => { const result = button().props.onClick(); paint(); return result; };
  paint(); await tick();
  return { calls, tick, click, button, handler: () => button().props.onClick, html: () => renderToStaticMarkup(tree), scope: value => { props = { ...props, ...value }; paint(true); }, rerender: () => paint(true), unmount: () => { alive = false; for (const hook of hooks) hook?.close?.(); }, updatesAfterUnmount: () => updatesAfterUnmount };
}
const whatsappAppSnapshot = extra => ({ accountId: 'whatsapp/a', platform: 'whatsapp', loadedAt: '2026-10-20T12:00:00Z', phone: { quality_rating: 'UNKNOWN', verified_name: '<script>unsafe</script>', name_status: 'FUTURE_NAME', messaging_limit_tier: 'FUTURE_TIER', throughput: { level: 'FUTURE_LEVEL' }, is_official_business_account: false }, waba: null, ...extra });

test('actual WhatsApp number UI reads explicitly for viewers and renders false, missing and unfamiliar values without readiness claims', async () => {
  const ui = await whatsappNumberUi(async () => whatsappAppSnapshot()); assert.equal(ui.calls.length, 0); await ui.click(); await ui.tick();
  assert.deepEqual(ui.calls, [['/projects/project%2Fa/integrations/accounts/whatsapp%2Fa/whatsapp-number-info']]);
  const html = ui.html(); assert.match(html, /Quality rating<\/dt><dd>UNKNOWN/); assert.match(html, /Official business account<\/dt><dd>No/); assert.match(html, /FUTURE_NAME|FUTURE_TIER|FUTURE_LEVEL/); assert.match(html, /Business verification status<\/dt><dd>Not reported/); assert.match(html, /Display number<\/dt><dd>Not reported/); assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/); assert.doesNotMatch(html, /<script|messages per second|ready to send|can send/i); assert.match(html, /Detailed Meta health signals are not included/); assert.match(html, /Refresh WhatsApp number status/);
  const sparse = await whatsappNumberUi(async () => whatsappAppSnapshot({ phone: {}, waba: {} }), { account: { ...account('whatsapp/a', 'whatsapp'), health: null, isActive: false, needsReconnection: true } }); await sparse.click(); await sparse.tick(); assert.match(sparse.html(), /Quality rating<\/dt><dd>Not reported/); assert.match(sparse.html(), /Official business account<\/dt><dd>Not reported/);
});

test('WhatsApp number UI clears stale refresh evidence, rejects malformed app scope and blocks duplicate or retained callbacks', async () => {
  let failure = false; const ui = await whatsappNumberUi(async () => { if (failure) throw new Error('Read unavailable'); return whatsappAppSnapshot(); });
  const old = ui.handler(); await ui.click(); await ui.tick(); const refresh = ui.handler(); failure = true; const pending = ui.click(); assert.doesNotMatch(ui.html(), /FUTURE_LEVEL/); await pending; await ui.tick(); assert.match(ui.html(), /Read unavailable/); assert.doesNotMatch(ui.html(), /Snapshot loaded|FUTURE_LEVEL/); await old(); await refresh(); assert.equal(ui.calls.length, 2);
  for (const extra of [{ accountId: 'other' }, { platform: 'facebook' }, { loadedAt: null }, { phone: null }, { waba: [] }, { phone: { throughput: { level: 1000 } } }, { phone: { is_official_business_account: null } }]) { const invalid = await whatsappNumberUi(async () => whatsappAppSnapshot(extra)); await invalid.click(); await invalid.tick(); assert.match(invalid.html(), /could not be verified/); assert.doesNotMatch(invalid.html(), /Snapshot loaded|FUTURE_LEVEL/); }
  let release; const held = await whatsappNumberUi(() => new Promise(resolve => { release = resolve; })); const load = held.handler(), loading = held.click(); await load(); assert.equal(held.calls.length, 1); assert.equal(held.button().props.disabled, true); held.rerender(); release(whatsappAppSnapshot()); await loading; await held.tick(); assert.match(held.html(), /FUTURE_LEVEL/);
});

test('WhatsApp number UI rejects pending and retained work across account/project/permission A to B to A, refresh snapshots and unmount', async () => {
  for (const mode of ['account', 'project', 'permission', 'snapshot', 'unmount']) {
    let release; const row = { ...account('whatsapp/a', 'whatsapp'), health: null }, ui = await whatsappNumberUi(() => new Promise(resolve => { release = resolve; }), { account: row }); const retained = ui.handler(), pending = ui.click();
    if (mode === 'account') { ui.scope({ account: { ...row, _id: 'other' } }); ui.scope({ account: row }); }
    if (mode === 'project') { ui.scope({ projectId: 'other' }); ui.scope({ projectId: 'project/a' }); }
    if (mode === 'permission') { ui.scope({ canManage: true }); ui.scope({ canManage: false }); }
    if (mode === 'snapshot') ui.scope({ account: { ...row } });
    if (mode === 'unmount') ui.unmount();
    release(whatsappAppSnapshot()); await pending; await ui.tick(); assert.doesNotMatch(ui.html(), /Snapshot loaded|FUTURE_LEVEL/, mode); await retained(); assert.equal(ui.calls.length, 1, mode); assert.equal(ui.updatesAfterUnmount(), 0);
  }
});

function facebookSubscriptionFixture(db = new DatabaseSync(':memory:')) {
  const calls = [], state = { row: { ...account('facebook-a', 'facebook'), platformUserId: '123456789' }, subscription: { pageId: '123456789', appSubscribed: false, leadgen: false, subscribedFields: ['feed'], warning: 'leadgen is missing' }, roleAllowed: true, mappingAllowed: true, accountReads: 0, subscriptionReads: 0, writes: 0 };
  const api = async (path, query = {}, body, key, method = body === undefined ? 'GET' : 'POST') => {
    calls.push({ path, query, body, key, method });
    if (path === '/accounts') { assert.deepEqual(query, { profileId }); state.onAccounts?.(++state.accountReads); return { accounts: [structuredClone(state.row), { ...structuredClone(state.row), _id: 'facebook-alias' }] }; }
    assert.match(path, /^\/accounts\/facebook-(a|alias)\/webhook-subscription$/); assert.deepEqual(query, {});
    if (method === 'POST') { assert.equal(body, undefined); state.writes++; state.onWrite?.(); if (state.writeFailure) throw state.writeFailure; return state.receipt ?? { ...structuredClone(state.subscription), resubscribed: true }; }
    assert.equal(method, 'GET'); state.onRead?.(++state.subscriptionReads); if (state.readFailure) throw new IntegrationError(502, 'PROVIDER_UNAVAILABLE', 'Read unavailable'); return state.readResponse ?? { ...structuredClone(state.subscription), secret: 'never-return' };
  };
  let sequence = 0;
  const request = async (body, { role = 'owner', accountId = 'facebook-a', key = `facebook-test-${++sequence}`, search = '', projectId = 'project-a', method = body === undefined ? 'GET' : 'POST', task = 'webhook-subscription' } = {}) => {
    let response;
    const context = { db, project: { id: projectId, zernioProfileId: profileId }, role, body: body ?? {}, req: { method, headers: { 'idempotency-key': key } }, url: new URL(`https://app.example/api/projects/${projectId}/integrations/accounts/${accountId}/${task}${search}`), assertProjectMapping(expected) { if (!state.mappingAllowed || expected !== profileId) throw Object.assign(new Error('Mapping changed'), { status: 409 }); }, assertIntegrationSettings() { if (!state.roleAllowed) throw Object.assign(new Error('Role changed'), { status: 403 }); }, send(status, data) { response = { status, data }; } };
    try { await handleZernioAccounts(context, api, profileId, `${accountId}/${task}`); return response; }
    catch (error) { if (!(error instanceof IntegrationError)) throw error; return { status: error.status, data: { error: { code: error.code, message: error.message } } }; }
  };
  return { db, calls, state, request, async reviewed(options) { const snapshot = await request(undefined, options); return request({ expectedVersion: snapshot.data.version, confirmed: true }, options); } };
}

test('Facebook Page subscription reads live scoped status and confirms bodyless native POST against independent actual readback', async () => {
  const { db, calls, state, request } = facebookSubscriptionFixture();
  try {
    state.subscription.subscribedFields = ['feed', 'leadgen', 'feed']; state.subscription.pageId = '000123456789';
    const loaded = await request(undefined, { role: 'viewer' }); assert.equal(loaded.status, 200); assert.equal(loaded.data.pageId, '123456789'); assert.equal(loaded.data.appSubscribed, false); assert.equal(loaded.data.leadgen, false); assert.deepEqual(loaded.data.subscribedFields, ['feed', 'leadgen']); assert.match(loaded.data.version, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(loaded).includes('never-return'), false);
    state.onWrite = () => { Object.assign(state.subscription, { appSubscribed: true, leadgen: true, subscribedFields: ['leadgen', 'feed'], warning: null }); };
    const payload = { expectedVersion: loaded.data.version, confirmed: true }, result = await request(payload, { key: 'facebook-same-key' });
    assert.equal(result.status, 200); assert.equal(result.data.operation.status, 'complete'); assert.equal(result.data.readback, true); assert.equal(result.data.resubscribed, true); assert.equal(result.data.leadgen, true); assert.deepEqual(result.data.subscribedFields, ['feed', 'leadgen']);
    assert.deepEqual(await request(payload, { key: 'facebook-same-key' }), result); assert.equal(state.writes, 1);
    state.onWrite = null; Object.assign(state.subscription, { appSubscribed: false, leadgen: false, subscribedFields: [], warning: 'Not granted' }); state.receipt = { ...state.subscription, resubscribed: false };
    const degraded = await request({ expectedVersion: (await request()).data.version, confirmed: true }); assert.equal(degraded.status, 200); assert.equal(degraded.data.resubscribed, false); assert.equal(degraded.data.appSubscribed, false); assert.equal(degraded.data.leadgen, false); assert.deepEqual(degraded.data.subscribedFields, []);
    assert.ok(calls.filter(row => row.method === 'POST').every(row => row.body === undefined && Object.keys(row.query).length === 0)); assert.equal(calls.some(row => row.path.includes('/pages')), false);
  } finally { db.close(); }
});

test('Facebook subscription rejects unreviewed scope, wrong platforms, malformed live statuses and stale versions without writing', async () => {
  const { db, state, calls, request } = facebookSubscriptionFixture();
  try {
    const payload = { expectedVersion: (await request()).data.version, confirmed: true };
    for (const extra of [{ confirmed: false }, { expectedVersion: 123 }, { expectedVersion: 'bad' }, { pageId: 'other' }, { subscribedFields: ['leadgen'] }, { refresh: true }]) assert.equal((await request({ ...payload, ...extra })).status, 400);
    const before = calls.length; assert.equal((await request(payload, { role: 'editor' })).status, 403); assert.equal(calls.length, before);
    assert.equal((await request(undefined, { search: '?refresh=true' })).status, 400); assert.equal((await request(undefined, { method: 'PATCH' })).status, 405); assert.equal((await request(undefined, { accountId: 'outside' })).status, 403);
    for (const platform of ['instagram', 'metaads', 'telegram']) { state.row.platform = platform; assert.equal((await request()).status, 400); } state.row.platform = 'facebook';
    state.row.isActive = false; assert.equal((await request()).status, 400); state.row.isActive = true; state.row.needsReconnection = true; assert.equal((await request()).status, 400); delete state.row.needsReconnection;
    for (const extra of [{ pageId: '' }, { pageId: '0' }, { pageId: '0000' }, { pageId: 123 }, { pageId: 'a b' }, { appSubscribed: undefined }, { appSubscribed: null }, { leadgen: 'false' }, { subscribedFields: undefined }, { subscribedFields: [3] }, { subscribedFields: [''] }, { subscribedFields: ['bad\nfield'] }, { subscribedFields: Array(201).fill('feed') }, { warning: {} }]) { state.readResponse = { ...state.subscription, ...extra }; assert.equal((await request()).status, 502, JSON.stringify(extra)); } state.readResponse = null;
    state.subscription.pageId = 'opaque-page'; assert.equal((await request()).data.pageId, 'opaque-page'); state.subscription.pageId = '123456789';
    for (const extra of [{ pageId: '987654321' }, { appSubscribed: true }, { leadgen: true }, { subscribedFields: ['feed', 'leadgen'] }]) { const original = { ...state.subscription }; Object.assign(state.subscription, extra); assert.equal((await request(payload)).data.error.code, 'FACEBOOK_SUBSCRIPTION_CHANGED'); Object.assign(state.subscription, original); }
    assert.equal(state.writes, 0);
  } finally { db.close(); }
});

test('Facebook subscription rechecks access and account identity around every await and takes two fresh snapshots before dispatch', async () => {
  for (const boundary of ['accounts-1', 'read-1', 'accounts-2', 'accounts-3', 'read-2', 'accounts-4']) for (const change of ['role', 'mapping', 'identity', 'scope']) {
    const { db, state, request } = facebookSubscriptionFixture();
    try {
      const payload = { expectedVersion: (await request()).data.version, confirmed: true }; state.accountReads = 0; state.subscriptionReads = 0;
      const drift = () => { if (change === 'role') state.roleAllowed = false; if (change === 'mapping') state.mappingAllowed = false; if (change === 'identity') state.row.platformUserId = 'replacement'; if (change === 'scope') state.row.profileId = 'outside'; };
      state.onAccounts = count => { if (boundary === `accounts-${count}`) drift(); }; state.onRead = count => { if (boundary === `read-${count}`) drift(); };
      const result = await request(payload); assert.ok([403, 409].includes(result.status), `${boundary}/${change}: ${JSON.stringify(result)}`); assert.equal(state.writes, 0, `${boundary}/${change}`);
    } finally { db.close(); }
  }
});

test('Facebook unknown receipts, readback mismatch and postwrite access loss fence Page aliases, projects and generic account actions', async () => {
  for (const failure of ['receipt', 'wrongPage', 'missingResubscribed', 'readback', 'booleans', 'fields', 'page', 'account', 'role', 'mapping', 'scope', 'provider']) {
    const { db, state, request, reviewed } = facebookSubscriptionFixture();
    try {
      state.onWrite = () => { if (failure === 'receipt') state.receipt = {}; if (failure === 'wrongPage') state.receipt = { ...state.subscription, pageId: '987654321', resubscribed: true }; if (failure === 'missingResubscribed') state.receipt = { ...state.subscription }; if (failure === 'readback') state.readFailure = true; if (failure === 'booleans') state.readResponse = { ...state.subscription, leadgen: true }; if (failure === 'fields') state.readResponse = { ...state.subscription, subscribedFields: ['leadgen'] }; if (failure === 'page') state.readResponse = { ...state.subscription, pageId: '987654321' }; if (failure === 'account') state.row.platformUserId = 'replacement'; if (failure === 'role') state.roleAllowed = false; if (failure === 'mapping') state.mappingAllowed = false; if (failure === 'scope') state.row.profileId = 'outside'; if (failure === 'provider') state.writeFailure = new IntegrationError(502, 'PROVIDER_UNAVAILABLE', 'No acknowledgement', true); };
      const result = await reviewed(); assert.equal(result.status, 409, failure); assert.equal(result.data.operation.status, 'uncertain', failure);
      Object.assign(state, { onWrite: null, receipt: null, readFailure: false, readResponse: null, writeFailure: null, roleAllowed: true, mappingAllowed: true }); state.row.profileId = profileId;
      const blocked = await request({ displayName: 'Changed' }, { task: 'update' }); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT', failure); assert.equal(blocked.data.operation.status, 'failed', failure); assert.notEqual(blocked.data.operation.id, result.data.operation.id, failure);
      assert.equal((await reviewed({ accountId: 'facebook-alias' })).data.error.code, 'FACEBOOK_PREVIOUS_OUTCOME_UNRESOLVED', failure);
      assert.equal((await reviewed({ projectId: 'project-b' })).data.error.code, 'FACEBOOK_PREVIOUS_OUTCOME_UNRESOLVED', failure); assert.equal(state.writes, 1, failure);
      db.prepare("UPDATE integration_operations SET status='reviewed-not-applied' WHERE request_key=(SELECT request_key FROM zernio_facebook_subscription_mutations)").run(); assert.equal((await reviewed()).status, 200, failure); assert.equal(state.writes, 2, failure);
    } finally { db.close(); }
  }
});

test('Facebook native Page uncertainty survives reopening and missing receipts; closed keys require a fresh review', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ten98-facebook-subscription-')), path = join(directory, 'state.sqlite'); let fixture = facebookSubscriptionFixture(new DatabaseSync(path));
  try {
    const payload = { expectedVersion: (await fixture.request()).data.version, confirmed: true }; fixture.state.receipt = {};
    const result = await fixture.request(payload, { key: 'facebook-durable-key' }); assert.equal(result.data.operation.status, 'uncertain'); assert.equal((await fixture.request(payload, { key: 'facebook-durable-key' })).data.error.code, 'OPERATION_UNCERTAIN');
    const blockedBody = { displayName: 'Blocked name' }, blocked = await fixture.request(blockedBody, { task: 'update', key: 'facebook-blocked-key' }); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.notEqual(blocked.data.operation.id, result.data.operation.id); fixture.db.close(); fixture = facebookSubscriptionFixture(new DatabaseSync(path));
    fixture.state.subscription.pageId = '000123456789'; assert.equal((await fixture.reviewed({ accountId: 'facebook-alias', projectId: 'project-b' })).data.error.code, 'FACEBOOK_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(fixture.state.writes, 0);
    fixture.db.prepare("UPDATE integration_operations SET status='pending' WHERE request_key='facebook-durable-key'").run(); assert.equal((await fixture.reviewed({ accountId: 'facebook-alias', projectId: 'project-c' })).data.error.code, 'FACEBOOK_PREVIOUS_OUTCOME_UNRESOLVED');
    fixture.db.prepare("UPDATE integration_operations SET status='reviewed-not-applied' WHERE request_key='facebook-durable-key'").run(); assert.equal((await fixture.request(payload, { key: 'facebook-durable-key' })).data.error.code, 'OPERATION_REVIEWED'); assert.deepEqual(await fixture.request(blockedBody, { task: 'update', key: 'facebook-blocked-key' }), blocked); assert.equal(fixture.state.writes, 0); assert.equal((await fixture.reviewed()).status, 200);
    fixture.state.receipt = {}; assert.equal((await fixture.reviewed()).data.operation.status, 'uncertain'); fixture.db.prepare('DELETE FROM integration_operations WHERE request_key=(SELECT request_key FROM zernio_facebook_subscription_mutations)').run(); assert.equal((await fixture.reviewed({ accountId: 'facebook-alias', projectId: 'project-d' })).data.error.code, 'FACEBOOK_PREVIOUS_OUTCOME_UNRESOLVED');
  } finally { fixture.db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Facebook Page subscription preserves durable pending fence when the local completion receipt cannot be saved', async () => {
  const { db, state, reviewed } = facebookSubscriptionFixture();
  try {
    assert.equal((await reviewed()).status, 200); db.exec("CREATE TRIGGER reject_facebook_receipt BEFORE UPDATE ON integration_operations BEGIN SELECT RAISE(FAIL,'receipt unavailable'); END");
    await assert.rejects(reviewed(), /receipt unavailable/); db.exec('DROP TRIGGER reject_facebook_receipt');
    assert.equal((await reviewed({ accountId: 'facebook-alias', projectId: 'project-b' })).data.error.code, 'FACEBOOK_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(state.writes, 2);
  } finally { db.close(); }
});

test('Facebook Page subscription real transport uses authenticated scoped live GET and bodyless POST with strict independent readback', async () => {
  const db = new DatabaseSync(':memory:'), original = globalThis.fetch, row = { ...account('facebook-a', 'facebook'), platformUserId: '123456789' }, calls = [];
  let subscription = { pageId: '123456789', appSubscribed: false, leadgen: false, subscribedFields: [], warning: 'leadgen is missing' }, receipt = 'good', sequence = 0;
  async function invoke(body, role = 'owner') {
    let response;
    await handleIntegration({ db, project: { id: 'project-a', zernioProfileId: profileId }, role, req: { method: body === undefined ? 'GET' : 'POST', headers: { 'idempotency-key': `facebook-router-${++sequence}` } }, url: new URL('http://localhost/api/projects/project-a/integrations/accounts/facebook-a/webhook-subscription'), body: body ?? {}, config: { env: { ZERNIO_API_KEY: 'fixture-secret' } }, assertProjectMapping(expected) { assert.equal(expected, profileId); }, send(status, data) { response = { status, data }; } }); return response;
  }
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); calls.push({ url, options }); assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.headers.Authorization, 'Bearer fixture-secret');
    if (url.pathname === '/api/v1/accounts') { assert.equal(url.searchParams.get('profileId'), profileId); assert.equal(options.method, 'GET'); return Response.json({ accounts: [row] }); }
    assert.equal(url.pathname, '/api/v1/accounts/facebook-a/webhook-subscription'); assert.equal(url.search, '');
    if (options.method === 'GET') return Response.json(subscription);
    assert.equal(options.method, 'POST'); assert.equal(options.body, undefined); assert.match(options.headers['Idempotency-Key'], /^facebook-router-/);
    subscription = { pageId: '123456789', appSubscribed: true, leadgen: true, subscribedFields: ['leadgen', 'feed'], warning: null };
    if (receipt === 'lost') throw new Error('Lost acknowledgement');
    if (receipt === 'empty') return new Response('', { status: 200 });
    if (receipt === 'malformed') return new Response('{not json', { status: 200 });
    return Response.json({ ...subscription, resubscribed: true });
  };
  try {
    let snapshot = await invoke(), result = await invoke({ expectedVersion: snapshot.data.version, confirmed: true }); assert.equal(result.status, 200); assert.equal(result.data.operation.status, 'complete'); assert.equal(result.data.readback, true); assert.equal(result.data.leadgen, true);
    for (const mode of ['empty', 'malformed', 'lost']) {
      receipt = mode; snapshot = await invoke(); result = await invoke({ expectedVersion: snapshot.data.version, confirmed: true }); assert.equal(result.status, 409, mode); assert.equal(result.data.operation.status, 'uncertain', mode);
      const writes = calls.filter(call => call.options.method === 'POST').length, uncertainId = result.data.operation.id; snapshot = await invoke(); result = await invoke({ expectedVersion: snapshot.data.version, confirmed: true }); assert.equal(result.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(result.data.operation.status, 'failed'); assert.notEqual(result.data.operation.id, uncertainId); assert.equal(calls.filter(call => call.options.method === 'POST').length, writes);
      db.prepare("UPDATE integration_operations SET status='reviewed-not-applied' WHERE status='uncertain'").run();
    }
  } finally { globalThis.fetch = original; db.close(); }
});
function discordFixture() {
  const db = new DatabaseSync(':memory:'), calls = [], state = { row: { ...account('discord-a', 'discord'), platformUserId: '111111111111111111' }, settings: { _id: 'discord-a', platform: 'discord', guildId: '222222222222222222', channelId: '111111111111111111', channelName: 'Updates', channelType: '0', webhookUsername: 'Updates', webhookAvatarUrl: 'https://images.example/avatar.png' }, roleAllowed: true, mappingAllowed: true };
  const api = async (path, query = {}, body, key, method = body === undefined ? 'GET' : 'POST') => {
    calls.push({ path, query, body, key, method });
    if (path === '/accounts') { assert.deepEqual(query, { profileId }); return { accounts: [structuredClone(state.row)] }; }
    assert.equal(path, '/accounts/discord-a/discord-settings');
    if (method === 'PATCH') { state.writes = (state.writes || 0) + 1; assert.deepEqual(Object.keys(body), ['webhookUsername', 'webhookAvatarUrl']); Object.assign(state.settings, body); state.onWrite?.(); if (state.writeFailure) throw state.writeFailure; return state.receipt ?? { account: structuredClone(state.settings) }; }
    if (state.readFailure) throw new IntegrationError(502, 'PROVIDER_UNAVAILABLE', 'Read unavailable');
    state.onRead?.(); return state.readResponse ?? { account: structuredClone(state.settings), secret: 'never-return' };
  };
  let sequence = 0;
  const request = async (body, { role = 'owner', accountId = 'discord-a', key = `discord-test-${++sequence}`, search = '', projectId = 'project-a', method = body === undefined ? 'GET' : 'POST' } = {}) => {
    let response;
    const context = { db, project: { id: projectId, zernioProfileId: profileId }, role, body: body ?? {}, req: { method, headers: { 'idempotency-key': key } }, url: new URL(`https://app.example/api/projects/${projectId}/integrations/accounts/${accountId}/discord-settings${search}`), assertProjectMapping(expected) { if (!state.mappingAllowed || expected !== profileId) throw Object.assign(new Error('Mapping changed'), { status: 409 }); }, assertIntegrationSettings() { if (!state.roleAllowed) throw Object.assign(new Error('Role changed'), { status: 403 }); }, send(status, data) { response = { status, data }; } };
    try { await handleZernioAccounts(context, api, profileId, `${accountId}/discord-settings`); return response; }
    catch (error) { if (!(error instanceof IntegrationError)) throw error; return { status: error.status, data: { error: { code: error.code, message: error.message } } }; }
  };
  return { db, calls, state, request, async reviewed(defaults = { webhookUsername: 'Support', webhookAvatarUrl: 'https://images.example/support.png' }, options) { const loaded = await request(); return request({ ...defaults, clearUsername: defaults.webhookUsername === '', clearAvatar: defaults.webhookAvatarUrl === '', expectedVersion: loaded.data.version, confirmed: true }, options); } };
}

test('Discord native defaults require admin review and confirm exact scoped PATCH receipt and GET readback, including independent resets', async () => {
  const { db, calls, state, request, reviewed } = discordFixture();
  try {
    const loaded = await request(undefined, { role: 'viewer' }); assert.equal(loaded.status, 200); assert.equal(loaded.data.guildId, state.settings.guildId); assert.match(loaded.data.version, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(loaded).includes('never-return'), false);
    let result = await reviewed(); assert.equal(result.status, 200); assert.equal(result.data.readback, true); assert.equal(result.data.operation.status, 'complete');
    result = await reviewed({ webhookUsername: '', webhookAvatarUrl: 'https://images.example/support.png' }); assert.equal(result.data.webhookUsername, ''); assert.ok(result.data.webhookAvatarUrl);
    result = await reviewed({ webhookUsername: 'Support', webhookAvatarUrl: '' }); assert.equal(result.data.webhookUsername, 'Support'); assert.equal(result.data.webhookAvatarUrl, '');
    result = await reviewed({ webhookUsername: '', webhookAvatarUrl: '' }); assert.equal(result.status, 200);
    delete state.settings.webhookUsername; delete state.settings.webhookAvatarUrl; assert.equal((await request()).data.webhookUsername, ''); state.settings.webhookUsername = null; state.settings.webhookAvatarUrl = null; assert.equal((await request()).data.webhookAvatarUrl, '');
    const payload = { webhookUsername: 'Reviewed', webhookAvatarUrl: '', clearUsername: false, clearAvatar: true, expectedVersion: (await request()).data.version, confirmed: true }, before = calls.length;
    assert.equal((await request(payload, { role: 'editor' })).status, 403); assert.equal(calls.length, before);
    result = await request(payload, { key: 'discord-same-key' }); const writes = state.writes; assert.equal(result.status, 200); assert.deepEqual(await request(payload, { key: 'discord-same-key' }), result); assert.equal(state.writes, writes);
    assert.ok(calls.filter(row => row.method === 'PATCH').every(row => row.key.startsWith('discord-') && Object.keys(row.body).length === 2));
  } finally { db.close(); }
});

test('Discord defaults reject channel changes, malformed identities and unreviewed or changed destinations before writing', async () => {
  const { db, state, calls, request } = discordFixture();
  try {
    const payload = { webhookUsername: 'New', webhookAvatarUrl: '', clearUsername: false, clearAvatar: true, expectedVersion: (await request()).data.version, confirmed: true };
    for (const extra of [{ confirmed: false }, { channelId: '333333333333333333' }, { defaultUsername: 'Wrong key' }, { clearAvatar: undefined }, { webhookUsername: '' }, { webhookUsername: '   ' }, { webhookUsername: 'a'.repeat(81) }, { webhookUsername: 'ClyDe helper' }, { webhookUsername: 'Our DISCORD' }, { webhookUsername: 'bad\nname' }, { webhookUsername: null }, { webhookAvatarUrl: '', clearAvatar: false }, ...['http://example.com/a', 'https://127.0.0.1/a', 'https://192.168.1.1/a', 'https://a.local/a', 'https://a/a', 'https://u:p@example.com/a', 'https://drive.google.com/a'].map(webhookAvatarUrl => ({ webhookAvatarUrl, clearAvatar: false }))]) assert.equal((await request({ ...payload, ...extra })).status, 400, JSON.stringify(extra));
    assert.equal((await request(undefined, { method: 'PATCH' })).status, 405); assert.equal((await request(undefined, { search: '?channelId=3' })).status, 400); assert.equal((await request(undefined, { accountId: 'outside' })).status, 403);
    for (const key of ['guildId', 'channelId', 'channelType', 'webhookUsername', 'webhookAvatarUrl']) { const original = state.settings[key]; state.settings[key] = key === 'channelType' ? '15' : key.endsWith('Id') ? '333333333333333333' : key === 'webhookAvatarUrl' ? 'https://images.example/changed.png' : 'Changed'; assert.equal((await request(payload)).data.error.code, 'DISCORD_SETTINGS_CHANGED', key); state.settings[key] = original; }
    state.row.needsReconnection = true; assert.equal((await request()).status, 400); delete state.row.needsReconnection;
    for (const field of ['roleAllowed', 'mappingAllowed']) { state.onRead = () => { state[field] = false; }; assert.equal((await request(payload)).status, field === 'roleAllowed' ? 403 : 409); state.onRead = null; state[field] = true; }
    state.onRead = () => { state.row.platformUserId = 'replacement'; }; assert.equal((await request()).data.error.code, 'DISCORD_ACCOUNT_CHANGED'); state.onRead = null;
    for (const settings of [{ ...state.settings, _id: 'other' }, { ...state.settings, platform: 'slack' }, { ...state.settings, guildId: 22 }, { ...state.settings, channelType: 0 }, { ...state.settings, webhookUsername: {} }, { ...state.settings, webhookAvatarUrl: 'https://localhost/a' }]) { state.readResponse = { account: settings }; assert.equal((await request()).status, 502); }
    assert.equal(calls.some(row => row.method === 'PATCH'), false);
  } finally { db.close(); }
});

test('Discord uncertain receipts and readbacks durably fence fresh drafts and another project until operator review', async () => {
  for (const failure of ['receipt', 'wrongReceipt', 'readback', 'wrongReadback', 'role', 'mapping', 'account', 'channel', 'guild', 'provider', 'localReceipt']) {
    const { db, state, request, reviewed } = discordFixture();
    try {
      if (failure === 'localReceipt') { await reviewed(); db.exec("CREATE TRIGGER reject_discord_receipt BEFORE UPDATE ON integration_operations BEGIN SELECT RAISE(FAIL,'receipt unavailable'); END"); }
      if (failure === 'receipt') state.receipt = {};
      if (failure === 'wrongReceipt') state.receipt = { account: { ...state.settings, webhookUsername: 'Wrong' } };
      state.onWrite = () => { if (failure === 'readback') state.readFailure = true; if (failure === 'wrongReadback') state.readResponse = { account: { ...state.settings, webhookUsername: 'Wrong' } }; if (failure === 'role') state.roleAllowed = false; if (failure === 'mapping') state.mappingAllowed = false; if (failure === 'account') state.row.platformUserId = 'replacement'; if (failure === 'channel') state.settings.channelId = '333333333333333333'; if (failure === 'guild') state.settings.guildId = '333333333333333333'; };
      if (failure === 'provider') state.writeFailure = new IntegrationError(502, 'PROVIDER_UNAVAILABLE', 'No acknowledgement', true);
      if (failure === 'localReceipt') { await assert.rejects(reviewed({ webhookUsername: 'Requested', webhookAvatarUrl: '' }), /receipt unavailable/); db.exec('DROP TRIGGER reject_discord_receipt'); }
      else { const result = await reviewed({ webhookUsername: 'Requested', webhookAvatarUrl: '' }); assert.equal(result.status, 409, failure); assert.equal(result.data.operation.status, 'uncertain', failure); }
      state.readFailure = false; state.readResponse = null; state.roleAllowed = true; state.mappingAllowed = true; state.onWrite = null; state.writeFailure = null; state.receipt = null;
      const writes = state.writes, blocked = await reviewed({ webhookUsername: 'New draft', webhookAvatarUrl: '' }); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT', failure); assert.equal(blocked.data.operation.status, 'failed', failure); assert.equal(db.prepare('SELECT status FROM integration_operations WHERE id=?').get(blocked.data.operation.id).status, 'failed'); assert.equal((await reviewed({ webhookUsername: 'Other project', webhookAvatarUrl: '' }, { projectId: 'project-b' })).data.error.code, 'DISCORD_PREVIOUS_OUTCOME_UNRESOLVED', failure); assert.equal(state.writes, writes, failure);
      db.prepare("UPDATE integration_operations SET status='reviewed-not-applied' WHERE request_key=(SELECT request_key FROM zernio_discord_mutations)").run(); assert.equal((await reviewed({ webhookUsername: '', webhookAvatarUrl: '' })).status, 200, failure);
    } finally { db.close(); }
  }
});

test('Discord real transport uses scoped authenticated native PATCH and GET readback, and keeps malformed or lost acknowledgement uncertain', async () => {
  const db = new DatabaseSync(':memory:'), original = globalThis.fetch, row = { ...account('discord-a', 'discord'), platformUserId: '111111111111111111' }, calls = [];
  let settings = { _id: row._id, platform: 'discord', guildId: '222222222222222222', channelId: '111111111111111111', channelType: '0', channelName: 'Updates', webhookUsername: 'Current', webhookAvatarUrl: 'https://images.example/current.png' }, receipt = 'good', sequence = 0;
  async function invoke(body, role = 'owner') {
    let response;
    await handleIntegration({ db, project: { id: 'project-a', zernioProfileId: profileId }, role, req: { method: body === undefined ? 'GET' : 'POST', headers: { 'idempotency-key': `discord-router-${++sequence}` } }, url: new URL('http://localhost/api/projects/project-a/integrations/accounts/discord-a/discord-settings'), body: body || {}, config: { env: { ZERNIO_API_KEY: 'fixture-secret' } }, assertProjectMapping(expected) { assert.equal(expected, profileId); }, send(status, data) { response = { status, data }; } }); return response;
  }
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); calls.push({ url, options }); assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.headers.Authorization, 'Bearer fixture-secret');
    if (url.pathname === '/api/v1/accounts') { assert.equal(url.searchParams.get('profileId'), profileId); return Response.json({ accounts: [row] }); }
    assert.equal(url.pathname, '/api/v1/accounts/discord-a/discord-settings'); assert.equal(url.search, '');
    if (options.method === 'GET') return Response.json({ account: settings });
    assert.equal(options.method, 'PATCH'); assert.match(options.headers['Idempotency-Key'], /^discord-router-/); const body = JSON.parse(options.body); assert.deepEqual(Object.keys(body), ['webhookUsername', 'webhookAvatarUrl']); settings = { ...settings, ...body };
    if (receipt === 'lost') throw new Error('Lost acknowledgement');
    if (receipt === 'malformed') return new Response('{not json', { status: 200 });
    return Response.json(receipt === 'missingAccount' ? {} : { message: 'Discord settings updated', account: settings });
  };
  const payload = (snapshot, clear = false) => ({ webhookUsername: clear ? '' : 'Support', webhookAvatarUrl: '', clearUsername: clear, clearAvatar: true, expectedVersion: snapshot.data.version, confirmed: true });
  try {
    let snapshot = await invoke(); const before = calls.length; assert.equal((await invoke(payload(snapshot), 'editor')).status, 403); assert.equal(calls.length, before);
    let saved = await invoke(payload(snapshot)); assert.equal(saved.status, 200); assert.equal(saved.data.readback, true); assert.equal(saved.data.webhookUsername, 'Support'); assert.equal(calls.at(-1).options.method, 'GET');
    snapshot = await invoke(); saved = await invoke(payload(snapshot, true)); assert.equal(saved.status, 200); assert.equal(saved.data.webhookUsername, ''); assert.equal(saved.data.webhookAvatarUrl, '');
    for (const failure of ['missingAccount', 'malformed', 'lost']) {
      snapshot = await invoke(); receipt = failure; saved = await invoke(payload(snapshot)); assert.equal(saved.status, 409, failure); assert.equal(saved.data.operation.status, 'uncertain', failure);
      const writes = calls.filter(row => row.options.method === 'PATCH').length, uncertainId = saved.data.operation.id; snapshot = await invoke(); const blocked = await invoke(payload(snapshot, true)); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.notEqual(blocked.data.operation.id, uncertainId); assert.equal(calls.filter(row => row.options.method === 'PATCH').length, writes);
      db.prepare("UPDATE integration_operations SET status='reviewed-not-applied' WHERE status='uncertain'").run();
    }
  } finally { globalThis.fetch = original; db.close(); }
});
function setup() {
  const db = new DatabaseSync(':memory:'), calls = [], rows = [account(), account('whatsapp-a', 'whatsapp'), account('outside', 'facebook')]; rows[2].profileId = 'other-profile';
  const state = { rows, health: rows.map(healthy), detail: {}, updateReceipt: null, readFailure: false, failAfterWrite: false, retainDisconnected: false, authUrl: 'https://provider.example.com/oauth?state=fixture', hold: null };
  let written = false;
  const api = async (path, query = {}, body, key, method = body === undefined ? 'GET' : 'POST') => {
    calls.push({ path, query, body, key, method });
    if (path === '/accounts') { assert.deepEqual(query, { profileId }); if (state.readFailure || state.failAfterWrite && written) throw new IntegrationError(502, 'PROVIDER_UNAVAILABLE', 'Readback unavailable'); written = false; return { accounts: structuredClone(state.rows) }; }
    if (path === '/accounts/health') { assert.deepEqual(query, { profileId }); return { summary: { total: 9999, healthy: 9999 }, accounts: structuredClone(state.health) }; }
    if (path.endsWith('/health')) { const row = state.rows.find(row => path === `/accounts/${row._id}/health`); return { ...healthy(row), tokenStatus: { valid: true, needsRefresh: false, expiresAt: '2027-01-01T00:00:00Z', secret: 'never-return' }, permissions: { canPost: true, canFetchAnalytics: true, missingRequired: [], posting: [{ scope: 'publish', granted: true, required: true }], analytics: [], optional: [] }, recommendations: [], ...structuredClone(state.detail) }; }
    if (path.startsWith('/connect/')) return { authUrl: state.authUrl };
    const row = state.rows.find(row => path === `/accounts/${row._id}`); assert.ok(row);
    state.onWrite?.(); if (state.hold) await state.hold;
    written = true;
    if (method === 'DELETE') { if (!state.retainDisconnected) state.rows.splice(state.rows.indexOf(row), 1); return state.updateReceipt || { message: 'Disconnected' }; }
    assert.equal(method, 'PUT'); Object.assign(row, body); return state.updateReceipt || { message: 'Updated', ...body };
  };
  let counter = 0;
  async function request(action, { method = 'GET', body = {}, role = 'owner', key = `test-account-${++counter}`, config } = {}) {
    let response;
    const context = { db, project: { id: 'project-a', zernioProfileId: profileId }, role, req: { method, headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/project-a/integrations/accounts/${action}`), body, config: config || { appUrl: 'https://app.example.com' }, send(status, data) { response = { status, data }; } };
    try { const handled = await handleZernioAccounts(context, api, profileId, action); return response || { handled }; }
    catch (error) { if (!(error instanceof IntegrationError)) throw error; return { status: error.status, data: { error: { code: error.code, message: error.message } } }; }
  }
  return { db, calls, state, request };
}

test('connection health is project-scoped, validates provider details and does not expose secrets or global totals', async () => {
  const { db, state, calls, request } = setup();
  try {
    let result = await request('health', { role: 'viewer' }); assert.equal(result.status, 200); assert.equal(result.data.accounts.length, 2); assert.equal(result.data.summary.total, 2); assert.equal(result.data.summary.healthy, 2); assert.equal(JSON.stringify(result).includes('outside'), false);
    state.health = state.health.filter(row => row.accountId !== 'instagram-a'); result = await request('health'); assert.equal(result.data.summary.unknown, 1); assert.equal(result.data.accounts[0].health, null);
    const count = calls.length; result = await request('outside/health'); assert.equal(result.status, 403); assert.equal(calls.length, count + 1, 'A foreign account is refused before its detail is requested.');
    state.detail = { tokenStatus: { valid: true, secret: 'never-return' }, issues: ['Permission missing'], recommendations: ['Reconnect and grant publishing'], analyticsSync: { status: 'stalled', lastSyncedAt: null } };
    result = await request('instagram-a/health', { role: 'viewer' }); assert.equal(result.status, 200); assert.equal(result.data.health.analyticsSync.status, 'stalled'); assert.equal(JSON.stringify(result).includes('never-return'), false);
    state.detail = { status: 'error', tokenStatus: { valid: true }, platformConnection: { status: 'disconnected', checkedAt: '2026-10-18T00:00:00Z', inboundWebhookSubscribed: false }, messagingRestriction: { code: 131031, message: 'Business account locked', pausedUntil: null }, issues: ['WhatsApp link is disconnected'] };
    result = await request('whatsapp-a/health'); assert.equal(result.status, 200); assert.equal(result.data.health.tokenStatus.valid, true); assert.equal(result.data.health.platformConnection.status, 'disconnected'); assert.equal(result.data.health.platformConnection.inboundWebhookSubscribed, false);
    for (const bad of [{ accountId: 'outside' }, { platform: 'facebook' }, { profileId: 'other-profile' }, { status: 'fine' }, { tokenStatus: { valid: 'yes' } }, { issues: [{}] }, { analyticsSync: { status: 'ok', lastSyncedAt: 'yesterday-ish' } }, { permissions: { posting: [{ scope: 'publish', granted: 'yes', required: true }] } }, { platformConnection: { status: 'connected' } }, { messagingRestriction: { code: {} } }]) { state.detail = bad; assert.equal((await request('instagram-a/health')).status, 502, JSON.stringify(bad)); }
    state.health.push({ accountId: 'instagram-a', platform: 'instagram', status: 'healthy', profileId: 'other-profile' }); result = await request('health'); assert.equal(result.status, 502);
    state.health = [healthy(state.rows[0]), healthy(state.rows[0])]; assert.equal((await request('health')).status, 502);
  } finally { db.close(); }
});

test('only administrators can reconnect scoped accounts using platform-specific OAuth and account identity guards', async () => {
  const { db, calls, state, request } = setup();
  try {
    for (const role of ['viewer', 'editor']) { const before = calls.length; assert.equal((await request('instagram-a/reconnect', { role })).status, 403); assert.equal(calls.length, before); }
    let result = await request('instagram-a/reconnect'); assert.equal(result.status, 200); let call = calls.at(-1); assert.equal(call.path, '/connect/instagram'); assert.equal(call.query.reconnectAccountId, 'instagram-a'); assert.equal(call.query.profileId, profileId); assert.equal(new URL(call.query.redirect_url).searchParams.get('project'), 'project-a');
    for (const [platform, route] of [['googleads', 'googleads'], ['redditads', 'redditads'], ['tiktokads', 'tiktok']]) { state.rows.push(account(platform, platform)); result = await request(`${platform}/reconnect`); assert.equal(result.status, 200); call = calls.at(-1); assert.equal(call.path, `/connect/${route}/ads`); assert.equal(call.query.force, true); }
    state.rows.push({ ...account('xads-a', 'xads'), parentAccountId: 'x-a' }, account('x-a', 'twitter')); assert.equal((await request('xads-a/reconnect')).status, 200); assert.equal(calls.at(-1).query.accountId, 'x-a');
    state.rows.push({ ...account('meta-a', 'metaads'), metadata: { tokenType: 'system-user' } }); assert.equal((await request('meta-a/reconnect')).status, 200); assert.equal(calls.at(-1).query.loginMode, 'business');
    state.rows.push(account('unlinked-meta', 'metaads')); assert.equal((await request('unlinked-meta/reconnect')).status, 409);
    state.rows.push({ ...account('foreign-parent', 'xads'), parentAccountId: 'outside' }); assert.equal((await request('foreign-parent/reconnect')).status, 403);
    for (const platform of ['snapchat', 'openaiads', 'wordpress']) { state.rows.push(account(platform, platform)); assert.equal((await request(`${platform}/reconnect`)).status, 422); }
    for (const authUrl of ['http://provider.example.com', 'https://user:secret@provider.example.com', 'javascript:alert(1)', undefined]) { state.authUrl = authUrl; assert.equal((await request('instagram-a/reconnect')).status, 502); }
    assert.equal((await request('instagram-a/reconnect', { config: { appUrl: 'http://public.example.com' } })).status, 503);
  } finally { db.close(); }
});

test('Instagram reconnect preserves the current scoped native login method after account refresh', async () => {
  const { db, calls, state, request } = setup();
  try {
    state.rows[0].metadata = { loginMethod: 'facebook_login' };
    assert.equal((await request('health', { role: 'viewer' })).status, 200);
    for (const metadata of [undefined, {}, { loginMethod: 'instagram_login' }, { loginMethod: 'facebook_login' }, {}]) {
      if (metadata === undefined) delete state.rows[0].metadata; else state.rows[0].metadata = metadata;
      const before = calls.length, result = await request('instagram-a/reconnect');
      assert.equal(result.status, 200); assert.equal(calls.length, before + 2);
      assert.deepEqual(calls[before], { path: '/accounts', query: { profileId }, body: undefined, key: undefined, method: 'GET' });
      assert.deepEqual(calls.at(-1).query, { profileId, redirect_url: 'https://app.example.com/?view=integrations&project=project-a', reconnectAccountId: 'instagram-a', ...(metadata?.loginMethod ? { loginMethod: metadata.loginMethod } : {}) });
      assert.equal(calls.at(-1).path, '/connect/instagram'); assert.equal(calls.at(-1).method, 'GET');
      assert.deepEqual(result.data, { authUrl: state.authUrl, accountId: 'instagram-a' });
    }
    for (const platform of ['facebook', 'whatsapp', 'slack']) {
      state.rows.push({ ...account(platform, platform), metadata: { loginMethod: 'not-an-instagram-account' } });
      assert.equal((await request(`${platform}/reconnect`)).status, 200); assert.equal(calls.at(-1).path, `/connect/${platform}`); assert.equal(Object.hasOwn(calls.at(-1).query, 'loginMethod'), false);
    }
    state.rows[0].profileId = 'other-profile'; const before = calls.length;
    assert.equal((await request('instagram-a/reconnect')).status, 403); assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).path, '/accounts');
  } finally { db.close(); }
});

test('Instagram reconnect refuses ambiguous provider login metadata before requesting an authorization link', async () => {
  const { db, calls, state, request } = setup();
  try {
    for (const metadata of [null, false, 'facebook_login', [], { loginMethod: null }, { loginMethod: '' }, { loginMethod: 'unknown' }, { loginMethod: true }, { loginMethod: ['facebook_login'] }, { loginMethod: {} }]) {
      state.rows[0].metadata = metadata; const before = calls.length, result = await request('instagram-a/reconnect');
      assert.equal(result.status, 502, JSON.stringify(metadata)); assert.equal(result.data.error.code, 'INVALID_PROVIDER_RESPONSE');
      assert.equal(calls.length, before + 1); assert.equal(calls.at(-1).path, '/accounts');
    }
    for (const role of ['viewer', 'editor']) { const before = calls.length; assert.equal((await request('instagram-a/reconnect', { role })).status, 403); assert.equal(calls.length, before); }
  } finally { db.close(); }
});

test('account updates and disconnects preserve idempotency, project isolation, permissions and unknown outcomes', async () => {
  const { db, calls, state, request } = setup();
  try {
    for (const task of ['update', 'disconnect']) for (const role of ['viewer', 'editor']) assert.equal((await request(`instagram-a/${task}`, { method: 'POST', body: { displayName: 'Updated' }, role })).status, 403);
    const write = (action, body, key) => request(action, { method: 'POST', body, key });
    let result = await write('instagram-a/update', { displayName: 'Updated' }, 'update-display-name'); assert.equal(result.status, 200); assert.equal(result.data.account.displayName, 'Updated'); const count = calls.length;
    result = await write('instagram-a/update', { displayName: 'Updated' }, 'update-display-name'); assert.equal(result.status, 200); assert.equal(calls.length, count);
    assert.equal((await write('instagram-a/update', { displayName: 'Other' }, 'update-display-name')).status, 409);
    for (const body of [{ displayName: {} }, { displayName: 'x\nsecret' }, { xCapabilities: { unsupported: true } }, { profileId: 'other-profile' }, {}]) assert.equal((await write('instagram-a/update', body)).status, 400);
    assert.equal((await write('instagram-a/update', { xCapabilities: { inbox: true } })).status, 400);
    state.rows.push(account('x-a', 'twitter')); result = await write('x-a/update', { xCapabilities: { inbox: false, analytics: true } }); assert.equal(result.status, 200); assert.deepEqual(result.data.xCapabilities, { analytics: true, inbox: false });
    assert.equal((await write('instagram-a/disconnect', { confirmAccountId: 'another-account' })).status, 400);
    assert.equal((await write('outside/disconnect', { confirmAccountId: 'outside' })).status, 403);
    result = await write('instagram-a/disconnect', { confirmAccountId: 'instagram-a' }, 'disconnect-confirmed'); assert.equal(result.status, 200); assert.equal(result.data.disconnected, true); const deletes = calls.filter(call => call.method === 'DELETE').length;
    result = await write('instagram-a/disconnect', { confirmAccountId: 'instagram-a' }, 'disconnect-confirmed'); assert.equal(result.status, 200); assert.equal(calls.filter(call => call.method === 'DELETE').length, deletes, 'A completed disconnection replays after the account has disappeared.');
    state.failAfterWrite = true; result = await write('whatsapp-a/update', { displayName: 'Unknown update' }, 'unknown-update'); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); state.failAfterWrite = false;
    const writes = calls.filter(call => call.method === 'PUT').length; assert.equal((await write('whatsapp-a/update', { displayName: 'Unknown update' }, 'different-key-for-unknown')).status, 409); assert.equal(calls.filter(call => call.method === 'PUT').length, writes);
    db.prepare("UPDATE integration_operations SET status='reviewed-not-applied' WHERE status='uncertain'").run();
    state.updateReceipt = {}; result = await write('whatsapp-a/update', { displayName: 'Unreadable receipt' }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); state.updateReceipt = null;
    db.prepare("UPDATE integration_operations SET status='reviewed-not-applied' WHERE status='uncertain'").run();
    state.retainDisconnected = true; result = await write('whatsapp-a/disconnect', { confirmAccountId: 'whatsapp-a' }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain');
  } finally { db.close(); }
});

test('connection UI retains uncertain action keys and refuses stale account mutations or stale list results', async () => {
  const source = await readFile(new URL('../src/ZernioAccounts.tsx', import.meta.url), 'utf8');
  const compile = (start, end, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))))});`)(...Object.values(context));
  let active = true, finish, reject; const keys = { current: new Map() }, calls = [];
  const write = compile('async function write(', '  async function save(', { selected: { _id: 'account /a' }, current: () => active, path: '/projects/a/integrations/accounts', keys, crypto: { randomUUID: () => 'stable-account-key' }, requester: { current: (...args) => { calls.push(args); return new Promise((resolve, fail) => { finish = resolve; reject = fail; }); } } });
  let pending = write('update', { displayName: 'New name' }); reject(new Error('Unreadable app response')); await assert.rejects(pending); assert.equal(keys.current.size, 1);
  pending = write('update', { displayName: 'New name' }); reject(Object.assign(new Error('Uncertain'), { status: 409, code: 'OPERATION_UNCERTAIN' })); await assert.rejects(pending); assert.equal(calls[0][3], calls[1][3]); assert.equal(keys.current.size, 1);
  pending = write('update', { displayName: 'New name' }); active = false; finish({ account: {} }); await assert.rejects(pending, { name: 'AbortError' }); assert.equal(keys.current.size, 0); await assert.rejects(write('disconnect', {}), { name: 'AbortError' }); assert.equal(calls.length, 3);
  const reads = { current: 0 }, requests = [], accepted = [], callback = { current: rows => accepted.push(rows) };
  const load = compile('async function loadAccounts()', '  function choose(', { reads, requester: { current: () => new Promise(resolve => requests.push(resolve)) }, path: '/projects/a/integrations/accounts', current: () => active, setAccounts: rows => accepted.push(rows), setLoaded() {}, setDetail() {}, setAuthUrl() {}, selectedId: '', setSelectedId() {}, callback });
  active = true; const first = load(), second = load(); requests[1]({ accounts: [{ _id: 'new' }] }); await second; requests[0]({ accounts: [{ _id: 'old' }] }); await first; assert.deepEqual(accepted, [[{ _id: 'new' }], [{ _id: 'new' }]]);
  const third = load(); active = false; requests[2]({ accounts: [{ _id: 'departed' }] }); await third; assert.equal(accepted.length, 2);
});

test('account write keys survive server failures and pending receipts until a definite client failure', async () => {
  const source = await readFile(new URL('../src/ZernioAccounts.tsx', import.meta.url), 'utf8'), handler = stripTypeScriptTypes(source.slice(source.indexOf('async function write('), source.indexOf('  async function save(')));
  const keys = { current: new Map() }, calls = []; let failure, sequence = 0;
  const context = { selected: { _id: 'account-a' }, current: () => true, path: '/projects/a/integrations/accounts', keys, crypto: { randomUUID: () => `account-key-${++sequence}` }, requester: { current: async (...args) => { calls.push(args); if (failure) throw Object.assign(new Error('Request failed'), failure); return { account: { _id: 'account-a' } }; } } };
  const write = new Function(...Object.keys(context), `return (${handler});`)(...Object.values(context));
  for (const receipt of [{ status: 502 }, { status: 409, code: 'OPERATION_UNCERTAIN' }, { status: 409, code: 'OPERATION_IN_PROGRESS' }, { status: 409, code: 'OPERATION_PENDING' }, { status: 409, operation: { status: 'pending' } }, { status: 400, operation: { status: 'uncertain' } }]) {
    failure = receipt; await assert.rejects(write('update', { displayName: 'Name' })); assert.equal(keys.current.size, 1, JSON.stringify(receipt)); const retained = calls.at(-1)[3];
    failure = null; await write('update', { displayName: 'Name' }); assert.equal(calls.at(-1)[3], retained); assert.equal(keys.current.size, 0);
  }
  failure = { status: 400, code: 'INVALID_ACCOUNT_UPDATE', operation: { status: 'failed' } }; await assert.rejects(write('update', { displayName: 'Name' })); assert.equal(keys.current.size, 0); const rejected = calls.at(-1)[3];
  failure = null; await write('update', { displayName: 'Name' }); assert.notEqual(calls.at(-1)[3], rejected);
});

test('account settings and disconnect share one concurrent resource guard', async () => {
  const { db, state, request, calls } = setup(); let release, entered;
  try {
    state.hold = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; }); state.onWrite = entered;
    const pending = request('instagram-a/update', { method: 'POST', body: { displayName: 'Held update' } }); await started;
    const result = await request('instagram-a/disconnect', { method: 'POST', body: { confirmAccountId: 'instagram-a' }, key: 'blocked-disconnect-key' }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(result.data.operation.status, 'failed'); assert.equal(db.prepare('SELECT status FROM integration_operations WHERE id=?').get(result.data.operation.id).status, 'failed'); assert.equal(calls.filter(call => call.method === 'DELETE').length, 0);
    release(); state.hold = null; assert.equal((await pending).status, 200);
    assert.deepEqual(await request('instagram-a/disconnect', { method: 'POST', body: { confirmAccountId: 'instagram-a' }, key: 'blocked-disconnect-key' }), result); assert.equal(calls.filter(call => call.method === 'DELETE').length, 0);
  } finally { release?.(); db.close(); }
});

test('integration router uses scoped authenticated requests and preserves uncertainty if mappings change after an account write', async () => {
  const db = new DatabaseSync(':memory:'), original = globalThis.fetch, project = { id: 'project-a', zernioProfileId: profileId }, rows = [account()]; let changed = false, mutate = false;
  async function invoke(action, body, role = 'owner') {
    let response; const method = body === undefined ? 'GET' : 'POST';
    await handleIntegration({ db, project, role, req: { method, headers: { 'idempotency-key': 'router-account-operation' } }, url: new URL(`http://localhost/api/projects/project-a/integrations/accounts/${action}`), body: body || {}, config: { env: {}, ZERNIO_API_KEY: 'fixture-secret', appUrl: 'https://app.example.com' }, assertProjectMapping(expected) { if (changed || expected !== profileId) throw new Error('Mapping changed'); }, send(status, data) { response = { status, data }; } }); return response;
  }
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.headers.Authorization, 'Bearer fixture-secret');
    if (url.pathname === '/api/v1/accounts') { assert.equal(url.searchParams.get('profileId'), profileId); return Response.json({ accounts: rows }); }
    if (url.pathname === '/api/v1/accounts/health') return Response.json({ accounts: rows.map(healthy) });
    assert.equal(options.method, 'PUT'); assert.equal(url.pathname, '/api/v1/accounts/instagram-a'); assert.equal(options.headers['Idempotency-Key'], 'router-account-operation'); mutate = true; changed = true; return Response.json({ message: 'Updated', displayName: 'Changed' });
  };
  try {
    assert.equal((await invoke('health', undefined, 'viewer')).status, 200);
    assert.equal((await invoke('instagram-a/update', { displayName: 'Changed' }, 'editor')).status, 403); assert.equal(mutate, false);
    const result = await invoke('instagram-a/update', { displayName: 'Changed' }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(mutate, true);
  } finally { globalThis.fetch = original; db.close(); }
});

test('rendered health controls show WhatsApp link and permission evidence, hide administrative controls for readers, and do not imply token liveness', async () => {
  const source = await readFile(new URL('../src/ZernioAccounts.tsx', import.meta.url), 'utf8'), start = source.indexOf('  return <section'), end = source.indexOf('\n}', start);
  const { code } = await transformWithOxc(`const render = () => (${source.slice(start + '  return '.length, end).trim().replace(/;$/, '')});`, 'AccountsView.tsx', { jsx: { runtime: 'classic' } });
  const selected = { _id: 'wa', platform: 'whatsapp', displayName: 'Support number', username: '+12025550101', health: null, canReconnect: true };
  const shown = { status: 'error', tokenStatus: { valid: true }, issues: ['WhatsApp channel disconnected'], recommendations: ['Reconnect the number'], permissions: { canPost: false, canFetchAnalytics: false, posting: [{ scope: 'messages', granted: false, required: true }], analytics: [], optional: [], missingRequired: ['messages'] }, platformConnection: { status: 'disconnected', inboundWebhookSubscribed: false } };
  function render(canManage, busy = false) {
    let chosen;
    const context = { React, projectId: 'project-a', request() {}, WhatsAppNumberStatus() { return null; }, busy, loaded: true, accounts: [selected], selected, selectedId: selected._id, detail: shown, shown, draft: { displayName: '', username: '', analytics: '', inbox: '' }, error: '', notice: '', authUrl: '', canManage, action() {}, loadAccounts() {}, choose: account => { chosen = account; }, checkSelected() {}, reconnect() {}, disconnect() {}, save() {}, setDraft() {}, name: row => row.displayName, yes: value => value == null ? 'Not reported' : value ? 'Yes' : 'No', when: () => 'Not reported' };
    const tree = new Function(...Object.keys(context), code + '; return render;')(...Object.values(context))(), nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
    const manage = nodes(tree).find(node => node.type === 'button' && node.props['aria-label'] === 'Manage Support number');
    assert.ok(manage); assert.equal(manage.props.children, 'Manage'); assert.equal(manage.props['aria-pressed'], true); assert.equal(manage.props.disabled, busy);
    if (!busy) { manage.props.onClick(); assert.equal(chosen, selected); }
    assert.ok(nodes(tree).some(node => node.type === 'div' && node.props.className === 'table-scroll'));
    const html = renderToStaticMarkup(tree); return html.replace(/<[^>]*>/g, ' ');
  }
  const viewer = render(false), admin = render(true); assert.match(viewer, /WhatsApp platform link:.*disconnected/); assert.match(viewer, /valid token alone does not confirm/); assert.match(viewer, /Inbound webhook subscribed:.*No/); assert.match(viewer, /Permission details/); assert.doesNotMatch(viewer, /Disconnect account|Save account settings|Reconnect account/); assert.match(admin, /Reconnect account/); assert.match(admin, /Save account settings/);
  render(false, true); render(true, true);
});

function blueskyFixture() {
  const db = new DatabaseSync(':memory:'), calls = [], state = { row: { ...account('blue-a', 'bluesky'), platformUserId: 'did:plc:one' }, defaultLangs: ['en'], roleAllowed: true, mappingAllowed: true };
  const api = async (path, query, body, key, method = 'GET') => {
    calls.push({ path, body, key, method });
    if (path === '/accounts') return { accounts: [structuredClone(state.row)] };
    assert.equal(path, '/accounts/blue-a/bluesky-settings');
    if (method === 'PATCH') { state.writes = (state.writes || 0) + 1; if (!state.noApply) state.defaultLangs = body.defaultLangs; state.onWrite?.(); if (state.writeFailure) throw state.writeFailure; return state.receipt ?? { defaultLangs: structuredClone(state.defaultLangs) }; }
    state.onRead?.(); if (state.readFailure) throw new IntegrationError(502, 'PROVIDER_UNAVAILABLE', 'Bluesky read unavailable');
    return state.readResponse ?? { defaultLangs: structuredClone(state.defaultLangs), secret: 'never-return' };
  };
  let sequence = 0;
  const request = async (body, { role = 'owner', accountId = 'blue-a', key = `bluesky-test-${++sequence}` } = {}) => {
    let response;
    const context = { db, project: { id: 'project-a', zernioProfileId: profileId }, role, body: body ?? {}, req: { method: body === undefined ? 'GET' : 'POST', headers: { 'idempotency-key': key } }, url: new URL(`https://app.example/api/projects/project-a/integrations/accounts/${accountId}/bluesky-settings`), assertProjectMapping(expected) { if (!state.mappingAllowed || expected !== profileId) throw Object.assign(new Error('Mapping changed'), { status: 409 }); }, assertIntegrationSettings() { if (!state.roleAllowed) throw Object.assign(new Error('Role changed'), { status: 403 }); }, send(status, data) { response = { status, data }; } };
    try { await handleZernioAccounts(context, api, profileId, `${accountId}/bluesky-settings`); return response; }
    catch (error) { if (!(error instanceof IntegrationError)) throw error; return { status: error.status, data: { error: { code: error.code, message: error.message } } }; }
  };
  return { db, calls, state, request, async reviewed(defaultLangs, options) { const loaded = await request(); return request({ defaultLangs, expectedVersion: loaded.data.version, confirmed: true }, options); } };
}

test('Bluesky defaults use documented PATCH languages/null with fresh review, scoped access, checked receipt and readback', async () => {
  const fixture = blueskyFixture(), { db, calls, state, request, reviewed } = fixture;
  try {
    const loaded = await request(undefined, { role: 'viewer' }); assert.equal(loaded.status, 200); assert.deepEqual(loaded.data.defaultLangs, ['en']); assert.equal(JSON.stringify(loaded).includes('never-return'), false);
    let result = await reviewed(['pt', 'en-US']); assert.equal(result.status, 200); assert.equal(result.data.readback, true); assert.deepEqual(result.data.defaultLangs, ['pt', 'en-US']); assert.deepEqual(calls.find(row => row.method === 'PATCH').body, { defaultLangs: ['pt', 'en-US'] });
    result = await reviewed(null); assert.equal(result.status, 200); assert.equal(result.data.defaultLangs, null);
    const version = (await request()).data.version, payload = { defaultLangs: ['fr'], expectedVersion: version, confirmed: true };
    for (const defaultLangs of [undefined, [], ['en_US'], ['en', 'EN'], ['en', 'pt', 'fr', 'de'], [''], ['en,pt'], 'en', [4]]) assert.equal((await request({ ...payload, defaultLangs })).status, 400, JSON.stringify(defaultLangs));
    for (const role of ['viewer', 'editor']) { const before = calls.length; assert.equal((await request(payload, { role })).status, 403); assert.equal(calls.length, before); }
    assert.equal((await request(undefined, { accountId: 'foreign' })).status, 403);
    state.row.platform = 'instagram'; assert.equal((await request()).status, 400); state.row.platform = 'bluesky';
    state.defaultLangs = ['de']; assert.equal((await request(payload)).data.error.code, 'BLUESKY_SETTINGS_CHANGED');
    for (const flag of ['roleAllowed', 'mappingAllowed']) { const fresh = (await request()).data; state.onRead = () => { state[flag] = false; }; const before = state.writes; result = await request({ ...payload, expectedVersion: fresh.version }); assert.equal(result.status, flag === 'roleAllowed' ? 403 : 409); assert.equal(state.writes, before); state.onRead = null; state[flag] = true; }
    const fresh = (await request()).data; state.row.platformUserId = 'did:plc:replacement'; assert.equal((await request({ ...payload, expectedVersion: fresh.version })).data.error.code, 'BLUESKY_SETTINGS_CHANGED');
    state.readResponse = {}; assert.equal((await request()).status, 502);
  } finally { db.close(); }
});

test('Bluesky uncertain writes fence fresh keys and changed drafts until provider outcome review', async () => {
  for (const failure of ['receipt', 'readback', 'wrongReadback', 'role', 'mapping', 'account', 'provider']) {
    const { db, state, request, reviewed } = blueskyFixture();
    try {
      if (failure === 'receipt') state.receipt = {};
      if (failure === 'wrongReadback') state.receipt = { defaultLangs: ['fr'] };
      state.onWrite = () => { if (failure === 'readback') state.readFailure = true; if (failure === 'wrongReadback') state.defaultLangs = ['de']; if (failure === 'role') state.roleAllowed = false; if (failure === 'mapping') state.mappingAllowed = false; if (failure === 'account') state.row.platformUserId = 'did:plc:replacement'; };
      if (failure === 'provider') state.writeFailure = new IntegrationError(502, 'PROVIDER_UNAVAILABLE', 'Provider did not confirm', true);
      const result = await reviewed(['fr']); assert.equal(result.status, 409, failure); assert.equal(result.data.operation.status, 'uncertain', failure);
      state.readFailure = false; state.roleAllowed = true; state.mappingAllowed = true; state.onWrite = null; state.receipt = null; state.writeFailure = null;
      const writes = state.writes, retry = await reviewed(['es']); assert.equal(retry.status, 409, failure); assert.equal(retry.data.error.code, 'OPERATION_NOT_SENT', failure); assert.equal(retry.data.operation.status, 'failed', failure); assert.notEqual(retry.data.operation.id, result.data.operation.id, failure); assert.equal(state.writes, writes, failure);
    } finally { db.close(); }
  }
});

test('Bluesky retains a durable fence if saving the local operation receipt fails', async () => {
  const { db, state, request, reviewed } = blueskyFixture();
  try {
    await request({ defaultLangs: [], confirmed: true, expectedVersion: 'a'.repeat(64) });
    // Create the normal receipt table, then simulate a local durability failure after the provider write.
    await reviewed(['pt']);
    db.exec("CREATE TRIGGER reject_bluesky_receipt BEFORE UPDATE ON integration_operations BEGIN SELECT RAISE(FAIL,'receipt unavailable'); END");
    await assert.rejects(reviewed(['fr']), /receipt unavailable/); const writes = state.writes;
    db.exec('DROP TRIGGER reject_bluesky_receipt');
    const blocked = await reviewed(['de']); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(blocked.data.operation.status, 'failed'); assert.equal(db.prepare('SELECT status FROM integration_operations WHERE id=?').get(blocked.data.operation.id).status, 'failed'); assert.equal(state.writes, writes);
  } finally { db.close(); }
});

test('Bluesky UI makes reset intentional, loads explicitly, and hides save controls from readers', async () => {
  const source = await readFile(new URL('../src/ZernioAccounts.tsx', import.meta.url), 'utf8');
  const compile = (start, end, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))))});`)(...Object.values(context));
  assert.throws(compile('function intendedLanguages()', '  async function readBluesky(', { clearLanguages: false, languageText: '' }), /Enter 1 to 3/);
  assert.equal(compile('function intendedLanguages()', '  async function readBluesky(', { clearLanguages: true, languageText: '' })(), null);
  assert.deepEqual(compile('function intendedLanguages()', '  async function readBluesky(', { clearLanguages: false, languageText: 'pt, en-us' })(), ['pt', 'en-US']);
  for (const departed of ['account', 'project', 'role', 'returnedToAccount']) {
    let finish, current = true, role = true, selection = { current: '/accounts:blue-a' }; const accepted = [], action = async run => run(), reads = { current: 0 };
    const load = compile('async function loadBluesky(', '  async function saveBluesky(', { selected: { _id: 'blue-a' }, path: '/accounts', current: () => current, selection, reads, manager: { get current() { return role; } }, action, intendedLanguages: () => ['fr'], readBluesky: () => new Promise(resolve => { finish = resolve; }), setBluesky: value => accepted.push(value), setBlueskyReview: value => accepted.push(value), setLanguageText: value => accepted.push(value), setClearLanguages: value => accepted.push(value) });
    const pending = load(true); if (departed === 'account') selection.current = '/accounts:other'; if (departed === 'project') current = false; if (departed === 'role') role = false; if (departed === 'returnedToAccount') reads.current++; finish({ accountId: 'blue-a', defaultLangs: ['en'], version: 'a'.repeat(64) }); await pending; assert.equal(accepted.length, 0, departed);
  }
  const markup = source.slice(source.indexOf("      {selected.platform === 'bluesky'"), source.indexOf('      {canManage && <>'));
  const { code } = await transformWithOxc(`const render = () => <div>${markup}</div>;`, 'BlueskyView.tsx', { jsx: { runtime: 'classic' } });
  for (const canManage of [false, true]) {
    const context = { React, selected: { _id: 'blue-a', platform: 'bluesky' }, busy: false, loadBluesky() {}, bluesky: { accountId: 'blue-a', defaultLangs: ['en'] }, canManage, languageText: 'fr', clearLanguages: false, setLanguageText() {}, setBlueskyReview() {}, setClearLanguages() {}, blueskyReview: null };
    const html = renderToStaticMarkup(new Function(...Object.keys(context), code + '; return render;')(...Object.values(context))()); assert.match(html, /Load default languages/); assert.equal(html.includes('Review latest settings'), canManage); assert.equal(html.includes('Clear default languages'), canManage);
  }
});

test('Bluesky GET/PATCH transport uses the project route, authorization and operation key and validates real JSON receipts', async () => {
  const db = new DatabaseSync(':memory:'), original = globalThis.fetch, row = { ...account('blue-a', 'bluesky'), platformUserId: 'did:plc:one' }, calls = []; let defaultLangs = ['en'], badReceipt = false, sequence = 0;
  async function invoke(body, role = 'owner') {
    let response;
    await handleIntegration({ db, project: { id: 'project-a', zernioProfileId: profileId }, role, req: { method: body === undefined ? 'GET' : 'POST', headers: { 'idempotency-key': `bluesky-router-${++sequence}` } }, url: new URL('http://localhost/api/projects/project-a/integrations/accounts/blue-a/bluesky-settings'), body: body || {}, config: { env: { ZERNIO_API_KEY: 'fixture-secret' } }, assertProjectMapping(expected) { assert.equal(expected, profileId); }, send(status, data) { response = { status, data }; } }); return response;
  }
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); calls.push({ url, options }); assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.headers.Authorization, 'Bearer fixture-secret');
    if (url.pathname === '/api/v1/accounts') { assert.equal(url.searchParams.get('profileId'), profileId); return Response.json({ accounts: [row] }); }
    assert.equal(url.pathname, '/api/v1/accounts/blue-a/bluesky-settings');
    if (options.method === 'PATCH') { assert.match(options.headers['Idempotency-Key'], /^bluesky-router-/); const body = JSON.parse(options.body); assert.deepEqual(Object.keys(body), ['defaultLangs']); defaultLangs = body.defaultLangs; return Response.json(badReceipt ? {} : { defaultLangs }); }
    assert.equal(options.method, 'GET'); return Response.json({ defaultLangs });
  };
  try {
    let snapshot = await invoke(); assert.equal(snapshot.status, 200);
    const before = calls.length; assert.equal((await invoke({ defaultLangs: ['fr'], expectedVersion: snapshot.data.version, confirmed: true }, 'editor')).status, 403); assert.equal(calls.length, before);
    let saved = await invoke({ defaultLangs: ['fr'], expectedVersion: snapshot.data.version, confirmed: true }); assert.equal(saved.status, 200); assert.equal(saved.data.readback, true); assert.deepEqual(saved.data.defaultLangs, ['fr']);
    snapshot = await invoke(); saved = await invoke({ defaultLangs: null, expectedVersion: snapshot.data.version, confirmed: true }); assert.equal(saved.status, 200); assert.equal(saved.data.defaultLangs, null);
    snapshot = await invoke(); badReceipt = true; saved = await invoke({ defaultLangs: ['de'], expectedVersion: snapshot.data.version, confirmed: true }); assert.equal(saved.status, 409); assert.equal(saved.data.operation.status, 'uncertain');
  } finally { globalThis.fetch = original; db.close(); }
});

function telegramFixture() {
  const db = new DatabaseSync(':memory:'), calls = [], state = { row: { ...account('tg-a', 'telegram'), platformUserId: 'bot-one' }, commands: [{ command: 'start', description: 'Start here' }], roleAllowed: true, mappingAllowed: true };
  const api = async (path, query, body, key, method = 'GET') => {
    calls.push({ path, query, body, key, method });
    if (path === '/accounts') return { accounts: [structuredClone(state.row)] };
    assert.equal(path, '/accounts/tg-a/telegram-commands');
    if (method !== 'GET') { state.writes = (state.writes || 0) + 1; assert.ok(['PUT', 'DELETE'].includes(method)); if (!state.noApply) state.commands = method === 'DELETE' ? [] : structuredClone(body.commands); state.onWrite?.(); if (state.writeFailure) throw state.writeFailure; return {}; }
    state.onRead?.(); if (state.readFailure) throw new IntegrationError(502, 'PROVIDER_UNAVAILABLE', 'Telegram read unavailable');
    return state.readResponse ?? { data: structuredClone(state.commands), secret: 'never-return' };
  };
  let sequence = 0;
  const request = async (body, { role = 'owner', accountId = 'tg-a', key = `telegram-test-${++sequence}`, search = '', projectId = 'project-a' } = {}) => {
    let response;
    const context = { db, project: { id: projectId, zernioProfileId: profileId }, role, body: body ?? {}, req: { method: body === undefined ? 'GET' : 'POST', headers: { 'idempotency-key': key } }, url: new URL(`https://app.example/api/projects/${projectId}/integrations/accounts/${accountId}/telegram-commands${search}`), assertProjectMapping(expected) { if (!state.mappingAllowed || expected !== profileId) throw Object.assign(new Error('Mapping changed'), { status: 409 }); }, assertIntegrationSettings() { if (!state.roleAllowed) throw Object.assign(new Error('Role changed'), { status: 403 }); }, send(status, data) { response = { status, data }; } };
    try { await handleZernioAccounts(context, api, profileId, `${accountId}/telegram-commands`); return response; }
    catch (error) { if (!(error instanceof IntegrationError)) throw error; return { status: error.status, data: { error: { code: error.code, message: error.message } } }; }
  };
  return { db, calls, state, request, async reviewed(commands, options) { const loaded = await request(); return request({ commands, clear: commands.length === 0, expectedVersion: loaded.data.version, confirmed: true }, options); } };
}

test('Telegram command menu replaces and explicitly clears the documented default menu with checked scoped readback', async () => {
  const { db, calls, state, request, reviewed } = telegramFixture();
  try {
    const loaded = await request(undefined, { role: 'viewer' }); assert.equal(loaded.status, 200); assert.deepEqual(loaded.data.commands, state.commands); assert.equal(JSON.stringify(loaded).includes('never-return'), false);
    const commands = [{ command: 'help_2', description: 'Get help' }, { command: 'about', description: '😀'.repeat(256) }];
    let result = await reviewed(commands, { key: 'telegram-success' }); assert.equal(result.status, 200); assert.equal(result.data.readback, true); assert.deepEqual(result.data.commands, commands);
    const dispatched = calls.find(row => row.method === 'PUT'); assert.deepEqual(dispatched.body, { commands }); assert.deepEqual(dispatched.query, {});
    const count = calls.length; result = await request({ commands, clear: false, expectedVersion: loaded.data.version, confirmed: true }, { key: 'telegram-success' }); assert.equal(result.status, 200); assert.equal(calls.length, count);
    result = await reviewed([]); assert.equal(result.status, 200); assert.deepEqual(result.data.commands, []); assert.equal(calls.find(row => row.method === 'DELETE').body, undefined);
  } finally { db.close(); }
});

test('Telegram menu refuses invalid input, unsupported scope/locale, foreign accounts, changed permissions and stale reviews before dispatch', async () => {
  const { db, calls, state, request } = telegramFixture();
  try {
    const payload = { commands: [{ command: 'help', description: 'Help' }], clear: false, expectedVersion: (await request()).data.version, confirmed: true };
    for (const commands of [undefined, null, [], [{ command: '/help', description: 'Help' }], [{ command: 'UPPER', description: 'Help' }], [{ command: 'a'.repeat(33), description: 'Help' }], [{ command: 'help', description: '' }], [{ command: 'help', description: 'a'.repeat(257) }], [{ command: 'help', description: 'line\nbreak' }], [...payload.commands, ...payload.commands], [{ ...payload.commands[0], scope: 'all_private_chats' }], Array.from({ length: 101 }, (_, index) => ({ command: `a_${index}`, description: 'Help' }))]) assert.equal((await request({ ...payload, commands })).status, 400, JSON.stringify(commands));
    for (const body of [{ ...payload, clear: true }, { ...payload, clear: undefined }, { ...payload, confirmed: false }, { ...payload, scope: {} }, { ...payload, locale: 'en' }]) assert.equal((await request(body)).status, 400);
    assert.equal((await request(undefined, { search: '?locale=en' })).status, 400);
    for (const role of ['viewer', 'editor']) { const before = calls.length; assert.equal((await request(payload, { role })).status, 403); assert.equal(calls.length, before); }
    assert.equal((await request(undefined, { accountId: 'outside' })).status, 403);
    state.row.platform = 'instagram'; assert.equal((await request()).status, 400); state.row.platform = 'telegram'; state.row.isActive = false; assert.equal((await request()).status, 400); state.row.isActive = true;
    state.commands = [{ command: 'changed', description: 'Elsewhere' }]; assert.equal((await request(payload)).data.error.code, 'TELEGRAM_COMMANDS_CHANGED');
    for (const flag of ['roleAllowed', 'mappingAllowed']) { const fresh = (await request()).data; state.onRead = () => { state[flag] = false; }; assert.equal((await request({ ...payload, expectedVersion: fresh.version })).status, flag === 'roleAllowed' ? 403 : 409); state.onRead = null; state[flag] = true; }
    const fresh = (await request()).data; state.row.platformUserId = 'bot-replaced'; assert.equal((await request({ ...payload, expectedVersion: fresh.version })).data.error.code, 'TELEGRAM_COMMANDS_CHANGED');
    state.onRead = () => { state.row.username = 'replacement'; }; assert.equal((await request()).data.error.code, 'TELEGRAM_ACCOUNT_CHANGED'); state.onRead = null;
    state.readResponse = { commands: [] }; assert.equal((await request()).status, 502); state.readResponse = { data: [{ command: 'a', description: {} }] }; assert.equal((await request()).status, 502); assert.equal(state.writes, undefined);
  } finally { db.close(); }
});

test('Telegram lost receipts and failed readback keep durable fences across keys, drafts and projects until an operator review', async () => {
  for (const failure of ['readback', 'wrongReadback', 'role', 'mapping', 'account', 'provider', 'localReceipt']) {
    const { db, state, request, reviewed } = telegramFixture();
    try {
      if (failure === 'localReceipt') { await reviewed([{ command: 'ready', description: 'Ready' }]); db.exec("CREATE TRIGGER reject_telegram_receipt BEFORE UPDATE ON integration_operations BEGIN SELECT RAISE(FAIL,'receipt unavailable'); END"); }
      state.onWrite = () => { if (failure === 'readback') state.readFailure = true; if (failure === 'wrongReadback') state.commands = []; if (failure === 'role') state.roleAllowed = false; if (failure === 'mapping') state.mappingAllowed = false; if (failure === 'account') state.row.platformUserId = 'replacement'; };
      if (failure === 'provider') state.writeFailure = new IntegrationError(502, 'PROVIDER_UNAVAILABLE', 'No readable acknowledgement', true);
      if (failure === 'localReceipt') { await assert.rejects(reviewed([{ command: 'help', description: 'Help' }]), /receipt unavailable/); db.exec('DROP TRIGGER reject_telegram_receipt'); }
      else { const result = await reviewed([{ command: 'help', description: 'Help' }], { key: 'telegram-uncertain' }); assert.equal(result.status, 409, failure); assert.equal(result.data.operation.status, 'uncertain', failure); }
      state.readFailure = false; state.roleAllowed = true; state.mappingAllowed = true; state.onWrite = null; state.writeFailure = null;
      const writes = state.writes, retry = await reviewed([{ command: 'other', description: 'Other' }], { projectId: 'project-b' }); assert.equal(retry.data.error.code, 'TELEGRAM_PREVIOUS_OUTCOME_UNRESOLVED', failure); assert.equal(state.writes, writes);
      db.prepare("UPDATE integration_operations SET status='reviewed-not-applied' WHERE request_key=(SELECT request_key FROM zernio_telegram_mutations)").run();
      assert.equal((await reviewed([])).status, 200, failure);
    } finally { db.close(); }
  }
});

test('Telegram UI validates intentional clear, rejects stale responses and preserves uncertain drafts and keys', async () => {
  const source = await readFile(new URL('../src/ZernioAccounts.tsx', import.meta.url), 'utf8');
  const compile = (start, end, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))))});`)(...Object.values(context));
  assert.throws(compile('function intendedCommands()', '  async function readTelegram(', { clearCommands: false, commandDraft: [] }), /Enter 1 to 100/);
  assert.deepEqual(compile('function intendedCommands()', '  async function readTelegram(', { clearCommands: true, commandDraft: [] })(), []);
  for (const commandDraft of [[{ command: '/help', description: 'Help' }], [{ command: 'help', description: ' ' }], [{ command: 'help', description: 'a'.repeat(257) }], [{ command: 'help', description: 'Help' }, { command: 'help', description: 'Again' }]]) assert.throws(compile('function intendedCommands()', '  async function readTelegram(', { clearCommands: false, commandDraft }), /Enter 1 to 100/);
  for (const departed of ['account', 'project', 'role', 'returnedToAccount']) {
    let finish, live = true, role = true; const accepted = [], reads = { current: 0 }, selection = { current: '/accounts:tg-a' };
    const load = compile('async function loadTelegram(', '  async function saveTelegram(', { selected: { _id: 'tg-a' }, path: '/accounts', current: () => live, selection, reads, manager: { get current() { return role; } }, action: async run => run(), intendedCommands: () => [], clearCommands: true, readTelegram: () => new Promise(resolve => { finish = resolve; }), setTelegram: value => accepted.push(value), setTelegramReview: value => accepted.push(value), setCommandDraft: value => accepted.push(value), setClearCommands: value => accepted.push(value) });
    const pending = load(true); if (departed === 'account') selection.current = '/accounts:other'; if (departed === 'project') live = false; if (departed === 'role') role = false; if (departed === 'returnedToAccount') reads.current++; finish({ accountId: 'tg-a', commands: [], version: 'a'.repeat(64) }); await pending; assert.equal(accepted.length, 0, departed);
  }
  const keys = { current: new Map() }, calls = [], accepted = [], commands = [{ command: 'help', description: 'Help' }]; let response = { accountId: 'other' }, failure;
  const write = compile('async function write(', '  async function save(', { selected: { _id: 'tg-a' }, current: () => true, path: '/accounts', keys, crypto: { randomUUID: () => 'telegram-stable-key' }, requester: { current: async (...args) => { calls.push(args); if (failure) throw failure; return response; } } });
  const save = compile('async function saveTelegram(', '  const shown', { selected: { _id: 'tg-a' }, telegramReview: { settings: { accountId: 'tg-a', version: 'a'.repeat(64) }, commands, clear: false }, current: () => true, manager: { current: true }, path: '/accounts', selection: { current: '/accounts:tg-a' }, reads: { current: 0 }, action: async run => run(), write, setTelegram: value => accepted.push(value), setCommandDraft: value => accepted.push(value), setClearCommands: value => accepted.push(value), setTelegramReview: value => accepted.push(value), setNotice: value => accepted.push(value) });
  await assert.rejects(save(), /draft and action key were retained/); assert.equal(keys.current.size, 1); assert.equal(accepted.length, 0);
  failure = Object.assign(new Error('Unknown provider outcome'), { status: 409, code: 'OPERATION_UNCERTAIN' }); await assert.rejects(save(), /Unknown provider outcome/); assert.equal(keys.current.size, 1); assert.equal(accepted.length, 0);
  failure = null; response = { accountId: 'tg-a', commands, version: 'b'.repeat(64), readback: true }; await save(); assert.equal(keys.current.size, 0); assert.deepEqual(accepted[1], commands); assert.equal(calls[0][3], calls[2][3]);
  for (const departed of ['account', 'project', 'role', 'returnedToAccount', 'returnedToRole']) {
    let finish, live = true, role = true; const accepted = [], reads = { current: 0 }, selection = { current: '/accounts:tg-a' };
    const save = compile('async function saveTelegram(', '  const shown', { selected: { _id: 'tg-a' }, telegramReview: { settings: { accountId: 'tg-a', version: 'a'.repeat(64) }, commands, clear: false }, current: () => live, manager: { get current() { return role; } }, path: '/accounts', selection, reads, action: async run => run(), write: () => new Promise(resolve => { finish = resolve; }), setTelegram: value => accepted.push(value), setCommandDraft: value => accepted.push(value), setClearCommands: value => accepted.push(value), setTelegramReview: value => accepted.push(value), setNotice: value => accepted.push(value) });
    const pending = save(); if (departed === 'account') selection.current = '/accounts:other'; if (departed === 'project') live = false; if (departed === 'role') role = false; if (departed === 'returnedToAccount' || departed === 'returnedToRole') reads.current++; finish(response); await pending; assert.equal(accepted.length, 0, departed);
  }
  assert.match(source, /useLayoutEffect\(\(\) => \{\s*if \(manager\.current !== canManage \|\| scope\.current !== view\) reads\.current\+\+;\s*manager\.current = canManage;/);
  const markup = source.slice(source.indexOf("      {selected.platform === 'telegram'"), source.indexOf("      {selected.platform === 'bluesky'"));
  const { code } = await transformWithOxc(`const render = () => <div>${markup}</div>;`, 'TelegramView.tsx', { jsx: { runtime: 'classic' } });
  for (const canManage of [false, true]) {
    const context = { React, selected: { _id: 'tg-a', platform: 'telegram' }, busy: false, loadTelegram() {}, telegram: { accountId: 'tg-a', commands }, canManage, commandDraft: commands, clearCommands: false, setCommandDraft() {}, setTelegramReview() {}, setClearCommands() {}, telegramReview: { settings: { commands }, commands: [], clear: true }, saveTelegram() {}, name: () => 'Support bot' };
    const html = renderToStaticMarkup(new Function(...Object.keys(context), code + '; return render;')(...Object.values(context))()); assert.match(html, /Load bot commands/); assert.match(html, /no custom scope or locale/); assert.equal(html.includes('Confirm and save bot menu'), canManage); assert.equal(html.includes('Clear all bot commands'), canManage); if (canManage) { assert.match(html, /Review Telegram bot menu replacement/); assert.match(html, /Command 1/); assert.match(html, /Description 1/); }
  }
});

test('Telegram real transport handles documented empty 200 acknowledgements and malformed or lost receipts safely', async () => {
  const db = new DatabaseSync(':memory:'), original = globalThis.fetch, row = { ...account('tg-a', 'telegram'), platformUserId: 'bot-one' }, calls = []; let commands = [], receipt = 'empty', sequence = 0;
  async function invoke(body) {
    let response;
    await handleIntegration({ db, project: { id: 'project-a', zernioProfileId: profileId }, role: 'owner', req: { method: body === undefined ? 'GET' : 'POST', headers: { 'idempotency-key': `telegram-router-${++sequence}` } }, url: new URL('http://localhost/api/projects/project-a/integrations/accounts/tg-a/telegram-commands'), body: body || {}, config: { env: { ZERNIO_API_KEY: 'fixture-secret' } }, assertProjectMapping(expected) { assert.equal(expected, profileId); }, send(status, data) { response = { status, data }; } }); return response;
  }
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); calls.push({ url, options }); assert.equal(options.headers.Authorization, 'Bearer fixture-secret');
    if (url.pathname === '/api/v1/accounts') { assert.equal(url.searchParams.get('profileId'), profileId); return Response.json({ accounts: [row] }); }
    assert.equal(url.pathname, '/api/v1/accounts/tg-a/telegram-commands'); assert.equal(url.search, '');
    if (options.method === 'GET') return Response.json({ data: commands });
    assert.match(options.headers['Idempotency-Key'], /^telegram-router-/); assert.ok(['PUT', 'DELETE'].includes(options.method));
    if (options.method === 'PUT') { const body = JSON.parse(options.body); assert.deepEqual(Object.keys(body), ['commands']); commands = body.commands; } else { assert.equal(options.body, undefined); commands = []; }
    if (receipt === 'lost') throw new Error('Lost acknowledgement');
    return new Response(receipt === 'malformed' ? '{not json' : '', { status: 200 });
  };
  try {
    let snapshot = await invoke(), saved = await invoke({ commands: [{ command: 'help', description: 'Help' }], clear: false, expectedVersion: snapshot.data.version, confirmed: true }); assert.equal(saved.status, 200); assert.equal(saved.data.readback, true);
    snapshot = await invoke(); saved = await invoke({ commands: [], clear: true, expectedVersion: snapshot.data.version, confirmed: true }); assert.equal(saved.status, 200); assert.deepEqual(saved.data.commands, []);
    snapshot = await invoke(); receipt = 'malformed'; saved = await invoke({ commands: [{ command: 'bad_receipt', description: 'Help' }], clear: false, expectedVersion: snapshot.data.version, confirmed: true }); assert.equal(saved.status, 409); assert.equal(saved.data.operation.status, 'uncertain');
    const writes = calls.filter(row => row.options.method !== 'GET').length, uncertainId = saved.data.operation.id; snapshot = await invoke(); saved = await invoke({ commands: [], clear: true, expectedVersion: snapshot.data.version, confirmed: true }); assert.equal(saved.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(saved.data.operation.status, 'failed'); assert.notEqual(saved.data.operation.id, uncertainId); assert.equal(calls.filter(row => row.options.method !== 'GET').length, writes);
    db.prepare("UPDATE integration_operations SET status='reviewed-not-applied' WHERE status='uncertain'").run(); snapshot = await invoke(); receipt = 'lost'; saved = await invoke({ commands: [], clear: true, expectedVersion: snapshot.data.version, confirmed: true }); assert.equal(saved.data.operation.status, 'uncertain');
  } finally { globalThis.fetch = original; db.close(); }
});

function slackFixture() {
  const db = new DatabaseSync(':memory:'), calls = [], state = { row: { ...account('slack-a', 'slack'), platformUserId: 'channel-one' }, settings: { _id: 'slack-a', platform: 'slack', teamId: 'T-one', teamName: 'Acme', channelId: 'C-one', channelName: 'Updates', channelType: 'public', defaultUsername: 'Updates', defaultIconUrl: 'https://images.example/avatar.png' }, roleAllowed: true, mappingAllowed: true };
  const api = async (path, query, body, key, method = 'GET') => {
    calls.push({ path, query, body, key, method });
    if (path === '/accounts') return { accounts: [structuredClone(state.row)] };
    assert.equal(path, '/accounts/slack-a/slack-settings');
    if (method === 'PATCH') { state.writes = (state.writes || 0) + 1; assert.deepEqual(Object.keys(body), ['defaultUsername', 'defaultIconUrl']); if (!state.noApply) Object.assign(state.settings, body); state.onWrite?.(); if (state.writeFailure) throw state.writeFailure; return {}; }
    state.onRead?.(); if (state.readFailure) throw new IntegrationError(502, 'PROVIDER_UNAVAILABLE', 'Slack read unavailable');
    return state.readResponse ?? { account: structuredClone(state.settings), secret: 'never-return' };
  };
  let sequence = 0;
  const request = async (body, { role = 'owner', accountId = 'slack-a', key = `slack-test-${++sequence}`, search = '', projectId = 'project-a', method = body === undefined ? 'GET' : 'POST' } = {}) => {
    let response;
    const context = { db, project: { id: projectId, zernioProfileId: profileId }, role, body: body ?? {}, req: { method, headers: { 'idempotency-key': key } }, url: new URL(`https://app.example/api/projects/${projectId}/integrations/accounts/${accountId}/slack-settings${search}`), assertProjectMapping(expected) { if (!state.mappingAllowed || expected !== profileId) throw Object.assign(new Error('Mapping changed'), { status: 409 }); }, assertIntegrationSettings() { if (!state.roleAllowed) throw Object.assign(new Error('Role changed'), { status: 403 }); }, send(status, data) { response = { status, data }; } };
    try { await handleZernioAccounts(context, api, profileId, `${accountId}/slack-settings`); return response; }
    catch (error) { if (!(error instanceof IntegrationError)) throw error; return { status: error.status, data: { error: { code: error.code, message: error.message } } }; }
  };
  return { db, calls, state, request, async reviewed(defaults = { defaultUsername: 'Support', defaultIconUrl: 'https://images.example/support.png' }, options) { const loaded = await request(); return request({ ...defaults, clearUsername: defaults.defaultUsername === '', clearIcon: defaults.defaultIconUrl === '', expectedVersion: loaded.data.version, confirmed: true }, options); } };
}

test('Slack identity loads only native scoped defaults, confirms exact PATCH readback and clears each field intentionally', async () => {
  const { db, state, calls, request, reviewed } = slackFixture();
  try {
    const snapshot = await request(undefined, { role: 'viewer' }); assert.equal(snapshot.status, 200); assert.equal(snapshot.data.channelId, 'C-one'); assert.equal(snapshot.data.defaultUsername, 'Updates'); assert.match(snapshot.data.version, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(snapshot).includes('never-return'), false);
    let result = await reviewed(); assert.equal(result.status, 200); assert.equal(result.data.readback, true); assert.equal(result.data.operation.status, 'complete'); assert.equal(result.data.defaultUsername, 'Support');
    result = await reviewed({ defaultUsername: '', defaultIconUrl: state.settings.defaultIconUrl }); assert.equal(result.status, 200); assert.equal(result.data.defaultUsername, ''); assert.ok(result.data.defaultIconUrl);
    result = await reviewed({ defaultUsername: '', defaultIconUrl: '' }); assert.equal(result.status, 200); assert.equal(result.data.defaultIconUrl, '');
    state.settings.defaultUsername = null; state.settings.defaultIconUrl = null; const cleared = await request(); assert.equal(cleared.data.defaultUsername, ''); assert.equal(cleared.data.defaultIconUrl, '');
    const payload = { defaultUsername: 'Reviewed', defaultIconUrl: '', clearUsername: false, clearIcon: true, confirmed: true, expectedVersion: cleared.data.version };
    const before = calls.length; assert.equal((await request(payload, { role: 'editor' })).status, 403); assert.equal(calls.length, before);
    const key = 'slack-repeat-key'; result = await request(payload, { key }); const writes = state.writes; assert.equal(result.status, 200); assert.deepEqual(await request(payload, { key }), result); assert.equal(state.writes, writes);
    assert.equal(calls.filter(row => row.method === 'PATCH').every(row => /^[a-z-]+(?:\d+)?$/.test(row.key) || row.key === key), true);
  } finally { db.close(); }
});

test('Slack settings enforce review, native fields, scope, stable channel identity and access before writing', async () => {
  const { db, state, request } = slackFixture();
  try {
    const loaded = (await request()).data, payload = { defaultUsername: 'New', defaultIconUrl: '', clearUsername: false, clearIcon: true, expectedVersion: loaded.version, confirmed: true };
    for (const extra of [{ confirmed: false }, { expectedVersion: 'bad' }, { iconUrl: 'https://example.com/a.png' }, { channelId: 'C-other' }, { clearIcon: undefined }, { defaultUsername: '' }, { defaultUsername: 'a'.repeat(81) }, { defaultUsername: 'bad\nname' }, { defaultIconUrl: '', clearIcon: false }, { defaultIconUrl: 'http://example.com/a.png', clearIcon: false }, { defaultIconUrl: 'https://127.0.0.1/a.png', clearIcon: false }, { defaultIconUrl: 'https://u:p@example.com/a.png', clearIcon: false }, { defaultUsername: null }]) assert.equal((await request({ ...payload, ...extra })).status, 400, JSON.stringify(extra));
    assert.equal((await request(undefined, { method: 'PATCH' })).status, 405); assert.equal((await request(undefined, { search: '?username=other' })).status, 400); assert.equal((await request(undefined, { accountId: 'outside' })).status, 403);
    state.row.platform = 'telegram'; assert.equal((await request()).status, 400); state.row.platform = 'slack'; state.row.isActive = false; assert.equal((await request()).status, 400); state.row.isActive = true;
    state.settings.defaultUsername = 'External change'; assert.equal((await request(payload)).data.error.code, 'SLACK_SETTINGS_CHANGED');
    for (const field of ['roleAllowed', 'mappingAllowed']) { const fresh = (await request()).data; state.onRead = () => { state[field] = false; }; assert.equal((await request({ ...payload, expectedVersion: fresh.version })).status, field === 'roleAllowed' ? 403 : 409); state.onRead = null; state[field] = true; }
    const fresh = (await request()).data; state.settings.channelId = 'C-replaced'; assert.equal((await request({ ...payload, expectedVersion: fresh.version })).data.error.code, 'SLACK_SETTINGS_CHANGED');
    state.onRead = () => { state.row.platformUserId = 'replacement'; }; assert.equal((await request()).data.error.code, 'SLACK_ACCOUNT_CHANGED'); state.onRead = null;
    for (const account of [{ ...state.settings, _id: 'other' }, { ...state.settings, platform: 'discord' }, { ...state.settings, teamId: null }, { ...state.settings, defaultUsername: undefined }, { ...state.settings, defaultIconUrl: {} }]) { state.readResponse = { account }; assert.equal((await request()).status, 502); }
    assert.equal(state.writes, undefined);
  } finally { db.close(); }
});

test('Slack uncertain writes fence fresh drafts and projects durably until operator review', async () => {
  for (const failure of ['readback', 'wrongReadback', 'role', 'mapping', 'account', 'channel', 'provider', 'localReceipt']) {
    const { db, state, request, reviewed } = slackFixture();
    try {
      if (failure === 'localReceipt') { await reviewed(); db.exec("CREATE TRIGGER reject_slack_receipt BEFORE UPDATE ON integration_operations BEGIN SELECT RAISE(FAIL,'receipt unavailable'); END"); }
      state.onWrite = () => { if (failure === 'readback') state.readFailure = true; if (failure === 'wrongReadback') state.settings.defaultUsername = 'Wrong'; if (failure === 'role') state.roleAllowed = false; if (failure === 'mapping') state.mappingAllowed = false; if (failure === 'account') state.row.platformUserId = 'replacement'; if (failure === 'channel') state.settings.channelId = 'C-replacement'; };
      if (failure === 'provider') state.writeFailure = new IntegrationError(502, 'PROVIDER_UNAVAILABLE', 'No acknowledgement', true);
      const defaults = { defaultUsername: 'Requested', defaultIconUrl: '' };
      if (failure === 'localReceipt') { await assert.rejects(reviewed(defaults), /receipt unavailable/); db.exec('DROP TRIGGER reject_slack_receipt'); }
      else { const result = await reviewed(defaults); assert.equal(result.status, 409, failure); assert.equal(result.data.operation.status, 'uncertain', failure); }
      state.readFailure = false; state.roleAllowed = true; state.mappingAllowed = true; state.onWrite = null; state.writeFailure = null;
      const writes = state.writes, blocked = await reviewed({ defaultUsername: 'Fresh draft', defaultIconUrl: '' }); assert.equal(blocked.data.error.code, 'OPERATION_NOT_SENT', failure); assert.equal(blocked.data.operation.status, 'failed', failure); assert.equal(db.prepare('SELECT status FROM integration_operations WHERE id=?').get(blocked.data.operation.id).status, 'failed'); assert.equal((await reviewed({ defaultUsername: 'Other project', defaultIconUrl: '' }, { projectId: 'project-b' })).data.error.code, 'SLACK_PREVIOUS_OUTCOME_UNRESOLVED', failure); assert.equal(state.writes, writes, failure);
      db.prepare("UPDATE integration_operations SET status='reviewed-not-applied' WHERE request_key=(SELECT request_key FROM zernio_slack_mutations)").run(); assert.equal((await reviewed({ defaultUsername: '', defaultIconUrl: '' })).status, 200, failure);
    } finally { db.close(); }
  }
});

test('Slack native review UI validates resets, discards stale reads and retains drafts and keys on malformed app receipts', async () => {
  const source = await readFile(new URL('../src/ZernioAccounts.tsx', import.meta.url), 'utf8');
  const compile = (start, end, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))))});`)(...Object.values(context));
  for (const draft of [{ defaultUsername: '', defaultIconUrl: 'https://example.com/a.png' }, { defaultUsername: 'a'.repeat(81), defaultIconUrl: 'https://example.com/a.png' }, { defaultUsername: 'Name', defaultIconUrl: '' }, { defaultUsername: 'Name', defaultIconUrl: 'http://example.com/a.png' }, { defaultUsername: 'Name', defaultIconUrl: 'https://u:p@example.com/a.png' }]) assert.throws(compile('function intendedSlackDefaults()', '  async function readSlack(', { slackDraft: draft, clearSlackUsername: false, clearSlackIcon: false }), /Enter/);
  assert.deepEqual(compile('function intendedSlackDefaults()', '  async function readSlack(', { slackDraft: {}, clearSlackUsername: true, clearSlackIcon: true })(), { defaultUsername: '', defaultIconUrl: '' });
  const settings = { accountId: 'slack-a', teamId: 'T-one', channelId: 'C-one', teamName: 'Acme', channelName: 'Updates', accountVersion: 'c'.repeat(64), version: 'a'.repeat(64), defaultUsername: 'Current', defaultIconUrl: '' }, defaults = { defaultUsername: 'Requested', defaultIconUrl: '' };
  for (const departed of ['account', 'project', 'role', 'returnedToAccount']) {
    let finish, live = true, role = true; const accepted = [], reads = { current: 0 }, selection = { current: '/accounts:slack-a' };
    const load = compile('async function loadSlack(', '  async function saveSlack(', { selected: { _id: 'slack-a' }, path: '/accounts', current: () => live, selection, reads, manager: { get current() { return role; } }, action: async run => run(), intendedSlackDefaults: () => defaults, clearSlackUsername: false, clearSlackIcon: true, readSlack: () => new Promise(resolve => { finish = resolve; }), setSlack: value => accepted.push(value), setSlackReview: value => accepted.push(value), setSlackDraft: value => accepted.push(value), setClearSlackUsername: value => accepted.push(value), setClearSlackIcon: value => accepted.push(value) });
    const pending = load(true); if (departed === 'account') selection.current = '/accounts:other'; if (departed === 'project') live = false; if (departed === 'role') role = false; if (departed === 'returnedToAccount') reads.current++; finish(settings); await pending; assert.equal(accepted.length, 0, departed);
  }
  const keys = { current: new Map() }, calls = [], accepted = []; let response, failure;
  const write = compile('async function write(', '  async function save(', { selected: { _id: 'slack-a' }, current: () => true, path: '/accounts', keys, crypto: { randomUUID: () => 'slack-stable-key' }, requester: { current: async (...args) => { calls.push(args); if (failure) throw failure; return response; } } });
  const save = compile('async function saveSlack(', '  function intendedLanguages()', { selected: { _id: 'slack-a' }, slackReview: { settings, defaults, clearUsername: false, clearIcon: true }, current: () => true, manager: { current: true }, path: '/accounts', selection: { current: '/accounts:slack-a' }, reads: { current: 0 }, action: async run => run(), write, setSlack: value => accepted.push(value), setSlackDraft: value => accepted.push(value), setClearSlackUsername: value => accepted.push(value), setClearSlackIcon: value => accepted.push(value), setSlackReview: value => accepted.push(value), setNotice: value => accepted.push(value) });
  const good = { ...settings, ...defaults, version: 'b'.repeat(64), readback: true, operation: { id: 'slack-operation', status: 'complete' } };
  for (const malformed of [undefined, {}, { ...good, operation: undefined }, { ...good, operation: { id: 'slack-operation', status: 'pending' } }, { ...good, accountId: 'other' }, { ...good, readback: false }, { ...good, accountVersion: 'd'.repeat(64) }, { ...good, channelId: 'C-other' }, { ...good, defaultUsername: 'Wrong' }]) { response = malformed; await assert.rejects(save(), /draft and action key were retained/); assert.equal(keys.current.size, 1); assert.equal(accepted.length, 0); }
  failure = Object.assign(new Error('Unknown outcome'), { status: 409, code: 'OPERATION_UNCERTAIN' }); await assert.rejects(save(), /Unknown outcome/); assert.equal(keys.current.size, 1);
  failure = null; response = good; await save(); assert.equal(keys.current.size, 0); assert.deepEqual(accepted[1], defaults); assert.equal(new Set(calls.map(call => call[3])).size, 1);
  for (const departed of ['account', 'project', 'role', 'returnedToRole']) {
    let finish, live = true, role = true; const accepted = [], reads = { current: 0 }, selection = { current: '/accounts:slack-a' };
    const save = compile('async function saveSlack(', '  function intendedLanguages()', { selected: { _id: 'slack-a' }, slackReview: { settings, defaults, clearUsername: false, clearIcon: true }, current: () => live, manager: { get current() { return role; } }, path: '/accounts', selection, reads, action: async run => run(), write: () => new Promise(resolve => { finish = resolve; }), setSlack: value => accepted.push(value), setSlackDraft: value => accepted.push(value), setClearSlackUsername: value => accepted.push(value), setClearSlackIcon: value => accepted.push(value), setSlackReview: value => accepted.push(value), setNotice: value => accepted.push(value) });
    const pending = save(); if (departed === 'account') selection.current = '/accounts:other'; if (departed === 'project') live = false; if (departed === 'role') role = false; if (departed === 'returnedToRole') reads.current++; finish(good); await pending; assert.equal(accepted.length, 0, departed);
  }
  const markup = source.slice(source.indexOf("      {selected.platform === 'slack'"), source.indexOf("      {selected.platform === 'telegram'"));
  const { code } = await transformWithOxc(`const render = () => <div>${markup}</div>;`, 'SlackView.tsx', { jsx: { runtime: 'classic' } });
  for (const canManage of [false, true]) {
    const context = { React, selected: { _id: 'slack-a', platform: 'slack' }, busy: false, loadSlack() {}, slack: settings, canManage, slackDraft: defaults, clearSlackUsername: false, clearSlackIcon: true, setSlackDraft() {}, setSlackReview() {}, setClearSlackUsername() {}, setClearSlackIcon() {}, slackReview: { settings, defaults }, saveSlack() {}, name: () => 'Updates' };
    const html = renderToStaticMarkup(new Function(...Object.keys(context), code + '; return render;')(...Object.values(context))()); assert.match(html, /Load Slack identity/); assert.match(html, /Per-post username and icon URL override/); assert.match(html, /APP badge/); assert.equal(html.includes('Confirm and save Slack identity'), canManage); if (canManage) { assert.match(html, /type="url"/); assert.match(html, /Review Slack identity change/); assert.match(html, /Clear default author name/); assert.match(html, /Clear default avatar/); }
  }
});

test('Bluesky malformed app success retains its reviewed draft and action key until exact readback arrives', async () => {
  const source = await readFile(new URL('../src/ZernioAccounts.tsx', import.meta.url), 'utf8');
  const compile = (start, end, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))))});`)(...Object.values(context));
  const keys = { current: new Map() }, accepted = [], calls = []; let response = { accountId: 'other' };
  const write = compile('async function write(', '  async function save(', { selected: { _id: 'blue-a' }, current: () => true, path: '/accounts', keys, crypto: { randomUUID: () => 'blue-stable-key' }, requester: { current: async (...args) => { calls.push(args); return response; } } });
  const save = compile('async function saveBluesky(', '  function intendedCommands()', { selected: { _id: 'blue-a' }, blueskyReview: { settings: { accountId: 'blue-a', version: 'a'.repeat(64) }, defaultLangs: ['fr'] }, current: () => true, manager: { current: true }, path: '/accounts', selection: { current: '/accounts:blue-a' }, reads: { current: 0 }, action: async run => run(), write, setBluesky: value => accepted.push(value), setLanguageText: value => accepted.push(value), setClearLanguages: value => accepted.push(value), setBlueskyReview: value => accepted.push(value), setNotice: value => accepted.push(value) });
  await assert.rejects(save(), /draft and action key were retained/); assert.equal(keys.current.size, 1); assert.equal(accepted.length, 0);
  response = { accountId: 'blue-a', defaultLangs: ['fr'], version: 'b'.repeat(64), readback: true }; await save(); assert.equal(keys.current.size, 0); assert.equal(calls[0][3], calls[1][3]); assert.equal(accepted[1], 'fr');
});

test('Slack real transport accepts documented empty PATCH receipts, uses native fields and fences malformed or lost responses', async () => {
  const db = new DatabaseSync(':memory:'), original = globalThis.fetch, row = { ...account('slack-a', 'slack'), platformUserId: 'channel-one' }, calls = []; let defaults = { defaultUsername: 'Current', defaultIconUrl: 'https://images.example/current.png' }, receipt = 'empty', sequence = 0;
  async function invoke(body) {
    let response;
    await handleIntegration({ db, project: { id: 'project-a', zernioProfileId: profileId }, role: 'owner', req: { method: body === undefined ? 'GET' : 'POST', headers: { 'idempotency-key': `slack-router-${++sequence}` } }, url: new URL('http://localhost/api/projects/project-a/integrations/accounts/slack-a/slack-settings'), body: body || {}, config: { env: { ZERNIO_API_KEY: 'fixture-secret' } }, assertProjectMapping(expected) { assert.equal(expected, profileId); }, send(status, data) { response = { status, data }; } }); return response;
  }
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); calls.push({ url, options }); assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.headers.Authorization, 'Bearer fixture-secret');
    if (url.pathname === '/api/v1/accounts') { assert.equal(url.searchParams.get('profileId'), profileId); return Response.json({ accounts: [row] }); }
    assert.equal(url.pathname, '/api/v1/accounts/slack-a/slack-settings'); assert.equal(url.search, '');
    if (options.method === 'GET') return Response.json({ account: { _id: row._id, platform: 'slack', teamId: 'T-one', teamName: 'Acme', channelId: 'C-one', channelName: 'Updates', ...defaults } });
    assert.equal(options.method, 'PATCH'); assert.match(options.headers['Idempotency-Key'], /^slack-router-/); const body = JSON.parse(options.body); assert.deepEqual(Object.keys(body), ['defaultUsername', 'defaultIconUrl']); defaults = body;
    if (receipt === 'lost') throw new Error('Lost acknowledgement');
    return new Response(receipt === 'malformed' ? '{not json' : '', { status: 200 });
  };
  const payload = (snapshot, clear = false) => ({ defaultUsername: clear ? '' : 'Support', defaultIconUrl: '', clearUsername: clear, clearIcon: true, expectedVersion: snapshot.data.version, confirmed: true });
  try {
    let snapshot = await invoke(), saved = await invoke(payload(snapshot)); assert.equal(saved.status, 200); assert.equal(saved.data.readback, true); assert.equal(saved.data.defaultUsername, 'Support');
    snapshot = await invoke(); saved = await invoke(payload(snapshot, true)); assert.equal(saved.status, 200); assert.equal(saved.data.defaultUsername, ''); assert.equal(saved.data.defaultIconUrl, '');
    snapshot = await invoke(); receipt = 'malformed'; saved = await invoke(payload(snapshot)); assert.equal(saved.status, 409); assert.equal(saved.data.operation.status, 'uncertain');
    const writes = calls.filter(call => call.options.method === 'PATCH').length, uncertainId = saved.data.operation.id; snapshot = await invoke(); saved = await invoke(payload(snapshot, true)); assert.equal(saved.data.error.code, 'OPERATION_NOT_SENT'); assert.equal(saved.data.operation.status, 'failed'); assert.notEqual(saved.data.operation.id, uncertainId); assert.equal(calls.filter(call => call.options.method === 'PATCH').length, writes);
    db.prepare("UPDATE integration_operations SET status='reviewed-not-applied' WHERE status='uncertain'").run(); snapshot = await invoke(); receipt = 'lost'; saved = await invoke(payload(snapshot, true)); assert.equal(saved.data.operation.status, 'uncertain');
  } finally { globalThis.fetch = original; db.close(); }
});
