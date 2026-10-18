import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, createStore } from '../server/database.mjs';
import { createWebhookService, WEBHOOK_MAX_BYTES } from '../server/webhooks.mjs';
import { handleEngagement } from '../server/engagement.mjs';

const env = { ZERNIO_WEBHOOK_SECRET: 'webhook-test-secret-with-enough-entropy' };
const signature = bytes => createHmac('sha256', env.ZERNIO_WEBHOOK_SECRET).update(bytes).digest('hex');
const event = (name = 'message.received', changes = {}) => ({
  id: randomUUID(), event: name, timestamp: '2026-10-10T12:00:00Z',
  profiles: [{ id: 'profile-a', externalId: 'project-b' }],
  account: { accountId: 'account-a', id: 'account-a', profileId: 'profile-a', platform: 'facebook' },
  conversation: { id: 'conversation-a', platformConversationId: 'native-conversation-a', participantName: 'Alex', participantId: 'contact-a', status: 'active' },
  message: { id: 'message-a', conversationId: 'conversation-a', platformMessageId: 'native-message-a', text: 'Launch details 👋', direction: 'incoming', sentAt: '2026-10-10T11:59:59Z', sender: { id: 'contact-a', name: 'Alex' } },
  ...changes,
});
function signed(service, payload, extraHeaders = {}) {
  const bytes = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  return service.receive(bytes, { 'x-zernio-signature': signature(bytes), ...extraHeaders });
}
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ten98-webhooks-'));
  const db = openDatabase(dir), store = createStore(db);
  db.prepare('INSERT INTO workspaces VALUES(?,?)').run('workspace-a', 'Workspace A');
  db.prepare('INSERT INTO workspaces VALUES(?,?)').run('workspace-b', 'Workspace B');
  db.prepare('INSERT INTO projects(id,workspace_id,name,zernio_profile_id) VALUES(?,?,?,?)').run('project-a', 'workspace-a', 'A', 'profile-a');
  db.prepare('INSERT INTO projects(id,workspace_id,name,zernio_profile_id) VALUES(?,?,?,?)').run('project-b', 'workspace-b', 'B', 'profile-b');
  return { dir, db, store, service: createWebhookService({ db, store, env }), cleanup() { db.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('raw signed delivery is durable, isolated, idempotent, and strictly authenticated', async () => {
  const f = fixture();
  try {
    const payload = event(), bytes = Buffer.from(JSON.stringify(payload));
    assert.equal(f.service.receive(bytes, {}).status, 401);
    assert.equal(createWebhookService({ ...f, env: {} }).receive(bytes, { 'x-zernio-signature': signature(bytes) }).status, 503);
    for (const value of ['', 'x'.repeat(64), `sha256=${signature(bytes)}`, signature(bytes).toUpperCase(), [signature(bytes)]]) assert.equal(f.service.receive(bytes, { 'x-zernio-signature': value }).status, 401);
    assert.equal(f.service.receive(Buffer.concat([bytes, Buffer.from(' ')]), { 'x-zernio-signature': signature(bytes) }).status, 401, 'Verify raw bytes, before parsing.');
    assert.equal(signed(f.service, '{broken').status, 400);
    assert.equal(signed(f.service, { ...payload, id: 'not-a-stable-event-id' }).status, 400);
    assert.equal(signed(f.service, payload, { 'x-zernio-event-id': randomUUID() }).status, 400);
    assert.equal(signed(f.service, Buffer.alloc(WEBHOOK_MAX_BYTES + 1).toString()).status, 413);
    const acknowledgements = await Promise.all(Array.from({ length: 10 }, async () => signed(f.service, payload)));
    assert.equal(acknowledgements[0].status, 202);
    assert.equal(acknowledgements.filter(value => value.status === 200).length, 9);
    assert.equal(f.store.list('project-a', 'conversations').length, 0, 'Acknowledgement does no inbox work or provider calls.');
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM webhook_events').get().count, 1);
    assert.equal(signed(f.service, { ...payload, message: { ...payload.message, text: 'conflicting payload' } }).status, 409);
    assert.deepEqual(f.service.processPending(), { processed: 1, pending: 0 });
    const [conversation] = f.store.list('project-a', 'conversations');
    assert.equal(conversation.source, 'zernio'); assert.equal(conversation.isLive, true);
    assert.equal(conversation.externalConversationId, 'native-conversation-a'); assert.equal(conversation.zernioConversationId, 'conversation-a'); assert.equal(conversation.accountId, 'account-a');
    assert.equal(conversation.messages[0].content, payload.message.text);
    assert.equal(f.store.list('project-b', 'conversations').length, 0, 'Never route by profiles[].externalId or client metadata.');
    assert.equal(signed(f.service, event('message.received', { id: randomUUID() })).status, 202);
    f.service.processPending();
    assert.equal(f.store.list('project-a', 'conversations')[0].messages.length, 1, 'Two events naming one provider message still produce one message.');
    signed(f.service, event('conversation.started', { conversation: { ...payload.conversation, id: 'native-conversation-a' } })); f.service.processPending();
    assert.equal(f.store.list('project-a', 'conversations').length, 1, 'Lifecycle events use the platform ID, not the internal message conversation ID.');
    const unknown = event('message.received', { account: { accountId: 'account-b', profileId: 'missing-profile', platform: 'facebook' }, profiles: [{ id: 'missing-profile' }] });
    signed(f.service, unknown);
    assert.deepEqual(f.service.processPending(), { processed: 0, pending: 1 });
    assert.equal(f.db.prepare('SELECT last_error FROM webhook_events WHERE id=?').get(unknown.id).last_error, 'PROFILE_NOT_MAPPED');
    const ambiguous = event();
    f.db.prepare("UPDATE projects SET zernio_profile_id='profile-a' WHERE id='project-b'").run();
    signed(f.service, ambiguous); f.service.processPending();
    assert.equal(f.db.prepare('SELECT last_error FROM webhook_events WHERE id=?').get(ambiguous.id).last_error, 'PROFILE_MAPPING_AMBIGUOUS');
    assert.equal(f.store.list('project-b', 'conversations').length, 0);
    f.db.prepare("UPDATE projects SET zernio_profile_id='profile-b' WHERE id='project-b'").run();
    assert.deepEqual(f.service.processPending({ now: Date.now() + 61000 }), { processed: 1, pending: 1 });
    const mismatch = event('message.received', { profiles: [{ id: 'profile-b' }] });
    signed(f.service, mismatch); f.service.processPending();
    assert.equal(f.db.prepare('SELECT last_error FROM webhook_events WHERE id=?').get(mismatch.id).last_error, 'PROFILE_CONTEXT_MISMATCH');
    signed(f.service, event('message.received', { test: true, message: { id: 'test-message', text: 'Fake DM' } }));
    signed(f.service, event('unsupported.example'));
    f.service.processPending();
    assert.equal(f.store.list('project-a', 'conversations')[0].messages.length, 1, 'Test and non-DM events must not create live DMs.');
    assert.equal(f.db.prepare("SELECT count(*) AS count FROM webhook_events WHERE status='ignored'").get().count, 2);
  } finally { f.cleanup(); }
});

test('message edits, deletions, receipts and post statuses tolerate out-of-order delivery', () => {
  const f = fixture();
  try {
    const base = event();
    const send = (name, timestamp, changes = {}) => { signed(f.service, { ...base, id: randomUUID(), event: name, timestamp, ...changes }); f.service.processPending(); };
    send('message.read', '2026-10-10T12:04:00Z', { message: { ...base.message, direction: 'outgoing' } });
    send('message.edited', '2026-10-10T12:03:00Z', { message: { ...base.message, text: 'Edited copy' }, editedAt: '2026-10-10T12:03:00Z' });
    send('message.received', '2026-10-10T12:00:00Z');
    send('message.delivered', '2026-10-10T12:02:00Z');
    let conversation = f.store.list('project-a', 'conversations')[0], message = conversation.messages[0];
    assert.equal(message.content, 'Edited copy'); assert.equal(message.deliveryStatus, 'read');
    assert.equal(conversation.providerEventAt, '2026-10-10T12:04:00.000Z');
    send('message.failed', '2026-10-10T12:05:00Z', { error: { code: '131026', message: 'Do not leak diagnostic secrets.' } });
    assert.equal(f.store.list('project-a', 'conversations')[0].messages[0].deliveryStatus, 'read', 'A failure cannot undo a confirmed read.');
    send('message.deleted', '2026-10-10T12:06:00Z');
    send('message.edited', '2026-10-10T12:07:00Z', { message: { ...base.message, text: 'Resurrect deleted content' } });
    message = f.store.list('project-a', 'conversations')[0].messages[0];
    assert.equal(message.content, ''); assert.ok(message.deletedAt);
    send('message.received', '2026-10-10T11:00:00Z', { message: { ...base.message, id: 'earlier-message', text: 'Earlier', sentAt: '2026-10-10T11:00:00Z' } });
    assert.deepEqual(f.store.list('project-a', 'conversations')[0].messages.map(item => item.id), ['earlier-message', 'message-a']);
    const post = f.store.create('project-a', 'posts', { content: 'Local copy', externalId: 'remote-post-a', zernioProfileId: 'profile-a', status: 'submitted' });
    const fakeOther = f.store.create('project-b', 'posts', { content: 'Other tenant', externalId: 'remote-post-a', zernioProfileId: 'profile-b', status: 'draft' });
    send('post.platform.published', '2026-10-10T12:08:00Z', { post: { id: 'remote-post-a', status: 'publishing' }, platform: { name: 'facebook', status: 'published' } });
    assert.equal(f.store.get('project-a', 'posts', post.id).status, 'submitted', 'One target publishing cannot finalize a multi-platform post.');
    send('post.published', '2026-10-10T12:10:00Z', { post: { id: 'remote-post-a', platforms: [{ accountId: 'account-b', content: 'Private other tenant copy' }] } });
    send('post.scheduled', '2026-10-10T12:09:00Z', { post: { id: 'remote-post-a' } });
    assert.equal(f.store.get('project-a', 'posts', post.id).status, 'published');
    assert.equal(f.store.get('project-b', 'posts', fakeOther.id).status, 'draft');
    assert.equal(JSON.stringify(f.store.get('project-a', 'posts', post.id)).includes('Private other tenant'), false);
  } finally { f.cleanup(); }
});

test('receipt-first and delete-first messages retain immutable native identity for REST reconciliation', () => {
  const f = fixture();
  try {
    for (const name of ['message.read', 'message.deleted']) {
      const payload = event(name, { timestamp: '2026-10-18T12:01:00Z' });
      payload.message = { ...payload.message, id: name, platformMessageId: `native-${name}`, text: 'Pre-delete content', direction: 'outgoing' };
      signed(f.service, payload); assert.deepEqual(f.service.processPending(), { processed: 1, pending: 0 });
      const find = () => f.store.list('project-a', 'conversations')[0].messages.find(row => row.id === name);
      assert.equal(find().platformMessageId, payload.message.platformMessageId, 'Lifecycle events must match the native REST message ID before any content event arrives.');
      signed(f.service, { ...payload, id: randomUUID(), event: 'message.sent', timestamp: '2026-10-18T12:00:00Z' }); f.service.processPending();
      assert.equal(find().platformMessageId, payload.message.platformMessageId);
      if (name === 'message.deleted') { assert.equal(find().content, ''); assert.ok(find().deletedAt); }
      else assert.equal(find().deliveryStatus, 'read');
      const conflict = { ...payload, id: randomUUID(), message: { ...payload.message, platformMessageId: 'different-native-message' } };
      signed(f.service, conflict); f.service.processPending();
      assert.equal(f.db.prepare('SELECT last_error FROM webhook_events WHERE id=?').get(conflict.id).last_error, 'MESSAGE_IDENTITY_MISMATCH');
      assert.equal(find().platformMessageId, payload.message.platformMessageId, 'Conflicting native identity stays pending without changing the cached message.');
    }
  } finally { f.cleanup(); }
});

test('queued work survives restart and its effects commit atomically with event completion', () => {
  const f = fixture();
  let reopened;
  try {
    const payload = event(); signed(f.service, payload);
    const faultyStore = { ...f.store, create(...args) { f.store.create(...args); throw new Error('Private provider diagnostic with a secret'); } };
    const faultyService = createWebhookService({ db: f.db, store: faultyStore, env });
    assert.deepEqual(faultyService.processPending(), { processed: 0, pending: 1 });
    assert.equal(f.store.list('project-a', 'conversations').length, 0);
    assert.equal(f.db.prepare('SELECT count(*) AS count FROM webhook_messages').get().count, 0);
    assert.equal(f.db.prepare('SELECT last_error FROM webhook_events WHERE id=?').get(payload.id).last_error, 'PROCESSING_FAILED');
    f.db.close();
    reopened = openDatabase(f.dir);
    const store = createStore(reopened), service = createWebhookService({ db: reopened, store, env });
    assert.deepEqual(service.processPending({ now: Date.now() + 61000 }), { processed: 1, pending: 0 });
    assert.equal(store.list('project-a', 'conversations')[0].messages.length, 1);
    assert.equal(signed(service, payload).status, 200);
    assert.deepEqual(service.processPending(), { processed: 0, pending: 0 });
  } finally {
    if (reopened) reopened.close(); else { try { f.db.close(); } catch {} }
    rmSync(f.dir, { recursive: true, force: true });
  }
});

test('comment and review webhook updates are durable, scoped and readable without provider polling', async () => {
  const f = fixture(), originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('Webhook update checks must never call a paid provider.'); };
  const comment = { id: randomUUID(), event: 'comment.received', timestamp: '2026-10-18T12:00:00Z', profiles: [{ id: 'profile-a', externalId: 'project-b' }], account: { id: 'account-a', platform: 'facebook' }, comment: { id: 'comment-a', platformPostId: 'post-a', platform: 'facebook', text: 'A comment' }, post: { platformPostId: 'post-a' } };
  async function updates(projectId = 'project-a', profile = 'profile-a', kind = 'comments') {
    let response;
    await handleEngagement({ req: { method: 'GET' }, url: new URL(`http://localhost/api/projects/${projectId}/engagement/updates?accountId=account-a&kind=${kind}`), project: { id: projectId, zernioProfileId: profile }, role: 'viewer', db: f.db, store: f.store, config: { env: {} }, send(status, data) { response = { status, data }; } }); return response;
  }
  try {
    assert.deepEqual((await updates()).data, { revision: 0, lastEventAt: null });
    assert.equal(signed(f.service, { ...comment, comment: { ...comment.comment, platform: 'instagram' } }).status, 400);
    assert.equal(signed(f.service, comment).status, 202); assert.equal(signed(f.service, comment).status, 200);
    assert.deepEqual(f.service.processPending(), { processed: 1, pending: 0 });
    assert.deepEqual((await updates()).data, { revision: 1, lastEventAt: '2026-10-18T12:00:00.000Z' });
    assert.equal((await updates('project-b', 'profile-b')).data.revision, 0); assert.equal((await updates('project-a', 'new-profile')).data.revision, 0);
    signed(f.service, { ...comment, id: randomUUID(), timestamp: '2026-10-18T11:00:00Z' }); f.service.processPending();
    assert.deepEqual((await updates()).data, { revision: 2, lastEventAt: '2026-10-18T12:00:00.000Z' }, 'Late delivery increments the receipt revision without moving the latest event backward.');
    signed(f.service, { ...comment, id: randomUUID(), comment: { ...comment.comment, ad: { id: 'paid-ad' } } }); f.service.processPending();
    assert.equal((await updates()).data.revision, 2, 'Ad comments cannot advertise a change in the organic-only feed.');
    for (const name of ['review.new', 'review.updated']) { signed(f.service, { id: randomUUID(), event: name, timestamp: '2026-10-18T12:01:00Z', profiles: [{ id: 'profile-a' }], account: { id: 'account-a', platform: 'googlebusiness' }, review: { id: 'accounts/a/locations/b/reviews/c', text: 'A review' } }); f.service.processPending(); }
    assert.equal((await updates('project-a', 'profile-a', 'reviews')).data.revision, 2);
    assert.equal(f.store.list('project-a', 'conversations').length, 0, 'Engagement events never create direct messages.');
    signed(f.service, { ...comment, id: randomUUID(), profiles: [{ id: 'profile-a' }, { id: 'profile-b' }] }); f.service.processPending();
    assert.equal((await updates()).data.revision, 2, 'Ambiguous profile context stays pending instead of broadcasting to tenants.');
    assert.equal((await updates('project-a', 'profile-a', 'unsupported')).status, 400);
    const reopened = createWebhookService({ db: f.db, store: f.store, env }); assert.deepEqual(reopened.processPending(), { processed: 0, pending: 0 });
    assert.equal((await updates()).data.revision, 2, 'Restarting the worker preserves revisions.');
  } finally { globalThis.fetch = originalFetch; f.cleanup(); }
});
