import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { transaction } from './database.mjs';
import { IntegrationError, scopedAccounts, zernioClient } from './integrations.mjs';
import { createContacts } from './contacts.mjs';
import { sendDirect, listWhatsAppTemplates, validateWhatsAppTemplate, createWhatsAppBroadcast, addWhatsAppRecipients, sendWhatsAppBroadcast, getWhatsAppBroadcast, cancelWhatsAppBroadcast, getSmsStatus, syncEmailSuppressions } from './direct-providers.mjs';

const channels = ['email', 'sms', 'whatsapp'];
const fail = (status, code, message) => { throw new IntegrationError(status, code, message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const nowISO = () => new Date().toISOString();
const escape = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const text = (value, label, maximum, optional = false) => {
  if (optional && (value === undefined || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(400, 'INVALID_CAMPAIGN', `Enter ${label} of at most ${maximum} characters.`);
  return value.trim();
};
const list = (value, label, maximum = 500) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) fail(400, 'INVALID_CAMPAIGN', `${label} must contain at most ${maximum} entries.`);
  return [...new Set(value.map(item => text(item, label, 120)))];
};
const gsm = new Set(Array.from('@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà'));
const extension = new Set(Array.from('\f^{}\\[~]|€'));
export function estimateSms(value) {
  const isGsm = Array.from(value).every(character => gsm.has(character) || extension.has(character));
  const units = isGsm ? Array.from(value).reduce((sum, character) => sum + (extension.has(character) ? 2 : 1), 0) : value.length;
  return { encoding: isGsm ? 'GSM-7' : 'UCS-2', units, segments: Math.max(1, Math.ceil(units / (units <= (isGsm ? 160 : 70) ? (isGsm ? 160 : 70) : (isGsm ? 153 : 67)))) };
}
function render(value, contact, html = false) {
  return value.replace(/\{\{(name|email|phone|company)\}\}/g, (_, key) => html ? escape(contact[key] || '') : contact[key] || '');
}
function content(campaign, contact) {
  return { ...campaign, subject: render(campaign.subject, contact), text: render(campaign.text, contact) + (campaign.channel === 'sms' ? '\nReply STOP to unsubscribe.' : ''), html: render(campaign.html, contact, true) };
}
function validate(raw) {
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
function exclusion(contact, channel) {
  if (!contact) return 'Contact no longer exists';
  if (!contact.consents?.[channel]) return 'No recorded consent';
  if (contact.suppression?.[channel]) return `Suppressed: ${contact.suppression[channel].reason}`;
  if (!(channel === 'email' ? contact.email : contact.phone)) return channel === 'email' ? 'No email address' : 'No E.164 phone number';
  if (channel === 'email' && contact.hygiene?.disposable) return 'Disposable email address';
  if (channel === 'email' && ['no_mx', 'null_mx', 'nxdomain'].includes(contact.hygiene?.dnsStatus)) return 'Email domain cannot receive mail';
  return '';
}
const credentialFields = { email: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_EMAIL_API_TOKEN', 'CLOUDFLARE_EMAIL_FROM_ADDRESS', 'CLOUDFLARE_EMAIL_FROM_NAME', 'CLOUDFLARE_EMAIL_REPLY_TO_ADDRESS'], sms: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER', 'TWILIO_MESSAGING_SERVICE_SID'], whatsapp: ['ZERNIO_API_KEY'] };
const fingerprint = (env, channel) => createHash('sha256').update(JSON.stringify(credentialFields[channel].map(key => env[key] || ''))).digest('hex');
const statuses = ['pending', 'sending', 'accepted', 'queued', 'sent', 'delivered', 'read', 'failed', 'undelivered', 'suppressed', 'cancelled', 'uncertain'];
const terminal = new Set(['delivered', 'read', 'failed', 'undelivered', 'suppressed', 'cancelled', 'uncertain']);
function nextStatus(previous, incoming) {
  if (!statuses.includes(incoming)) return previous;
  if (terminal.has(previous) && !(previous === 'delivered' && incoming === 'read') && previous !== 'uncertain') return previous;
  const rank = { pending: 0, sending: 1, accepted: 2, queued: 3, sent: 4, delivered: 5, read: 6 };
  return (rank[incoming] ?? 99) >= (rank[previous] ?? 0) ? incoming : previous;
}

export function createDirectCampaigns({ db, env, appUrl, secret, store }) {
  const contacts = createContacts({ db });
  let smsInbox;
  db.exec(`CREATE TABLE IF NOT EXISTS direct_campaigns(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS direct_campaigns_project ON direct_campaigns(project_id);
    CREATE TABLE IF NOT EXISTS direct_deliveries(id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL REFERENCES direct_campaigns(id) ON DELETE CASCADE,contact_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(campaign_id,contact_id));`);
  const campaignRows = projectId => db.prepare('SELECT data FROM direct_campaigns WHERE project_id=? ORDER BY rowid DESC').all(projectId).map(row => JSON.parse(row.data));
  const find = (projectId, id) => { const row = db.prepare('SELECT data FROM direct_campaigns WHERE project_id=? AND id=?').get(projectId, id); if (!row) fail(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found.'); return JSON.parse(row.data); };
  const save = campaign => {
    const row = db.prepare('SELECT data FROM direct_campaigns WHERE id=?').get(campaign.id), current = row && JSON.parse(row.data);
    if (current?.status === 'cancelled') { campaign.status = 'cancelled'; if (current.providerStatus === 'cancelled') campaign.providerStatus = 'cancelled'; }
    campaign.updatedAt = nowISO(); db.prepare('UPDATE direct_campaigns SET data=? WHERE id=? AND project_id=?').run(JSON.stringify(campaign), campaign.id, campaign.projectId); return campaign;
  };
  const deliveries = id => db.prepare('SELECT data FROM direct_deliveries WHERE campaign_id=? ORDER BY rowid').all(id).map(row => JSON.parse(row.data));
  const putDelivery = delivery => { delivery.updatedAt = nowISO(); db.prepare('UPDATE direct_deliveries SET data=? WHERE id=?').run(JSON.stringify(delivery), delivery.id); return delivery; };
  const recordSms = (campaign, delivery) => smsInbox?.recordOutbound({ id: delivery.id, projectId: campaign.projectId, campaignId: campaign.id, accountSid: delivery.smsAccountSid, sender: delivery.smsSender, recipient: delivery.recipient, messagingServiceSid: delivery.smsMessagingServiceSid || '', providerId: delivery.providerId, message: delivery.message || '', status: delivery.status });
  function decorate(campaign) {
    const counts = { pending: 0, accepted: 0, delivered: 0, failed: 0, suppressed: 0, uncertain: 0 };
    for (const delivery of deliveries(campaign.id)) counts[['pending', 'sending'].includes(delivery.status) ? 'pending' : ['delivered', 'read'].includes(delivery.status) ? 'delivered' : ['failed', 'undelivered'].includes(delivery.status) ? 'failed' : ['suppressed', 'cancelled'].includes(delivery.status) ? 'suppressed' : delivery.status === 'uncertain' ? 'uncertain' : 'accepted']++;
    const { credentialHash, scheduledBy, ...publicCampaign } = campaign;
    return { ...publicCampaign, counts };
  }
  function audience(campaign) {
    const all = contacts.list(campaign.projectId).filter(contact => (!campaign.contactIds.length || campaign.contactIds.includes(contact.id)) && (!campaign.tags.length || campaign.tags.some(tag => contact.tags.includes(tag))));
    const eligible = [], exclusions = [];
    for (const contact of all) { const reason = exclusion(contact, campaign.channel); if (reason) exclusions.push({ id: contact.id, name: contact.name || contact.email || contact.phone, reason }); else eligible.push(contact); }
    if (campaign.contactIds.some(id => !contacts.get(campaign.projectId, id))) fail(400, 'CONTACT_NOT_FOUND', 'A selected contact does not belong to this project.');
    return { eligible, exclusions, total: all.length };
  }
  function preview(campaign) {
    const selected = audience(campaign), sample = content(campaign, selected.eligible[0] || { name: 'Recipient', email: 'recipient@example.com', phone: '+12025550123', company: 'Company' });
    for (const contact of selected.eligible) { const rendered = content(campaign, contact); if (campaign.channel === 'sms' && rendered.text.length > 1600 || campaign.channel === 'email' && (rendered.subject.length > 998 || rendered.text.length > 99000 || rendered.html.length > 490000)) fail(400, 'PERSONALIZATION_TOO_LONG', 'Personalization makes a message too long. Shorten the content and check the audience again.'); }
    return { campaign: decorate(campaign), previewToken: createHash('sha256').update(JSON.stringify([campaign, selected.eligible])).digest('hex'), audience: { eligible: selected.eligible.length, excluded: selected.exclusions.length, total: selected.total, exclusions: selected.exclusions, unverified: selected.eligible.filter(contact => campaign.channel === 'email' && !['mx', 'implicit_mx'].includes(contact.hygiene?.dnsStatus)).length }, sample: { subject: sample.subject, text: sample.text, html: sample.html }, ...(campaign.channel === 'sms' ? { sms: { ...estimateSms(sample.text), totalSegments: selected.eligible.reduce((sum, contact) => sum + estimateSms(content(campaign, contact).text).segments, 0), estimate: true } } : {}) };
  }
  const projectFor = id => db.prepare('SELECT id,zernio_profile_id AS zernioProfileId FROM projects WHERE id=?').get(id);
  function guard(campaign, requireAuthor = true) {
    if (fingerprint(env, campaign.channel) !== campaign.credentialHash) fail(409, 'CONNECTION_CHANGED', 'Integration settings changed. Cancel this campaign and create a new draft after reviewing the connection.');
    const project = projectFor(campaign.projectId);
    if (!project || (campaign.channel === 'whatsapp' && project.zernioProfileId !== campaign.profileId)) fail(409, 'CONNECTION_CHANGED', 'The project provider mapping changed.');
    if (requireAuthor && !db.prepare("SELECT m.role FROM memberships m JOIN projects p ON p.workspace_id=m.workspace_id WHERE p.id=? AND m.user_id=? AND m.role IN ('owner','admin','editor')").get(campaign.projectId, campaign.scheduledBy)) fail(409, 'ACCESS_CHANGED', 'The campaign author no longer has permission to send.');
    return project;
  }
  function ready(channel) { return channel === 'email' ? Boolean(env.CLOUDFLARE_ACCOUNT_ID && env.CLOUDFLARE_EMAIL_API_TOKEN && env.CLOUDFLARE_EMAIL_FROM_ADDRESS) : channel === 'sms' ? Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_FROM_NUMBER || env.TWILIO_MESSAGING_SERVICE_SID)) : Boolean(env.ZERNIO_API_KEY); }
  function unsubscribeToken(projectId, email) { const value = Buffer.from(JSON.stringify([projectId, email])).toString('base64url'); return `${value}.${createHmac('sha256', secret).update(`direct-unsubscribe:${value}`).digest('base64url')}`; }
  function unsubscribe(token) {
    if (typeof token !== 'string' || token.length > 1000) fail(400, 'INVALID_LINK', 'The preference link is invalid.');
    const [value, signature, extra] = token.split('.'), expected = createHmac('sha256', secret).update(`direct-unsubscribe:${value}`).digest('base64url');
    if (extra || typeof signature !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) fail(400, 'INVALID_LINK', 'The preference link is invalid.');
    let ids; try { ids = JSON.parse(Buffer.from(value, 'base64url').toString()); } catch { fail(400, 'INVALID_LINK', 'The preference link is invalid.'); }
    if (!Array.isArray(ids) || ids.length !== 2 || !ids.every(id => typeof id === 'string')) fail(400, 'INVALID_LINK', 'The preference link is invalid.');
    return ids;
  }
  function finish(campaign) {
    const rows = deliveries(campaign.id);
    if (!rows.length || ['draft', 'cancelled'].includes(campaign.status)) return save(campaign);
    if (rows.some(row => row.status === 'uncertain')) campaign.status = 'attention';
    else if (!rows.some(row => ['pending', 'sending'].includes(row.status))) campaign.status = 'completed';
    return save(campaign);
  }
  // A process crash must never replay an external send whose acknowledgement was lost.
  for (const row of db.prepare('SELECT data FROM direct_deliveries').all()) { const delivery = JSON.parse(row.data); if (delivery.status === 'sending') { delivery.status = 'uncertain'; delivery.error = 'The server stopped before the send was confirmed. Check the provider before making another campaign.'; putDelivery(delivery); } }
  for (const row of db.prepare('SELECT data FROM direct_campaigns').all()) { const campaign = JSON.parse(row.data); if (campaign.phase === 'creating' || campaign.phase === 'adding' || campaign.phase === 'dispatching') { campaign.status = 'attention'; campaign.lastError = 'The server stopped during a WhatsApp request. Reconcile the broadcast with Zernio.'; save(campaign); } else if (campaign.status === 'sending') finish(campaign); }
  let active = false, closed = false;
  // ponytail: one SQLite process sends one recipient per second; use a dedicated worker when throughput requires it.
  async function processPending({ now = Date.now(), limit = 1 } = {}) {
    if (active || closed) return;
    active = true;
    try {
      const rows = db.prepare('SELECT data FROM direct_campaigns ORDER BY rowid').all().map(row => JSON.parse(row.data)).filter(campaign => ['scheduled', 'sending'].includes(campaign.status) && Date.parse(campaign.scheduledAt) <= now);
      for (const campaign of rows.slice(0, Math.max(1, Math.min(25, limit)))) {
        try {
          const project = guard(campaign), currentEnv = { ...env }, assertMapping = () => { guard(campaign); if (campaign.channel === 'whatsapp') { if (find(campaign.projectId, campaign.id).status === 'cancelled') fail(409, 'CAMPAIGN_CANCELLED', 'This campaign was cancelled while its broadcast was being prepared.'); for (const delivery of deliveries(campaign.id).filter(row => row.status === 'pending')) { const contact = contacts.get(campaign.projectId, delivery.contactId); if (exclusion(contact, 'whatsapp') || contact.phone !== delivery.recipient) fail(409, 'AUDIENCE_CHANGED', 'Recipient permission changed while preparing the broadcast.'); } } };
          campaign.status = 'sending'; save(campaign);
          if (campaign.channel === 'whatsapp') {
            const pending = deliveries(campaign.id).filter(row => row.status === 'pending'), selected = [];
            for (const delivery of pending) { const contact = contacts.get(campaign.projectId, delivery.contactId), reason = exclusion(contact, 'whatsapp'); if (reason || contact.phone !== delivery.recipient) { delivery.status = 'suppressed'; delivery.error = reason || 'Contact address changed'; putDelivery(delivery); } else selected.push(contact); }
            if (!selected.length) { finish(campaign); continue; }
            if (!campaign.providerId) {
              campaign.phase = 'creating'; save(campaign);
              const result = await createWhatsAppBroadcast({ env: currentEnv, project, campaign, idempotencyKey: campaign.id, assertMapping });
              campaign.providerId = result.providerId; campaign.phase = 'created'; save(campaign);
            }
            campaign.phase = 'adding'; save(campaign);
            const added = await addWhatsAppRecipients({ env: currentEnv, project, campaign, providerId: campaign.providerId, contacts: selected, idempotencyKey: campaign.id + '-recipients', assertMapping });
            if (added.added !== selected.length || added.skipped) fail(409, 'RECIPIENT_MISMATCH', 'Zernio did not accept the complete audience. Review the draft broadcast before sending.');
            // Consent can be revoked while recipients are uploaded; never dispatch that stale batch.
            for (const contact of selected) if (exclusion(contacts.get(campaign.projectId, contact.id), 'whatsapp') || contacts.get(campaign.projectId, contact.id)?.phone !== contact.phone) fail(409, 'AUDIENCE_CHANGED', 'A recipient changed during preparation. Review the draft broadcast.');
            const prepared = await getWhatsAppBroadcast({ env: currentEnv, project, campaign, providerId: campaign.providerId, assertMapping }), expectedPhones = new Set(selected.map(contact => contact.phone));
            if (prepared.status !== 'draft' || prepared.recipients?.length !== expectedPhones.size || prepared.recipients.some(recipient => !expectedPhones.delete(recipient.phone)) || expectedPhones.size) fail(409, 'AUDIENCE_CHANGED', 'The provider broadcast audience differs from the approved local audience. Review it before sending.');
            for (const contact of selected) if (exclusion(contacts.get(campaign.projectId, contact.id), 'whatsapp') || contacts.get(campaign.projectId, contact.id)?.phone !== contact.phone) fail(409, 'AUDIENCE_CHANGED', 'A recipient changed while the broadcast was being verified.');
            campaign.phase = 'dispatching'; save(campaign);
            const result = await sendWhatsAppBroadcast({ env: currentEnv, project, campaign, providerId: campaign.providerId, expectedRecipientCount: selected.length, idempotencyKey: campaign.id + '-send', assertMapping });
            campaign.phase = 'dispatched'; campaign.providerStatus = result.status; campaign.stats = result.stats; save(campaign);
            if (result.stats?.recipientCount !== selected.length || result.stats.sentCount + result.stats.failedCount > selected.length) fail(502, 'AUDIENCE_MISMATCH', 'Zernio reported a different audience size after sending. Check its broadcast receipt.');
            for (const delivery of pending) if (selected.some(contact => contact.id === delivery.contactId)) { delivery.status = result.status === 'failed' ? 'failed' : 'accepted'; delivery.providerId = campaign.providerId; putDelivery(delivery); }
            finish(campaign);
          } else {
            const delivery = deliveries(campaign.id).find(row => row.status === 'pending');
            if (!delivery) { finish(campaign); continue; }
            const contact = contacts.get(campaign.projectId, delivery.contactId), reason = exclusion(contact, campaign.channel);
            if (reason || (campaign.channel === 'email' ? contact.email : contact.phone) !== delivery.recipient) { delivery.status = 'suppressed'; delivery.error = reason || 'Contact address changed'; putDelivery(delivery); finish(campaign); continue; }
            const rendered = content(campaign, contact);
            if (campaign.channel === 'sms') Object.assign(delivery, { smsAccountSid: currentEnv.TWILIO_ACCOUNT_SID, smsSender: currentEnv.TWILIO_MESSAGING_SERVICE_SID ? '' : currentEnv.TWILIO_FROM_NUMBER, smsMessagingServiceSid: currentEnv.TWILIO_MESSAGING_SERVICE_SID || '', message: rendered.text });
            delivery.status = 'sending'; putDelivery(delivery);
            try {
              const result = await sendDirect({ channel: campaign.channel, campaign: rendered, contact, delivery: { ...delivery, callbackUrl: `${appUrl}/api/webhooks/twilio/status/${delivery.id}` }, env: currentEnv, project, appUrl, unsubscribeUrl: `${appUrl}/api/direct/unsubscribe/${unsubscribeToken(campaign.projectId, contact.email)}`, assertMapping });
              const latest = deliveries(campaign.id).find(row => row.id === delivery.id);
              if (latest.providerId && result.providerId !== latest.providerId) throw new IntegrationError(502, 'DELIVERY_MISMATCH', 'The provider acknowledgement conflicts with a delivery callback.', true);
              latest.providerId = result.providerId; latest.status = nextStatus(latest.status, result.status); if (campaign.channel === 'sms') { latest.smsSender = result.sender || latest.smsSender; latest.smsMessagingServiceSid = result.messagingServiceSid || latest.smsMessagingServiceSid; } putDelivery(latest);
              if (campaign.channel === 'sms') recordSms(campaign, latest);
              if (campaign.channel === 'sms' && result.errorCode === '21610') contacts.suppressSmsGlobally(delivery.recipient, 'Recipient opted out');
              if (result.suppressionReason) contacts.suppressDestination(campaign.projectId, campaign.channel, delivery.recipient, result.suppressionReason);
            } catch (error) { if (campaign.channel === 'sms' && error.providerCode === 21610) contacts.suppressSmsGlobally(delivery.recipient, 'Recipient opted out'); const latest = deliveries(campaign.id).find(row => row.id === delivery.id); if (!latest.providerId) { latest.status = error.uncertain ? 'uncertain' : 'failed'; latest.error = error instanceof IntegrationError ? error.message : 'The provider did not confirm the message.'; putDelivery(latest); } if (error.uncertain || error.status === 429) { campaign.status = 'attention'; campaign.lastError = latest.error || 'Review the provider acknowledgement before continuing.'; } }
            finish(campaign);
          }
        } catch (error) { campaign.status = 'attention'; campaign.lastError = error instanceof IntegrationError ? error.message : 'The campaign could not continue. Check its provider status.'; save(campaign); }
      }
    } finally { active = false; }
  }
  async function handle(context) {
    const { req, url, body, project, user, send } = context;
    const route = url.pathname.match(/^\/api\/projects\/[^/]+\/direct\/(status|templates|contacts|campaigns)(?:\/([^/]+))?(?:\/([^/]+))?$/);
    if (!route) return false;
    const [, kind, id, action] = route, method = req.method;
    if (kind === 'status' && method === 'GET') { let accounts = [], accountError; if (env.ZERNIO_API_KEY && project.zernioProfileId) { try { accounts = await scopedAccounts(zernioClient(env.ZERNIO_API_KEY, () => context.assertProjectMapping(project.zernioProfileId)), project.zernioProfileId); } catch (error) { accountError = error instanceof IntegrationError ? error.message : 'WhatsApp accounts could not be loaded.'; } } send(200, { providers: Object.fromEntries(channels.map(channel => [channel, ready(channel) && (channel !== 'whatsapp' || Boolean(project.zernioProfileId && !accountError))])), accounts: accounts.filter(account => account.platform === 'whatsapp').map(account => ({ id: account._id || account.id, name: account.displayName || account.username || 'WhatsApp Business' })), accountError, emailPolicy: 'transactional_only', callbackUrl: `${appUrl}/api/webhooks/twilio/inbound`, publicCallbacks: appUrl.startsWith('https://') }); return true; }
    if (kind === 'templates' && method === 'GET') { send(200, await listWhatsAppTemplates({ env: { ...env }, project, accountId: url.searchParams.get('accountId'), assertMapping: () => context.assertProjectMapping(project.zernioProfileId) })); return true; }
    if (kind === 'contacts') {
      if (!id && method === 'GET') send(200, { contacts: contacts.list(project.id) });
      else if (!id && method === 'POST') send(201, { contact: contacts.save(project.id, body) });
      else if (id === 'import' && method === 'POST') send(200, contacts.import(project.id, body));
      else if (id === 'assess-dns' && method === 'POST') { const result = await contacts.assessDNS(project.id, body.ids, { assertAccess: context.assertIntegrationSettings }); context.assertIntegrationSettings(); send(200, result); }
      else if (id && !action && method === 'PATCH') send(200, { contact: contacts.save(project.id, body, id) });
      else if (id && !action && method === 'DELETE') { if (!contacts.remove(project.id, id)) fail(404, 'CONTACT_NOT_FOUND', 'Contact not found.'); send(200, { removed: true }); }
      else if (id && action === 'suppress' && method === 'POST') send(200, { contact: contacts.suppress(project.id, id, body.channel, body.reason) });
      else return false;
      return true;
    }
    if (kind !== 'campaigns') return false;
    if (!id && method === 'GET') { send(200, { campaigns: campaignRows(project.id).map(decorate) }); return true; }
    if (!id && method === 'POST') { const timestamp = nowISO(), campaign = { ...validate(body), id: randomUUID(), projectId: project.id, status: 'draft', createdAt: timestamp, updatedAt: timestamp }; db.prepare('INSERT INTO direct_campaigns VALUES(?,?,?)').run(campaign.id, project.id, JSON.stringify(campaign)); send(201, { campaign: decorate(campaign) }); return true; }
    const campaign = find(project.id, id);
    if (!action && method === 'GET') { send(200, { campaign: decorate(campaign), deliveries: deliveries(id) }); return true; }
    if (!action && method === 'PATCH') { if (campaign.status !== 'draft') fail(409, 'CAMPAIGN_LOCKED', 'Only drafts can be edited. Create a new draft for another send.'); const fields = Object.fromEntries(['name', 'channel', 'subject', 'text', 'html', 'emailPurpose', 'accountId', 'templateName', 'templateLanguage', 'templateComponents', 'contactIds', 'tags'].map(key => [key, campaign[key]])); Object.assign(campaign, validate({ ...fields, ...body })); send(200, { campaign: decorate(save(campaign)) }); return true; }
    if (method !== 'POST') return false;
    if (action === 'preview') { if (campaign.channel === 'whatsapp') { const result = await listWhatsAppTemplates({ env: { ...env }, project, accountId: campaign.accountId, assertMapping: () => context.assertProjectMapping(project.zernioProfileId) }), approved = result.templates.find(template => template.name === campaign.templateName && template.language === campaign.templateLanguage); if (!approved) fail(409, 'TEMPLATE_NOT_APPROVED', 'Choose a currently approved WhatsApp template.'); validateWhatsAppTemplate(campaign, approved); } send(200, preview(campaign)); return true; }
    if (['send', 'schedule'].includes(action)) {
      if (campaign.status !== 'draft') { send(200, { campaign: decorate(campaign), deliveries: deliveries(id) }); return true; }
      if (body.confirmed !== true) fail(400, 'SEND_CONFIRMATION_REQUIRED', 'Review the audience and confirm provider charges before sending.');
      if (campaign.channel === 'email' && body.transactionalConfirmed !== true) fail(400, 'TRANSACTIONAL_CONFIRMATION_REQUIRED', 'Confirm this message is transactional and contains no marketing content.');
      if (!ready(campaign.channel)) fail(409, 'INTEGRATION_NOT_CONFIGURED', 'Configure this sending provider in Integrations first.');
      if (!appUrl.startsWith('https://')) fail(409, 'PUBLIC_URL_REQUIRED', 'Set APP_URL to a public HTTPS address before sending so unsubscribe links and delivery callbacks can work.');
      const scheduledAt = action === 'send' ? nowISO() : body.scheduledAt;
      if (typeof scheduledAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(scheduledAt) || !Number.isFinite(Date.parse(scheduledAt)) || (action === 'schedule' && (Date.parse(scheduledAt) <= Date.now() || Date.parse(scheduledAt) > Date.now() + 366 * 86400000))) fail(400, 'INVALID_SCHEDULE', 'Choose a valid future time within the next year.');
      const selected = audience(campaign);
      if (body.previewToken !== preview(campaign).previewToken) fail(409, 'AUDIENCE_CHANGED', 'The campaign or audience changed. Review a fresh preview before confirming.');
      if (!selected.eligible.length || selected.eligible.length > 500) fail(400, 'AUDIENCE_LIMIT', 'Select between 1 and 500 eligible recipients per campaign.');
      if (campaign.channel === 'whatsapp') { const result = await listWhatsAppTemplates({ env: { ...env }, project, accountId: campaign.accountId, assertMapping: () => context.assertProjectMapping(project.zernioProfileId) }), approved = result.templates.find(template => template.name === campaign.templateName && template.language === campaign.templateLanguage && template.status === 'APPROVED'); if (!approved) fail(409, 'TEMPLATE_NOT_APPROVED', 'Choose a currently approved WhatsApp template.'); validateWhatsAppTemplate(campaign, approved); }
      context.assertIntegrationSettings();
      transaction(db, () => {
        const fresh = find(project.id, id); if (fresh.status !== 'draft') return;
        if (preview(fresh).previewToken !== body.previewToken) fail(409, 'AUDIENCE_CHANGED', 'The campaign or audience changed during preparation. Review a fresh preview before confirming.');
        Object.assign(campaign, { status: 'scheduled', scheduledAt: new Date(scheduledAt).toISOString(), scheduledBy: user.id, profileId: project.zernioProfileId, credentialHash: fingerprint(env, campaign.channel), audienceCount: selected.eligible.length }); save(campaign);
        for (const contact of selected.eligible) { const delivery = { id: randomUUID(), campaignId: id, contactId: contact.id, recipient: campaign.channel === 'email' ? contact.email : contact.phone, status: 'pending', createdAt: nowISO() }; db.prepare('INSERT INTO direct_deliveries VALUES(?,?,?,?)').run(delivery.id, id, contact.id, JSON.stringify(delivery)); }
        store.activity(project.id, `${campaign.channel === 'email' ? 'Transactional email' : campaign.channel.toUpperCase()} campaign scheduled for ${selected.eligible.length} recipients.`);
      });
      send(200, { campaign: decorate(find(project.id, id)), deliveries: deliveries(id) }); return true;
    }
    if (action === 'cancel') {
      campaign.status = 'cancelled'; save(campaign);
      for (const delivery of deliveries(id)) if (delivery.status === 'pending') { delivery.status = 'cancelled'; putDelivery(delivery); }
      if (campaign.channel === 'whatsapp' && campaign.providerId && campaign.providerStatus !== 'cancelled') {
        const assertMapping = () => { context.assertIntegrationSettings(); guard(campaign, false); };
        try {
          assertMapping(); const result = await cancelWhatsAppBroadcast({ env: { ...env }, project, campaign, providerId: campaign.providerId, idempotencyKey: campaign.id + '-cancel', assertMapping });
          const latest = find(project.id, id); latest.providerStatus = result.status; delete latest.lastError; save(latest);
        } catch (error) {
          const latest = find(project.id, id); latest.lastError = error instanceof IntegrationError ? error.message : 'Local sending stopped. Provider cancellation was not confirmed; check Zernio.'; save(latest);
        }
      }
      context.assertIntegrationSettings(); send(200, { campaign: decorate(find(project.id, id)), deliveries: deliveries(id) }); return true;
    }
    if (action === 'refresh') {
      const assertMapping = () => { context.assertIntegrationSettings(); guard(campaign, false); };
      if (campaign.channel === 'whatsapp' && campaign.providerId) {
        assertMapping(); const result = await getWhatsAppBroadcast({ env: { ...env }, project, campaign, providerId: campaign.providerId, assertMapping }), latest = find(project.id, id);
        // Preserve worker/cancellation progress and receipts written while this provider read was in flight.
        if (latest.providerStatus === campaign.providerStatus && JSON.stringify(latest.stats) === JSON.stringify(campaign.stats)) { latest.providerStatus = result.status; latest.stats = result.stats; save(latest); }
        for (const delivery of deliveries(id)) { const remote = result.recipients?.find(recipient => recipient.phone === delivery.recipient || recipient.phone === delivery.recipient.replace(/^\+/, '')); if (remote) { delivery.status = nextStatus(delivery.status, remote.status); putDelivery(delivery); } }
      }
      if (campaign.channel === 'sms' && deliveries(id).some(row => row.providerId)) { assertMapping(); for (const delivery of deliveries(id).filter(row => row.providerId && !terminal.has(row.status)).slice(0, 25)) { const result = await getSmsStatus({ env: { ...env }, providerId: delivery.providerId, assertMapping }); if (result.recipient !== delivery.recipient) fail(502, 'DELIVERY_MISMATCH', 'The provider returned another recipient.'); const latest = deliveries(id).find(row => row.id === delivery.id); latest.status = nextStatus(latest.status, result.status); if (result.errorCode) latest.errorCode = result.errorCode; if (result.sender) Object.assign(latest, { smsSender: result.sender, smsAccountSid: env.TWILIO_ACCOUNT_SID, smsMessagingServiceSid: result.messagingServiceSid || latest.smsMessagingServiceSid || '' }); putDelivery(latest); recordSms(campaign, latest); if (result.errorCode === '21610') contacts.suppressSmsGlobally(delivery.recipient, 'Recipient opted out'); } }
      if (campaign.channel === 'email' && ready('email')) { const result = await syncEmailSuppressions({ env: { ...env }, assertMapping: () => context.assertIntegrationSettings() }); const suppressed = (result.suppressions || []).filter(row => (!row.expiresAt || Date.parse(row.expiresAt) > Date.now()) && (row.scope?.type !== 'sending_domain' || row.scope.value.toLowerCase() === env.CLOUDFLARE_EMAIL_FROM_ADDRESS.split('@')[1].toLowerCase())); for (const contact of contacts.list(project.id)) { const match = suppressed.find(row => row.email?.toLowerCase() === contact.email); if (match) contacts.suppress(project.id, contact.id, 'email', match.reason === 'hard_bounce' ? 'hard-bounce' : match.reason); } }
      context.assertIntegrationSettings(); finish(find(project.id, id)); send(200, { campaign: decorate(find(project.id, id)), deliveries: deliveries(id) }); return true;
    }
    return false;
  }
  function receiveTwilio({ rawBody, headers, url }) {
    if (!env.TWILIO_AUTH_TOKEN || !env.TWILIO_ACCOUNT_SID) fail(503, 'WEBHOOK_NOT_CONFIGURED', 'Twilio is not configured.');
    if (!(headers['content-type'] || '').toLowerCase().startsWith('application/x-www-form-urlencoded')) fail(415, 'INVALID_WEBHOOK', 'Twilio form content is required.');
    let form; try { form = new URLSearchParams(new TextDecoder('utf-8', { fatal: true }).decode(rawBody)); } catch { fail(400, 'INVALID_WEBHOOK', 'Twilio form content must use UTF-8.'); } const keys = [...form.keys()];
    if (new Set(keys).size !== keys.length || keys.length > 100 || headers['x-twilio-webhooks-signature-settings']) fail(400, 'INVALID_WEBHOOK', 'Use the standard Twilio Auth Token signature.');
    const signed = appUrl + url.pathname + url.search + keys.sort().map(key => key + form.get(key)).join(''), expected = createHmac('sha1', env.TWILIO_AUTH_TOKEN).update(signed).digest('base64'), signature = headers['x-twilio-signature'];
    if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{27}=$/.test(signature) || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) fail(401, 'INVALID_SIGNATURE', 'The Twilio signature is invalid.');
    if (form.get('AccountSid') !== env.TWILIO_ACCOUNT_SID) fail(400, 'ACCOUNT_MISMATCH', 'The webhook belongs to another account.');
    const id = url.pathname.match(/^\/api\/webhooks\/twilio\/status\/([\w-]+)$/)?.[1];
    if (id) {
      const row = db.prepare('SELECT d.data,c.project_id FROM direct_deliveries d JOIN direct_campaigns c ON c.id=d.campaign_id WHERE d.id=?').get(id);
      if (!row) { if (smsInbox?.receiveStatus(form, id)) return { accepted: true }; fail(404, 'DELIVERY_NOT_FOUND', 'Delivery not found.'); }
      const delivery = JSON.parse(row.data), campaign = find(row.project_id, delivery.campaignId), providerId = form.get('MessageSid'), status = form.get('MessageStatus') === 'canceled' ? 'cancelled' : form.get('MessageStatus');
      if (campaign.channel !== 'sms' || !/^(SM|MM)[a-f0-9]{32}$/i.test(providerId || '') || (delivery.providerId && providerId !== delivery.providerId) || form.get('To') !== delivery.recipient || !statuses.includes(status) || form.get('From') && delivery.smsSender && form.get('From') !== delivery.smsSender || form.get('MessagingServiceSid') && delivery.smsMessagingServiceSid && form.get('MessagingServiceSid') !== delivery.smsMessagingServiceSid) fail(400, 'DELIVERY_MISMATCH', 'The callback does not match this delivery.');
      if (/^\+[1-9]\d{6,14}$/.test(form.get('From') || '')) { delivery.smsSender = form.get('From'); delivery.smsAccountSid = form.get('AccountSid'); if (/^MG[a-f0-9]{32}$/i.test(form.get('MessagingServiceSid') || '')) delivery.smsMessagingServiceSid = form.get('MessagingServiceSid'); }
      delivery.providerId = providerId; delivery.status = nextStatus(delivery.status, status); if (form.get('ErrorCode')) delivery.errorCode = form.get('ErrorCode').slice(0, 20); putDelivery(delivery); finish(campaign);
      recordSms(campaign, delivery);
      if (form.get('ErrorCode') === '21610') contacts.suppressSmsGlobally(delivery.recipient, 'Recipient opted out');
    } else if (/^\/api\/webhooks\/twilio\/inbound(?:\/[\w-]+)?$/.test(url.pathname)) {
      if (form.get('To') !== env.TWILIO_FROM_NUMBER && !(env.TWILIO_MESSAGING_SERVICE_SID && form.get('MessagingServiceSid') === env.TWILIO_MESSAGING_SERVICE_SID)) fail(400, 'SENDER_MISMATCH', 'The callback is for another sender.');
      if (smsInbox) return smsInbox.receiveVerified(form, { projectId: url.pathname.split('/')[5] || undefined });
      if (form.get('OptOutType') === 'STOP' || /^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|REVOKE|OPT OUT)$/i.test((form.get('Body') || '').trim())) {
        contacts.suppressSmsGlobally(form.get('From'), 'Recipient opted out');
      }
    } else fail(404, 'WEBHOOK_NOT_FOUND', 'Webhook not found.');
    return { accepted: true };
  }
  function handleUnsubscribe(token, method) { const [projectId, email] = unsubscribe(token); if (method === 'POST' && projectFor(projectId)) contacts.suppressDestination(projectId, 'email', email, 'Unsubscribed'); return method === 'POST' ? '<h1>Preferences updated</h1><p>This address will receive no further email campaigns from this project.</p>' : '<h1>Email preferences</h1><form method="post"><button type="submit">Stop email from this project</button></form>'; }
  return { handle, contacts, processPending, receiveTwilio, handleUnsubscribe, attachSmsInbox(service) {
    smsInbox = service;
    for (const row of db.prepare('SELECT data FROM direct_campaigns').all()) { const campaign = JSON.parse(row.data); if (campaign.channel !== 'sms') continue; for (const delivery of deliveries(campaign.id)) { if (!delivery.smsAccountSid && campaign.credentialHash === fingerprint(env, 'sms') && !env.TWILIO_MESSAGING_SERVICE_SID) Object.assign(delivery, { smsAccountSid: env.TWILIO_ACCOUNT_SID, smsSender: env.TWILIO_FROM_NUMBER }); recordSms(campaign, delivery); } }
  }, close() { closed = true; }, async idle() { while (active) await new Promise(resolve => setTimeout(resolve, 10)); } };
}

export { nextStatus as nextDeliveryStatus };
