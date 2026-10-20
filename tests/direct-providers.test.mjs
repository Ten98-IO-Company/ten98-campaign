import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { sendDirect, getSmsStatus, syncEmailSuppressions, listWhatsAppTemplates, validateWhatsAppTemplate, createWhatsAppBroadcast, addWhatsAppRecipients, sendWhatsAppBroadcast, getWhatsAppBroadcast, cancelWhatsAppBroadcast } from '../server/direct-providers.ts';
import { createIntegrationSettings } from '../server/integration-settings.mjs';

const env = { TWILIO_ACCOUNT_SID: `AC${'a'.repeat(32)}`, TWILIO_AUTH_TOKEN: 'secret-twilio-token', TWILIO_FROM_NUMBER: '+12025550100', CLOUDFLARE_ACCOUNT_ID: 'b'.repeat(32), CLOUDFLARE_EMAIL_API_TOKEN: 'secret-cloudflare-token', CLOUDFLARE_ZONE_ID: 'c'.repeat(32), CLOUDFLARE_EMAIL_FROM_ADDRESS: 'service@example.com', ZERNIO_API_KEY: 'secret-zernio-key' };
const messageId = `SM${'d'.repeat(32)}`, contact = { phone: '+12025550123', email: 'recipient@example.com' }, appUrl = 'https://campaign.example.com';
const project = { id: 'local-project', zernioProfileId: 'profile-a' }, campaign = { channel: 'whatsapp', name: 'Order update', accountId: 'wa-a', templateName: 'order_update', templateLanguage: 'en_US', templateComponents: [{ type: 'body', parameters: [{ type: 'text', text: 'Ready for collection' }] }] };
const template = { id: 'template-1', name: 'order_update', language: 'en_US', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'Order {{1}}' }] };
const reject = (promise, code, uncertain = false) => assert.rejects(promise, error => error.code === code && Boolean(error.uncertain) === uncertain);

