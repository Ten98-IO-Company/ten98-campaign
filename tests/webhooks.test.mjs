import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createStore } from '../server/database.ts';
import { createWebhookService, WEBHOOK_MAX_BYTES } from '../server/webhooks.ts';

const env = { ZERNIO_WEBHOOK_SECRET: 'webhook-test-secret-with-enough-entropy' };
const signature = bytes => createHmac('sha256', env.ZERNIO_WEBHOOK_SECRET).update(bytes).digest('hex');
const event = (name = 'post.published', changes = {}) => ({ id: randomUUID(), event: name, timestamp: '2026-10-10T12:00:00Z', profiles: [{ id: 'profile-a', externalId: 'project-b' }], post: { id: 'remote-post-a', content: 'مرحباً دبي 👋 — café' }, ...changes });
function signed(service, payload, extraHeaders = {}) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return service.receive(bytes, { 'x-zernio-signature': signature(bytes), ...extraHeaders });
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ten98-webhooks-')), db = openDatabase(dir), store = createStore(db);
  db.prepare('INSERT INTO workspaces VALUES(?,?)').run('workspace-a', 'Workspace A');
  db.prepare('INSERT INTO workspaces VALUES(?,?)').run('workspace-b', 'Workspace B');
  db.prepare('INSERT INTO projects(id,workspace_id,name,zernio_profile_id) VALUES(?,?,?,?)').run('project-a', 'workspace-a', 'A', 'profile-a');
  db.prepare('INSERT INTO projects(id,workspace_id,name,zernio_profile_id) VALUES(?,?,?,?)').run('project-b', 'workspace-b', 'B', 'profile-b');
  const post = store.create('project-a', 'posts', { content: 'Local copy', externalId: 'remote-post-a', zernioProfileId: 'profile-a', status: 'submitted' });
  return { dir, db, store, post, service: createWebhookService({ db, store, env }), cleanup() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('signed post deliveries preserve raw bytes, authenticate, deduplicate and durably update linked posts', async () => {
  const f = fixture();
  try {
    const payload = event(), bytes = Buffer.from(JSON.stringify(payload));
    assert.equal(f.service.receive(bytes, {}).status, 401);
    assert.equal(createWebhookService({ ...f, env: {} }).receive(bytes, { 'x-zernio-signature': signature(bytes) }).status, 503);
    for (const value of ['', 'x'.repeat(64), `sha256=${signature(bytes)}`, signature(bytes).toUpperCase(), [signature(bytes)]]) assert.equal(f.service.receive(bytes, { 'x-zernio-signature': value }).status, 401);
    assert.equal(f.service.receive(Buffer.concat([bytes, Buffer.from(' ')]), { 'x-zernio-signature': signature(bytes) }).status, 401, 'Verify bytes before parsing, including multibyte content.');
    assert.equal(signed(f.service, '{broken').status, 400); assert.equal(signed(f.service, Buffer.from([0xff, 0xfe])).status, 400);
    assert.equal(signed(f.service, { ...payload, id: 'not-a-stable-event-id' }).status, 400);
    assert.equal(signed(f.service, { ...payload, post: {} }).status, 400);
    assert.equal(signed(f.service, payload, { 'x-zernio-event-id': randomUUID() }).status, 400);
    assert.equal(signed(f.service, Buffer.alloc(WEBHOOK_MAX_BYTES + 1)).status, 413);
    const acknowledgements = await Promise.all(Array.from({ length: 10 }, async () => signed(f.service, payload)));
    assert.equal(acknowledgements[0].status, 202); assert.equal(acknowledgements.filter(value => value.status === 200).length, 9);
    assert.equal(f.store.get('project-a', 'posts', f.post.id).status, 'submitted', 'Acknowledgement performs no provider or record work.');
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM webhook_events').get().count, 1);
    assert.equal(signed(f.service, { ...payload, post: { ...payload.post, content: 'conflicting payload' } }).status, 409);
    assert.deepEqual(f.service.processPending(), { processed: 1, pending: 0 });
    const post = f.store.get('project-a', 'posts', f.post.id); assert.equal(post.status, 'published'); assert.equal(post.content, 'Local copy');
    assert.equal(f.store.list('project-b', 'posts').length, 0, 'Client externalId metadata is not routing evidence.');
    assert.equal(signed(f.service, payload).status, 200); assert.deepEqual(f.service.processPending(), { processed: 0, pending: 0 });
    signed(f.service, event('post.published', { test: true })); signed(f.service, event('unsupported.example'));
    assert.deepEqual(f.service.processPending(), { processed: 0, pending: 0 });
    assert.equal(f.db.prepare("SELECT count(*) AS count FROM webhook_events WHERE status='ignored'").get().count, 2);
  } finally { f.cleanup(); }
});

test('post lifecycle changes are profile scoped, reject ambiguous mappings and tolerate out-of-order delivery', () => {
  const f = fixture();
  try {
    const other = f.store.create('project-b', 'posts', { content: 'Other tenant', externalId: 'remote-post-a', zernioProfileId: 'profile-b', status: 'draft' });
    const send = (name, timestamp, changes = {}) => { const payload = event(name, { timestamp, ...changes }); signed(f.service, payload); f.service.processPending(); return payload; };
    send('post.platform.published', '2026-10-10T12:08:00Z', { post: { id: 'remote-post-a', status: 'publishing' }, platform: { name: 'facebook', status: 'published' } });
    assert.equal(f.store.get('project-a', 'posts', f.post.id).status, 'submitted', 'One publishing target cannot finalize a multi-platform post.');
    send('post.published', '2026-10-10T12:10:00Z', { post: { id: 'remote-post-a', platforms: [{ accountId: 'account-b', content: 'Private other tenant copy' }] } });
    send('post.scheduled', '2026-10-10T12:09:00Z');
    assert.equal(f.store.get('project-a', 'posts', f.post.id).status, 'published'); assert.equal(f.store.get('project-b', 'posts', other.id).status, 'draft');
    assert.equal(JSON.stringify(f.store.get('project-a', 'posts', f.post.id)).includes('Private other tenant'), false);
    const unknown = send('post.published', '2026-10-10T12:11:00Z', { profiles: [{ id: 'missing-profile' }] });
    assert.equal(f.db.prepare('SELECT last_error FROM webhook_events WHERE id=?').get(unknown.id).last_error, 'PROFILE_NOT_MAPPED');
    const unlinked = send('post.published', '2026-10-10T12:11:00Z', { post: { id: 'unlinked-provider-post' } });
    assert.equal(f.db.prepare('SELECT last_error FROM webhook_events WHERE id=?').get(unlinked.id).last_error, 'POST_NOT_LINKED');
    f.db.prepare("UPDATE projects SET zernio_profile_id='profile-a' WHERE id='project-b'").run();
    const ambiguous = send('post.published', '2026-10-10T12:12:00Z');
    assert.equal(f.db.prepare('SELECT last_error FROM webhook_events WHERE id=?').get(ambiguous.id).last_error, 'PROFILE_MAPPING_AMBIGUOUS');
    f.db.prepare("UPDATE projects SET zernio_profile_id='profile-b' WHERE id='project-b'").run();
    assert.deepEqual(f.service.processPending({ now: Date.now() + 61000 }), { processed: 1, pending: 2 });
    assert.equal(f.store.get('project-b', 'posts', other.id).status, 'draft');
  } finally { f.cleanup(); }
});

test('a delayed post webhook cannot restore a provider record already cancelled locally', () => {
  const f = fixture();
  try {
    const post = f.store.update('project-a', 'posts', f.post.id, { status: 'cancelled', providerStatus: 'cancelled', providerDeletedAt: '2026-10-10T12:10:00Z' });
    const delayed = event('post.scheduled', { timestamp: '2026-10-10T12:09:00Z' });
    assert.equal(signed(f.service, delayed).status, 202);
    assert.deepEqual(f.service.processPending(), { processed: 1, pending: 0 });
    assert.deepEqual(f.store.get('project-a', 'posts', f.post.id), post, 'Confirmed removal must survive a lifecycle event queued before cancellation.');
    assert.equal(f.db.prepare('SELECT status FROM webhook_events WHERE id=?').get(delayed.id).status, 'processed');
  } finally { f.cleanup(); }
});

test('queued post work survives restart and its effects commit atomically with event completion', () => {
  const f = fixture(); let reopened;
  try {
    const payload = event(); signed(f.service, payload);
    const faultyStore = { ...f.store, update(...args) { f.store.update(...args); throw new Error('Private provider diagnostic with a secret'); } };
    assert.deepEqual(createWebhookService({ db: f.db, store: faultyStore, env }).processPending(), { processed: 0, pending: 1 });
    assert.equal(f.store.get('project-a', 'posts', f.post.id).status, 'submitted', 'Event and local post status must roll back together.');
    assert.equal(f.db.prepare('SELECT last_error FROM webhook_events WHERE id=?').get(payload.id).last_error, 'PROCESSING_FAILED');
    f.db.close(); reopened = openDatabase(f.dir);
    const store = createStore(reopened), service = createWebhookService({ db: reopened, store, env });
    assert.deepEqual(service.processPending({ now: Date.now() + 61000 }), { processed: 1, pending: 0 });
    assert.equal(store.get('project-a', 'posts', f.post.id).status, 'published');
    assert.equal(signed(service, payload).status, 200); assert.deepEqual(service.processPending(), { processed: 0, pending: 0 });
  } finally { if (reopened) reopened.close(); else { try { f.db.close(); } catch {} } rmSync(f.dir, { recursive: true, force: true }); }
});

test('malformed inbox payloads cannot create contacts, while unknown and test events retain metadata only', () => {
  const f = fixture(), originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Webhook workers must never call a provider.'); };
  try {
    for (const name of ['message.received', 'conversation.started', 'comment.received', 'review.new', 'review.updated']) {
      const payload = event(name, { post: undefined, message: { text: 'PRIVATE_INBOX_TEXT' }, comment: { text: 'PRIVATE_COMMENT_TEXT' }, review: { text: 'PRIVATE_REVIEW_TEXT' } });
      assert.equal(signed(f.service, payload).status, 400);
    }
    for (const payload of [event('unsupported.message', { message: { text: 'PRIVATE_UNUSED_TEXT' } }), event('message.received', { test: true, message: { text: 'PRIVATE_TEST_TEXT' } })]) {
      assert.equal(signed(f.service, payload).status, 202); assert.equal(signed(f.service, payload).status, 200);
      assert.equal(signed(f.service, { ...payload, message: { text: 'different' } }).status, 409);
      const row = f.db.prepare('SELECT status,payload FROM webhook_events WHERE id=?').get(payload.id);
      assert.equal(row.status, 'ignored'); assert.deepEqual(JSON.parse(row.payload), { id: payload.id, event: payload.event, timestamp: payload.timestamp });
    }
    assert.deepEqual(f.service.processPending(), { processed: 0, pending: 0 });
    const legacy = event('message.received', { post: undefined, message: { text: 'LEGACY_PRIVATE_DM' } });
    f.db.prepare('INSERT INTO webhook_events(id,event,payload,body_hash,status,received_at) VALUES(?,?,?,?,?,?)').run(legacy.id, legacy.event, JSON.stringify(legacy), 'legacy-hash', 'pending', new Date().toISOString());
    assert.deepEqual(f.service.processPending(), { processed: 0, pending: 0 });
    const row = f.db.prepare('SELECT status,payload FROM webhook_events WHERE id=?').get(legacy.id);
    assert.equal(row.status, 'ignored'); assert.equal(row.payload.includes('LEGACY_PRIVATE_DM'), false);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM direct_contacts').get().n, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS n FROM webhook_inbox_updates').get().n, 0);
    assert.equal(f.store.get('project-a', 'posts', f.post.id).status, 'submitted');
  } finally { globalThis.fetch = originalFetch; f.cleanup(); }
});
