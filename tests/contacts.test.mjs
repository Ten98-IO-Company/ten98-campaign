import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createContacts } from '../server/contacts.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:'); db.exec("PRAGMA foreign_keys=ON; CREATE TABLE projects(id TEXT PRIMARY KEY); INSERT INTO projects VALUES('a'),('b');");
  return { db, contacts: createContacts({ db }) };
}

test('DNS results cannot update contacts after the initiating access is revoked', async () => {
  const { db, contacts } = fixture();
  try {
    const contact = contacts.save('a', { email: 'recipient@example.test' }), before = contacts.get('a', contact.id);
    let permitted = true, checked = 0;
    const assertAccess = () => { checked++; if (!permitted) throw Object.assign(new Error('Access revoked'), { status: 403 }); };
    await assert.rejects(contacts.assessDNS('a', [contact.id], { assertAccess, resolver: async () => { permitted = false; return [{ priority: 1, exchange: 'mail.example.test' }]; } }), error => error.status === 403);
    assert.equal(checked, 2); assert.deepEqual(contacts.get('a', contact.id), before);
    let queries = 0; await assert.rejects(contacts.assessDNS('a', [contact.id], { assertAccess, resolver: async () => { queries++; return []; } }), error => error.status === 403); assert.equal(queries, 0);
  } finally { db.close(); }
});

test('verified SMS opt-outs survive future projects, deletion and opt-in imports without changing manual or other-channel scope', () => {
  const { db, contacts } = fixture();
  try {
    const phone = '+971501234567', other = '+971509876543', source = { phone, consents: { sms: true, whatsapp: true }, consentSource: 'Signup evidence' };
    const existing = contacts.save('a', source); contacts.save('b', { phone: other, consents: { sms: true }, consentSource: 'Other signup' });
    contacts.suppressDestination('a', 'sms', other, 'Project-only manual suppression'); assert.equal(contacts.get('b', contacts.list('b')[0].id).consents.sms, true); assert.equal(contacts.smsSuppression(other), undefined);
    contacts.suppressSmsGlobally(phone, 'Recipient opted out'); assert.equal(contacts.get('a', existing.id).consents.sms, false); assert.equal(contacts.get('a', existing.id).consents.whatsapp, true);
    const original = contacts.smsSuppression(phone); contacts.suppressSmsGlobally(phone, 'Repeated verified opt-out'); assert.deepEqual(contacts.smsSuppression(phone), original);
    db.exec("INSERT INTO projects VALUES('future')"); const future = contacts.save('future', source); assert.equal(future.consents.sms, false); assert.equal(future.consentEvidence.sms, undefined); assert.equal(future.suppression.sms.reason, 'Recipient opted out');
    contacts.remove('future', future.id); const imported = contacts.import('future', { csv: 'phone,name\n' + phone + ',Reimported', consents: { sms: true }, consentSource: 'Import cannot clear an opt-out' }).contacts[0]; assert.equal(imported.consents.sms, false);
    db.exec('DELETE FROM projects'); assert.equal(db.prepare('SELECT count(*) AS n FROM direct_sms_suppressions').get().n, 1); assert.equal(JSON.stringify(db.prepare('SELECT * FROM direct_sms_suppressions').all()).includes(phone), false);
    db.exec("INSERT INTO projects VALUES('rebuilt')"); assert.equal(createContacts({ db }).save('rebuilt', source).consents.sms, false);
    assert.throws(() => contacts.suppressSmsGlobally('invalid', 'Recipient opted out'), error => error.status === 400);
  } finally { db.close(); }
});

