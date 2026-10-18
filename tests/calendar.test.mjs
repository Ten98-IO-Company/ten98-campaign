import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createStore } from '../server/database.mjs';
import { handleCalendar, calendarPlan } from '../server/calendar.mjs';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
test('Google Calendar mapping, managed event boundaries, stable writes, sync dates and retries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ten98-calendar-')), db = openDatabase(dir), store = createStore(db), originalFetch = globalThis.fetch;
  db.prepare('INSERT INTO workspaces VALUES(?,?)').run('workspace-a', 'Team');
  for (const id of ['project-a', 'project-b']) db.prepare('INSERT INTO projects(id,workspace_id,name) VALUES(?,?,?)').run(id, 'workspace-a', id);
  const env = { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'calendar-service@example.test', GOOGLE_PRIVATE_KEY: privateKey };
  const calls = []; let remote = [], seq = 0, loseResponse = false;
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
    store.create('project-a', 'campaigns', { name: 'Launch', startDate: '2026-10-18', endDate: '2026-10-20' });
    store.create('project-a', 'placements', { name: 'Sample booking', startDate: '2026-10-18', sample: true });
    store.create('project-a', 'posts', { content: 'Publish later', scheduledAt: '2026-10-19T09:00:00Z' });
    store.create('project-b', 'campaigns', { name: 'Private other campaign', startDate: '2026-10-19' });
    const plan = calendarPlan(store, 'project-a'); assert.equal(plan.length, 2); assert.deepEqual(plan, calendarPlan(store, 'project-a'));
    assert.equal(plan[0].end.date, '2026-10-21'); assert.equal(plan[1].end.dateTime, '2026-10-19T09:30:00.000Z');
    const synced = await invoke('sync', { method: 'POST', key: 'sync-plan-0001' }); assert.equal(synced.data.created, 2); assert.equal(synced.data.updated, 0);
    assert.deepEqual(await invoke('sync', { method: 'POST', key: 'sync-plan-0001' }), synced);
    const again = await invoke('sync', { method: 'POST', key: 'sync-plan-0002' }); assert.equal(again.data.created, 0); assert.equal(again.data.updated, 2);
    loseResponse = true; const uncertainBody = { ...body, summary: 'Check uncertain event' }, before = eventWrites().length;
    const uncertain = await invoke('events', { method: 'POST', body: uncertainBody, key: 'uncertain-create-001' }); assert.equal(uncertain.data.error.code, 'OPERATION_UNCERTAIN'); assert.equal(JSON.stringify(uncertain).includes('private upstream'), false);
    await invoke('events', { method: 'POST', body: uncertainBody, key: 'uncertain-create-001' }); await invoke('events', { method: 'POST', body: uncertainBody, key: 'uncertain-create-002' });
    assert.equal(eventWrites().length, before + 1, 'An uncertain provider write cannot be repeated with a fresh request key.');
  } finally { globalThis.fetch = originalFetch; db.close(); rmSync(dir, { recursive: true, force: true }); }
});
