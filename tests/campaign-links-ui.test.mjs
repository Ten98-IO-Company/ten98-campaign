import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as UI from '@ten98/ui';

const source = await readFile(new URL('../src/CampaignLinks.tsx', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const compile = (code, context = {}) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context));
const DestinationError = compile(source.match(/class DestinationError extends Error \{\}/)[0]);
const destinationWithUtm = compile(section('function destinationWithUtm(', 'const localShortAddress'), { DestinationError });
const event = { preventDefault() {} }, path = '/projects/project-a/links';
const draft = { name: 'Launch', destination: 'https://example.com/offer?product=one&utm_source=old#details', campaignId: 'campaign-a', utm_source: ' instagram ', utm_medium: 'social', utm_campaign: '', utm_content: '', utm_term: '' };

test('actual link creation preserves destination parameters, applies optional UTM values and never submits an unsafe protocol', async () => {
  const url = new URL(destinationWithUtm(draft)); assert.equal(url.searchParams.get('product'), 'one'); assert.equal(url.searchParams.get('utm_source'), 'instagram'); assert.equal(url.hash, '#details');
  for (const destination of ['javascript:alert(1)', 'http://example.com/offer', 'https://user:secret@example.com/offer']) assert.throws(() => destinationWithUtm({ ...draft, destination }), error => error instanceof DestinationError && /public HTTPS/.test(error.message));
  assert.throws(() => destinationWithUtm({ ...draft, destination: 'example.com/offer' }), error => error instanceof DestinationError && /https:\/\//.test(error.message));
  const calls = [], saved = [], selections = [], cleared = [];
  const create = compile(section('async function create(', '  async function saveName('), { readOnly: false, draft, links: [], destinationWithUtm, DestinationError, setDestinationError: value => assert.equal(value, '', 'A valid destination has no field error.'), destinationRef: { current: null }, focusDestination: { current: false }, action: async (_, run) => run(1), requester: { current: async (...args) => { calls.push(args); return { link: { id: 'new-link', name: 'Launch' } }; } }, path, version: { current: 1 }, acceptLink: value => saved.push(value), setSelected: value => selections.push(value), setDraft: value => cleared.push(value), blank: () => ({}), setNotice() {} });
  await create(event); assert.deepEqual(calls[0], [path, 'POST', { name: 'Launch', destination: url.href, campaignId: 'campaign-a' }]); assert.deepEqual(saved, [{ id: 'new-link', name: 'Launch' }]); assert.deepEqual(selections, ['new-link']); assert.equal(cleared.length, 1);
});

test('destination problems from the client check or the server show on the destination field, not as a form error', async () => {
  const run = (destination, response) => {
    const calls = [], fieldErrors = [], formErrors = [], focused = [], focusDestination = { current: false };
    const create = compile(section('async function create(', '  async function saveName('), { readOnly: false, draft: { ...draft, destination }, links: [], destinationWithUtm, DestinationError, setDestinationError: value => { if (value) fieldErrors.push(value); }, destinationRef: { current: { focus: () => focused.push('destination') } }, focusDestination,
      action: async (_, work) => { try { await work(1); } catch (failure) { formErrors.push(failure.message); } }, requester: { current: async (...args) => { calls.push(args); return response(); } }, path, version: { current: 1 }, acceptLink() {}, setSelected() {}, setDraft() {}, blank: () => ({}), setNotice() {} });
    return create(event).then(() => ({ calls, fieldErrors, formErrors, focused, deferredFocus: focusDestination.current }));
  };
  const local = await run('http://example.com/offer', () => assert.fail('An HTTP destination is never sent.'));
  assert.deepEqual(local, { calls: [], fieldErrors: ['Choose a public HTTPS destination without embedded credentials.'], formErrors: [], focused: ['destination'], deferredFocus: false }, 'The client check focuses the enabled field at once.');
  const server = await run('https://intranet.example/offer', () => { throw Object.assign(new Error('Use a public HTTPS domain without credentials or private addresses.'), { status: 400 }); });
  assert.deepEqual([server.calls.length, server.fieldErrors, server.formErrors, server.deferredFocus], [1, ['Use a public HTTPS domain without credentials or private addresses.'], [], true], 'A server rejection focuses the field after the fieldset re-enables.');
  const other = await run('https://example.com/offer', () => { throw Object.assign(new Error('Choose a campaign in this project.'), { status: 400 }); });
  assert.deepEqual([other.fieldErrors, other.formErrors], [[], ['Choose a campaign in this project.']], 'Other failures stay form-level.');
  // The field carries the message and aria-invalid through Field's error, and takes focus once the fieldset is enabled again.
  assert.match(source, /<Field label="Web page it opens \*" error=\{destinationError \|\| undefined\}><Input ref=\{destinationRef\}/);
  assert.match(source, /useEffect\(\(\) => \{ if \(focusDestination\.current && !busy\) \{ focusDestination\.current = false; destinationRef\.current\?\.focus\(\); \} \}, \[busy, destinationError\]\);/);
  const html = renderToStaticMarkup(React.createElement(UI.Field, { label: 'Web page it opens *', error: 'Choose a public HTTPS destination without embedded credentials.' }, React.createElement(UI.Input, { type: 'url' })));
  assert.match(html, /aria-invalid="true"/); assert.match(html, /role="alert"[^>]*>Choose a public HTTPS destination/);
});

test('renames cannot alter a saved destination and disabling a link requires confirmation', async () => {
  const calls = [], accepted = [], context = { readOnly: false, editing: { id: 'link/a', name: 'Updated name' }, path, version: { current: 1 }, requester: { current: async (...args) => { calls.push(args); return { link: { id: 'link/a', archived: true } }; } }, action: async (_, run) => run(1), acceptLink: value => accepted.push(value), setEditing() {}, setNotice() {} };
  await compile(section('async function saveName(', '  async function archive('), context)(event); assert.deepEqual(calls[0], [path + '/link%2Fa', 'PATCH', { name: 'Updated name' }]);
  assert.match(source, /onClick=\{\(\) => setArchiving\(item\)\}>\{item.archived \? 'Restore' : 'Disable'\}/, 'Disable and restore only open the confirmation.');
  assert.match(source, /<ConfirmDialog open=\{!!archiving\}.*?`Disable “\$\{archiving\?\.name\}”\?`.*?'Existing posts and QR codes will stop redirecting.'.*?onConfirm=\{\(\) => archive\(archiving!\)\}/, 'Only the confirmation dialog dispatches the archive request.');
  const archive = compile(section('async function archive(', '  async function saveSettings('), context);
  await archive({ id: 'link/a', archived: false }); assert.deepEqual(calls[1], [path + '/link%2Fa', 'PATCH', { archived: true }]);
  await compile(section('async function archive(', '  async function saveSettings('), { ...context, readOnly: true })({ id: 'link/a' }); assert.equal(calls.length, 2);
});

test('settings restrict domain changes to the operator and late project responses cannot replace settings or reports', async () => {
  const calls = [], settings = [], reports = [], version = { current: 1 }, context = { readOnly: false, canManageSettings: true, canChangeDomain: false, settingsForm: { shortBaseUrl: 'https://go.example.com', allowedWebsiteOrigins: 'https://example.com\nhttps://example.com\nhttps://www.example.com' }, action: async (_, run) => run(1), requester: { current: async (...args) => { calls.push(args); return { settings: { shortBaseUrl: 'https://old.example.com', allowedWebsiteOrigins: ['https://example.com'] } }; } }, path, version, setSettings: value => settings.push(value), setSettingsForm() {}, setNotice() {}, settings: { shortBaseUrl: 'https://old.example.com' }, setOriginsError() {}, originsRef: { current: null }, focusOrigins: { current: false } };
  const save = compile(section('async function saveSettings(', '  async function loadAnalytics('), context); await save(event); assert.deepEqual(calls[0][2], { allowedWebsiteOrigins: ['https://example.com', 'https://www.example.com'] });
  await compile(section('async function saveSettings(', '  async function loadAnalytics('), { ...context, canChangeDomain: true })(event); assert.equal(calls[1][2].shortBaseUrl, 'https://go.example.com');
  version.current = 2; await save(event); assert.equal(settings.length, 2);
  const load = compile(section('async function loadAnalytics(', '  const campaignOptions'), { action: async (_, run) => run(1), days: '30', campaignId: 'campaign/a', requester: { current: async (...args) => { calls.push(args); return { totals: {} }; } }, path, version, setReport: value => reports.push(value) });
  await load(event); assert.equal(reports.length, 0); const query = new URL(calls.at(-1)[0], 'https://app.example').searchParams; assert.equal(query.get('campaignId'), 'campaign/a'); assert.equal(query.get('days'), '30');
});

test('local-address warnings and website snippet escaping use actual production helpers', () => {
  const local = compile(source.match(/const localShortAddress = (.+);/)[1]), snippet = compile(source.match(/const siteSnippet = (.+);/)[1]);
  assert.equal(local('http://localhost:3018'), true); assert.equal(local('http://127.0.0.1:3018/s/code'), true); assert.equal(local('https://go.example.com'), false);
  assert.equal(snippet('https://app.example/t/site.js?one=1&two="2"'), '<script defer src="https://app.example/t/site.js?one=1&amp;two=&quot;2&quot;"></script>');
});

test('link setup discloses configured administration while keeping unconfigured setup and public-address warnings visible', async () => {
  const start = source.indexOf('    {settings && localShortAddress'), end = source.indexOf('    {!readOnly && <Card as="section" headingLevel={2} title="Create a short link"', start);
  assert.ok(start > 0 && end > start);
  const { code } = await transformWithOxc(`function Setup(props) { const { settings, settingsForm, canManageSettings, readOnly, canChangeDomain, busy, saveSettings, setSettingsForm, originsError, originsRef, setOriginsError } = props; return <>${source.slice(start, end)}</>; }`, 'LinkSetup.tsx', { jsx: { runtime: 'classic' } });
  const Setup = new Function('React', 'localShortAddress', 'siteSnippet', ...Object.keys(UI), code + '; return Setup;')(React, compile(source.match(/const localShortAddress = (.+);/)[1]), compile(source.match(/const siteSnippet = (.+);/)[1]), ...Object.values(UI));
  const settings = { shortBaseUrl: 'https://go.example.com', allowedWebsiteOrigins: ['https://example.com'], scriptUrl: 'https://app.example/t/site.js', domainStatus: 'configured_unverified' };
  const props = { settings, settingsForm: { shortBaseUrl: settings.shortBaseUrl, allowedWebsiteOrigins: 'https://example.com' }, canManageSettings: true, readOnly: false, canChangeDomain: true, busy: '', saveSettings() {}, setSettingsForm() {} };
  const render = changes => renderToStaticMarkup(React.createElement(Setup, { ...props, ...changes }));
  const html = render(), disclosure = html.match(/<details[\s\S]*?<\/details>/)?.[0];
  assert.ok(disclosure, 'Setup must remain mounted inside a native disclosure.');
  assert.match(disclosure, /<summary[^>]*>[\s\S]*?Link and website setup[\s\S]*?<\/summary>/); assert.doesNotMatch(disclosure.match(/^<details[^>]*>/)[0], /\bopen=/);
  assert.match(disclosure, /Save link settings/); assert.match(disclosure, /Copy tracking code/); assert.match(disclosure, /value="https:\/\/go\.example\.com"/);
  const outside = html.replace(disclosure, ''); assert.match(outside, /Saving only stores the address/); assert.doesNotMatch(disclosure, /Saving only stores the address/);
  for (const domainStatus of ['app_origin', 'unknown', undefined]) assert.match(render({ settings: { ...settings, domainStatus } }).replace(/<details[\s\S]*?<\/details>/, ''), /Saving only stores the address/);
  for (const value of [null, { ...settings, shortBaseUrl: 'http://localhost:3018' }, { ...settings, allowedWebsiteOrigins: [] }, { scriptUrl: settings.scriptUrl }]) assert.match(render({ settings: value }), /<details[^>]*\bopen=""/, JSON.stringify(value));
  const local = render({ settings: { ...settings, shortBaseUrl: 'http://localhost:3018' } }); assert.match(local.replace(/<details[\s\S]*?<\/details>/, ''), /will work only on this computer/);
  for (const change of [{ readOnly: true }, { canManageSettings: false }]) { const viewer = render(change); assert.doesNotMatch(viewer, /<form|Save link settings/); assert.match(viewer, /Ask your admin to change them/); assert.match(viewer, /Copy tracking code/); }
  assert.match(render({ canChangeDomain: false }), /type="url"[^>]*disabled=""/);
});

// #148: at 320 px the Link column was squeezed to 24 px and wrapped one character per line. It names its row and keeps
// the large named minimum width; the table scrolls instead.
test('the Link column keeps a readable minimum width and names its row', () => {
  assert.match(source, /\{ key: 'link', header: 'Link', rowHeader: true, wrap: true, minWidth: 'lg', render:/);
});
