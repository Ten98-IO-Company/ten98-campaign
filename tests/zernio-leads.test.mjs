import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { createApp } from '../server/index.mjs';

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-leads-')), originalFetch = globalThis.fetch, origin = 'https://leads.example.test', calls = [];
  const app = createApp({ dataDir, env: { ZERNIO_API_KEY: 'synthetic-leads-key' }, appUrl: origin, directScheduler: false });
  const accounts = ['metaads', 'linkedinads'].map(platform => ({ _id: platform + '-account', platform, profileId: 'lead-profile', isActive: true, displayName: platform }));
  const meta = index => ({ id: 'meta-form-' + index, name: 'Meta form ' + index, status: 'ACTIVE', questions: [{ type: 'EMAIL' }, { type: 'FULL_NAME' }, { type: 'PHONE' }], privacy_policy_url: 'https://example.test/privacy', accessToken: 'must-not-leak' });
  const state = { forms: { metaads: [meta(1), meta(2)], linkedinads: [{ id: 'linkedin-form-1', name: 'LinkedIn inquiry', state: 'PUBLISHED', headline: 'Talk to us', questions: [{ kind: 'text', name: 'email', question: 'Work email' }, { kind: 'text', name: 'Company name', question: 'Company name' }], accessToken: 'must-not-leak' }] }, paged: false, hook: null, sequence: 0, tests: new Map() };
  const submitted = (formId, accountId, index) => ({ id: 'lead-' + index, formId, accountId, leadgenId: 'native-' + index, createdTime: '2026-10-18T10:30:00+0000', fields: { email: `lead${index}@example.test`, full_name: 'Reviewed lead ' + index, phone_number: '+971 50 123 456' + index, 'Company name': 'Example Company', channel_consent: 'yes' }, secret: 'must-not-leak' });
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.hostname, 'zernio.com'); assert.equal(options.headers.Authorization, 'Bearer synthetic-leads-key');
    const method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, method, body, key: options.headers['Idempotency-Key'] });
    if (state.hook) { const response = await state.hook(url, options, body); if (response !== undefined) return response; }
    if (url.pathname.endsWith('/accounts') && !url.pathname.endsWith('/ads/accounts')) return Response.json({ accounts: [...accounts, { _id: 'foreign-account', platform: 'metaads', profileId: 'foreign-profile', isActive: true }] });
    if (url.pathname.endsWith('/ads/accounts')) { assert.equal(url.searchParams.get('inScopeOnly'), 'true'); return Response.json({ accounts: [{ id: 'advertiser-1', name: 'Verified advertiser', selectable: true }, { id: 'disabled-advertiser', name: 'Unavailable advertiser', selectable: false }] }); }
    if (url.pathname.endsWith('/ads/lead-forms') && method === 'POST') {
      const linkedin = body.accountId.startsWith('linkedin'), form = { id: 'created-' + (++state.sequence), name: body.name, ...(linkedin ? { state: body.platformSpecificData.state } : { status: 'ACTIVE' }), ...body.platformSpecificData, questions: body.platformSpecificData.questions, privacy_policy_url: body.privacyPolicyUrl };
      state.forms[linkedin ? 'linkedinads' : 'metaads'].push(form); return Response.json({ status: 'success', form: { id: form.id, name: form.name } });
    }
    if (url.pathname.endsWith('/ads/lead-forms')) {
      const platform = url.searchParams.get('accountId').startsWith('linkedin') ? 'linkedinads' : 'metaads';
      if (platform === 'linkedinads') assert.equal(url.searchParams.get('adAccountId'), 'advertiser-1'); else assert.equal(url.searchParams.has('adAccountId'), false);
      const rows = state.forms[platform], offset = url.searchParams.has('cursor') ? 1 : 0, page = state.paged ? rows.slice(offset, offset + 1) : rows;
      return Response.json({ status: 'success', forms: page, pagination: { hasMore: state.paged && offset === 0 && rows.length > 1, cursor: state.paged && offset === 0 && rows.length > 1 ? 'form-next+/' : null } });
    }
    const detail = /\/ads\/lead-forms\/([^/]+)$/.exec(url.pathname);
    if (detail) {
      const formId = decodeURIComponent(detail[1]), platform = url.searchParams.get('accountId').startsWith('linkedin') ? 'linkedinads' : 'metaads', form = state.forms[platform].find(row => row.id === formId); assert.ok(form, formId);
      if (method === 'DELETE') { if (platform === 'linkedinads') form.state = 'ARCHIVED'; else form.status = 'ARCHIVED'; return Response.json({ status: 'success', formId, archived: true }); }
      return Response.json({ status: 'success', form });
    }
    const testLead = /\/ads\/lead-forms\/([^/]+)\/test-leads$/.exec(url.pathname);
    if (testLead) {
      const formId = decodeURIComponent(testLead[1]);
      if (method === 'POST') { const id = 'synthetic-test-' + (++state.sequence); state.tests.set(id, { formId, body }); return Response.json({ status: 'success', testLead: { id } }); }
      const id = url.searchParams.get('leadId'); assert.equal(state.tests.get(id)?.formId, formId); state.tests.delete(id); return Response.json({ status: 'success', deleted: [id] });
    }
    const formLeads = /\/ads\/lead-forms\/([^/]+)\/leads$/.exec(url.pathname);
    if (formLeads || url.pathname.endsWith('/ads/leads')) {
      const accountId = url.searchParams.get('accountId'), formId = formLeads ? decodeURIComponent(formLeads[1]) : url.searchParams.get('formId');
      if (!formLeads) assert.equal(url.searchParams.get('adAccountId'), 'advertiser-1');
      const next = url.searchParams.has('cursor'), rows = [submitted(formId, accountId, 1), submitted(formId, accountId, 2)];
      return Response.json({ status: 'success', leads: state.paged ? [rows[next ? 1 : 0]] : rows, pagination: { hasMore: state.paged && !next, cursor: state.paged && !next ? 'lead-next+/' : null } });
    }
    assert.fail('Unexpected synthetic lead endpoint: ' + method + ' ' + url.pathname);
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${app.server.address().port}/api`; let cookie;
  async function request(path, method = 'GET', body, key = randomUUID(), authenticated = true) {
    const response = await originalFetch(base + path, { method, headers: { Origin: origin, ...(authenticated && cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...(method === 'POST' ? { 'Idempotency-Key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const setup = await request('/auth/setup', 'POST', { name: 'Lead owner', email: 'owner@example.test', password: 'synthetic lead acceptance passphrase', sample: false }); cookie = setup.cookie; const project = '/projects/' + setup.data.projectId;
  await request(project, 'PATCH', { zernioProfileId: 'lead-profile' });
  const path = project + '/integrations/leads', formPath = platform => `${path}/${platform}-account/forms`, selected = platform => `${formPath(platform)}/${state.forms[platform][0].id}`;
  return { app, state, calls, accounts, project, path, formPath, selected, request, query: '?adAccountId=advertiser-1', writes: () => calls.filter(row => row.method !== 'GET'), async close() { await app.close(); globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); } };
}

test('authenticated lead browser verifies project, native advertiser and paginated form ownership before scoped reads', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.request(f.path + '/accounts', 'GET', undefined, undefined, false)).status, 401);
    const accounts = await f.request(f.path + '/accounts'); assert.equal(accounts.status, 200); assert.equal(accounts.data.accounts.length, 2);
    assert.equal((await f.request(`${f.path}/foreign-account/forms${f.query}`)).status, 403);
    for (const native of ['foreign-advertiser', 'disabled-advertiser']) assert.equal((await f.request(`${f.formPath('metaads')}?adAccountId=${native}`)).status, 403);
    f.state.paged = true; const first = await f.request(f.formPath('metaads') + f.query); assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(first.data.pagination.cursor, 'form-next+/');
    const second = await f.request(f.formPath('metaads') + f.query + '&cursor=form-next%2B%2F'); assert.equal(second.data.forms[0].id, 'meta-form-2');
    const detail = await f.request(f.formPath('metaads') + '/meta-form-2' + f.query); assert.equal(detail.status, 200); assert.equal(detail.data.form.id, 'meta-form-2'); assert.equal(detail.data.form.accessToken, undefined);
    const count = f.calls.length; assert.equal((await f.request(f.formPath('metaads') + '/unknown-form/leads' + f.query)).status, 403); assert.ok(f.calls.slice(count).every(row => !row.url.pathname.endsWith('/leads')));
    for (const platform of ['metaads', 'linkedinads']) {
      const leads = await f.request(f.selected(platform) + '/leads' + f.query); assert.equal(leads.status, 200, JSON.stringify(leads.data)); assert.equal(leads.data.leads[0].fields.email, 'lead1@example.test'); assert.equal(leads.data.leads[0].createdTime, '2026-10-18T10:30:00.000Z'); assert.equal(leads.data.leads[0].secret, undefined); assert.equal(leads.data.pagination.hasMore, true);
      const next = await f.request(f.selected(platform) + '/leads' + f.query + '&cursor=lead-next%2B%2F'); assert.equal(next.data.leads[0].id, 'lead-2');
    }
    assert.equal(f.writes().length, 0); assert.equal((await f.request(f.project + '/direct/contacts')).data.contacts.length, 0, 'Reading responses never creates contacts.');
  } finally { await f.close(); }
});

test('lead import revalidates reviewed answers, preserves contact consent/suppression and persists one association across replays', async () => {
  const f = await fixture();
  try {
    const created = await f.request(f.project + '/direct/contacts', 'POST', { name: 'Existing contact', email: 'lead1@example.test', phone: '+971501234561', consents: { email: true, whatsapp: true }, consentSource: 'Earlier documented channel permission' }); assert.equal(created.status, 201, JSON.stringify(created.data));
    const contact = created.data.contact;
    const suppressed = await f.request(`${f.project}/direct/contacts/${contact.id}/suppress`, 'POST', { channel: 'sms', reason: 'Earlier opt-out' }); assert.equal(suppressed.status, 200, JSON.stringify(suppressed.data));
    f.state.paged = true; const row = (await f.request(f.selected('metaads') + '/leads' + f.query)).data.leads[0];
    const route = f.selected('metaads') + `/leads/${row.id}/import`, body = { adAccountId: 'advertiser-1', expectedLeadVersion: row.version, confirmImport: true, mapping: { name: 'full_name', email: 'email', phone: 'phone_number', company: 'Company name' } };
    assert.equal((await f.request(route, 'POST', { ...body, confirmImport: false })).status, 400);
    assert.equal((await f.request(route, 'POST', { ...body, expectedLeadVersion: 'stale' })).status, 409);
    assert.equal((await f.request(route, 'POST', { ...body, mapping: { email: 'invented-answer' } })).status, 400);
    const key = randomUUID(), imported = await f.request(route, 'POST', body, key); assert.equal(imported.status, 200, JSON.stringify(imported.data)); assert.equal(imported.data.operation.status, 'complete'); assert.equal(imported.data.contact.id, contact.id);
    assert.equal(imported.data.contact.consents.email, true); assert.equal(imported.data.contact.consents.whatsapp, true); assert.equal(imported.data.contact.consents.sms, false); assert.equal(imported.data.contact.suppression.sms.reason, 'Earlier opt-out');
    const replay = await f.request(route, 'POST', body, key); assert.deepEqual(replay.data, imported.data);
    const fresh = await f.request(route, 'POST', body); assert.equal(fresh.data.alreadyImported, true); assert.equal(fresh.data.association.contactId, contact.id);
    assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM zernio_lead_associations').get().n, 1); assert.equal((await f.request(f.project + '/direct/contacts')).data.contacts.length, 1);
    const second = (await f.request(f.selected('metaads') + '/leads' + f.query + '&cursor=lead-next%2B%2F')).data.leads[0];
    const secondImport = await f.request(f.selected('metaads') + `/leads/${second.id}/import`, 'POST', { ...body, expectedLeadVersion: second.version, mapping: { email: 'email' } }); assert.equal(secondImport.status, 200); assert.deepEqual(secondImport.data.contact.consents, { email: false, sms: false, whatsapp: false });
    assert.equal(f.writes().length, 0, 'Contact import makes local changes only.');
  } finally { await f.close(); }
});

test('form creation, archival and app-created Meta test lead lifecycle use typed scoped contracts and exact-key receipts', async () => {
  const f = await fixture();
  try {
    for (const platform of ['metaads', 'linkedinads']) {
      const body = { adAccountId: 'advertiser-1', name: platform + ' typed form', privacyPolicyUrl: 'https://example.test/privacy', questions: platform === 'metaads' ? [{ type: 'EMAIL' }, { type: 'CUSTOM', key: 'team', label: 'Team size', options: [{ key: 'small', value: 'Small' }] }] : [{ kind: 'text', name: 'email', question: 'Work email', required: true }, { kind: 'multipleChoice', name: 'team', question: 'Team size', choices: [{ id: 1, text: 'Small' }] }], ...(platform === 'linkedinads' ? { headline: 'Enquire', description: 'Tell us about your project', state: 'PUBLISHED', consents: [{ description: 'Contact me about this inquiry', required: true }] } : { thankYouTitle: 'Thank you' }) }, key = randomUUID();
      const result = await f.request(f.formPath(platform) + '/create', 'POST', body, key); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.form.name, body.name);
      const count = f.writes().length; assert.equal((await f.request(f.formPath(platform) + '/create', 'POST', body, key)).status, 200); assert.equal(f.writes().length, count);
      const form = result.data.form, archived = await f.request(f.formPath(platform) + '/' + form.id + '/archive', 'POST', { adAccountId: 'advertiser-1', expectedFormVersion: form.version, confirmArchive: form.id }); assert.equal(archived.status, 200, JSON.stringify(archived.data)); assert.equal(archived.data.form.status, 'ARCHIVED');
    }
    const detail = (await f.request(f.selected('metaads') + f.query)).data.form;
    const created = await f.request(f.selected('metaads') + '/test-leads/create', 'POST', { adAccountId: 'advertiser-1', expectedFormVersion: detail.version, confirmTest: true, fieldData: [{ name: 'email', values: ['synthetic@example.test'] }] }); assert.equal(created.status, 200, JSON.stringify(created.data)); const id = created.data.testLead.id;
    assert.equal((await f.request(f.selected('metaads') + f.query)).data.testLeads[0].id, id);
    assert.equal((await f.request(f.selected('metaads') + '/test-leads/real-lead/delete', 'POST', { adAccountId: 'advertiser-1', confirmDelete: 'real-lead' })).status, 403);
    const removed = await f.request(f.selected('metaads') + `/test-leads/${id}/delete`, 'POST', { adAccountId: 'advertiser-1', confirmDelete: id }); assert.equal(removed.status, 200); assert.equal(removed.data.deleted, id);
    assert.equal((await f.request(f.selected('metaads') + f.query)).data.testLeads.length, 0);
    const linkedin = (await f.request(f.selected('linkedinads') + f.query)).data.form;
    assert.equal((await f.request(f.selected('linkedinads') + '/test-leads/create', 'POST', { adAccountId: 'advertiser-1', expectedFormVersion: linkedin.version, confirmTest: true, fieldData: [{ name: 'email', values: ['synthetic@example.test'] }] })).status, 422);
    const before = f.writes().length;
    for (const questions of [[{ type: 'EMAIL', label: 'Invalid override' }], [{ type: 'CUSTOM', key: 'same', label: 'First' }, { type: 'CUSTOM', key: 'same', label: 'Second' }]]) assert.equal((await f.request(f.formPath('metaads') + '/create', 'POST', { adAccountId: 'advertiser-1', name: 'Invalid form', privacyPolicyUrl: 'https://example.test/privacy', questions })).status, 400);
    assert.equal(f.writes().length, before);
  } finally { await f.close(); }
});

test('lead reads reject malformed and foreign data, role changes and unsupported filters before returning contact answers', async () => {
  const f = await fixture();
  try {
    for (const row of [{ id: 'foreign', formId: 'other-form', fields: {} }, { id: 'bad', formId: 'meta-form-1', fields: { email: {} } }]) {
      f.state.hook = url => url.pathname.endsWith('/meta-form-1/leads') ? Response.json({ status: 'success', leads: [row], pagination: { hasMore: false, cursor: null } }) : undefined;
      assert.equal((await f.request(f.selected('metaads') + '/leads' + f.query)).status, 502);
    }
    f.state.hook = null; assert.equal((await f.request(f.formPath('metaads') + f.query + '&fields=access_token')).status, 400);
    f.state.hook = url => { if (url.pathname.endsWith('/meta-form-1/leads')) { f.app.db.prepare("UPDATE memberships SET role='viewer'").run(); return Response.json({ status: 'success', leads: [], pagination: { hasMore: false, cursor: null } }); } };
    assert.equal((await f.request(f.selected('metaads') + '/leads' + f.query)).status, 403); f.state.hook = null;
    const before = f.calls.length; assert.equal((await f.request(f.formPath('metaads') + '/create', 'POST', {})).status, 403); assert.equal(f.calls.length, before);
    f.app.db.prepare("UPDATE memberships SET role='editor'").run(); assert.equal((await f.request(f.formPath('metaads') + '/create', 'POST', {})).status, 403);
    const row = (await f.request(f.selected('metaads') + '/leads' + f.query)).data.leads[0];
    assert.equal((await f.request(f.selected('metaads') + `/leads/${row.id}/import`, 'POST', { adAccountId: 'advertiser-1', expectedLeadVersion: row.version, confirmImport: true, mapping: { email: 'email' } })).status, 200);
  } finally { await f.close(); }
});

test('form creation requires a fresh id and read-back proof of the requested privacy, questions and consent settings', async () => {
  for (const drift of ['existing-id', 'privacy', 'question', 'consent', 'required', 'response-editable', 'response-length']) {
    const f = await fixture();
    try {
      const linkedin = ['consent', 'required', 'response-editable', 'response-length'].includes(drift), platform = linkedin ? 'linkedinads' : 'metaads';
      const body = { adAccountId: 'advertiser-1', name: 'Verified requested form', privacyPolicyUrl: 'https://example.test/privacy', questions: linkedin ? [{ kind: 'text', name: 'email', question: 'Work email', required: true, responseEditable: false, maxResponseLength: 120 }] : [{ type: 'CUSTOM', key: 'email', label: 'Work email' }], ...(linkedin ? { headline: 'Headline', description: 'Description', state: 'PUBLISHED', consents: [{ description: 'Contact me about this inquiry', required: true }] } : {}) };
      f.state.hook = (url, options) => {
        if (drift === 'existing-id' && url.pathname.endsWith('/ads/lead-forms') && options.method === 'POST') return Response.json({ status: 'success', form: { id: f.state.forms.metaads[0].id, name: body.name } });
        if (options.method !== 'GET' || !url.pathname.endsWith('/created-1')) return;
        const row = structuredClone(f.state.forms[platform].find(row => row.id === 'created-1'));
        if (drift === 'privacy') row.privacy_policy_url = 'https://different.example/privacy';
        if (drift === 'question') row.questions[0].label = 'Different question';
        if (drift === 'consent') row.consents[0].description = 'Unreviewed consent';
        if (drift === 'required') row.questions[0].required = false;
        if (drift === 'response-editable') row.questions[0].responseEditable = true;
        if (drift === 'response-length') row.questions[0].maxResponseLength = 300;
        return Response.json({ status: 'success', form: row });
      };
      const result = await f.request(f.formPath(platform) + '/create', 'POST', body); assert.equal(result.status, 409, drift + ': ' + JSON.stringify(result.data)); assert.equal(result.data.operation.status, 'uncertain');
      const writes = f.writes().length; assert.equal((await f.request(f.formPath(platform) + '/create', 'POST', { ...body, name: 'Do not duplicate an unknown form' })).status, 409); assert.equal(f.writes().length, writes);
    } finally { await f.close(); }
  }
});

test('unknown lead mutations retain durable fences across changed request bodies until explicit recovery', async () => {
  const f = await fixture();
  try {
    const body = { adAccountId: 'advertiser-1', name: 'Unconfirmed creation', privacyPolicyUrl: 'https://example.test/privacy', questions: [{ type: 'EMAIL' }] }, key = randomUUID();
    f.state.hook = (url, options) => url.pathname.endsWith('/ads/lead-forms') && options.method === 'POST' ? Response.json({ status: 'success', form: { id: null } }) : undefined;
    const unknown = await f.request(f.formPath('metaads') + '/create', 'POST', body, key); assert.equal(unknown.status, 409); assert.equal(unknown.data.operation.status, 'uncertain'); const count = f.writes().length;
    assert.equal((await f.request(f.formPath('metaads') + '/create', 'POST', body, key)).status, 409);
    const blocked = await f.request(f.formPath('metaads') + '/create', 'POST', { ...body, name: 'Changed request body' }); assert.equal(blocked.status, 409); assert.equal(blocked.data.error.code, 'LEAD_PREVIOUS_OUTCOME_UNRESOLVED'); assert.equal(blocked.data.operation.status, 'failed'); assert.equal(f.writes().length, count);
    const reviewed = await f.request(`${f.project}/operations/${unknown.data.operation.id}/review`, 'POST', { resolution: 'not_applied', confirmChecked: true, note: 'Synthetic fixture confirmed the malformed request persisted no form.', reference: 'synthetic-no-form' }); assert.equal(reviewed.status, 200, JSON.stringify(reviewed.data));
    f.state.hook = null; const result = await f.request(f.formPath('metaads') + '/create', 'POST', { ...body, name: 'Reviewed new creation' }); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(f.app.db.prepare('SELECT count(*) AS n FROM zernio_lead_mutations').get().n, 0);
  } finally { await f.close(); }
});

test('lead UI retains exact operation keys through uncertain writes and rejects responses from an abandoned scope', async () => {
  const source = await readFile(new URL('../src/ZernioLeads.tsx', import.meta.url), 'utf8'), start = source.indexOf('async function write('), code = stripTypeScriptTypes(source.slice(start, source.indexOf('  function prepareImport(', start)));
  const keys = { current: new Map() }, calls = []; let live = true, unknown = true, priorUnresolved = false;
  const write = new Function('current', 'keys', 'crypto', 'requester', `return (${code});`)(() => live, keys, crypto, { current: async (...args) => { calls.push(args); if (unknown) throw Object.assign(new Error('Unknown outcome'), { status: 409, code: 'OPERATION_UNCERTAIN' }); if (priorUnresolved) throw Object.assign(new Error('Review the prior outcome'), { status: 409, code: 'LEAD_PREVIOUS_OUTCOME_UNRESOLVED', operation: { status: 'failed' } }); return { operation: { status: 'complete' }, contact: { id: 'contact' }, association: { contactId: 'contact' } }; } });
  const body = { adAccountId: 'advertiser-1', expectedLeadVersion: 'reviewed', confirmImport: true, mapping: { email: 'email' } };
  await assert.rejects(write('/import', body, 'import'), /Unknown/); assert.equal(keys.current.size, 1); unknown = false; await write('/import', body, 'import'); assert.deepEqual(calls[0], calls[1]);
  priorUnresolved = true; await assert.rejects(write('/import', body, 'import'), /prior outcome/); assert.equal(keys.current.size, 0, 'A definite non-dispatch must release its failed key so recovery can permit a fresh request.'); const failedKey = calls.at(-1)[3];
  priorUnresolved = false; await write('/import', body, 'import'); assert.notEqual(calls.at(-1)[3], failedKey);
  live = false; await assert.rejects(write('/import', body, 'import'), /changed/); assert.equal(calls.length, 4);
  assert.doesNotMatch(source, /window\.confirm/);
});

test('test-lead confirmation belongs to the reviewed form version rather than a later selected form', async () => {
  const source = await readFile(new URL('../src/ZernioLeads.tsx', import.meta.url), 'utf8');
  const checkbox = source.match(/checked=\{confirmTest === selected\.version\} onChange=\{(event => setConfirmTest\([^}]+\))\}/);
  assert.ok(checkbox, 'The rendered checkbox must capture the selected form version.');
  const before = { id: 'first-form', version: 'reviewed-form', questions: [{ key: 'email' }] }, after = { ...before, id: 'new-form', version: 'unseen-form' };
  let confirmed = false; new Function('selected', 'setConfirmTest', `return (${checkbox[1]});`)(before, value => { confirmed = value; })({ target: { checked: true } });
  assert.equal(confirmed, before.version);
  const start = source.indexOf('async function createTest('), code = stripTypeScriptTypes(source.slice(start, source.indexOf('  async function deleteTest(', start))), writes = [];
  const submit = selected => new Function('canManage', 'linkedin', 'selected', 'confirmTest', 'testAnswers', 'action', 'write', 'current', 'target', 'adAccountId', 'setTestLeads', 'setConfirmTest', 'setNotice', 'merge', `return (${code});`)(true, false, selected, confirmed, { email: 'synthetic@example.test' }, run => run(), async (...args) => { writes.push(args); return { testLead: { id: 'test' } }; }, () => true, '/forms', 'advertiser-1', () => {}, () => {}, () => {}, () => []);
  await submit(after)({ preventDefault() {} }); assert.equal(writes.length, 0, 'A newly selected form cannot inherit the prior form’s review.');
  await submit(before)({ preventDefault() {} }); assert.equal(writes.length, 1); assert.equal(writes[0][1].expectedFormVersion, before.version);
});
