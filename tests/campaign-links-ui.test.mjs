import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';

const source = await readFile(new URL('../src/CampaignLinks.tsx', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const compile = (code, context = {}) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context));
const destinationWithUtm = compile(section('function destinationWithUtm(', 'const localShortAddress'));
const event = { preventDefault() {} }, path = '/projects/project-a/links';
const draft = { name: 'Launch', destination: 'https://example.com/offer?product=one&utm_source=old#details', campaignId: 'campaign-a', utm_source: ' instagram ', utm_medium: 'social', utm_campaign: '', utm_content: '', utm_term: '' };

test('actual link creation preserves destination parameters, applies optional UTM values and never submits an unsafe protocol', async () => {
  const url = new URL(destinationWithUtm(draft)); assert.equal(url.searchParams.get('product'), 'one'); assert.equal(url.searchParams.get('utm_source'), 'instagram'); assert.equal(url.hash, '#details');
  for (const destination of ['javascript:alert(1)', 'http://example.com/offer', 'https://user:secret@example.com/offer']) assert.throws(() => destinationWithUtm({ ...draft, destination }), /public HTTPS/);
  const calls = [], saved = [], selections = [], cleared = [];
  const create = compile(section('async function create(', '  async function saveName('), { readOnly: false, draft, destinationWithUtm, action: async (_, run) => run(1), requester: { current: async (...args) => { calls.push(args); return { link: { id: 'new-link' } }; } }, path, version: { current: 1 }, acceptLink: value => saved.push(value), setSelected: value => selections.push(value), setDraft: value => cleared.push(value), blank: () => ({}), setNotice() {} });
  await create(event); assert.deepEqual(calls[0], [path, 'POST', { name: 'Launch', destination: url.href, campaignId: 'campaign-a' }]); assert.deepEqual(saved, [{ id: 'new-link' }]); assert.deepEqual(selections, ['new-link']); assert.equal(cleared.length, 1);
});

test('renames cannot alter a saved destination and disabling a link requires confirmation', async () => {
  const calls = [], accepted = [], context = { readOnly: false, editing: { id: 'link/a', name: 'Updated name' }, path, version: { current: 1 }, requester: { current: async (...args) => { calls.push(args); return { link: { id: 'link/a', archived: true } }; } }, action: async (_, run) => run(1), acceptLink: value => accepted.push(value), setEditing() {}, setNotice() {} };
  await compile(section('async function saveName(', '  async function archive('), context)(event); assert.deepEqual(calls[0], [path + '/link%2Fa', 'PATCH', { name: 'Updated name' }]);
  let confirmed = false; const archive = compile(section('async function archive(', '  async function saveSettings('), { ...context, window: { confirm: () => confirmed } });
  await archive({ id: 'link/a', archived: false }); assert.equal(calls.length, 1); confirmed = true; await archive({ id: 'link/a', archived: false }); assert.deepEqual(calls[1], [path + '/link%2Fa', 'PATCH', { archived: true }]);
  await compile(section('async function archive(', '  async function saveSettings('), { ...context, readOnly: true, window: { confirm: () => true } })({ id: 'link/a' }); assert.equal(calls.length, 2);
});

test('settings restrict domain changes to the operator and late project responses cannot replace settings or reports', async () => {
  const calls = [], settings = [], reports = [], version = { current: 1 }, context = { readOnly: false, canManageSettings: true, canChangeDomain: false, settingsForm: { shortBaseUrl: 'https://go.example.com', allowedWebsiteOrigins: 'https://example.com\nhttps://example.com\nhttps://www.example.com' }, action: async (_, run) => run(1), requester: { current: async (...args) => { calls.push(args); return { settings: { shortBaseUrl: 'https://old.example.com', allowedWebsiteOrigins: ['https://example.com'] } }; } }, path, version, setSettings: value => settings.push(value), setSettingsForm() {}, setNotice() {} };
  const save = compile(section('async function saveSettings(', '  async function loadAnalytics('), context); await save(event); assert.deepEqual(calls[0][2], { allowedWebsiteOrigins: ['https://example.com', 'https://www.example.com'] });
  await compile(section('async function saveSettings(', '  async function loadAnalytics('), { ...context, canChangeDomain: true })(event); assert.equal(calls[1][2].shortBaseUrl, 'https://go.example.com');
  version.current = 2; await save(event); assert.equal(settings.length, 2);
  const load = compile(section('async function loadAnalytics(', '  async function copy('), { action: async (_, run) => run(1), days: '30', campaignId: 'campaign/a', requester: { current: async (...args) => { calls.push(args); return { totals: {} }; } }, path, version, setReport: value => reports.push(value) });
  await load(event); assert.equal(reports.length, 0); const query = new URL(calls.at(-1)[0], 'https://app.example').searchParams; assert.equal(query.get('campaignId'), 'campaign/a'); assert.equal(query.get('days'), '30');
});

