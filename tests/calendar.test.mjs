import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createStore } from '../server/database.ts';
import { handleCalendar, calendarPlan } from '../server/calendar.ts';
import { handleOperationRecovery } from '../server/operation-recovery.ts';
import { postScheduleEntries } from '../shared/post-schedule.ts';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
test('Local schedule entries retain two same-platform account captions, own dates and parent inheritance', () => {
  const post = { id: 'copy-post', content: 'Shared caption', platforms: ['instagram'], accounts: ['first', 'second'], scheduledAt: '2070-01-01T10:00:00Z', platformOverrides: { instagram: { content: 'Platform caption' } }, accountOverrides: { first: { platform: 'instagram', content: 'First account caption', scheduledAt: '' }, second: { platform: 'instagram', content: 'Second account caption', scheduledAt: '2070-01-03T10:00:00Z' } } };
  const copies = postScheduleEntries(post);
  assert.deepEqual(copies.map(({ id, content, scheduledAt }) => ({ id, content, scheduledAt })), [{ id: 'copy-post:first', content: 'First account caption', scheduledAt: post.scheduledAt }, { id: 'copy-post:second', content: 'Second account caption', scheduledAt: '2070-01-03T10:00:00Z' }]);
  assert.equal(copies[0].post, post, 'The editor must receive the original parent record.');
  post.scheduledAt = '2070-02-01T10:00:00Z'; assert.equal(postScheduleEntries(post)[0].scheduledAt, post.scheduledAt); assert.equal(postScheduleEntries(post)[1].scheduledAt, '2070-01-03T10:00:00Z');
  delete post.accountOverrides.second.scheduledAt; assert.equal(postScheduleEntries(post)[1].scheduledAt, post.scheduledAt);
  post.accounts = ['first']; assert.equal(postScheduleEntries(post).length, 1, 'Removed recipients may not remain in the calendar.');
  post.accounts = ['first', 'unknown']; post.platforms = ['instagram', 'facebook']; const unknown = postScheduleEntries(post)[1]; assert.equal(unknown.content, ''); assert.equal(unknown.scheduledAt, post.scheduledAt, 'Unknown account platforms retain accurate inherited timing without guessing their caption.');
  post.providerResults = [{ accountId: 'unknown', platform: 'instagram' }]; assert.equal(postScheduleEntries(post)[1].content, 'Platform caption');
  post.accountOverrides = {}; assert.equal(postScheduleEntries(post)[0].id, post.id, 'Ordinary posts keep their original identity.');
});