test('direct SMS and transactional email use exact contracts, sender isolation, recipient-scoped receipts and uncertain writes', async () => {
  const original = globalThis.fetch, calls = []; let result, rejectNetwork = false, mapping = true;
  globalThis.fetch = async (target, options) => { calls.push({ url: new URL(target), options }); assert.equal(options.redirect, 'error'); assert.ok(options.signal); if (rejectNetwork) throw new Error('secret network detail'); return Response.json(result); };
  const sms = { channel: 'sms', campaign: { text: 'Collection ready', from: '+19999999999' }, contact, env, appUrl, delivery: { callbackUrl: `${appUrl}/api/webhooks/twilio/status/local-delivery` } };
  try {
    result = { sid: messageId, account_sid: env.TWILIO_ACCOUNT_SID, to: contact.phone, status: 'queued' };
    assert.equal((await sendDirect(sms)).status, 'queued');
    const request = calls.at(-1), body = new URLSearchParams(request.options.body);
    assert.equal(request.url.href, `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`);
    assert.equal(body.get('From'), env.TWILIO_FROM_NUMBER); assert.equal(body.get('Body'), 'Collection ready'); assert.equal(body.get('To'), contact.phone); assert.equal(body.get('StatusCallback'), sms.delivery.callbackUrl);
    assert.equal(request.options.headers.Authorization, `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`);
    await sendDirect({ ...sms, env: { ...env, TWILIO_MESSAGING_SERVICE_SID: `MG${'1'.repeat(32)}` } });
    const serviceBody = new URLSearchParams(calls.at(-1).options.body); assert.equal(serviceBody.has('From'), false); assert.equal(serviceBody.get('MessagingServiceSid'), `MG${'1'.repeat(32)}`);
    result.status = 'delivered'; assert.deepEqual(await getSmsStatus({ env, providerId: messageId }), { providerId: messageId, status: 'delivered', recipient: contact.phone }); assert.equal(calls.at(-1).options.method, 'GET');
    result.to = '+12025550999'; await reject(sendDirect(sms), 'INVALID_PROVIDER_RESPONSE', true); result.to = contact.phone;
    result.account_sid = `AC${'0'.repeat(32)}`; await reject(sendDirect(sms), 'INVALID_PROVIDER_RESPONSE', true); result.account_sid = env.TWILIO_ACCOUNT_SID;
    const before = calls.length;
    await reject(sendDirect({ ...sms, campaign: { text: 'x'.repeat(1601) } }), 'INVALID_DIRECT_CONTENT');
    await reject(sendDirect({ ...sms, delivery: { callbackUrl: 'https://other.example.com/callback' } }), 'INVALID_CALLBACK_URL');
    await reject(sendDirect({ ...sms, assertMapping: () => { if (!mapping) throw new Error(); } , env: { ...env, TWILIO_FROM_NUMBER: '' } }), 'INTEGRATION_NOT_CONFIGURED');
    mapping = false; await reject(sendDirect({ ...sms, assertMapping: () => { if (!mapping) throw new Error(); } }), 'PROJECT_CONNECTION_CHANGED'); assert.equal(calls.length, before);
    rejectNetwork = true; await reject(sendDirect(sms), 'PROVIDER_UNAVAILABLE', true); rejectNetwork = false;
    const mail = { channel: 'email', campaign: { emailPurpose: 'transactional', subject: 'Receipt', text: 'Your receipt', html: '<p>Your receipt</p>' }, contact, env, appUrl, unsubscribeUrl: `${appUrl}/api/direct/unsubscribe/signed-token` };
    result = { success: true, result: { message_id: '<receipt@example.com>', delivered: [], permanent_bounces: [], queued: [contact.email] } };
    assert.deepEqual(await sendDirect(mail), { providerId: '<receipt@example.com>', status: 'queued', recipient: contact.email });
    const payload = JSON.parse(calls.at(-1).options.body); assert.equal(payload.from, env.CLOUDFLARE_EMAIL_FROM_ADDRESS); assert.deepEqual(payload.to, [contact.email]); assert.ok(payload.text.endsWith(mail.unsubscribeUrl)); assert.ok(payload.html.includes('Manage email preferences')); assert.equal(payload.headers['List-Unsubscribe'], `<${mail.unsubscribeUrl}>`); assert.equal(payload.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
    delete result.result.message_id; assert.equal((await sendDirect(mail)).providerId, null);
    result.result.queued = []; result.result.permanent_bounces = [contact.email]; assert.equal((await sendDirect(mail)).suppressionReason, 'hard-bounce');
    result.result.permanent_bounces = []; result.result.suppressed_recipients = [contact.email]; assert.equal((await sendDirect(mail)).suppressionReason, 'Provider suppression');
    result.result.delivered = [contact.email]; await reject(sendDirect(mail), 'INVALID_PROVIDER_RESPONSE', true);
    result.result.delivered = ['foreign@example.com']; result.result.suppressed_recipients = []; await reject(sendDirect(mail), 'INVALID_PROVIDER_RESPONSE', true);
    const mailBefore = calls.length; await reject(sendDirect({ ...mail, campaign: { ...mail.campaign, emailPurpose: 'marketing' } }), 'TRANSACTIONAL_EMAIL_ONLY'); assert.equal(calls.length, mailBefore);
  } finally { globalThis.fetch = original; }
});

test('WhatsApp phases are scoped broadcasts, validate approved template values, never send on create and refresh recipients', async () => {
  const original = globalThis.fetch, calls = []; let status = 'draft', foreign = false, deleted = false, deleteDenied = false, invalidAdd = false, approved = structuredClone(template), changed = false;
  const options = { env, project, campaign, providerId: 'broadcast-1', idempotencyKey: 'unique-operation', assertMapping: () => { if (changed) throw new Error(); } };
  globalThis.fetch = async (target, request) => {
    const url = new URL(target); calls.push({ url, request });
    assert.equal(url.hostname, 'zernio.com'); assert.equal(request.headers.Authorization, `Bearer ${env.ZERNIO_API_KEY}`);
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ _id: 'wa-a', profileId: 'profile-a', platform: 'whatsapp', isActive: true }, { _id: 'foreign', profileId: 'profile-b', platform: 'whatsapp' }] });
    if (url.pathname.endsWith('/whatsapp/templates')) { assert.equal(url.searchParams.get('accountId'), 'wa-a'); assert.equal(url.searchParams.get('status'), 'APPROVED'); return Response.json({ success: true, templates: [approved] }); }
    if (url.pathname.endsWith('/broadcasts') && request.method === 'POST') {
      const payload = JSON.parse(request.body); assert.deepEqual(payload, { profileId: 'profile-a', accountId: 'wa-a', platform: 'whatsapp', name: campaign.name, template: { name: campaign.templateName, language: campaign.templateLanguage, components: campaign.templateComponents } });
      assert.equal(request.headers['Idempotency-Key'], 'unique-operation'); return Response.json({ success: true, broadcast: { id: 'broadcast-1', accountId: foreign ? 'foreign' : 'wa-a', platform: 'whatsapp', status: 'draft' } });
    }
    if (url.pathname.endsWith('/broadcasts/broadcast-1')) {
      if (request.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }); }
      if (deleted) return Response.json({}, { status: deleteDenied ? 403 : 404 });
      return Response.json({ success: true, broadcast: { id: 'broadcast-1', accountId: foreign ? 'foreign' : 'wa-a', platform: 'whatsapp', status, recipientCount: 1 } });
    }
    if (url.pathname.endsWith('/recipients')) {
      if (request.method === 'POST') { assert.deepEqual(JSON.parse(request.body), { phones: [contact.phone] }); return Response.json({ success: true, added: invalidAdd ? 0 : 1, skipped: 0 }); }
      return Response.json({ success: true, recipients: [{ platformIdentifier: contact.phone.slice(1), status: 'delivered', messageId: 'wa-message-1' }], pagination: { hasMore: false } });
    }
    if (url.pathname.endsWith('/send')) { assert.equal(request.method, 'POST'); assert.equal(request.body, undefined); status = 'completed'; return Response.json({ success: true, status, sent: 1, failed: 0, recipientCount: 1 }); }
    assert.fail(`Unexpected request ${url}`);
  };
  try {
    assert.deepEqual((await listWhatsAppTemplates(options)).templates, [template]);
    assert.equal((await createWhatsAppBroadcast({ ...options, providerId: undefined })).status, 'draft'); assert.equal(calls.some(row => row.url.pathname.endsWith('/send')), false);
    assert.deepEqual(await addWhatsAppRecipients({ ...options, contacts: [contact, contact] }), { added: 1, skipped: 0 });
    invalidAdd = true; await reject(addWhatsAppRecipients({ ...options, contacts: [contact] }), 'INVALID_PROVIDER_RESPONSE', true); invalidAdd = false;
    const writes = () => calls.filter(row => row.request.method !== 'GET').length;
    const beforeForeign = writes(); foreign = true; await reject(addWhatsAppRecipients({ ...options, contacts: [contact] }), 'INVALID_PROVIDER_RESPONSE'); assert.equal(writes(), beforeForeign);
    await reject(createWhatsAppBroadcast({ ...options, providerId: undefined }), 'INVALID_PROVIDER_RESPONSE', true); foreign = false;
    const beforeTemplate = writes();
    await reject(createWhatsAppBroadcast({ ...options, providerId: undefined, campaign: { ...campaign, templateComponents: [] } }), 'INVALID_TEMPLATE');
    approved.components[0].text = 'Order {{first_name}}'; await reject(createWhatsAppBroadcast({ ...options, providerId: undefined }), 'UNSUPPORTED_TEMPLATE');
    approved = structuredClone(template); approved.components[0].text = 'Order {{2}}'; await reject(createWhatsAppBroadcast({ ...options, providerId: undefined }), 'UNSUPPORTED_TEMPLATE');
    approved = structuredClone(template); approved.components.unshift({ type: 'HEADER', format: 'IMAGE' }); await reject(createWhatsAppBroadcast({ ...options, providerId: undefined }), 'INVALID_TEMPLATE');
    approved = { ...structuredClone(template), status: 'PENDING' }; await reject(createWhatsAppBroadcast({ ...options, providerId: undefined }), 'TEMPLATE_NOT_APPROVED'); approved = structuredClone(template); assert.equal(writes(), beforeTemplate);
    const beforeCount = writes(); await reject(sendWhatsAppBroadcast({ ...options, expectedRecipientCount: 2 }), 'AUDIENCE_CHANGED'); assert.equal(writes(), beforeCount);
    assert.equal((await sendWhatsAppBroadcast({ ...options, expectedRecipientCount: 1 })).status, 'completed'); await reject(sendWhatsAppBroadcast(options), 'BROADCAST_NOT_DRAFT');
    assert.deepEqual((await getWhatsAppBroadcast(options)).recipients, [{ phone: contact.phone, status: 'delivered', messageId: 'wa-message-1' }]);
    status = 'draft'; assert.equal((await cancelWhatsAppBroadcast(options)).deletedDraft, true);
    deleted = false; deleteDenied = true; await reject(cancelWhatsAppBroadcast(options), 'BROADCAST_DELETE_UNCONFIRMED', true);
    changed = true; await reject(listWhatsAppTemplates(options), 'PROJECT_CONNECTION_CHANGED');
  } finally { globalThis.fetch = original; }
});

