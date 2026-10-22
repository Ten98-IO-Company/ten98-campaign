import { IntegrationError, fail, reportObject as plain, providerRequest, zernioClient, scopedAccounts, requireAccount } from './provider-core.ts';
import type { ProviderRecord } from './provider-core.ts';
import { publicMediaUrl } from '../shared/social-posts.ts';

const validId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\s\u0000-\u001f\u007f]/.test(value);
const number = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const sid = (value: unknown, prefix: string) => typeof value === 'string' && new RegExp(`^${prefix}[a-fA-F0-9]{32}$`).test(value);
const email = (value: unknown): value is string => typeof value === 'string' && value.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(value);
const phone = (value: unknown): value is string => typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value);
const text = (value: unknown, label: string, max: number): string => { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(400, 'INVALID_DIRECT_CONTENT', `Enter a valid ${label}.`); return value; };
function invalid(provider: string, uncertain = false): never { return fail(502, 'INVALID_PROVIDER_RESPONSE', `${provider} did not return a complete, scoped acknowledgement. Reconcile with the provider before retrying a send.`, uncertain); }
const SMS_STATUSES = new Set(['accepted', 'queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed', 'canceled', 'scheduled', 'partially_delivered']);
const BROADCAST_STATUSES = new Set(['draft', 'scheduled', 'sending', 'completed', 'failed', 'cancelled']);