test('Reviewed account calendar plans replace obsolete plan events without touching manual or foreign events', async () => {
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, remote = new Map(), writes = [];
  db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('account-plan'); CREATE TABLE calendar_connections(project_id TEXT PRIMARY KEY,calendar_id TEXT); INSERT INTO calendar_connections VALUES('account-plan','qa@example.test');");
  const post = { id: 'one', content: 'Shared caption', platforms: ['instagram'], accounts: ['first', 'second'], scheduledAt: '2070-01-01T10:00:00Z' };
  const store = { list(_project, collection) { return collection === 'posts' ? [structuredClone(post)] : []; }, activity() {} };
  let revision = 0, sequence = 0;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target);
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-token' });
    if (options.method === 'GET') { const id = url.pathname.split('/events/')[1]; return id ? remote.has(id) ? Response.json(remote.get(id)) : Response.json({ error: 'not found' }, { status: 404 }) : Response.json({ items: [...remote.values()].filter(event => event.status !== 'cancelled') }); }
    const id = url.pathname.split('/events/')[1]; writes.push({ id, method: options.method });
    if (options.method === 'DELETE') { assert.equal(options.headers['If-Match'], remote.get(id).etag); remote.set(id, { id, status: 'cancelled' }); return new Response(null, { status: 204 }); }
    if (options.method === 'PATCH') assert.equal(options.headers['If-Match'], remote.get(id).etag);
    const event = { ...JSON.parse(options.body), etag: `"revision-${++revision}"` }; if (options.method === 'POST' && remote.has(event.id)) return Response.json({ error: 'duplicate event ID' }, { status: 409 }); remote.set(event.id, event); return Response.json(event);
  };
  async function invoke(action, body = {}, key = `account-calendar-${++sequence}`, role = 'owner') {
    let response;
    await handleCalendar({ req: { method: ['plan', 'events'].includes(action) ? 'GET' : action.startsWith('events/') ? 'PATCH' : 'POST', headers: { 'idempotency-key': key } }, url: new URL('http://localhost/api/projects/account-plan/calendar/' + action), body, project: { id: 'account-plan' }, role, user: { isOperator: true }, db, store, config: { env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'qa@example.test', GOOGLE_PRIVATE_KEY: privateKey } }, send(status, data) { response = { status, data }; } }); return response;
  }
  try {
    const originalPlan = calendarPlan(store, 'account-plan'), parentId = originalPlan[0].id;
    assert.equal((await invoke('sync')).status, 200);
    const edited = await invoke('events/' + parentId, { summary: 'Edited plan event in Google tools', description: 'Keep its plan ownership', start: '2070-01-01T11:00:00Z', end: '2070-01-01T12:00:00Z', etag: remote.get(parentId).etag, calendarId: 'qa@example.test', extendedProperties: { private: { ten98ProjectId: 'other-project', ten98Collection: 'events' } } });
    assert.equal(edited.status, 200); assert.deepEqual(remote.get(parentId).extendedProperties, originalPlan[0].extendedProperties, 'Editing a planned event preserves its original project, record and collection identity; request bodies cannot replace ownership.');
    assert.deepEqual(edited.data.event.plan, { collection: 'posts', recordId: post.id });
    const editedPlan = (await invoke('plan')).data, resynced = await invoke('sync', { planFingerprint: editedPlan.fingerprint }); assert.equal(resynced.status, 200); assert.equal(resynced.data.updated, 1, 'An edited plan event must still resync before account expansion.');
    const manual = { id: 'manual01', summary: 'Manual project event', start: { date: '2070-01-01' }, end: { date: '2070-01-02' }, extendedProperties: { private: { ten98ProjectId: 'account-plan', ten98Collection: 'events' } } };
    const foreign = calendarPlan(store, 'other-project')[0];
    const imitation = { ...manual, id: 'imitation01', extendedProperties: { private: { ten98ProjectId: 'account-plan', ten98Collection: 'posts', ten98RecordId: 'unverified' } } };
    for (const event of [manual, foreign, imitation]) remote.set(event.id, event);
    const listed = (await invoke('events')).data.events; assert.deepEqual(listed.find(event => event.id === parentId).plan, { collection: 'posts', recordId: post.id }); for (const event of [manual, foreign, imitation]) assert.equal(listed.find(item => item.id === event.id).plan, undefined, 'Only a verified plan event owned by the current project receives overlay metadata.');
    post.accountOverrides = { first: { platform: 'instagram', content: 'First account caption', scheduledAt: '' }, second: { platform: 'instagram', content: 'Second account caption', scheduledAt: '2070-01-03T10:00:00Z' } };
    const preview = (await invoke('plan')).data; assert.equal(preview.upserts.length, 2); assert.deepEqual(preview.deletions.map(event => event.id), [parentId]); assert.equal(preview.upserts[1].start.dateTime, '2070-01-03T10:00:00.000Z');
    assert.deepEqual(preview.upserts[1].plan, { collection: 'posts', recordId: post.id, accountId: 'second' });
    assert.match(preview.upserts[0].description, /First account caption/); assert.match(preview.upserts[1].description, /Second account caption/);
    const before = writes.length; assert.equal((await invoke('sync')).status, 409); assert.equal(writes.length, before, 'Deleting obsolete copies requires a reviewed native set.');
    post.accountOverrides.second.scheduledAt = '2070-01-04T10:00:00Z'; assert.equal((await invoke('sync', { planFingerprint: preview.fingerprint })).status, 409); assert.equal(writes.length, before);
    post.accountOverrides.second.scheduledAt = '2070-01-03T10:00:00Z';
    remote.get(parentId).summary = 'Changed in Google'; remote.get(parentId).etag = '"native-change"';
    assert.equal((await invoke('sync', { planFingerprint: preview.fingerprint })).status, 409); assert.equal(writes.length, before, 'Native changes invalidate a deletion review.');
    const reviewed = (await invoke('plan')).data, body = { planFingerprint: reviewed.fingerprint };
    const applied = await invoke('sync', body, 'account-calendar-reviewed'); assert.equal(applied.status, 200, JSON.stringify(applied.data)); assert.equal(applied.data.created, 2); assert.equal(applied.data.deleted, 1); assert.equal(remote.get(parentId).status, 'cancelled');
    const after = writes.length; assert.deepEqual(await invoke('sync', body, 'account-calendar-reviewed'), applied); assert.equal(writes.length, after, 'A successful deletion batch must replay its receipt after the native deletion set disappears.');
    assert.equal((await invoke('sync', body, 'account-calendar-viewer', 'viewer')).status, 403); assert.equal(writes.length, after);
    post.accountOverrides = {}; const reset = (await invoke('plan')).data; assert.equal(reset.upserts.length, 1); const restoredId = reset.upserts[0].id; assert.notEqual(restoredId, parentId, 'A retained Google tombstone cannot be recreated with its original ID.'); assert.equal(reset.deletions.length, 2);
    const restored = await invoke('sync', { planFingerprint: reset.fingerprint }); assert.equal(restored.status, 200); assert.equal(restored.data.deleted, 2); assert.equal(remote.get(restoredId).extendedProperties.private.ten98Generation, '1');
    assert.deepEqual([...remote.values()].filter(event => event.status !== 'cancelled').map(event => event.id).sort(), [restoredId, manual.id, foreign.id, imitation.id].sort(), 'Resetting account timing must leave no orphan copies and preserve all non-plan events.');
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test('Account plan sync rechecks access, calendar mapping and deletion revisions, and quarantines a lost deletion receipt', async () => {
  for (const failure of ['role-before', 'mapping-before', 'role-after', 'mapping-after', 'delete-lost', 'native-delete-race']) {
    const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, remote = new Map(), writes = [];
    db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('account-race'); CREATE TABLE calendar_connections(project_id TEXT PRIMARY KEY,calendar_id TEXT); INSERT INTO calendar_connections VALUES('account-race','qa@example.test');");
    const post = { id: 'one', content: 'Shared caption', platforms: ['instagram'], accounts: ['first', 'second'], scheduledAt: '2070-01-01T10:00:00Z' };
    const store = { list(_project, collection) { return collection === 'posts' ? [structuredClone(post)] : []; }, activity() {} }, parent = { ...calendarPlan(store, 'account-race')[0], etag: '"old-parent"' };
    remote.set(parent.id, parent);
    post.accountOverrides = { first: { platform: 'instagram', content: 'First caption' }, second: { platform: 'instagram', content: 'Second caption', scheduledAt: '2070-01-02T10:00:00Z' } };
    let armed = false, allowed = true, lists = 0, deletionLost = false;
    function revoke() { if (failure.startsWith('role')) allowed = false; else db.prepare('UPDATE calendar_connections SET calendar_id=?').run('changed@example.test'); }
    globalThis.fetch = async (target, options = {}) => {
      if (new URL(target).hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-token' });
      if (options.method === 'GET') {
        if (armed) { lists++; if (failure.endsWith('before')) revoke(); if (failure === 'native-delete-race' && lists === 2) remote.get(parent.id).etag = '"changed-in-google"'; }
        return Response.json({ items: [...remote.values()].filter(event => event.status !== 'cancelled') });
      }
      const id = new URL(target).pathname.split('/events/')[1]; writes.push(options.method);
      if (options.method === 'DELETE') { remote.set(id, { id, status: 'cancelled' }); if (failure === 'delete-lost' && !deletionLost) { deletionLost = true; throw new Error('Synthetic deletion acknowledgement lost.'); } return new Response(null, { status: 204 }); }
      const event = { ...JSON.parse(options.body), etag: '"new-copy"' }; if (options.method === 'POST' && remote.has(event.id)) return Response.json({}, { status: 409 }); remote.set(event.id, event); if (armed && failure.endsWith('after')) revoke(); return Response.json(event);
    };
    async function invoke(action, body = {}, key = 'account-race-first-key') {
      let response;
      await handleCalendar({ req: { method: action === 'plan' ? 'GET' : 'POST', headers: { 'idempotency-key': key } }, url: new URL('http://localhost/api/projects/account-race/calendar/' + action), body, project: { id: 'account-race' }, role: 'owner', user: { isOperator: true }, db, store, assertIntegrationSettings() { if (!allowed) throw Object.assign(new Error('Access revoked'), { status: 403 }); }, config: { env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'qa@example.test', GOOGLE_PRIVATE_KEY: privateKey } }, send(status, data) { response = { status, data }; } }); return response;
    }
    try {
      const preview = await invoke('plan'); assert.equal(preview.status, 200); armed = true;
      const body = { planFingerprint: preview.data.fingerprint }, result = await invoke('sync', body);
      assert.equal(result.status, 409, `${failure}: ${JSON.stringify(result.data)}`);
      const partial = !failure.endsWith('before'); assert.equal(result.data.operation.status, partial ? 'uncertain' : 'failed');
      assert.equal(writes.length, failure.endsWith('before') ? 0 : failure.endsWith('after') ? 1 : failure === 'delete-lost' ? 3 : 2);
      if (failure === 'native-delete-race') assert.equal(remote.has(parent.id), true, 'A changed native deletion set must not be deleted.');
      if (failure === 'delete-lost') assert.equal(remote.get(parent.id).status, 'cancelled', 'The lost receipt happened after the synthetic deletion was applied.');
      if (partial) {
        armed = false; allowed = true; db.prepare('UPDATE calendar_connections SET calendar_id=?').run('qa@example.test'); const before = writes.length;
        assert.equal((await invoke('sync', body)).status, 409); assert.equal((await invoke('sync', body, 'account-race-fresh-key')).status, 409); assert.equal(writes.length, before, 'Uncertain account batches cannot replay with either request key.');
        if (failure === 'delete-lost') {
          assert.equal(db.prepare("SELECT generation FROM calendar_plan_generations WHERE project_id='account-race' AND account_id=''").get().generation, 1);
          let reviewed; await handleOperationRecovery({ req: { method: 'POST' }, url: new URL(`http://localhost/api/projects/account-race/operations/${result.data.operation.id}/review`), body: { resolution: 'applied', confirmChecked: true, note: 'Verified synthetic account copies and retained parent tombstone.', reference: parent.id }, project: { id: 'account-race' }, role: 'owner', user: { id: 'qa-operator', isOperator: true }, db, send(status, data) { reviewed = { status, data }; } }); assert.equal(reviewed.status, 200);
          post.accountOverrides = {}; const reset = await invoke('plan'); assert.equal(reset.status, 200); assert.notEqual(reset.data.upserts[0].id, parent.id);
          const restored = await invoke('sync', { planFingerprint: reset.data.fingerprint }, 'account-race-after-review'); assert.equal(restored.status, 200, JSON.stringify(restored.data)); assert.equal(restored.data.deleted, 2); assert.equal([...remote.values()].filter(event => event.status !== 'cancelled').length, 1, 'Reviewed recovery cannot reuse a tombstone or leave account copies behind.');
        }
      }
    } finally { globalThis.fetch = originalFetch; db.close(); }
  }
});

test('Reviewed upserts bind native existence, contents, ownership and revision before any effect', async () => {
  for (const mutation of ['modify', 'delete', 'create', 'recreate', 'ownership', 'missing-revision']) {
    const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, writes = [];
    db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('upsert-review'); CREATE TABLE calendar_connections(project_id TEXT PRIMARY KEY,calendar_id TEXT); INSERT INTO calendar_connections VALUES('upsert-review','qa@example.test');");
    const store = { list(_project, collection) { return collection === 'posts' ? [{ id: 'one', content: 'Planned caption', scheduledAt: '2070-01-01T10:00:00Z' }] : []; }, activity() {} }, event = { ...calendarPlan(store, 'upsert-review')[0], etag: '"reviewed-revision"' };
    let native = mutation === 'create' ? [] : [structuredClone(event)], sequence = 0; const tombstones = new Map();
    globalThis.fetch = async (target, options = {}) => {
      if (new URL(target).hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-token' });
      if (options.method === 'GET') { const id = new URL(target).pathname.split('/events/')[1]; return id ? Response.json(native.find(event => event.id === id) || tombstones.get(id) || {}, { status: native.some(event => event.id === id) || tombstones.has(id) ? 200 : 404 }) : Response.json({ items: native }); }
      writes.push(options.method);
      if (options.method === 'PATCH') assert.equal(options.headers['If-Match'], native[0].etag, 'An existing upsert must be conditional on its reviewed revision.');
      const saved = { ...JSON.parse(options.body), etag: '"saved-revision"' }; if (options.method === 'POST' && tombstones.has(saved.id)) return Response.json({}, { status: 409 }); native = [saved]; return Response.json(saved);
    };
    async function invoke(action, body = {}) {
      let response;
      await handleCalendar({ req: { method: action === 'plan' ? 'GET' : 'POST', headers: { 'idempotency-key': `upsert-review-${++sequence}` } }, url: new URL('http://localhost/api/projects/upsert-review/calendar/' + action), body, project: { id: 'upsert-review' }, role: 'owner', user: { isOperator: true }, db, store, config: { env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'qa@example.test', GOOGLE_PRIVATE_KEY: privateKey } }, send(status, data) { response = { status, data }; } }); return response;
    }
    try {
      const preview = await invoke('plan'); assert.equal(preview.status, 200); assert.equal(preview.data.upserts[0].action, mutation === 'create' ? 'create' : 'update');
      if (mutation === 'delete') { tombstones.set(event.id, { id: event.id, status: 'cancelled' }); native = []; }
      else if (mutation === 'create') native = [{ ...event, etag: '"created-after-review"' }];
      else if (mutation === 'recreate') native = [{ ...event, etag: '"recreated-after-review"' }];
      else if (mutation === 'modify') native[0].summary = 'A native edit even if an upstream fixture reused its revision';
      else if (mutation === 'ownership') native[0].extendedProperties.private.ten98Collection = 'events';
      else delete native[0].etag;
      const stale = await invoke('sync', { planFingerprint: preview.data.fingerprint }); assert.equal(stale.status, 409, mutation); assert.equal(stale.data.operation.status, 'failed'); assert.equal(writes.length, 0, 'A changed reviewed upsert cannot authorize any create, update or deletion.');
      const refreshed = await invoke('plan'); assert.equal(refreshed.status, 200, JSON.stringify(refreshed.data)); const fresh = await invoke('sync', { planFingerprint: refreshed.data.fingerprint });
      if (mutation === 'missing-revision') { assert.equal(fresh.status, 502); assert.equal(writes.length, 0, 'Missing native revisions must never permit an unconditional update.'); }
      else if (mutation === 'ownership') { assert.equal(fresh.status, 409); assert.equal(writes.length, 0, 'A manual event cannot become a planned upsert.'); }
      else { assert.equal(fresh.status, 200, JSON.stringify(fresh.data)); assert.deepEqual(writes, [mutation === 'delete' ? 'POST' : 'PATCH']); }
    } finally { globalThis.fetch = originalFetch; db.close(); }
  }
});

test('External Google tombstones get a fresh reviewed generation, with calendar-bound allocation', async () => {
  for (const missing of ['cancelled', '404', '410']) {
    const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, remote = new Map(), writes = [];
    db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('external-delete'); CREATE TABLE calendar_connections(project_id TEXT PRIMARY KEY,calendar_id TEXT); INSERT INTO calendar_connections VALUES('external-delete','qa@example.test');");
    const store = { list(_project, collection) { return collection === 'posts' ? [{ id: 'one', content: 'Owned appointment', scheduledAt: '2070-01-01T10:00:00Z' }] : []; }, activity() {} }; let sequence = 0;
    globalThis.fetch = async (target, options = {}) => {
      const url = new URL(target); if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-token' });
      const id = url.pathname.split('/events/')[1], secondCalendar = decodeURIComponent(url.pathname).includes('/other@example.test/');
      if (options.method === 'GET') {
        if (!id) return Response.json({ items: secondCalendar ? [] : [...remote.values()].filter(event => event.status !== 'cancelled') });
        const event = remote.get(id); return event?.status === 'cancelled' && missing !== 'cancelled' ? Response.json({}, { status: Number(missing) }) : Response.json(event || {}, { status: event ? 200 : 404 });
      }
      const event = { ...JSON.parse(options.body), etag: '"owned-revision"' }; writes.push(event.id);
      if (remote.has(event.id)) return Response.json({ error: 'The identifier already exists, including cancelled resources.' }, { status: 409 });
      remote.set(event.id, event); return Response.json(event);
    };
    async function invoke(action, body = {}) {
      let response; await handleCalendar({ req: { method: action === 'plan' ? 'GET' : 'POST', headers: { 'idempotency-key': `external-delete-${++sequence}` } }, url: new URL('http://localhost/api/projects/external-delete/calendar/' + action), body, project: { id: 'external-delete' }, role: 'owner', user: { isOperator: true }, db, store, config: { env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'qa@example.test', GOOGLE_PRIVATE_KEY: privateKey } }, send(status, data) { response = { status, data }; } }); return response;
    }
    try {
      const original = (await invoke('plan')).data, oldId = original.upserts[0].id; assert.equal((await invoke('sync', { planFingerprint: original.fingerprint })).status, 200);
      remote.set(oldId, { id: oldId, status: 'cancelled' });
      const reviewed = await invoke('plan'); assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data)); const newId = reviewed.data.upserts[0].id;
      assert.notEqual(newId, oldId); assert.deepEqual(reviewed.data.upserts[0].plan, { collection: 'posts', recordId: 'one' });
      const synced = await invoke('sync', { planFingerprint: reviewed.data.fingerprint }); assert.equal(synced.status, 200); assert.deepEqual(writes, [oldId, newId], 'A known Google tombstone must never receive another create request.'); assert.equal(remote.get(newId).extendedProperties.private.ten98Generation, '1');
      db.prepare('UPDATE calendar_connections SET calendar_id=?').run('other@example.test');
      const remapped = await invoke('plan'); assert.equal(remapped.status, 200); assert.equal(remapped.data.upserts[0].id, oldId, 'A different calendar has its own generation allocation.');
    } finally { globalThis.fetch = originalFetch; db.close(); }
  }
});

