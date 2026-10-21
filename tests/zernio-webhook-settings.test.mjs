import test from 'node:test';
import assert from 'node:assert/strict';
import { handleWebhookSettings } from '../server/zernio-webhook-settings.ts';
import { IntegrationError } from '../server/provider-core.ts';
import { postgresSkip, testDatabase } from './postgres.mjs';

const pg = { skip: postgresSkip };

const callback = 'https://campaign.example/api/webhooks/zernio', hookId = 'abcdef123456abcdef123456';
async function fixture(t) {
  const { db, sql } = await testDatabase(t), calls = [], state = { rows: [], logs: [], writes: 0, reject: false, unreadableAfterWrite: false, lostWrite: false };
  const api = async (path, query = {}, body, key, method = body === undefined ? 'GET' : 'POST') => {
    calls.push({ path, query, body, key, method });
    if (path === '/webhooks/logs') return { logs: structuredClone(state.logs.filter(row => row.webhookId === query.webhookId && (!query.eventId || row.eventId === query.eventId) && (!query.status || row.status === query.status)).slice(query.skip || 0, (query.skip || 0) + query.limit)), pagination: { hasMore: false } };
    if (method === 'GET') { if (state.unreadableAfterWrite && state.writes) throw new IntegrationError(400, 'PROVIDER_REJECTED', 'Readback rejected'); return { webhooks: structuredClone(state.rows) }; }
    if (state.reject) throw new IntegrationError(400, 'PROVIDER_REJECTED', 'Settings rejected');
    state.writes++;
    if (path === '/webhooks/test' || path === '/webhooks/logs/redeliver') { if (state.lostTest) throw new IntegrationError(502, 'PROVIDER_UNAVAILABLE', 'Test acknowledgement lost', true); return { success: true }; }
    if (method === 'DELETE') { state.rows = state.rows.filter(row => row._id !== query.webhookId); return { success: true }; }
    const row = method === 'PUT' ? state.rows.find(row => row._id === body.webhookId) : { _id: hookId, failureCount: 0 };
    Object.assign(row, body); if (state.deniedGroups) row.disabledResourceGroups = [...new Set([...(row.disabledResourceGroups || []), ...state.deniedGroups])]; if (method === 'POST') state.rows.push(row);
    if (state.lostWrite) throw new IntegrationError(502, 'PROVIDER_UNAVAILABLE', 'Lost acknowledgement', true);
    return { success: true, webhook: structuredClone(row) };
  };
  let count = 0;
  async function request(action = '', body, options = {}) {
    let output;
    const context = { db, project: { id: options.projectId || 'project-a' }, user: { isOperator: options.operator ?? true }, role: options.role || 'owner', config: { appUrl: 'https://campaign.example', env: { ZERNIO_WEBHOOK_SECRET: 'private-fixture-signing-secret-never-return' } }, req: { method: body === undefined ? 'GET' : 'POST', headers: { 'idempotency-key': options.key || `webhook-key-${++count}` } }, url: new URL(`https://campaign.example/api/projects/project-a/integrations/webhook-settings/${action}`), body, send(status, data) { output = { status, data }; } };
    try { const handled = await handleWebhookSettings(context, api, options.profileId || 'profile-a', action.split('?')[0]); return output || { handled }; }
    catch (error) { if (!(error instanceof IntegrationError)) throw error; return { status: error.status, data: { error: { code: error.code } } }; }
  }
  return { db, sql, state, calls, request };
}
const input = { name: 'Campaign updates', events: ['post.published', 'message.received'], isActive: true, confirm: true };
const review = async setup => (await setup.request()).data.webhooks[0];

test('webhook administration requires both operator and workspace administration before upstream reads', pg, async t => {
  const f = await fixture(t);
  for (const options of [{ operator: false }, { role: 'editor' }, { role: 'viewer' }]) assert.equal((await f.request('', undefined, options)).status, 403);
  assert.deepEqual(f.calls, []);
});

test('project webhook create, edit, synthetic test and removal verify scope and never expose the signing secret', pg, async t => {
  const f = await fixture(t);
  f.state.rows.push({ _id: '111111111111111111111111', url: 'https://foreign.example/secret-path', profileIds: ['other-profile'], secret: 'foreign-secret', name: 'Private endpoint' });
  const created = await f.request('create', input, { key: 'webhook-create-key' }); assert.equal(created.status, 200); assert.equal(created.data.webhook.url, callback); assert.deepEqual(created.data.webhook.profileIds, ['profile-a']);
  assert.equal(JSON.stringify(created).includes('secret'), false);
  assert.equal((await f.request('create', input, { key: 'webhook-create-key' })).status, 200); assert.equal(f.state.writes, 1);
  assert.equal((await f.request('create', input)).status, 409); assert.equal(f.state.writes, 1);
  let row = await review(f); assert.equal(row.id, hookId); assert.equal((await f.request()).data.webhooks.length, 1);
  assert.equal((await f.request(`${hookId}/test`, { expectedVersion: row.version, confirm: true })).status, 200);
  assert.equal((await f.request(`${hookId}/update`, { ...input, name: 'Paused updates', isActive: false, expectedVersion: row.version })).status, 200);
  row = await review(f); assert.equal(row.isActive, false);
  assert.equal((await f.request(`${hookId}/delete`, { expectedVersion: row.version, confirm: true })).status, 200);
  assert.equal((await f.request()).data.webhooks.length, 0); assert.equal(f.state.rows.length, 1);
  assert.ok(f.calls.every(call => !call.body || call.body.url === undefined || call.body.url === callback));
});

