import { createHash, randomUUID } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import { sql } from 'drizzle-orm';
import { advisoryLock, HttpError } from './auth.ts';
import type { Database, Executor, Transaction } from './database.ts';
import { reportObject as object } from './provider-core.ts';
import type { ProviderRecord } from './provider-core.ts';
import { publicMediaUrl } from '../shared/social-posts.ts';

const channels = ['email', 'sms', 'whatsapp'], own = (value: object, key: string) => Object.hasOwn(value, key);
function fail(status: number, message: string): never { throw new HttpError(status, message); }
const text = (value: unknown, label: string, max = 200): string => { if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) fail(400, `Enter a valid ${label}.`); return value.trim(); };
const messengerId = (value: unknown, label: string) => { const id = text(value, label, 500); if (!id || /\s/.test(id)) fail(400, `Provide a valid Messenger ${label}.`); return id; };
const disposableDomains = new Set(['mailinator.com', 'guerrillamail.com', 'guerrillamail.net', 'sharklasers.com', 'grr.la', 'tempmail.com', 'temp-mail.org', '10minutemail.com', 'yopmail.com', 'throwawaymail.com', 'getnada.com', 'dispostable.com']);
const roleNames = new Set(['admin', 'info', 'sales', 'hello', 'support', 'contact', 'billing', 'marketing', 'office', 'team', 'postmaster', 'abuse', 'noreply', 'no-reply']);
const typos: Record<string, string> = { 'gmal.com': 'gmail.com', 'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gmail.con': 'gmail.com', 'hotmial.com': 'hotmail.com', 'outlok.com': 'outlook.com', 'yaho.com': 'yahoo.com', 'yahoo.con': 'yahoo.com' };
function emailAddress(value: unknown) {
  const input = text(value, 'email address', 254); if (!input) return '';
  const pieces = input.split('@'); if (pieces.length !== 2) fail(400, 'Enter one email address using name@example.com.');
  const local = pieces[0].toLowerCase(), domain = domainToASCII(pieces[1]).toLowerCase();
  if (!local || local.length > 64 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..') || !domain.includes('.') || domain.length > 253 || domain.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) || !/^(?:[a-z]{2,63}|xn--[a-z0-9-]+)$/.test(domain.split('.').at(-1)!) || `${local}@${domain}`.length > 254) fail(400, 'Enter a supported email address using name@example.com.');
  return `${local}@${domain}`;
}
function hygiene(email: string, previous?: ProviderRecord) {
  const [local, domain] = email.split('@'), labels = domain?.split('.') || [];
  return { roleAddress: Boolean(email && roleNames.has(local.split('+')[0])), disposable: Boolean(email && labels.some((_, index) => disposableDomains.has(labels.slice(index).join('.')))), typoSuggestion: typos[domain!] ? `${local}@${typos[domain!]}` : null, dnsStatus: previous?.dnsStatus || 'unchecked', dnsCheckedAt: previous?.dnsCheckedAt || null };
}
function parseCsv(csv: any) {
  if (typeof csv !== 'string' || !csv.trim() || Buffer.byteLength(csv) > 2 * 1024 * 1024) fail(400, 'Provide a CSV file of at most 2 MB.');
  const rows: string[][] = []; let row: string[] = [], field = '', quoted = false, closed = false;
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
  const headers = rows.shift()!.map(value => value.trim().toLowerCase());
  if (new Set(headers).size !== headers.length || headers.some(value => !['name', 'email', 'phone', 'company', 'tags'].includes(value)) || !headers.some(value => ['email', 'phone'].includes(value))) fail(400, 'CSV headers may be name,email,phone,company,tags and must include email or phone.');
  return rows.map((values, index) => ({ row: index + 2, values: values.length === headers.length ? Object.fromEntries(headers.map((header, position) => [header, values[position]])) : null }));
}

// Every contact write in one project takes this lock: duplicate-destination checks, the 10,000-contact limit and
// Messenger identity creation read the whole project first, so concurrent writers could otherwise both pass them.
export const lockContacts = (tx: Executor, projectId: string) => advisoryLock(tx, 'direct-contacts:' + projectId);
// A transaction on the pool, or a savepoint when the caller passes its own transaction.
const atomic = <T>(executor: Executor, run: (tx: Transaction) => Promise<T>): Promise<T> => (executor as Database).transaction(run);
const resultRows = async (query: Promise<{ rows: unknown[] }>) => (await query).rows as ProviderRecord[];

/** The contact's suppression on a channel, unless it is a provider's temporary one that has expired. */
export function activeSuppression(contact: any, channel: string) {
  const entry = contact?.suppression?.[channel];
  return entry && !(entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) ? entry : null;
}
export function createContacts({ db }: { db: Database }) {
  const hash = (target: string) => createHash('sha256').update(target).digest('hex');
  const ledger = async (ex: Executor, projectId: string, channel: string, target: string) => (await resultRows(ex.execute(sql`SELECT reason, created_at AS at FROM direct_contact_suppressions WHERE project_id = ${projectId} AND channel = ${channel} AND target_hash = ${hash(target)}`)))[0];
  const remember = (ex: Executor, projectId: string, channel: string, targetHash: string, reason: string, at: string) => ex.execute(sql`INSERT INTO direct_contact_suppressions VALUES (${projectId}, ${channel}, ${targetHash}, ${reason}, ${at}) ON CONFLICT (project_id, channel, target_hash) DO NOTHING`);
  const smsSuppression = async (target: string, ex: Executor = db): Promise<any> => target ? (await resultRows(ex.execute(sql`SELECT reason, created_at AS at FROM direct_sms_suppressions WHERE target_hash = ${hash(target)}`)))[0] : null;
  // One suppression lookup per read instead of one query per contact.
  async function contactViews(ex: Executor, found: ProviderRecord[]): Promise<ProviderRecord[]> {
    const contacts = found.map(row => row.data as ProviderRecord), hashes = [...new Set(contacts.filter(contact => contact.phone).map(contact => hash(contact.phone)))], blocked = new Map<string, ProviderRecord>();
    if (hashes.length) for (const row of await resultRows(ex.execute(sql`SELECT target_hash, reason, created_at AS at FROM direct_sms_suppressions WHERE target_hash IN ${hashes}`))) blocked.set(row.target_hash, { reason: row.reason, at: row.at });
    for (const contact of contacts) { const suppressed = contact.phone && blocked.get(hash(contact.phone)); if (suppressed) { contact.suppression.sms ||= suppressed; contact.consents.sms = false; delete contact.consentEvidence?.sms; } }
    return contacts;
  }
  const list = async (projectId: string, ex: Executor = db): Promise<ProviderRecord[]> => contactViews(ex, await resultRows(ex.execute(sql`SELECT data FROM direct_contacts WHERE project_id = ${projectId} ORDER BY seq DESC`)));
  const get = async (projectId: string, id: string, ex: Executor = db): Promise<ProviderRecord | null> => (await contactViews(ex, await resultRows(ex.execute(sql`SELECT data FROM direct_contacts WHERE project_id = ${projectId} AND id = ${id}`))))[0] || null;
  async function findMessenger(projectId: string, accountId: unknown, participantId: unknown, ex: Executor = db) {
    const found = await resultRows(ex.execute(sql`SELECT c.data FROM direct_contact_messenger_identities i JOIN direct_contacts c ON c.id = i.contact_id AND c.project_id = i.project_id WHERE i.project_id = ${projectId} AND i.account_id = ${messengerId(accountId, 'account ID')} AND i.participant_id = ${messengerId(participantId, 'participant ID')}`));
    return (await contactViews(ex, found))[0] || null;
  }
  async function prepare(ex: Executor, projectId: string, body: any, previous?: ProviderRecord, messengerIdentity?: ProviderRecord): Promise<ProviderRecord> {
    if (!object(body) || Object.keys(body).some(key => !['name', 'email', 'phone', 'company', 'tags', 'consents', 'consentSource'].includes(key))) fail(400, 'Use the supported contact fields.');
    const result: ProviderRecord = { name: '', email: '', phone: '', company: '', tags: [], ...previous };
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
      // A provider's temporary suppression belongs to the old address; it does not follow an edited destination.
      if (previous && destination !== oldDestination && result.suppression[channel]?.expiresAt) delete result.suppression[channel];
      if (destination) { const suppressed = await ledger(ex, projectId, channel, destination) || channel === 'sms' && await smsSuppression(destination, ex); if (suppressed) result.suppression[channel] = suppressed; }
      if (!destination || previous && destination !== oldDestination || result.suppression[channel] && !result.suppression[channel].expiresAt) { result.consents[channel] = false; delete result.consentEvidence[channel]; }
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
  function match(rows: Map<string, ProviderRecord>, body: any, id?: string) {
    if (!object(body)) fail(400, 'Use the supported contact fields.');
    if (id) { const previous = rows.get(id); if (!previous) fail(404, 'Contact not found in this project.'); return previous; }
    const email = own(body, 'email') ? emailAddress(body.email) : '', phone = body.phone === undefined ? '' : text(body.phone, 'phone number', 16);
    const matches = [...rows.values()].filter(row => email && row.email === email || phone && row.phone === phone);
    if (matches.length > 1) fail(409, 'Email and phone match different contacts. Review them separately.');
    const previous = matches[0];
    if (previous && (email && previous.email && email !== previous.email || phone && previous.phone && phone !== previous.phone)) fail(409, 'This row would replace another contact identity. Edit that contact explicitly.');
    return previous;
  }
  async function persist(ex: Executor, record: ProviderRecord) {
    await ex.execute(sql`INSERT INTO direct_contacts (id, project_id, data) VALUES (${record.id}, ${record.projectId}, ${JSON.stringify(record)}) ON CONFLICT (id) DO UPDATE SET data = excluded.data WHERE direct_contacts.project_id = excluded.project_id`);
    for (const channel of channels) { const target = channel === 'email' ? record.email : record.phone, suppression = record.suppression[channel]; if (target && suppression && !suppression.expiresAt) await remember(ex, record.projectId, channel, hash(target), suppression.reason, suppression.at); }
    return record;
  }
  async function save(projectId: string, body: any, id?: string) {
    return db.transaction(async tx => {
      await lockContacts(tx, projectId);
      // ponytail: scan at most 10,000 contacts; index canonical destinations if this project limit grows.
      const rows = new Map((await list(projectId, tx)).map(row => [row.id, row])), previous = match(rows, body, id), record = await prepare(tx, projectId, body, previous);
      if ([...rows.values()].some(row => row.id !== record.id && (record.email && row.email === record.email || record.phone && row.phone === record.phone))) fail(409, 'This destination belongs to another contact in this project.');
      if (!previous && rows.size >= 10000) fail(400, 'This project has reached its 10,000-contact limit.');
      return persist(tx, record);
    });
  }
  /** Pass the webhook transaction as `executor`; the contact and identity writes then run in a savepoint inside it. */
  async function fromMessenger(projectId: string, body: any, executor: Executor = db) {
    if (!object(body) || Object.keys(body).some(key => !['accountId', 'participantId', 'conversationId', 'name', 'avatarUrl'].includes(key))) fail(400, 'Use the verified Messenger identity fields.');
    const accountId = messengerId(body.accountId, 'account ID'), participantId = messengerId(body.participantId, 'participant ID'), conversationId = messengerId(body.conversationId, 'conversation ID');
    const name = body.name === undefined ? undefined : text(body.name, 'Messenger name');
    let avatarUrl: string | undefined;
    if (body.avatarUrl !== undefined && body.avatarUrl !== '') { try { avatarUrl = publicMediaUrl(body.avatarUrl); } catch { fail(400, 'Use a public HTTPS Messenger avatar URL.'); } }
    // The savepoint also works inside the caller's webhook transaction; a failed identity write must not leave an orphan contact.
    return atomic(executor, async tx => {
      if (!(await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId}`)).rowCount) fail(404, 'Project not found.');
      // Replayed or parallel deliveries of one identity wait here and then find the first contact instead of creating a second.
      await lockContacts(tx, projectId);
      let record = await findMessenger(projectId, accountId, participantId, tx);
      const at = new Date().toISOString();
      if (record) {
        const identity = record.identities.find((row: ProviderRecord) => row.platform === 'facebook' && row.accountId === accountId && row.participantId === participantId);
        if (!identity) throw new Error('The stored Messenger identity is incomplete.');
        if (name && record.nameSource === 'messenger') record.name = name;
        Object.assign(identity, { conversationId, ...(name ? { name } : {}), ...(avatarUrl ? { avatarUrl } : {}), updatedAt: at });
        record.updatedAt = at; await persist(tx, record);
      } else {
        if ((await resultRows(tx.execute(sql`SELECT COUNT(*) AS count FROM direct_contacts WHERE project_id = ${projectId}`)))[0].count >= 10000) fail(400, 'This project has reached its 10,000-contact limit.');
        const identity = { platform: 'facebook', accountId, participantId, conversationId, name: name || '', ...(avatarUrl ? { avatarUrl } : {}), createdAt: at, updatedAt: at };
        record = await persist(tx, await prepare(tx, projectId, { name: name || '' }, undefined, identity));
        await tx.execute(sql`INSERT INTO direct_contact_messenger_identities VALUES (${projectId}, ${accountId}, ${participantId}, ${record.id})`);
      }
      return record;
    });
  }
  async function importCsv(projectId: string, options: any) {
    if (!object(options) || Object.keys(options).some(key => !['csv', 'dryRun', 'consents', 'consentSource'].includes(key)) || options.dryRun !== undefined && typeof options.dryRun !== 'boolean') fail(400, 'Use CSV text, optional consent evidence and an optional dry-run flag.');
    if (options.consents !== undefined && (!object(options.consents) || Object.entries(options.consents).some(([channel, granted]) => !channels.includes(channel) || typeof granted !== 'boolean'))) fail(400, 'Use explicit channel consent flags.');
    if (Object.values(options.consents || {}).some(Boolean) && (!options.consentSource || !text(options.consentSource, 'consent source', 1000))) fail(400, 'Record the source of explicit consent before importing opt-ins.');
    const entries = parseCsv(options.csv);
    return db.transaction(async tx => {
      await lockContacts(tx, projectId);
      const rows = new Map((await list(projectId, tx)).map(row => [row.id, row])), result: ProviderRecord = { imported: 0, created: 0, updated: 0, skipped: 0, contacts: [], errors: [], dryRun: options.dryRun === true };
      for (const entry of entries) {
        try {
          if (!entry.values) fail(400, 'The number of fields does not match the CSV header.');
          const body: ProviderRecord = Object.fromEntries(Object.entries(entry.values as ProviderRecord).filter(([, value]) => value.trim())), previous = match(rows, body);
          if (body.tags) body.tags = [...new Set([...(previous?.tags || []), ...body.tags.split(/[;|]/).map((value: string) => value.trim()).filter(Boolean)])];
          body.consents = Object.fromEntries(Object.entries(options.consents || {}).filter(([, granted]) => granted)); if (options.consentSource !== undefined) body.consentSource = options.consentSource;
          const record = await prepare(tx, projectId, body, previous);
          if (!previous && rows.size >= 10000) fail(400, 'This project has reached its 10,000-contact limit.');
          rows.set(record.id, record); result.imported++; result[previous ? 'updated' : 'created']++; result.contacts.push(record);
        } catch (error: any) { if (!(error instanceof HttpError)) throw error; result.skipped++; result.errors.push({ row: entry.row, error: error.message }); }
      }
      if (!result.dryRun) for (const record of new Map<string, ProviderRecord>(result.contacts.map((record: ProviderRecord): [string, ProviderRecord] => [record.id, record])).values()) await persist(tx, record);
      result.contacts = [...new Map(result.contacts.map((record: ProviderRecord): [string, ProviderRecord] => [record.id, record])).values()]; return result;
    });
  }
  function suppressionReason(channel: string, reason: any) {
    if (!channels.includes(channel)) fail(400, 'Choose email, sms or whatsapp.');
    reason = text(reason, 'suppression reason', 500); if (!reason) fail(400, 'Provide a suppression reason.');
    return channel === 'email' && /^hard[-_ ]?bounce$/i.test(reason) ? 'hard-bounce' : reason;
  }
  function suppressRecord(ex: Executor, record: ProviderRecord, channel: string, reason: string, at: string) {
    if (!record.suppression[channel] || record.suppression[channel].expiresAt) record.suppression[channel] = { reason, at };
    record.consents[channel] = false; delete record.consentEvidence[channel]; record.updatedAt = at;
    if (channel === 'email' && reason === 'hard-bounce') record.hardBounceAt ||= at;
    return persist(ex, record);
  }
  async function suppress(projectId: string, id: string, channel: string, reason: any) {
    reason = suppressionReason(channel, reason);
    return db.transaction(async tx => {
      await lockContacts(tx, projectId);
      const record = await get(projectId, id, tx); if (!record) fail(404, 'Contact not found in this project.');
      return suppressRecord(tx, record, channel, reason, new Date().toISOString());
    });
  }
  // A provider's temporary suppression (Cloudflare's soft bounce, or a hard bounce it lists with an expiry) holds sends
  // until it expires. Campaign did not withdraw the recipient's permission, so consent and its evidence stay, and the
  // entry is not copied to the permanent ledger. A permanent suppression already on the contact wins.
  async function suppressUntil(projectId: string, id: string, channel: string, reason: any, expiresAt: string) {
    reason = suppressionReason(channel, reason);
    if (!Number.isFinite(Date.parse(expiresAt))) fail(400, 'Provide a valid suppression expiry.');
    return db.transaction(async tx => {
      await lockContacts(tx, projectId);
      const record = await get(projectId, id, tx); if (!record) fail(404, 'Contact not found in this project.');
      const current = record.suppression[channel], at = new Date().toISOString();
      if (current && !current.expiresAt || current?.reason === reason && current.expiresAt === expiresAt) return record;
      record.suppression[channel] = { reason, at: current?.reason === reason ? current.at : at, expiresAt }; record.updatedAt = at;
      return persist(tx, record);
    });
  }
  async function suppressDestination(projectId: string, channel: string, target: any, reason: any, executor: Executor = db) {
    reason = suppressionReason(channel, reason);
    target = channel === 'email' ? emailAddress(target) : text(target, 'phone number', 16);
    if (!target || channel !== 'email' && !/^\+[1-9]\d{6,14}$/.test(target)) fail(400, 'Provide a valid destination to suppress.');
    return atomic(executor, async tx => {
      if (!(await tx.execute(sql`SELECT id FROM projects WHERE id = ${projectId}`)).rowCount) return { suppressed: 0 };
      await lockContacts(tx, projectId);
      const at = new Date().toISOString(); await remember(tx, projectId, channel, hash(target), reason, at);
      const matching = (await list(projectId, tx)).filter(record => (channel === 'email' ? record.email : record.phone) === target);
      for (const record of matching) await suppressRecord(tx, record, channel, reason, at);
      return { suppressed: matching.length };
    });
  }
  async function suppressSmsGlobally(target: any, reason: any) {
    reason = suppressionReason('sms', reason); target = text(target, 'phone number', 16);
    if (!/^\+[1-9]\d{6,14}$/.test(target)) fail(400, 'Provide a valid destination to suppress.');
    await db.execute(sql`INSERT INTO direct_sms_suppressions VALUES (${hash(target)}, ${reason}, ${new Date().toISOString()}) ON CONFLICT (target_hash) DO NOTHING`);
    return { suppressed: true };
  }
  // A signed START/UNSTOP is the recipient's own re-opt-in at the carrier: it lifts only the opt-out suppression a STOP
  // wrote, never a manual or hard suppression, and restores no campaign consent (contacts keep sms consent off until a
  // new consent source is recorded). Council decision ten98-code-system#35 Q3.
  async function liftSmsOptOut(target: any): Promise<boolean> {
    if (typeof target !== 'string' || !/^\+[1-9]\d{6,14}$/.test(target)) return false;
    const reason = 'Recipient opted out', targetHash = hash(target);
    return db.transaction(async tx => {
      const global = await tx.execute(sql`DELETE FROM direct_sms_suppressions WHERE target_hash = ${targetHash} AND reason = ${reason}`);
      // Projects copied the opt-out into their ledger and contact records; lift that same reason there, under each project's contacts lock.
      const projects = [...new Set((await resultRows(tx.execute(sql`DELETE FROM direct_contact_suppressions WHERE channel = 'sms' AND target_hash = ${targetHash} AND reason = ${reason} RETURNING project_id`))).map(row => row.project_id as string))].sort();
      for (const projectId of projects) {
        await lockContacts(tx, projectId);
        for (const record of (await list(projectId, tx)).filter(record => record.phone === target && record.suppression.sms?.reason === reason)) { delete record.suppression.sms; record.updatedAt = new Date().toISOString(); await persist(tx, record); }
      }
      return Boolean(global.rowCount || projects.length);
    });
  }
  async function assessDNS(projectId: string, ids: unknown, { resolver, assertAccess }: { resolver?: any; assertAccess?: () => unknown } = {}) {
    await assertAccess?.();
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string')) fail(400, 'Select between 1 and 100 contacts to check DNS.');
    const selected: ProviderRecord[] = [];
    for (const id of new Set(ids)) { const record = await get(projectId, id); if (!record) fail(404, 'A selected contact is not in this project.'); selected.push(record); }
    const domains = [...new Set(selected.filter(row => row.email).map(row => row.email.split('@')[1]))], outcomes = new Map();
    if (domains.length) {
      const native = resolver ? null : new Resolver({ timeout: 1500, tries: 1 }), backend = resolver || native, lookup = typeof resolver === 'function' ? resolver : backend.resolveMx.bind(backend); let expired = false, timer;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => { expired = true; native?.cancel(); reject(new Error('DNS check timed out')); }, 5000); });
      const query = (action: () => unknown) => { if (expired) return Promise.reject(new Error('DNS check timed out')); return Promise.race([Promise.resolve().then(action), deadline]); };
      async function domainStatus(domain: string) {
        let records;
        try { records = await query(() => lookup(domain)); }
        catch (error: any) { if (error.code === 'ENOTFOUND') return 'nxdomain'; if (error.code !== 'ENODATA') throw error; records = []; }
        if (!Array.isArray(records) || records.some(row => !row || !Number.isInteger(row.priority) || row.priority < 0 || typeof row.exchange !== 'string')) return 'unavailable';
        if (records.some(row => row.priority === 0 && ['', '.'].includes(row.exchange))) return 'null_mx';
        if (records.some(row => row.exchange && row.exchange !== '.')) return 'mx';
        // RFC 5321: an address record can serve as an implicit MX when no MX exists.
        if (typeof backend.resolve4 !== 'function' || typeof backend.resolve6 !== 'function') return 'unavailable';
        let absent = 0;
        for (const method of ['resolve4', 'resolve6']) {
          try { const addresses = await query(() => backend[method](domain)); if (!Array.isArray(addresses) || addresses.some(address => typeof address !== 'string' || !address)) return 'unavailable'; if (addresses.length) return 'implicit_mx'; absent++; }
          catch (error: any) { if (['ENODATA', 'ENOTFOUND'].includes(error.code)) absent++; }
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
    await assertAccess?.();
    const checkedAt = new Date().toISOString();
    return db.transaction(async tx => {
      // Re-read under the project lock so a stale DNS result cannot overwrite an edit or suppression made during the lookups.
      await lockContacts(tx, projectId);
      const contacts: ProviderRecord[] = [];
      for (const snapshot of selected) {
        const current = await get(projectId, snapshot.id, tx); if (!current) continue;
        if (!current.email || current.email !== snapshot.email) { contacts.push(current); continue; }
        current.hygiene = { ...current.hygiene, dnsStatus: outcomes.get(current.email.split('@')[1]) || 'unavailable', dnsCheckedAt: checkedAt }; current.updatedAt = checkedAt; await persist(tx, current); contacts.push(current);
      }
      return { checked: outcomes.size, contacts, notice: 'DNS checks describe domain mail records only. They do not verify that a mailbox exists or that a person consented.' };
    });
  }
  return { list, get, save, fromMessenger, findMessenger, import: importCsv, assessDNS, suppress, suppressUntil, suppressDestination, suppressSmsGlobally, liftSmsOptOut, smsSuppression, async remove(projectId: string, id: string) { return Boolean((await db.execute(sql`DELETE FROM direct_contacts WHERE project_id = ${projectId} AND id = ${id}`)).rowCount); } };
}