test('Negative missing-event probes recheck mapping, role and session before retirement or preview', async () => {
  for (const status of [404, 410]) for (const change of ['mapping', 'role', 'session']) {
    const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch;
    db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('negative-probe'); CREATE TABLE calendar_connections(project_id TEXT PRIMARY KEY,calendar_id TEXT); INSERT INTO calendar_connections VALUES('negative-probe','qa@example.test');");
    const store = { list(_project, collection) { return collection === 'posts' ? [{ id: 'one', content: 'Known appointment', scheduledAt: '2070-01-01T10:00:00Z' }] : []; }, activity() {} };
    let event, removed = false, allowed = true, writes = 0, probes = 0;
    globalThis.fetch = async (target, options = {}) => {
      const url = new URL(target); if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-token' });
      if (options.method === 'GET') {
        if (!url.pathname.includes('/events/')) return Response.json({ items: removed ? [] : event ? [event] : [] });
        probes++;
        if (change === 'mapping') db.prepare('UPDATE calendar_connections SET calendar_id=?').run('changed@example.test'); else allowed = false;
        return Response.json({}, { status });
      }
      writes++; event = { ...JSON.parse(options.body), etag: '"confirmed-revision"' }; return Response.json(event);
    };
    async function invoke(action) {
      let response; await handleCalendar({ req: { method: action === 'plan' ? 'GET' : 'POST', headers: { 'idempotency-key': 'negative-probe-create' } }, url: new URL('http://localhost/api/projects/negative-probe/calendar/' + action), body: {}, project: { id: 'negative-probe' }, role: 'owner', user: { isOperator: true }, db, store, assertIntegrationSettings() { if (!allowed) throw Object.assign(new Error(change === 'session' ? 'Sign-in ended.' : 'Role changed.'), { status: 403 }); }, config: { env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'qa@example.test', GOOGLE_PRIVATE_KEY: privateKey } }, send(status, data) { response = { status, data }; } }); return response;
    }
    try {
      assert.equal((await invoke('sync')).status, 200); removed = true;
      const before = db.prepare('SELECT * FROM calendar_plan_generations').all(), preview = await invoke('plan');
      assert.equal(probes, 1); assert.equal(preview.status, 409, `${status} ${change}: ${JSON.stringify(preview.data)}`); assert.equal(preview.data.fingerprint, undefined); assert.equal(preview.data.upserts, undefined, 'A departed calendar or revoked session cannot receive an old-scope preview.');
      assert.deepEqual(db.prepare('SELECT * FROM calendar_plan_generations').all(), before, 'An accepted 404/410 cannot retire an event after its project access or mapping changed.'); assert.equal(writes, 1);
    } finally { globalThis.fetch = originalFetch; db.close(); }
  }
});