function twilio(env: ProviderRecord) {
  if (!sid(env.TWILIO_ACCOUNT_SID, 'AC') || !env.TWILIO_AUTH_TOKEN) fail(409, 'INTEGRATION_NOT_CONFIGURED', 'Configure the Twilio account and auth token in Integrations.');
  return { base: `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}`, headers: { Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}` } };
}
function smsReceipt(data: any, env: ProviderRecord, uncertain: boolean, expectedId?: string, expectedRecipient?: string) {
  if (!plain(data) || !sid(data.sid, 'SM') || data.account_sid !== env.TWILIO_ACCOUNT_SID || !phone(data.to) || !SMS_STATUSES.has(data.status) || expectedId && data.sid !== expectedId || expectedRecipient && data.to !== expectedRecipient) invalid('Twilio', uncertain);
  if (data.from != null && !phone(data.from) || data.messaging_service_sid != null && !sid(data.messaging_service_sid, 'MG')) invalid('Twilio', uncertain);
  return { providerId: data.sid, status: data.status === 'canceled' ? 'cancelled' : data.status, recipient: data.to, ...(data.from ? { sender: data.from } : {}), ...(data.messaging_service_sid ? { messagingServiceSid: data.messaging_service_sid } : {}), ...(data.error_code != null ? { errorCode: String(data.error_code).slice(0, 100) } : {}) };
}
function cloudflare(env: ProviderRecord) {
  if (!/^[a-fA-F0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID || '') || !env.CLOUDFLARE_EMAIL_API_TOKEN || !email(env.CLOUDFLARE_EMAIL_FROM_ADDRESS)) fail(409, 'INTEGRATION_NOT_CONFIGURED', 'Configure the Cloudflare account, Email Sending API token, and sender address in Integrations.');
  return { base: `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/email/sending`, headers: { Authorization: `Bearer ${env.CLOUDFLARE_EMAIL_API_TOKEN}`, 'Content-Type': 'application/json' } };
}

export async function sendDirect({ channel, campaign, contact, delivery = {}, env, project, appUrl, unsubscribeUrl, assertMapping }: ProviderRecord) {
  if (channel === 'sms') {
    const api = twilio(env);
    if (!phone(contact.phone)) fail(400, 'INVALID_RECIPIENT', 'SMS recipients need an international phone number, including + and country code.');
    const body = new URLSearchParams({ To: contact.phone, Body: text(campaign.text, 'SMS message of at most 1600 characters', 1600) });
    if (env.TWILIO_MESSAGING_SERVICE_SID) {
      if (!sid(env.TWILIO_MESSAGING_SERVICE_SID, 'MG')) fail(409, 'INVALID_SETTING', 'Configure a valid Twilio Messaging Service SID.');
      body.set('MessagingServiceSid', env.TWILIO_MESSAGING_SERVICE_SID);
    } else {
      if (!phone(env.TWILIO_FROM_NUMBER)) fail(409, 'INTEGRATION_NOT_CONFIGURED', 'Configure a Twilio sender number or Messaging Service in Integrations.');
      body.set('From', env.TWILIO_FROM_NUMBER);
    }
    if (delivery.sender !== undefined) { if (!phone(delivery.sender)) fail(400, 'INVALID_SENDER', 'Choose the original Twilio sender.'); body.set('From', delivery.sender); }
    if (delivery.callbackUrl) {
      let callback;
      try { callback = publicMediaUrl(delivery.callbackUrl); if (new URL(callback).origin !== new URL(appUrl).origin) throw new Error(); }
      catch { fail(409, 'INVALID_CALLBACK_URL', 'SMS delivery reports require this app’s public HTTPS address.'); }
      body.set('StatusCallback', callback);
    }
    const data = await providerRequest(`${api.base}/Messages.json`, { method: 'POST', headers: { ...api.headers, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }, 'Twilio', assertMapping);
    const receipt = smsReceipt(data, env, true, undefined, contact.phone);
    if (delivery.sender !== undefined && receipt.sender !== delivery.sender || body.has('From') && receipt.sender && receipt.sender !== body.get('From') || receipt.messagingServiceSid && receipt.messagingServiceSid !== (env.TWILIO_MESSAGING_SERVICE_SID || '')) invalid('Twilio', true);
    return receipt;
  }
  if (channel !== 'email') fail(400, 'UNSUPPORTED_CHANNEL', 'Use the WhatsApp broadcast workflow for WhatsApp campaigns.');
  if (campaign.emailPurpose !== 'transactional') fail(400, 'TRANSACTIONAL_EMAIL_ONLY', 'Cloudflare Email Sending supports transactional email only.');
  const api = cloudflare(env);
  if (!email(contact.email)) fail(400, 'INVALID_RECIPIENT', 'Enter a valid email recipient.');
  const subject = text(campaign.subject, 'email subject', 998); if (/[\r\n]/.test(subject)) fail(400, 'INVALID_DIRECT_CONTENT', 'Email subjects cannot contain line breaks.');
  const body: ProviderRecord = { from: env.CLOUDFLARE_EMAIL_FROM_NAME ? { address: env.CLOUDFLARE_EMAIL_FROM_ADDRESS, name: text(env.CLOUDFLARE_EMAIL_FROM_NAME, 'sender name', 200) } : env.CLOUDFLARE_EMAIL_FROM_ADDRESS, to: [contact.email], subject, text: text(campaign.text, 'plain-text email', 100000) };
  if (campaign.html) body.html = text(campaign.html, 'HTML email', 500000);
  if (env.CLOUDFLARE_EMAIL_REPLY_TO_ADDRESS) { if (!email(env.CLOUDFLARE_EMAIL_REPLY_TO_ADDRESS)) fail(409, 'INVALID_REPLY_TO', 'Configure a valid email reply address.'); body.reply_to = env.CLOUDFLARE_EMAIL_REPLY_TO_ADDRESS; }
  if (unsubscribeUrl) {
    let url: string;
    try { url = publicMediaUrl(unsubscribeUrl); if (new URL(url).origin !== new URL(appUrl).origin) throw new Error(); }
    catch { fail(409, 'INVALID_UNSUBSCRIBE_URL', 'Email preferences require this app’s public HTTPS address.'); }
    body.text += `\n\nManage email preferences: ${url}`;
    if (body.html) body.html += `<p><a href="${url.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">Manage email preferences</a></p>`;
    // List-ID (RFC 2919) names the project's list, so mail clients can identify and filter it.
    body.headers = { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click', ...(project?.id ? { 'List-ID': `<${project.id}.${new URL(appUrl).hostname}>` } : {}) };
  }
  const data = await providerRequest(`${api.base}/send`, { method: 'POST', headers: api.headers, body: JSON.stringify(body) }, 'Cloudflare Email Sending', assertMapping);
  const buckets = { delivered: 'delivered', permanent_bounces: 'failed', queued: 'queued', suppressed_recipients: 'suppressed' }, matches = [];
  if (data?.success !== true || !plain(data.result)) invalid('Cloudflare Email Sending', true);
  for (const [key, status] of Object.entries(buckets)) {
    const values = data.result[key] ?? (key === 'suppressed_recipients' ? [] : null);
    if (!Array.isArray(values) || values.length > 1 || values.some(value => !email(value) || value.toLowerCase() !== contact.email.toLowerCase())) invalid('Cloudflare Email Sending', true);
    if (values.length) matches.push(status);
  }
  if (matches.length !== 1 || data.result.message_id != null && !validId(data.result.message_id)) invalid('Cloudflare Email Sending', true);
  // A suppressed recipient is not suppressed locally here: the receipt carries no reason or expiry, so a temporary block would
  // become permanent. The suppression-list sync records it with Cloudflare's own reason and expiry.
  return { providerId: data.result.message_id || null, status: matches[0], recipient: contact.email, ...(matches[0] === 'failed' ? { suppressionReason: 'hard-bounce' } : {}) };
}

export function sendSmsReply({ env, sender, recipient, message, callbackUrl, appUrl, assertMapping }: ProviderRecord) {
  return sendDirect({ channel: 'sms', env, contact: { phone: recipient }, campaign: { text: message }, delivery: { sender, callbackUrl }, appUrl, assertMapping });
}

export async function getSmsStatus({ env, providerId, assertMapping }: ProviderRecord) {
  const api = twilio(env); if (!sid(providerId, 'SM')) fail(400, 'INVALID_PROVIDER_ID', 'Choose a valid SMS delivery.');
  return smsReceipt(await providerRequest(`${api.base}/Messages/${providerId}.json`, { method: 'GET', headers: api.headers }, 'Twilio', assertMapping), env, false, providerId);
}

export async function syncEmailSuppressions({ env, assertMapping }: ProviderRecord) {
  const api = cloudflare(env), suppressions: ProviderRecord[] = [], seen = new Set<string>(); let cursor: string | null | undefined;
  // ponytail: cap a refresh at 10,000 suppressions; use a persisted cursor if an account exceeds it.
  for (let page = 0; page < 10; page++) {
    const url = new URL(`${api.base}/suppressions`); url.searchParams.set('per_page', '1000'); if (cursor) url.searchParams.set('cursor', cursor);
    const data = await providerRequest(url, { method: 'GET', headers: api.headers }, 'Cloudflare Email Sending', assertMapping);
    if (data?.success !== true || !Array.isArray(data.result) || data.result.length > 1000 || !plain(data.result_info) || data.result_info.next_cursor !== null && (typeof data.result_info.next_cursor !== 'string' || !data.result_info.next_cursor || data.result_info.next_cursor.length > 2048)) invalid('Cloudflare Email Sending');
    for (const row of data.result) {
      if (!plain(row) || !email(row.email) || !validId(row.id) || !['manual', 'complaint', 'hard_bounce', 'soft_bounce', 'policy'].includes(row.reason) || row.expires_at != null && !Number.isFinite(Date.parse(row.expires_at)) || row.scope && (!['account', 'sending_domain'].includes(row.scope.type) || row.scope.type === 'sending_domain' && typeof row.scope.value !== 'string')) invalid('Cloudflare Email Sending');
      suppressions.push({ email: row.email.toLowerCase(), reason: row.reason, expiresAt: row.expires_at || null, scope: row.scope || { type: 'account' } });
    }
    cursor = data.result_info.next_cursor;
    if (cursor === null) return { suppressions, complete: true };
    if (seen.has(cursor!)) invalid('Cloudflare Email Sending'); seen.add(cursor!);
  }
  fail(503, 'INCOMPLETE_PROVIDER_DATA', 'The suppression list exceeds this refresh limit. No partial suppression list was applied.');
}

async function whatsapp({ env, project, campaign, accountId = campaign?.accountId, assertMapping }: ProviderRecord) {
  if (!env.ZERNIO_API_KEY || !validId(project?.zernioProfileId)) fail(409, 'INTEGRATION_NOT_CONFIGURED', 'Configure Zernio and map a profile to this project.');
  if (!validId(accountId)) fail(400, 'INVALID_ACCOUNT', 'Choose a WhatsApp account.');
  const api = zernioClient(env.ZERNIO_API_KEY, assertMapping), account = requireAccount(await scopedAccounts(api, project.zernioProfileId), accountId);
  if (account.platform !== 'whatsapp' || account.isActive === false) fail(409, 'WHATSAPP_ACCOUNT_REQUIRED', 'Choose an active WhatsApp account connected to this project.');
  return api;
}

export async function listWhatsAppTemplates(options: ProviderRecord) {
  const api = await whatsapp(options), data = await api('/whatsapp/templates', { accountId: options.accountId || options.campaign?.accountId, status: 'APPROVED' });
  if (data?.success !== true || !Array.isArray(data.templates) || data.templates.length > 10000) invalid('Zernio');
  const templates = data.templates.filter(row => row?.status === 'APPROVED').map(row => {
    if (!validId(row.id) || typeof row.name !== 'string' || !/^[a-z0-9_]{1,512}$/.test(row.name) || typeof row.language !== 'string' || !/^[A-Za-z]{2,3}(?:_[A-Za-z0-9]{2,8})?$/.test(row.language) || !['AUTHENTICATION', 'MARKETING', 'UTILITY'].includes(row.category) || !Array.isArray(row.components) || row.components.length > 20 || row.components.some((component: any) => !plain(component))) invalid('Zernio');
    for (const component of row.components) {
      if (['type', 'format', 'text'].some(field => component[field] != null && typeof component[field] !== 'string') || component.buttons != null && (!Array.isArray(component.buttons) || component.buttons.some((button: any) => !plain(button) || ['type', 'text', 'url', 'phone_number'].some(field => button[field] != null && typeof button[field] !== 'string')))) invalid('Zernio');
    }
    return { id: row.id, name: row.name, language: row.language, status: row.status, category: row.category, components: row.components };
  });
  if (new Set(templates.map(row => `${row.name}:${row.language}`)).size !== templates.length) invalid('Zernio');
  return { templates };
}

export function validateWhatsAppTemplate(campaign: ProviderRecord, approved: ProviderRecord) {
  if (!approved || approved.status !== 'APPROVED' || approved.name !== campaign.templateName || approved.language !== campaign.templateLanguage) fail(409, 'TEMPLATE_NOT_APPROVED', 'Choose a currently approved WhatsApp template and language.');
  const template: ProviderRecord = { name: approved.name, language: approved.language };
  const components = campaign.templateComponents === undefined ? [] : campaign.templateComponents;
  if (!Array.isArray(components) || components.length > 20 || components.some(row => !plain(row)) || JSON.stringify(components).length > 100000) fail(400, 'INVALID_TEMPLATE', 'Enter valid approved template values.');
  if (!Array.isArray(approved.components) || approved.components.some(row => !plain(row))) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned an unreadable approved template.');
  const expected = new Map<string, ProviderRecord>();
  for (const row of approved.components) {
    const type = String(row.type).toLowerCase();
    if (!['header', 'body', 'footer', 'buttons'].includes(type)) fail(400, 'UNSUPPORTED_TEMPLATE', 'Flows, carousels and advanced template components are not supported.');
    if (type === 'footer') continue;
    if (type === 'buttons') {
      if (!Array.isArray(row.buttons) || row.buttons.some((button: any) => !plain(button) || !['url', 'phone_number', 'quick_reply'].includes(String(button.type).toLowerCase()))) fail(400, 'UNSUPPORTED_TEMPLATE', 'Choose URL, phone or quick reply buttons. Advanced template buttons are not supported.');
      row.buttons.forEach((button: any, index: number) => {
        if (String(button.type).toLowerCase() !== 'url') return;
        const url = button.url;
        if (typeof url !== 'string') fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned an unreadable template button URL.');
        if (!/\{\{/.test(url)) return;
        if (!url.endsWith('{{1}}') || /\{\{/.test(url.slice(0, -5))) fail(400, 'UNSUPPORTED_TEMPLATE', 'Dynamic URL buttons need one numbered variable at the end of the approved URL.');
        let prefix;
        try { prefix = publicMediaUrl(url.slice(0, -5)); }
        catch { fail(400, 'UNSUPPORTED_TEMPLATE', 'Dynamic buttons need a public HTTPS URL with a fixed origin.'); }
        expected.set(`button:${index}`, { type: 'button', index: String(index), count: 1, url, origin: new URL(prefix).origin });
      });
      continue;
    }
    if (expected.has(type)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned duplicate template components.');
    if (type === 'header' && row.format && String(row.format).toLowerCase() !== 'text') {
      const mediaType = String(row.format).toLowerCase();
      if (!['image', 'video', 'document'].includes(mediaType)) fail(400, 'UNSUPPORTED_TEMPLATE', 'Supported media headers are images, videos and documents.');
      expected.set(type, { type, mediaType, count: 1 }); continue;
    }
    const content = String(row.text || ''), positions = [...new Set([...content.matchAll(/\{\{(\d+)\}\}/g)].map(match => Number(match[1])))].sort((a, b) => a - b);
    if (/\{\{/.test(content.replace(/\{\{\d+\}\}/g, '')) || positions.some((position, index) => position !== index + 1)) fail(400, 'UNSUPPORTED_TEMPLATE', 'Choose a template with consecutive numbered variables. Named variables are not supported.');
    expected.set(type, { type, count: positions.length });
  }
  const seen = new Set<string>(), wire: ProviderRecord[] = [];
  for (const row of components) {
    const key = row.type === 'button' ? `button:${row.index}` : row.type, spec = expected.get(key), fields = row.type === 'button' ? ['type', 'sub_type', 'index', 'parameters'] : ['type', 'parameters'];
    if (!spec || seen.has(key) || Object.keys(row).some(field => !fields.includes(field)) || row.type !== spec.type || !Array.isArray(row.parameters) || row.parameters.length !== spec.count || row.type === 'button' && (row.sub_type !== 'url' || row.index !== spec.index)) fail(400, 'INVALID_TEMPLATE', 'Fill each approved template field exactly once.');
    seen.add(key);
    if (spec.mediaType) {
      const parameter = row.parameters[0], media = parameter?.[spec.mediaType];
      if (!plain(parameter) || parameter.type !== spec.mediaType || Object.keys(parameter).some(field => !['type', spec.mediaType].includes(field)) || !plain(media) || Object.keys(media).some(field => !['link', ...(spec.mediaType === 'document' ? ['filename'] : [])].includes(field))) fail(400, 'INVALID_TEMPLATE', 'The media header must match the approved image, video or document format.');
      let link; try { link = publicMediaUrl(media.link); } catch { fail(400, 'INVALID_TEMPLATE', 'Media headers need a public HTTPS file URL. Drive preview links cannot be sent.'); }
      if (media.filename !== undefined && (typeof media.filename !== 'string' || !media.filename.trim() || media.filename.length > 255 || /[\u0000-\u001f\u007f\\/]/.test(media.filename))) fail(400, 'INVALID_TEMPLATE', 'Enter a document filename without paths or control characters.');
      wire.push({ type: 'header', parameters: [{ type: spec.mediaType, [spec.mediaType]: { link, ...(media.filename ? { filename: media.filename } : {}) } }] });
    } else {
      const parameters = row.parameters.map((parameter: any) => {
        if (!plain(parameter) || parameter.type !== 'text' || Object.keys(parameter).some(field => !['type', 'text'].includes(field))) fail(400, 'INVALID_TEMPLATE', 'Use text values for approved template variables.');
        return { type: 'text', text: text(parameter.text, 'template value', spec.type === 'button' ? 2000 : 32768) };
      });
      if (spec.type === 'button') {
        let url;
        try { url = publicMediaUrl(spec.url.replace('{{1}}', parameters[0].text)); if (new URL(url).origin !== spec.origin || /\{\{/.test(parameters[0].text)) throw new Error(); }
        catch { fail(400, 'INVALID_TEMPLATE', 'Enter a URL suffix that keeps the approved public HTTPS address.'); }
      }
      wire.push({ type: row.type, ...(spec.type === 'button' ? { sub_type: 'url', index: spec.index } : {}), parameters });
    }
  }
  for (const [key, spec] of expected) if (spec.count && !seen.has(key)) fail(400, 'INVALID_TEMPLATE', `Fill every ${spec.type === 'button' ? 'dynamic button' : spec.type} field in the approved template.`);
  if (campaign.templateVariables && Object.keys(campaign.templateVariables).length) fail(400, 'UNSUPPORTED_TEMPLATE', 'Provide explicit template values; local contact fields are not Zernio contact fields.');
  if (wire.length) template.components = wire;
  return template;
}

function broadcastReceipt(data: any, options: ProviderRecord, uncertain = false) {
  const row = data?.broadcast;
  if (data?.success !== true || !plain(row) || !validId(row.id) || options.providerId && row.id !== options.providerId || row.platform !== 'whatsapp' || String(row.accountId?._id || row.accountId) !== options.campaign.accountId || row.profileId != null && String(row.profileId?._id || row.profileId) !== options.project.zernioProfileId || !BROADCAST_STATUSES.has(row.status)) invalid('Zernio', uncertain);
  const stats: ProviderRecord = {};
  for (const key of ['recipientCount', 'sentCount', 'deliveredCount', 'readCount', 'failedCount']) if (row[key] !== undefined) { if (!number(row[key])) invalid('Zernio', uncertain); stats[key] = row[key]; }
  return { providerId: row.id, status: row.status, stats };
}

export async function createWhatsAppBroadcast(options: ProviderRecord) {
  const { templates } = await listWhatsAppTemplates(options), approved = templates.find(row => row.name === options.campaign.templateName && row.language === options.campaign.templateLanguage);
  if (!approved) fail(409, 'TEMPLATE_NOT_APPROVED', 'Choose a currently approved WhatsApp template and language.');
  const api = await whatsapp(options), body = { profileId: options.project.zernioProfileId, accountId: options.campaign.accountId, platform: 'whatsapp', name: text(options.campaign.name, 'campaign name', 200), template: validateWhatsAppTemplate(options.campaign, approved) };
  const receipt = broadcastReceipt(await api('/broadcasts', {}, body, options.idempotencyKey), options, true);
  if (receipt.status !== 'draft') invalid('Zernio', true);
  return receipt;
}

async function readBroadcast(options: ProviderRecord) {
  if (!validId(options.providerId)) fail(400, 'INVALID_PROVIDER_ID', 'Choose a valid WhatsApp broadcast.');
  const api = await whatsapp(options), data = await api(`/broadcasts/${encodeURIComponent(options.providerId)}`);
  return { api, receipt: broadcastReceipt(data, options) };
}

export async function addWhatsAppRecipients(options: ProviderRecord) {
  const { api, receipt } = await readBroadcast(options);
  if (receipt.status !== 'draft') fail(409, 'BROADCAST_NOT_DRAFT', 'Recipients can only be added to a draft broadcast.');
  if (!Array.isArray(options.contacts) || !options.contacts.length || options.contacts.length > 20000 || options.contacts.some(row => !phone(row?.phone))) fail(400, 'INVALID_RECIPIENT', 'Choose at most 20,000 WhatsApp recipients with international phone numbers.');
  const phones = [...new Set(options.contacts.map(row => row.phone))], data = await api(`/broadcasts/${encodeURIComponent(options.providerId)}/recipients`, {}, { phones }, options.idempotencyKey);
  if (data?.success !== true || !number(data.added) || !number(data.skipped) || data.added + data.skipped !== phones.length) invalid('Zernio', true);
  return { added: data.added, skipped: data.skipped };
}

export async function sendWhatsAppBroadcast(options: ProviderRecord) {
  const { api, receipt } = await readBroadcast(options);
  if (receipt.status !== 'draft') fail(409, 'BROADCAST_NOT_DRAFT', 'Only a draft WhatsApp broadcast can be sent. Reconcile the existing delivery before retrying.');
  if (options.expectedRecipientCount !== undefined && (!number(options.expectedRecipientCount) || receipt.stats.recipientCount !== options.expectedRecipientCount)) fail(409, 'AUDIENCE_CHANGED', 'The provider audience changed before dispatch. Review the broadcast before sending.');
  const data = await api(`/broadcasts/${encodeURIComponent(options.providerId)}/send`, {}, undefined, options.idempotencyKey, 'POST');
  if (data?.success !== true || !['sending', 'completed', 'failed'].includes(data.status) || !number(data.sent) || !number(data.failed) || !number(data.recipientCount) || data.sent + data.failed > data.recipientCount) invalid('Zernio', true);
  return { providerId: options.providerId, status: data.status, stats: { sentCount: data.sent, failedCount: data.failed, recipientCount: data.recipientCount } };
}

export async function cancelWhatsAppBroadcast(options: ProviderRecord) {
  const { api, receipt } = await readBroadcast(options);
  if (receipt.status === 'cancelled') return receipt;
  if (receipt.status === 'draft') {
    await api(`/broadcasts/${encodeURIComponent(options.providerId)}`, {}, undefined, options.idempotencyKey, 'DELETE');
    // Zernio documents no deletion response schema; read back to confirm before reporting cancellation.
    try { await api(`/broadcasts/${encodeURIComponent(options.providerId)}`); }
    catch (error: any) { if (error.providerStatus === 404) return { providerId: options.providerId, status: 'cancelled', deletedDraft: true }; throw new IntegrationError(502, 'BROADCAST_DELETE_UNCONFIRMED', 'The draft deletion could not be confirmed. Reconcile the broadcast in Zernio.', true); }
    invalid('Zernio', true);
  }
  if (!['scheduled', 'sending'].includes(receipt.status)) fail(409, 'BROADCAST_NOT_CANCELLABLE', 'Only a scheduled or sending broadcast can be cancelled at Zernio. Draft schedules are cancelled locally.');
  const data = await api(`/broadcasts/${encodeURIComponent(options.providerId)}/cancel`, {}, undefined, options.idempotencyKey, 'POST');
  if (data?.success !== true || data.broadcast?.id !== options.providerId || data.broadcast.status !== 'cancelled') invalid('Zernio', true);
  return { providerId: options.providerId, status: 'cancelled' };
}

export async function getWhatsAppBroadcast(options: ProviderRecord) {
  const { api, receipt } = await readBroadcast(options), recipients: ProviderRecord[] = [];
  // ponytail: refresh at most 20,000 recipients; add persisted paging for larger broadcasts.
  for (let skip = 0; skip < 20000; skip += 100) {
    const data = await api(`/broadcasts/${encodeURIComponent(options.providerId)}/recipients`, { limit: 100, skip });
    if (data?.success !== true || !Array.isArray(data.recipients) || data.recipients.length > 100 || typeof data.pagination?.hasMore !== 'boolean') invalid('Zernio');
    for (const row of data.recipients) {
      const destination = typeof row?.platformIdentifier === 'string' ? `+${row.platformIdentifier.replace(/^\+/, '')}` : '';
      if (!phone(destination) || !['pending', 'sent', 'delivered', 'read', 'failed'].includes(row.status)) invalid('Zernio');
      recipients.push({ phone: destination, status: row.status, ...(row.messageId ? { messageId: String(row.messageId).slice(0, 500) } : {}), ...(row.error ? { error: String(row.error).slice(0, 1000) } : {}) });
    }
    if (!data.pagination.hasMore) return { ...receipt, recipients };
    if (!data.recipients.length) invalid('Zernio');
  }
  fail(503, 'INCOMPLETE_PROVIDER_DATA', 'This WhatsApp broadcast exceeds the recipient refresh limit.');
}