test('contacts normalize destinations, isolate projects, preserve consent evidence and reject identity collisions', () => {
  const { db, contacts } = fixture();
  try {
    const contact = contacts.save('a', { name: ' Alex ', email: 'Alex@ExAmPlE.test', phone: '+971501234567', tags: ['launch', 'launch'], consents: { email: true, sms: true, whatsapp: false }, consentSource: 'Signup form submission 2026-10-18, checked opt-in.' });
    assert.equal(contact.email, 'alex@example.test'); assert.equal(contact.name, 'Alex'); assert.deepEqual(contact.tags, ['launch']); assert.equal(contact.consents.email, true); assert.ok(contact.consentEvidence.email.at); assert.ok(contact.consentEvidence.sms.source);
    assert.equal(contacts.list('b').length, 0); assert.equal(contacts.get('b', contact.id), null);
    assert.throws(() => contacts.save('b', { name: 'Not this project' }, contact.id), error => error.status === 404);
    const duplicate = contacts.save('a', { email: 'ALEX@example.test', company: 'Studio' }); assert.equal(duplicate.id, contact.id); assert.equal(duplicate.phone, contact.phone); assert.equal(duplicate.consents.email, true); assert.equal(contacts.list('a').length, 1);
    const dated = contacts.get('a', contact.id); dated.consentEvidence.email.at = '2026-01-01T00:00:00.000Z'; dated.consentUpdatedAt = '2026-01-01T00:00:00.000Z'; db.prepare('UPDATE direct_contacts SET data=? WHERE id=?').run(JSON.stringify(dated), dated.id);
    const cosmetic = contacts.save('a', { name: 'Renamed', consents: dated.consents, consentSource: dated.consentSource }, dated.id); assert.deepEqual(cosmetic.consentEvidence, dated.consentEvidence); assert.equal(cosmetic.consentUpdatedAt, dated.consentUpdatedAt, 'A cosmetic edit must not rewrite consent evidence dates.');
    contacts.save('a', { consents: { whatsapp: true }, consentSource: 'WhatsApp signup record' }, dated.id); assert.deepEqual(contacts.get('a', dated.id).consentEvidence.email, dated.consentEvidence.email, 'Evidence for a newly enabled channel must not replace an earlier channel’s proof.');
    contacts.save('a', { consents: { whatsapp: false } }, dated.id); assert.throws(() => contacts.save('a', { consents: { whatsapp: true } }, dated.id), error => error.status === 400, 'Re-enabling a channel needs an explicitly submitted source, not stale saved evidence.');
    const other = contacts.save('a', { email: 'other@example.test', phone: '+971509876543' });
    assert.throws(() => contacts.save('a', { email: contact.email, phone: other.phone }), error => error.status === 409);
    assert.throws(() => contacts.save('a', { phone: other.phone }, contact.id), error => error.status === 409);
    assert.throws(() => contacts.save('a', { email: contact.email, phone: '+971501111111' }), error => error.status === 409);
    const changed = contacts.save('a', { email: 'new@example.test', consents: { email: true, sms: true }, consentSource: contact.consentSource }, contact.id);
    assert.equal(changed.consents.email, false, 'Old consent must not transfer to a new address.'); assert.equal(changed.consents.sms, true); assert.equal(changed.consentEvidence.email, undefined); assert.equal(changed.hygiene.dnsStatus, 'unchecked');
    const reconsented = contacts.save('a', { consents: { email: true }, consentSource: 'New address signup evidence 2026-10-19.' }, changed.id); assert.equal(reconsented.consents.email, true);
    const changedPhone = contacts.save('a', { phone: '+971502222222', consents: { sms: true, whatsapp: true }, consentSource: 'Old phone source' }, contact.id); assert.equal(changedPhone.consents.sms, false); assert.equal(changedPhone.consents.whatsapp, false); assert.equal(changedPhone.consents.email, true);
    contacts.save('b', { email: contact.email }); assert.equal(contacts.list('b').length, 1, 'The same address may be managed independently in another project.');
    for (const body of [null, [], { email: 42 }, { email: 'invalid' }, { email: 'a..b@example.test' }, { email: '.a@example.test' }, { email: 'a@-example.test' }, { email: 'a@example..test' }, { email: 'a@example.test', phone: 42 }, { phone: '0501234567' }, { phone: '+0123456789' }, { email: 'a@example.test', consents: { email: 'true' } }, { email: 'a@example.test', consents: { email: true } }, { email: 'a@example.test', suppression: {} }, { email: 'a@example.test', tags: ['bad\nvalue'] }]) assert.throws(() => contacts.save('a', body), error => error.status === 400, JSON.stringify(body));
    assert.equal(contacts.save('a', { email: 'test@bücher.de' }).email, 'test@xn--bcher-kva.de');
  } finally { db.close(); }
});