test('changed settings, foreign hooks, unsupported events and unreviewed actions stop before dispatch', pg, async t => {
  const f = await fixture(t);
  assert.equal((await f.request('create', { ...input, events: ['call.received'] })).status, 400);
  assert.equal((await f.request('create', { ...input, confirm: false })).status, 400);
  assert.equal((await f.request('create', { ...input, url: 'https://attacker.example' })).status, 400);
  await f.request('create', input); const row = await review(f), writes = f.state.writes;
  f.state.rows[0].events.push('post.failed');
  assert.equal((await f.request(`${hookId}/delete`, { expectedVersion: row.version, confirm: true })).status, 409);
  assert.equal((await f.request('111111111111111111111111/logs')).status, 404);
  assert.equal(f.state.writes, writes);
  f.state.rows[0].customHeaders = { Authorization: 'private-header' };
  const advanced = await review(f); assert.equal(advanced.editable, false); assert.equal(JSON.stringify(advanced).includes('private-header'), false);
  assert.equal((await f.request(`${hookId}/delete`, { expectedVersion: advanced.version, confirm: true })).status, 409);
});

test('logs expose delivery metadata only and redelivery requires a real failed event from this endpoint', pg, async t => {
  const f = await fixture(t);
  await f.request('create', input); const row = await review(f);
  f.state.logs = [{ webhookId: hookId, eventId: 'event-one', event: 'message.received', status: 'failed', createdAt: new Date().toISOString(), statusCode: 503, attemptNumber: 7, requestPayload: { text: 'private message' }, responseBody: 'private response', errorMessage: 'private diagnostics' }];
  const history = await f.request(`${hookId}/logs`); assert.equal(history.status, 200); assert.equal(history.data.logs[0].statusCode, 503); assert.equal(JSON.stringify(history).includes('private'), false);
  const body = { expectedVersion: row.version, confirm: true, eventId: 'event-one' };
  assert.equal((await f.request(`${hookId}/redeliver`, body)).status, 200);
  assert.equal((await f.request(`${hookId}/redeliver`, { ...body, eventId: 'foreign-event' })).status, 409);
  f.state.logs[0].test = true; assert.equal((await f.request(`${hookId}/redeliver`, body)).status, 409);
  delete f.state.logs[0].test; f.state.logs[0].event = 'webhook.test'; assert.equal((await f.request(`${hookId}/logs`)).data.logs[0].test, true); assert.equal((await f.request(`${hookId}/redeliver`, body)).status, 409);
  const writes = f.state.writes; assert.equal((await f.request(`${hookId}/logs?skip=-1`)).status, 400); assert.equal(f.state.writes, writes);
});

test('unknown webhook writes fence new keys and remapped projects; known rejection remains retryable', pg, async t => {
  const f = await fixture(t);
  f.state.reject = true; assert.equal((await f.request('create', input)).status, 400); f.state.reject = false;
  f.state.lostWrite = true; const lost = await f.request('create', input); assert.equal(lost.status, 409); assert.equal(lost.data.operation.status, 'uncertain');
  assert.equal((await f.request('create', { ...input, name: 'Changed input' }, { projectId: 'remapped-project' })).status, 409); assert.equal(f.state.writes, 1);
});

test('accepted writes with rejected readback remain uncertain and cannot be blindly repeated', pg, async t => {
  const f = await fixture(t);
  f.state.unreadableAfterWrite = true;
  const result = await f.request('create', input); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain');
  f.state.unreadableAfterWrite = false;
  assert.equal((await f.request('create', { ...input, name: 'Fresh request' })).status, 409); assert.equal(f.state.writes, 1);
});


test('provider-enforced excluded groups are confirmed and preserved instead of blocking restricted keys', pg, async t => {
  const f = await fixture(t);
  f.state.deniedGroups = ['billing', 'telephony'];
  const created = await f.request('create', input); assert.equal(created.status, 200); assert.equal(created.data.webhook.editable, true); assert.deepEqual(created.data.webhook.excludedGroups, ['billing', 'telephony']);
  const row = await review(f);
  assert.equal((await f.request(`${hookId}/update`, { ...input, expectedVersion: row.version })).status, 200);
  assert.equal((await f.request(`${hookId}/test`, { confirm: true, expectedVersion: (await review(f)).version })).status, 200);
  assert.deepEqual(f.state.rows[0].disabledResourceGroups, ['billing', 'telephony']);
});

test('a synthetic test stays fenced while uncertain and can be deliberately rerun after operator review', pg, async t => {
  const f = await fixture(t);
  await f.request('create', input); const row = await review(f), body = { expectedVersion: row.version, confirm: true };
  f.state.lostTest = true; const unknown = await f.request(`${hookId}/test`, body, { key: 'test-first-attempt' }); assert.equal(unknown.status, 409);
  const writes = f.state.writes; assert.equal((await f.request(`${hookId}/test`, body, { key: 'test-second-attempt' })).status, 409); assert.equal(f.state.writes, writes);
  await f.sql.run("UPDATE integration_operations SET status='reviewed-applied' WHERE id=?", unknown.data.operation.id); f.state.lostTest = false;
  assert.equal((await f.request(`${hookId}/test`, body, { key: 'test-third-attempt' })).status, 200); assert.equal(f.state.writes, writes + 1);
  assert.equal((await f.request(`${hookId}/test`, body, { key: 'test-third-attempt' })).status, 200); assert.equal(f.state.writes, writes + 1);
});

test('parallel webhook creations with different keys reach the provider once', pg, async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.request('create', input, { key: 'parallel-create-a' }), f.request('create', input, { key: 'parallel-create-b' })]);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]); assert.equal(f.state.writes, 1);
  assert.equal(f.calls.filter(call => call.path === '/webhooks/settings' && call.method === 'POST').length, 1);
});
