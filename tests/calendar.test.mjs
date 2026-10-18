import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createStore } from '../server/database.mjs';
import { handleCalendar, calendarPlan } from '../server/calendar.mjs';
import { handleOperationRecovery } from '../server/operation-recovery.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
test('Calendar plan sync stops stale local records before writing and quarantines partial batches', async () => {
  for (const during of ['list', 'write', 'remove', 'last']) {
    const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, writes = [];
    db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('plan-race'); CREATE TABLE calendar_connections(project_id TEXT PRIMARY KEY,calendar_id TEXT); INSERT INTO calendar_connections VALUES('plan-race','qa@example.test');");
    let posts = [{ id: 'one', content: 'First post', scheduledAt: '2070-01-01T10:00:00Z' }, { id: 'two', content: 'Second post', scheduledAt: '2070-01-02T10:00:00Z' }], change = true;
    const store = { list(_project, collection) { return collection === 'posts' ? structuredClone(posts) : []; }, activity() {} };
    function edit() { if (during === 'remove') posts.pop(); else posts[1].scheduledAt = '2070-02-02T10:00:00Z'; change = false; }
    globalThis.fetch = async (target, options = {}) => {
      if (new URL(target).hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-token' });
      if (options.method === 'GET') { if (during === 'list' && change) edit(); return Response.json({ items: [] }); }
      const event = JSON.parse(options.body); writes.push(event); if (change && (during !== 'last' || writes.length === 2)) edit(); return Response.json(event);
    };
    async function invoke(key) {
      let response;
      await handleCalendar({ req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL('http://localhost/api/projects/plan-race/calendar/sync'), body: {}, project: { id: 'plan-race' }, role: 'owner', user: { isOperator: true }, db, store, config: { env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'qa@example.test', GOOGLE_PRIVATE_KEY: privateKey } }, send(status, data) { response = { status, data }; } });
      return response;
    }
    try {
      const result = await invoke('plan-race-original');
      const applied = during === 'list' ? 0 : during === 'last' ? 2 : 1;
      assert.equal(result.status, 409, JSON.stringify(result.data)); assert.equal(writes.length, applied);
      assert.equal(result.data.operation.status, during === 'list' ? 'failed' : 'uncertain');
      const retry = await invoke('plan-race-new-key');
      if (during === 'list') { assert.equal(retry.status, 200); assert.equal(writes[1].start.dateTime, '2070-02-02T10:00:00.000Z'); }
      else { assert.equal(retry.status, 409); assert.equal(writes.length, applied, 'A partially applied batch must not replay with a fresh key.'); }
    } finally { globalThis.fetch = originalFetch; db.close(); }
  }
});