test('CSV import previews, quoted fields, row errors, deduplication and merges preserve explicit permissions', () => {
  const { db, contacts } = fixture();
  try {
    const csv = '\uFEFFname,email,phone,company,tags\r\n"Alex, A.",ALEX@example.test,+971501234567,"Studio ""A""",launch|brand\r\nAlex,alex@example.test,,,launch\r\nBad,not-an-email,,,\r\nToo,few\r\n';
    let result = contacts.import('a', { csv, dryRun: true }); assert.equal(result.created, 1); assert.equal(result.updated, 1); assert.equal(result.skipped, 2); assert.equal(result.contacts.length, 1); assert.equal(result.errors.length, 2); assert.equal(contacts.list('a').length, 0); assert.equal(result.contacts[0].consents.email, false);
    result = contacts.import('a', { csv, consents: { email: true }, consentSource: 'Original checked signup list, campaign email only.' });
    assert.equal(result.imported, 2); assert.equal(result.contacts[0].company, 'Studio "A"'); assert.deepEqual(result.contacts[0].tags, ['launch', 'brand']); assert.equal(result.contacts[0].consents.email, true); assert.equal(result.contacts[0].consents.sms, false);
    const id = result.contacts[0].id;
    result = contacts.import('a', { csv: 'email,name\nalex@example.test,Renamed', consents: { email: false, sms: false, whatsapp: false } }); assert.equal(result.contacts[0].id, id); assert.equal(result.contacts[0].phone, '+971501234567'); assert.equal(result.contacts[0].consents.email, true, 'Unchecked import opt-ins must not revoke previously recorded consent.');
    const other = contacts.save('a', { email: 'other@example.test', phone: '+971509876543' });
    result = contacts.import('a', { csv: `email,phone\nalex@example.test,${other.phone}\nchanged@example.test,+971501234567\n` }); assert.equal(result.skipped, 2); assert.equal(result.imported, 0); assert.equal(contacts.list('a').length, 2);
    assert.throws(() => contacts.import('a', { csv: 'email,consent\na@example.test,true' }), error => error.status === 400);
    assert.throws(() => contacts.import('a', { csv: 'email\n"unclosed' }), error => error.status === 400);
    assert.throws(() => contacts.import('a', { csv: 'email\n"a@example.test"bad' }), error => error.status === 400);
    assert.throws(() => contacts.import('a', { csv: 'email,email\na@example.test,b@example.test' }), error => error.status === 400);
    assert.throws(() => contacts.import('a', { csv: 'email\na@example.test', consents: { email: true } }), error => error.status === 400);
    assert.throws(() => contacts.import('a', { csv: 'email\n' + Array(1001).fill('a@example.test').join('\n') }), error => error.status === 400);
    db.exec("CREATE TRIGGER fail_contact BEFORE INSERT ON direct_contacts WHEN NEW.data LIKE '%fail@example.test%' BEGIN SELECT RAISE(ABORT,'storage failure'); END;");
    const before = contacts.list('a'); assert.throws(() => contacts.import('a', { csv: 'email\ncreated@example.test\nfail@example.test' }), /storage failure/); assert.deepEqual(contacts.list('a'), before, 'A storage failure must roll back the complete import.');
  } finally { db.close(); }
});

