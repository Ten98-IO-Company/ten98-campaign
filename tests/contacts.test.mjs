import test from 'node:test';
import assert from 'node:assert/strict';
import { createContacts } from '../server/contacts.ts';
import { postgresSkip, testDatabase } from './postgres.mjs';

const pg = { skip: postgresSkip };
// Drizzle wraps driver errors; the PostgreSQL message is on the cause.
const failure = pattern => error => pattern.test(error.cause?.message ?? error.message);
async function fixture(t) {
  const { db, pool } = await testDatabase(t);
  await pool.query("INSERT INTO workspaces (id, name) VALUES ('w', 'Fixture'); INSERT INTO projects (id, workspace_id, name) VALUES ('a', 'w', 'A'), ('b', 'w', 'B')");
  const project = id => pool.query('INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, $3)', [id, 'w', id]);
  return { db, pool, project, contacts: createContacts({ db }) };
}

test('DNS results cannot update contacts after the initiating access is revoked', pg, async t => {
  const { contacts } = await fixture(t);
  const contact = await contacts.save('a', { email: 'recipient@example.test' }), before = await contacts.get('a', contact.id);
  let permitted = true, checked = 0;
  const assertAccess = () => { checked++; if (!permitted) throw Object.assign(new Error('Access revoked'), { status: 403 }); };
  await assert.rejects(contacts.assessDNS('a', [contact.id], { assertAccess, resolver: async () => { permitted = false; return [{ priority: 1, exchange: 'mail.example.test' }]; } }), error => error.status === 403);
  assert.equal(checked, 2); assert.deepEqual(await contacts.get('a', contact.id), before);
  let queries = 0; await assert.rejects(contacts.assessDNS('a', [contact.id], { assertAccess, resolver: async () => { queries++; return []; } }), error => error.status === 403); assert.equal(queries, 0);
});

test('verified SMS opt-outs survive future projects, deletion and opt-in imports without changing manual or other-channel scope', pg, async t => {
  const { db, pool, project, contacts } = await fixture(t);
  const phone = '+971501234567', other = '+971509876543', source = { phone, consents: { sms: true, whatsapp: true }, consentSource: 'Signup evidence' };
  const existing = await contacts.save('a', source); await contacts.save('b', { phone: other, consents: { sms: true }, consentSource: 'Other signup' });
  await contacts.suppressDestination('a', 'sms', other, 'Project-only manual suppression'); assert.equal((await contacts.get('b', (await contacts.list('b'))[0].id)).consents.sms, true); assert.equal(await contacts.smsSuppression(other), undefined);
  await contacts.suppressSmsGlobally(phone, 'Recipient opted out'); assert.equal((await contacts.get('a', existing.id)).consents.sms, false); assert.equal((await contacts.get('a', existing.id)).consents.whatsapp, true);
  const original = await contacts.smsSuppression(phone); await contacts.suppressSmsGlobally(phone, 'Repeated verified opt-out'); assert.deepEqual(await contacts.smsSuppression(phone), original);
  await project('future'); const future = await contacts.save('future', source); assert.equal(future.consents.sms, false); assert.equal(future.consentEvidence.sms, undefined); assert.equal(future.suppression.sms.reason, 'Recipient opted out');
  await contacts.remove('future', future.id); const imported = (await contacts.import('future', { csv: 'phone,name\n' + phone + ',Reimported', consents: { sms: true }, consentSource: 'Import cannot clear an opt-out' })).contacts[0]; assert.equal(imported.consents.sms, false);
  await pool.query('DELETE FROM projects'); assert.equal((await pool.query('SELECT count(*) AS n FROM direct_sms_suppressions')).rows[0].n, 1); assert.equal(JSON.stringify((await pool.query('SELECT * FROM direct_sms_suppressions')).rows).includes(phone), false);
  await project('rebuilt'); assert.equal((await createContacts({ db }).save('rebuilt', source)).consents.sms, false);
  await assert.rejects(contacts.suppressSmsGlobally('invalid', 'Recipient opted out'), error => error.status === 400);
});