test('Calendar sync recovery binds the mapped plan and never bypasses an unresolved prior sync', async () => {
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, remote = new Map();
  db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('plan-intent'); CREATE TABLE calendar_connections(project_id TEXT PRIMARY KEY,calendar_id TEXT); INSERT INTO calendar_connections VALUES('plan-intent','qa@example.test');");
  const project = { id: 'plan-intent' }, user = { id: 'qa-operator', isOperator: true }, originalTime = '2070-01-01T10:00:00Z';
  let scheduledAt = originalTime, loseResponse = true, writes = 0, release, entered, pending;
  const reached = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const store = { list(_project, collection) { return collection === 'posts' ? [{ id: 'one', content: 'Appointment', scheduledAt }] : []; }, activity() {} };
  globalThis.fetch = async (target, options = {}) => {
    if (new URL(target).hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-token' });
    if (options.method === 'GET') return Response.json({ items: [...remote.values()] });
    const event = JSON.parse(options.body); remote.set(event.id, event); writes++;
    if (loseResponse) { loseResponse = false; entered(); await gate; throw new Error('Synthetic acknowledgement lost after the event was applied.'); }
    return Response.json(event);
  };
  async function invoke(key, body = {}) {
    let response;
    await handleCalendar({ req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL('http://localhost/api/projects/plan-intent/calendar/sync'), body, project, user, role: 'owner', db, store, config: { env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'qa@example.test', GOOGLE_PRIVATE_KEY: privateKey } }, send(status, data) { response = { status, data }; } });
    return response;
  }
  try {
    pending = invoke('plan-intent-first'); await reached;
    scheduledAt = '2070-02-01T10:00:00Z'; assert.equal((await invoke('plan-intent-still-running')).status, 409); assert.equal(writes, 1);
    release(); const first = await pending; assert.equal(first.data.operation.status, 'uncertain');
    assert.equal((await invoke('plan-intent-unreviewed')).status, 409); assert.equal(writes, 1);
    let reviewed;
    await handleOperationRecovery({ req: { method: 'POST' }, url: new URL(`http://localhost/api/projects/plan-intent/operations/${first.data.operation.id}/review`), body: { resolution: 'applied', confirmChecked: true, note: 'Checked the synthetic provider event and verified it exists.', reference: [...remote.keys()][0] }, project, role: 'owner', user, db, send(status, data) { reviewed = { status, data }; } });
    assert.equal(reviewed.status, 200);
    scheduledAt = originalTime; assert.equal((await invoke('plan-intent-same-plan')).status, 409); assert.equal(writes, 1);
    scheduledAt = '2070-02-01T10:00:00Z'; const changed = await invoke('plan-intent-changed-plan');
    assert.equal(changed.status, 200, JSON.stringify(changed.data)); assert.equal(writes, 2); assert.equal(changed.data.updated, 1);
    assert.equal([...remote.values()][0].start.dateTime, '2070-02-01T10:00:00.000Z');
    assert.equal(db.prepare('SELECT status FROM integration_operations WHERE id=?').get(first.data.operation.id).status, 'reviewed-applied');
  } finally { release(); await pending?.catch(() => {}); globalThis.fetch = originalFetch; db.close(); }
});