test('suppression and hard bounces survive edits, deletion, reimport and consent attempts without crossing projects', () => {
  const { db, contacts } = fixture();
  try {
    const source = { email: 'bounced@example.test', phone: '+971501234567', consents: { email: true, sms: true, whatsapp: true }, consentSource: 'Signed subscription record' };
    const contact = contacts.save('a', source), suppressed = contacts.suppress('a', contact.id, 'email', 'hard_bounce');
    assert.equal(suppressed.consents.email, false); assert.equal(suppressed.suppression.email.reason, 'hard-bounce'); assert.ok(suppressed.hardBounceAt); assert.equal(suppressed.consents.sms, true);
    assert.throws(() => contacts.suppress('b', contact.id, 'sms', 'unsubscribe'), error => error.status === 404);
    assert.throws(() => contacts.suppress('a', contact.id, 'voice', 'unsupported'), error => error.status === 400);
    assert.equal(contacts.save('a', { consents: { email: true }, consentSource: 'Reimport cannot clear suppression' }, contact.id).consents.email, false);
    const imported = contacts.import('a', { csv: 'email,name\nbounced@example.test,Renamed', consents: { email: true }, consentSource: 'Another explicit source' }).contacts[0]; assert.equal(imported.suppression.email.reason, 'hard-bounce'); assert.equal(imported.consents.email, false);
    contacts.suppress('a', contact.id, 'whatsapp', 'unsubscribe'); assert.equal(contacts.get('a', contact.id).consents.sms, true, 'Channel suppression must remain separate.');
    assert.equal(contacts.remove('a', contact.id), true); assert.equal(contacts.remove('b', contact.id), false);
    const recreated = contacts.save('a', source); assert.equal(recreated.consents.email, false); assert.equal(recreated.consents.whatsapp, false); assert.equal(recreated.consents.sms, true); assert.equal(recreated.suppression.email.reason, 'hard-bounce');
    assert.equal(contacts.save('b', source).consents.email, true);
  } finally { db.close(); }
});

test('hygiene flags are cautious heuristics and DNS checks are scoped, bounded and never attest mailbox existence', async () => {
  const { db, contacts } = fixture();
  try {
    assert.equal(contacts.save('a', { email: 'info@example.test' }).hygiene.roleAddress, true);
    assert.equal(contacts.save('a', { email: 'person@sub.mailinator.com' }).hygiene.disposable, true);
    assert.equal(contacts.save('a', { email: 'person@gmial.com' }).hygiene.typoSuggestion, 'person@gmail.com');
    const records = ['mx.test', 'null.test', 'none.test', 'missing.test', 'offline.test', 'shared.test', 'implicit.test', 'nxdomain.test'].map(domain => contacts.save('a', { email: `person@${domain}` }));
    records.push(contacts.save('a', { email: 'another@shared.test' })); let active = 0, maximum = 0; const lookups = [];
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
    const changing = records[0]; await contacts.assessDNS('a', [changing.id], { resolver: async () => { contacts.save('a', { email: 'changed@new.test' }, changing.id); return [{ priority: 1, exchange: 'mail.example.test' }]; } }); assert.equal(contacts.get('a', changing.id).hygiene.dnsStatus, 'unchecked', 'A stale DNS result cannot verify a newly edited address.');
    await contacts.assessDNS('a', [records[1].id], { resolver: async () => { contacts.suppress('a', records[1].id, 'email', 'unsubscribe'); return [{ priority: 1, exchange: 'mail.example.test' }]; } }); assert.ok(contacts.get('a', records[1].id).suppression.email, 'DNS updates preserve concurrent suppression changes.');
  } finally { db.close(); }
});

