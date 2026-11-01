import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import pg from 'pg';
import { connect, createStore } from '../server/database.ts';
import { createWebhookService, WEBHOOK_MAX_BYTES } from '../server/webhooks.ts';
import { postgresSkip, testDatabase } from './postgres.mjs';
import { seedAccounts } from './fixtures/accounts.ts';

const env = { ZERNIO_WEBHOOK_SECRET: 'webhook-test-secret-with-enough-entropy' };
const signature = bytes => createHmac('sha256', env.ZERNIO_WEBHOOK_SECRET).update(bytes).digest('hex');
const event = (name = 'post.published', changes = {}) => ({ id: randomUUID(), event: name, timestamp: '2026-10-10T12:00:00Z', profiles: [{ id: 'profile-a', externalId: 'project-b' }], post: { id: 'remote-post-a', content: 'مرحباً دبي 👋 — café' }, ...changes });
function signed(service, payload, extraHeaders = {}) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return service.receive(bytes, { 'x-zernio-signature': signature(bytes), ...extraHeaders });
}
async function fixture(t) {
  const { db, pool, url } = await testDatabase(t), store = createStore(db);
  await seedAccounts(pool, { workspaces: [{ id: 'workspace-a', name: 'Workspace A' }, { id: 'workspace-b', name: 'Workspace B' }] });
  await pool.query("INSERT INTO projects (id, workspace_id, name, zernio_profile_id) VALUES ('project-a', 'workspace-a', 'A', 'profile-a'), ('project-b', 'workspace-b', 'B', 'profile-b')");
  const post = await store.create('project-a', 'posts', { content: 'Local copy', externalId: 'remote-post-a', zernioProfileId: 'profile-a', status: 'submitted' });
  const one = async (text, params) => (await pool.query(text, params)).rows[0];
  return { db, pool, url, one, store, post, service: createWebhookService({ db, env }) };
}

test('signed post deliveries preserve raw bytes, authenticate, deduplicate and durably update linked posts', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  const payload = event(), bytes = Buffer.from(JSON.stringify(payload));
  assert.equal((await f.service.receive(bytes, {})).status, 401);
  assert.equal((await createWebhookService({ db: f.db, env: {} }).receive(bytes, { 'x-zernio-signature': signature(bytes) })).status, 503);
  for (const value of ['', 'x'.repeat(64), `sha256=${signature(bytes)}`, signature(bytes).toUpperCase(), [signature(bytes)]]) assert.equal((await f.service.receive(bytes, { 'x-zernio-signature': value })).status, 401);
  assert.equal((await f.service.receive(Buffer.concat([bytes, Buffer.from(' ')]), { 'x-zernio-signature': signature(bytes) })).status, 401, 'Verify bytes before parsing, including multibyte content.');
  assert.equal((await signed(f.service, '{broken')).status, 400); assert.equal((await signed(f.service, Buffer.from([0xff, 0xfe]))).status, 400);
  assert.equal((await signed(f.service, { ...payload, id: 'not-a-stable-event-id' })).status, 400);
  assert.equal((await signed(f.service, { ...payload, post: {} })).status, 400);
  assert.equal((await signed(f.service, payload, { 'x-zernio-event-id': randomUUID() })).status, 400);
  assert.equal((await signed(f.service, Buffer.alloc(WEBHOOK_MAX_BYTES + 1))).status, 413);
  // Concurrent duplicate deliveries race on separate connections; exactly one may be accepted as new.
  const acknowledgements = await Promise.all(Array.from({ length: 10 }, async () => signed(f.service, payload)));
  assert.equal(acknowledgements.filter(value => value.status === 202).length, 1); assert.equal(acknowledgements.filter(value => value.status === 200).length, 9);
  assert.equal((await f.store.get('project-a', 'posts', f.post.id)).status, 'submitted', 'Acknowledgement performs no provider or record work.');
  assert.equal((await f.one('SELECT count(*) AS count FROM webhook_events')).count, 1);
  assert.equal((await signed(f.service, { ...payload, post: { ...payload.post, content: 'conflicting payload' } })).status, 409);
  // Two services draining at once must not process the same event twice.
  const drains = await Promise.all([f.service.processPending(), createWebhookService({ db: f.db, env }).processPending()]);
  assert.deepEqual(drains.reduce((total, value) => ({ processed: total.processed + value.processed, pending: total.pending + value.pending })), { processed: 1, pending: 0 });
  assert.equal((await f.one('SELECT attempts FROM webhook_events WHERE id=$1', [payload.id])).attempts, 1);
  const post = await f.store.get('project-a', 'posts', f.post.id); assert.equal(post.status, 'published'); assert.equal(post.content, 'Local copy');
  assert.equal((await f.store.list('project-b', 'posts')).length, 0, 'Client externalId metadata is not routing evidence.');
  assert.equal((await signed(f.service, payload)).status, 200); assert.deepEqual(await f.service.processPending(), { processed: 0, pending: 0 });
  await signed(f.service, event('post.published', { test: true })); await signed(f.service, event('unsupported.example'));
  assert.deepEqual(await f.service.processPending(), { processed: 0, pending: 0 });
  assert.equal((await f.one("SELECT count(*) AS count FROM webhook_events WHERE status='ignored'")).count, 2);
});

