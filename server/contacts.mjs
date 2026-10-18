import { createHash, randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { HttpError } from './auth.mjs';
import { transaction } from './database.mjs';
import { publicMediaUrl } from '../shared/social-posts.mjs';

const channels = ['email', 'sms', 'whatsapp'], own = (value, key) => Object.hasOwn(value, key);
const fail = (status, message) => { throw new HttpError(status, message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, label, max = 200) => { if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(400, `Enter a valid ${label}.`); return value.trim(); };
const messengerId = (value, label) => { const id = text(value, label, 500); if (!id || /\s/.test(id)) fail(400, `Provide a valid Messenger ${label}.`); return id; };
const disposableDomains = new Set(['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', 'grr.la', 'tempmail.com', 'temp-mail.org', '10minutemail.com', 'yopmail.com', 'throwawaymail.com', 'getnada.com', 'dispostable.com']);
const roleNames = new Set(['admin', 'info', 'sales', 'hello', 'support', 'contact', 'billing', 'marketing', 'office', 'team', 'postmaster', 'abuse', 'noreply', 'no-reply']);
const typos = { 'gmal.com': 'gmail.com', 'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmail.con': 'gmail.com', 'hotmial.com': 'hotmail.com', 'outlok.com': 'outlook.com', 'yaho.com': 'yahoo.com', 'yahoo.con': 'yahoo.com' };
function emailAddress(value) {
  const input = text(value, 'email address', 254); if (!input) return '';
  const pieces = input.split('@'); if (pieces.length !== 2) fail(400, 'Enter one email address using name@example.com.');
  const local = pieces[0].toLowerCase(), domain = domainToASCII(pieces[1]).toLowerCase();
  if (!local || local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..') || !domain.includes('.') || domain.length > 253 || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/.test(domain.split('.').at(-1)) || `${local}@${domain}`.length > 254) fail(400, 'Enter a supported email address using name@example.com.');
  return `${local}@${domain}`;
}
function hygiene(email, previous) {
  const [local, domain] = email.split('@'), labels = domain?.split('.') || [];
  return { roleAddress: Boolean(email && roleNames.has(local.split('+')[0])), disposable: Boolean(email && labels.some((_, index) => disposableDomains.has(labels.slice(index).join('.')))), typoSuggestion: typos[domain] ? `${local}@${typos[domain]}` : null, dnsStatus: previous?.dnsStatus || 'unchecked', dnsCheckedAt: previous?.dnsCheckedAt || null };
}
function parseCsv(csv) {
  if (typeof csv !== 'string' || !csv.trim() || Buffer.byteLength(csv) > 2 * 1024 * 1024) fail(400, 'Provide a CSV file of at most 2 MB.');
  const rows = []; let row = [], field = '', quoted = false, closed = false;
  const finish = () => { row.push(field); field = ''; closed = false; if (row.length > 10) fail(400, 'Use only the supported contact columns.'); };
  const line = () => { finish(); if (row.some(value => value.trim())) rows.push(row); row = []; if (rows.length > 1001) fail(400, 'Import at most 1,000 contacts at a time.'); };
  csv = csv.replace(/^\uFEFF/, '');
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index];
    if (quoted) { if (char === '"') { if (csv[index + 1] === '"') { field += '"'; index++; } else { quoted = false; closed = true; } } else field += char; }
    else if (char === ',') finish();
    else if (char === '\n' || char === '\r') { if (char === '\r' && csv[index + 1] === '\n') index++; line(); }
    else if (closed) { if (!/[ \t]/.test(char)) fail(400, 'A quoted CSV field must end before the next column.'); }
    else if (char === '"') { if (field) fail(400, 'CSV quotes must surround the whole field.'); quoted = true; }
    else field += char;
    if (field.length > 10000) fail(400, 'A CSV field is too long.');
  }
  if (quoted) fail(400, 'Close every quoted CSV field.');
  if (field || row.length || closed) line();
  if (!rows.length) fail(400, 'Provide a header row and contact rows.');
  const headers = rows.shift().map(value => value.trim().toLowerCase());
  if (new Set(headers).size !== headers.length || headers.some(value => !['name', 'email', 'phone', 'company', 'tags'].includes(value)) || !headers.some(value => ['email', 'phone'].includes(value))) fail(400, 'CSV headers may be name,email,phone,company,tags and must include email or phone.');
  return rows.map((values, index) => ({ row: index + 2, values: values.length === headers.length ? Object.fromEntries(headers.map((header, position) => [header, values[position]])) : null }));
}

export function createContacts({ db }) {
  db.exec(`CREATE TABLE IF NOT EXISTS direct_contacts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS direct_contacts_project ON direct_contacts(project_id);
    CREATE TABLE IF NOT EXISTS direct_contact_messenger_identities(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,account_id TEXT NOT NULL,participant_id TEXT NOT NULL,contact_id TEXT NOT NULL REFERENCES direct_contacts(id) ON DELETE CASCADE,PRIMARY KEY(project_id,account_id,participant_id));
    CREATE TABLE IF NOT EXISTS direct_contact_suppressions(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,channel TEXT NOT NULL,target_hash TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,channel,target_hash));
    CREATE TABLE IF NOT EXISTS direct_sms_suppressions(target_hash TEXT PRIMARY KEY,reason TEXT NOT NULL,created_at TEXT NOT NULL);`);
  const read = db.prepare('SELECT data FROM direct_contacts WHERE project_id=? ORDER BY rowid DESC'), find = db.prepare('SELECT data FROM direct_contacts WHERE project_id=? AND id=?');
  const hash = target => createHash('sha256').update(target).digest('hex');
  const ledger = db.prepare('SELECT reason,created_at AS at FROM direct_contact_suppressions WHERE project_id=? AND channel=? AND target_hash=?');
  const remember = db.prepare('INSERT INTO direct_contact_suppressions VALUES(?,?,?,?,?) ON CONFLICT(project_id,channel,target_hash) DO NOTHING');
  const smsSuppression = target => target ? db.prepare('SELECT reason,created_at AS at FROM direct_sms_suppressions WHERE target_hash=?').get(hash(target)) : null;
  const contactView = row => { const contact = JSON.parse(row.data), suppressed = smsSuppression(contact.phone); if (suppressed) { contact.suppression.sms ||= suppressed; contact.consents.sms = false; delete contact.consentEvidence?.sms; } return contact; };
  const list = projectId => read.all(projectId).map(contactView);
  const get = (projectId, id) => { const row = find.get(projectId, id); return row ? contactView(row) : null; };
  const messengerContact = db.prepare('SELECT c.data FROM direct_contact_messenger_identities i JOIN direct_contacts c ON c.id=i.contact_id AND c.project_id=i.project_id WHERE i.project_id=? AND i.account_id=? AND i.participant_id=?');
  function findMessenger(projectId, accountId, participantId) {
    const row = messengerContact.get(projectId, messengerId(accountId, 'account ID'), messengerId(participantId, 'participant ID')); return row ? contactView(row) : null;
  }
  function prepare(projectId, body, previous, messengerIdentity) {
    if (!object(body) || Object.keys(body).some(key => !['name', 'email', 'phone', 'company', 'tags', 'consents', 'consentSource'].includes(key))) fail(400, 'Use the supported contact fields.');
    const result = { name: '', email: '', phone: '', company: '', tags: [], ...previous };
    for (const field of ['name', 'company']) if (own(body, field)) result[field] = text(body[field], field);
    if (messengerIdentity) Object.assign(result, { source: 'messenger', nameSource: 'messenger', identities: [messengerIdentity] });
    if (previous?.identities?.length && own(body, 'name') && result.name !== previous.name) result.nameSource = 'manual';
    if (own(body, 'email')) result.email = emailAddress(body.email);
    if (own(body, 'phone')) { result.phone = text(body.phone, 'phone number', 16); if (result.phone && !/^\+[1-9]\d{6,14}$/.test(result.phone)) fail(400, 'Use an international E.164 phone number, for example +971501234567.'); }
    if (!result.email && !result.phone && !result.identities?.length) fail(400, 'Provide an email address or international phone number.');
    if (own(body, 'tags')) { if (!Array.isArray(body.tags) || body.tags.length > 30) fail(400, 'Use at most 30 contact tags.'); result.tags = [...new Set(body.tags.map(tag => text(tag, 'contact tag', 50)).filter(Boolean))]; }
    if (body.consents !== undefined && (!object(body.consents) || Object.entries(body.consents).some(([channel, granted]) => !channels.includes(channel) || typeof granted !== 'boolean'))) fail(400, 'Use an explicit true or false consent for each supported channel.');
    const source = own(body, 'consentSource') ? text(body.consentSource, 'consent source', 1000) : previous?.consentSource || '';
    result.consents = { email: false, sms: false, whatsapp: false, ...previous?.consents, ...body.consents }; result.suppression = { ...previous?.suppression }; result.consentEvidence = { ...previous?.consentEvidence };
    const now = new Date().toISOString();
    for (const channel of channels) {
      const destination = channel === 'email' ? result.email : result.phone, oldDestination = channel === 'email' ? previous?.email : previous?.phone;
      if (destination) { const suppressed = ledger.get(projectId, channel, hash(destination)) || channel === 'sms' && smsSuppression(destination); if (suppressed) result.suppression[channel] = suppressed; }
      if (!destination || previous && destination !== oldDestination || result.suppression[channel]) { result.consents[channel] = false; delete result.consentEvidence[channel]; }
      if (result.consents[channel]) {
        const newlyEnabled = previous?.consents?.[channel] !== true;
        if (!source || newlyEnabled && !own(body, 'consentSource')) fail(400, 'Record the source of explicit consent before enabling a channel.');
        if (body.consents?.[channel] === true && (newlyEnabled || !result.consentEvidence[channel])) result.consentEvidence[channel] = { source, at: now };
      } else delete result.consentEvidence[channel];
    }
    const consentChanged = channels.some(channel => result.consents[channel] !== (previous?.consents?.[channel] === true)) || JSON.stringify(result.consentEvidence) !== JSON.stringify(previous?.consentEvidence || {});
    result.consentSource = source; result.consentUpdatedAt = consentChanged ? now : previous?.consentUpdatedAt || null;
    result.hygiene = hygiene(result.email, result.email === previous?.email ? previous?.hygiene : undefined);
    return { ...result, id: previous?.id || randomUUID(), projectId, createdAt: previous?.createdAt || now, updatedAt: now };
  }
  function match(rows, body, id) {
    if (!object(body)) fail(400, 'Use the supported contact fields.');
    if (id) { const previous = rows.get(id); if (!previous) fail(404, 'Contact not found in this project.'); return previous; }
    const email = own(body, 'email') ? emailAddress(body.email) : '', phone = body.phone === undefined ? '' : text(body.phone, 'phone number', 16);
    const matches = [...rows.values()].filter(row => email && row.email === email || phone && row.phone === phone);
    if (matches.length > 1) fail(409, 'Email and phone match different contacts. Review them separately.');
    const previous = matches[0];
    if (previous && (email && previous.email && email !== previous.email || phone && previous.phone && phone !== previous.phone)) fail(409, 'This row would replace another contact identity. Edit that contact explicitly.');
    return previous;
  }
  function persist(record) {
    db.prepare('INSERT INTO direct_contacts VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE direct_contacts.project_id=excluded.project_id').run(record.id, record.projectId, JSON.stringify(record));
    for (const channel of channels) { const target = channel === 'email' ? record.email : record.phone, suppression = record.suppression[channel]; if (target && suppression) remember.run(record.projectId, channel, hash(target), suppression.reason, suppression.at); }
    return record;
  }
  function save(projectId, body, id) {
    return transaction(db, () => {
      // ponytail: scan at most 10,000 contacts; index canonical destinations if this project limit grows.
      const rows = new Map(list(projectId).map(row => [row.id, row])), previous = match(rows, body, id), record = prepare(projectId, body, previous);
      if ([...rows.values()].some(row => row.id !== record.id && (record.email && row.email === record.email || record.phone && row.phone === record.phone))) fail(409, 'This destination belongs to another contact in this project.');
      if (!previous && rows.size >= 10000) fail(400, 'This project has reached its 10,000-contact limit.');
      return persist(record);
    });
  }
  function fromMessenger(projectId, body) {
    if (!object(body) || Object.keys(body).some(key => !['accountId', 'participantId', 'conversationId', 'name', 'avatarUrl'].includes(key))) fail(400, 'Use the verified Messenger identity fields.');
    const accountId = messengerId(body.accountId, 'account ID'), participantId = messengerId(body.participantId, 'participant ID'), conversationId = messengerId(body.conversationId, 'conversation ID');
    const name = body.name === undefined ? undefined : text(body.name, 'Messenger name');
    let avatarUrl;
    if (body.avatarUrl !== undefined && body.avatarUrl !== '') { try { avatarUrl = publicMediaUrl(body.avatarUrl); } catch { fail(400, 'Use a public HTTPS Messenger avatar URL.'); } }
    // SAVEPOINT also works inside the caller's webhook transaction; a failed identity write must not leave an orphan contact.
    db.exec('SAVEPOINT messenger_contact');
    try {
      if (!db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)) fail(404, 'Project not found.');
      let record = findMessenger(projectId, accountId, participantId);
      const at = new Date().toISOString();
      if (record) {
        const identity = record.identities.find(row => row.platform === 'facebook' && row.accountId === accountId && row.participantId === participantId);
        if (!identity) throw new Error('The stored Messenger identity is incomplete.');
        if (name && record.nameSource === 'messenger') record.name = name;
        Object.assign(identity, { conversationId, ...(name ? { name } : {}), ...(avatarUrl ? { avatarUrl } : {}), updatedAt: at });
        record.updatedAt = at; persist(record);
      } else {
        if (db.prepare('SELECT COUNT(*) AS count FROM direct_contacts WHERE project_id=?').get(projectId).count >= 10000) fail(400, 'This project has reached its 10,000-contact limit.');
        const identity = { platform: 'facebook', accountId, participantId, conversationId, name: name || '', ...(avatarUrl ? { avatarUrl } : {}), createdAt: at, updatedAt: at };
        record = persist(prepare(projectId, { name: name || '' }, undefined, identity));
        db.prepare('INSERT INTO direct_contact_messenger_identities VALUES(?,?,?,?)').run(projectId, accountId, participantId, record.id);
      }
      db.exec('RELEASE SAVEPOINT messenger_contact'); return record;
    } catch (error) { db.exec('ROLLBACK TO SAVEPOINT messenger_contact; RELEASE SAVEPOINT messenger_contact'); throw error; }
  }
  function importCsv(projectId, options) {
    if (!object(options) || Object.keys(options).some(key => !['csv', 'dryRun', 'consents', 'consentSource'].includes(key)) || options.dryRun !== undefined && typeof options.dryRun !== 'boolean') fail(400, 'Use CSV text, optional consent evidence and an optional dry-run flag.');
    if (options.consents !== undefined && (!object(options.consents) || Object.entries(options.consents).some(([channel, granted]) => !channels.includes(channel) || typeof granted !== 'boolean'))) fail(400, 'Use explicit channel consent flags.');
    if (Object.values(options.consents || {}).some(Boolean) && (!options.consentSource || !text(options.consentSource, 'consent source', 1000))) fail(400, 'Record the source of explicit consent before importing opt-ins.');
    const entries = parseCsv(options.csv);
    return transaction(db, () => {
      const rows = new Map(list(projectId).map(row => [row.id, row])), result = { imported: 0, created: 0, updated: 0, skipped: 0, contacts: [], errors: [], dryRun: options.dryRun === true };
      for (const entry of entries) {
        try {
          if (!entry.values) fail(400, 'The number of fields does not match the CSV header.');
          const body = Object.fromEntries(Object.entries(entry.values).filter(([, value]) => value.trim())), previous = match(rows, body);
          if (body.tags) body.tags = [...new Set([...(previous?.tags || []), ...body.tags.split(/[;|]/).map(value => value.trim()).filter(Boolean)])];
          body.consents = Object.fromEntries(Object.entries(options.consents || {}).filter(([, granted]) => granted)); if (options.consentSource !== undefined) body.consentSource = options.consentSource;
          const record = prepare(projectId, body, previous);
          if (!previous && rows.size >= 10000) fail(400, 'This project has reached its 10,000-contact limit.');
          rows.set(record.id, record); result.imported++; result[previous ? 'updated' : 'created']++; result.contacts.push(record);
        } catch (error) { if (!(error instanceof HttpError)) throw error; result.skipped++; result.errors.push({ row: entry.row, error: error.message }); }
      }
      if (!result.dryRun) for (const record of new Map(result.contacts.map(record => [record.id, record])).values()) persist(record);
      result.contacts = [...new Map(result.contacts.map(record => [record.id, record])).values()]; return result;
    });
  }
  function suppressionReason(channel, reason) {
    if (!channels.includes(channel)) fail(400, 'Choose email, sms or whatsapp.');
    reason = text(reason, 'suppression reason', 500); if (!reason) fail(400, 'Provide a suppression reason.');
    return channel === 'email' && /^hard[-_ ]?bounce$/i.test(reason) ? 'hard-bounce' : reason;
  }
  function suppressRecord(record, channel, reason, at) {
    record.suppression[channel] ||= { reason, at }; record.consents[channel] = false; delete record.consentEvidence[channel]; record.updatedAt = at;
    if (channel === 'email' && reason === 'hard-bounce') record.hardBounceAt ||= at;
    return persist(record);
  }
  function suppress(projectId, id, channel, reason) {
    reason = suppressionReason(channel, reason);
    return transaction(db, () => {
      const record = get(projectId, id); if (!record) fail(404, 'Contact not found in this project.');
      return suppressRecord(record, channel, reason, new Date().toISOString());
    });
  }
  function suppressDestination(projectId, channel, target, reason) {
    reason = suppressionReason(channel, reason);
    target = channel === 'email' ? emailAddress(target) : text(target, 'phone number', 16);
    if (!target || channel !== 'email' && !/^\+[1-9]\d{6,14}$/.test(target)) fail(400, 'Provide a valid destination to suppress.');
    return transaction(db, () => {
      if (!db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)) return { suppressed: 0 };
      const at = new Date().toISOString(); remember.run(projectId, channel, hash(target), reason, at);
      const matching = list(projectId).filter(record => (channel === 'email' ? record.email : record.phone) === target);
      for (const record of matching) suppressRecord(record, channel, reason, at);
      return { suppressed: matching.length };
    });
  }
  function suppressSmsGlobally(target, reason) {
    reason = suppressionReason('sms', reason); target = text(target, 'phone number', 16);
    if (!/^\+[1-9]\d{6,14}$/.test(target)) fail(400, 'Provide a valid destination to suppress.');
    db.prepare('INSERT INTO direct_sms_suppressions VALUES(?,?,?) ON CONFLICT(target_hash) DO NOTHING').run(hash(target), reason, new Date().toISOString());
    return { suppressed: true };
  }
  async function assessDNS(projectId, ids, { resolver, assertAccess } = {}) {
    assertAccess?.();
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string')) fail(400, 'Select between 1 and 100 contacts to check DNS.');
    const selected = [...new Set(ids)].map(id => { const record = get(projectId, id); if (!record) fail(404, 'A selected contact is not in this project.'); return record; });
    const domains = [...new Set(selected.filter(row => row.email).map(row => row.email.split('@')[1]))], outcomes = new Map();
    if (domains.length) {
      const native = resolver ? null : new Resolver({ timeout: 1500, tries: 1 }), backend = resolver || native, lookup = typeof resolver === 'function' ? resolver : backend.resolveMx.bind(backend); let expired = false, timer;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => { expired = true; native?.cancel(); reject(new Error('DNS check timed out')); }, 5000); });
      const query = action => { if (expired) return Promise.reject(new Error('DNS check timed out')); return Promise.race([Promise.resolve().then(action), deadline]); };
      async function domainStatus(domain) {
        let records;
        try { records = await query(() => lookup(domain)); }
        catch (error) { if (error.code === 'ENOTFOUND') return 'nxdomain'; if (error.code !== 'ENODATA') throw error; records = []; }
        if (!Array.isArray(records) || records.some(row => !row || !Number.isInteger(row.priority) || row.priority < 0 || typeof row.exchange !== 'string')) return 'unavailable';
        if (records.some(row => row.priority === 0 && ['', '.'].includes(row.exchange))) return 'null_mx';
        if (records.some(row => row.exchange && row.exchange !== '.')) return 'mx';
        // RFC 5321: an address record can serve as an implicit MX when no MX exists.
        if (typeof backend.resolve4 !== 'function' || typeof backend.resolve6 !== 'function') return 'unavailable';
        let absent = 0;
        for (const method of ['resolve4', 'resolve6']) {
          try { const addresses = await query(() => backend[method](domain)); if (!Array.isArray(addresses) || addresses.some(address => typeof address !== 'string' || !address)) return 'unavailable'; if (addresses.length) return 'implicit_mx'; absent++; }
          catch (error) { if (['ENODATA', 'ENOTFOUND'].includes(error.code)) absent++; }
        }
        return absent === 2 ? 'no_mx' : 'unavailable';
      }
      let next = 0;
      try { await Promise.all(Array.from({ length: Math.min(4, domains.length) }, async () => {
        while (next < domains.length && !expired) {
          const domain = domains[next++]; let status;
          try { status = await domainStatus(domain); } catch { status = 'unavailable'; }
          outcomes.set(domain, status);
        }
      })); } finally { clearTimeout(timer); native?.cancel(); }
    }
    assertAccess?.();
    const checkedAt = new Date().toISOString();
    return transaction(db, () => ({ checked: outcomes.size, contacts: selected.flatMap(snapshot => {
      const current = get(projectId, snapshot.id); if (!current) return [];
      if (!current.email || current.email !== snapshot.email) return [current];
      current.hygiene = { ...current.hygiene, dnsStatus: outcomes.get(current.email.split('@')[1]) || 'unavailable', dnsCheckedAt: checkedAt }; current.updatedAt = checkedAt; persist(current); return [current];
    }), notice: 'DNS checks describe domain mail records only. They do not verify that a mailbox exists or that a person consented.' }));
  }
  return { list, get, save, fromMessenger, findMessenger, import: importCsv, assessDNS, suppress, suppressDestination, suppressSmsGlobally, smsSuppression, remove(projectId, id) { return db.prepare('DELETE FROM direct_contacts WHERE project_id=? AND id=?').run(projectId, id).changes > 0; } };
}