test('destination suppression targets the originally mailed address after edits or deletion and safely ignores deleted projects', () => {
  const { db, contacts } = fixture();
  try {
    const original = contacts.save('a', { email: 'original@example.test', consents: { email: true }, consentSource: 'Original address opt-in' });
    contacts.save('a', { email: 'new@example.test' }, original.id);
    contacts.save('a', { consents: { email: true }, consentSource: 'New address opt-in' }, original.id);
    assert.deepEqual(contacts.suppressDestination('a', 'email', 'ORIGINAL@example.test', 'Unsubscribed'), { suppressed: 0 });
    assert.equal(contacts.get('a', original.id).consents.email, true, 'An old preference link must not suppress a different current address.');
    const recreated = contacts.save('a', { email: 'original@example.test', consents: { email: true }, consentSource: 'An import must not clear an unsubscribe' }); assert.equal(recreated.consents.email, false); assert.equal(recreated.suppression.email.reason, 'Unsubscribed');
    contacts.remove('a', recreated.id);
    assert.deepEqual(contacts.suppressDestination('a', 'email', 'original@example.test', 'Unsubscribed'), { suppressed: 0 });
    assert.equal(contacts.save('a', { email: 'original@example.test' }).suppression.email.reason, 'Unsubscribed');
    const phone = contacts.save('a', { phone: '+971501234567', consents: { sms: true, whatsapp: true }, consentSource: 'Independent channel opt-ins' });
    assert.equal(contacts.suppressDestination('a', 'sms', phone.phone, 'Recipient opted out').suppressed, 1); assert.equal(contacts.get('a', phone.id).consents.sms, false); assert.equal(contacts.get('a', phone.id).consents.whatsapp, true);
    assert.throws(() => contacts.suppressDestination('a', 'email', 'bad', 'Unsubscribed'), error => error.status === 400);
    db.prepare('DELETE FROM projects WHERE id=?').run('b'); assert.deepEqual(contacts.suppressDestination('b', 'email', 'original@example.test', 'Unsubscribed'), { suppressed: 0 });
  } finally { db.close(); }
});

test('verified Messenger identities create scoped replay-safe contacts without inferred destinations or campaign permissions', async () => {
  const { db, contacts } = fixture();
  try {
    const incoming = { accountId: 'facebook-page-a', participantId: 'page-scoped-person', conversationId: 'conversation-a', name: 'Alex Messenger', avatarUrl: 'https://cdn.example.test/avatar.jpg' };
    const manual = contacts.save('a', { name: incoming.name, email: 'alex@example.test' });
    assert.equal(contacts.findMessenger('a', incoming.accountId, incoming.participantId), null);
    const [first, replay, poll] = await Promise.all([contacts, createContacts({ db }), contacts].map(service => Promise.resolve().then(() => service.fromMessenger('a', incoming))));
    assert.equal(first.id, replay.id); assert.equal(first.id, poll.id); assert.notEqual(first.id, manual.id, 'A matching display name cannot merge unrelated identities.');
    assert.equal(contacts.list('a').length, 2); assert.equal(first.source, 'messenger'); assert.equal(first.email, ''); assert.equal(first.phone, '');
    assert.deepEqual(first.consents, { email: false, sms: false, whatsapp: false }); assert.deepEqual(first.consentEvidence, {}); assert.equal(first.consentSource, ''); assert.deepEqual(first.suppression, {});
    assert.deepEqual(first.identities.map(({ platform, accountId, participantId, conversationId }) => ({ platform, accountId, participantId, conversationId })), [{ platform: 'facebook', accountId: incoming.accountId, participantId: incoming.participantId, conversationId: incoming.conversationId }]);
    assert.ok(first.identities[0].createdAt); assert.equal(first.identities[0].avatarUrl, incoming.avatarUrl);
    const otherAccount = contacts.fromMessenger('a', { ...incoming, accountId: 'facebook-page-b' }); assert.notEqual(otherAccount.id, first.id);
    const otherProject = contacts.fromMessenger('b', incoming); assert.notEqual(otherProject.id, first.id); assert.equal(contacts.findMessenger('b', incoming.accountId, incoming.participantId).id, otherProject.id);
    assert.throws(() => db.prepare('INSERT INTO direct_contact_messenger_identities VALUES(?,?,?,?)').run('a', incoming.accountId, incoming.participantId, manual.id), /UNIQUE/, 'The database enforces identity uniqueness for independently created services.');
    const renamed = contacts.fromMessenger('a', { ...incoming, name: 'Provider rename', conversationId: 'conversation-b' }); assert.equal(renamed.name, 'Provider rename'); assert.equal(renamed.identities[0].conversationId, 'conversation-b');
    contacts.save('a', { name: 'My contact label', company: 'Studio', tags: ['customer'], email: '', phone: '' }, first.id);
    assert.equal(contacts.fromMessenger('a', { ...incoming, name: 'My contact label' }).name, 'My contact label');
    const preserved = contacts.fromMessenger('a', { ...incoming, name: 'Another provider rename' }); assert.equal(preserved.name, 'My contact label', 'Provider updates must never reclaim a manually edited name.'); assert.equal(preserved.identities[0].name, 'Another provider rename'); assert.equal(preserved.company, 'Studio'); assert.deepEqual(preserved.tags, ['customer']);
    const enriched = contacts.save('a', { email: 'messenger@example.test', phone: '+971501234567', consents: { email: true, sms: true }, consentSource: 'Explicit destination opt-in' }, first.id); assert.equal(enriched.consents.email, false, 'An identity link must not transfer consent to a newly supplied address.');
    contacts.save('a', { consents: { email: true, sms: true, whatsapp: true }, consentSource: 'Verified opt-in for these destinations' }, first.id); contacts.suppress('a', first.id, 'whatsapp', 'Explicit opt-out');
    const before = contacts.get('a', first.id), after = contacts.fromMessenger('a', incoming);
    for (const field of ['email', 'phone', 'consents', 'consentEvidence', 'consentUpdatedAt', 'consentSource', 'suppression', 'hygiene']) assert.deepEqual(after[field], before[field], `Incoming messages must preserve ${field}.`);
    for (const body of [{ identities: first.identities }, { source: 'messenger' }, { nameSource: 'messenger' }]) assert.throws(() => contacts.save('a', body, first.id), error => error.status === 400, 'Normal contact writes cannot forge identity metadata.');
    assert.throws(() => contacts.save('a', { name: 'A name alone is not an ordinary contact' }), error => error.status === 400);
    for (const body of [{ ...incoming, participantId: '' }, { ...incoming, participantId: 123 }, { ...incoming, accountId: 'bad account' }, { ...incoming, conversationId: '' }, { ...incoming, name: 'bad\nname' }, { ...incoming, avatarUrl: 'https://127.0.0.1/avatar' }, { ...incoming, email: 'forged@example.test' }]) assert.throws(() => contacts.fromMessenger('a', body), error => error.status === 400);
    assert.throws(() => contacts.fromMessenger('missing-project', incoming), error => error.status === 404);
    contacts.remove('a', first.id); assert.equal(contacts.findMessenger('a', incoming.accountId, incoming.participantId), null, 'Contact deletion cascades its identity lookup.');
    assert.notEqual(contacts.fromMessenger('a', incoming).id, first.id);
  } finally { db.close(); }
});

