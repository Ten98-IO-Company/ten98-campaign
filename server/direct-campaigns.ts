import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createStore } from './database.ts';
import type { Database, Executor, Store, Transaction } from './database.ts';
import { IntegrationError, fail, operation, reportObject as plain, scopedAccounts, zernioClient } from './provider-core.ts';
import { activeSuppression, createContacts, lockContacts } from './contacts.ts';
import { sendDirect, listWhatsAppTemplates, validateWhatsAppTemplate, createWhatsAppBroadcast, addWhatsAppRecipients, sendWhatsAppBroadcast, getWhatsAppBroadcast, cancelWhatsAppBroadcast, getSmsStatus, syncEmailSuppressions, emailProvider, requireEmailProvider } from './direct-providers.ts';
import { classifyEmailFeedback, readResponseText, verifySnsMessage } from '@ten98/runtime';

const channels = ['email', 'sms', 'whatsapp'];
const nowISO = () => new Date().toISOString();
const escape = (value: any) => String(value).replace(/[&<>"']/g, character => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[character]));
const text = (value: any, label: string, maximum: number, optional = false) => {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(400, 'INVALID_CAMPAIGN', `Enter ${label} of at most ${maximum} characters.`);
  return value.trim();
};
const list = (value: any, label: string, maximum = 500) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) fail(400, 'INVALID_CAMPAIGN', `${label} must contain at most ${maximum} entries.`);
  return [...new Set(value.map((item: any) => text(item, label, 120)))];
};
const gsm = new Set(Array.from('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'));
const extension = new Set(Array.from('\f^{}\\[~]|€'));
export function estimateSms(value: string) {
  const isGsm = Array.from(value).every(character => gsm.has(character) || extension.has(character));
  const units = isGsm ? Array.from(value).reduce((sum, character) => sum + (extension.has(character) ? 2 : 1), 0) : value.length;
  return { encoding: isGsm ? 'GSM-7' : 'UCS-2', units, segments: Math.max(1, Math.ceil(units / (units <= (isGsm ? 160 : 70) ? (isGsm ? 160 : 70) : (isGsm ? 153 : 67)))) };
}
function render(value: string, contact: any, html = false) {
  return value.replace(/\{\{(name|email|phone|company)\}\}/g, (_: string, key: string) => html ? escape(contact[key] || '') : contact[key] || '');
}
function content(campaign: any, contact: any) {
  return { ...campaign, subject: render(campaign.subject, contact), text: render(campaign.text, contact) + (campaign.channel === 'sms' ? '\nReply STOP to unsubscribe.' : ''), html: render(campaign.html, contact, true) };
}
function validate(raw: any) {
  if (!plain(raw)) fail(400, 'INVALID_CAMPAIGN', 'Use the campaign fields.');
  const allowed = ['name', 'channel', 'subject', 'text', 'html', 'emailPurpose', 'accountId', 'templateName', 'templateLanguage', 'templateComponents', 'contactIds', 'tags'];
  if (Object.keys(raw).some(key => !allowed.includes(key))) fail(400, 'INVALID_CAMPAIGN', 'Use only the campaign editor fields.');
  if (!channels.includes(raw.channel)) fail(400, 'INVALID_CAMPAIGN', 'Choose email, SMS or WhatsApp.');
  const data = { name: text(raw.name, 'a campaign name', 120), channel: raw.channel, subject: text(raw.subject, 'a subject', 200, true), text: text(raw.text, 'message text', 100000, true), html: text(raw.html, 'HTML content', 200000, true), emailPurpose: 'transactional', accountId: text(raw.accountId, 'a WhatsApp account', 200, true), templateName: text(raw.templateName, 'a template name', 200, true), templateLanguage: text(raw.templateLanguage, 'a template language', 30, true), contactIds: list(raw.contactIds, 'Recipients'), tags: list(raw.tags, 'Tags', 30), templateComponents: raw.templateComponents ?? [] };
  if (raw.emailPurpose !== undefined && raw.emailPurpose !== 'transactional') fail(400, 'TRANSACTIONAL_ONLY', 'Cloudflare permits transactional email only. Marketing email is not supported by this connection.');
  if (!Array.isArray(data.templateComponents) || JSON.stringify(data.templateComponents).length > 20000) fail(400, 'INVALID_CAMPAIGN', 'Use a template component array of at most 20 KB.');
  if (data.channel === 'email' && (!data.subject || !data.text)) fail(400, 'INVALID_CAMPAIGN', 'Email needs a subject and plain text content.');
  if (/[\r\n]/.test(data.subject)) fail(400, 'INVALID_CAMPAIGN', 'Email subjects must fit on one line.');
  if (data.channel === 'sms' && (!data.text || data.text.length > 1500)) fail(400, 'INVALID_CAMPAIGN', 'SMS needs message text of at most 1,500 characters.');
  if (data.channel === 'whatsapp' && (!data.accountId || !data.templateName || !data.templateLanguage)) fail(400, 'INVALID_CAMPAIGN', 'Choose a WhatsApp account, approved template and language.');
  for (const value of [data.subject, data.text, data.html]) if (/\{\{.*?\}\}/.test(value.replace(/\{\{(name|email|phone|company)\}\}/g, ''))) fail(400, 'INVALID_PERSONALIZATION', 'Supported personalization fields are name, email, phone and company.');
  return data;
}
function exclusion(contact: any, channel: string) {
  if (!contact) return 'Contact no longer exists';
  if (!contact.consents?.[channel]) return 'No recorded consent';
  const suppression = activeSuppression(contact, channel); if (suppression) return `Suppressed: ${suppression.reason}`;
  if (!(channel === 'email' ? contact.email : contact.phone)) return channel === 'email' ? 'No email address' : 'No E.164 phone number';
  if (channel === 'email' && contact.hygiene?.disposable) return 'Disposable email address';
  if (channel === 'email' && ['no_mx', 'null_mx', 'nxdomain'].includes(contact.hygiene?.dnsStatus)) return 'Email domain cannot receive mail';
  return '';
}
const credentialFields: Record<string, string[]> = { email: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_EMAIL_API_TOKEN', 'CLOUDFLARE_EMAIL_FROM_ADDRESS', 'CLOUDFLARE_EMAIL_FROM_NAME', 'CLOUDFLARE_EMAIL_REPLY_TO_ADDRESS'], sms: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'TWILIO_MESSAGING_SERVICE_SID'], whatsapp: ['ZERNIO_API_KEY'] };
// SES settings join the email fingerprint only once any is set, so campaigns scheduled before SES keep their hash.
const sesFields = ['EMAIL_PROVIDER', 'AWS_SES_REGION', 'AWS_SES_ACCESS_KEY_ID', 'AWS_SES_SECRET_ACCESS_KEY', 'AWS_SES_FROM_ADDRESS', 'AWS_SES_FROM_NAME', 'AWS_SES_REPLY_TO_ADDRESS', 'AWS_SES_CONFIGURATION_SET'];
const fingerprint = (env: any, channel: string) => createHash('sha256').update(JSON.stringify([...credentialFields[channel], ...(channel === 'email' && sesFields.some(key => env[key]) ? sesFields : [])].map(key => env[key] || ''))).digest('hex');
// Transient and undetermined bounces suppress a recipient at the third within seven days (brief for ten98-campaign#77).
const feedbackRules = { threshold: 3, windowMs: 7 * 86400000 };
const recipientHash = (email: string) => createHash('sha256').update(email.toLowerCase()).digest('hex');
const SES_SUPPRESSION_REASONS: Record<string, string> = { 'permanent-bounce': 'hard-bounce', complaint: 'complaint', 'repeated-transient': 'repeated-transient-bounce' };
const statuses = ['pending', 'sending', 'accepted', 'queued', 'sent', 'delivered', 'read', 'failed', 'undelivered', 'suppressed', 'cancelled', 'uncertain'];
const terminal = new Set(['delivered', 'read', 'failed', 'undelivered', 'suppressed', 'cancelled', 'uncertain']);
function nextStatus(previous: string, incoming: string) {
  if (!statuses.includes(incoming)) return previous;
  if (terminal.has(previous) && !(previous === 'delivered' && incoming === 'read') && previous !== 'uncertain') return previous;
  const rank: Record<string, number> = { pending: 0, sending: 1, accepted: 2, queued: 3, sent: 4, delivered: 5, read: 6 };
  return (rank[incoming] ?? 99) >= (rank[previous] ?? 0) ? incoming : previous;
}

const resultRows = async (query: Promise<{ rows: unknown[] }>) => (await query).rows as any[];
// A transaction on the pool, or a savepoint when the caller passes its own transaction.
const atomic = <T>(executor: Executor, run: (tx: Transaction) => Promise<T>): Promise<T> => (executor as Database).transaction(run);

// `store` stays in the options for callers; campaign activity is written with createStore(tx) inside the scheduling transaction.
// Twilio's re-subscribe keywords (Advanced Opt-Out): a signed START, YES or UNSTOP, or its OptOutType.
export const smsStarted = (form: URLSearchParams) => form.get('OptOutType') === 'START' || /^(START|UNSTOP|YES)$/i.test((form.get('Body') || '').trim());
export function createDirectCampaigns({ db, env, appUrl, secret }: { db: Database; env: any; appUrl: string; secret: string; store?: Store }) {
  const contacts = createContacts({ db });
  let smsInbox: any, attaching: Promise<void> | undefined;
  const campaignRows = async (projectId: string) => (await resultRows(db.execute(sql`SELECT data FROM direct_campaigns WHERE project_id = ${projectId} ORDER BY seq DESC`))).map(row => row.data);
  const find = async (projectId: string, id: string, ex: Executor = db, lock = false) => {
    const [row] = await resultRows(ex.execute(lock ? sql`SELECT data FROM direct_campaigns WHERE project_id = ${projectId} AND id = ${id} FOR UPDATE` : sql`SELECT data FROM direct_campaigns WHERE project_id = ${projectId} AND id = ${id}`));
    if (!row) fail(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found.'); return row.data;
  };
  // Row lock: a worker writing its in-memory copy cannot undo a cancellation that commits between this read and the update.
  const save = (campaign: any, ex: Executor = db) => atomic(ex, async tx => {
    const [row] = await resultRows(tx.execute(sql`SELECT data FROM direct_campaigns WHERE id = ${campaign.id} FOR UPDATE`)), current = row?.data;
    if (current?.status === 'cancelled') { campaign.status = 'cancelled'; if (current.providerStatus === 'cancelled') campaign.providerStatus = 'cancelled'; }
    campaign.updatedAt = nowISO(); await tx.execute(sql`UPDATE direct_campaigns SET data = ${JSON.stringify(campaign)} WHERE id = ${campaign.id} AND project_id = ${campaign.projectId}`); return campaign;
  });
  // Row lock: read-modify-write of the stored campaign, so a concurrent worker, refresh or cancellation write is not lost.
  const changeCampaign = (projectId: string, id: string, change: (campaign: any) => unknown) => db.transaction(async tx => {
    const campaign = await find(projectId, id, tx, true);
    return await change(campaign) === false ? campaign : save(campaign, tx);
  });
  const deliveries = async (id: string, ex: Executor = db) => (await resultRows(ex.execute(sql`SELECT data FROM direct_deliveries WHERE campaign_id = ${id} ORDER BY seq`))).map(row => row.data);
  const putDelivery = async (delivery: any, ex: Executor = db) => { delivery.updatedAt = nowISO(); await ex.execute(sql`UPDATE direct_deliveries SET data = ${JSON.stringify(delivery)} WHERE id = ${delivery.id}`); return delivery; };
  // Row lock: read-modify-write of one delivery, so a callback, refresh, cancellation or worker acknowledgement is merged rather than
  // overwritten by a stale copy. `change` returns false to leave the row unchanged; the current delivery is returned (null when gone).
  const changeDelivery = (id: string, change: (delivery: any) => unknown) => db.transaction(async tx => {
    const [row] = await resultRows(tx.execute(sql`SELECT data FROM direct_deliveries WHERE id = ${id} FOR UPDATE`));
    if (!row) return null;
    const delivery = row.data; if (await change(delivery) !== false) await putDelivery(delivery, tx); return delivery;
  });
  const recordSms = async (campaign: any, delivery: any) => smsInbox?.recordOutbound({ id: delivery.id, projectId: campaign.projectId, campaignId: campaign.id, accountSid: delivery.smsAccountSid, sender: delivery.smsSender, recipient: delivery.recipient, messagingServiceSid: delivery.smsMessagingServiceSid || '', providerId: delivery.providerId, message: delivery.message || '', status: delivery.status });
  async function decorate(campaign: any, ex: Executor = db) {
    const counts = { pending: 0, accepted: 0, delivered: 0, failed: 0, suppressed: 0, uncertain: 0 };
    for (const delivery of await deliveries(campaign.id, ex)) counts[['pending', 'sending'].includes(delivery.status) ? 'pending' : ['delivered', 'read'].includes(delivery.status) ? 'delivered' : ['failed', 'undelivered'].includes(delivery.status) ? 'failed' : ['suppressed', 'cancelled'].includes(delivery.status) ? 'suppressed' : delivery.status === 'uncertain' ? 'uncertain' : 'accepted']++;
    const { credentialHash, scheduledBy, ...publicCampaign } = campaign;
    return { ...publicCampaign, counts };
  }
  async function audience(campaign: any, ex: Executor = db) {
    const everyone = await contacts.list(campaign.projectId, ex), all = everyone.filter((contact: any) => (!campaign.contactIds.length || campaign.contactIds.includes(contact.id)) && (!campaign.tags.length || campaign.tags.some((tag: string) => contact.tags.includes(tag))));
    const eligible = [], exclusions = [];
    for (const contact of all) { const reason = exclusion(contact, campaign.channel); if (reason) exclusions.push({ id: contact.id, name: contact.name || contact.email || contact.phone, reason }); else eligible.push(contact); }
    if (campaign.contactIds.some((id: string) => !everyone.some((contact: any) => contact.id === id))) fail(400, 'CONTACT_NOT_FOUND', 'A selected contact does not belong to this project.');
    return { eligible, exclusions, total: all.length };
  }
  async function preview(campaign: any, ex: Executor = db) {
    const selected = await audience(campaign, ex), sample = content(campaign, selected.eligible[0] || { name: 'Recipient', email: 'recipient@example.com', phone: '+12025550123', company: 'Company' });
    for (const contact of selected.eligible) { const rendered = content(campaign, contact); if (campaign.channel === 'sms' && rendered.text.length > 1600 || campaign.channel === 'email' && (rendered.subject.length > 998 || rendered.text.length > 99000 || rendered.html.length > 490000)) fail(400, 'PERSONALIZATION_TOO_LONG', 'Personalization makes a message too long. Shorten the content and check the audience again.'); }
    return { campaign: await decorate(campaign, ex), previewToken: createHash('sha256').update(JSON.stringify([campaign, selected.eligible])).digest('hex'), audience: { eligible: selected.eligible.length, excluded: selected.exclusions.length, total: selected.total, exclusions: selected.exclusions, unverified: selected.eligible.filter((contact: any) => campaign.channel === 'email' && !['mx', 'implicit_mx'].includes(contact.hygiene?.dnsStatus)).length }, sample: { subject: sample.subject, text: sample.text, html: sample.html }, ...(campaign.channel === 'sms' ? { sms: { ...estimateSms(sample.text), totalSegments: selected.eligible.reduce((sum: number, contact: any) => sum + estimateSms(content(campaign, contact).text).segments, 0), estimate: true } } : {}) };
  }
  const projectFor = async (id: string): Promise<any> => (await resultRows(db.execute(sql`SELECT id, zernio_profile_id AS "zernioProfileId" FROM projects WHERE id = ${id}`)))[0];
  async function guard(campaign: any, requireAuthor = true) {
    if (fingerprint(env, campaign.channel) !== campaign.credentialHash) fail(409, 'CONNECTION_CHANGED', 'Integration settings changed. Cancel this campaign and create a new draft after reviewing the connection.');
    const project = await projectFor(campaign.projectId);
    if (!project || (campaign.channel === 'whatsapp' && project.zernioProfileId !== campaign.profileId)) fail(409, 'CONNECTION_CHANGED', 'The project provider mapping changed.');
    if (requireAuthor && !(await db.execute(sql`SELECT m.role FROM memberships m JOIN projects p ON p.workspace_id = m.workspace_id WHERE p.id = ${campaign.projectId} AND m.user_id = ${campaign.scheduledBy} AND m.role IN ('owner', 'admin', 'editor')`)).rowCount) fail(409, 'ACCESS_CHANGED', 'The campaign author no longer has permission to send.');
    return project;
  }
  function ready(channel: string) { return channel === 'email' ? emailProvider(env) === 'ses' || emailProvider(env) === 'cloudflare' && Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_EMAIL_API_TOKEN && env.CLOUDFLARE_EMAIL_FROM_ADDRESS) : channel === 'sms' ? Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_FROM_NUMBER || env.TWILIO_MESSAGING_SERVICE_SID)) : Boolean(env.ZERNIO_API_KEY); }
  function unsubscribeToken(projectId: string, email: string) { const value = Buffer.from(JSON.stringify([projectId, email])).toString('base64url'); return `${value}.${createHmac('sha256', secret).update(`direct-unsubscribe:${value}`).digest('base64url')}`; }
  function unsubscribe(token: any) {
    if (typeof token !== 'string' || token.length > 1000) fail(400, 'INVALID_LINK', 'The preference link is invalid.');
    const [value, signature, extra] = token.split('.'), expected = createHmac('sha256', secret).update(`direct-unsubscribe:${value}`).digest('base64url');
    if (extra || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) fail(400, 'INVALID_LINK', 'The preference link is invalid.');
    let ids: any; try { ids = JSON.parse(Buffer.from(value, 'base64url').toString()); } catch { fail(400, 'INVALID_LINK', 'The preference link is invalid.'); }
    if (!Array.isArray(ids) || ids.length !== 2 || !ids.every((id: any) => typeof id === 'string')) fail(400, 'INVALID_LINK', 'The preference link is invalid.');
    return ids;
  }
  async function finish(campaign: any, ex: Executor = db) {
    // Counted in SQL: a send finishes after every message, so reading every delivery here made a campaign O(N²).
    const [counts] = await resultRows(ex.execute(sql`SELECT count(*) AS total, count(*) FILTER (WHERE data->>'status' = 'uncertain') AS uncertain, count(*) FILTER (WHERE data->>'status' IN ('pending', 'sending')) AS open FROM direct_deliveries WHERE campaign_id = ${campaign.id}`));
    if (!counts.total || ['draft', 'cancelled'].includes(campaign.status)) return save(campaign, ex);
    if (counts.uncertain) campaign.status = 'attention';
    else if (!counts.open) campaign.status = 'completed';
    return save(campaign, ex);
  }
  // Row lock: finishing the stored campaign cannot overwrite a worker or schedule write that lands between its read and save.
  const finishLatest = (projectId: string, id: string) => db.transaction(async tx => finish(await find(projectId, id, tx, true), tx));
  // A process crash must never replay an external send whose acknowledgement was lost. Runs once per process under the worker lease.
  async function recover() {
    for (const { id } of await resultRows(db.execute(sql`SELECT id FROM direct_deliveries WHERE data->>'status' = 'sending' ORDER BY seq`))) await changeDelivery(id, delivery => { if (delivery.status !== 'sending') return false; delivery.status = 'uncertain'; delivery.error = 'The server stopped before the send was confirmed. Check the provider before making another campaign.'; });
    for (const { data: campaign } of await resultRows(db.execute(sql`SELECT data FROM direct_campaigns ORDER BY seq`))) { if (campaign.phase === 'creating' || campaign.phase === 'adding' || campaign.phase === 'dispatching') { campaign.status = 'attention'; campaign.lastError = 'The server stopped during a WhatsApp request. Reconcile the broadcast with Zernio.'; await save(campaign); } else if (campaign.status === 'sending') await finish(campaign); }
  }
  let active = false, closed = false, recovered = false;
  // ponytail: one worker lease across processes sends one recipient per second; use a dedicated worker when throughput requires it.
  async function processPending({ now = Date.now(), limit = 1 } = {}) {
    if (active || closed) return;
    active = true;
    try {
      await db.transaction(async lease => {
        // Worker lease: only one process sends at a time, so two app instances cannot claim the same campaign and recovery never
        // quarantines another live worker's in-flight send. The lease holds no other lock; all work below runs on other connections.
        if (!(await resultRows(lease.execute(sql`SELECT pg_try_advisory_xact_lock(hashtextextended('direct-campaigns:worker', 0)) AS locked`)))[0].locked) return;
        if (!recovered) { await recover(); recovered = true; }
        await sendDue(now, limit);
      });
    } finally { active = false; }
  }
  // Cloudflare's suppression list (bounces, complaints) applied to this project's contacts. Refresh runs it, and so does the
  // worker before an email campaign's first send and every 15 minutes while it sends, so a new complaint stops later sends.
  // A row with an expiry holds the contact only until then and keeps its consent. Cloudflare does not define `policy`, so a
  // policy row may be a sender-side block: it raises a project deliverability alert instead of suppressing the recipient.
  async function applyEmailSuppressions(projectId: string, assertMapping: () => unknown) {
    const result = await syncEmailSuppressions({ env: { ...env }, assertMapping }), domain = env.CLOUDFLARE_EMAIL_FROM_ADDRESS.split('@')[1].toLowerCase();
    const suppressed = (result.suppressions || []).filter((row: any) => (!row.expiresAt || Date.parse(row.expiresAt) > Date.now()) && (row.scope?.type !== 'sending_domain' || row.scope.value.toLowerCase() === domain));
    const policy: { contactId: string; expiresAt: string | null }[] = [];
    for (const contact of await contacts.list(projectId)) {
      const match = suppressed.find((row: any) => row.email?.toLowerCase() === contact.email); if (!match) continue;
      const [outcome] = classifyEmailFeedback({ provider: 'cloudflare', email: match.email, reason: match.reason, expiresAt: match.expiresAt }, { transient: feedbackRules });
      if (outcome?.action === 'deliverability-alert') policy.push({ contactId: contact.id, expiresAt: match.expiresAt });
      else if (!['suppress', 'count-transient'].includes(outcome?.action)) continue;
      // Cloudflare refuses the address itself until the row expires, so an expiring row holds the contact until then.
      else if (match.expiresAt) await contacts.suppressUntil(projectId, contact.id, 'email', match.reason, match.expiresAt);
      else await contacts.suppress(projectId, contact.id, 'email', match.reason === 'hard_bounce' ? 'hard-bounce' : match.reason);
    }
    await db.transaction(async tx => {
      const seenAt = nowISO();
      for (const row of policy) await tx.execute(sql`INSERT INTO direct_deliverability_alerts VALUES (${projectId}, 'cloudflare', 'policy', ${row.contactId}, ${row.expiresAt}, ${seenAt}, ${seenAt}) ON CONFLICT (project_id, provider, kind, contact_id) DO UPDATE SET expires_at = excluded.expires_at, last_seen_at = excluded.last_seen_at`);
      await tx.execute(sql`DELETE FROM direct_deliverability_alerts WHERE project_id = ${projectId} AND provider = 'cloudflare' AND last_seen_at <> ${seenAt}`);
    });
  }
  // Open alerts, grouped by provider report, for the project's direct-messaging status.
  async function deliverabilityAlerts(projectId: string) {
    const rows = await resultRows(db.execute(sql`SELECT provider, kind, count(*)::int AS contacts, min(first_seen_at) AS "firstSeenAt", max(last_seen_at) AS "lastSeenAt", max(expires_at) AS "expiresAt", bool_or(expires_at IS NULL) AS permanent FROM direct_deliverability_alerts WHERE project_id = ${projectId} AND (expires_at IS NULL OR expires_at > ${nowISO()}) GROUP BY provider, kind ORDER BY provider, kind`));
    return rows.map((row: any) => ({ provider: row.provider, kind: row.kind, channel: 'email', contacts: row.contacts, firstSeenAt: row.firstSeenAt, lastSeenAt: row.lastSeenAt, expiresAt: row.permanent ? null : row.expiresAt }));
  }
  async function sendDue(now: number, limit: number) {
    const rows = (await resultRows(db.execute(sql`SELECT data FROM direct_campaigns WHERE data->>'status' IN ('scheduled', 'sending') ORDER BY seq`))).map(row => row.data).filter((campaign: any) => ['scheduled', 'sending'].includes(campaign.status) && Date.parse(campaign.scheduledAt) <= now);
    for (const campaign of rows.slice(0, Math.max(1, Math.min(25, limit)))) {
      try {
        const project = await guard(campaign), currentEnv = { ...env }, assertMapping = async () => { await guard(campaign); if (campaign.channel === 'whatsapp') { if ((await find(campaign.projectId, campaign.id)).status === 'cancelled') fail(409, 'CAMPAIGN_CANCELLED', 'This campaign was cancelled while its broadcast was being prepared.'); for (const delivery of (await deliveries(campaign.id)).filter((row: any) => row.status === 'pending')) { const contact: any = await contacts.get(campaign.projectId, delivery.contactId); if (exclusion(contact, 'whatsapp') || contact.phone !== delivery.recipient) fail(409, 'AUDIENCE_CHANGED', 'Recipient permission changed while preparing the broadcast.'); } } };
        campaign.status = 'sending'; await save(campaign);
        if (campaign.channel === 'whatsapp') {
          const pending = (await deliveries(campaign.id)).filter((row: any) => row.status === 'pending'), selected: any[] = [];
          for (const delivery of pending) { const contact: any = await contacts.get(campaign.projectId, delivery.contactId), reason = exclusion(contact, 'whatsapp'); if (reason || contact.phone !== delivery.recipient) await changeDelivery(delivery.id, current => { if (current.status !== 'pending') return false; current.status = 'suppressed'; current.error = reason || 'Contact address changed'; }); else selected.push(contact); }
          if (!selected.length) { await finish(campaign); continue; }
          if (!campaign.providerId) {
            campaign.phase = 'creating'; await save(campaign);
            const result = await createWhatsAppBroadcast({ env: currentEnv, project, campaign, idempotencyKey: campaign.id, assertMapping });
            campaign.providerId = result.providerId; campaign.phase = 'created'; await save(campaign);
          }
          campaign.phase = 'adding'; await save(campaign);
          const added = await addWhatsAppRecipients({ env: currentEnv, project, campaign, providerId: campaign.providerId, contacts: selected, idempotencyKey: campaign.id + '-recipients', assertMapping });
          if (added.added !== selected.length || added.skipped) fail(409, 'RECIPIENT_MISMATCH', 'Zernio did not accept the complete audience. Review the draft broadcast before sending.');
          // Consent can be revoked while recipients are uploaded; never dispatch that stale batch.
          for (const contact of selected) { const current = await contacts.get(campaign.projectId, contact.id); if (exclusion(current, 'whatsapp') || current?.phone !== contact.phone) fail(409, 'AUDIENCE_CHANGED', 'A recipient changed during preparation. Review the draft broadcast.'); }
          const prepared = await getWhatsAppBroadcast({ env: currentEnv, project, campaign, providerId: campaign.providerId, assertMapping }), expectedPhones = new Set(selected.map((contact: any) => contact.phone));
          if (prepared.status !== 'draft' || prepared.recipients?.length !== expectedPhones.size || prepared.recipients.some((recipient: any) => !expectedPhones.delete(recipient.phone)) || expectedPhones.size) fail(409, 'AUDIENCE_CHANGED', 'The provider broadcast audience differs from the approved local audience. Review it before sending.');
          for (const contact of selected) { const current = await contacts.get(campaign.projectId, contact.id); if (exclusion(current, 'whatsapp') || current?.phone !== contact.phone) fail(409, 'AUDIENCE_CHANGED', 'A recipient changed while the broadcast was being verified.'); }
          campaign.phase = 'dispatching'; await save(campaign);
          const result = await sendWhatsAppBroadcast({ env: currentEnv, project, campaign, providerId: campaign.providerId, expectedRecipientCount: selected.length, idempotencyKey: campaign.id + '-send', assertMapping });
          campaign.phase = 'dispatched'; campaign.providerStatus = result.status; campaign.stats = result.stats; await save(campaign);
          if (result.stats?.recipientCount !== selected.length || result.stats.sentCount + result.stats.failedCount > selected.length) fail(502, 'AUDIENCE_MISMATCH', 'Zernio reported a different audience size after sending. Check its broadcast receipt.');
          for (const delivery of pending) if (selected.some((contact: any) => contact.id === delivery.contactId)) { delivery.status = result.status === 'failed' ? 'failed' : 'accepted'; delivery.providerId = campaign.providerId; await putDelivery(delivery); }
          await finish(campaign);
        } else {
          // A failed sync leaves this tick's send waiting rather than sending past a fresh complaint.
          if (campaign.channel === 'email' && emailProvider(env) === 'cloudflare' && !(Date.parse(campaign.suppressionsSyncedAt) > Date.now() - 900000)) { await applyEmailSuppressions(campaign.projectId, assertMapping); campaign.suppressionsSyncedAt = new Date().toISOString(); await save(campaign); }
          const [delivery] = (await resultRows(db.execute(sql`SELECT data FROM direct_deliveries WHERE campaign_id = ${campaign.id} AND data->>'status' = 'pending' ORDER BY seq LIMIT 1`))).map(row => row.data);
          if (!delivery) { await finish(campaign); continue; }
          const contact: any = await contacts.get(campaign.projectId, delivery.contactId), reason = exclusion(contact, campaign.channel);
          if (reason || (campaign.channel === 'email' ? contact.email : contact.phone) !== delivery.recipient) { await changeDelivery(delivery.id, current => { if (current.status !== 'pending') return false; current.status = 'suppressed'; current.error = reason || 'Contact address changed'; }); await finish(campaign); continue; }
          const rendered = content(campaign, contact);
          if (campaign.channel === 'sms') Object.assign(delivery, { smsAccountSid: currentEnv.TWILIO_ACCOUNT_SID, smsSender: currentEnv.TWILIO_MESSAGING_SERVICE_SID ? '' : currentEnv.TWILIO_FROM_NUMBER, smsMessagingServiceSid: currentEnv.TWILIO_MESSAGING_SERVICE_SID || '', message: rendered.text });
          delivery.status = 'sending';
          // Claim: only a still-pending row moves to sending, so a cancellation that committed after the read above is never sent.
          if ((await changeDelivery(delivery.id, current => { if (current.status !== 'pending') return false; Object.assign(current, delivery); }))?.status !== 'sending') { await finish(campaign); continue; }
          try {
            const result: any = await sendDirect({ channel: campaign.channel, campaign: rendered, contact, delivery: { ...delivery, callbackUrl: `${appUrl}/api/webhooks/twilio/status/${delivery.id}` }, env: currentEnv, project, appUrl, unsubscribeUrl: `${appUrl}/api/direct/unsubscribe/${unsubscribeToken(campaign.projectId, contact.email)}`, assertMapping });
            const latest = await changeDelivery(delivery.id, latest => {
              if (latest.providerId && result.providerId !== latest.providerId || campaign.channel === 'sms' && latest.smsSender && result.sender && result.sender !== latest.smsSender) throw new IntegrationError(502, 'DELIVERY_MISMATCH', 'The provider acknowledgement conflicts with a delivery callback.', true);
              latest.providerId = result.providerId; latest.status = nextStatus(latest.status, result.status); if (campaign.channel === 'sms') { latest.smsSender = result.sender || latest.smsSender; latest.smsMessagingServiceSid = result.messagingServiceSid || latest.smsMessagingServiceSid; }
            });
            if (campaign.channel === 'sms') await recordSms(campaign, latest);
            if (campaign.channel === 'sms' && result.errorCode === '21610') await contacts.suppressSmsGlobally(delivery.recipient, 'Recipient opted out');
            if (result.suppressionReason) await contacts.suppressDestination(campaign.projectId, campaign.channel, delivery.recipient, result.suppressionReason);
          } catch (error: any) {
            if (campaign.channel === 'sms' && error.providerCode === 21610) await contacts.suppressSmsGlobally(delivery.recipient, 'Recipient opted out');
            const latest = await changeDelivery(delivery.id, latest => { if (latest.providerId) return false; latest.status = error.uncertain ? 'uncertain' : 'failed'; latest.error = error instanceof IntegrationError ? error.message : 'The provider did not confirm the message.'; });
            if (error.uncertain || error.status === 429 || error.code === 'EMAIL_SENDER_BLOCKED') { campaign.status = 'attention'; campaign.lastError = latest.error || 'Review the provider acknowledgement before continuing.'; }
          }
          await finish(campaign);
        }
      } catch (error: any) { campaign.status = 'attention'; campaign.lastError = error instanceof IntegrationError ? error.message : 'The campaign could not continue. Check its provider status.'; await save(campaign); }
    }
  }
  async function handle(context: any) {
    const { req, url, body, project, user, send } = context;
    const route = url.pathname.match(/^\/api\/projects\/[^/]+\/direct\/(status|templates|contacts|campaigns)(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if (!route) return false;
    const [, kind, id, action] = route, method = req.method;
    if (kind === 'status' && method === 'GET') { let accounts: any[] = [], accountError: any; if (env.ZERNIO_API_KEY && project.zernioProfileId) { try { accounts = await scopedAccounts(zernioClient(env.ZERNIO_API_KEY, () => context.assertProjectMapping(project.zernioProfileId)), project.zernioProfileId); } catch (error: any) { accountError = error instanceof IntegrationError ? error.message : 'WhatsApp accounts could not be loaded.'; } } send(200, { providers: Object.fromEntries(channels.map(channel => [channel, ready(channel) && (channel !== 'whatsapp' || Boolean(project.zernioProfileId && !accountError))])), accounts: accounts.filter(account => account.platform === 'whatsapp').map(account => ({ id: account._id || account.id, name: account.displayName || account.username || 'WhatsApp Business' })), accountError, emailPolicy: 'transactional_only', emailProvider: emailProvider(env), sesWebhookUrl: `${appUrl}/api/webhooks/ses/sns`, deliverabilityAlerts: await deliverabilityAlerts(project.id), callbackUrl: `${appUrl}/api/webhooks/twilio/inbound`, publicCallbacks: appUrl.startsWith('https://') }); return true; }
    if (kind === 'templates' && method === 'GET') { send(200, await listWhatsAppTemplates({ env: { ...env }, project, accountId: url.searchParams.get('accountId'), assertMapping: () => context.assertProjectMapping(project.zernioProfileId) })); return true; }
    if (kind === 'contacts') {
      if (!id && method === 'GET') send(200, { contacts: await contacts.list(project.id) });
      else if (!id && method === 'POST') send(201, { contact: await contacts.save(project.id, body) });
      else if (id === 'import' && method === 'POST') send(200, await contacts.import(project.id, body));
      else if (id === 'assess-dns' && method === 'POST') { const result = await contacts.assessDNS(project.id, body.ids, { assertAccess: context.assertIntegrationSettings }); await context.assertIntegrationSettings(); send(200, result); }
      else if (id && !action && method === 'PATCH') send(200, { contact: await contacts.save(project.id, body, id) });
      else if (id && !action && method === 'DELETE') { if (!await contacts.remove(project.id, id)) fail(404, 'CONTACT_NOT_FOUND', 'Contact not found.'); send(200, { removed: true }); }
      else if (id && action === 'suppress' && method === 'POST') send(200, { contact: await contacts.suppress(project.id, id, body.channel, body.reason) });
      else return false;
      return true;
    }
    if (kind !== 'campaigns') return false;
    if (!id && method === 'GET') { const campaigns = []; for (const campaign of await campaignRows(project.id)) campaigns.push(await decorate(campaign)); send(200, { campaigns }); return true; }
    if (!id && method === 'POST') { const timestamp = nowISO(), campaign = { ...validate(body), id: randomUUID(), projectId: project.id, status: 'draft', createdAt: timestamp, updatedAt: timestamp }; await db.execute(sql`INSERT INTO direct_campaigns (id, project_id, data) VALUES (${campaign.id}, ${project.id}, ${JSON.stringify(campaign)})`); send(201, { campaign: await decorate(campaign) }); return true; }
    const campaign = await find(project.id, id);
    if (!action && method === 'GET') { send(200, { campaign: await decorate(campaign), deliveries: await deliveries(id) }); return true; }
    if (!action && method === 'PATCH') {
      // Row lock: the draft check and the edit commit together, so a concurrent send cannot be reverted to an edited draft.
      const saved = await db.transaction(async tx => { const current = await find(project.id, id, tx, true); if (current.status !== 'draft') fail(409, 'CAMPAIGN_LOCKED', 'Only drafts can be edited. Create a new draft for another send.'); const fields = Object.fromEntries(['name', 'channel', 'subject', 'text', 'html', 'emailPurpose', 'accountId', 'templateName', 'templateLanguage', 'templateComponents', 'contactIds', 'tags'].map(key => [key, current[key]])); Object.assign(current, validate({ ...fields, ...body })); return save(current, tx); });
      send(200, { campaign: await decorate(saved) }); return true;
    }
    if (method !== 'POST') return false;
    if (action === 'preview') { if (campaign.channel === 'whatsapp') { const result = await listWhatsAppTemplates({ env: { ...env }, project, accountId: campaign.accountId, assertMapping: () => context.assertProjectMapping(project.zernioProfileId) }), approved = result.templates.find((template: any) => template.name === campaign.templateName && template.language === campaign.templateLanguage); if (!approved) fail(409, 'TEMPLATE_NOT_APPROVED', 'Choose a currently approved WhatsApp template.'); validateWhatsAppTemplate(campaign, approved); } send(200, await preview(campaign)); return true; }
    // A test send renders the draft for one recipient: the signed-in user's own email address, or one project contact with
    // recorded SMS consent. It creates no delivery and leaves the draft unchanged; its receipt keeps a retried key from
    // sending twice, and a project gets 10 per hour.
    if (action === 'test') {
      if (campaign.status !== 'draft') fail(409, 'CAMPAIGN_LOCKED', 'Send a test from a draft.');
      if (!['email', 'sms'].includes(campaign.channel)) fail(400, 'TEST_SEND_UNSUPPORTED', 'Test sends are available for email and SMS drafts.');
      if (!body || typeof body !== 'object' || Object.keys(body).some(key => !['confirmed', 'contactId'].includes(key))) fail(400, 'INVALID_TEST_SEND', 'Use only the fields shown in the test send form.');
      if (body.confirmed !== true) fail(400, 'SEND_CONFIRMATION_REQUIRED', 'Confirm the test send and its provider charge.');
      if (campaign.channel === 'email') requireEmailProvider(env);
      if (!ready(campaign.channel)) fail(409, 'INTEGRATION_NOT_CONFIGURED', 'Configure this sending provider in Integrations first.');
      if (!appUrl.startsWith('https://')) fail(409, 'PUBLIC_URL_REQUIRED', 'Set APP_URL to a public HTTPS address before sending.');
      let contact: any;
      if (campaign.channel === 'email') { if (body.contactId !== undefined) fail(400, 'INVALID_TEST_RECIPIENT', 'Email tests go to your own address.'); contact = { name: user.name, email: user.email }; }
      else { contact = typeof body.contactId === 'string' ? await contacts.get(project.id, body.contactId) : null; if (!contact || exclusion(contact, 'sms')) fail(400, 'INVALID_TEST_RECIPIENT', 'Choose one contact with recorded SMS consent.'); }
      const [recent] = await resultRows(db.execute(sql`SELECT count(*) AS count FROM integration_operations WHERE project_id = ${project.id} AND action_path LIKE 'POST %/test' AND created_at > ${new Date(Date.now() - 3600000).toISOString()}`));
      if (recent.count >= 10) fail(429, 'TEST_SEND_LIMIT', 'A project can send 10 tests per hour. Try again later.');
      const outcome = await operation(context, async () => {
        const result: any = await sendDirect({ channel: campaign.channel, campaign: content(campaign, contact), contact, env: { ...env }, project, appUrl, unsubscribeUrl: campaign.channel === 'email' ? `${appUrl}/api/direct/unsubscribe/${unsubscribeToken(project.id, contact.email)}` : undefined, assertMapping: () => context.assertIntegrationSettings() });
        return { test: { channel: campaign.channel, recipient: campaign.channel === 'email' ? contact.email : contact.phone, status: result.status, providerId: result.providerId } };
      });
      send(outcome.status, outcome.data); return true;
    }
    if (['send', 'schedule'].includes(action)) {
      if (campaign.status !== 'draft') { send(200, { campaign: await decorate(campaign), deliveries: await deliveries(id) }); return true; }
      if (body.confirmed !== true) fail(400, 'SEND_CONFIRMATION_REQUIRED', 'Review the audience and confirm provider charges before sending.');
      if (campaign.channel === 'email' && body.transactionalConfirmed !== true) fail(400, 'TRANSACTIONAL_CONFIRMATION_REQUIRED', 'Confirm this message is transactional and contains no marketing content.');
      if (campaign.channel === 'email') requireEmailProvider(env);
      if (!ready(campaign.channel)) fail(409, 'INTEGRATION_NOT_CONFIGURED', 'Configure this sending provider in Integrations first.');
      if (!appUrl.startsWith('https://')) fail(409, 'PUBLIC_URL_REQUIRED', 'Set APP_URL to a public HTTPS address before sending so unsubscribe links and delivery callbacks can work.');
      const scheduledAt = action === 'send' ? nowISO() : body.scheduledAt;
      if (typeof scheduledAt !== 'string' || !/^\d{4}-\d\d-\d\dT(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(scheduledAt) || !Number.isFinite(Date.parse(scheduledAt)) || new Date(scheduledAt.slice(0, 10)).toISOString().slice(0, 10) !== scheduledAt.slice(0, 10) || (action === 'schedule' && (Date.parse(scheduledAt) <= Date.now() || Date.parse(scheduledAt) > Date.now() + 366 * 86400000))) fail(400, 'INVALID_SCHEDULE', 'Choose a valid future time within the next year.');
      const selected = await audience(campaign);
      if (body.previewToken !== (await preview(campaign)).previewToken) fail(409, 'AUDIENCE_CHANGED', 'The campaign or audience changed. Review a fresh preview before confirming.');
      if (!selected.eligible.length || selected.eligible.length > 500) fail(400, 'AUDIENCE_LIMIT', 'Select between 1 and 500 eligible recipients per campaign.');
      if (campaign.channel === 'whatsapp') { const result = await listWhatsAppTemplates({ env: { ...env }, project, accountId: campaign.accountId, assertMapping: () => context.assertProjectMapping(project.zernioProfileId) }), approved = result.templates.find((template: any) => template.name === campaign.templateName && template.language === campaign.templateLanguage && template.status === 'APPROVED'); if (!approved) fail(409, 'TEMPLATE_NOT_APPROVED', 'Choose a currently approved WhatsApp template.'); validateWhatsAppTemplate(campaign, approved); }
      await context.assertIntegrationSettings();
      await db.transaction(async tx => {
        // Contact writes in this project wait until the queue commits, so the audience cannot change between the token check and the delivery rows.
        await lockContacts(tx, project.id);
        // Row lock: a double-submitted send or schedule queues the deliveries once.
        const fresh = await find(project.id, id, tx, true); if (fresh.status !== 'draft') return;
        if ((await preview(fresh, tx)).previewToken !== body.previewToken) fail(409, 'AUDIENCE_CHANGED', 'The campaign or audience changed during preparation. Review a fresh preview before confirming.');
        Object.assign(campaign, { status: 'scheduled', scheduledAt: new Date(scheduledAt).toISOString(), scheduledBy: user.id, profileId: project.zernioProfileId, credentialHash: fingerprint(env, campaign.channel), ...(campaign.channel === 'email' ? { emailProvider: emailProvider(env) } : {}), audienceCount: selected.eligible.length }); await save(campaign, tx);
        for (const contact of selected.eligible) { const delivery = { id: randomUUID(), campaignId: id, contactId: contact.id, recipient: campaign.channel === 'email' ? contact.email : contact.phone, status: 'pending', createdAt: nowISO() }; await tx.execute(sql`INSERT INTO direct_deliveries (id, campaign_id, contact_id, data) VALUES (${delivery.id}, ${id}, ${contact.id}, ${JSON.stringify(delivery)})`); }
        await createStore(tx).activity(project.id, `${campaign.channel === 'email' ? 'Transactional email' : campaign.channel.toUpperCase()} campaign scheduled for ${selected.eligible.length} recipients.`);
      });
      send(200, { campaign: await decorate(await find(project.id, id)), deliveries: await deliveries(id) }); return true;
    }
    if (action === 'cancel') {
      // Cancel the stored campaign under its row lock rather than the copy read at the start of this request.
      Object.assign(campaign, await changeCampaign(project.id, id, latest => { latest.status = 'cancelled'; }));
      for (const delivery of await deliveries(id)) if (delivery.status === 'pending') await changeDelivery(delivery.id, current => { if (current.status !== 'pending') return false; current.status = 'cancelled'; });
      if (campaign.channel === 'whatsapp' && campaign.providerId && campaign.providerStatus !== 'cancelled') {
        const assertMapping = async () => { await context.assertIntegrationSettings(); await guard(campaign, false); };
        try {
          await assertMapping(); const result = await cancelWhatsAppBroadcast({ env: { ...env }, project, campaign, providerId: campaign.providerId, idempotencyKey: campaign.id + '-cancel', assertMapping });
          await changeCampaign(project.id, id, latest => { latest.providerStatus = result.status; delete latest.lastError; });
        } catch (error: any) {
          await changeCampaign(project.id, id, latest => { latest.lastError = error instanceof IntegrationError ? error.message : 'Local sending stopped. Provider cancellation was not confirmed; check Zernio.'; });
        }
      }
      await context.assertIntegrationSettings(); send(200, { campaign: await decorate(await find(project.id, id)), deliveries: await deliveries(id) }); return true;
    }
    if (action === 'refresh') {
      const assertMapping = async () => { await context.assertIntegrationSettings(); await guard(campaign, false); };
      if (campaign.channel === 'whatsapp' && campaign.providerId) {
        await assertMapping(); const result = await getWhatsAppBroadcast({ env: { ...env }, project, campaign, providerId: campaign.providerId, assertMapping });
        // Preserve worker/cancellation progress and receipts written while this provider read was in flight.
        await changeCampaign(project.id, id, latest => { if (latest.providerStatus !== campaign.providerStatus || JSON.stringify(latest.stats) !== JSON.stringify(campaign.stats)) return false; latest.providerStatus = result.status; latest.stats = result.stats; });
        for (const delivery of await deliveries(id)) { const remote = result.recipients?.find((recipient: any) => recipient.phone === delivery.recipient || recipient.phone === delivery.recipient.replace(/^\+/, '')); if (remote) await changeDelivery(delivery.id, current => { current.status = nextStatus(current.status, remote.status); }); }
      }
      if (campaign.channel === 'sms' && (await deliveries(id)).some((row: any) => row.providerId)) {
        await assertMapping();
        for (const delivery of (await deliveries(id)).filter((row: any) => row.providerId && !terminal.has(row.status)).slice(0, 25)) {
          const result = await getSmsStatus({ env: { ...env }, providerId: delivery.providerId, assertMapping }); if (result.recipient !== delivery.recipient) fail(502, 'DELIVERY_MISMATCH', 'The provider returned another recipient.');
          const latest = await changeDelivery(delivery.id, latest => { if (result.sender && latest.smsSender && result.sender !== latest.smsSender || result.messagingServiceSid && result.messagingServiceSid !== (latest.smsMessagingServiceSid || '')) fail(502, 'DELIVERY_MISMATCH', 'The provider returned another sending number or messaging service.'); latest.status = nextStatus(latest.status, result.status); if (result.errorCode) latest.errorCode = result.errorCode; if (result.sender) Object.assign(latest, { smsSender: result.sender, smsAccountSid: env.TWILIO_ACCOUNT_SID, smsMessagingServiceSid: result.messagingServiceSid || latest.smsMessagingServiceSid || '' }); });
          await recordSms(campaign, latest); if (result.errorCode === '21610') await contacts.suppressSmsGlobally(delivery.recipient, 'Recipient opted out');
        }
      }
      if (campaign.channel === 'email' && ready('email') && emailProvider(env) === 'cloudflare') await applyEmailSuppressions(project.id, () => context.assertIntegrationSettings());
      await context.assertIntegrationSettings(); await finishLatest(project.id, id); send(200, { campaign: await decorate(await find(project.id, id)), deliveries: await deliveries(id) }); return true;
    }
    return false;
  }
  // SNS signing certificates, cached by URL. The runtime verifier only asks for URLs on the regional SNS origin.
  const certificates = new Map<string, string>();
  async function snsCertificate(url: string) {
    const cached = certificates.get(url); if (cached) return cached;
    const signal = AbortSignal.timeout(10000), response = await fetch(url, { redirect: 'error', credentials: 'omit', signal });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error('certificate'); }
    const pem = await readResponseText(response, { maxBytes: 16384, signal });
    if (certificates.size >= 20) certificates.clear(); certificates.set(url, pem); return pem;
  }
  // Amazon SES feedback through an SNS HTTPS subscription. Only a verified message for the configured topic does anything,
  // and every refusal gets the same empty 400. Returns the HTTP status; a 500 asks SNS to redeliver.
  async function receiveSes(rawBody: Buffer): Promise<number> {
    const topic = env.AWS_SES_SNS_TOPIC_ARN, region = env.AWS_SES_REGION;
    if (emailProvider(env) !== 'ses' || !topic || topic.split(':')[3] !== region) return 503;
    let body: string; try { body = new TextDecoder('utf-8', { fatal: true }).decode(rawBody); } catch { return 400; }
    const claimed = async (id: string) => Boolean((await db.execute(sql`SELECT 1 FROM ses_notification_receipts WHERE topic_arn = ${topic} AND message_id = ${id}`)).rowCount);
    const verified = await verifySnsMessage(body, { allowedRegions: [region], topicArns: [topic], fetchCertificate: snsCertificate, isDuplicate: claimed });
    if (!verified.ok) return 400;
    if (verified.duplicate || !(await db.execute(sql`INSERT INTO ses_notification_receipts VALUES (${topic}, ${verified.messageId}, ${nowISO()}) ON CONFLICT DO NOTHING`)).rowCount) return 200;
    try {
      if (verified.type === 'SubscriptionConfirmation') {
        const response = await fetch(verified.subscribeUrl!, { redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(10000) });
        await response.body?.cancel().catch(() => {}); if (!response.ok) throw new Error('subscription');
      } else if (verified.type === 'Notification') await applySesFeedback(verified.message);
      return 200;
    } catch {
      // Release the claim so SNS's redelivery is processed.
      await db.execute(sql`DELETE FROM ses_notification_receipts WHERE topic_arn = ${topic} AND message_id = ${verified.messageId}`);
      return 500;
    }
  }
  // One SES Bounce, Complaint or Delivery record for a direct campaign delivery, classified by the shared runtime mapper.
  // Feedback for mail Campaign did not send through a campaign (no delivery has that SES message ID) is ignored.
  async function applySesFeedback(message: any) {
    const messageId = message?.mail?.messageId;
    if (typeof messageId !== 'string' || !messageId) return;
    const [row] = await resultRows(db.execute(sql`SELECT d.data AS delivery, c.project_id FROM direct_deliveries d JOIN direct_campaigns c ON c.id = d.campaign_id WHERE d.data->>'providerId' = ${messageId} AND c.data->>'channel' = 'email' LIMIT 1`));
    if (!row) return;
    const delivery = row.delivery, projectId: string = row.project_id, recipient = String(delivery.recipient).toLowerCase(), target = recipientHash(recipient);
    const occurred = Date.parse(message.bounce?.timestamp || message.complaint?.timestamp || message.delivery?.timestamp || message.mail?.timestamp), at = new Date(Number.isFinite(occurred) ? occurred : Date.now()).toISOString();
    const earlier = (await resultRows(db.execute(sql`SELECT occurred_at FROM direct_email_feedback WHERE project_id = ${projectId} AND target_hash = ${target} AND occurred_at >= ${new Date(Date.parse(at) - feedbackRules.windowMs).toISOString()}`))).map(item => Date.parse(item.occurred_at));
    const eventId = String(message.bounce?.feedbackId || message.complaint?.feedbackId || messageId);
    for (const outcome of classifyEmailFeedback(message, { transient: feedbackRules, history: () => earlier })) {
      if (outcome.recipient.toLowerCase() !== recipient) continue;
      // Each provider event counts once toward the transient threshold, however often SNS delivers it.
      if (['count-transient', 'flag-undetermined'].includes(outcome.action) || outcome.reason === 'repeated-transient') {
        const counted = await db.execute(sql`INSERT INTO direct_email_feedback VALUES (${projectId}, 'ses', ${eventId}, ${target}, ${message.bounce?.bounceType === 'Undetermined' ? 'undetermined' : 'transient'}, ${outcome.subType ?? null}, ${at}) ON CONFLICT DO NOTHING`);
        if (!counted.rowCount) continue;
      }
      if (outcome.action === 'suppress') await contacts.suppressDestination(projectId, 'email', recipient, SES_SUPPRESSION_REASONS[outcome.reason] || outcome.reason);
      if (outcome.action === 'record' && outcome.reason === 'unsubscribed-recipient') await contacts.suppressDestination(projectId, 'email', recipient, 'Unsubscribed');
      if (['deliverability-alert', 'flag-undetermined'].includes(outcome.action)) {
        // SES alerts lapse a week after the latest report; Cloudflare's are replaced by each suppression sync.
        const expires = new Date(Date.parse(at) + feedbackRules.windowMs).toISOString(), kind = outcome.action === 'flag-undetermined' ? 'undetermined' : 'policy';
        await db.execute(sql`INSERT INTO direct_deliverability_alerts SELECT ${projectId}, 'ses', ${kind}, id, ${expires}, ${at}, ${at} FROM direct_contacts WHERE id = ${delivery.contactId} AND project_id = ${projectId} ON CONFLICT (project_id, provider, kind, contact_id) DO UPDATE SET expires_at = excluded.expires_at, last_seen_at = excluded.last_seen_at`);
      }
      const status = outcome.action === 'delivered' ? 'delivered' : outcome.action === 'record' && outcome.reason === 'provider-suppressed' ? 'suppressed' : message.bounce ? 'failed' : '';
      if (status) await changeDelivery(delivery.id, current => { const next = nextStatus(current.status, status); if (next === current.status) return false; current.status = next; });
    }
  }
  async function receiveTwilio({ rawBody, headers, url }: { rawBody: any; headers: any; url: URL }) {
    if (!env.TWILIO_AUTH_TOKEN || !env.TWILIO_ACCOUNT_SID) fail(503, 'WEBHOOK_NOT_CONFIGURED', 'Twilio is not configured.');
    if (!(headers['content-type'] || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) fail(415, 'INVALID_WEBHOOK', 'Twilio form content is required.');
    let form: URLSearchParams; try { form = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)); } catch { fail(400, 'INVALID_WEBHOOK', 'Twilio form content must use UTF-8.'); } const keys = [...form.keys()];
    if (new Set(keys).size !== keys.length || keys.length > 100 || headers['x-twilio-webhooks-signature-settings']) fail(400, 'INVALID_WEBHOOK', 'Use the standard Twilio Auth Token signature.');
    const signed = appUrl + url.pathname + url.search + keys.sort().map(key => key + form.get(key)).join(''), expected = createHmac('sha1', env.TWILIO_AUTH_TOKEN).update(signed).digest('base64'), signature = headers['x-twilio-signature'];
    if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{27}=$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) fail(401, 'INVALID_SIGNATURE', 'The Twilio signature is invalid.');
    if (form.get('AccountSid') !== env.TWILIO_ACCOUNT_SID) fail(400, 'ACCOUNT_MISMATCH', 'The webhook belongs to another account.');
    const id = url.pathname.match(/^\/api\/webhooks\/twilio\/status\/([\w-]+)$/)?.[1];
    if (id) {
      const [row] = await resultRows(db.execute(sql`SELECT d.data, c.project_id FROM direct_deliveries d JOIN direct_campaigns c ON c.id = d.campaign_id WHERE d.id = ${id}`));
      if (!row) { if (await smsInbox?.receiveStatus(form, id)) return { accepted: true }; fail(404, 'DELIVERY_NOT_FOUND', 'Delivery not found.'); }
      const campaign = await find(row.project_id, row.data.campaignId), providerId = form.get('MessageSid'), status = form.get('MessageStatus') === 'canceled' ? 'cancelled' : form.get('MessageStatus') as string;
      const delivery = await changeDelivery(id, delivery => {
        if (campaign.channel !== 'sms' || !/^(SM|MM)[a-f0-9]{32}$/i.test(providerId || '') || (delivery.providerId && providerId !== delivery.providerId) || form.get('To') !== delivery.recipient || !statuses.includes(status) || form.get('From') && delivery.smsSender && form.get('From') !== delivery.smsSender || form.get('MessagingServiceSid') && delivery.smsMessagingServiceSid && form.get('MessagingServiceSid') !== delivery.smsMessagingServiceSid) fail(400, 'DELIVERY_MISMATCH', 'The callback does not match this delivery.');
        if (/^\+[1-9]\d{6,14}$/.test(form.get('From') || '')) { delivery.smsSender = form.get('From'); delivery.smsAccountSid = form.get('AccountSid'); if (/^MG[a-f0-9]{32}$/i.test(form.get('MessagingServiceSid') || '')) delivery.smsMessagingServiceSid = form.get('MessagingServiceSid'); }
        delivery.providerId = providerId; delivery.status = nextStatus(delivery.status, status); if (form.get('ErrorCode')) delivery.errorCode = form.get('ErrorCode')!.slice(0, 20);
      });
      if (!delivery) fail(404, 'DELIVERY_NOT_FOUND', 'Delivery not found.');
      await finishLatest(row.project_id, campaign.id);
      await recordSms(campaign, delivery);
      if (form.get('ErrorCode') === '21610') await contacts.suppressSmsGlobally(delivery.recipient, 'Recipient opted out');
    } else if (/^\/api\/webhooks\/twilio\/inbound(?:\/[\w-]+)?$/.test(url.pathname)) {
      if (form.get('To') !== env.TWILIO_FROM_NUMBER && !(env.TWILIO_MESSAGING_SERVICE_SID && form.get('MessagingServiceSid') === env.TWILIO_MESSAGING_SERVICE_SID)) fail(400, 'SENDER_MISMATCH', 'The callback is for another sender.');
      if (smsInbox) return await smsInbox.receiveVerified(form, { projectId: url.pathname.split('/')[5] || undefined });
      if (form.get('OptOutType') === 'STOP' || /^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|REVOKE|OPT OUT)$/i.test((form.get('Body') || '').trim())) {
        await contacts.suppressSmsGlobally(form.get('From')!, 'Recipient opted out');
      } else if (smsStarted(form)) await contacts.liftSmsOptOut(form.get('From')!);
    } else fail(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found.');
    return { accepted: true };
  }
  async function handleUnsubscribe(token: any, method: string) { const [projectId, email] = unsubscribe(token); if (method === 'POST' && await projectFor(projectId)) await contacts.suppressDestination(projectId, 'email', email, 'Unsubscribed'); return method === 'POST' ? '<h1>Preferences updated</h1><p>This address will receive no further email campaigns from this project.</p>' : '<h1>Email preferences</h1><form method="post"><button type="submit">Stop email from this project</button></form>'; }
  async function backfillSms() {
    for (const { data: campaign } of await resultRows(db.execute(sql`SELECT data FROM direct_campaigns ORDER BY seq`))) { if (campaign.channel !== 'sms') continue; for (const delivery of await deliveries(campaign.id)) { if (!delivery.smsAccountSid && campaign.credentialHash === fingerprint(env, 'sms') && !env.TWILIO_MESSAGING_SERVICE_SID) Object.assign(delivery, { smsAccountSid: env.TWILIO_ACCOUNT_SID, smsSender: env.TWILIO_FROM_NUMBER }); await recordSms(campaign, delivery); } }
  }
  return { handle, contacts, processPending, receiveTwilio, receiveSes, handleUnsubscribe,
    /** Attaches the inbox at once; the returned promise records existing campaign SMS in it. Await it before serving requests. */
    attachSmsInbox(service: any) { smsInbox = service; return attaching = backfillSms(); },
    close() { closed = true; },
    async idle() { await attaching?.catch(() => undefined); while (active) await new Promise(resolve => setTimeout(resolve, 10)); } };
}

export { nextStatus as nextDeliveryStatus };
