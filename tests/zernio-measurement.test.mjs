import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { handleZernioMeasurement } from '../server/zernio-measurement.mjs';
import { handleIntegration } from '../server/integrations.mjs';
import { IntegrationError } from '../server/provider-core.ts';

const profileId = 'profile-a', platforms = ['metaads', 'googleads', 'linkedinads', 'tiktokads', 'pinterestads', 'xads', 'openaiads', 'redditads'];
const pixel = (platform, id = `${platform}-pixel`) => ({ id, name: 'Website pixel', platform, kind: 'pixel', status: 'active', siteTagId: `site-${id}`, lastFiredTime: null, installed: false, code: '<script>example("public-pixel-id")</script>', secret: 'must-not-escape' });
function setup() {
  const db = new DatabaseSync(':memory:'), calls = [], state = { accounts: platforms.map(platform => ({ _id: platform, platform, profileId, isActive: true, displayName: platform })), tags: new Map(platforms.map(platform => [platform, [pixel(platform)]])), natives: [{ id: 'ad-a', name: 'Project advertiser', currency: 'USD', selectable: true }, { id: 'ad-b', name: 'Other advertiser', currency: 'USD', selectable: true }], list: null, receipt: null, detail: null, events: null, diagnostics: null, fail: false, readbackFail: false, created: false, hold: null, destinations: [{ id: 'reddit-pixel-a', name: 'Selected advertiser pixel', status: 'active', adAccountId: 'ad-a' }, { id: 'reddit-pixel-b', name: 'Other advertiser pixel', status: 'active', adAccountId: 'ad-b' }] };
  state.accounts.push({ _id: 'foreign', platform: 'metaads', profileId: 'other-profile', isActive: true });
  let sequence = 0;
  const api = async (path, query = {}, body, key, method = body === undefined ? 'GET' : 'POST') => {
    calls.push({ path, query, body, key, method });
    if (path === '/accounts') { assert.equal(query.profileId, profileId); return { accounts: structuredClone(state.accounts) }; }
    if (path === '/ads/accounts') { assert.equal(query.inScopeOnly, true); return { accounts: structuredClone(state.natives) }; }
    const match = /^\/accounts\/([^/]+)\/(tracking-tags|conversion-destinations)(?:\/([^/]+)(?:\/(events|diagnostics))?)?$/.exec(path); assert.ok(match, path);
    const platform = match[1], rows = state.tags.get(platform), id = match[3];
    if (match[2] === 'conversion-destinations') return { platform, destinations: structuredClone(state.destinations) };
    if (method === 'POST' || method === 'PATCH') {
      state.onWrite?.(); if (state.hold) await state.hold;
      if (state.fail) throw new IntegrationError(502, 'PROVIDER_UNAVAILABLE', 'Synthetic provider failure', true);
      const row = method === 'POST' ? pixel(platform, `created-${++sequence}`) : rows.find(row => row.id === id); assert.ok(row); row.name = body.name; if (method === 'POST') rows.push(row); state.created = true;
      return state.receipt || { platform, tag: structuredClone(row), privateKey: 'must-not-escape' };
    }
    if (!id) { assert.equal(query.adAccountId, 'ad-a'); if (state.created && state.readbackFail) throw new IntegrationError(502, 'PROVIDER_UNAVAILABLE', 'Readback failed'); return state.list || { platform, tags: structuredClone(rows) }; }
    if (match[4] === 'events') return state.events || { platform, events: [{ id: 'purchase', name: 'Purchase', type: 'PURCHASE', siteEventId: 'site-purchase', status: 'active', secret: 'must-not-escape' }] };
    if (match[4] === 'diagnostics') return state.diagnostics || { platform, checks: [{ key: 'events', title: 'Recent events', description: 'No missing parameters', result: 'ok', actionUrl: 'javascript:alert(1)', secret: 'must-not-escape' }] };
    return state.detail || { platform, tag: structuredClone(rows.find(row => row.id === id)) };
  };
  let serial = 0;
  async function request(action, { body, key = `measurement-${++serial}`, role = 'owner', method = body === undefined ? 'GET' : 'POST' } = {}) {
    let response;
    const context = { db, project: { id: 'project-a', zernioProfileId: profileId }, role, req: { method, headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/project-a/integrations/measurement/${action}`), body: body || {}, send(status, data) { response = { status, data }; } };
    try { const handled = await handleZernioMeasurement(context, api, profileId, context.url.pathname.split('/measurement/')[1]); return response || { handled }; }
    catch (error) { if (!(error instanceof IntegrationError)) throw error; return { status: error.status, data: { error: { code: error.code, message: error.message } } }; }
  }
  return { db, calls, state, request };
}

test('measurement discovery scopes connections, native advertisers, Reddit pixels and every supported tag platform', async () => {
  const { db, calls, state, request } = setup();
  try {
    const connections = await request('accounts', { role: 'viewer' }); assert.equal(connections.status, 200); assert.equal(connections.data.accounts.length, 8); assert.equal(JSON.stringify(connections).includes('foreign'), false);
    let result = await request('redditads/ad-accounts'); assert.equal(result.status, 200); assert.equal(result.data.accounts.length, 2);
    result = await request('redditads/tags?adAccountId=ad-a'); assert.equal(result.status, 200); assert.deepEqual(result.data.tags.map(row => row.id), ['reddit-pixel-a']); assert.equal(result.data.canCreate, false); assert.equal(JSON.stringify(result).includes('Other advertiser pixel'), false);
    result = await request('redditads/tags/reddit-pixel-a?adAccountId=ad-a'); assert.equal(result.status, 200); assert.match(result.data.instructions, /already|fired/);
    const before = calls.length; assert.equal((await request('foreign/tags?adAccountId=ad-a')).status, 403); assert.equal(calls.length, before + 1);
    for (const platform of platforms.filter(name => name !== 'redditads')) { result = await request(`${platform}/tags?adAccountId=ad-a`); assert.equal(result.status, 200, platform); assert.equal(result.data.tags[0].platform, platform); assert.equal(result.data.tags[0].code, undefined); assert.equal(JSON.stringify(result).includes('must-not-escape'), false); }
    const reads = calls.length; assert.equal((await request('redditads/tags?adAccountId=foreign-advertiser')).status, 403); assert.equal(calls.length, reads + 2);
    assert.equal((await request('redditads/tags/reddit-pixel-b?adAccountId=ad-a')).status, 403);
    state.destinations[0].adAccountId = undefined; assert.equal((await request('redditads/tags?adAccountId=ad-a')).status, 502);
  } finally { db.close(); }
});

test('tag detail, installation code, event definitions and Meta diagnostics validate scope and omit private provider fields', async () => {
  const { db, state, calls, request } = setup();
  try {
    let result = await request('metaads/tags/metaads-pixel?adAccountId=ad-a'); assert.equal(result.status, 200); assert.match(result.data.tag.code, /<script>/); assert.equal(result.data.tag.siteTagId, 'site-metaads-pixel'); assert.equal(JSON.stringify(result).includes('must-not-escape'), false);
    result = await request('openaiads/tags/openaiads-pixel/events?adAccountId=ad-a'); assert.equal(result.status, 200); assert.equal(result.data.events[0].siteEventId, 'site-purchase'); assert.equal(JSON.stringify(result).includes('must-not-escape'), false);
    result = await request('metaads/tags/metaads-pixel/diagnostics?adAccountId=ad-a'); assert.equal(result.status, 200); assert.equal(result.data.checks[0].result, 'ok'); assert.equal(JSON.stringify(result).includes('javascript:'), false);
    const before = calls.length; assert.equal((await request('metaads/tags/private-pixel?adAccountId=ad-a')).status, 403); assert.equal(calls.length, before + 3, 'An unlisted tag must never be read directly.');
    assert.equal((await request('googleads/tags/googleads-pixel/diagnostics?adAccountId=ad-a')).status, 422);
    for (const malformed of [{ platform: 'other', tags: [pixel('metaads')] }, { platform: 'metaads', tags: [pixel('googleads')] }, { platform: 'metaads', tags: [{ ...pixel('metaads'), installed: {} }] }, { platform: 'metaads', tags: [pixel('metaads'), pixel('metaads')] }, { platform: 'metaads', tags: [pixel('metaads')], hasMore: true }]) { state.list = malformed; assert.equal((await request('metaads/tags?adAccountId=ad-a')).status, 502); } state.list = null;
    state.detail = { platform: 'metaads', tag: pixel('metaads', 'different-pixel') }; assert.equal((await request('metaads/tags/metaads-pixel?adAccountId=ad-a')).status, 502); state.detail = null;
    state.events = { platform: 'openaiads', events: [{ id: 'event', name: {} }] }; assert.equal((await request('openaiads/tags/openaiads-pixel/events?adAccountId=ad-a')).status, 502);
    state.diagnostics = { platform: 'metaads', checks: [{ title: {} }] }; assert.equal((await request('metaads/tags/metaads-pixel/diagnostics?adAccountId=ad-a')).status, 502);
  } finally { db.close(); }
});

test('tag creation and Meta rename use administrative permissions, receipt/readback guards and exact-key replay', async () => {
  const { db, calls, request } = setup(); const body = { adAccountId: 'ad-a', name: 'New website pixel' };
  try {
    for (const role of ['viewer', 'editor']) { const before = calls.length; assert.equal((await request('metaads/tags/create', { body, role })).status, 403); assert.equal(calls.length, before); }
    for (const platform of platforms.filter(name => name !== 'redditads')) { const result = await request(`${platform}/tags/create`, { body: { ...body, ...(platform === 'openaiads' ? { defaultEventType: 'order_created' } : {}) }, key: `create-${platform}` }); assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.tag.name, body.name); assert.equal(JSON.stringify(result).includes('must-not-escape'), false); }
    const writes = calls.filter(call => call.method === 'POST').length; assert.equal((await request('metaads/tags/create', { body, key: 'create-metaads' })).status, 200); assert.equal(calls.filter(call => call.method === 'POST').length, writes);
    assert.equal((await request('metaads/tags/metaads-pixel/update', { body: { ...body, name: 'Renamed pixel' }, key: 'rename-meta-pixel' })).status, 200); assert.equal(calls.findLast(call => call.method === 'PATCH').body.name, 'Renamed pixel');
    assert.equal((await request('redditads/tags/create', { body })).status, 422); assert.equal((await request('openaiads/tags/openaiads-pixel/update', { body })).status, 422);
    for (const invalid of [{ ...body, name: '' }, { ...body, accessToken: 'private' }, { ...body, defaultEventType: 'order_created' }, { ...body, adAccountId: 'outside' }]) assert.ok((await request('metaads/tags/create', { body: invalid })).status >= 400);
    assert.equal((await request('tiktokads/tags/create', { body: { ...body, name: 'Emoji 😀 pixel' } })).status, 400);
  } finally { db.close(); }
});

test('unreadable or lost pixel receipts block changed-name duplicate creation until the operator reviews the unknown outcome', async () => {
  for (const mode of ['receipt', 'readback', 'network']) {
    const { db, calls, state, request } = setup(); const body = { adAccountId: 'ad-a', name: 'Uncertain pixel' };
    try {
      if (mode === 'receipt') state.receipt = { platform: 'openaiads', tag: { id: 'broken-receipt' } }; if (mode === 'readback') state.readbackFail = true; if (mode === 'network') state.fail = true;
      let result = await request('openaiads/tags/create', { body, key: `unknown-${mode}` }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); const before = calls.filter(call => call.method === 'POST').length;
      state.receipt = null; state.readbackFail = false; state.fail = false;
      result = await request('openaiads/tags/create', { body: { ...body, name: 'Changed retry name' }, key: `fresh-${mode}` }); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'OPERATION_UNCERTAIN'); assert.equal(calls.filter(call => call.method === 'POST').length, before);
      db.prepare("UPDATE integration_operations SET status='reviewed-not-applied' WHERE request_key=?").run(`unknown-${mode}`);
      result = await request('openaiads/tags/create', { body: { ...body, name: 'Changed retry name' }, key: `fresh-${mode}` }); assert.equal(result.status, 200, 'A rejected duplicate must not leave a failed receipt that prevents use after review.');
    } finally { db.close(); }
  }
});

test('pixel UI retains operation keys after malformed app receipts and stops stale writes before another provider request', async () => {
  const source = await readFile(new URL('../src/ZernioMeasurement.tsx', import.meta.url), 'utf8'), handler = stripTypeScriptTypes(source.slice(source.indexOf('async function write('), source.indexOf('  async function save(')));
  const keys = { current: new Map() }, calls = []; let active = true, response = {};
  const context = { current: () => active, account: { platform: 'metaads' }, keys, crypto: { randomUUID: () => 'fixed-pixel-operation' }, requester: { current: async (...args) => { calls.push(args); return response; } } };
  const write = new Function(...Object.keys(context), `return (${handler});`)(...Object.values(context));
  await assert.rejects(write('/pixel/create', { name: 'Retain key' })); assert.equal(keys.current.size, 1);
  response = { platform: 'metaads', tag: { id: 'confirmed-pixel' } }; await write('/pixel/create', { name: 'Retain key' }); assert.equal(keys.current.size, 0); assert.equal(calls[0][3], calls[1][3]);
  active = false; await assert.rejects(write('/pixel/create', { name: 'Other' }), { name: 'AbortError' }); assert.equal(calls.length, 2);
});

test('returning to a prior measurement account or role never revives its previous in-flight view', async () => {
  const source = await readFile(new URL('../src/ZernioMeasurement.tsx', import.meta.url), 'utf8'), line = source.match(/  if \(scope.current.identity !== identity\) scope.current = \{ identity \};/)[0], update = new Function('scope', 'identity', line);
  const scope = { current: { identity: 'project-a:account-a:owner' } }, mounted = { current: true }, view = scope.current;
  const expression = source.match(/current = (\(\) => mounted.current && scope.current === view)/)[1], current = new Function('mounted', 'scope', 'view', `return (${expression});`)(mounted, scope, view);
  assert.equal(current(), true); update(scope, 'project-b:account-b:owner'); update(scope, 'project-a:account-a:owner'); assert.equal(current(), false);
  const roleView = scope.current, roleCurrent = new Function('mounted', 'scope', 'view', `return (${expression});`)(mounted, scope, roleView); update(scope, 'project-a:account-a:viewer'); update(scope, 'project-a:account-a:owner'); assert.equal(roleCurrent(), false);
});

test('measurement write keys survive server failures and pending receipts until a definite client failure', async () => {
  const source = await readFile(new URL('../src/ZernioMeasurement.tsx', import.meta.url), 'utf8'), handler = stripTypeScriptTypes(source.slice(source.indexOf('async function write('), source.indexOf('  async function save(')));
  const keys = { current: new Map() }, calls = []; let failure, sequence = 0;
  const context = { current: () => true, account: { platform: 'metaads' }, keys, crypto: { randomUUID: () => `measurement-key-${++sequence}` }, requester: { current: async (...args) => { calls.push(args); if (failure) throw Object.assign(new Error('Request failed'), failure); return { platform: 'metaads', tag: { id: 'pixel-a' } }; } } };
  const write = new Function(...Object.keys(context), `return (${handler});`)(...Object.values(context));
  for (const receipt of [{ status: 502 }, { status: 409, code: 'OPERATION_UNCERTAIN' }, { status: 409, code: 'OPERATION_IN_PROGRESS' }, { status: 409, code: 'OPERATION_PENDING' }, { status: 409, operation: { status: 'pending' } }, { status: 400, operation: { status: 'uncertain' } }]) {
    failure = receipt; await assert.rejects(write('/pixel/create', { name: 'Pixel' })); assert.equal(keys.current.size, 1, JSON.stringify(receipt)); const retained = calls.at(-1)[3];
    failure = null; await write('/pixel/create', { name: 'Pixel' }); assert.equal(calls.at(-1)[3], retained); assert.equal(keys.current.size, 0);
  }
  failure = { status: 400, code: 'INVALID_MEASUREMENT_SETTINGS', operation: { status: 'failed' } }; await assert.rejects(write('/pixel/create', { name: 'Pixel' })); assert.equal(keys.current.size, 0); const rejected = calls.at(-1)[3];
  failure = null; await write('/pixel/create', { name: 'Pixel' }); assert.notEqual(calls.at(-1)[3], rejected);
});

test('the integration router authenticates scoped measurement requests and preserves unknown creation when mapping changes after a write', async () => {
  const original = globalThis.fetch, db = new DatabaseSync(':memory:'), project = { id: 'project-a', zernioProfileId: profileId }; let changed = false, writes = 0;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.headers.Authorization, 'Bearer fixture-key');
    if (url.pathname === '/api/v1/accounts') return Response.json({ accounts: [{ _id: 'openaiads', platform: 'openaiads', profileId, isActive: true }] });
    if (url.pathname === '/api/v1/ads/accounts') return Response.json({ accounts: [{ id: 'ad-a', currency: 'USD', selectable: true }] });
    assert.equal(url.pathname, '/api/v1/accounts/openaiads/tracking-tags');
    if (options.method === 'GET') return Response.json({ platform: 'openaiads', tags: [] });
    writes++; changed = true; return Response.json({ platform: 'openaiads', tag: pixel('openaiads', 'new-pixel') });
  };
  async function invoke(action, body, role = 'owner', key = 'measurement-router-create') {
    let response; const method = body === undefined ? 'GET' : 'POST';
    await handleIntegration({ db, project, role, req: { method, headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/project-a/integrations/measurement/${action}`), body: body || {}, config: { env: {}, ZERNIO_API_KEY: 'fixture-key' }, assertProjectMapping(expected) { if (changed || expected !== profileId) throw new Error('Mapping changed'); }, send(status, data) { response = { status, data }; } }); return response;
  }
  try {
    assert.equal((await invoke('accounts', undefined, 'viewer')).status, 200);
    assert.equal((await invoke('openaiads/tags/create', { adAccountId: 'ad-a', name: 'Router pixel' }, 'editor')).status, 403); assert.equal(writes, 0);
    let result = await invoke('openaiads/tags/create', { adAccountId: 'ad-a', name: 'Router pixel' }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(writes, 1);
    changed = false; result = await invoke('openaiads/tags/create', { adAccountId: 'ad-a', name: 'Changed retry' }, 'owner', 'measurement-router-retry'); assert.equal(result.status, 409); assert.equal(writes, 1);
  } finally { globalThis.fetch = original; db.close(); }
});