test('Messenger contact and identity writes are atomic standalone and inside the webhook transaction', () => {
  const { db, contacts } = fixture();
  try {
    const incoming = { accountId: 'page-a', participantId: 'sender-a', conversationId: 'thread-a' };
    db.exec('BEGIN IMMEDIATE'); const nested = contacts.fromMessenger('a', incoming); assert.equal(contacts.get('a', nested.id).id, nested.id); db.exec('ROLLBACK');
    assert.equal(contacts.list('a').length, 0); assert.equal(contacts.findMessenger('a', incoming.accountId, incoming.participantId), null, 'An outer webhook rollback also removes the auto-created contact.');
    db.exec("CREATE TRIGGER fail_identity BEFORE INSERT ON direct_contact_messenger_identities WHEN NEW.participant_id='fail' BEGIN SELECT RAISE(ABORT,'identity storage failure'); END;");
    assert.throws(() => contacts.fromMessenger('a', { ...incoming, participantId: 'fail' }), /identity storage failure/); assert.equal(contacts.list('a').length, 0, 'Standalone failure leaves no orphan contact.');
    db.exec('BEGIN IMMEDIATE'); assert.throws(() => contacts.fromMessenger('a', { ...incoming, participantId: 'fail' }), /identity storage failure/);
    const valid = contacts.fromMessenger('a', incoming); db.exec('COMMIT'); assert.equal(contacts.findMessenger('a', incoming.accountId, incoming.participantId).id, valid.id, 'A savepoint rollback preserves the caller transaction for valid subsequent work.');
    db.prepare('DELETE FROM projects WHERE id=?').run('a'); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM direct_contact_messenger_identities').get().count, 0);
  } finally { db.close(); }
});
