import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { createApp } from '../server/index.mjs';
import { estimateSms, createDirectCampaigns } from '../server/direct-campaigns.mjs';

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-direct-')), origin = 'https://campaign.example.test';
  const env = { TWILIO_ACCOUNT_SID: 'AC' + '1'.repeat(32), TWILIO_AUTH_TOKEN: 'test-twilio-secret', TWILIO_FROM_NUMBER: '+12025550100', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_EMAIL_API_TOKEN: 'test-cloudflare-token', CLOUDFLARE_EMAIL_FROM_ADDRESS: 'receipts@example.com', ZERNIO_API_KEY: 'test-zernio-key' };
  const app = createApp({ dataDir, env, appUrl: origin, directScheduler: false }), originalFetch = globalThis.fetch;
  const calls = [], messages = new Map(), broadcasts = new Map(); let hook, suppressions = [], emailMode = 'queued', cookie;
  const json = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target);
    if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    calls.push({ url: url.href, method: options.method || 'GET', body: options.body });
    if (hook) { const response = await hook(url, options); if (response !== undefined) return response; }
    if (url.hostname === 'api.twilio.com') {
      if (options.method === 'POST') { const form = new URLSearchParams(options.body), sid = 'SM' + String(messages.size + 1).padStart(32, '0'), message = { sid, account_sid: env.TWILIO_ACCOUNT_SID, to: form.get('To'), status: 'queued' }; messages.set(sid, message); return json(message); }
      const id = url.pathname.split('/').at(-1).replace('.json', ''); return json(messages.get(id));
    }
    if (url.hostname === 'api.cloudflare.com') {
      if (url.pathname.endsWith('/send')) { const body = JSON.parse(options.body), email = body.to[0]; return json({ success: true, result: { message_id: 'email-' + calls.length, delivered: emailMode === 'delivered' ? [email] : [], queued: emailMode === 'queued' ? [email] : [], permanent_bounces: emailMode === 'bounce' ? [email] : [], suppressed_recipients: [] } }); }
      if (url.pathname.endsWith('/suppressions')) return json({ success: true, result: suppressions, result_info: { next_cursor: null } });
    }
    if (url.hostname === 'zernio.com') {
      if (url.pathname.endsWith('/accounts')) return json({ accounts: [{ _id: 'wa-direct', platform: 'whatsapp', profileId: 'profile-direct', username: 'QA WhatsApp' }, { _id: 'wa-foreign', platform: 'whatsapp', profileId: 'other-profile' }] });
      if (url.pathname.endsWith('/whatsapp/templates')) return json({ success: true, templates: [{ id: 'tpl-direct', name: 'appointment_update', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Your appointment has been confirmed.' }] }] });
      const match = url.pathname.match(/\/broadcasts(?:\/([^/]+))?(?:\/(recipients|send|cancel))?$/);
      if (match) {
        const [, id, action] = match;
        if (!id && options.method === 'POST') { const body = JSON.parse(options.body), broadcast = { id: randomUUID(), platform: 'whatsapp', accountId: body.accountId, profileId: body.profileId, status: 'draft', phones: [] }; broadcasts.set(broadcast.id, broadcast); return json({ success: true, broadcast }); }
        const broadcast = broadcasts.get(id); if (!broadcast) return new Response('{}', { status: 404 });
        if (options.method === 'DELETE') { broadcasts.delete(id); return json({ success: true }); }
        if (!action) return json({ success: true, broadcast: { ...broadcast, recipientCount: broadcast.phones.length } });
        if (action === 'recipients' && options.method === 'POST') { const body = JSON.parse(options.body); broadcast.phones = body.phones; return json({ success: true, added: body.phones.length, skipped: 0 }); }
        if (action === 'recipients') return json({ success: true, recipients: broadcast.phones.map(phone => ({ platformIdentifier: phone.replace('+', ''), status: broadcast.status === 'completed' ? 'delivered' : 'pending' })), pagination: { hasMore: false } });
        if (action === 'send') { broadcast.status = 'completed'; return json({ success: true, status: 'completed', sent: broadcast.phones.length, failed: 0, recipientCount: broadcast.phones.length }); }
        if (action === 'cancel') { broadcast.status = 'cancelled'; return json({ success: true, broadcast }); }
      }
    }
    throw new Error('Unexpected provider request: ' + url.hostname + url.pathname);
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, method = 'GET', body, override = {}) {
    const response = await fetch(base + path, { method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...override.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const content = await response.text(); return { status: response.status, data: response.headers.get('content-type')?.includes('json') ? JSON.parse(content) : content, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const setup = await request('/api/auth/setup', 'POST', { name: 'QA owner', email: 'direct-owner@example.test', password: 'fixture-passphrase-long-enough', sample: false }); assert.equal(setup.status, 201); cookie = setup.cookie;
  const projectId = setup.data.projectId, path = `/api/projects/${projectId}/direct`;
  await request(`/api/projects/${projectId}`, 'PATCH', { zernioProfileId: 'profile-direct' });
  const person = async (fields = {}) => { const result = await request(path + '/contacts', 'POST', { name: 'Alex', email: 'alex@example.com', phone: '+12025550123', consents: { email: true, sms: true, whatsapp: true }, consentSource: 'Customer request, recorded in CRM', ...fields }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.contact; };
  const draft = async (fields = {}) => { const result = await request(path + '/campaigns', 'POST', { name: 'Appointment notice', channel: 'sms', text: 'Hello {{name}}, your appointment is tomorrow.', ...fields }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.campaign; };
  const arm = async (campaign, action = 'send', fields = {}) => { const preview = await request(path + `/campaigns/${campaign.id}/preview`, 'POST', {}); if (preview.status !== 200) return preview; return request(path + `/campaigns/${campaign.id}/${action}`, 'POST', { confirmed: true, transactionalConfirmed: true, previewToken: preview.data.previewToken, ...(action === 'schedule' ? { scheduledAt: new Date(Date.now() + 3600000).toISOString() } : {}), ...fields }); };
  async function twilio(urlPath, fields, valid = true) {
    const form = new URLSearchParams({ AccountSid: env.TWILIO_ACCOUNT_SID, ...fields }), payload = origin + urlPath + [...form.keys()].sort().map(key => key + form.get(key)).join(''), signature = valid ? createHmac('sha1', env.TWILIO_AUTH_TOKEN).update(payload).digest('base64') : 'invalid';
    const response = await originalFetch(base + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature }, body: form }); return { status: response.status, body: await response.text() };
  }
  return { app, env, origin, base, path, projectId, calls, messages, broadcasts, request, person, draft, arm, twilio, setHook(value) { hook = value; }, setEmailMode(value) { emailMode = value; }, setSuppressions(value) { suppressions = value; }, async close() { await app.close(); globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); } };
}

test('SMS campaigns persist schedules, deduplicate sends, validate audiences, deliver signed callbacks and honor STOP', async () => {
  const f = await fixture();
  try {
    const contact = await f.person(), other = await f.person({ name: 'No permission', email: 'no-permission@example.com', phone: '+12025550124', consents: { email: false, sms: false, whatsapp: false } });
    const status = await f.request(f.path + '/status'); assert.equal(status.data.accounts.length, 1); assert.equal(status.data.accounts[0].id, 'wa-direct');
    const campaign = await f.draft(), preview = await f.request(f.path + `/campaigns/${campaign.id}/preview`, 'POST', {}); assert.equal(preview.data.audience.eligible, 1); assert.equal(preview.data.audience.excluded, 1); assert.equal(preview.data.sample.text, 'Hello Alex, your appointment is tomorrow.\nReply STOP to unsubscribe.');
    await f.request(f.path + '/contacts/' + contact.id, 'PATCH', { name: 'Alex changed' });
    assert.equal((await f.request(f.path + `/campaigns/${campaign.id}/send`, 'POST', { confirmed: true, previewToken: preview.data.previewToken })).status, 409);
    assert.equal((await f.arm(campaign, 'schedule')).data.campaign.status, 'scheduled');
    assert.equal((await f.arm(campaign, 'send')).data.campaign.status, 'scheduled');
    await f.app.direct.processPending(); assert.equal(f.messages.size, 0, 'Future campaigns do not send early.');
    await f.app.direct.processPending({ now: Date.now() + 7200000 }); assert.equal(f.messages.size, 1);
    await f.app.direct.processPending({ now: Date.now() + 7200000 }); assert.equal(f.messages.size, 1, 'Completed sends cannot be replayed.');
    let detail = (await f.request(f.path + '/campaigns/' + campaign.id)).data, delivery = detail.deliveries[0]; assert.equal(detail.campaign.counts.accepted, 1);
    const form = { MessageSid: delivery.providerId, To: contact.phone, MessageStatus: 'delivered' }, callback = `/api/webhooks/twilio/status/${delivery.id}`;
    let resumeRefresh, enteredRefresh; const refreshGate = new Promise(resolve => { resumeRefresh = resolve; }), refreshEntered = new Promise(resolve => { enteredRefresh = resolve; });
    f.setHook(async (url, options) => { if (url.hostname === 'api.twilio.com' && options.method === 'GET') { enteredRefresh(); await refreshGate; return new Response(JSON.stringify({ ...f.messages.get(delivery.providerId), status: 'sent' })); } });
    const refreshing = f.request(f.path + `/campaigns/${campaign.id}/refresh`, 'POST', {}); await refreshEntered; assert.equal((await f.twilio(callback, form)).status, 200); resumeRefresh(); assert.equal((await refreshing).data.deliveries[0].status, 'delivered', 'A stale read cannot overwrite a callback that arrived during refresh.'); f.setHook(null);
    assert.equal((await f.twilio(callback, form, false)).status, 401); assert.equal((await f.twilio(callback, { ...form, To: other.phone })).status, 400); assert.equal((await f.twilio(callback, form)).status, 200);
    assert.equal((await f.twilio(callback, { ...form, MessageStatus: 'queued' })).status, 200); detail = (await f.request(f.path + '/campaigns/' + campaign.id)).data; assert.equal(detail.deliveries[0].status, 'delivered', 'Late callbacks cannot regress delivery.');
    assert.equal((await f.twilio('/api/webhooks/twilio/inbound', { MessageSid: 'SM' + 'f'.repeat(32), From: contact.phone, To: f.env.TWILIO_FROM_NUMBER, Body: 'STOP' })).status, 200);
    const updated = (await f.request(f.path + '/contacts')).data.contacts.find(item => item.id === contact.id); assert.equal(updated.consents.sms, false); assert.ok(updated.suppression.sms);
    const next = await f.draft(); assert.equal((await f.arm(next)).status, 400, 'Opt-outs exclude future campaigns.');
    assert.deepEqual(estimateSms('a'.repeat(161)), { encoding: 'GSM-7', units: 161, segments: 2 }); assert.equal(estimateSms('€'.repeat(81)).segments, 2); assert.equal(estimateSms('😀'.repeat(36)).encoding, 'UCS-2'); assert.equal(estimateSms('😀'.repeat(36)).segments, 2);
  } finally { await f.close(); }
});

test('Cloudflare email enforces transactional purpose, reports true receipts, appends unsubscribe and preserves bounce suppressions', async () => {
  const f = await fixture();
  try {
    const contact = await f.person();
    assert.equal((await f.request(f.path + '/campaigns', 'POST', { name: 'Newsletter', channel: 'email', emailPurpose: 'marketing', subject: 'Sale', text: 'Sale' })).status, 400);
    const campaign = await f.draft({ channel: 'email', emailPurpose: 'transactional', subject: 'Receipt for {{name}}', text: 'Your requested receipt.', html: '<p>Hello {{name}}</p>' });
    assert.equal((await f.arm(campaign, 'send', { transactionalConfirmed: false })).status, 400);
    assert.equal((await f.arm(campaign)).status, 200); await f.app.direct.processPending();
    const emailCall = f.calls.find(call => call.url.endsWith('/send')), email = JSON.parse(emailCall.body); assert.deepEqual(email.to, [contact.email]); assert.match(email.text, /Your requested receipt/); assert.match(email.text, /https:\/\/campaign.example.test\/api\/direct\/unsubscribe\//);
    const unsubscribe = new URL(email.text.match(/https:\/\/\S+/)[0]).pathname;
    assert.equal((await f.request(unsubscribe)).status, 200); assert.equal((await f.request(f.path + '/contacts')).data.contacts[0].consents.email, true, 'Link previews cannot unsubscribe recipients.');
    assert.equal((await f.request(unsubscribe, 'POST', {})).status, 200); assert.equal((await f.request(f.path + '/contacts')).data.contacts[0].consents.email, false);
    const bounceContact = await f.person({ email: 'dead@example.com', phone: '+12025550125' }); f.setEmailMode('bounce'); const bounce = await f.draft({ channel: 'email', subject: 'Requested service update', text: 'Your service update.', contactIds: [bounceContact.id] }); await f.arm(bounce); await f.app.direct.processPending();
    const people = (await f.request(f.path + '/contacts')).data.contacts; assert.equal(people.find(item => item.id === bounceContact.id).suppression.email.reason, 'hard-bounce');
    const safeContact = await f.person({ email: 'safe@example.com', phone: '+12025550126' });
    f.setSuppressions([{ id: 'suppression-other-domain', email: safeContact.email, reason: 'hard_bounce', scope: { type: 'sending_domain', value: 'another.example' }, expires_at: null }, { id: 'suppression-expired', email: safeContact.email, reason: 'complaint', scope: { type: 'account' }, expires_at: '2020-01-01T00:00:00Z' }]);
    assert.equal((await f.request(f.path + `/campaigns/${campaign.id}/refresh`, 'POST', {})).status, 200); assert.equal((await f.request(f.path + '/contacts')).data.contacts.find(item => item.id === safeContact.id).consents.email, true, 'Unrelated and expired provider suppressions are not applied.');
    const draft = await f.draft({ channel: 'email', subject: 'Service', text: 'Service' }); assert.equal((await f.request(f.path + `/campaigns/${draft.id}/refresh`, 'POST', {})).data.campaign.status, 'draft', 'Refreshing a draft cannot mark it completed.');
  } finally { await f.close(); }
});

test('direct schedules reject normalized dates and invalid clock times without queuing recipients', async () => {
  const f = await fixture();
  try {
    await f.person(); const campaign = await f.draft(), february = new Date();
    february.setUTCMonth(1, 1); if (february <= new Date()) february.setUTCFullYear(february.getUTCFullYear() + 1);
    const prefix = february.toISOString().slice(0, 7), tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    for (const scheduledAt of [`${prefix}-30T12:00:00Z`, `${tomorrow}T24:00:00Z`, `${tomorrow}T12:60:00Z`, `${tomorrow}T12:00:00`]) {
      const rejected = await f.arm(campaign, 'schedule', { scheduledAt });
      assert.equal(rejected.status, 400, scheduledAt); assert.equal(rejected.data.error.code, 'INVALID_SCHEDULE');
      const unchanged = (await f.request(f.path + '/campaigns/' + campaign.id)).data;
      assert.equal(unchanged.campaign.status, 'draft'); assert.deepEqual(unchanged.deliveries, []);
    }
    const scheduledAt = `${tomorrow}T12:30:00+04:00`, accepted = await f.arm(campaign, 'schedule', { scheduledAt });
    assert.equal(accepted.status, 200); assert.equal(accepted.data.campaign.scheduledAt, new Date(scheduledAt).toISOString());
    assert.equal(accepted.data.deliveries.length, 1); assert.equal(f.messages.size, 0);
  } finally { await f.close(); }
});

test('WhatsApp uses scoped approved-template broadcasts, separate durable phases and recipient delivery refresh', async () => {
  const f = await fixture();
  try {
    await f.person(); const campaign = await f.draft({ channel: 'whatsapp', accountId: 'wa-direct', templateName: 'appointment_update', templateLanguage: 'en' });
    assert.equal((await f.arm(campaign)).status, 200); await f.app.direct.processPending();
    const detail = (await f.request(f.path + '/campaigns/' + campaign.id)).data; assert.equal(detail.campaign.phase, 'dispatched'); assert.equal(detail.campaign.counts.accepted, 1); assert.equal(f.broadcasts.size, 1);
    const created = f.calls.find(call => call.url.endsWith('/broadcasts')); assert.equal(JSON.parse(created.body).profileId, 'profile-direct'); assert.equal(f.calls.some(call => call.url.includes('/inbox')), false);
    const refreshed = await f.request(f.path + `/campaigns/${campaign.id}/refresh`, 'POST', {}); assert.equal(refreshed.status, 200); assert.equal(refreshed.data.campaign.counts.delivered, 1);
    const foreign = await f.draft({ channel: 'whatsapp', accountId: 'wa-foreign', templateName: 'appointment_update', templateLanguage: 'en' }); assert.equal((await f.arm(foreign)).status, 403); assert.equal(f.broadcasts.size, 1);
    const cancel = await f.draft({ channel: 'whatsapp', accountId: 'wa-direct', templateName: 'appointment_update', templateLanguage: 'en' }); await f.arm(cancel, 'schedule'); assert.equal((await f.request(f.path + `/campaigns/${cancel.id}/cancel`, 'POST', {})).data.campaign.status, 'cancelled'); await f.app.direct.processPending({ now: Date.now() + 7200000 }); assert.equal(f.broadcasts.size, 1);
  } finally { await f.close(); }
});

test('uncertain outcomes never retry, cancellation survives an in-flight send, and credential changes stop queued work', async () => {
  const f = await fixture();
  try {
    await f.person(); await f.person({ email: 'second@example.com', phone: '+12025550124' });
    const campaign = await f.draft(); await f.arm(campaign);
    let release, started; const gate = new Promise(resolve => { release = resolve; }), pending = new Promise(resolve => { started = resolve; });
    f.setHook(async (url, options) => { if (url.hostname === 'api.twilio.com' && options.method === 'POST') { started(); await gate; } });
    const processing = f.app.direct.processPending(); await pending; await f.request(f.path + `/campaigns/${campaign.id}/cancel`, 'POST', {}); release(); await processing; f.setHook(null);
    assert.equal((await f.request(f.path + '/campaigns/' + campaign.id)).data.campaign.status, 'cancelled'); await f.app.direct.processPending(); assert.equal(f.messages.size, 1);
    const uncertain = await f.draft(); await f.arm(uncertain); let attempts = 0;
    f.setHook(async (url, options) => { if (url.hostname === 'api.twilio.com' && options.method === 'POST') { attempts++; throw new Error('Lost acknowledgement'); } }); await f.app.direct.processPending(); await f.app.direct.processPending(); assert.equal(attempts, 1); assert.equal((await f.request(f.path + '/campaigns/' + uncertain.id)).data.campaign.status, 'attention');
    f.setHook(null); const changed = await f.draft(); await f.arm(changed); f.env.TWILIO_FROM_NUMBER = '+12025550999'; const before = f.messages.size; await f.app.direct.processPending(); assert.equal(f.messages.size, before); assert.equal((await f.request(f.path + '/campaigns/' + changed.id)).data.campaign.status, 'attention');
  } finally { await f.close(); }
});

test('WhatsApp cancellation during preparation prevents dispatch and a changed review cannot queue stale recipients', async () => {
  const f = await fixture();
  try {
    const contact = await f.person(), campaign = await f.draft({ channel: 'whatsapp', accountId: 'wa-direct', templateName: 'appointment_update', templateLanguage: 'en' }); await f.arm(campaign);
    let release, started; const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
    f.setHook(async (url, options) => { if (url.pathname.endsWith('/recipients') && options.method === 'POST') { started(); await gate; return new Response(JSON.stringify({ success: true, added: 1, skipped: 0 })); } });
    const processing = f.app.direct.processPending(); await entered; assert.equal((await f.request(f.path + `/campaigns/${campaign.id}/cancel`, 'POST', {})).status, 200); release(); await processing; f.setHook(null);
    assert.equal(f.calls.filter(call => /\/broadcasts\/[^/]+\/send$/.test(call.url)).length, 0); const cancelled = (await f.request(f.path + '/campaigns/' + campaign.id)).data.campaign; assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.providerStatus, 'cancelled', 'A late worker error must preserve the confirmed provider cancellation.');
    const next = await f.draft({ channel: 'whatsapp', accountId: 'wa-direct', templateName: 'appointment_update', templateLanguage: 'en' }), preview = await f.request(f.path + `/campaigns/${next.id}/preview`, 'POST', {});
    let resume, reached; const wait = new Promise(resolve => { resume = resolve; }), waiting = new Promise(resolve => { reached = resolve; });
    f.setHook(async url => { if (url.pathname.endsWith('/whatsapp/templates')) { reached(); await wait; } });
    const sending = f.request(f.path + `/campaigns/${next.id}/send`, 'POST', { confirmed: true, previewToken: preview.data.previewToken }); await waiting;
    await f.request(f.path + '/contacts/' + contact.id, 'PATCH', { company: 'Changed while reviewing' }); resume(); assert.equal((await sending).status, 409); f.setHook(null);
    assert.equal((await f.request(f.path + '/campaigns/' + next.id)).data.campaign.status, 'draft'); assert.equal((await f.request(f.path + '/campaigns/' + next.id)).data.deliveries.length, 0);
  } finally { await f.close(); }
});

test('restart quarantines in-flight requests and rejects expanded personalized bodies before queuing', async () => {
  const f = await fixture();
  try {
    await f.person({ company: 'x'.repeat(200) });
    const huge = await f.draft({ text: '{{company}} '.repeat(10) }); assert.equal((await f.request(f.path + `/campaigns/${huge.id}/preview`, 'POST', {})).status, 400);
    const campaign = await f.draft(); await f.arm(campaign);
    const detail = (await f.request(f.path + '/campaigns/' + campaign.id)).data, delivery = detail.deliveries[0]; delivery.status = 'sending'; f.app.db.prepare('UPDATE direct_deliveries SET data=? WHERE id=?').run(JSON.stringify(delivery), delivery.id);
    const raw = JSON.parse(f.app.db.prepare('SELECT data FROM direct_campaigns WHERE id=?').get(campaign.id).data); raw.status = 'sending'; f.app.db.prepare('UPDATE direct_campaigns SET data=? WHERE id=?').run(JSON.stringify(raw), campaign.id);
    const recovered = createDirectCampaigns({ db: f.app.db, env: f.env, appUrl: f.origin, secret: f.app.config.sessionSecret, store: f.app.store }); await recovered.processPending(); recovered.close();
    const result = (await f.request(f.path + '/campaigns/' + campaign.id)).data; assert.equal(result.campaign.status, 'attention'); assert.equal(result.deliveries[0].status, 'uncertain'); assert.equal(f.messages.size, 0);
  } finally { await f.close(); }
});

test('late refreshes cannot restart an uncertain broadcast or revert a concurrently scheduled email draft', async () => {
  const f = await fixture(); let releaseSend = () => {}, releaseRefresh = () => {}, releaseEmail = () => {};
  try {
    await f.person(); const campaign = await f.draft({ channel: 'whatsapp', accountId: 'wa-direct', templateName: 'appointment_update', templateLanguage: 'en' }); await f.arm(campaign);
    let sendStarted, refreshStarted, sends = 0, heldRefresh = false;
    const sendEntered = new Promise(resolve => { sendStarted = resolve; }), sendGate = new Promise(resolve => { releaseSend = resolve; }), refreshEntered = new Promise(resolve => { refreshStarted = resolve; }), refreshGate = new Promise(resolve => { releaseRefresh = resolve; });
    f.setHook(async (url, options) => {
      if (url.hostname === 'zernio.com' && url.pathname.endsWith('/send') && ++sends === 1) { sendStarted(); await sendGate; throw new Error('Lost acknowledgement'); }
      if (url.pathname.endsWith('/recipients') && options.method === 'GET' && sends && !heldRefresh) { heldRefresh = true; refreshStarted(); await refreshGate; }
    });
    const worker = f.app.direct.processPending(); await sendEntered;
    const refreshing = f.request(f.path + `/campaigns/${campaign.id}/refresh`, 'POST', {}); await refreshEntered;
    releaseSend(); await worker; const uncertain = (await f.request(f.path + '/campaigns/' + campaign.id)).data.campaign; assert.equal(uncertain.status, 'attention');
    releaseRefresh(); const refreshed = await refreshing; assert.equal(refreshed.status, 200); assert.equal(refreshed.data.campaign.status, 'attention'); assert.equal(refreshed.data.campaign.phase, uncertain.phase); assert.equal(refreshed.data.campaign.lastError, uncertain.lastError);
    await f.app.direct.processPending(); assert.equal(sends, 1, 'A stale provider refresh must not rearm an unconfirmed send.');
    const email = await f.draft({ channel: 'email', subject: 'Requested receipt', text: 'Your requested receipt.' });
    let emailStarted; const emailEntered = new Promise(resolve => { emailStarted = resolve; }), emailGate = new Promise(resolve => { releaseEmail = resolve; });
    f.setHook(async url => { if (url.pathname.endsWith('/suppressions')) { emailStarted(); await emailGate; } });
    const emailRefresh = f.request(f.path + `/campaigns/${email.id}/refresh`, 'POST', {}); await emailEntered; assert.equal((await f.arm(email, 'schedule')).status, 200);
    releaseEmail(); const scheduled = await emailRefresh; assert.equal(scheduled.data.campaign.status, 'scheduled'); assert.equal(scheduled.data.deliveries[0].status, 'pending');
  } finally { releaseSend(); releaseRefresh(); releaseEmail(); await f.close(); }
});

test('a late WhatsApp refresh preserves a newer provider receipt and terminal delivery evidence', async () => {
  const f = await fixture(); let release = () => {};
  try {
    await f.person(); const campaign = await f.draft({ channel: 'whatsapp', accountId: 'wa-direct', templateName: 'appointment_update', templateLanguage: 'en' }); await f.arm(campaign); await f.app.direct.processPending();
    const broadcast = [...f.broadcasts.values()][0]; let oldRead = true, entered;
    const reached = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    f.setHook(async (url, options) => {
      if (oldRead && url.pathname.endsWith('/broadcasts/' + broadcast.id)) return Response.json({ success: true, broadcast: { ...broadcast, status: 'sending', recipientCount: 1, sentCount: 0, deliveredCount: 0 } });
      if (oldRead && url.pathname.endsWith('/recipients') && options.method === 'GET') { oldRead = false; entered(); await gate; return Response.json({ success: true, recipients: [{ platformIdentifier: broadcast.phones[0].replace('+', ''), status: 'pending' }], pagination: { hasMore: false } }); }
    });
    const stale = f.request(f.path + `/campaigns/${campaign.id}/refresh`, 'POST', {}); await reached; broadcast.sentCount = 1; broadcast.deliveredCount = 1;
    const fresh = await f.request(f.path + `/campaigns/${campaign.id}/refresh`, 'POST', {}); assert.equal(fresh.data.campaign.providerStatus, 'completed'); assert.equal(fresh.data.campaign.stats.deliveredCount, 1);
    release(); const result = await stale; assert.equal(result.data.campaign.providerStatus, 'completed'); assert.equal(result.data.campaign.stats.deliveredCount, 1); assert.equal(result.data.deliveries[0].status, 'delivered');
  } finally { release(); await f.close(); }
});

test('manual provider cancellation and refresh recheck the requester without requiring the original author', async () => {
  const f = await fixture(); let releaseCancel = () => {}, releaseSms = () => {};
  try {
    await f.person(); const campaign = await f.draft({ channel: 'whatsapp', accountId: 'wa-direct', templateName: 'appointment_update', templateLanguage: 'en' }); await f.arm(campaign);
    f.setHook(url => { if (url.hostname === 'zernio.com' && url.pathname.endsWith('/send')) { const broadcast = [...f.broadcasts.values()][0]; broadcast.status = 'sending'; return Response.json({ success: true, status: 'sending', sent: 0, failed: 0, recipientCount: broadcast.phones.length }); } });
    await f.app.direct.processPending();
    const raw = JSON.parse(f.app.db.prepare('SELECT data FROM direct_campaigns WHERE id=?').get(campaign.id).data); raw.scheduledBy = 'former-author'; f.app.db.prepare('UPDATE direct_campaigns SET data=? WHERE id=?').run(JSON.stringify(raw), campaign.id);
    let cancelStarted, held = false; const cancelEntered = new Promise(resolve => { cancelStarted = resolve; }), cancelGate = new Promise(resolve => { releaseCancel = resolve; });
    f.setHook(async url => { if (url.pathname.endsWith('/accounts') && !held) { held = true; cancelStarted(); await cancelGate; } });
    const cancelling = f.request(f.path + `/campaigns/${campaign.id}/cancel`, 'POST', {}); await cancelEntered; f.app.db.prepare("UPDATE memberships SET role='viewer'").run(); releaseCancel();
    assert.equal((await cancelling).status, 403); assert.equal(f.calls.filter(call => call.url.endsWith('/cancel')).length, 0, 'Demotion during account verification must stop the provider cancellation.');
    f.app.db.prepare("UPDATE memberships SET role='owner'").run(); f.setHook(null);
    const retry = await f.request(f.path + `/campaigns/${campaign.id}/cancel`, 'POST', {}); assert.equal(retry.status, 200); assert.equal(retry.data.campaign.providerStatus, 'cancelled', 'An authorized administrator can reconcile a campaign whose author has left.');
    const sms = await f.draft(); await f.arm(sms); await f.app.direct.processPending();
    let smsStarted; const smsEntered = new Promise(resolve => { smsStarted = resolve; }), smsGate = new Promise(resolve => { releaseSms = resolve; });
    f.setHook(async (url, options) => { if (url.hostname === 'api.twilio.com' && options.method === 'GET') { smsStarted(); await smsGate; } });
    const refreshing = f.request(f.path + `/campaigns/${sms.id}/refresh`, 'POST', {}); await smsEntered; f.app.db.prepare("UPDATE memberships SET role='viewer'").run(); releaseSms();
    const denied = await refreshing; assert.equal(denied.status, 403); assert.equal(denied.data.deliveries, undefined, 'Revoked manual access must not expose an awaited provider receipt.');
  } finally { releaseCancel(); releaseSms(); await f.close(); }
});

test('SMS delivery refresh preserves the original sender and service when the provider returns conflicting routing', async () => {
  const f = await fixture();
  try {
    await f.person(); const campaign = await f.draft(); await f.arm(campaign); await f.app.direct.processPending();
    const original = (await f.request(f.path + '/campaigns/' + campaign.id)).data.deliveries[0];
    for (const routing of [{ from: '+12025550999' }, { from: f.env.TWILIO_FROM_NUMBER, messaging_service_sid: 'MG' + '9'.repeat(32) }]) {
      f.setHook(async (url, options) => { if (url.hostname === 'api.twilio.com' && options.method === 'GET') return Response.json({ ...f.messages.get(original.providerId), status: 'delivered', ...routing }); });
      const result = await f.request(f.path + `/campaigns/${campaign.id}/refresh`, 'POST', {});
      assert.equal(result.status, 502, 'A routing mismatch cannot reattribute a campaign delivery or create another reply thread.');
      const saved = (await f.request(f.path + '/campaigns/' + campaign.id)).data.deliveries[0];
      assert.deepEqual(saved, original);
    }
    f.setHook(async (url, options) => { if (url.hostname === 'api.twilio.com' && options.method === 'GET') return Response.json({ ...f.messages.get(original.providerId), from: f.env.TWILIO_FROM_NUMBER, status: 'delivered' }); });
    const result = await f.request(f.path + `/campaigns/${campaign.id}/refresh`, 'POST', {});
    assert.equal(result.status, 200); assert.equal(result.data.deliveries[0].status, 'delivered'); assert.equal(result.data.deliveries[0].smsSender, original.smsSender);
  } finally { await f.close(); }
});