test('local-address warnings and website snippet escaping use actual production helpers', () => {
  const local = compile(source.match(/const localShortAddress = (.+);/)[1]), snippet = compile(source.match(/const siteSnippet = (.+);/)[1]);
  assert.equal(local('http://localhost:3018'), true); assert.equal(local('http://127.0.0.1:3018/s/code'), true); assert.equal(local('https://go.example.com'), false);
  assert.equal(snippet('https://app.example/t/site.js?one=1&two="2"'), '<script defer src="https://app.example/t/site.js?one=1&amp;two=&quot;2&quot;"></script>');
});

test('link setup discloses configured administration while keeping unconfigured setup and public-address warnings visible', async () => {
  const start = source.indexOf('    {settings && localShortAddress'), end = source.indexOf('    {!readOnly && <section className="panel links-create"', start);
  assert.ok(start > 0 && end > start);
  const { code } = await transformWithOxc(`function Setup(props) { const { settings, settingsForm, canManageSettings, readOnly, canChangeDomain, busy, saveSettings, setSettingsForm, copy } = props; return <>${source.slice(start, end)}</>; }`, 'LinkSetup.tsx', { jsx: { runtime: 'classic' } });
  const Setup = new Function('React', 'localShortAddress', 'siteSnippet', code + '; return Setup;')(React, compile(source.match(/const localShortAddress = (.+);/)[1]), compile(source.match(/const siteSnippet = (.+);/)[1]));
  const settings = { shortBaseUrl: 'https://go.example.com', allowedWebsiteOrigins: ['https://example.com'], scriptUrl: 'https://app.example/t/site.js', domainStatus: 'configured_unverified' };
  const props = { settings, settingsForm: { shortBaseUrl: settings.shortBaseUrl, allowedWebsiteOrigins: 'https://example.com' }, canManageSettings: true, readOnly: false, canChangeDomain: true, busy: '', saveSettings() {}, setSettingsForm() {}, copy() {} };
  const render = changes => renderToStaticMarkup(React.createElement(Setup, { ...props, ...changes }));
  const html = render(), disclosure = html.match(/<details[\s\S]*?<\/details>/)?.[0];
  assert.ok(disclosure, 'Setup must remain mounted inside a native disclosure.');
  assert.match(disclosure, /<summary>Link and website setup<\/summary>/); assert.doesNotMatch(disclosure.match(/^<details[^>]*>/)[0], /\bopen=/);
  assert.match(disclosure, /Save link settings/); assert.match(disclosure, /Copy snippet/); assert.match(disclosure, /value="https:\/\/go\.example\.com"/);
  const outside = html.replace(disclosure, ''); assert.match(outside, /does not verify DNS or the certificate/); assert.doesNotMatch(disclosure, /does not verify DNS or the certificate/);
  for (const domainStatus of ['app_origin', 'unknown', undefined]) assert.match(render({ settings: { ...settings, domainStatus } }).replace(/<details[\s\S]*?<\/details>/, ''), /does not verify DNS or the certificate/);
  for (const value of [null, { ...settings, shortBaseUrl: 'http://localhost:3018' }, { ...settings, allowedWebsiteOrigins: [] }, { scriptUrl: settings.scriptUrl }]) assert.match(render({ settings: value }), /<details[^>]*\bopen=""/, JSON.stringify(value));
  const local = render({ settings: { ...settings, shortBaseUrl: 'http://localhost:3018' } }); assert.match(local.replace(/<details[\s\S]*?<\/details>/, ''), /will work only on this computer/);
  for (const change of [{ readOnly: true }, { canManageSettings: false }]) { const viewer = render(change); assert.doesNotMatch(viewer, /<form|Save link settings/); assert.match(viewer, /Project administrators manage this setup/); assert.match(viewer, /Copy snippet/); }
  assert.match(render({ canChangeDomain: false }), /type="url"[^>]*disabled=""/);
});