test('approved WhatsApp media headers and dynamic URL buttons have exact wire payloads and reject incompatible or unsafe values', () => {
  const approved = { ...structuredClone(template), components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Order {{2}} is for {{1}}' }, { type: 'BUTTONS', buttons: [{ type: 'PHONE_NUMBER', phone_number: '+12025550100' }, { type: 'URL', url: 'https://shop.example.com/order/{{1}}' }, { type: 'URL', url: 'https://shop.example.com/help' }] }] };
  const draft = { ...campaign, templateComponents: [{ type: 'header', parameters: [{ type: 'image', image: { link: 'https://cdn.example.com/creative.jpg' } }] }, { type: 'body', parameters: [{ type: 'text', text: 'Alex' }, { type: 'text', text: 'Ready' }] }, { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'order-123?receipt=yes' }] }] };
  const expected = { name: campaign.templateName, language: campaign.templateLanguage, components: draft.templateComponents };
  assert.deepEqual(validateWhatsAppTemplate(draft, approved), expected);
  for (const type of ['video', 'document']) {
    const mediaTemplate = structuredClone(approved), mediaDraft = structuredClone(draft); mediaTemplate.components[0].format = type.toUpperCase(); mediaDraft.templateComponents[0].parameters = [{ type, [type]: { link: `https://cdn.example.com/file.${type === 'document' ? 'pdf' : 'mp4'}`, ...(type === 'document' ? { filename: 'Receipt.pdf' } : {}) } }];
    assert.deepEqual(validateWhatsAppTemplate(mediaDraft, mediaTemplate).components, mediaDraft.templateComponents);
  }
  const invalid = [
    value => { value.templateComponents.shift(); },
    value => { value.templateComponents[0].parameters[0] = { type: 'video', video: { link: 'https://cdn.example.com/file.mp4' } }; },
    value => { value.templateComponents[0].parameters[0].image.link = 'http://cdn.example.com/file.jpg'; },
    value => { value.templateComponents[0].parameters[0].image.link = 'https://127.0.0.1/file.jpg'; },
    value => { value.templateComponents[0].parameters[0].image.link = 'https://drive.google.com/file/d/123/view'; },
    value => { value.templateComponents[0].parameters[0].image.id = 'unverified-media-id'; },
    value => { value.templateComponents[2].index = '0'; },
    value => { value.templateComponents[2].index = 1; },
    value => { value.templateComponents[2].index = '2'; },
    value => { value.templateComponents[2].parameters = []; },
    value => { value.templateComponents[2].sub_type = 'quick_reply'; },
    value => { value.templateComponents.push(structuredClone(value.templateComponents[2])); },
  ];
  for (const change of invalid) { const value = structuredClone(draft); change(value); assert.throws(() => validateWhatsAppTemplate(value, approved), error => error.code === 'INVALID_TEMPLATE'); }
  for (const type of ['LOCATION', 'GIF']) { const value = structuredClone(approved); value.components[0].format = type; assert.throws(() => validateWhatsAppTemplate(draft, value), error => error.code === 'UNSUPPORTED_TEMPLATE'); }
  for (const url of ['https://{{1}}', 'https://shop.example.com/{{name}}', 'https://shop.example.com/{{1}}/trailing', 'https://shop.example.com/{{1}}/{{1}}']) { const value = structuredClone(approved); value.components[2].buttons[1].url = url; assert.throws(() => validateWhatsAppTemplate(draft, value), error => error.code === 'UNSUPPORTED_TEMPLATE'); }
  const document = { ...structuredClone(approved), components: [{ type: 'HEADER', format: 'DOCUMENT' }] }, filename = { ...campaign, templateComponents: [{ type: 'header', parameters: [{ type: 'document', document: { link: 'https://cdn.example.com/file.pdf', filename: '../receipt.pdf' } }] }] };
  assert.throws(() => validateWhatsAppTemplate(filename, document), error => error.code === 'INVALID_TEMPLATE');
  assert.throws(() => validateWhatsAppTemplate(draft, undefined), error => error.code === 'TEMPLATE_NOT_APPROVED');
});