test('contacts normalize destinations, isolate projects, preserve consent evidence and reject identity collisions', pg, async t => {
  const { pool, contacts } = await fixture(t);
  const contact = await contacts.save('a', { name: ' Alex ', email: 'Alex@ExAmPlE.test', phone: '+971501234567', tags: ['launch', 'launch'], consents: { email: true, sms: true, whatsapp: false }, consentSource: 'Signup form submission 2026-10-18, checked opt-in.' });
  assert.equal(contact.email, 'alex@example.test'); assert.equal(contact.name, 'Alex'); assert.deepEqual(contact.tags, ['launch']); assert.equal(contact.consents.email, true); assert.ok(contact.consentEvidence.email.at); assert.ok(contact.consentEvidence.sms.source);
  assert.equal((await contacts.list('b')).length, 0); assert.equal(await contacts.get('b', contact.id), null);
  await assert.rejects(contacts.save('b', { name: 'Not this project' }, contact.id), error => error.status === 404);
  const duplicate = await contacts.save('a', { email: 'ALEX@example.test', company: 'Studio' }); assert.equal(duplicate.id, contact.id); assert.equal(duplicate.phone, contact.phone); assert.equal(duplicate.consents.email, true); assert.equal((await contacts.list('a')).length, 1);
  const dated = await contacts.get('a', contact.id); dated.consentEvidence.email.at = '2026-01-01T00:00:00.000Z'; dated.consentUpdatedAt = '2026-01-01T00:00:00.000Z'; await pool.query('UPDATE direct_contacts SET data = $1 WHERE id = $2', [JSON.stringify(dated), dated.id]);
  const cosmetic = await contacts.save('a', { name: 'Renamed', consents: dated.consents, consentSource: dated.consentSource }, dated.id); assert.deepEqual(cosmetic.consentEvidence, dated.consentEvidence); assert.equal(cosmetic.consentUpdatedAt, dated.consentUpdatedAt, 'A cosmetic edit must not rewrite consent evidence dates.');
  await contacts.save('a', { consents: { whatsapp: true }, consentSource: 'WhatsApp signup record' }, dated.id); assert.deepEqual((await contacts.get('a', dated.id)).consentEvidence.email, dated.consentEvidence.email, 'Evidence for a newly enabled channel must not replace an earlier channel’s proof.');
  await contacts.save('a', { consents: { whatsapp: false } }, dated.id); await assert.rejects(contacts.save('a', { consents: { whatsapp: true } }, dated.id), error => error.status === 400, 'Re-enabling a channel needs an explicitly submitted source, not stale saved evidence.');
  const other = await contacts.save('a', { email: 'other@example.test', phone: '+971509876543' });
  await assert.rejects(contacts.save('a', { email: contact.email, phone: other.phone }), error => error.status === 409);
  await assert.rejects(contacts.save('a', { phone: other.phone }, contact.id), error => error.status === 409);
  await assert.rejects(contacts.save('a', { email: contact.email, phone: '+971501111111' }), error => error.status === 409);
  const changed = await contacts.save('a', { email: 'new@example.test', consents: { email: true, sms: true }, consentSource: contact.consentSource }, contact.id);
  assert.equal(changed.consents.email, false, 'Old consent must not transfer to a new address.'); assert.equal(changed.consents.sms, true); assert.equal(changed.consentEvidence.email, undefined); assert.equal(changed.hygiene.dnsStatus, 'unchecked');
  const reconsented = await contacts.save('a', { consents: { email: true }, consentSource: 'New address signup evidence 2026-10-19.' }, changed.id); assert.equal(reconsented.consents.email, true);
  const changedPhone = await contacts.save('a', { phone: '+971502222222', consents: { sms: true, whatsapp: true }, consentSource: 'Old phone source' }, contact.id); assert.equal(changedPhone.consents.sms, false); assert.equal(changedPhone.consents.whatsapp, false); assert.equal(changedPhone.consents.email, true);
  await contacts.save('b', { email: contact.email }); assert.equal((await contacts.list('b')).length, 1, 'The same address may be managed independently in another project.');
  for (const body of [null, [], { email: 42 }, { email: 'invalid' }, { email: 'a..b@example.test' }, { email: '.a@example.test' }, { email: 'a@-example.test' }, { email: 'a@example..test' }, { email: 'a@example.test', phone: 42 }, { phone: '0501234567' }, { phone: '+0123456789' }, { email: 'a@example.test', consents: { email: 'true' } }, { email: 'a@example.test', consents: { email: true } }, { email: 'a@example.test', suppression: {} }, { email: 'a@example.test', tags: ['bad\nvalue'] }]) await assert.rejects(contacts.save('a', body), error => error.status === 400, JSON.stringify(body));
  assert.equal((await contacts.save('a', { email: 'test@bücher.de' })).email, 'test@xn--bcher-kva.de');
});