test('post lifecycle changes are profile scoped, reject ambiguous mappings and tolerate out-of-order delivery', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  const other = await f.store.create('project-b', 'posts', { content: 'Other tenant', externalId: 'remote-post-a', zernioProfileId: 'profile-b', status: 'draft' });
  const send = async (name, timestamp, changes = {}) => { const payload = event(name, { timestamp, ...changes }); await signed(f.service, payload); await f.service.processPending(); return payload; };
  await send('post.platform.published', '2026-10-10T12:08:00Z', { post: { id: 'remote-post-a', status: 'publishing' }, platform: { name: 'facebook', status: 'published' } });
  assert.equal((await f.store.get('project-a', 'posts', f.post.id)).status, 'submitted', 'One publishing target cannot finalize a multi-platform post.');
  await send('post.published', '2026-10-10T12:10:00Z', { post: { id: 'remote-post-a', platforms: [{ accountId: 'account-b', content: 'Private other tenant copy' }] } });
  await send('post.scheduled', '2026-10-10T12:09:00Z');
  assert.equal((await f.store.get('project-a', 'posts', f.post.id)).status, 'published'); assert.equal((await f.store.get('project-b', 'posts', other.id)).status, 'draft');
  assert.equal(JSON.stringify(await f.store.get('project-a', 'posts', f.post.id)).includes('Private other tenant'), false);
  const unknown = await send('post.published', '2026-10-10T12:11:00Z', { profiles: [{ id: 'missing-profile' }] });
  assert.equal((await f.one('SELECT last_error FROM webhook_events WHERE id=$1', [unknown.id])).last_error, 'PROFILE_NOT_MAPPED');
  const unlinked = await send('post.published', '2026-10-10T12:11:00Z', { post: { id: 'unlinked-provider-post' } });
  assert.equal((await f.one('SELECT last_error FROM webhook_events WHERE id=$1', [unlinked.id])).last_error, 'POST_NOT_LINKED');
  // A profile mapped to two projects is now refused by the projects_zernio_profile index; drop it here to keep
  // checking that legacy duplicate mappings still fail closed.
  await f.pool.query('DROP INDEX projects_zernio_profile');
  await f.pool.query("UPDATE projects SET zernio_profile_id='profile-a' WHERE id='project-b'");
  const ambiguous = await send('post.published', '2026-10-10T12:12:00Z');
  assert.equal((await f.one('SELECT last_error FROM webhook_events WHERE id=$1', [ambiguous.id])).last_error, 'PROFILE_MAPPING_AMBIGUOUS');
  await f.pool.query("UPDATE projects SET zernio_profile_id='profile-b' WHERE id='project-b'");
  assert.deepEqual(await f.service.processPending({ now: Date.now() + 61000 }), { processed: 1, pending: 2 });
  assert.equal((await f.store.get('project-b', 'posts', other.id)).status, 'draft');
});

test('a delayed post webhook cannot restore a provider record already cancelled locally', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  const post = await f.store.update('project-a', 'posts', f.post.id, { status: 'cancelled', providerStatus: 'cancelled', providerDeletedAt: '2026-10-10T12:10:00Z' });
  const delayed = event('post.scheduled', { timestamp: '2026-10-10T12:09:00Z' });
  assert.equal((await signed(f.service, delayed)).status, 202);
  assert.deepEqual(await f.service.processPending(), { processed: 1, pending: 0 });
  assert.deepEqual(await f.store.get('project-a', 'posts', f.post.id), post, 'Confirmed removal must survive a lifecycle event queued before cancellation.');
  assert.equal((await f.one('SELECT status FROM webhook_events WHERE id=$1', [delayed.id])).status, 'processed');
});