test('WhatsApp template reads reject malformed rendered fields before either inbox or campaigns can consume them', async () => {
  const original = globalThis.fetch, options = { env, project, campaign, idempotencyKey: 'malformed-template-check' };
  let components = [], writes = 0;
  globalThis.fetch = async (target, request) => {
    const url = new URL(target); assert.equal(url.hostname, 'zernio.com');
    if (request.method !== 'GET') { writes++; assert.fail('Malformed template reads must not send provider writes.'); }
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ _id: campaign.accountId, profileId: project.zernioProfileId, platform: 'whatsapp', isActive: true }] });
    assert.ok(url.pathname.endsWith('/whatsapp/templates')); return Response.json({ success: true, templates: [{ ...template, components }] });
  };
  try {
    for (const malformed of [
      [{ type: 'BODY', text: { unexpected: true } }],
      [{ type: 'HEADER', format: ['TEXT'] }],
      [{ type: 'BUTTONS', buttons: { unexpected: true } }],
      [{ type: 'BUTTONS', buttons: [null] }],
      [{ type: 'BUTTONS', buttons: [{ type: 'URL', text: { unexpected: true }, url: 'https://example.com/' }] }],
      [{ type: 'BUTTONS', buttons: [{ type: 'URL', text: 'View details', url: { unexpected: true } }] }],
      [{ type: 'BUTTONS', buttons: [{ type: 'PHONE_NUMBER', phone_number: { unexpected: true } }] }],
    ]) {
      components = malformed;
      await reject(listWhatsAppTemplates(options), 'INVALID_PROVIDER_RESPONSE');
      await reject(createWhatsAppBroadcast(options), 'INVALID_PROVIDER_RESPONSE');
    }
    components = [{ type: 'CAROUSEL', cards: [{ components: [{ type: 'BODY', text: 'Advanced format' }] }] }, { type: 'BUTTONS', buttons: [{ type: 'FLOW', text: 'Continue', flow_id: 'flow-123' }] }];
    assert.deepEqual((await listWhatsAppTemplates(options)).templates[0].components, components, 'Valid advanced definitions remain available for the UI to label unsupported.');
    assert.equal(writes, 0);
  } finally { globalThis.fetch = original; }
});