test('A never-proven native ID collision stays quarantined without claiming ownership or deleting it', async () => {
  const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch;
  db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('unknown-collision'); CREATE TABLE calendar_connections(project_id TEXT PRIMARY KEY,calendar_id TEXT); INSERT INTO calendar_connections VALUES('unknown-collision','qa@example.test');");
  const store = { list(_project, collection) { return collection === 'posts' ? [{ id: 'one', content: 'A new plan', scheduledAt: '2070-01-01T10:00:00Z' }] : []; }, activity() {} }; let writes = 0, sequence = 0;
  globalThis.fetch = async (target, options = {}) => {
    if (new URL(target).hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-token' });
    if (options.method === 'GET') return Response.json({ items: [] });
    assert.equal(options.method, 'POST', 'An unproven native collision cannot authorize a delete.'); writes++; return Response.json({}, { status: 409 });
  };
  async function invoke(action, body = {}, key = `unknown-collision-${++sequence}`) {
    let response; await handleCalendar({ req: { method: action === 'plan' ? 'GET' : 'POST', headers: { 'idempotency-key': key } }, url: new URL('http://localhost/api/projects/unknown-collision/calendar/' + action), body, project: { id: 'unknown-collision' }, role: 'owner', user: { isOperator: true }, db, store, config: { env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'qa@example.test', GOOGLE_PRIVATE_KEY: privateKey } }, send(status, data) { response = { status, data }; } }); return response;
  }
  try {
    const preview = await invoke('plan'), body = { planFingerprint: preview.data.fingerprint }, result = await invoke('sync', body, 'unknown-collision-original');
    assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(writes, 1);
    assert.equal((await invoke('sync', body, 'unknown-collision-original')).status, 409); assert.equal((await invoke('sync', body)).status, 409); assert.equal(writes, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM calendar_plan_generations').get().count, 0, 'Without native or confirmed local ownership proof, a collision cannot allocate a new identity automatically.');
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test('Manual event mutations bind reviewed revision and calendar, with conditional writes and preserved plan ownership', async () => {
  for (const method of ['PATCH', 'DELETE']) for (const mutation of ['revision', 'mapping', 'foreign', 'missing-review', 'between-read-and-write', 'valid']) {
    const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, writes = [], applied = [];
    db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('manual-review'); CREATE TABLE calendar_connections(project_id TEXT PRIMARY KEY,calendar_id TEXT); INSERT INTO calendar_connections VALUES('manual-review','qa@example.test');");
    const store = { list(_project, collection) { return collection === 'posts' ? [{ id: 'one', content: 'Owned appointment', scheduledAt: '2070-01-01T10:00:00Z' }] : []; }, activity() {} }, original = { ...calendarPlan(store, 'manual-review')[0], etag: '"reviewed-revision"' }; let event = structuredClone(original);
    const body = { summary: 'Updated manually', start: '2070-01-01T11:00:00Z', end: '2070-01-01T12:00:00Z', etag: original.etag, calendarId: 'qa@example.test' };
    if (mutation === 'revision') event.etag = '"new-native-revision"';
    if (mutation === 'mapping') db.prepare('UPDATE calendar_connections SET calendar_id=?').run('changed@example.test');
    if (mutation === 'foreign') event.extendedProperties.private.ten98ProjectId = 'other-project';
    if (mutation === 'missing-review') delete body.etag;
    globalThis.fetch = async (target, options = {}) => {
      if (new URL(target).hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-token' });
      if (options.method === 'GET') { const response = Response.json({ items: [event] }); if (mutation === 'between-read-and-write') { event.etag = '"raced-revision"'; event.extendedProperties.private.ten98ProjectId = 'other-project'; } return response; }
      writes.push(options.method); assert.equal(options.headers['If-Match'], original.etag);
      if (options.headers['If-Match'] !== event.etag) return Response.json({}, { status: 412 });
      applied.push(options.method);
      if (options.method === 'DELETE') { event = { id: event.id, status: 'cancelled' }; return new Response(null, { status: 204 }); }
      event = { ...JSON.parse(options.body), etag: '"saved-revision"' }; return Response.json(event);
    };
    try {
      let result; await handleCalendar({ req: { method, headers: { 'idempotency-key': 'manual-reviewed-action' } }, url: new URL('http://localhost/api/projects/manual-review/calendar/events/' + original.id), body, project: { id: 'manual-review' }, role: 'owner', user: { isOperator: true }, db, store, config: { env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'qa@example.test', GOOGLE_PRIVATE_KEY: privateKey } }, send(status, data) { result = { status, data }; } });
      if (mutation === 'valid') { assert.equal(result.status, 200, JSON.stringify(result.data)); assert.deepEqual(applied, [method]); if (method === 'PATCH') assert.deepEqual(event.extendedProperties, original.extendedProperties); }
      else { assert.equal(result.status, mutation === 'foreign' ? 404 : ['missing-review', 'between-read-and-write'].includes(mutation) ? 400 : 409); assert.deepEqual(applied, [], 'A stale, moved or unreviewed event must not be changed.'); assert.equal(writes.length, mutation === 'between-read-and-write' ? 1 : 0); }
      if (method === 'DELETE' && ['valid', 'between-read-and-write'].includes(mutation)) assert.equal(db.prepare('SELECT generation FROM calendar_plan_generations WHERE project_id=?').get('manual-review').generation, 1, 'The next ID is reserved before a plan deletion can become uncertain.');
    } finally { globalThis.fetch = originalFetch; db.close(); }
  }
});

test('Calendar plan sync stops stale local records before writing and quarantines partial batches', async () => {
  for (const during of ['list', 'write', 'remove', 'last', 'account']) {
    const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, writes = [];
    db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('plan-race'); CREATE TABLE calendar_connections(project_id TEXT PRIMARY KEY,calendar_id TEXT); INSERT INTO calendar_connections VALUES('plan-race','qa@example.test');");
    let posts = [{ id: 'one', content: 'First post', scheduledAt: '2070-01-01T10:00:00Z' }, { id: 'two', content: 'Second post', scheduledAt: '2070-01-02T10:00:00Z' }], change = true;
    const store = { list(_project, collection) { return collection === 'posts' ? structuredClone(posts) : []; }, activity() {} };
    function edit() { if (during === 'remove') posts.pop(); else if (during === 'account') posts[1].accountOverrides = { second: { platform: 'instagram', scheduledAt: '2070-02-02T10:00:00Z' } }; else posts[1].scheduledAt = '2070-02-02T10:00:00Z'; change = false; }
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
    const event = { ...JSON.parse(options.body), etag: '"planned-revision"' }; remote.set(event.id, event); writes++;
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
  globalThis.fetch = async (target, options = {}) => { reads++; if (new URL(target).hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-token' }); assert.equal(options.method, 'GET', 'Plan review is read-only.'); return Response.json({ items: [] }); };
  async function invoke(method, action, body = {}) {
    let response;
    await handleCalendar({ req: { method, headers: { 'idempotency-key': 'fingerprint-request' } }, url: new URL('http://localhost/api/projects/fingerprint/calendar/' + action), body, project: { id: 'fingerprint' }, role: 'owner', user: { isOperator: true }, db, store, config: { env: { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'qa@example.test', GOOGLE_PRIVATE_KEY: privateKey } }, send(status, data) { response = { status, data }; } });
    return response;
  }
  try {
    const first = await invoke('GET', 'plan'); assert.equal(first.status, 200); assert.match(first.data.fingerprint, /^[a-f0-9]{64}$/); assert.equal(reads, 2); assert.equal(first.data.upserts.length, 2); assert.deepEqual(first.data.deletions, []);
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
    assert.equal(response.status, 409); assert.equal(response.data.operation.status, 'failed'); assert.equal(response.data.error.code, 'OPERATION_NOT_SENT'); assert.notEqual(response.data.operation.id, 'legacy-operation'); assert.equal(db.prepare('SELECT status FROM integration_operations WHERE id=?').get('legacy-operation').status, 'uncertain');
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
    const event = { ...JSON.parse(options.body), etag: '"planned-revision"' }; assert.equal(event.extendedProperties.private.ten98ProjectId, 'project-a');
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
    const id = saved.data.event.id, deleteReview = { etag: saved.data.event.etag, calendarId: 'shared@example.test' };
    assert.equal((await invoke(`events/${id}`, { method: 'DELETE', body: deleteReview, key: 'stable-delete-001' })).data.deleted, true);
    assert.equal((await invoke(`events/${id}`, { method: 'DELETE', body: deleteReview, key: 'stable-delete-001' })).data.deleted, true);
    assert.equal(eventWrites().filter(call => call.options.method === 'DELETE').length, 1);
    malformedEventResponse = true;
    const malformedBody = { ...body, summary: 'Unconfirmed event details' }, beforeMalformed = eventWrites().length;
    const malformed = await invoke('events', { method: 'POST', body: malformedBody, key: 'malformed-event-create' });
    assert.equal(malformed.status, 409); assert.equal(malformed.data.operation.status, 'uncertain');
    await invoke('events', { method: 'POST', body: malformedBody, key: 'malformed-event-retry' });
    assert.equal(eventWrites().length, beforeMalformed + 1, 'Unreadable event details after a successful write must not authorize another create.');
    db.prepare("UPDATE integration_operations SET status='reviewed-applied' WHERE id=?").run(malformed.data.operation.id);
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
    db.prepare("UPDATE integration_operations SET status='reviewed-applied' WHERE id=?").run(invalidSync.data.operation.id);
    loseResponse = true; const uncertainBody = { ...body, summary: 'Check uncertain event' }, before = eventWrites().length;
    const uncertain = await invoke('events', { method: 'POST', body: uncertainBody, key: 'uncertain-create-001' }); assert.equal(uncertain.data.error.code, 'OPERATION_UNCERTAIN'); assert.equal(JSON.stringify(uncertain).includes('private upstream'), false);
    await invoke('events', { method: 'POST', body: uncertainBody, key: 'uncertain-create-001' }); await invoke('events', { method: 'POST', body: uncertainBody, key: 'uncertain-create-002' });
    assert.equal(eventWrites().length, before + 1, 'An uncertain provider write cannot be repeated with a fresh request key.');
  } finally { globalThis.fetch = originalFetch; db.close(); rmSync(dir, { recursive: true, force: true }); }
});
