import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
const { AudienceSummary } = ui;

const source = await readFile(new URL('../src/DirectCampaigns.tsx', import.meta.url), 'utf8');
const templateSource = await readFile(new URL('../src/WhatsAppTemplate.tsx', import.meta.url), 'utf8');
const section = (start, end, text = source) => text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
function compile(code, context = {}) { return new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context)); }
const event = { preventDefault() {} };
const campaignBody = compile(section('function campaignBody(', 'const when ='));
const templateRestriction = compile(section('function templateRestriction(', 'export function templatePreviewText(', templateSource));
const templatePreviewText = compile(section('function templatePreviewText(', 'export function templateParameter(', templateSource));
const templateParameter = compile(section('function templateParameter(', 'export default function WhatsAppTemplate(', templateSource));
const helper = name => source.match(new RegExp(`^const ${name} = [^\n]+;$`, 'm'))[0].replace(`const ${name} = `, '').replace(/;$/, '');
const emailProviderChoice = compile(helper('emailProviderChoice'));
const sendErrors = compile('(' + section('const testSendErrors', '\nconst testSendError =').replace(/^const testSendErrors[^=]*= /, '').replace(/;\s*$/, '') + ')', { emailProviderChoice });
const blankDraft = { name: 'Launch notice', campaignId: 'c1', channel: 'email', subject: 'Receipt for {{name}}', text: 'Your receipt', html: '<p>Receipt</p>', accountId: 'wa-account', templateName: 'receipt', templateLanguage: 'en', templateComponents: [], contactIds: [], tags: [] };