test('Cloudflare suppression reads follow cursors including short pages, preserve expiry/scope and reject partial scans', async () => {
  const original = globalThis.fetch; let requests = 0, loop = false;
  globalThis.fetch = async (target, options) => { const url = new URL(target); assert.equal(options.method, 'GET'); assert.equal(url.hostname, 'api.cloudflare.com'); requests++; if (!url.searchParams.has('cursor')) return Response.json({ success: true, result: [], result_info: { next_cursor: 'opaque-cursor' } }); return Response.json({ success: true, result: [{ id: 'suppression-1', email: contact.email, reason: 'hard_bounce', expires_at: null, scope: { type: 'account' } }], result_info: { next_cursor: loop ? 'opaque-cursor' : null } }); };
  try { assert.deepEqual(await syncEmailSuppressions({ env }), { suppressions: [{ email: contact.email, reason: 'hard_bounce', expiresAt: null, scope: { type: 'account' } }], complete: true }); assert.equal(requests, 2); loop = true; await reject(syncEmailSuppressions({ env }), 'INVALID_PROVIDER_RESPONSE'); } finally { globalThis.fetch = original; }
});

test('Twilio and Cloudflare settings encrypt secrets, reject unsafe identifiers and use read-only connection tests', async () => {
  const original = globalThis.fetch, db = new DatabaseSync(':memory:'), settingsEnv = {}, secret = 'direct-settings-encryption-key-at-least-32-characters', calls = [];
  const manager = createIntegrationSettings({ db, env: settingsEnv, secret });
  globalThis.fetch = async (target, options) => { const url = new URL(target); calls.push(url); assert.equal(options.method, 'GET'); if (url.hostname === 'api.twilio.com') return Response.json({ sid: env.TWILIO_ACCOUNT_SID, status: 'active' }); if (url.hostname === 'api.cloudflare.com') return Response.json({ success: true, result: [{ enabled: true, name: '*.example.com' }, { enabled: true, name: 'example.com' }] }); assert.fail('Unexpected provider'); };
  try {
    manager.save('twilio', { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, fromNumber: env.TWILIO_FROM_NUMBER });
    manager.save('cloudflareEmail', { accountId: env.CLOUDFLARE_ACCOUNT_ID, apiKey: env.CLOUDFLARE_EMAIL_API_TOKEN, zoneId: env.CLOUDFLARE_ZONE_ID, fromAddress: env.CLOUDFLARE_EMAIL_FROM_ADDRESS });
    for (const id of ['twilio', 'cloudflareEmail']) { assert.equal(manager.describe().providers.find(row => row.id === id).configured, true); const result = await manager.test(id); assert.equal(result.readOnly, true); assert.equal(result.ok, true); }
    assert.equal(calls.length, 2); const output = JSON.stringify(manager.describe()); assert.equal(output.includes(env.TWILIO_AUTH_TOKEN), false); assert.equal(output.includes(env.CLOUDFLARE_EMAIL_API_TOKEN), false);
    for (const row of db.prepare('SELECT ciphertext FROM integration_settings').all()) assert.equal(Buffer.from(row.ciphertext).toString().includes('secret-'), false);
    const restored = {}; createIntegrationSettings({ db, env: restored, secret }); assert.equal(restored.TWILIO_AUTH_TOKEN, env.TWILIO_AUTH_TOKEN); assert.equal(restored.CLOUDFLARE_EMAIL_API_TOKEN, env.CLOUDFLARE_EMAIL_API_TOKEN);
    for (const [id, fields] of [['twilio', { accountSid: '../foreign' }], ['twilio', { fromNumber: '555123' }], ['cloudflareEmail', { accountId: 'wrong' }], ['cloudflareEmail', { fromAddress: 'Name <sender@example.com>' }]]) assert.throws(() => manager.save(id, fields), error => error.code === 'INVALID_SETTING');
    manager.save('twilio', { authToken: '' }); assert.equal(settingsEnv.TWILIO_AUTH_TOKEN, env.TWILIO_AUTH_TOKEN); manager.save('twilio', { authToken: null }); assert.equal(manager.describe().providers.find(row => row.id === 'twilio').configured, false);
  } finally { globalThis.fetch = original; db.close(); }
});