test('CSV import previews, quoted fields, row errors, deduplication and merges preserve explicit permissions', pg, async t => {
  const { pool, contacts } = await fixture(t);
  const csv = '﻿name,email,phone,company,tags\r\n"Alex, A.",ALEX@example.test,+971501234567,"Studio ""A""",launch|brand\r\nAlex,alex@example.test,,,launch\r\nBad,not-an-email,,,\r\nToo,few\r\n';
  let result = await contacts.import('a', { csv, dryRun: true }); assert.equal(result.created, 1); assert.equal(result.updated, 1); assert.equal(result.skipped, 2); assert.equal(result.contacts.length, 1); assert.equal(result.errors.length, 2); assert.equal((await contacts.list('a')).length, 0); assert.equal(result.contacts[0].consents.email, false);
  result = await contacts.import('a', { csv, consents: { email: true }, consentSource: 'Original checked signup list, campaign email only.' });
  assert.equal(result.imported, 2); assert.equal(result.contacts[0].company, 'Studio "A"'); assert.deepEqual(result.contacts[0].tags, ['launch', 'brand']); assert.equal(result.contacts[0].consents.email, true); assert.equal(result.contacts[0].consents.sms, false);
  const id = result.contacts[0].id;
  result = await contacts.import('a', { csv: 'email,name\nalex@example.test,Renamed', consents: { email: false, sms: false, whatsapp: false } }); assert.equal(result.contacts[0].id, id); assert.equal(result.contacts[0].phone, '+971501234567'); assert.equal(result.contacts[0].consents.email, true, 'Unchecked import opt-ins must not revoke previously recorded consent.');
  const other = await contacts.save('a', { email: 'other@example.test', phone: '+971509876543' });
  result = await contacts.import('a', { csv: `email,phone\nalex@example.test,${other.phone}\nchanged@example.test,+971501234567\n` }); assert.equal(result.skipped, 2); assert.equal(result.imported, 0); assert.equal((await contacts.list('a')).length, 2);
  await assert.rejects(contacts.import('a', { csv: 'email,consent\na@example.test,true' }), error => error.status === 400);
  await assert.rejects(contacts.import('a', { csv: 'email\n"unclosed' }), error => error.status === 400);
  await assert.rejects(contacts.import('a', { csv: 'email\n"a@example.test"bad' }), error => error.status === 400);
  await assert.rejects(contacts.import('a', { csv: 'email,email\na@example.test,b@example.test' }), error => error.status === 400);
  await assert.rejects(contacts.import('a', { csv: 'email\na@example.test', consents: { email: true } }), error => error.status === 400);
  await assert.rejects(contacts.import('a', { csv: 'email\n' + Array(1001).fill('a@example.test').join('\n') }), error => error.status === 400);
  await pool.query("CREATE FUNCTION fail_contact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.data::text LIKE '%fail@example.test%' THEN RAISE EXCEPTION 'storage failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_contact BEFORE INSERT ON direct_contacts FOR EACH ROW EXECUTE FUNCTION fail_contact();");
  const before = await contacts.list('a'); await assert.rejects(contacts.import('a', { csv: 'email\ncreated@example.test\nfail@example.test' }), failure(/storage failure/)); assert.deepEqual(await contacts.list('a'), before, 'A storage failure must roll back the complete import.');
});