test('Calendar plan fingerprints are read-only, order independent, mapping bound and checked before sync', async () => {
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch;
  db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('fingerprint'); CREATE TABLE calendar_connections(project_id TEXT PRIMARY KEY,calendar_id TEXT); INSERT INTO calendar_connections VALUES('fingerprint','one@example.test');");
  let posts = [{ id: 'one', content: 'First post', scheduledAt: '2070-01-01T10:00:00Z' }, { id: 'two', content: 'Second post', scheduledAt: '2070-01-02T10:00:00Z' }], reads = 0;
  const store = { list(_project, collection) { return collection === 'posts' ? posts : []; } };
  globalThis.fetch = async target => { reads++; assert.equal(new URL(target).hostname, 'oauth2.googleapis.com'); return Response.json({ access_token: 'fixture-token' }); };
  async function invoke(method, action, body = {}) {
    let response;
    await handleCalendar({ req: { method, headers: { 'idempotency-key': 'fingerprint-request' } }, url: new URL('http://localhost/api/projects/fingerprint/calendar/' + action), body, project: { id: 'fingerprint' }, role: 'owner', user: { isOperator: true }, db, store, config: { env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'qa@example.test', GOOGLE_PRIVATE_KEY: privateKey } }, send(status, data) { response = { status, data }; } });
    return response;
  }
  try {
    const first = await invoke('GET', 'plan'); assert.equal(first.status, 200); assert.match(first.data.fingerprint, /^[a-f0-9]{64}$/); assert.equal(reads, 0);
    posts.reverse(); assert.equal((await invoke('GET', 'plan')).data.fingerprint, first.data.fingerprint);
    posts[0] = { ...posts[0], content: 'Changed caption' }; const changed = await invoke('GET', 'plan'); assert.notEqual(changed.data.fingerprint, first.data.fingerprint);
    assert.equal((await invoke('POST', 'sync', { planFingerprint: first.data.fingerprint })).status, 409);
    assert.equal((await invoke('POST', 'sync', { planFingerprint: 'invalid' })).status, 400);
    db.prepare('UPDATE calendar_connections SET calendar_id=?').run('two@example.test'); assert.notEqual((await invoke('GET', 'plan')).data.fingerprint, changed.data.fingerprint);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test('Calendar plan identity cannot bypass unconfirmed legacy receipts without action metadata', async () => {
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch;
  db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('legacy-plan'); CREATE TABLE calendar_connections(project_id TEXT PRIMARY KEY,calendar_id TEXT); INSERT INTO calendar_connections VALUES('legacy-plan','qa@example.test'); CREATE TABLE integration_operations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL,response TEXT,http_status INTEGER,created_at TEXT NOT NULL,UNIQUE(project_id,request_key));");
  const path = '/api/projects/legacy-plan/calendar/sync', legacyHash = createHash('sha256').update(JSON.stringify({ body: {}, method: 'POST', path })).digest('hex');
  db.prepare('INSERT INTO integration_operations VALUES(?,?,?,?,?,?,?,?)').run('legacy-operation', 'legacy-plan', 'legacy-plan-old-key', legacyHash, 'uncertain', null, null, new Date().toISOString());
  globalThis.fetch = async (target, options = {}) => { if (new URL(target).hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-token' }); assert.equal(options.method, 'GET', 'An unconfirmed legacy plan may not issue another provider write.'); return Response.json({ items: [] }); };
  try {
    let response;
    await handleCalendar({ req: { method: 'POST', headers: { 'idempotency-key': 'legacy-plan-fresh-key' } }, url: new URL('http://localhost' + path), body: {}, project: { id: 'legacy-plan' }, role: 'owner', user: { isOperator: true }, db, store: { list(_project, collection) { return collection === 'posts' ? [{ id: 'one', content: 'New plan', scheduledAt: '2070-01-01T10:00:00Z' }] : []; }, activity() {} }, config: { env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'qa@example.test', GOOGLE_PRIVATE_KEY: privateKey } }, send(status, data) { response = { status, data }; } });
    assert.equal(response.status, 409); assert.equal(response.data.operation.status, 'failed'); assert.equal(db.prepare('SELECT status FROM integration_operations WHERE id=?').get('legacy-operation').status, 'uncertain');
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test('Google Calendar mapping, managed event boundaries, stable writes, sync dates and retries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ten98-calendar-')), db = openDatabase(dir), store = createStore(db), originalFetch = globalThis.fetch;
  db.prepare('INSERT INTO workspaces VALUES(?,?)').run('workspace-a', 'Team');
  for (const id of ['project-a', 'project-b']) db.prepare('INSERT INTO projects(id,workspace_id,name) VALUES(?,?,?)').run(id, 'workspace-a', id);
  const env = { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'calendar-service@example.test', GOOGLE_PRIVATE_KEY: privateKey };
  const calls = []; let remote = [], seq = 0, loseResponse = false, invalidWriteResponse = false, malformedEventResponse = false;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); calls.push({ url, options });
    assert.equal(url.protocol, 'https:'); assert.equal(options.redirect, 'error');
    if (url.hostname === 'oauth2.googleapis.com') {
      const assertion = new URLSearchParams(options.body).get('assertion'), claims = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url'));
      assert.equal(claims.scope, 'https://www.googleapis.com/auth/calendar.events');
      return new Response(JSON.stringify({ access_token: 'private-fixture-token', expires_in: 3600 }));
    }
    assert.equal(url.hostname, 'www.googleapis.com'); assert.equal(options.headers.Authorization, 'Bearer private-fixture-token');
    assert.match(url.pathname, /^\/calendar\/v3\/calendars\/shared%40example.test\/events/);
    const id = url.pathname.split('/events/')[1];
    if (options.method === 'GET') {
      if (url.searchParams.has('privateExtendedProperty')) assert.equal(url.searchParams.get('privateExtendedProperty'), 'ten98ProjectId=project-a');
      return new Response(JSON.stringify({ items: remote }));
    }
    assert.equal(url.searchParams.get('sendUpdates'), 'none', 'Calendar writes never email attendees.');
    if (options.method === 'DELETE') { remote = remote.filter(item => item.id !== id); return new Response(null, { status: 204 }); }
    const event = JSON.parse(options.body); assert.equal(event.extendedProperties.private.ten98ProjectId, 'project-a');
    assert.equal(event.visibility, 'private'); remote = [...remote.filter(item => item.id !== event.id), event];
    if (loseResponse) { loseResponse = false; throw new Error('A private upstream diagnostic must not escape.'); }
    if (invalidWriteResponse) { invalidWriteResponse = false; return Response.json({ id: 'unexpected-event' }); }
    if (malformedEventResponse) { malformedEventResponse = false; return Response.json({ ...event, summary: { private: 'not display text' } }); }
    return new Response(JSON.stringify(event));
  };
  async function invoke(suffix, { method = 'GET', body = {}, role = 'owner', operator = true, projectId = 'project-a', key = `calendar-key-${++seq}` } = {}) {
    let response;
    assert.equal(await handleCalendar({ req: { method, headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${projectId}/calendar/${suffix}`), project: { id: projectId }, user: { isOperator: operator }, role, db, body, store, config: { env }, send(status, data) { response = { status, data: JSON.parse(JSON.stringify(data)) }; } }), true);
    return response;
  }
  const eventWrites = () => calls.filter(call => call.url.hostname === 'www.googleapis.com' && call.options.method !== 'GET');
  try {
    assert.deepEqual((await invoke('status')).data, { configured: true, mapped: false, calendarId: '' }); assert.equal(calls.length, 0);
    assert.equal((await invoke('connection', { method: 'POST', body: { calendarId: 'shared@example.test' }, operator: false })).status, 403);
    assert.equal((await invoke('connection', { method: 'POST', body: { calendarId: 'shared@example.test' }, role: 'editor' })).status, 403);
    assert.equal((await invoke('connection', { method: 'POST', body: { calendarId: 'primary' } })).status, 400);
    assert.equal((await invoke('connection', { method: 'POST', body: { calendarId: 'shared@example.test' } })).status, 200);
    assert.equal((await invoke('connection', { method: 'POST', body: { calendarId: 'shared@example.test' }, projectId: 'project-b' })).status, 409);
    remote = [{ id: 'external01', summary: 'Existing meeting', start: { date: '2026-10-01' }, end: { date: '2026-10-02' } }, { id: 'other001', summary: 'Other managed event', extendedProperties: { private: { ten98ProjectId: 'project-b' } }, start: { date: '2026-10-02' }, end: { date: '2026-10-03' } }];
    const listed = await invoke('events?fromDate=2026-10-01&toDate=2026-10-31', { role: 'viewer' });
    assert.equal(listed.status, 200); assert.equal(listed.data.events[0].managed, false); assert.equal(listed.data.events[1].projectId, 'project-b');
    const listing = calls.find(call => call.url.searchParams.has('timeMin'));
    assert.equal(listing.url.searchParams.get('timeMin'), '2026-10-01T00:00:00Z'); assert.equal(listing.url.searchParams.get('timeMax'), '2026-11-01T00:00:00.000Z');
    const originalEvents = remote;
    for (const invalid of [null, { ...originalEvents[0], summary: {} }, { ...originalEvents[0], start: { date: {} } }, { ...originalEvents[0], start: { date: {}, dateTime: '2026-10-01T12:00:00Z' } }, { ...originalEvents[0], end: null }]) {
      remote = [invalid]; const result = await invoke('events'); assert.equal(result.status, 502); assert.equal(result.data.error.code, 'CALENDAR_ERROR'); assert.equal(result.data.events, undefined);
    }
    remote = originalEvents;
    assert.equal((await invoke('events/other001', { method: 'DELETE' })).status, 404);
    assert.equal((await invoke('events/external01', { method: 'PATCH' })).status, 404);
    assert.equal((await invoke('events', { method: 'POST', role: 'viewer' })).status, 403); assert.equal(eventWrites().length, 0);
    const body = { summary: 'Launch meeting', description: 'Prepare the launch', start: '2026-10-20T10:00:00+04:00', end: '2026-10-20T11:00:00+04:00' };
    assert.equal((await invoke('events', { method: 'POST', body: { ...body, end: body.start } })).status, 400);
    assert.equal((await invoke('events', { method: 'POST', body: { ...body, start: '2026-10-20T10:00' } })).status, 400);
    assert.equal((await invoke('events', { method: 'POST', body: { ...body, start: '2026-02-30T10:00:00Z' } })).status, 400);
    assert.equal((await invoke('events', { method: 'POST', body: { ...body, allDay: true, start: '2026-02-30', end: '2026-03-02' } })).status, 400); assert.equal(eventWrites().length, 0);
    const saved = await invoke('events', { method: 'POST', body, key: 'stable-create-001' });
    assert.equal(saved.status, 200); assert.equal(saved.data.event.start.dateTime, '2026-10-20T06:00:00.000Z'); assert.match(saved.data.event.id, /^[a-v0-9]+$/);
    assert.deepEqual(await invoke('events', { method: 'POST', body, key: 'stable-create-001' }), saved); assert.equal(eventWrites().length, 1);
    assert.equal((await invoke('events', { method: 'POST', body: { ...body, summary: 'A different event' }, key: 'stable-create-001' })).status, 409);
    const id = saved.data.event.id;
    assert.equal((await invoke(`events/${id}`, { method: 'DELETE', key: 'stable-delete-001' })).data.deleted, true);
    assert.equal((await invoke(`events/${id}`, { method: 'DELETE', key: 'stable-delete-001' })).data.deleted, true);
    assert.equal(eventWrites().filter(call => call.options.method === 'DELETE').length, 1);
    malformedEventResponse = true;
    const malformedBody = { ...body, summary: 'Unconfirmed event details' }, beforeMalformed = eventWrites().length;
    const malformed = await invoke('events', { method: 'POST', body: malformedBody, key: 'malformed-event-create' });
    assert.equal(malformed.status, 409); assert.equal(malformed.data.operation.status, 'uncertain');
    await invoke('events', { method: 'POST', body: malformedBody, key: 'malformed-event-retry' });
    assert.equal(eventWrites().length, beforeMalformed + 1, 'Unreadable event details after a successful write must not authorize another create.');
    store.create('project-a', 'campaigns', { name: 'Launch', startDate: '2026-10-18', endDate: '2026-10-20' });
    store.create('project-a', 'placements', { name: 'Sample booking', startDate: '2026-10-18', sample: true });
    store.create('project-a', 'posts', { content: 'Publish later', scheduledAt: '2026-10-19T09:00:00Z' });
    store.create('project-b', 'campaigns', { name: 'Private other campaign', startDate: '2026-10-19' });
    const plan = calendarPlan(store, 'project-a'); assert.equal(plan.length, 2); assert.deepEqual(plan, calendarPlan(store, 'project-a'));
    assert.equal(plan[0].end.date, '2026-10-21'); assert.equal(plan[1].end.dateTime, '2026-10-19T09:30:00.000Z');
    const synced = await invoke('sync', { method: 'POST', key: 'sync-plan-0001' }); assert.equal(synced.data.created, 2); assert.equal(synced.data.updated, 0);
    assert.deepEqual(await invoke('sync', { method: 'POST', key: 'sync-plan-0001' }), synced);
    const again = await invoke('sync', { method: 'POST', key: 'sync-plan-0002' }); assert.equal(again.data.created, 0); assert.equal(again.data.updated, 2);
    invalidWriteResponse = true; const beforeInvalidSync = eventWrites().length;
    const invalidSync = await invoke('sync', { method: 'POST', key: 'sync-invalid-0001' }); assert.equal(invalidSync.data.error.code, 'OPERATION_UNCERTAIN');
    await invoke('sync', { method: 'POST', key: 'sync-invalid-0002' });
    assert.equal(eventWrites().length, beforeInvalidSync + 1, 'A plan write without confirmation of its expected event must stop and block automatic retries.');
    loseResponse = true; const uncertainBody = { ...body, summary: 'Check uncertain event' }, before = eventWrites().length;
    const uncertain = await invoke('events', { method: 'POST', body: uncertainBody, key: 'uncertain-create-001' }); assert.equal(uncertain.data.error.code, 'OPERATION_UNCERTAIN'); assert.equal(JSON.stringify(uncertain).includes('private upstream'), false);
    await invoke('events', { method: 'POST', body: uncertainBody, key: 'uncertain-create-001' }); await invoke('events', { method: 'POST', body: uncertainBody, key: 'uncertain-create-002' });
    assert.equal(eventWrites().length, before + 1, 'An uncertain provider write cannot be repeated with a fresh request key.');
  } finally { globalThis.fetch = originalFetch; db.close(); rmSync(dir, { recursive: true, force: true }); }
});