test('audience readiness renders the real library summary with app counts and preserves unknowns', async () => {
  const jsx = source.match(/<AudienceSummary[\s\S]*?\/>/)?.[0]; assert.ok(jsx);
  const { code } = await transformWithOxc(`const render = (validPreview, audienceMode, draft) => (${jsx});`, 'AudienceReadiness.tsx', { jsx: { runtime: 'classic' } });
  const summary = new Function('React', 'AudienceSummary', 'labels', `${code}; return render;`)(React, AudienceSummary, { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' });
  const counts = { total: 8, eligible: 5, excluded: 3, unverified: 2 };
  for (const [mode, scope, channel, purpose] of [['all', 'All contacts in this project', 'email', 'Transactional email only'], ['tags', 'Contacts matching tags', 'sms', 'Direct campaign'], ['contacts', 'Chosen contacts', 'whatsapp', 'Direct campaign']]) {
    const element = summary({ audience: counts }, mode, { channel }); assert.deepEqual(element.props.counts, counts);
    const html = renderToStaticMarkup(element);
    assert.match(html, /class="t98-card t98-audience-summary"/); assert.match(html, /Audience readiness/);
    for (const value of [scope, purpose, channel === 'email' ? 'Email' : channel === 'sms' ? 'SMS' : 'WhatsApp']) assert.ok(html.includes(value));
    assert.match(html, /<dt>Eligible<\/dt><dd>5<\/dd>/); assert.match(html, /<dt>Unverified<\/dt><dd>2<\/dd>/);
  }
  assert.equal((renderToStaticMarkup(summary({}, 'all', blankDraft)).match(/<dd>Unavailable<\/dd>/g) || []).length, 4);
  assert.match(renderToStaticMarkup(summary({ audience: { ...counts, eligible: 0 } }, 'all', blankDraft)), /<dt>Eligible<\/dt><dd>0<\/dd>/);
});

test('actual campaign serialization keeps channel fields separate and never broadens an empty explicit audience', () => {
  assert.deepEqual(campaignBody(blankDraft, 'all'), { name: 'Launch notice', channel: 'email', subject: 'Receipt for {{name}}', text: 'Your receipt', html: '<p>Receipt</p>', emailPurpose: 'transactional', contactIds: [], tags: [], campaignId: 'c1' });
  assert.deepEqual(campaignBody({ ...blankDraft, channel: 'sms', contactIds: ['one'], tags: ['other'] }, 'contacts'), { name: 'Launch notice', channel: 'sms', text: 'Your receipt', contactIds: ['one'], tags: [], campaignId: 'c1' });
  const whatsapp = campaignBody({ ...blankDraft, channel: 'whatsapp', tags: ['customer'] }, 'tags');
  assert.deepEqual(whatsapp.tags, ['customer']); assert.equal(whatsapp.subject, undefined); assert.equal(whatsapp.text, undefined); assert.equal(whatsapp.accountId, 'wa-account');
  assert.throws(() => campaignBody(blankDraft, 'contacts'), /Choose at least one contact/);
  assert.throws(() => campaignBody(blankDraft, 'tags'), /Enter at least one audience tag/);
});

test('shared WhatsApp field helper preserves media details and the real button index, with readable template previews', () => {
  let draft = { ...blankDraft, templateComponents: [] };
  function input(...values) { const previous = structuredClone(draft.templateComponents), current = draft.templateComponents; draft = { ...draft, templateComponents: templateParameter(current, ...values) }; assert.deepEqual(current, previous, 'Template fields must not mutate the previous draft.'); }
  input('header', 0, 'https://cdn.example.com/invoice.pdf', undefined, 'document');
  input('header', 0, 'invoice.pdf', undefined, 'document', 'filename');
  input('body', 1, '42'); input('body', 0, 'Alex'); input('button', 0, 'invoice-42', 1);
  assert.deepEqual(draft.templateComponents, [
    { type: 'header', parameters: [{ type: 'document', document: { link: 'https://cdn.example.com/invoice.pdf', filename: 'invoice.pdf' } }] },
    { type: 'body', parameters: [{ type: 'text', text: 'Alex' }, { type: 'text', text: '42' }] },
    { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'invoice-42' }] },
  ]);
  const template = { components: [{ type: 'HEADER', format: 'DOCUMENT' }, { type: 'BODY', text: 'Receipt {{2}} for {{1}}' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Thanks' }, { type: 'URL', text: 'View invoice', url: 'https://example.com/invoices/{{1}}' }] }] };
  assert.equal(templateRestriction(template), '');
  assert.match(templatePreviewText(template, draft.templateComponents), /document header: https:\/\/cdn.example.com\/invoice.pdf \(invoice.pdf\)/);
  assert.match(templatePreviewText(template, draft.templateComponents), /Receipt 42 for Alex/);
  assert.match(templatePreviewText(template, draft.templateComponents), /View invoice: https:\/\/example.com\/invoices\/invoice-42/);
  for (const component of [{ type: 'CAROUSEL' }, { type: 'HEADER', format: 'LOCATION' }, { type: 'BODY', text: '{{name}}' }, { type: 'BODY', text: '{{2}}' }, { type: 'BUTTONS', buttons: [{ type: 'FLOW' }] }, { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://example.com/{{1}}/extra' }] }]) assert.ok(templateRestriction({ components: [component] }));
});

test('readiness requires a current reviewed audience, a configured public sender and write access', () => {
  const expression = source.match(/ready = (.+);/)[1];
  const ready = changes => { const context = { readOnly: false, editable: true, current: { id: 'draft' }, validPreview: { previewToken: 'review', audience: { eligible: 2 } }, status: { providers: { email: true }, publicCallbacks: true }, draft: blankDraft, ...changes }; return compile(`() => (${expression})`, context)(); };
  assert.equal(ready(), true); assert.equal(ready({ readOnly: true }), false); assert.equal(ready({ editable: false }), false);
  assert.equal(ready({ status: { providers: { email: true }, publicCallbacks: false } }), false);
  assert.equal(ready({ validPreview: { audience: { eligible: 2 } } }), false);
  assert.equal(ready({ validPreview: { previewToken: 'review', audience: { eligible: 501 } } }), false);
});

test('actual send handler requires explicit confirmation, carries the review token and safely handles uncertain writes', async () => {
  const handler = section('async function send(', '  async function campaignAction(');
  async function run(changes = {}) {
    const requests = [], errors = [], previews = [], confirmations = [], accepted = [], details = [];
    const context = { ready: true, confirmed: true, transactionalConfirmed: true, draft: blankDraft, editingId: 'campaign /1', confirmationMode: 'send', scheduledAt: '', validPreview: { previewToken: 'review-token' }, version: { current: 1 }, setError: value => errors.push(value), setPreview: value => previews.push(value), setConfirmationMode: value => confirmations.push(value), setDetail: value => details.push(value), setNotice() {}, acceptCampaign: value => accepted.push(value), path: '/projects/project/direct', action: async (_, perform) => perform(1), requester: { current: async (path, method, body) => { requests.push({ path, method, body }); return { campaign: { id: 'campaign /1', status: 'scheduled' } }; } }, ...changes };
    await compile(handler, context)(event); return { requests, errors, previews, confirmations, accepted, details };
  }
  for (const changes of [{ ready: false }, { confirmed: false }, { transactionalConfirmed: false }, { confirmationMode: '' }]) assert.equal((await run(changes)).requests.length, 0);
  const sent = await run(); assert.deepEqual(sent.requests[0], { path: '/projects/project/direct/campaigns/campaign%20%2F1/send', method: 'POST', body: { confirmed: true, previewToken: 'review-token', transactionalConfirmed: true } });
  const scheduledAt = new Date(Date.now() + 3600000).toISOString(), scheduled = await run({ draft: { ...blankDraft, channel: 'sms' }, confirmationMode: 'schedule', scheduledAt });
  assert.equal(scheduled.requests[0].body.scheduledAt, scheduledAt); assert.equal(scheduled.requests[0].body.transactionalConfirmed, undefined);
  for (const scheduledAt of ['not a date', '2000-01-01T00:00', new Date(Date.now() + 367 * 86400000).toISOString()]) { const result = await run({ confirmationMode: 'schedule', scheduledAt }); assert.equal(result.requests.length, 0); assert.match(result.errors[0], /future send time/); }
  const requests = [], previews = [], confirmations = [], accepted = [];
  await assert.rejects(run({ setPreview: value => previews.push(value), setConfirmationMode: value => confirmations.push(value), acceptCampaign: value => accepted.push(value), requester: { current: async (path, method) => { requests.push({ path, method }); if (method === 'POST') throw new Error('Connection lost after dispatch'); return { campaign: { id: 'campaign /1', status: 'sending' } }; } } }), /Connection lost/);
  assert.equal(requests.filter(item => item.method === 'POST').length, 1); assert.equal(requests[1].method, undefined); assert.deepEqual(previews, [null]); assert.deepEqual(confirmations, ['']); assert.equal(accepted[0].status, 'sending');
});

test('actual loader preserves independent contact/campaign results and ignores responses from a previous project', async () => {
  const handler = section('async function load(', '  useEffect(() =>');
  const states = {}, version = { current: 1 };
  const context = { version, path: '/projects/a/direct', requester: { current: async path => { if (path.endsWith('/status')) throw new Error('Provider down'); return path.endsWith('/contacts') ? { contacts: [{ id: 'contact' }] } : { campaigns: [{ id: 'campaign' }] }; } }, setStatus: value => { states.status = value; }, setContacts: value => { states.contacts = value; }, setCampaigns: value => { states.campaigns = value; } };
  await assert.rejects(compile(handler, context)(1), /Provider down/); assert.deepEqual(states.contacts, [{ id: 'contact' }]); assert.deepEqual(states.campaigns, [{ id: 'campaign' }]);
  const snapshot = structuredClone(states); version.current = 2; await compile(handler, context)(1); assert.deepEqual(states, snapshot);
});

test('actual action lock prevents repeat sends and local progress polling never invokes provider refresh or overwrites a later action', async () => {
  const pending = { current: false }, version = { current: 1 }, actionVersion = { current: 0 }, busy = [], errors = [];
  const action = compile(section('async function action(', '  function acceptCampaign('), { pending, version, actionVersion, setBusy: value => busy.push(value), setError: value => errors.push(value), setNotice() {}, rememberFocus() {} });
  let release, executions = 0; const work = action('Sending', async () => { executions++; await new Promise(resolve => { release = resolve; }); });
  await action('Sending again', async () => { executions++; }); assert.equal(executions, 1); assert.equal(actionVersion.current, 1); release(); await work; assert.equal(pending.current, false); assert.deepEqual(busy, ['Sending', '']);
  const polling = section('const refreshProgress = async () =>', '    const timer =').replace('const refreshProgress = ', '').trim().replace(/;$/, '');
  let finish; const paths = [], accepted = [];
  const progress = compile(polling, { loading: false, pending, actionVersion, closed: false, generation: 1, version, requester: { current: async path => { paths.push(path); return new Promise(resolve => { finish = resolve; }); } }, path: '/projects/a/direct', campaign: { id: 'campaign' }, acceptCampaign: value => accepted.push(value), setDetail() {} });
  const reading = progress(); actionVersion.current++; finish({ campaign: { id: 'campaign', status: 'scheduled' } }); await reading;
  assert.deepEqual(paths, ['/projects/a/direct/campaigns/campaign']); assert.equal(accepted.length, 0, 'A stale local read must not reverse a later cancel or explicit refresh.');
});

test('actual contact import previews grant only explicit permissions and do not refresh records until imported', async () => {
  const handler = section('async function importContacts(', '  async function readCsv('), calls = [], results = [], people = [], notices = [];
  const context = { importNotice: compile(helper('importNotice')), readOnly: false, action: async (_, run) => run(1), requester: { current: async (path, method, body) => { calls.push({ path, method, body }); return method === 'POST' ? { imported: 3, created: 2, updated: 1, skipped: 0, errors: [] } : { contacts: [{ id: 'saved' }] }; } }, path: '/projects/a/direct', csv: 'name,email,tags\nAlex,alex@example.com,customer|launch', importConsent: { email: true, sms: false, whatsapp: false }, importSource: 'Signup form 2026-10-18', version: { current: 1 }, setImportResult: value => results.push(value), setNotice: value => notices.push(value), setContacts: value => people.push(value) };
  const submit = compile(handler, context);
  await submit({ ...event, nativeEvent: { submitter: { getAttribute: () => 'preview' } } }); assert.equal(calls.length, 1); assert.equal(calls[0].body.dryRun, true); assert.deepEqual(calls[0].body.consents, context.importConsent); assert.equal(results[0].dryRun, true); assert.equal(people.length, 0);
  await submit({ ...event, nativeEvent: { submitter: { getAttribute: () => 'import' } } }); assert.equal(calls.length, 3); assert.equal(calls[1].body.dryRun, undefined); assert.deepEqual(people[0], [{ id: 'saved' }]); assert.match(notices.at(-1), /Processed 3 rows: 2 created, 1 merged/);
});

test('a locally cancelled WhatsApp broadcast can explicitly retry an unconfirmed provider cancellation', async () => {
  const expression = source.match(/const retryCancellation = (.+);/)[1];
  const campaign = { id: 'campaign', status: 'cancelled', channel: 'whatsapp', providerId: 'broadcast', providerStatus: 'sending', lastError: 'Provider unavailable' };
  const retry = current => compile(`() => (${expression})`, { current })();
  assert.equal(retry(campaign), true);
  for (const changes of [{ status: 'sending' }, { channel: 'sms' }, { providerId: '' }, { providerStatus: 'cancelled' }, { lastError: '' }]) assert.equal(retry({ ...campaign, ...changes }), false);
  assert.equal(retry(undefined), false);
  const calls = [], accepted = [];
  const cancel = compile(section('async function campaignAction(', '  function editContact('), { current: campaign, window: { confirm: () => true }, action: async (_, run) => run(1), requester: { current: async (...args) => { calls.push(args); return { campaign: { ...campaign, providerStatus: 'cancelled', lastError: undefined } }; } }, path: '/projects/a/direct', version: { current: 1 }, acceptCampaign: value => accepted.push(value), setDetail() {}, setNotice() {} });
  await cancel('cancel'); assert.deepEqual(calls, [['/projects/a/direct/campaigns/campaign/cancel', 'POST', {}]]); assert.equal(retry(accepted[0]), false);
});

test('explicit message shortening preserves HTML/template content and ignores stale or edited drafts', async () => {
  const handler = section('async function shortenText(', '  function openReplies('), draft = { ...blankDraft, text: 'See https://example.com', html: '<p>Keep original HTML</p>' }, updates = [], notices = [], calls = [];
  const context = { onShortenText: async (...args) => { calls.push(args); return 'See https://go.example/s/code'; }, readOnly: false, editable: true, draft, editingId: 'direct-campaign', action: async (_, run) => run(1), version: { current: 1 }, latestDraft: { current: { draft, editingId: 'direct-campaign' } }, setNotice: value => notices.push(value), setDraft: update => updates.push(update(draft)) };
  await compile(handler, context)(); assert.deepEqual(calls[0], ['See https://example.com', 'direct-campaign']); assert.equal(updates[0].text, 'See https://go.example/s/code'); assert.equal(updates[0].html, draft.html); assert.deepEqual(updates[0].templateComponents, draft.templateComponents);
  await compile(handler, { ...context, latestDraft: { current: { draft: { ...draft, text: 'Newer text' }, editingId: 'direct-campaign' } } })(); assert.equal(updates.length, 1); assert.match(notices.at(-1), /message changed/);
  await compile(handler, { ...context, version: { current: 2 } })(); assert.equal(updates.length, 1);
  const before = calls.length; await compile(handler, { ...context, readOnly: true })(); await compile(handler, { ...context, draft: { ...draft, channel: 'whatsapp' } })(); await compile(handler, { ...context, editingId: '' })(); assert.equal(calls.length, before); assert.match(notices.at(-1), /Save this draft first/);
});

test('reply navigation carries the selected campaign account and recipient without choosing another channel', () => {
  const calls = [], open = compile(section('function openReplies(', '\n  const deliveries: any[] ='),{ onOpenReplies: (...args) => calls.push(args) });
  open({ channel: 'whatsapp', accountId: 'campaign-account' }, '+971501234567'); open({ channel: 'sms', accountId: 'unused' }, '+971501234567'); open({ channel: 'email' }, 'person@example.com');
  assert.deepEqual(calls, [['whatsapp', 'campaign-account', '+971501234567'], ['sms', undefined, '+971501234567']]);
});

test('CSV file reads cannot replace newer selections, manual edits or errors after the view closes', async () => {
  function setup() {
    const state = { csv: '', error: '', result: 'preview' }, version = { current: 1 }, csvRead = { current: 0 };
    const context = { version, csvRead, setCsv: value => { state.csv = value; }, setError: value => { state.error = value; }, setImportResult: value => { state.result = value; } };
    return { state, version, read: compile(section('async function readCsv(', '  async function suppress('), context), edit: compile(`event => { ${source.match(/value={csv} onChange={event => { (.*?) }}/)[1]} }`, context) };
  }
  const file = promise => ({ files: [{ size: 100, text: () => promise }], value: 'selected.csv' });
  for (const failure of [false, true]) {
    const ui = setup(); let resolve, reject;
    const oldInput = file(new Promise((yes, no) => { resolve = yes; reject = no; })), oldRead = ui.read({ currentTarget: oldInput });
    await ui.read({ currentTarget: file(Promise.resolve('New CSV')) });
    if (failure) reject(new Error('Old read failed')); else resolve('Old CSV'); await oldRead;
    assert.equal(ui.state.csv, 'New CSV'); assert.equal(ui.state.error, '');
  }
  {
    const ui = setup(); let resolve;
    const reading = ui.read({ currentTarget: file(new Promise(yes => { resolve = yes; })) });
    ui.edit({ target: { value: 'Pasted CSV' } }); resolve('Old CSV'); await reading;
    assert.equal(ui.state.csv, 'Pasted CSV'); assert.equal(ui.state.result, null);
  }
  {
    const ui = setup(); let resolveOld, resolveNew;
    const input = file(new Promise(yes => { resolveOld = yes; })), oldRead = ui.read({ currentTarget: input });
    input.files = [{ size: 100, text: () => new Promise(yes => { resolveNew = yes; }) }]; input.value = 'new.csv';
    const newRead = ui.read({ currentTarget: input }); resolveOld('Old CSV'); await oldRead;
    assert.equal(input.value, '', 'Capture and clear the selected file before reading, so the same file can be chosen again.'); assert.equal(ui.state.csv, '');
    resolveNew('New CSV'); await newRead; assert.equal(ui.state.csv, 'New CSV'); assert.equal(input.value, '');
  }
  for (const failure of [false, true]) {
    const ui = setup(); let resolve, reject;
    const reading = ui.read({ currentTarget: file(new Promise((yes, no) => { resolve = yes; reject = no; })) }); ui.version.current++;
    if (failure) reject(new Error('Closed read failed')); else resolve('Closed CSV'); await reading;
    assert.equal(ui.state.csv, ''); assert.equal(ui.state.error, '');
  }
});

test('a replacement CSV cannot import the previous text while its file is still loading', async () => {
  let csv = 'name,email\nPrevious,previous@example.com', finish;
  const requests = [], version = { current: 1 }, csvRead = { current: 0 }, context = { version, csvRead, setCsv: value => { csv = value; }, setImportResult() {}, setError() {} };
  const reading = compile(section('async function readCsv(', '  async function suppress('), context)({ currentTarget: { files: [{ size: 100, text: () => new Promise(resolve => { finish = resolve; }) }], value: 'replacement.csv' } });
  async function submit() {
    await compile(section('async function importContacts(', '  async function readCsv('), { ...context, csv, readOnly: false, action: async (_, run) => run(1), importConsent: {}, importSource: '', path: '/projects/a/direct', requester: { current: async (_path, _method, body) => { requests.push(body); return {}; } }, setNotice() {}, setContacts() {} })({ ...event, nativeEvent: { submitter: { getAttribute: () => 'preview' } } });
  }
  await submit(); assert.equal(requests.length, 0, 'Selecting another file must prevent import of the previous CSV.');
  const edit = compile(`event => { ${source.match(/value={csv} onChange={event => { (.*?) }}/)[1]} }`, context);
  edit({ target: { value: 'name,email\nManual,manual@example.com' } }); await submit(); assert.equal(requests.length, 1); assert.match(requests[0].csv, /Manual/);
  finish('name,email\nReplacement,replacement@example.com'); await reading; assert.match(csv, /Manual/);
  csv = '   '; await submit(); assert.equal(requests.length, 1);
});

test('a draft test send posts a confirmed request under a new key per click, with a contact only for SMS', async () => {
  const handler = section('async function sendTest(', '  async function importContacts(');
  const smsTestContacts = compile(section('const smsTestContacts =', '\nconst testSendErrors').replace(/^const smsTestContacts = /, '').replace(/;\s*$/, ''));
  const sms = { id: 'sms /1', status: 'draft', channel: 'sms' }, people = [{ id: 'consented', phone: '+971501234567', consents: { sms: true } }, { id: 'no-permission', phone: '+971501234568', consents: { sms: false } }, { id: 'suppressed', phone: '+971501234569', consents: { sms: true }, suppression: { sms: { reason: 'Recipient opted out' } } }, { id: 'no-phone', consents: { sms: true } }];
  assert.deepEqual(smsTestContacts(people).map(person => person.id), ['consented']);
  async function run(changes = {}) {
    const requests = [], results = [], keys = { next: 0 };
    const context = { current: { id: 'campaign /1', status: 'draft', channel: 'email' }, readOnly: false, testContactId: '', contacts: people, smsTestContacts, testSendError: () => 'readable', crypto: { randomUUID: () => 'key-' + ++keys.next }, path: '/projects/a/direct', version: { current: 1 }, action: async (_, perform) => perform(1), setTestSend: value => results.push(value), requester: { current: async (...args) => { requests.push(args); return { operation: { id: 'operation', status: 'complete' }, test: { channel: 'email', recipient: 'owner@example.test', status: 'queued', providerId: 'provider-1' } }; } }, ...changes };
    const send = compile(handler, context); await send(); await send(); return { requests, results };
  }
  const email = await run();
  assert.deepEqual(email.requests.map(([path, method, body]) => [path, method, body]), Array(2).fill(['/projects/a/direct/campaigns/campaign%20%2F1/test', 'POST', { confirmed: true }]));
  assert.deepEqual(email.requests.map(request => request[3]), ['key-1', 'key-2'], 'Each click sends a new Idempotency-Key.');
  assert.deepEqual(email.results[0], { campaignId: 'campaign /1', result: { channel: 'email', recipient: 'owner@example.test', status: 'queued', providerId: 'provider-1' } });
  assert.deepEqual((await run({ current: sms, testContactId: 'consented' })).requests[0].slice(0, 3), ['/projects/a/direct/campaigns/sms%20%2F1/test', 'POST', { confirmed: true, contactId: 'consented' }]);
  for (const changes of [{ readOnly: true }, { current: undefined }, { current: { ...sms, status: 'scheduled' } }, { current: { ...sms, channel: 'whatsapp' } }, { current: sms }, { current: sms, testContactId: 'no-permission' }, { current: sms, testContactId: 'suppressed' }]) assert.equal((await run(changes)).requests.length, 0);
  const failed = await run({ requester: { current: async () => { throw Object.assign(new Error('Server text'), { status: 429, code: 'TEST_SEND_LIMIT' }); } } });
  assert.deepEqual(failed.results[0], { campaignId: 'campaign /1', error: 'readable' });
  assert.equal((await run({ version: { current: 2 } })).results.length, 0, 'A result for a project that is no longer open is ignored.');
});

test('test send errors are readable for each server code and fall back to the server message', () => {
  const testSendErrors = compile('(' + section('const testSendErrors', '\nconst testSendError =').replace(/^const testSendErrors[^=]*= /, '').replace(/;\s*$/, '') + ')', { emailProviderChoice });
  const testSendError = compile(section('const testSendError =', '\n').replace(/^const testSendError = /, '').replace(/;\s*$/, ''), { testSendErrors });
  assert.equal(testSendError({ code: 'EMAIL_PROVIDER_REQUIRED', message: 'Server text' }), emailProviderChoice);
  for (const code of ['SEND_CONFIRMATION_REQUIRED', 'INVALID_TEST_RECIPIENT', 'INVALID_TEST_SEND', 'TEST_SEND_UNSUPPORTED', 'CAMPAIGN_LOCKED', 'INTEGRATION_NOT_CONFIGURED', 'EMAIL_PROVIDER_REQUIRED', 'PUBLIC_URL_REQUIRED', 'TEST_SEND_LIMIT']) {
    const message = testSendError({ code, message: code }); assert.ok(message.length > 20 && !message.includes(code), code);
  }
  assert.match(testSendError({ code: 'TEST_SEND_LIMIT' }), /10 tests/);
  assert.equal(testSendError({ code: 'OPERATION_UNCERTAIN', message: 'Check the provider before another attempt.' }), 'Check the provider before another attempt.');
  assert.equal(testSendError({ code: 'constructor' }), 'The test could not be sent. Try again.');
  assert.equal(testSendError(undefined), 'The test could not be sent. Try again.');
});

test('the test send is offered only on writable email and SMS drafts, behind a confirmation', () => {
  const expression = source.match(/const testable = (.+?);\n/)[1], testable = (current, readOnly = false) => compile(`() => (${expression})`, { readOnly, current })();
  assert.equal(testable({ status: 'draft', channel: 'email' }), true); assert.equal(testable({ status: 'draft', channel: 'sms' }), true);
  for (const current of [undefined, { status: 'draft', channel: 'whatsapp' }, { status: 'scheduled', channel: 'email' }, { status: 'completed', channel: 'sms' }]) assert.equal(testable(current), false);
  assert.equal(testable({ status: 'draft', channel: 'email' }, true), false);
  assert.match(source, /<ConfirmDialog open={confirmingTest}[^>]*onConfirm={sendTest}/);
  assert.match(source, /acknowledgement={current\.channel === 'sms' \?/);
});

test('provider deliverability alerts show as a warning that names the provider and does not claim recipients were suppressed', async () => {
  const emailProviderName = compile(helper('emailProviderName')), emailProviderConsole = compile(helper('emailProviderConsole')), deliverabilityAlerts = compile(helper('deliverabilityAlerts'));
  const deliverabilityCopy = compile(helper('deliverabilityCopy'), { emailProviderName, emailProviderConsole });
  assert.equal(emailProviderName('cloudflare'), 'Cloudflare'); assert.equal(emailProviderName('ses'), 'Amazon SES');
  const status = { deliverabilityAlerts: [{ provider: 'cloudflare', kind: 'policy', channel: 'email', contacts: 2, firstSeenAt: 'x', lastSeenAt: 'y', expiresAt: null }, { provider: 'ses', kind: 'undetermined', contacts: 3, expiresAt: null }, { provider: 'cloudflare', kind: 'policy', contacts: 0, expiresAt: null }, { provider: 7 }, null] };
  assert.deepEqual(deliverabilityAlerts(status).map(row => [row.provider, row.kind, row.contacts]), [['cloudflare', 'policy', 2], ['ses', 'undetermined', 3]], 'Malformed or empty groups are not shown.');
  assert.deepEqual(deliverabilityAlerts({}), []); assert.deepEqual(deliverabilityAlerts(null), []);
  assert.deepEqual(deliverabilityCopy({ provider: 'cloudflare', kind: 'policy', contacts: 2 }), { title: 'Cloudflare reports a policy block for 2 contacts', body: 'It may concern your sending account, not the recipients, so they were not suppressed. Check Cloudflare Email Sending.' });
  assert.deepEqual(deliverabilityCopy({ provider: 'ses', kind: 'policy', contacts: 1 }), { title: 'Amazon SES reports a policy block for 1 contact', body: 'It may concern your sending account, not the recipients, so they were not suppressed. Check the Amazon SES console.' });
  const undetermined = deliverabilityCopy({ provider: 'ses', kind: 'undetermined', contacts: 3 });
  assert.equal(undetermined.title, 'Amazon SES could not classify bounces for 3 contacts');
  assert.match(undetermined.body, /Check the bounce details in the Amazon SES console\./); assert.doesNotMatch(undetermined.body, /policy|not suppressed/);
  assert.equal(deliverabilityCopy({ provider: 'ses', kind: 'undetermined', contacts: 1 }).title, 'Amazon SES could not classify bounces for 1 contact');
  assert.match(source, /\{deliverabilityAlerts\(status\)\.map\(alert => \{ const copy = deliverabilityCopy\(alert\); return <Alert key=\{alert\.provider \+ ':' \+ alert\.kind\} tone="warning" title=\{copy\.title\}>\{copy\.body\}/);
});

// Renders the real @ten98/ui components for a JSX expression taken from the component source.
async function renderSnippet(pattern, names, scope) {
  const jsx = source.match(pattern)?.[0]; assert.ok(jsx, String(pattern));
  const { code } = await transformWithOxc(`const render = (${Object.keys(scope).join(', ')}) => (<>${jsx}</>);`, 'Snippet.tsx', { jsx: { runtime: 'classic' } });
  return new Function('React', ...names, `${code}; return render;`)(React, ...names.map(name => ui[name]))(...Object.values(scope));
}
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : React.isValidElement(node) ? [node, ...nodes(node.props.children)] : [];

test('the email channel names the provider that sends, or asks for a choice when both are configured', async () => {
  const emailProviderName = compile(helper('emailProviderName'));
  const names = ['Alert', 'StatusLine'], labels = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };
  const show = (status, channel = 'email') => renderSnippet(/\{status && \(draft\.channel === 'email' && status\.emailProvider === null[\s\S]*?<\/Alert>\)\}/, names, { status, draft: { channel }, labels, emailProviderName, emailProviderChoice, integrationsAction: undefined, editable: true, readOnly: false }).then(renderToStaticMarkup);
  assert.match(await show({ providers: { email: true }, emailProvider: 'ses' }), /Email sends through Amazon SES\./);
  assert.match(await show({ providers: { email: true }, emailProvider: 'cloudflare' }), /Email sends through Cloudflare\./);
  const both = await show({ providers: { email: false }, emailProvider: null });
  assert.ok(both.includes(emailProviderChoice)); assert.doesNotMatch(both, /sends through|provider configured/); assert.doesNotMatch(both, /Open integrations/);
  assert.match(await show({ providers: { email: false }, emailProvider: 'cloudflare' }), /Email sending is not configured/);
  assert.match(await show({ providers: { sms: true }, emailProvider: null }, 'sms'), /SMS provider configured\./, 'The email choice does not affect other channels.');
});

test('the email provider choice offers a working Open integrations button wherever it is shown', async () => {
  const jsx = source.match(/const integrationsAction = (onOpenIntegrations \? <Button[^\n]*?<\/Button> : undefined);/)?.[1]; assert.ok(jsx);
  const { code } = await transformWithOxc(`const make = onOpenIntegrations => (${jsx});`, 'IntegrationsAction.tsx', { jsx: { runtime: 'classic' } });
  const make = new Function('React', 'Button', `${code}; return make;`)(React, ui.Button), opened = [], action = make(() => opened.push('Integrations'));
  assert.equal(make(undefined), undefined, 'Without the prop there is no button.');
  action.props.onClick(); assert.deepEqual(opened, ['Integrations']);
  const button = /<button[^>]*>Open Connections<\/button>/, html = (pattern, scope) => renderSnippet(pattern, ['Alert', 'StatusLine'], { emailProviderChoice, testSendErrors: sendErrors, integrationsAction: action, ...scope }).then(renderToStaticMarkup);
  const warning = scope => html(/\{status && \(draft\.channel === 'email' && status\.emailProvider === null[\s\S]*?<\/Alert>\)\}/, { status: { providers: { email: false }, emailProvider: null }, draft: { channel: 'email' }, labels: {}, emailProviderName: String, editable: true, readOnly: false, ...scope });
  assert.match(await warning({}), button);
  assert.doesNotMatch(await warning({ editable: false }), button, 'A campaign that is no longer a draft has a disabled form, so no dead button.');
  assert.doesNotMatch(await warning({ readOnly: true }), button);
  for (const pattern of [/\{error && <Alert tone="danger"[\s\S]*?<\/Alert>\}/, /\{shownTest\?\.error && <Alert[\s\S]*?<\/Alert>\}/]) {
    const show = error => html(pattern, { error, shownTest: { error } });
    assert.match(await show(emailProviderChoice), button, String(pattern)); assert.doesNotMatch(await show('Server text'), button, 'Other failures do not link to Integrations.');
  }
  const testFailure = error => html(/\{shownTest\?\.error && <Alert[\s\S]*?<\/Alert>\}/, { shownTest: { error } });
  assert.match(await testFailure(sendErrors.INTEGRATION_NOT_CONFIGURED), button, 'A test refused for a missing provider links to Integrations.');
  assert.doesNotMatch(await testFailure(sendErrors.TEST_SEND_LIMIT), button);
  const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.match(main, /<DirectCampaigns [^>]*onOpenIntegrations=\{\(\) => setPage\('Integrations'\)\}/);
});

test('the Amazon SES feedback webhook URL is shown with a copy action only when SES sends email', async () => {
  const names = ['CopyButton', 'Disclosure', 'Field', 'Inline', 'Input', 'Stack'], url = 'https://campaign.example.test/api/webhooks/ses/sns';
  const show = status => renderSnippet(/\{status\?\.emailProvider === 'ses'[\s\S]*?<\/Disclosure>\}/, names, { status });
  const tree = await show({ emailProvider: 'ses', sesWebhookUrl: url }), found = nodes(tree);
  assert.equal(found.find(node => node.type === ui.CopyButton)?.props.value, url);
  assert.equal(found.find(node => node.type === ui.Input)?.props.value, url); assert.equal(found.find(node => node.type === ui.Input).props.readOnly, true);
  assert.match(found.find(node => node.type === ui.Field).props.description, /SNS topic .* over HTTPS/);
  assert.match(renderToStaticMarkup(tree), /Amazon SES feedback webhook/);
  for (const status of [{ emailProvider: 'cloudflare', sesWebhookUrl: url }, { emailProvider: null, sesWebhookUrl: url }, { emailProvider: 'ses' }, { emailProvider: 'ses', sesWebhookUrl: '' }, null]) assert.equal(renderToStaticMarkup(await show(status)), '');
});

test('a send refused for EMAIL_PROVIDER_REQUIRED shows the provider choice, other failures keep the server message', async () => {
  async function run(failure) {
    const errors = [], context = { pending: { current: false }, version: { current: 1 }, actionVersion: { current: 0 }, setBusy() {}, setNotice() {}, setError: value => errors.push(value), emailProviderChoice, rememberFocus() {} };
    await compile(section('async function action(', '\n  function acceptCampaign('), context)('Sending campaign', async () => { throw failure; });
    return errors.filter(Boolean);
  }
  assert.deepEqual(await run(Object.assign(new Error('Server text'), { status: 409, code: 'EMAIL_PROVIDER_REQUIRED' })), [emailProviderChoice]);
  assert.deepEqual(await run(Object.assign(new Error('Configure this sending provider in Integrations first.'), { code: 'INTEGRATION_NOT_CONFIGURED' })), ['Configure this sending provider in Integrations first.']);
  assert.deepEqual(await run(new Error('')), ['This action could not be completed.']);
});

test('Save and check audience validates the form through its ref, saves the draft, then previews the audience', async () => {
  const saveDraft = section('async function saveDraft(', '  async function save(');
  async function run(valid = true) {
    const requests = [], notices = [], previews = [], reported = [];
    const context = { formRef: { current: { reportValidity: () => { reported.push(true); return valid; } } }, readOnly: false, editable: true, draft: blankDraft, audienceMode: 'all', editingId: 'campaign-1', path: '/projects/a/direct', version: { current: 1 }, campaignBody, selectedTemplate: null, templateRestriction, action: async (_, perform) => perform(1), acceptCampaign() {}, setEditingId() {}, setNotice: value => notices.push(value), setError() {}, setPreview: value => previews.push(value), requester: { current: async (path, method, body) => { requests.push([path, method, body]); return path.endsWith('/preview') ? { previewToken: 'review', audience: { eligible: 2 } } : { campaign: { id: 'campaign-1', status: 'draft' } }; } } };
    context.saveDraft = compile(saveDraft, context);
    await compile(section('async function checkAudience(', '  async function openCampaign('), context)();
    return { requests, notices, previews, reported };
  }
  const checked = await run();
  assert.deepEqual(checked.reported, [true], 'Native validity is reported on the form.');
  assert.deepEqual(checked.requests.map(([path, method]) => [path, method]), [['/projects/a/direct/campaigns/campaign-1', 'PATCH'], ['/projects/a/direct/campaigns/campaign-1/preview', 'POST']]);
  assert.equal(checked.previews[0].result.previewToken, 'review'); assert.match(checked.notices.at(-1), /Audience and content checked/);
  const invalid = await run(false); assert.deepEqual(invalid.reported, [true]); assert.equal(invalid.requests.length, 0, 'An invalid form is not saved or previewed.');
  assert.match(source, /<Button variant="secondary" disabled=\{[^}]*\} onClick=\{checkAudience\}>Save and check audience<\/Button>/);
  assert.match(source, /formRef = useRef<HTMLFormElement>\(null\)/);
  assert.match(source, /<Form ref=\{formRef\} onSubmit=\{\(_, event\) => save\(event\)\}>/, 'The ui Form forwards the consumer ref to the native form.');
});

test('the test send is disabled with a reason and an Open integrations action when the channel has no provider', async () => {
  const [, ready, reason] = source.match(/const testProviderReady = (.+?), testProviderReason = (.+);\n/);
  const check = (status, channel = 'email') => compile(`() => [${ready}, ${reason}]`, { status, current: { channel }, labels: { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' }, emailProviderChoice })();
  assert.equal(check({ providers: { email: true }, emailProvider: 'ses' })[0], true);
  assert.equal(check(null)[0], true, 'An unknown status leaves the check to the server.');
  assert.deepEqual(check({ providers: { email: false }, emailProvider: 'cloudflare' }), [false, 'Set up Email sending in Settings › Connections to send a test.']);
  assert.deepEqual(check({ providers: { email: false }, emailProvider: null }), [false, emailProviderChoice]);
  assert.deepEqual(check({ providers: { sms: false } }, 'sms'), [false, 'Set up SMS sending in Settings › Connections to send a test.']);
  assert.match(source, /<Button variant="secondary" disabled=\{!!busy \|\| !testProviderReady \|\|[^}]*\} onClick=\{\(\) => setConfirmingTest\(true\)\}>/);
  const action = React.createElement(ui.Button, { variant: 'secondary', size: 'sm' }, 'Open Connections'), pattern = /\{!testProviderReady && <Inline[\s\S]*?<\/Inline>\}/;
  const html = renderToStaticMarkup(await renderSnippet(pattern, ['Inline', 'Text'], { testProviderReady: false, testProviderReason: 'Set up Email sending in Settings › Connections to send a test.', integrationsAction: action }));
  assert.match(html, /Set up Email sending in Settings › Connections to send a test\.[\s\S]*<button[^>]*>Open Connections<\/button>/);
  assert.equal(renderToStaticMarkup(await renderSnippet(pattern, ['Inline', 'Text'], { testProviderReady: true, testProviderReason: '', integrationsAction: action })), '');
});

// ten98-campaign#136: "Save draft" works before a WhatsApp account or template is chosen; the server asks for them at
// preview and send. Neither field may carry a required flag that native validation would enforce on save.
test('a WhatsApp draft can be saved before its account and template are chosen', () => {
  for (const label of ['Connected WhatsApp account', 'Approved template']) {
    const start = source.indexOf(`<Field label="${label}"`), field = start < 0 ? undefined : source.slice(start, source.indexOf('</Field>', start));
    assert.ok(field, label);
    assert.doesNotMatch(field.split('<Option')[0], /\brequired\b/, `${label} must not block saving a draft.`);
    assert.match(field, /description="Needed before preview and sending/);
  }
});

// ten98-campaign#137(a): the page says plainly that email campaigns are transactional only, and why.
test('Direct campaigns says email campaigns are transactional only, with the reason', () => {
  assert.match(source, /Email campaigns are for transactional messages such as receipts and updates\./);
  assert.doesNotMatch(source, /Manage permission-based email, SMS and approved WhatsApp template campaigns/, 'The intro no longer implies newsletters.');
  assert.match(source, /title="Transactional email only">[^<]*because the configured email provider is for transactional mail\./);
});

// ten98-campaign#137(b): the Marketing purpose is serialized, offered only while Amazon SES sends, and asks for marketing
// permission on contacts instead of the transactional confirmation.
test('the Marketing email purpose is offered only while Amazon SES sends, with a reason and Open integrations otherwise', () => {
  assert.equal(campaignBody({ ...blankDraft, emailPurpose: 'marketing' }, 'all').emailPurpose, 'marketing');
  assert.equal(campaignBody({ ...blankDraft, emailPurpose: 'other' }, 'all').emailPurpose, 'transactional', 'Anything else is sent as transactional.');
  assert.equal(campaignBody({ ...blankDraft, channel: 'sms', emailPurpose: 'marketing' }, 'all').emailPurpose, undefined);
  assert.match(source, /<Option value="marketing" disabled=\{!status\?\.marketingAvailable\}>Marketing<\/Option>/);
  assert.match(source, /'Marketing email needs Amazon SES as the email sender\.'/);
  assert.match(source, /\{!status\?\.marketingAvailable && status\?\.emailProvider !== null && editable && !readOnly && integrationsAction && <Inline>\{integrationsAction\}<\/Inline>\}/);
  assert.match(source, /draft\.channel === 'email' && draft\.emailPurpose !== 'marketing' && <Checkbox label="This is an expected transactional message/, 'Marketing sends skip the transactional confirmation.');
  assert.match(source, /draft\.emailPurpose === 'marketing' \? 'Marketing email' : 'Transactional email only'/);
  assert.match(source, /<Checkbox label="Email marketing permission \(newsletters and promotions\) is recorded for this contact\. Marketing email also needs email permission\." checked=\{contact\.consents\.emailMarketing\}/);
  assert.match(source, /<Checkbox label="Email marketing permission is recorded for all applicable imported contacts\." checked=\{importConsent\.emailMarketing\}/);
});

// ten98-campaign#135 client points: the import notice counts every processed row, skipped ones included, with a correct
// plural, and the preview says a merge updates details but keeps recorded permissions.
test('the import notice counts every processed row and the preview explains what a merge keeps', () => {
  const importNotice = compile(helper('importNotice'));
  assert.equal(importNotice({ imported: 4, created: 3, updated: 1, skipped: 2 }), 'Processed 6 rows: 3 created, 1 merged, 2 skipped. Review contact hygiene before sending.');
  assert.equal(importNotice({ created: 0, updated: 1, skipped: 0 }), 'Processed 1 row: 0 created, 1 merged, 0 skipped. Review contact hygiene before sending.');
  assert.equal(importNotice({}), 'Processed 0 rows: 0 created, 0 merged, 0 skipped. Review contact hygiene before sending.');
  assert.match(source, /\{importResult\.dryRun && importResult\.updated > 0 && <Text tone="muted" size="sm">Merging updates an existing contact's details from the file, such as name and company, and keeps the permissions and evidence already recorded\.<\/Text>\}/);
});

test('Messages shows campaigns and contacts as its own tabs, so a view hides the inner tab strip', async () => {
  const source = (await readFile(new URL('../src/DirectCampaigns.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  // #128 removed the inner tab strip altogether: the view picks contacts, the campaign page or the campaign list.
  assert.match(source, /\{view === 'contacts' \? contactsView : pageOpen \? campaignPage : campaignList\}/);
  assert.doesNotMatch(source, /<Tabs /);
  const app = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.match(app, /\['campaigns', 'people'\]\.includes\(directView\) && <Suspense[^\n]*<DirectCampaigns key=\{state\.projectId\} projectId=\{state\.projectId\} view=\{directView === 'people' \? 'contacts' : 'campaigns'\}/);
  assert.match(app, /<SegmentedControl label="Contacts to show" value=\{directView\}[^\n]*'Your contacts'[^\n]*'From social accounts'/);
});


test('a lead captured at a field activity reads From field activity, never its internal tag', () => {
  assert.match(source, /\(person\.tags \|\| \[\]\)\.filter\(\(tag: string\) => !tag\.startsWith\('offline:'\)\)\.join\(', '\)/, 'The internal offline:<id> tag is not shown under the name.');
  assert.match(source, /\(person\.tags \|\| \[\]\)\.some\(\(tag: string\) => tag\.startsWith\('offline:'\)\) && <Text as="small" tone="muted">From field activity<\/Text>/);
});