test('suppression and hard bounces survive edits, deletion, reimport and consent attempts without crossing projects', pg, async t => {
  const { contacts } = await fixture(t);
  const source = { email: 'bounced@example.test', phone: '+971501234567', consents: { email: true, sms: true, whatsapp: true }, consentSource: 'Signed subscription record' };
  const contact = await contacts.save('a', source), suppressed = await contacts.suppress('a', contact.id, 'email', 'hard_bounce');
  assert.equal(suppressed.consents.email, false); assert.equal(suppressed.suppression.email.reason, 'hard-bounce'); assert.ok(suppressed.hardBounceAt); assert.equal(suppressed.consents.sms, true);
  await assert.rejects(contacts.suppress('b', contact.id, 'sms', 'unsubscribe'), error => error.status === 404);
  await assert.rejects(contacts.suppress('a', contact.id, 'voice', 'unsupported'), error => error.status === 400);
  assert.equal((await contacts.save('a', { consents: { email: true }, consentSource: 'Reimport cannot clear suppression' }, contact.id)).consents.email, false);
  const imported = (await contacts.import('a', { csv: 'email,name\nbounced@example.test,Renamed', consents: { email: true }, consentSource: 'Another explicit source' })).contacts[0]; assert.equal(imported.suppression.email.reason, 'hard-bounce'); assert.equal(imported.consents.email, false);
  await contacts.suppress('a', contact.id, 'whatsapp', 'unsubscribe'); assert.equal((await contacts.get('a', contact.id)).consents.sms, true, 'Channel suppression must remain separate.');
  assert.equal(await contacts.remove('a', contact.id), true); assert.equal(await contacts.remove('b', contact.id), false);
  const recreated = await contacts.save('a', source); assert.equal(recreated.consents.email, false); assert.equal(recreated.consents.whatsapp, false); assert.equal(recreated.consents.sms, true); assert.equal(recreated.suppression.email.reason, 'hard-bounce');
  assert.equal((await contacts.save('b', source)).consents.email, true);
});

