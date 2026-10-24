// ten98-campaign#128: the Direct campaigns flow is a list, then one checklist page per campaign, with one tab level.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React, { useEffect, useRef, useState } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';

type Row = Record<string, any>;
const source = await readFile(new URL('../src/DirectCampaigns.tsx', import.meta.url), 'utf8');
const templateSource = await readFile(new URL('../src/WhatsAppTemplate.tsx', import.meta.url), 'utf8');
const mainSource = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
const library = ui as unknown as Record<string, unknown>;
const strip = (text: string) => text.replace(/^import .+;\r?\n/gm, '').replace(/^export (default )?/gm, '');
const compiled = async (text: string, file: string) => (await transformWithOxc(strip(text), file, { jsx: { runtime: 'classic' } })).code;
const templateModule = new Function('React', ...Object.keys(library), await compiled(templateSource, 'WhatsAppTemplate.tsx') + '; return { WhatsAppTemplate, templateRestriction, templatePreviewText, templateParameter, templateMissing };')(React, ...Object.values(library));
const module = new Function('React', 'useEffect', 'useRef', 'useState', 'WhatsAppTemplate', 'templateRestriction', 'templatePreviewText', 'templateMissing', 'useFocusReturn', 'useRevealPanel', ...Object.keys(library),
  await compiled(source, 'DirectCampaigns.tsx') + '; return { DirectCampaigns, localAudience, exclusionGroups, campaignChecks, campaignProgress, ChecklistRow, CampaignStatus, CampaignResults };',
)(React, useEffect, useRef, useState, templateModule.WhatsAppTemplate, templateModule.templateRestriction, templateModule.templatePreviewText, templateModule.templateMissing, () => () => {}, () => {}, ...Object.values(library));

const draft = (changes: Row = {}) => ({ name: 'Autumn notice', channel: 'email', emailPurpose: 'transactional', subject: 'Your receipt', text: 'Thanks {{name}}', html: '', accountId: '', templateName: '', templateLanguage: 'en', templateComponents: [], contactIds: [], tags: [], ...changes });
const person = (id: string, changes: Row = {}) => ({ id, name: id, email: `${id}@example.com`, phone: '+971501234567', tags: ['customer'], consents: { email: true, sms: true, whatsapp: true, emailMarketing: false }, ...changes });
const status = (changes: Row = {}) => ({ providers: { email: true, sms: true, whatsapp: true }, emailProvider: 'ses', marketingAvailable: true, publicCallbacks: true, accounts: [{ id: 'wa1', name: 'Brand WhatsApp' }], ...changes });
const checks = (changes: Row = {}) => module.campaignChecks({ draft: draft(), audienceMode: 'all', status: status(), selectedTemplate: null, estimate: { total: 3, eligible: 2 }, validPreview: { previewToken: 't', audience: { total: 3, eligible: 2, excluded: 1 } }, current: { id: 'c1', status: 'draft' }, sendMode: 'now', scheduledAt: '', readOnly: false, isOperator: false, ...changes });

test('the local audience estimate mirrors the server exclusions, scope and active suppressions', () => {
  const contacts = [person('a'), person('b', { consents: { email: false } }), person('c', { tags: ['lead'] }), person('d', { suppression: { email: { reason: 'Bounced' } } }), person('e', { suppression: { email: { reason: 'Held', expiresAt: '2000-01-01T00:00:00Z' } } }), person('f', { email: '' }), person('g', { hygiene: { disposable: true } }), person('h', { hygiene: { dnsStatus: 'nxdomain' } })];
  assert.deepEqual(module.localAudience(contacts, draft(), 'all'), { total: 8, eligible: 3 }, 'a, c and e (an expired hold) are eligible.');
  assert.deepEqual(module.localAudience(contacts, draft({ tags: ['customer'] }), 'tags'), { total: 7, eligible: 2 });
  assert.deepEqual(module.localAudience(contacts, draft({ contactIds: ['a', 'b'] }), 'contacts'), { total: 2, eligible: 1 });
  assert.deepEqual(module.localAudience(contacts, draft({ emailPurpose: 'marketing' }), 'all'), { total: 8, eligible: 0 }, 'Marketing needs its own permission.');
  assert.deepEqual(module.localAudience([person('a', { consents: { sms: true }, phone: '' }), person('b', { consents: { sms: true }, hygiene: { disposable: true } })], draft({ channel: 'sms' }), 'all'), { total: 2, eligible: 1 }, 'Email hygiene does not affect SMS.');
});

