import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createContacts } from '../server/contacts.mjs';
import { createWebhookService } from '../server/webhooks.mjs';

const env = { ZERNIO_WEBHOOK_SECRET: 'signed-inbox-fixture-secret' };
const originalFetch = globalThis.fetch;
before(() => { globalThis.fetch = () => { throw new Error('Webhook workers must not call a provider.'); }; });
after(() => { globalThis.fetch = originalFetch; });
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec("PRAGMA foreign_keys=ON; CREATE TABLE projects(id TEXT PRIMARY KEY,zernio_profile_id TEXT NOT NULL); INSERT INTO projects VALUES('project-a','profile-a'),('project-b','profile-b');");
  const contacts = createContacts({ db }), store = { list: () => [] }, service = createWebhookService({ db, store, contacts, env });
  return { db, contacts, service };
}
const event = (changes = {}) => ({
  id: randomUUID(), event: 'message.received', timestamp: '2026-10-18T12:00:00Z',
  profiles: [{ id: 'profile-a', externalId: 'project-b' }],
  account: { accountId: 'page-a', id: 'page-a', profileId: 'profile-a', platform: 'facebook' },
  conversation: { id: 'conversation-a', platformConversationId: 'facebook-thread-a', participantId: 'participant-a', participantName: 'Alex Messenger', platform: 'facebook', extra: 'PRIVATE_CONVERSATION_METADATA' },
  message: { id: 'message-a', conversationId: 'conversation-a', platform: 'facebook', direction: 'incoming', sender: { id: 'participant-a', name: 'Sender name', email: 'PRIVATE_SENDER_EMAIL' }, text: 'PRIVATE_MESSAGE_TEXT', attachments: [{ url: 'https://example.test/PRIVATE_ATTACHMENT' }], metadata: { private: 'PRIVATE_MESSAGE_METADATA' } },
  ...changes,
});
function signed(service, payload) {
  const raw = Buffer.from(JSON.stringify(payload));
  return service.receive(raw, { 'x-zernio-signature': createHmac('sha256', env.ZERNIO_WEBHOOK_SECRET).update(raw).digest('hex') });
}
const count = (db, table) => db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count;

test('signed incoming Messenger events create one identity contact and retain notifications without message content', () => {
  const f = fixture();
  try {
    const payload = event();
    assert.equal(signed(f.service, payload).status, 202); assert.equal(f.contacts.list('project-a').length, 0, 'Acknowledgement does not mutate contacts.');
    const queued = f.db.prepare('SELECT payload,body_hash FROM webhook_events WHERE id=?').get(payload.id);
    assert.equal(queued.body_hash, createHash('sha256').update(JSON.stringify(payload)).digest('hex'));
    assert.equal(queued.payload.includes('PRIVATE_'), false, 'Only identity and notification metadata may be retained.');
    assert.equal(signed(f.service, payload).status, 200); assert.equal(signed(f.service, { ...payload, message: { ...payload.message, text: 'Another private body' } }).status, 409);
    assert.deepEqual(f.service.processPending(), { processed: 1, pending: 0 });
    const [contact] = f.contacts.list('project-a'); assert.ok(contact); assert.equal(f.contacts.list('project-b').length, 0, 'An externalId is not profile routing evidence.');
    assert.equal(contact.email, ''); assert.equal(contact.phone, ''); assert.deepEqual(contact.consents, { email: false, sms: false, whatsapp: false }); assert.deepEqual(contact.consentEvidence, {});
    assert.equal(contact.identities[0].conversationId, 'facebook-thread-a');
    const update = f.service.updates('project-a', { accountId: 'page-a', after: 0 }); assert.equal(update.updates.length, 1); assert.equal(update.updates[0].contactId, contact.id); assert.equal(JSON.stringify(update).includes('PRIVATE_'), false);
    assert.equal(signed(f.service, payload).status, 200); assert.deepEqual(f.service.processPending(), { processed: 0, pending: 0 }); assert.equal(count(f.db, 'webhook_inbox_updates'), 1);
    f.contacts.save('project-a', { name: 'Our customer label', tags: ['customer'] }, contact.id);
    const newer = event({ conversation: { ...payload.conversation, participantName: 'Different provider name' }, message: { ...payload.message, id: 'message-b' } }); signed(f.service, newer); f.service.processPending();
    assert.equal(f.contacts.list('project-a').length, 1); assert.equal(f.contacts.get('project-a', contact.id).name, 'Our customer label'); assert.deepEqual(f.contacts.get('project-a', contact.id).tags, ['customer']); assert.deepEqual(f.contacts.get('project-a', contact.id).consents, contact.consents);
    assert.equal(f.db.prepare('SELECT payload FROM webhook_events WHERE id=?').get(newer.id).payload.includes('PRIVATE_'), false);
  } finally { f.db.close(); }
});