test('hygiene flags are cautious heuristics and DNS checks are scoped, bounded and never attest mailbox existence', pg, async t => {
  const { contacts } = await fixture(t);
  assert.equal((await contacts.save('a', { email: 'info@example.test' })).hygiene.roleAddress, true);
  assert.equal((await contacts.save('a', { email: 'person@sub.mailinator.com' })).hygiene.disposable, true);
  assert.equal((await contacts.save('a', { email: 'person@gmial.com' })).hygiene.typoSuggestion, 'person@gmail.com');
  const records = [];
  for (const domain of ['mx.test', 'null.test', 'none.test', 'missing.test', 'offline.test', 'shared.test', 'implicit.test', 'nxdomain.test']) records.push(await contacts.save('a', { email: `person@${domain}` }));
  records.push(await contacts.save('a', { email: 'another@shared.test' })); let active = 0, maximum = 0; const lookups = [];
  const resolver = { async resolveMx(domain) {
    active++; maximum = Math.max(maximum, active); lookups.push(domain); await Promise.resolve(); active--;
    if (domain === 'null.test') return [{ priority: 0, exchange: '.' }]; if (['none.test', 'implicit.test'].includes(domain)) return [];
    if (domain === 'nxdomain.test') throw Object.assign(new Error('Domain absent'), { code: 'ENOTFOUND' });
    if (domain === 'missing.test') throw Object.assign(new Error('Absent'), { code: 'ENODATA' }); if (domain === 'offline.test') throw Object.assign(new Error('Timeout'), { code: 'ETIMEOUT' });
    return [{ priority: 10, exchange: 'mail.example.test' }];
  }, async resolve4(domain) { if (domain === 'implicit.test') return ['192.0.2.1']; throw Object.assign(new Error('No IPv4'), { code: 'ENODATA' }); }, async resolve6() { throw Object.assign(new Error('No IPv6'), { code: 'ENODATA' }); } };
  const result = await contacts.assessDNS('a', records.map(row => row.id), { resolver }); assert.equal(result.checked, 8); assert.equal(maximum <= 4, true); assert.equal(lookups.filter(domain => domain === 'shared.test').length, 1);
  assert.deepEqual(result.contacts.slice(0, 5).map(row => row.hygiene.dnsStatus), ['mx', 'null_mx', 'no_mx', 'no_mx', 'unavailable']); assert.match(result.notice, /do not verify that a mailbox exists/); assert.equal(result.contacts[0].consents.email, false);
  assert.equal(result.contacts[6].hygiene.dnsStatus, 'implicit_mx'); assert.equal(result.contacts[7].hygiene.dnsStatus, 'nxdomain');
  const unavailableFallback = await contacts.assessDNS('a', [records[2].id], { resolver: async () => [] }); assert.equal(unavailableFallback.contacts[0].hygiene.dnsStatus, 'unavailable', 'An unchecked A/AAAA fallback cannot be treated as conclusive no-mail DNS.');
  await assert.rejects(contacts.assessDNS('b', [records[0].id], { resolver }), error => error.status === 404);
  await assert.rejects(contacts.assessDNS('a', Array(101).fill(records[0].id), { resolver }), error => error.status === 400);
  const changing = records[0]; await contacts.assessDNS('a', [changing.id], { resolver: async () => { await contacts.save('a', { email: 'changed@new.test' }, changing.id); return [{ priority: 1, exchange: 'mail.example.test' }]; } }); assert.equal((await contacts.get('a', changing.id)).hygiene.dnsStatus, 'unchecked', 'A stale DNS result cannot verify a newly edited address.');
  await contacts.assessDNS('a', [records[1].id], { resolver: async () => { await contacts.suppress('a', records[1].id, 'email', 'unsubscribe'); return [{ priority: 1, exchange: 'mail.example.test' }]; } }); assert.ok((await contacts.get('a', records[1].id)).suppression.email, 'DNS updates preserve concurrent suppression changes.');
});

test('destination suppression targets the originally mailed address after edits or deletion and safely ignores deleted projects', pg, async t => {
  const { pool, contacts } = await fixture(t);
  const original = await contacts.save('a', { email: 'original@example.test', consents: { email: true }, consentSource: 'Original address opt-in' });
  await contacts.save('a', { email: 'new@example.test' }, original.id);
  await contacts.save('a', { consents: { email: true }, consentSource: 'New address opt-in' }, original.id);
  assert.deepEqual(await contacts.suppressDestination('a', 'email', 'ORIGINAL@example.test', 'Unsubscribed'), { suppressed: 0 });
  assert.equal((await contacts.get('a', original.id)).consents.email, true, 'An old preference link must not suppress a different current address.');
  const recreated = await contacts.save('a', { email: 'original@example.test', consents: { email: true }, consentSource: 'An import must not clear an unsubscribe' }); assert.equal(recreated.consents.email, false); assert.equal(recreated.suppression.email.reason, 'Unsubscribed');
  await contacts.remove('a', recreated.id);
  assert.deepEqual(await contacts.suppressDestination('a', 'email', 'original@example.test', 'Unsubscribed'), { suppressed: 0 });
  assert.equal((await contacts.save('a', { email: 'original@example.test' })).suppression.email.reason, 'Unsubscribed');
  const phone = await contacts.save('a', { phone: '+971501234567', consents: { sms: true, whatsapp: true }, consentSource: 'Independent channel opt-ins' });
  assert.equal((await contacts.suppressDestination('a', 'sms', phone.phone, 'Recipient opted out')).suppressed, 1); assert.equal((await contacts.get('a', phone.id)).consents.sms, false); assert.equal((await contacts.get('a', phone.id)).consents.whatsapp, true);
  await assert.rejects(contacts.suppressDestination('a', 'email', 'bad', 'Unsubscribed'), error => error.status === 400);
  await pool.query('DELETE FROM projects WHERE id = $1', ['b']); assert.deepEqual(await contacts.suppressDestination('b', 'email', 'original@example.test', 'Unsubscribed'), { suppressed: 0 });
});

