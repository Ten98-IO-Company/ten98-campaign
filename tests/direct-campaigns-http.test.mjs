import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, randomUUID } from 'node:crypto';
import { estimateSms, createDirectCampaigns } from '../server/direct-campaigns.ts';
import { postgresSkip, singleConnection, testApp } from './postgres.mjs';
import { firstProject } from './first-project.ts';

const pg = { skip: postgresSkip };

async function fixture(t, poolOptions) {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-direct-')), origin = 'https://campaign.example.test';
  const env = { TWILIO_ACCOUNT_SID: 'AC' + '1'.repeat(32), TWILIO_AUTH_TOKEN: 'test-twilio-secret', TWILIO_FROM_NUMBER: '+12025550100', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_EMAIL_API_TOKEN: 'test-cloudflare-token', CLOUDFLARE_EMAIL_FROM_ADDRESS: 'receipts@example.com', ZERNIO_API_KEY: 'test-zernio-key' };
  const app = await testApp(t, { dataDir, env, appUrl: origin, directScheduler: false }, poolOptions), originalFetch = globalThis.fetch;
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
      if (url.pathname.endsWith('/send')) { const body = JSON.parse(options.body), email = body.to[0]; return json({ success: true, result: { message_id: 'email-' + calls.length, delivered: emailMode === 'delivered' ? [email] : [], queued: emailMode === 'queued' ? [email] : [], permanent_bounces: emailMode === 'bounce' ? [email] : [], suppressed_recipients: emailMode === 'suppressed' ? [email] : [] } }); }
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
  const setup = await request('/api/auth/setup', 'POST', { name: 'QA owner', email: 'direct-owner@example.test', password: 'fixture-passphrase-long-enough' }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); cookie = setup.cookie;
  const projectId = setup.data.projectId, path = `/api/projects/${projectId}/direct`;
  await request(`/api/projects/${projectId}`, 'PATCH', { zernioProfileId: 'profile-direct' });
  const person = async (fields = {}) => { const result = await request(path + '/contacts', 'POST', { name: 'Alex', email: 'alex@example.com', phone: '+12025550123', consents: { email: true, sms: true, whatsapp: true }, consentSource: 'Customer request, recorded in CRM', ...fields }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.contact; };
  const draft = async (fields = {}) => { const result = await request(path + '/campaigns', 'POST', { name: 'Appointment notice', channel: 'sms', text: 'Hello {{name}}, your appointment is tomorrow.', ...fields }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.campaign; };
  const arm = async (campaign, action = 'send', fields = {}) => { const preview = await request(path + `/campaigns/${campaign.id}/preview`, 'POST', {}); if (preview.status !== 200) return preview; return request(path + `/campaigns/${campaign.id}/${action}`, 'POST', { confirmed: true, transactionalConfirmed: true, previewToken: preview.data.previewToken, ...(action === 'schedule' ? { scheduledAt: new Date(Date.now() + 3600000).toISOString() } : {}), ...fields }); };
  async function twilio(urlPath, fields, valid = true) {
    const form = new URLSearchParams({ AccountSid: env.TWILIO_ACCOUNT_SID, ...fields }), payload = origin + urlPath + [...form.keys()].sort().map(key => key + form.get(key)).join(''), signature = valid ? createHmac('sha1', env.TWILIO_AUTH_TOKEN).update(payload).digest('base64') : 'invalid';
    const response = await originalFetch(base + urlPath, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': signature }, body: form }); return { status: response.status, body: await response.text() };
  }
  return { app, env, origin, base, path, projectId, calls, messages, broadcasts, request, person, draft, arm, twilio, setHook(value) { hook = value; }, setEmailMode(value) { emailMode = value; }, setSuppressions(value) { suppressions = value; }, async close() { globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); } };
}

test('SMS campaigns persist schedules, deduplicate sends, validate audiences, deliver signed callbacks and honor STOP', pg, async t => {
  const f = await fixture(t);
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

test('consent and contact changes leave an Activity entry naming who made them, without the contact details', pg, async t => {
  const f = await fixture(t), { pool } = f.app.database;
  try {
    const messages = async () => (await pool.query('SELECT message FROM activity WHERE project_id = $1', [f.projectId])).rows.map(row => row.message);
    const before = new Set(await messages());
    const kept = await f.person({ email: 'kept@example.com', phone: '+12025550151' });
    assert.equal((await f.request(f.path + '/contacts/' + kept.id, 'PATCH', { consents: { sms: false } })).status, 200);
    assert.equal((await f.request(f.path + '/contacts/' + kept.id + '/suppress', 'POST', { channel: 'email', reason: 'Asked to stop by phone' })).status, 200);
    assert.equal((await f.request(f.path + '/contacts/import', 'POST', { csv: 'name,email\nImported,imported@example.com\n' })).status, 200);
    const gone = await f.person({ email: 'gone@example.com', phone: '+12025550152' });
    assert.equal((await f.request(f.path + '/contacts/' + gone.id, 'DELETE')).status, 200);
    const draft = await f.draft({ contactIds: [kept.id] });
    assert.equal((await f.request(f.path + '/campaigns/' + draft.id + '/cancel', 'POST', {})).status, 200);
    const added = (await messages()).filter(message => !before.has(message)), ref = id => 'contact ' + id.slice(0, 8);
    for (const expected of [
      'Permission recorded for ' + ref(kept.id) + ' by ',
      'Permission changed for ' + ref(kept.id) + ' by ',
      'Suppressed ' + ref(kept.id) + ' for email by ',
      'Contacts imported from CSV by ',
      'Deleted ' + ref(gone.id) + ' by ',
      'Direct campaign "' + draft.name + '" cancelled by ',
    ]) assert.ok(added.some(message => message.startsWith(expected)), expected + ' in ' + JSON.stringify(added));
    assert.ok(added.some(message => /^Permission changed for .+: SMS off\.$/.test(message)), 'The change lists the channel and its new state.');
    assert.equal(added.some(message => /kept@example|gone@example|imported@example|\+1202555|Asked to stop/.test(message)), false, 'No contact details or reasons in Activity.');
  } finally { await f.close(); }
});

test('adding a contact whose email already exists is refused and leaves the existing contact unchanged', pg, async t => {
  const f = await fixture(t);
  try {
    const first = await f.person({ name: 'Original Name', email: 'same@example.com', phone: '+12025550161' });
    const response = await f.request(f.path + '/contacts', 'POST', { name: 'Someone Else', email: 'SAME@example.com' });
    assert.equal(response.status, 409, JSON.stringify(response.data)); assert.match(response.data.error.message || response.data.error, /already exists/);
    const stored = (await f.request(f.path + '/contacts')).data.contacts.find(contact => contact.id === first.id);
    assert.equal(stored.name, 'Original Name', 'The existing contact is not renamed.');
    assert.equal((await f.request(f.path + '/contacts/' + first.id, 'PATCH', { name: 'Renamed On Purpose' })).status, 200, 'Editing the contact itself still works.');
  } finally { await f.close(); }
});

test('a draft is saved only with contacts of its own project', pg, async t => {
  const f = await fixture(t);
  try {
    const known = await f.person({ phone: '+12025550141' });
    let response = await f.request(f.path + '/campaigns', 'POST', { name: 'Notice', channel: 'sms', text: 'Hello', contactIds: [known.id, 'another-project-contact'] });
    assert.equal(response.status, 400, JSON.stringify(response.data)); assert.equal(response.data.error.code, 'CONTACT_NOT_FOUND');
    const draft = await f.draft({ contactIds: [known.id] });
    response = await f.request(f.path + '/campaigns/' + draft.id, 'PATCH', { contactIds: [known.id, 'another-project-contact'] });
    assert.equal(response.status, 400, JSON.stringify(response.data)); assert.equal(response.data.error.code, 'CONTACT_NOT_FOUND');
    assert.equal((await f.request(f.path + '/campaigns/' + draft.id, 'PATCH', { name: 'Renamed' })).status, 200, 'An edit that leaves the contacts alone still saves.');
  } finally { await f.close(); }
});

test('a draft refuses any foreign contact id: alone, swapped in on edit, and without storing a refused draft', pg, async t => {
  const f = await fixture(t), { pool } = f.app.database;
  try {
    const drafts = async () => Number((await pool.query('SELECT count(*)::int AS n FROM direct_campaigns WHERE project_id = $1', [f.projectId])).rows[0].n);
    const known = await f.person({ email: 'own@example.com', phone: '+12025550171' }), other = await f.person({ email: 'other@example.com', phone: '+12025550172' });
    const before = await drafts();
    let response = await f.request(f.path + '/campaigns', 'POST', { name: 'Notice', channel: 'sms', text: 'Hello', contactIds: ['foreign-contact-id'] });
    assert.equal(response.status, 400); assert.equal(response.data.error.code, 'CONTACT_NOT_FOUND');
    assert.equal(await drafts(), before, 'A refused create stores nothing.');
    const draft = await f.draft({ contactIds: [known.id, other.id] });
    // Same length, one id swapped for a foreign one: refused, and the stored contacts are unchanged.
    response = await f.request(f.path + '/campaigns/' + draft.id, 'PATCH', { contactIds: [known.id, 'foreign-contact-id'] });
    assert.equal(response.status, 400); assert.equal(response.data.error.code, 'CONTACT_NOT_FOUND');
    assert.deepEqual((await f.request(f.path + '/campaigns/' + draft.id)).data.campaign.contactIds, [known.id, other.id]);
    // A contact deleted after it was chosen: the draft can still be edited to drop it.
    assert.equal((await f.request(f.path + '/contacts/' + other.id, 'DELETE')).status, 200);
    assert.equal((await f.request(f.path + '/campaigns/' + draft.id, 'PATCH', { name: 'Still editable' })).status, 200, 'Edits that leave the contacts alone still save.');
    assert.equal((await f.request(f.path + '/campaigns/' + draft.id, 'PATCH', { contactIds: [known.id] })).status, 200, 'The deleted contact can be cleared.');
  } finally { await f.close(); }
});

test('a consent change and its Activity entry are stored together: when the entry cannot be written, nothing changes', pg, async t => {
  const f = await fixture(t), { pool } = f.app.database;
  try {
    const kept = await f.person({ email: 'atomic@example.com', phone: '+12025550181' }), draft = await f.draft({ contactIds: [kept.id] });
    const count = async () => Number((await pool.query('SELECT count(*)::int AS n FROM direct_contacts WHERE project_id = $1', [f.projectId])).rows[0].n), contacts = await count();
    await pool.query("CREATE FUNCTION refuse_activity() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'activity unavailable'; END $$ LANGUAGE plpgsql");
    await pool.query('CREATE TRIGGER refuse_activity BEFORE INSERT ON activity FOR EACH ROW EXECUTE FUNCTION refuse_activity()');
    const refused = async (path, method, body) => { const response = await f.request(f.path + path, method, body); assert.ok(response.status >= 500, method + ' ' + path + ' ' + response.status); };
    await refused('/contacts/' + kept.id, 'PATCH', { consents: { sms: false } });
    await refused('/contacts/' + kept.id + '/suppress', 'POST', { channel: 'email', reason: 'Asked to stop' });
    await refused('/contacts/import', 'POST', { csv: 'name,email\nNew Person,new-person@example.com\n', consents: { email: true }, consentSource: 'Signup sheet' });
    await refused('/contacts/' + kept.id, 'DELETE');
    await refused('/campaigns/' + draft.id + '/cancel', 'POST', {});
    await pool.query('DROP TRIGGER refuse_activity ON activity');
    const stored = (await f.request(f.path + '/contacts')).data.contacts.find(contact => contact.id === kept.id);
    assert.ok(stored, 'The contact was not deleted.'); assert.equal(stored.consents.sms, true, 'SMS permission is unchanged.');
    assert.equal(stored.suppression?.email, undefined, 'The contact was not suppressed.');
    assert.equal(await count(), contacts, 'The import stored no contact.');
    assert.equal((await f.request(f.path + '/campaigns/' + draft.id)).data.campaign.status, 'draft', 'The campaign was not cancelled.');
  } finally { await f.close(); }
});

test('Activity records a consent or contact change only when one happened, and names what changed', pg, async t => {
  const f = await fixture(t), { pool } = f.app.database;
  try {
    const messages = async () => (await pool.query('SELECT message FROM activity WHERE project_id = $1 ORDER BY seq', [f.projectId])).rows.map(row => row.message);
    const kept = await f.person({ email: 'noop@example.com', phone: '+12025550182' }), draft = await f.draft({ name: 'Spring notice', contactIds: [kept.id] }), before = (await messages()).length;
    // Adding a contact whose email already exists is refused, so it can neither withdraw permission nor log a change.
    const again = await f.request(f.path + '/contacts', 'POST', { email: 'noop@example.com', consents: { email: false } });
    assert.equal(again.status, 409);
    assert.equal((await f.request(f.path + '/contacts')).data.contacts.find(contact => contact.id === kept.id).consents.email, true);
    assert.equal((await f.request(f.path + '/contacts/' + kept.id, 'PATCH', { consents: kept.consents })).status, 200);
    for (let i = 0; i < 2; i++) assert.equal((await f.request(f.path + '/contacts/' + kept.id + '/suppress', 'POST', { channel: 'email', reason: 'Asked to stop' })).status, 200);
    for (let i = 0; i < 2; i++) assert.equal((await f.request(f.path + '/campaigns/' + draft.id + '/cancel', 'POST', {})).status, 200);
    assert.equal((await f.request(f.path + '/contacts/import', 'POST', { csv: 'name,email\nListed,listed@example.com\n', consents: { email: true, sms: false }, consentSource: 'Signup sheet' })).status, 200);
    const added = (await messages()).slice(before);
    assert.equal(added.filter(message => message.startsWith('Suppressed ')).length, 1, 'A second suppression changes nothing: ' + JSON.stringify(added));
    assert.equal(added.filter(message => message.startsWith('Direct campaign ')).length, 1, 'A second cancel changes nothing: ' + JSON.stringify(added));
    assert.equal(added.some(message => message.startsWith('Permission ')), false, 'Neither the refused add nor an unchanged edit is logged.');
    assert.ok(added.some(message => /^Direct campaign "Spring notice" cancelled by .+\.$/.test(message)), 'The cancel entry names the campaign: ' + JSON.stringify(added));
    assert.ok(added.some(message => /^Contacts imported from CSV by .+: 1 created, 0 updated, 0 skipped\. Permission recorded for email\.$/.test(message)), 'The import entry names the permissions it recorded: ' + JSON.stringify(added));
    assert.equal(added.some(message => /listed@example|Signup sheet/.test(message)), false, 'No contact details or free text in Activity.');
  } finally { await f.close(); }
});

test('a contact of another project or another workspace cannot be chosen for a draft, in any position, on create or edit', pg, async t => {
  const f = await fixture(t), { pool } = f.app.database;
  try {
    const workspaceId = (await pool.query('SELECT workspace_id FROM projects WHERE id = $1', [f.projectId])).rows[0].workspace_id;
    const sameWorkspace = await f.request('/api/projects', 'POST', { name: 'Second brand', workspaceId }); assert.equal(sameWorkspace.status, 201, JSON.stringify(sameWorkspace.data));
    const otherWorkspace = await f.request('/api/workspaces', 'POST', { name: 'Separate company' }); assert.ok(otherWorkspace.data.projectId, JSON.stringify(otherWorkspace.data));
    const foreign = [];
    for (const [projectId, email] of [[sameWorkspace.data.project.id, 'other-brand@example.com'], [otherWorkspace.data.projectId, 'other-company@example.com']]) {
      const created = await f.request('/api/projects/' + projectId + '/direct/contacts', 'POST', { name: 'Foreign', email, consents: { sms: true }, consentSource: 'Signup sheet' });
      assert.equal(created.status, 201, JSON.stringify(created.data)); foreign.push(created.data.contact.id);
    }
    const own = await f.person({ email: 'own-brand@example.com', phone: '+12025550191' }), second = await f.person({ email: 'own-second@example.com', phone: '+12025550192' });
    const drafts = async () => Number((await pool.query('SELECT count(*)::int AS n FROM direct_campaigns WHERE project_id = $1', [f.projectId])).rows[0].n);
    const draft = await f.draft({ contactIds: [own.id, second.id] }), before = await drafts();
    for (const id of foreign) {
      let response = await f.request(f.path + '/campaigns', 'POST', { name: 'Notice', channel: 'sms', text: 'Hello', contactIds: [id, own.id] });
      assert.equal(response.status, 400, JSON.stringify(response.data)); assert.equal(response.data.error.code, 'CONTACT_NOT_FOUND');
      // Same length as the stored list, the foreign id first.
      response = await f.request(f.path + '/campaigns/' + draft.id, 'PATCH', { contactIds: [id, second.id] });
      assert.equal(response.status, 400, JSON.stringify(response.data)); assert.equal(response.data.error.code, 'CONTACT_NOT_FOUND');
    }
    assert.equal(await drafts(), before, 'No refused draft is stored.');
    assert.deepEqual((await f.request(f.path + '/campaigns/' + draft.id)).data.campaign.contactIds, [own.id, second.id], 'The stored contacts are unchanged.');
  } finally { await f.close(); }
});

test('a contact deleted while it is being edited stays deleted', pg, async t => {
  const f = await fixture(t);
  try {
    for (let round = 0; round < 10; round++) {
      const contact = await f.person({ email: 'race' + round + '@example.com', phone: '+1202555' + String(3000 + round) });
      const [edited, deleted] = await Promise.all([
        f.request(f.path + '/contacts/' + contact.id, 'PATCH', round % 2 ? { name: 'Renamed' } : { consents: { email: true, sms: false } }),
        f.request(f.path + '/contacts/' + contact.id, 'DELETE'),
      ]);
      assert.equal(deleted.status, 200);
      assert.ok([200, 404].includes(edited.status), 'The edit either ran first or found the contact gone: ' + edited.status);
      assert.equal((await f.request(f.path + '/contacts')).data.contacts.some(item => item.id === contact.id), false, 'Round ' + round + ': the deleted contact did not come back.');
    }
  } finally { await f.close(); }
});

test('a change that fails at commit leaves no Activity entry, and nothing that changed nothing is logged', pg, async t => {
  const f = await fixture(t), { pool } = f.app.database;
  try {
    const messages = async () => (await pool.query('SELECT message FROM activity WHERE project_id = $1 ORDER BY seq', [f.projectId])).rows.map(row => row.message);
    const kept = await f.person({ email: 'commit@example.com', phone: '+12025550241' }), draft = await f.draft({ contactIds: [kept.id] });
    const before = (await messages()).length;
    // A deferred check fails each change at commit, after its Activity entry was written in the same transaction.
    await pool.query("CREATE FUNCTION refuse_at_commit() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'refused at commit'; END $$ LANGUAGE plpgsql");
    for (const table of ['direct_contacts', 'direct_campaigns']) await pool.query('CREATE CONSTRAINT TRIGGER refuse_at_commit AFTER INSERT OR UPDATE OR DELETE ON ' + table + ' DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION refuse_at_commit()');
    for (const [path, method, body] of [['/contacts/' + kept.id, 'PATCH', { consents: { sms: false } }], ['/contacts/' + kept.id + '/suppress', 'POST', { channel: 'email', reason: 'Asked to stop' }], ['/contacts/import', 'POST', { csv: 'name,email\nNew,new-commit@example.com\n', consents: { email: true }, consentSource: 'Sheet' }], ['/contacts/' + kept.id, 'DELETE'], ['/campaigns/' + draft.id + '/cancel', 'POST', {}]])
      assert.ok((await f.request(f.path + path, method, body)).status >= 500, method + ' ' + path);
    for (const table of ['direct_contacts', 'direct_campaigns']) await pool.query('DROP TRIGGER refuse_at_commit ON ' + table);
    assert.deepEqual((await messages()).slice(before), [], 'No entry outlives its failed change.');
    // Nothing removed, a dry run, nothing imported: no entry.
    assert.equal((await f.request(f.path + '/contacts/no-such-contact', 'DELETE')).status, 404);
    assert.equal((await f.request(f.path + '/contacts/import', 'POST', { csv: 'name,email\nDry,dry@example.com\n', dryRun: true })).status, 200);
    assert.equal((await f.request(f.path + '/contacts/import', 'POST', { csv: 'name,email\nBroken,not-an-email\n' })).status, 200);
    assert.deepEqual((await messages()).slice(before), []);
    // An opt-in imported onto a suppressed address is not stored, and the entry does not claim it was.
    assert.equal((await f.request(f.path + '/contacts/' + kept.id + '/suppress', 'POST', { channel: 'email', reason: 'Asked to stop' })).status, 200);
    assert.equal((await f.request(f.path + '/contacts/import', 'POST', { csv: 'name,email\nKept,commit@example.com\n', consents: { email: true }, consentSource: 'Sheet' })).status, 200);
    const entry = (await messages()).find(message => message.startsWith('Contacts imported'));
    assert.ok(entry && !entry.includes('Permission recorded for email'), entry);
  } finally { await f.close(); }
});

test('scheduling a campaign re-checks its preview on the queuing transaction, without a second connection', pg, async t => {
  // One pool connection: a preview read through the pool inside the queuing transaction would time out. The sending
  // worker is left out because its lease transaction deliberately works on other connections.
  const f = await fixture(t, singleConnection);
  try {
    await f.person(); const campaign = await f.draft();
    const scheduled = await f.arm(campaign, 'schedule'); assert.equal(scheduled.status, 200, JSON.stringify(scheduled.data)); assert.equal(scheduled.data.campaign.status, 'scheduled');
    assert.equal(scheduled.data.deliveries.length, 1); assert.equal(f.messages.size, 0, 'Scheduling sends nothing.');
  } finally { await f.close(); }
});

test('a scheduler tick reads only due campaigns and the next pending delivery, whatever the history size', pg, async t => {
  const f = await fixture(t);
  try {
    await f.person(); const campaign = await f.draft();
    assert.equal((await f.arm(campaign, 'send')).data.campaign.status, 'scheduled');
    // The first tick also runs the one-time restart recovery; nothing is due yet, so it sends nothing.
    await f.app.direct.processPending({ now: 0 }); assert.equal(f.messages.size, 0);
    // History the tick must not read: finished campaigns in the project and delivered rows of this campaign.
    const { pool } = f.app.database;
    await pool.query(`INSERT INTO direct_campaigns (id, project_id, data) SELECT 'done-' || n, $1, json_build_object('status', 'completed', 'scheduledAt', '2026-01-01T00:00:00Z') FROM generate_series(1, 300) n`, [f.projectId]);
    await pool.query(`INSERT INTO direct_deliveries (id, campaign_id, contact_id, data) SELECT 'sent-' || n, $1, 'contact-' || n, json_build_object('status', 'delivered') FROM generate_series(1, 300) n`, [campaign.id]);
    let rows = 0; const query = pool.query;
    pool.query = async (...args) => { const result = await query.apply(pool, args); rows += result?.rows?.length || 0; return result; };
    try { await f.app.direct.processPending({ now: Date.now() + 7200000 }); } finally { pool.query = query; }
    assert.equal(f.messages.size, 1, 'The due campaign still sends its pending message.');
    assert.ok(rows < 60, `One tick read ${rows} rows; loading every campaign or delivery reads more than 600.`);
  } finally { await f.close(); }
});

test('a complaint recorded at Cloudflare before the first email send stops that send without a manual refresh', pg, async t => {
  const f = await fixture(t);
  try {
    const contact = await f.person(), campaign = await f.draft({ channel: 'email', emailPurpose: 'transactional', subject: 'Receipt for {{name}}', text: 'Your requested receipt.' });
    assert.equal((await f.arm(campaign, 'send', { transactionalConfirmed: true })).data.campaign.status, 'scheduled');
    f.setSuppressions([{ id: 'suppression-complaint', email: contact.email, reason: 'complaint', scope: { type: 'account' }, expires_at: null }]);
    await f.app.direct.processPending({ now: Date.now() + 7200000 });
    assert.equal(f.calls.filter(call => call.url.endsWith('/email/sending/send')).length, 0, 'No email reaches Cloudflare for a complained-about recipient.');
    assert.equal(f.calls.filter(call => call.url.includes('/suppressions')).length, 1);
    const detail = await f.request(f.path + `/campaigns/${campaign.id}`); assert.equal(detail.data.deliveries[0].status, 'suppressed');
  } finally { await f.close(); }
});

test('a test send reaches only the user or one consented contact, once per key, and leaves the draft unchanged', pg, async t => {
  const f = await fixture(t);
  try {
    const consented = await f.person(), refused = await f.person({ name: 'No SMS', email: 'no-sms@example.com', phone: '+12025550124', consents: { email: true, sms: false, whatsapp: false } });
    const sends = () => f.calls.filter(call => call.method === 'POST' && (call.url.endsWith('/Messages.json') || call.url.endsWith('/email/sending/send'))).length;
    const test = (campaign, body, key = 'test-send-' + Math.random().toString(36).slice(2)) => f.request(f.path + `/campaigns/${campaign.id}/test`, 'POST', body, { headers: { 'Idempotency-Key': key } });
    const sms = await f.draft();
    assert.equal((await test(sms, { contactId: consented.id })).status, 400, 'An unconfirmed test sends nothing.');
    assert.equal((await test(sms, { confirmed: true, contactId: refused.id })).data.error.code, 'INVALID_TEST_RECIPIENT');
    assert.equal((await test(sms, { confirmed: true })).data.error.code, 'INVALID_TEST_RECIPIENT');
    assert.equal(sends(), 0);
    let result = await test(sms, { confirmed: true, contactId: consented.id }, 'test-send-sms-1'); assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(result.data.test.recipient, consented.phone); assert.equal(sends(), 1);
    assert.equal((await test(sms, { confirmed: true, contactId: consented.id }, 'test-send-sms-1')).status, 200); assert.equal(sends(), 1, 'A retried key sends nothing more.');
    const mail = await f.draft({ channel: 'email', emailPurpose: 'transactional', subject: 'Receipt for {{name}}', text: 'Your requested receipt.' });
    assert.equal((await test(mail, { confirmed: true, contactId: consented.id })).data.error.code, 'INVALID_TEST_RECIPIENT', 'Email tests go only to the signed-in user.');
    result = await test(mail, { confirmed: true }); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.test.recipient, 'direct-owner@example.test');
    const payload = JSON.parse(f.calls.filter(call => call.url.endsWith('/email/sending/send')).at(-1).body); assert.deepEqual(payload.to, ['direct-owner@example.test']); assert.match(payload.subject, /Receipt for QA owner/);
    assert.equal(sends(), 2);
    for (const draft of [sms, mail]) { const detail = await f.request(f.path + `/campaigns/${draft.id}`); assert.equal(detail.data.campaign.status, 'draft'); assert.equal(detail.data.deliveries.length, 0); }
    for (let index = 0; index < 8; index++) assert.equal((await test(sms, { confirmed: true, contactId: consented.id })).status, 200);
    assert.equal((await test(sms, { confirmed: true, contactId: consented.id })).data.error.code, 'TEST_SEND_LIMIT'); assert.equal(sends(), 10);
  } finally { await f.close(); }
});

test('Cloudflare email enforces transactional purpose, reports true receipts, appends unsubscribe and preserves bounce suppressions', pg, async t => {
  const f = await fixture(t);
  try {
    const contact = await f.person();
    // A marketing draft saves, but Cloudflare cannot send it (#137): preview is refused until Amazon SES is the sender.
    const newsletter = await f.request(f.path + '/campaigns', 'POST', { name: 'Newsletter', channel: 'email', emailPurpose: 'marketing', subject: 'Sale', text: 'Sale' }); assert.equal(newsletter.status, 201);
    assert.equal((await f.request(f.path + `/campaigns/${newsletter.data.campaign.id}/preview`, 'POST', {})).data.error.code, 'MARKETING_PROVIDER_REQUIRED');
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

// ten98-campaign#77: Cloudflare lists soft bounces and some hard bounces with an expiry. Campaign holds those contacts only
// until then and keeps their consent; a `policy` row (undefined by Cloudflare, possibly sender-side) raises an alert instead.
// Cloudflare can list one address under two scopes; the first listed row decides, as the original search did (#97 review).
test('an address Cloudflare lists twice takes the reason of its first row', pg, async t => {
  const f = await fixture(t);
  try {
    const twice = await f.person({ email: 'twice@example.com', phone: '+12025550141' });
    f.setSuppressions([{ id: 'd1', email: twice.email, reason: 'complaint', scope: { type: 'account' }, expires_at: null }, { id: 'd2', email: twice.email, reason: 'hard_bounce', scope: { type: 'sending_domain', value: 'example.com' }, expires_at: null }]);
    const draft = await f.draft({ channel: 'email', subject: 'Service', text: 'Service', contactIds: [twice.id] });
    assert.equal((await f.request(f.path + `/campaigns/${draft.id}/refresh`, 'POST', {})).status, 200);
    assert.equal((await f.request(f.path + '/contacts')).data.contacts.find(item => item.id === twice.id).suppression.email.reason, 'complaint');
  } finally { await f.close(); }
});

test('Cloudflare temporary suppressions expire without withdrawing consent, and policy rows alert instead of suppressing', pg, async t => {
  const f = await fixture(t), { pool } = f.app.database;
  try {
    const soft = await f.person({ email: 'soft@example.com', phone: '+12025550131' }), policy = await f.person({ email: 'policy@example.com', phone: '+12025550132' }), complaint = await f.person({ email: 'complaint@example.com', phone: '+12025550133' }), moved = await f.person({ email: 'moved@example.com', phone: '+12025550134' });
    const later = new Date(Date.now() + 86400000).toISOString(), contact = async id => (await f.request(f.path + '/contacts')).data.contacts.find(item => item.id === id);
    const status = async () => (await f.request(f.path + '/status')).data.deliverabilityAlerts;
    f.setSuppressions([{ id: 's1', email: soft.email, reason: 'soft_bounce', scope: { type: 'account' }, expires_at: later }, { id: 's2', email: policy.email, reason: 'policy', scope: { type: 'account' }, expires_at: null }, { id: 's3', email: complaint.email, reason: 'complaint', scope: { type: 'account' }, expires_at: null }, { id: 's5', email: moved.email, reason: 'hard_bounce', scope: { type: 'account' }, expires_at: later }]);
    const draft = await f.draft({ channel: 'email', subject: 'Service', text: 'Service', contactIds: [soft.id, policy.id, complaint.id] });
    assert.equal((await f.request(f.path + `/campaigns/${draft.id}/refresh`, 'POST', {})).status, 200);
    const held = await contact(soft.id);
    assert.equal(held.consents.email, true, 'A temporary provider suppression keeps the consent Campaign did not withdraw.'); assert.ok(held.consentEvidence.email);
    assert.deepEqual([held.suppression.email.reason, held.suppression.email.expiresAt], ['soft_bounce', later]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM direct_contact_suppressions WHERE reason = 'soft_bounce'`)).rows[0].n, 0, 'A temporary suppression is not written to the permanent ledger.');
    const flagged = await contact(policy.id); assert.equal(flagged.consents.email, true); assert.equal(flagged.suppression.email, undefined, 'A policy row does not suppress the recipient.');
    assert.equal((await contact(complaint.id)).consents.email, false, 'Permanent suppressions keep withdrawing consent.');
    assert.deepEqual((await status()).map(({ provider, kind, channel, contacts, expiresAt }) => ({ provider, kind, channel, contacts, expiresAt })), [{ provider: 'cloudflare', kind: 'policy', channel: 'email', contacts: 1, expiresAt: null }]);
    let preview = (await f.request(f.path + `/campaigns/${draft.id}/preview`, 'POST', {})).data.audience;
    assert.deepEqual(preview.exclusions.map(row => [row.id, row.reason]).sort(), [[complaint.id, 'Suppressed: complaint'], [soft.id, 'Suppressed: soft_bounce']].sort());
    // An expiring Cloudflare hard bounce holds the contact only until its expiry: consent stays and the permanent ledger is untouched.
    const bounced = await contact(moved.id); assert.deepEqual([bounced.suppression.email.reason, bounced.suppression.email.expiresAt, bounced.consents.email], ['hard-bounce', later, true]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM direct_contact_suppressions WHERE reason = 'hard-bounce'`)).rows[0].n, 0);
    assert.equal((await f.request(f.path + '/contacts/' + moved.id, 'PATCH', { email: 'moved-new@example.com' })).status, 200); assert.equal((await contact(moved.id)).suppression.email, undefined, 'A temporary hold belongs to the old address.');
    // Editing the contact keeps its consent, and the hold lifts by itself once Cloudflare's expiry passes.
    assert.equal((await f.request(f.path + '/contacts/' + soft.id, 'PATCH', { name: 'Soft changed' })).status, 200); assert.equal((await contact(soft.id)).consents.email, true);
    await pool.query(`UPDATE direct_contacts SET data = jsonb_set(data::jsonb, '{suppression,email,expiresAt}', '"2020-01-01T00:00:00.000Z"')::json WHERE id = $1`, [soft.id]);
    preview = (await f.request(f.path + `/campaigns/${draft.id}/preview`, 'POST', {})).data.audience; assert.deepEqual(preview.exclusions.map(row => row.id), [complaint.id]);
    // A later permanent report replaces the temporary hold, and a policy row Cloudflare no longer lists clears the alert.
    f.setSuppressions([{ id: 's4', email: soft.email, reason: 'complaint', scope: { type: 'account' }, expires_at: null }]);
    assert.equal((await f.request(f.path + `/campaigns/${draft.id}/refresh`, 'POST', {})).status, 200);
    const reported = await contact(soft.id); assert.deepEqual([reported.consents.email, reported.suppression.email.reason, reported.suppression.email.expiresAt], [false, 'complaint', undefined]);
    assert.deepEqual(await status(), []);
    // A suppressed send receipt names no reason or expiry, so it does not suppress the contact locally.
    f.setSuppressions([]); f.setEmailMode('suppressed'); const receipt = await f.draft({ channel: 'email', subject: 'Service', text: 'Service', contactIds: [policy.id] }); assert.equal((await f.arm(receipt)).status, 200); await f.app.direct.processPending();
    assert.equal((await f.request(f.path + `/campaigns/${receipt.id}`)).data.deliveries[0].status, 'suppressed'); assert.equal((await contact(policy.id)).consents.email, true);
  } finally { await f.close(); }
});

// ten98-campaign#136: a WhatsApp draft saves before an account or template is chosen; preview and send require them.
test('a WhatsApp draft saves without an account or template, and preview and send ask for them', pg, async t => {
  const f = await fixture(t);
  try {
    await f.person();
    const created = await f.request(f.path + '/campaigns', 'POST', { name: 'WhatsApp order update', channel: 'whatsapp' });
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.campaign.id;
    assert.equal((await f.request(f.path + `/campaigns/${id}`, 'PATCH', { name: 'WhatsApp order update', channel: 'whatsapp', contactIds: [] })).status, 200, 'Editing the draft still saves.');
    for (const action of ['preview', 'send']) {
      const result = await f.request(f.path + `/campaigns/${id}/${action}`, 'POST', { confirmed: true });
      assert.deepEqual([result.status, result.data.error?.code], [400, 'INVALID_CAMPAIGN'], `${action}: ${JSON.stringify(result.data)}`);
      assert.match(result.data.error.message, /Choose a WhatsApp account, approved template and language/);
    }
    assert.equal(f.calls.some(call => call.url.includes('/whatsapp/')), false, 'Nothing reaches the provider for an incomplete draft.');
  } finally { await f.close(); }
});

// ten98-campaign#216: a message started from a campaign page is linked to that planner campaign, in the same project only.
test('a direct draft keeps the planner campaign it belongs to and refuses one from elsewhere', pg, async t => {
  const f = await fixture(t);
  try {
    const planner = await f.request(`/api/projects/${f.projectId}/campaigns`, 'POST', { name: 'Autumn launch' }); assert.equal(planner.status, 201, JSON.stringify(planner.data));
    const linked = await f.draft({ campaignId: planner.data.record.id }); assert.equal(linked.campaignId, planner.data.record.id);
    assert.equal((await f.request(f.path + `/campaigns/${linked.id}`, 'PATCH', { name: 'Renamed' })).data.campaign.campaignId, planner.data.record.id, 'An edit without the field keeps the link.');
    assert.equal((await f.request(f.path + `/campaigns/${linked.id}`, 'PATCH', { campaignId: '' })).data.campaign.campaignId, '', 'Choosing no campaign clears it.');
    for (const result of [await f.request(f.path + '/campaigns', 'POST', { name: 'Elsewhere', channel: 'sms', text: 'Hello', campaignId: 'not-in-this-project' }), await f.request(f.path + `/campaigns/${linked.id}`, 'PATCH', { campaignId: 'not-in-this-project' })])
      assert.deepEqual([result.status, result.data.error?.code], [400, 'INVALID_CAMPAIGN'], JSON.stringify(result.data));
    assert.equal((await f.draft()).campaignId, '', 'A message without a campaign stays unlinked.');
  } finally { await f.close(); }
});

test('direct schedules reject normalized dates and invalid clock times without queuing recipients', pg, async t => {
  const f = await fixture(t);
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

test('WhatsApp uses scoped approved-template broadcasts, separate durable phases and recipient delivery refresh', pg, async t => {
  const f = await fixture(t);
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

test('uncertain outcomes never retry, cancellation survives an in-flight send, and credential changes stop queued work', pg, async t => {
  const f = await fixture(t);
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

test('WhatsApp cancellation during preparation prevents dispatch and a changed review cannot queue stale recipients', pg, async t => {
  const f = await fixture(t);
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

test('restart quarantines in-flight requests and rejects expanded personalized bodies before queuing', pg, async t => {
  const f = await fixture(t);
  try {
    await f.person({ company: 'x'.repeat(200) });
    const huge = await f.draft({ text: '{{company}} '.repeat(10) }); assert.equal((await f.request(f.path + `/campaigns/${huge.id}/preview`, 'POST', {})).status, 400);
    const campaign = await f.draft(); await f.arm(campaign);
    const detail = (await f.request(f.path + '/campaigns/' + campaign.id)).data, delivery = detail.deliveries[0]; delivery.status = 'sending'; await f.app.pool.query('UPDATE direct_deliveries SET data = $1 WHERE id = $2', [JSON.stringify(delivery), delivery.id]);
    const raw = (await f.app.pool.query('SELECT data FROM direct_campaigns WHERE id = $1', [campaign.id])).rows[0].data; raw.status = 'sending'; await f.app.pool.query('UPDATE direct_campaigns SET data = $1 WHERE id = $2', [JSON.stringify(raw), campaign.id]);
    const recovered = createDirectCampaigns({ db: f.app.db, env: f.env, appUrl: f.origin, secret: f.app.config.sessionSecret, store: f.app.store }); await recovered.processPending(); recovered.close();
    const result = (await f.request(f.path + '/campaigns/' + campaign.id)).data; assert.equal(result.campaign.status, 'attention'); assert.equal(result.deliveries[0].status, 'uncertain'); assert.equal(f.messages.size, 0);
  } finally { await f.close(); }
});

test('late refreshes cannot restart an uncertain broadcast or revert a concurrently scheduled email draft', pg, async t => {
  const f = await fixture(t); let releaseSend = () => {}, releaseRefresh = () => {}, releaseEmail = () => {};
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

test('a late WhatsApp refresh preserves a newer provider receipt and terminal delivery evidence', pg, async t => {
  const f = await fixture(t); let release = () => {};
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

test('manual provider cancellation and refresh recheck the requester without requiring the original author', pg, async t => {
  const f = await fixture(t); let releaseCancel = () => {}, releaseSms = () => {};
  try {
    await f.person(); const campaign = await f.draft({ channel: 'whatsapp', accountId: 'wa-direct', templateName: 'appointment_update', templateLanguage: 'en' }); await f.arm(campaign);
    f.setHook(url => { if (url.hostname === 'zernio.com' && url.pathname.endsWith('/send')) { const broadcast = [...f.broadcasts.values()][0]; broadcast.status = 'sending'; return Response.json({ success: true, status: 'sending', sent: 0, failed: 0, recipientCount: broadcast.phones.length }); } });
    await f.app.direct.processPending();
    const raw = (await f.app.pool.query('SELECT data FROM direct_campaigns WHERE id = $1', [campaign.id])).rows[0].data; raw.scheduledBy = 'former-author'; await f.app.pool.query('UPDATE direct_campaigns SET data = $1 WHERE id = $2', [JSON.stringify(raw), campaign.id]);
    let cancelStarted, held = false; const cancelEntered = new Promise(resolve => { cancelStarted = resolve; }), cancelGate = new Promise(resolve => { releaseCancel = resolve; });
    f.setHook(async url => { if (url.pathname.endsWith('/accounts') && !held) { held = true; cancelStarted(); await cancelGate; } });
    const cancelling = f.request(f.path + `/campaigns/${campaign.id}/cancel`, 'POST', {}); await cancelEntered; await f.app.pool.query("UPDATE memberships SET role = 'viewer'"); releaseCancel();
    assert.equal((await cancelling).status, 403); assert.equal(f.calls.filter(call => call.url.endsWith('/cancel')).length, 0, 'Demotion during account verification must stop the provider cancellation.');
    await f.app.pool.query("UPDATE memberships SET role = 'owner'"); f.setHook(null);
    const retry = await f.request(f.path + `/campaigns/${campaign.id}/cancel`, 'POST', {}); assert.equal(retry.status, 200); assert.equal(retry.data.campaign.providerStatus, 'cancelled', 'An authorized administrator can reconcile a campaign whose author has left.');
    const sms = await f.draft(); await f.arm(sms); await f.app.direct.processPending();
    let smsStarted; const smsEntered = new Promise(resolve => { smsStarted = resolve; }), smsGate = new Promise(resolve => { releaseSms = resolve; });
    f.setHook(async (url, options) => { if (url.hostname === 'api.twilio.com' && options.method === 'GET') { smsStarted(); await smsGate; } });
    const refreshing = f.request(f.path + `/campaigns/${sms.id}/refresh`, 'POST', {}); await smsEntered; await f.app.pool.query("UPDATE memberships SET role = 'viewer'"); releaseSms();
    const denied = await refreshing; assert.equal(denied.status, 403); assert.equal(denied.data.deliveries, undefined, 'Revoked manual access must not expose an awaited provider receipt.');
  } finally { releaseCancel(); releaseSms(); await f.close(); }
});

test('SMS delivery refresh preserves the original sender and service when the provider returns conflicting routing', pg, async t => {
  const f = await fixture(t);
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
