import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { handleZernioAccounts } from '../server/zernio-accounts.mjs';
import { handleIntegration, IntegrationError } from '../server/integrations.mjs';

const profileId = 'profile-a';
const account = (id = 'instagram-a', platform = 'instagram') => ({ _id: id, platform, profileId, isActive: true, displayName: 'Acme', username: '@acme' });
const healthy = row => ({ accountId: row._id, platform: row.platform, status: 'healthy', canPost: true, canFetchAnalytics: true, tokenValid: true, needsReconnect: false, issues: [] });
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
    state.updateReceipt = {}; result = await write('whatsapp-a/update', { displayName: 'Unreadable receipt' }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); state.updateReceipt = null;
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
    let result = await request('instagram-a/disconnect', { method: 'POST', body: { confirmAccountId: 'instagram-a' } }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'PROVIDER_RESOURCE_BUSY'); assert.equal(calls.filter(call => call.method === 'DELETE').length, 0);
    release(); state.hold = null; assert.equal((await pending).status, 200);
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
  const source = await readFile(new URL('../src/ZernioAccounts.tsx', import.meta.url), 'utf8'), start = source.indexOf('  return <section'), end = source.lastIndexOf('\n}');
  const { code } = await transformWithOxc(`const render = () => (${source.slice(start + '  return '.length, end).trim().replace(/;$/, '')});`, 'AccountsView.tsx', { jsx: { runtime: 'classic' } });
  const selected = { _id: 'wa', platform: 'whatsapp', displayName: 'Support number', username: '+12025550101', health: null, canReconnect: true };
  const shown = { status: 'error', tokenStatus: { valid: true }, issues: ['WhatsApp channel disconnected'], recommendations: ['Reconnect the number'], permissions: { canPost: false, canFetchAnalytics: false, posting: [{ scope: 'messages', granted: false, required: true }], analytics: [], optional: [], missingRequired: ['messages'] }, platformConnection: { status: 'disconnected', inboundWebhookSubscribed: false } };
  function render(canManage) {
    const context = { React, busy: false, loaded: true, accounts: [selected], selected, selectedId: selected._id, detail: shown, shown, draft: { displayName: '', username: '', analytics: '', inbox: '' }, error: '', notice: '', authUrl: '', canManage, action() {}, loadAccounts() {}, choose() {}, checkSelected() {}, reconnect() {}, disconnect() {}, save() {}, setDraft() {}, name: row => row.displayName, yes: value => value == null ? 'Not reported' : value ? 'Yes' : 'No', when: () => 'Not reported' };
    const html = renderToStaticMarkup(new Function(...Object.keys(context), code + '; return render;')(...Object.values(context))()); return html.replace(/<[^>]*>/g, ' ');
  }
  const viewer = render(false), admin = render(true); assert.match(viewer, /WhatsApp platform link:.*disconnected/); assert.match(viewer, /valid token alone does not confirm/); assert.match(viewer, /Inbound webhook subscribed:.*No/); assert.match(viewer, /Permission details/); assert.doesNotMatch(viewer, /Disconnect account|Save account settings|Reconnect account/); assert.match(admin, /Reconnect account/); assert.match(admin, /Save account settings/);
});