test('verified Messenger identities create scoped replay-safe contacts without inferred destinations or campaign permissions', pg, async t => {
  const { db, pool, contacts } = await fixture(t);
  const incoming = { accountId: 'facebook-page-a', participantId: 'page-scoped-person', conversationId: 'conversation-a', name: 'Alex Messenger', avatarUrl: 'https://cdn.example.test/avatar.jpg' };
  const manual = await contacts.save('a', { name: incoming.name, email: 'alex@example.test' });
  assert.equal(await contacts.findMessenger('a', incoming.accountId, incoming.participantId), null);
  // Parallel deliveries from independent services race on separate connections; the project lock must make them converge on one contact.
  const [first, replay, poll] = await Promise.all([contacts, createContacts({ db }), contacts].map(service => Promise.resolve().then(() => service.fromMessenger('a', incoming))));
  assert.equal(first.id, replay.id); assert.equal(first.id, poll.id); assert.notEqual(first.id, manual.id, 'A matching display name cannot merge unrelated identities.');
  assert.equal((await contacts.list('a')).length, 2); assert.equal(first.source, 'messenger'); assert.equal(first.email, ''); assert.equal(first.phone, '');
  assert.deepEqual(first.consents, { email: false, sms: false, whatsapp: false }); assert.deepEqual(first.consentEvidence, {}); assert.equal(first.consentSource, ''); assert.deepEqual(first.suppression, {});
  assert.deepEqual(first.identities.map(({ platform, accountId, participantId, conversationId }) => ({ platform, accountId, participantId, conversationId })), [{ platform: 'facebook', accountId: incoming.accountId, participantId: incoming.participantId, conversationId: incoming.conversationId }]);
  assert.ok(first.identities[0].createdAt); assert.equal(first.identities[0].avatarUrl, incoming.avatarUrl);
  const otherAccount = await contacts.fromMessenger('a', { ...incoming, accountId: 'facebook-page-b' }); assert.notEqual(otherAccount.id, first.id);
  const otherProject = await contacts.fromMessenger('b', incoming); assert.notEqual(otherProject.id, first.id); assert.equal((await contacts.findMessenger('b', incoming.accountId, incoming.participantId)).id, otherProject.id);
  await assert.rejects(pool.query('INSERT INTO direct_contact_messenger_identities VALUES ($1, $2, $3, $4)', ['a', incoming.accountId, incoming.participantId, manual.id]), error => error.code === '23505', 'The database enforces identity uniqueness for independently created services.');
  const renamed = await contacts.fromMessenger('a', { ...incoming, name: 'Provider rename', conversationId: 'conversation-b' }); assert.equal(renamed.name, 'Provider rename'); assert.equal(renamed.identities[0].conversationId, 'conversation-b');
  await contacts.save('a', { name: 'My contact label', company: 'Studio', tags: ['customer'], email: '', phone: '' }, first.id);
  assert.equal((await contacts.fromMessenger('a', { ...incoming, name: 'My contact label' })).name, 'My contact label');
  const preserved = await contacts.fromMessenger('a', { ...incoming, name: 'Another provider rename' }); assert.equal(preserved.name, 'My contact label', 'Provider updates must never reclaim a manually edited name.'); assert.equal(preserved.identities[0].name, 'Another provider rename'); assert.equal(preserved.company, 'Studio'); assert.deepEqual(preserved.tags, ['customer']);
  const enriched = await contacts.save('a', { email: 'messenger@example.test', phone: '+971501234567', consents: { email: true, sms: true }, consentSource: 'Explicit destination opt-in' }, first.id); assert.equal(enriched.consents.email, false, 'An identity link must not transfer consent to a newly supplied address.');
  await contacts.save('a', { consents: { email: true, sms: true, whatsapp: true }, consentSource: 'Verified opt-in for these destinations' }, first.id); await contacts.suppress('a', first.id, 'whatsapp', 'Explicit opt-out');
  const before = await contacts.get('a', first.id), after = await contacts.fromMessenger('a', incoming);
  for (const field of ['email', 'phone', 'consents', 'consentEvidence', 'consentUpdatedAt', 'consentSource', 'suppression', 'hygiene']) assert.deepEqual(after[field], before[field], `Incoming messages must preserve ${field}.`);
  for (const body of [{ identities: first.identities }, { source: 'messenger' }, { nameSource: 'messenger' }]) await assert.rejects(contacts.save('a', body, first.id), error => error.status === 400, 'Normal contact writes cannot forge identity metadata.');
  await assert.rejects(contacts.save('a', { name: 'A name alone is not an ordinary contact' }), error => error.status === 400);
  for (const body of [{ ...incoming, participantId: '' }, { ...incoming, participantId: 123 }, { ...incoming, accountId: 'bad account' }, { ...incoming, conversationId: '' }, { ...incoming, name: 'bad\nname' }, { ...incoming, avatarUrl: 'https://127.0.0.1/avatar' }, { ...incoming, email: 'forged@example.test' }]) await assert.rejects(contacts.fromMessenger('a', body), error => error.status === 400);
  await assert.rejects(contacts.fromMessenger('missing-project', incoming), error => error.status === 404);
  await contacts.remove('a', first.id); assert.equal(await contacts.findMessenger('a', incoming.accountId, incoming.participantId), null, 'Contact deletion cascades its identity lookup.');
  assert.notEqual((await contacts.fromMessenger('a', incoming)).id, first.id);
});