test('excluded contacts are grouped by reason so the parts add up to the excluded count', () => {
  const groups = module.exclusionGroups([{ reason: 'No recorded consent' }, { reason: 'Suppressed: Bounced' }, { reason: 'Suppressed: Complaint' }, { reason: 'No recorded consent' }, { reason: 'Suppressed: Bounced' }, { reason: 'No email address' }]);
  assert.deepEqual(groups, [{ reason: 'Suppressed', count: 3 }, { reason: 'No recorded consent', count: 2 }, { reason: 'No email address', count: 1 }]);
  assert.deepEqual(module.exclusionGroups(undefined), []);
});

test('each checklist row reports its status and the reason it blocks', () => {
  const ready = checks();
  assert.deepEqual(Object.keys(ready.rows), ['to', 'from', 'subject', 'content', 'time']);
  for (const row of Object.values(ready.rows) as Row[]) assert.equal(row.reason, undefined, row.summary);
  assert.deepEqual(ready.sendBlockers, []); assert.deepEqual(ready.draftBlockers, []);
  assert.match(ready.rows.to.summary, /2 eligible · 1 excluded/);
  assert.match(checks({ validPreview: null }).rows.to.summary, /~2 eligible/, 'Before a check the count is an estimate.');
  assert.match(ready.rows.from.summary, /Amazon SES · Transactional/);
  assert.equal(ready.rows.subject.summary, 'Your receipt');
  assert.equal(checks({ draft: draft({ subject: ' ' }) }).rows.subject.reason, 'Add a subject');
  assert.equal(checks({ draft: draft({ text: '' }) }).rows.content.reason, 'Add the plain-text message');
  assert.equal(checks({ audienceMode: 'contacts' }).rows.to.reason, 'Choose at least one contact');
  assert.equal(checks({ audienceMode: 'tags' }).rows.to.reason, 'Enter at least one tag');
  assert.equal(checks({ validPreview: { previewToken: 't', audience: { total: 4, eligible: 0, excluded: 4 } } }).rows.to.reason, 'All 4 contacts are excluded');
  assert.equal(checks({ status: status({ providers: { email: false } , emailProvider: 'cloudflare' }) }).rows.from.reason, 'Set up Email sending in Integrations');
  assert.equal(checks({ status: status({ providers: { email: false }, emailProvider: null }) }).rows.from.reason, 'Choose which service sends email in Settings › Connections');
  assert.equal(checks({ draft: draft({ emailPurpose: 'marketing' }), status: status({ marketingAvailable: false, emailProvider: 'cloudflare' }) }).rows.from.reason, 'Marketing email needs Amazon SES');
  assert.equal(checks({ status: null }).rows.from.reason, undefined, 'An unknown status leaves the provider check to the server.');
  const sms = checks({ draft: draft({ channel: 'sms', subject: '' }) });
  assert.deepEqual(Object.keys(sms.rows), ['to', 'from', 'content', 'time'], 'SMS has no subject row.');
});

