import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('../src/DirectCampaigns.tsx', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function compile(code, context = {}) { return new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context)); }
const event = { preventDefault() {} };
const campaignBody = compile(section('function campaignBody(', 'const when ='));
const templateRestriction = compile(section('function templateRestriction(', 'function templatePreviewText('));
const templatePreviewText = compile(section('function templatePreviewText(', 'const statusLabel ='));
const blankDraft = { name: 'Launch notice', channel: 'email', subject: 'Receipt for {{name}}', text: 'Your receipt', html: '<p>Receipt</p>', accountId: 'wa-account', templateName: 'receipt', templateLanguage: 'en', templateComponents: [], contactIds: [], tags: [] };

test('actual campaign serialization keeps channel fields separate and never broadens an empty explicit audience', () => {
  assert.deepEqual(campaignBody(blankDraft, 'all'), { name: 'Launch notice', channel: 'email', subject: 'Receipt for {{name}}', text: 'Your receipt', html: '<p>Receipt</p>', emailPurpose: 'transactional', contactIds: [], tags: [] });
  assert.deepEqual(campaignBody({ ...blankDraft, channel: 'sms', contactIds: ['one'], tags: ['other'] }, 'contacts'), { name: 'Launch notice', channel: 'sms', text: 'Your receipt', contactIds: ['one'], tags: [] });
  const whatsapp = campaignBody({ ...blankDraft, channel: 'whatsapp', tags: ['customer'] }, 'tags');
  assert.deepEqual(whatsapp.tags, ['customer']); assert.equal(whatsapp.subject, undefined); assert.equal(whatsapp.text, undefined); assert.equal(whatsapp.accountId, 'wa-account');
  assert.throws(() => campaignBody(blankDraft, 'contacts'), /Choose at least one contact/);
  assert.throws(() => campaignBody(blankDraft, 'tags'), /Enter at least one audience tag/);
});

test('actual WhatsApp field handler preserves media details and the real button index, with readable template previews', () => {
  let draft = { ...blankDraft, templateComponents: [] };
  function input(...values) { compile(section('function templateParameter(', '  async function send('), { draft, setDraft: value => { draft = value; } })(...values); }
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
  const action = compile(section('async function action(', '  function acceptCampaign('), { pending, version, actionVersion, setBusy: value => busy.push(value), setError: value => errors.push(value), setNotice() {} });
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
  const context = { readOnly: false, action: async (_, run) => run(1), requester: { current: async (path, method, body) => { calls.push({ path, method, body }); return method === 'POST' ? { imported: 3, created: 2, updated: 1, skipped: 0, errors: [] } : { contacts: [{ id: 'saved' }] }; } }, path: '/projects/a/direct', csv: 'name,email,tags\nAlex,alex@example.com,customer|launch', importConsent: { email: true, sms: false, whatsapp: false }, importSource: 'Signup form 2026-10-18', version: { current: 1 }, setImportResult: value => results.push(value), setNotice: value => notices.push(value), setContacts: value => people.push(value) };
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