test('only proven incoming Facebook senders create contacts, with consistent conversation and account platforms', () => {
  const f = fixture();
  try {
    const original = event(), cases = [
      { event: 'message.sent' },
      { message: { ...original.message, direction: 'outgoing' } },
      { message: { ...original.message, direction: undefined } },
      { message: { ...original.message, sender: { id: 'different-participant' } } },
      { account: { ...original.account, platform: 'instagram' }, conversation: { ...original.conversation, platform: 'instagram' }, message: { ...original.message, platform: 'instagram' } },
      { event: 'conversation.started', message: undefined },
      { event: 'reaction.received', reaction: { platformMessageId: 'native-a', emoji: '👍', action: 'added' } },
      { event: 'referral.received', referral: { source: 'PRIVATE_REFERRAL' } },
      { event: 'comment.received', conversation: undefined, message: undefined, comment: { id: 'comment-a', platformPostId: 'post-a', platform: 'facebook', text: 'PRIVATE_COMMENT_TEXT' } },
      { event: 'review.new', account: { ...original.account, platform: 'googlebusiness' }, conversation: undefined, message: undefined, review: { id: 'review-a', platform: 'googlebusiness', text: 'PRIVATE_REVIEW_TEXT', reply: { text: 'PRIVATE_REVIEW_REPLY' } } },
    ];
    for (const changes of cases) { const payload = event(changes); assert.equal(signed(f.service, payload).status, 202); assert.deepEqual(f.service.processPending(), { processed: 1, pending: 0 }); }
    assert.equal(f.contacts.list('project-a').length, 0); assert.equal(count(f.db, 'webhook_inbox_updates'), cases.length);
    for (const row of f.db.prepare('SELECT payload FROM webhook_events').all()) assert.equal(row.payload.includes('PRIVATE_'), false);
    assert.equal(signed(f.service, event({ account: { ...original.account, id: 'another-account' } })).status, 400);
    assert.equal(signed(f.service, event({ conversation: { ...original.conversation, platform: 'instagram' } })).status, 400, 'A contradictory conversation cannot establish a Messenger identity.');
    assert.equal(signed(f.service, event({ message: { ...original.message, platform: 'instagram' } })).status, 400);
    for (const participantId of ['different participant', 123]) assert.equal(signed(f.service, event({ conversation: { ...original.conversation, participantId } })).status, 400, 'Malformed participant identity must not become an absent identity during minimization.');
    assert.equal(f.contacts.list('project-a').length, 0);
    const withoutParticipant = event({ conversation: { ...original.conversation, participantId: undefined } }); signed(f.service, withoutParticipant); f.service.processPending();
    assert.equal(f.contacts.list('project-a').length, 1, 'A verified incoming sender is sufficient when the optional participant field is absent.');
  } finally { f.db.close(); }
});

test('unknown and ambiguous profile mappings defer all effects and recover without duplicate contacts', () => {
  const f = fixture();
  try {
    const original = event(), unknown = event({ profiles: [{ id: 'profile-c' }], account: { ...original.account, profileId: 'profile-c' } });
    signed(f.service, unknown); assert.deepEqual(f.service.processPending(), { processed: 0, pending: 1 }); assert.equal(count(f.db, 'direct_contacts'), 0); assert.equal(count(f.db, 'webhook_inbox_updates'), 0);
    assert.equal(f.db.prepare('SELECT last_error FROM webhook_events WHERE id=?').get(unknown.id).last_error, 'PROFILE_NOT_MAPPED');
    f.db.prepare('INSERT INTO projects VALUES(?,?)').run('project-c', 'profile-c'); assert.deepEqual(f.service.processPending({ now: Date.now() + 61000 }), { processed: 1, pending: 0 }); assert.equal(f.contacts.list('project-c').length, 1);
    f.db.prepare("UPDATE projects SET zernio_profile_id='profile-a' WHERE id='project-b'").run();
    const ambiguous = event(); signed(f.service, ambiguous); assert.deepEqual(f.service.processPending(), { processed: 0, pending: 1 }); assert.equal(f.contacts.list('project-a').length, 0);
    assert.equal(f.db.prepare('SELECT last_error FROM webhook_events WHERE id=?').get(ambiguous.id).last_error, 'PROFILE_MAPPING_AMBIGUOUS');
    f.db.prepare("UPDATE projects SET zernio_profile_id='profile-b' WHERE id='project-b'").run(); assert.deepEqual(f.service.processPending({ now: Date.now() + 61000 }), { processed: 1, pending: 0 }); assert.equal(f.contacts.list('project-a').length, 1); assert.equal(f.contacts.list('project-b').length, 0);
    const mismatched = event({ profiles: [{ id: 'profile-b' }] }); signed(f.service, mismatched); assert.deepEqual(f.service.processPending(), { processed: 0, pending: 1 }); assert.equal(f.db.prepare('SELECT last_error FROM webhook_events WHERE id=?').get(mismatched.id).last_error, 'PROFILE_CONTEXT_MISMATCH'); assert.equal(f.contacts.list('project-b').length, 0);
    assert.equal(signed(f.service, ambiguous).status, 200); assert.equal(count(f.db, 'direct_contacts'), 2);
  } finally { f.db.close(); }
});