test('rendered pixel controls preserve API versus website IDs, escape snippets and restrict writes and unsupported Reddit operations', async () => {
  const source = await readFile(new URL('../src/ZernioMeasurement.tsx', import.meta.url), 'utf8'), start = source.indexOf('  return <section'), end = source.lastIndexOf('\n}');
  const { code } = await transformWithOxc(`const render = () => (${source.slice(start + '  return '.length, end).trim().replace(/;$/, '')});`, 'MeasurementView.tsx', { jsx: { runtime: 'classic' } });
  function render(platform, canManage) {
    const account = { _id: platform, platform, canCreate: platform !== 'redditads', canRename: platform === 'metaads', canDiagnose: platform === 'metaads' }, selected = pixel(platform);
    const context = { React, busy: false, loading: false, loaded: true, accounts: [account], nativeAccounts: [{ id: 'ad-a' }], account, accountId: platform, adAccountId: 'ad-a', tags: [selected], selected, events: [], checks: [], error: '', notice: '', canManage, labels: { [platform]: platform }, eventTypes: [], action() {}, refresh() {}, setAccountId() {}, setAdAccountId() {}, inspect() {}, loadMore() {}, save() {} };
    return renderToStaticMarkup(new Function(...Object.keys(context), code + '; return render;')(...Object.values(context))());
  }
  const reader = render('metaads', false); assert.match(reader, /Campaign pixel ID/); assert.match(reader, /Website tag ID/); assert.match(reader, /&lt;script&gt;/); assert.doesNotMatch(reader, /<script>/); assert.doesNotMatch(reader, /Create tracking tag|Rename tag/);
  assert.match(render('metaads', true), /Create tracking tag/); assert.match(render('metaads', true), /Rename tag/);
  const reddit = render('redditads', true); assert.match(reddit, /Reddit requires a pixel for every campaign goal/); assert.doesNotMatch(reddit, /Create tracking tag|Load conversion events|Check pixel diagnostics/);
});