test('WhatsApp rows need an account, an approved template and every template value', () => {
  const template = { name: 'receipt', language: 'en', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hi {{1}}, order {{2}}' }] };
  const base = { draft: draft({ channel: 'whatsapp', subject: '', text: '', accountId: 'wa1', templateName: 'receipt' }), selectedTemplate: template };
  assert.equal(checks({ ...base, draft: draft({ channel: 'whatsapp', accountId: '' }) }).rows.from.reason, 'Choose a WhatsApp account');
  assert.equal(checks(base).rows.from.summary, 'Brand WhatsApp');
  assert.equal(checks(base).rows.subject.label, 'Template');
  assert.equal(checks(base).rows.subject.summary, 'receipt · en');
  assert.equal(checks(base).rows.content.reason, 'Fill 2 template values');
  assert.equal(checks({ ...base, draft: { ...base.draft, templateComponents: [{ type: 'body', parameters: [{ type: 'text', text: 'Alex' }, { type: 'text', text: '42' }] }] } }).rows.content.reason, undefined);
  assert.equal(checks({ ...base, selectedTemplate: null }).rows.subject.reason, 'Load approved templates to check the saved template');
  assert.equal(checks({ ...base, selectedTemplate: null, draft: draft({ channel: 'whatsapp', accountId: 'wa1' }) }).rows.subject.reason, 'Choose an approved template');
  assert.equal(templateModule.templateMissing({ components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BUTTONS', buttons: [{ type: 'URL', url: 'https://example.com/{{1}}' }] }] }, []), 2, 'Media links and URL suffixes count as values.');
});

test('the send time row rejects past or far times and always names the timezone', () => {
  assert.equal(checks({ sendMode: 'schedule' }).rows.time.reason, 'Choose a send time');
  assert.equal(checks({ sendMode: 'schedule', scheduledAt: '2000-01-01T09:00' }).rows.time.reason, 'Choose a future time within 366 days');
  const later = new Date(Date.now() + 86400000), local = new Date(later.getTime() - later.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const scheduled = checks({ sendMode: 'schedule', scheduledAt: local }).rows.time;
  assert.equal(scheduled.reason, undefined); assert.ok(scheduled.summary.includes(Intl.DateTimeFormat().resolvedOptions().timeZone), scheduled.summary);
  assert.match(checks().rows.time.summary, /Send now, after you confirm/);
});

test('the primary action lists every blocker, without operator setup text for other members', () => {
  assert.deepEqual(checks({ validPreview: null }).sendBlockers, ['Check the audience']);
  assert.deepEqual(checks({ draft: draft({ name: '', subject: '' }), validPreview: null }).draftBlockers, ['Add a campaign name', 'Add a subject']);
  assert.ok(checks({ draft: draft({ subject: '' }) }).sendBlockers.includes('Add a subject'));
  assert.deepEqual(checks({ readOnly: true }).sendBlockers, ['You have view-only access']);
  const member = checks({ status: status({ publicCallbacks: false }) }).sendBlockers, operator = checks({ isOperator: true, status: status({ publicCallbacks: false }) }).sendBlockers;
  assert.deepEqual(member, ['Sending is unavailable until your admin finishes setup']);
  assert.doesNotMatch(member.join(' '), /APP_URL|operator/);
  assert.deepEqual(operator, ['Set the public web address (APP_URL) in the server settings']);
  assert.deepEqual(checks({ validPreview: { previewToken: 't', audience: { total: 900, eligible: 600, excluded: 300 } } }).sendBlockers, ['Choose at most 500 eligible recipients']);
  assert.deepEqual(checks({ current: undefined, validPreview: null }).sendBlockers, ['Check the audience'], 'Checking the audience saves a new draft first.');
});

test('a checklist row shows a status dot and its reason, and edits in place only while open', () => {
  const render = (props: Row) => renderToStaticMarkup(React.createElement(module.ChecklistRow, { label: 'Subject', onOpenChange() {}, ...props }, React.createElement(ui.Text, null, 'Subject field')));
  const done = render({ check: { summary: 'Your receipt' }, open: false });
  assert.match(done, /t98-badge[^"]*"[^>]*>[\s\S]*Ready/); assert.match(done, /Your receipt/); assert.doesNotMatch(done, /Subject field/);
  const blocked = render({ check: { summary: 'Your receipt', reason: 'Add a subject' }, open: false });
  assert.match(blocked, /Add a subject/); assert.match(blocked, /Needs attention/);
  assert.match(render({ check: { summary: '' }, open: true }), /Subject field/);
});

test('campaign rows show status, live progress and results', () => {
  assert.deepEqual(module.campaignProgress({ counts: { pending: 3, accepted: 2, delivered: 4, failed: 1, suppressed: 0, uncertain: 0 } }), { done: 7, total: 10 });
  assert.equal(module.campaignProgress({}), null);
  const sending = renderToStaticMarkup(React.createElement(module.CampaignStatus, { campaign: { status: 'sending', counts: { pending: 1, delivered: 3 } } }));
  assert.match(sending, /Sending/); assert.match(sending, /3 \/ 4 sent/); assert.match(sending, /<progress/);
  assert.match(renderToStaticMarkup(React.createElement(module.CampaignStatus, { campaign: { status: 'scheduled', scheduledAt: '2030-01-02T09:00:00Z' } })), /Scheduled/);
  const results = renderToStaticMarkup(React.createElement(module.CampaignResults, { campaign: { status: 'completed', counts: { pending: 0, accepted: 1, delivered: 5, failed: 2, suppressed: 1, uncertain: 0 } } }));
  assert.match(results, /5 delivered/); assert.match(results, /2 failed/); assert.match(results, /9 recipients/);
  assert.equal(renderToStaticMarkup(React.createElement(module.CampaignResults, { campaign: { status: 'draft' } })), '');
});

test('fields inside the draft form never stop Save draft for send-only choices, and changing when to send closes an open review', () => {
  const field = (label: string, end: string) => { const start = source.indexOf(`label="${label}"`); assert.ok(start > 0, label); return source.slice(start, source.indexOf(end, start)); };
  assert.doesNotMatch(field('Send at (your local timezone)', '/>'), /\brequired\b/);
  assert.doesNotMatch(field('Test recipient', 'onChange'), /\brequired\b/);
  assert.match(source, /<RadioGroup legend="When to send"[^\n]*onValueChange=\{value => \{ setSendMode\([^)]*\); setConfirmationMode\(''\); \}\}/);
});

const page = (props: Row) => renderToStaticMarkup(React.createElement(module.DirectCampaigns, { projectId: 'p1', request: async () => ({}), ...props }));
test('one tab level: campaigns and contacts are separate views without inner tabs or page-level refresh', () => {
  const campaigns = page({}), contacts = page({ view: 'contacts' });
  for (const html of [campaigns, contacts]) { assert.doesNotMatch(html, /role="tablist"/); assert.doesNotMatch(html, /Refresh lists/); assert.doesNotMatch(html, /<h2[^>]*>Direct campaigns<\/h2>/); }
  assert.match(campaigns, /New campaign/); assert.doesNotMatch(campaigns, /Project contacts/);
  assert.match(contacts, /Project contacts/); assert.doesNotMatch(contacts, /New campaign/);
  assert.doesNotMatch(source, /<Tabs /);
});

test('operator-only setup text is gated and the request paths are unchanged', () => {
  assert.match(source, /\{isOperator && status\?\.publicCallbacks === false && <Alert/);
  assert.match(source, /\{isOperator && <>\{status\?\.emailProvider === 'ses'/);
  const paths = [...new Set([...source.matchAll(/path \+ '([^']*)'/g)].map(match => match[1]))].sort();
  assert.deepEqual(paths, ['/campaigns', '/campaigns/', '/contacts', '/contacts/', '/contacts/assess-dns', '/contacts/import', '/status', '/templates?accountId='].sort());
  assert.deepEqual([...new Set([...source.matchAll(/'\/(preview|send|schedule|test|suppress)'/g)].map(match => match[1]))].sort(), ['preview', 'suppress', 'test']);
});

// The Messages Contacts tab and its switch belong to #189; this flow adds only the operator flag to that mount.
test('main mounts the campaign and contact views through the Messages Contacts tab and passes the operator flag', () => {
  assert.match(mainSource, /\['campaigns', 'people'\]\.includes\(directView\) && [^\n]*<DirectCampaigns key=\{state\.projectId\} projectId=\{state\.projectId\} view=\{directView === 'people' \? 'contacts' : 'campaigns'\} isOperator=\{canMap\}/);
  assert.doesNotMatch(mainSource, /section: 'people', label: 'Contacts'/, 'There is no second Contacts tab.');
});