test('Messenger contact and identity writes are atomic standalone and inside the webhook transaction', pg, async t => {
  const { db, pool, contacts } = await fixture(t);
  const incoming = { accountId: 'page-a', participantId: 'sender-a', conversationId: 'thread-a' };
  await assert.rejects(db.transaction(async tx => { const nested = await contacts.fromMessenger('a', incoming, tx); assert.equal((await contacts.get('a', nested.id, tx)).id, nested.id); throw new Error('outer webhook rollback'); }), /outer webhook rollback/);
  assert.equal((await contacts.list('a')).length, 0); assert.equal(await contacts.findMessenger('a', incoming.accountId, incoming.participantId), null, 'An outer webhook rollback also removes the auto-created contact.');
  await pool.query("CREATE FUNCTION fail_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.participant_id = 'fail' THEN RAISE EXCEPTION 'identity storage failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_identity BEFORE INSERT ON direct_contact_messenger_identities FOR EACH ROW EXECUTE FUNCTION fail_identity();");
  await assert.rejects(contacts.fromMessenger('a', { ...incoming, participantId: 'fail' }), failure(/identity storage failure/)); assert.equal((await contacts.list('a')).length, 0, 'Standalone failure leaves no orphan contact.');
  const valid = await db.transaction(async tx => {
    await assert.rejects(contacts.fromMessenger('a', { ...incoming, participantId: 'fail' }, tx), failure(/identity storage failure/));
    return contacts.fromMessenger('a', incoming, tx);
  });
  assert.equal((await contacts.findMessenger('a', incoming.accountId, incoming.participantId)).id, valid.id, 'A savepoint rollback preserves the caller transaction for valid subsequent work.');
  await pool.query('DELETE FROM projects WHERE id = $1', ['a']); assert.equal((await pool.query('SELECT COUNT(*) AS count FROM direct_contact_messenger_identities')).rows[0].count, 0);
});