test('queued post work survives restart and its effects commit atomically with event completion', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  const payload = event(); await signed(f.service, payload);
  const faultyStore = tx => { const store = createStore(tx); return { ...store, async update(...args) { await store.update(...args); throw new Error('Private provider diagnostic with a secret'); } }; };
  assert.deepEqual(await createWebhookService({ db: f.db, storeFor: faultyStore, env }).processPending(), { processed: 0, pending: 1 });
  assert.equal((await f.store.get('project-a', 'posts', f.post.id)).status, 'submitted', 'Event and local post status must roll back together.');
  assert.equal((await f.one('SELECT last_error FROM webhook_events WHERE id=$1', [payload.id])).last_error, 'PROCESSING_FAILED');
  await f.pool.end();
  const reopened = connect(f.url);
  try {
    const store = createStore(reopened.db), service = createWebhookService({ db: reopened.db, env });
    assert.deepEqual(await service.processPending({ now: Date.now() + 61000 }), { processed: 1, pending: 0 });
    assert.equal((await store.get('project-a', 'posts', f.post.id)).status, 'published');
    assert.equal((await signed(service, payload)).status, 200); assert.deepEqual(await service.processPending(), { processed: 0, pending: 0 });
  } finally { await reopened.pool.end(); }
});

test('malformed inbox payloads cannot create contacts, while unknown and test events retain metadata only', { skip: postgresSkip }, async t => {
  const f = await fixture(t), originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Webhook workers must never call a provider.'); };
  try {
    for (const name of ['message.received', 'conversation.started', 'comment.received', 'review.new', 'review.updated']) {
      const payload = event(name, { post: undefined, message: { text: 'PRIVATE_INBOX_TEXT' }, comment: { text: 'PRIVATE_COMMENT_TEXT' }, review: { text: 'PRIVATE_REVIEW_TEXT' } });
      assert.equal((await signed(f.service, payload)).status, 400);
    }
    for (const payload of [event('unsupported.message', { message: { text: 'PRIVATE_UNUSED_TEXT' } }), event('message.received', { test: true, message: { text: 'PRIVATE_TEST_TEXT' } })]) {
      assert.equal((await signed(f.service, payload)).status, 202); assert.equal((await signed(f.service, payload)).status, 200);
      assert.equal((await signed(f.service, { ...payload, message: { text: 'different' } })).status, 409);
      const row = await f.one('SELECT status,payload FROM webhook_events WHERE id=$1', [payload.id]);
      assert.equal(row.status, 'ignored'); assert.deepEqual(JSON.parse(row.payload), { id: payload.id, event: payload.event, timestamp: payload.timestamp });
    }
    assert.deepEqual(await f.service.processPending(), { processed: 0, pending: 0 });
    const legacy = event('message.received', { post: undefined, message: { text: 'LEGACY_PRIVATE_DM' } });
    await f.pool.query('INSERT INTO webhook_events(id,event,payload,body_hash,status,received_at) VALUES($1,$2,$3,$4,$5,$6)', [legacy.id, legacy.event, JSON.stringify(legacy), 'legacy-hash', 'pending', new Date().toISOString()]);
    assert.deepEqual(await f.service.processPending(), { processed: 0, pending: 0 });
    const row = await f.one('SELECT status,payload FROM webhook_events WHERE id=$1', [legacy.id]);
    assert.equal(row.status, 'ignored'); assert.equal(row.payload.includes('LEGACY_PRIVATE_DM'), false);
    assert.equal((await f.one('SELECT count(*) AS n FROM direct_contacts')).n, 0);
    assert.equal((await f.one('SELECT count(*) AS n FROM webhook_inbox_updates')).n, 0);
    assert.equal((await f.store.get('project-a', 'posts', f.post.id)).status, 'submitted');
  } finally { globalThis.fetch = originalFetch; }
});

test('a post event reads the linked post by provider ID, not the whole collection', { skip: postgresSkip }, async t => {
  const f = await fixture(t);
  await f.pool.query(`INSERT INTO records (id, project_id, collection, data) SELECT 'other-' || n, 'project-a', 'posts', json_build_object('id', 'other-' || n, 'content', 'Other post', 'externalId', 'remote-other-' || n, 'zernioProfileId', 'profile-a') FROM generate_series(1, 300) n`);
  assert.equal((await signed(f.service, event('post.published', { profiles: [{ id: 'profile-a' }] }))).status, 202);
  // Count rows returned on every connection, including the drain's transaction.
  let rows = 0; const query = pg.Client.prototype.query;
  pg.Client.prototype.query = function (...args) { const result = query.apply(this, args); if (result?.then) result.then(value => { rows += value?.rows?.length || 0; }, () => {}); return result; };
  try { assert.deepEqual(await f.service.processPending(), { processed: 1, pending: 0 }); } finally { pg.Client.prototype.query = query; }
  assert.equal((await f.store.get('project-a', 'posts', f.post.id)).status, 'published');
  assert.ok(rows < 40, `Applying one post event read ${rows} rows; loading every post reads more than 300.`);
});