test('notification cursors remain isolated by project, current profile and account, with bounded pagination', () => {
  const f = fixture();
  try {
    const original = event(), accountB = event({ account: { ...original.account, accountId: 'page-b', id: 'page-b' } }), projectB = event({ profiles: [{ id: 'profile-b' }], account: { ...original.account, profileId: 'profile-b' } });
    const scoped = [original, event(), event()];
    for (const payload of [scoped[0], accountB, projectB, scoped[1], scoped[2]]) signed(f.service, payload);
    assert.deepEqual(f.service.processPending(), { processed: 5, pending: 0 });
    assert.deepEqual(f.service.updates('project-a', { accountId: 'page-a' }).updates, []);
    const first = f.service.updates('project-a', { accountId: 'page-a', after: 0, limit: 1 }); assert.equal(first.hasMore, true); assert.equal(first.updates[0].id, scoped[0].id);
    const second = f.service.updates('project-a', { accountId: 'page-a', after: first.cursor, limit: 1 }); assert.equal(second.hasMore, true); assert.equal(second.updates[0].id, scoped[1].id);
    const third = f.service.updates('project-a', { accountId: 'page-a', after: second.cursor, limit: 1 }); assert.equal(third.hasMore, false); assert.equal(third.updates[0].id, scoped[2].id);
    assert.deepEqual(f.service.updates('project-a', { accountId: 'page-b', after: 0 }).updates.map(row => row.id), [accountB.id]);
    assert.deepEqual(f.service.updates('project-b', { accountId: 'page-a', after: 0 }).updates.map(row => row.id), [projectB.id]);
    assert.deepEqual(f.service.updates('project-b', { accountId: 'page-b', after: 0 }).updates, []);
    f.db.prepare("UPDATE projects SET zernio_profile_id='new-profile' WHERE id='project-a'").run(); assert.deepEqual(f.service.updates('project-a', { accountId: 'page-a', after: 0 }).updates, []);
    for (const after of [-1, 'x', Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => f.service.updates('project-b', { accountId: 'page-a', after }), error => error.status === 400);
    assert.throws(() => f.service.updates('project-b', { accountId: '', after: 0 }), error => error.status === 400);
  } finally { f.db.close(); }
});

test('contact, identity, notification and event completion commit together; queued legacy bodies are minimized', () => {
  const f = fixture();
  try {
    const payload = event(); signed(f.service, payload);
    f.db.exec("CREATE TRIGGER fail_event_completion BEFORE UPDATE OF status ON webhook_events WHEN NEW.status='processed' BEGIN SELECT RAISE(ABORT,'PRIVATE_STORAGE_DIAGNOSTIC'); END;");
    assert.deepEqual(f.service.processPending(), { processed: 0, pending: 1 });
    for (const table of ['direct_contacts', 'direct_contact_messenger_identities', 'webhook_inbox_updates']) assert.equal(count(f.db, table), 0, `${table} must roll back with failed completion.`);
    const failed = f.db.prepare('SELECT status,last_error,processed_at FROM webhook_events WHERE id=?').get(payload.id); assert.equal(failed.status, 'pending'); assert.equal(failed.last_error, 'PROCESSING_FAILED'); assert.equal(failed.processed_at, null);
    f.db.exec('DROP TRIGGER fail_event_completion'); assert.deepEqual(f.service.processPending({ now: Date.now() + 61000 }), { processed: 1, pending: 0 }); assert.equal(count(f.db, 'direct_contacts'), 1); assert.equal(count(f.db, 'webhook_inbox_updates'), 1);
    const legacy = event({ message: { ...payload.message, id: 'legacy-message' } });
    f.db.prepare('INSERT INTO webhook_events(id,event,payload,body_hash,status,received_at) VALUES(?,?,?,?,?,?)').run(legacy.id, legacy.event, JSON.stringify(legacy), 'legacy-hash', 'pending', new Date().toISOString());
    assert.deepEqual(f.service.processPending(), { processed: 1, pending: 0 }); assert.equal(count(f.db, 'direct_contacts'), 1);
    assert.equal(f.db.prepare('SELECT payload FROM webhook_events WHERE id=?').get(legacy.id).payload.includes('PRIVATE_'), false, 'Successful legacy processing must persist the minimized representation.');
  } finally { f.db.close(); }
});