// ten98-campaign#54 item 5: webhook opt-outs and opt-ins, suppressions and contact saves look a contact up by its email or
// phone instead of reading every contact in the project. Counts the direct_contacts rows each operation reads.
test('destination lookups read only the matching contacts, not the whole project', pg, async t => {
  const { pool, contacts } = await fixture(t);
  const csv = ['email,phone', ...Array.from({ length: 300 }, (_, index) => `person-${index}@example.test,+1202555${String(index).padStart(4, '0')}`)].join('\n');
  assert.equal((await contacts.import('a', { csv, consents: { email: true, sms: true }, consentSource: 'Fixture signup' })).created, 300);
  const pg = (await import('pg')).default, original = pg.Client.prototype.query;
  let read = 0;
  // Pool queries use pg's callback form and transactions the promise form; count direct_contacts rows either way.
  pg.Client.prototype.query = function (...args) {
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text || '', count = value => { if (/FROM direct_contacts/.test(text)) read += value?.rows?.length || 0; }, done = args.at(-1);
    if (typeof done === 'function') args[args.length - 1] = (error, value) => { if (!error) count(value); return done(error, value); };
    const result = original.apply(this, args); if (result?.then) result.then(count, () => {});
    return result;
  };
  t.after(() => { pg.Client.prototype.query = original; });
  const measure = async run => { read = 0; await run(); await new Promise(resolve => setImmediate(resolve)); return read; };
  assert.ok(await measure(() => contacts.suppressDestination('a', 'email', 'person-7@example.test', 'Unsubscribed')) <= 2, 'A destination suppression reads the matching contact only.');
  assert.ok(await measure(() => contacts.suppressSmsGlobally('+12025550008', 'Recipient opted out')) <= 2);
  assert.ok(await measure(() => contacts.liftSmsOptOut('+12025550008')) <= 2, 'A START reads only the contacts holding that number.');
  assert.ok(await measure(() => contacts.save('a', { email: 'person-9@example.test', name: 'Nine' })) <= 4, 'Saving by destination reads the matching contact, not the project.');
  assert.ok(await measure(() => contacts.save('a', { email: 'new-person@example.test' })) <= 4);
  assert.deepEqual((await contacts.byDestination('a', { phone: '+12025550009' })).map(row => row.email), ['person-9@example.test']);
  assert.equal((await contacts.list('a')).find(row => row.email === 'person-7@example.test').consents.email, false, 'The lookups still apply their effect.');
  await assert.rejects(contacts.save('a', { email: 'person-10@example.test', phone: '+12025550011' }), /different contacts/);
});

// ten98-campaign#135: re-importing a consented contact with no permissions ticked merges the row and keeps the contact's
// existing permissions and evidence; an empty consent source from the form grants and removes nothing.
test('a CSV re-import of a consented contact merges and keeps its consent when no permission is ticked', pg, async t => {
  const { contacts } = await fixture(t);
  const dana = await contacts.save('a', { name: 'Dana', email: 'dana@example.test', phone: '+971501112222', consents: { email: true, sms: true }, consentSource: 'Signup form' });
  for (const dryRun of [true, false]) {
    const result = await contacts.import('a', { csv: 'name,email\nDana Again,dana@example.test', dryRun, consents: {}, consentSource: '' });
    assert.deepEqual([result.created, result.updated, result.skipped, result.errors], [0, 1, 0, []], JSON.stringify(result.errors));
  }
  const merged = await contacts.get('a', dana.id);
  assert.equal(merged.name, 'Dana Again');
  assert.deepEqual([merged.consents.email, merged.consents.sms, merged.consentSource], [true, true, 'Signup form']);
  assert.deepEqual(merged.consentEvidence, dana.consentEvidence, 'The original evidence is kept.');
});
