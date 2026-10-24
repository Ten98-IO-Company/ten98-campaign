// Regression tests for the Links issues found in the v0.21.1 end-to-end user test (#113, #114, #115).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as UI from '@ten98/ui';
import { transformWithOxc } from 'vite';
import { readText } from './read-text.ts';

type Row = Record<string, unknown>;
type Run = (generation: number) => Promise<void>;

const source = await readFile(new URL('../src/CampaignLinks.tsx', import.meta.url), 'utf8');
const section = (start: string, end: string) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
// Evaluates one function from the real component with its hooks and helpers supplied as named values.
const compile = (code: string, context: Record<string, unknown> = {}) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context));
const event = { preventDefault() {} }, path = '/projects/project-a/links';
const draft = { name: 'Duplicate test', destination: 'https://shop.example.com/billboard', campaignId: '', utm_source: '', utm_medium: '', utm_campaign: '', utm_content: '', utm_term: '' };

function createWith(links: Row[], response: Row) {
  const notices: string[] = [], selections: string[] = [], cleared: unknown[] = [], reused: string[] = [];
  let reveals = 0;
  const DestinationError = compile(source.match(/class DestinationError extends Error \{\}/)![0]);
  const create = compile(section('async function create(', '  async function saveName('), { readOnly: false, draft, links, destinationWithUtm: () => draft.destination, DestinationError, setDestinationError() {}, destinationRef: { current: null }, focusDestination: { current: false }, action: async (_label: string, run: Run) => run(1), requester: { current: async () => response }, path, version: { current: 1 }, acceptLink() {}, setSelected: (value: string) => selections.push(value), setDraft: (value: unknown) => cleared.push(value), blank: () => ({}), setNotice: (value: string) => notices.push(value), setReused: (value: string) => reused.push(value), setReusedReveal: (update: (count: number) => number) => { reveals = update(reveals); } });
  return create(event).then(() => ({ notices, selections, cleared: cleared.length, reused, reveals }));
}

async function qrPanel(props: Row) {
  const start = source.indexOf('{chosen && <Card id="campaign-link-qr"'), end = source.indexOf('\n', start);
  assert.ok(start > 0 && end > start);
  const { code } = await transformWithOxc(`function Panel({ chosen, reused, qrPath, setSelected, localShortAddress }) { return <>${source.slice(start, end)}</>; }`, 'LinkQr.tsx', { jsx: { runtime: 'classic' } });
  const Panel = new Function('React', ...Object.keys(UI), code + '; return Panel;')(React, ...Object.values(UI));
  return renderToStaticMarkup(React.createElement(Panel, { qrPath: '/qr.svg', setSelected() {}, localShortAddress: () => false, ...props }));
}

test('#114 a destination that already has an active link says so inside the QR panel it opens, and keeps the form', async () => {
  const existing = { id: 'old-link', name: 'Billboard Downtown QR' };
  for (const links of [[existing], []]) {
    // The server answers with the link it already has, under that link's name, whether or not this list has loaded it.
    const result = await createWith(links, { link: existing });
    assert.deepEqual(result.selections, ['old-link'], 'The existing link is shown.');
    assert.equal(result.cleared, 0, 'Nothing was created, so the form keeps what was typed.');
    assert.deepEqual([result.reused, result.notices], [['old-link'], []], 'The explanation belongs to the QR panel, not the page-top status far above it.');
  }
  const created = await createWith([existing], { link: { id: 'new-link', name: 'Duplicate test' } });
  assert.deepEqual([created.selections, created.cleared, created.reused], [['new-link'], 1, []]); assert.match(created.notices[0], /^Short link created\./);
  // The panel takes focus on open, so its explanation is on screen and describes the focused panel.
  const chosen = { id: 'old-link', name: 'Billboard Downtown QR', code: 'abc', qrUrl: 'https://go.example.com/q/abc', shortUrl: 'https://go.example.com/s/abc' };
  const panel = await qrPanel({ chosen, reused: 'old-link' });
  assert.match(panel, /^<section[^>]*id="campaign-link-qr"[^>]*aria-describedby="campaign-link-reused"/);
  assert.match(panel, /<div(?=[^>]*role="status")(?=[^>]*id="campaign-link-reused")[^>]*>[\s\S]*?already has an active link, “Billboard Downtown QR”\. No new link was created[\s\S]*?QR tracking address/);
  for (const reused of ['', 'other-link']) { const plain = await qrPanel({ chosen, reused }); assert.doesNotMatch(plain, /already has an active link|aria-describedby/); }
  assert.match(source, /useEffect\(\(\) => \{ if \(reused && reused !== selected\) setReused\(''\); \}, \[selected, reused\]\);\n  async function action\(/, 'Opening another link or closing the panel drops the explanation; it is the last hook.');
});

test('#114 a reused-link create moves focus to its explanation, which is the first content in the QR panel', async () => {
  const existing = { id: 'old-link', name: 'Original link' };
  // In the QA case the original link's panel is already open, so `selected` does not change and only this reveal moves focus.
  for (const links of [[existing], []]) assert.equal((await createWith(links, { link: existing })).reveals, 1, 'Each reuse asks for its explanation, even when the same link is reused again.');
  assert.equal((await createWith([existing], { link: { id: 'new-link', name: 'Duplicate test' } })).reveals, 0, 'A new link only opens its panel.');
  const hooks = section("  useEffect(() => { if (selected) document.getElementById('campaign-link-qr')", '  async function action(');
  const reveal = hooks.split('\n').find(line => line.includes('useEffect(') && line.includes('reusedReveal'));
  assert.ok(reveal && hooks.indexOf(reveal) > 0, 'The reveal effect runs after the panel focus effect, so the explanation keeps focus when both run in one commit.');
  const focused: string[] = [];
  compile(`() => { ${reveal} }`, { useEffect: (run: () => void) => run(), reusedReveal: 1, document: { getElementById: (id: string) => ({ focus: () => focused.push(id) }) } })();
  assert.deepEqual(focused, ['campaign-link-reused'], 'Focus, and with it the scroll, goes to the explanation.');
  const chosen = { id: 'old-link', name: 'Original link', code: 'abc', qrUrl: 'https://go.example.com/q/abc', shortUrl: 'https://go.example.com/s/abc' };
  const panel = await qrPanel({ chosen, reused: 'old-link' });
  assert.match(panel, /t98-card-content"><div(?=[^>]*role="status")(?=[^>]*id="campaign-link-reused")(?=[^>]*tabindex="-1")[^>]*>/, 'The explanation is a focusable status, first in the panel body and across its width.');
  const text = readText(panel).trim();
  assert.ok(text.startsWith('QR code · Original link This destination and campaign already has an active link, “Original link”.'), text);
});

function saveWith(allowedWebsiteOrigins: string, response: () => Row, changes: Row = {}) {
  const calls: unknown[] = [], fieldErrors: string[] = [], formErrors: string[] = [], focused: string[] = [], focusOrigins = { current: false };
  const save = compile(section('async function saveSettings(', '  async function loadAnalytics('), { readOnly: false, canManageSettings: true, canChangeDomain: false, settings: { shortBaseUrl: 'https://go.example.com' }, settingsForm: { shortBaseUrl: 'https://go.example.com', allowedWebsiteOrigins }, setOriginsError: (value: string) => { if (value) fieldErrors.push(value); }, originsRef: { current: { focus: () => focused.push('origins') } }, focusOrigins,
    action: async (_label: string, work: Run) => { try { await work(1); } catch (failure) { formErrors.push((failure as Error).message); } }, requester: { current: async (...args: unknown[]) => { calls.push(args); return response(); } }, path, version: { current: 1 }, setSettings() {}, setSettingsForm() {}, setNotice() {}, ...changes });
  return save(event).then(() => ({ calls: calls.length, fieldErrors, formErrors, focused, deferredFocus: focusOrigins.current }));
}

test('#113 a refused website origin shows at the origins field with focus, not as an off-screen page alert', async () => {
  const refused = 'Use a public HTTPS domain without credentials or private addresses.', reject = (message: string, status = 400) => () => { throw Object.assign(new Error(message), { status }); };
  assert.deepEqual(await saveWith('http://127.0.0.1:4101', reject(refused)), { calls: 1, fieldErrors: [refused], formErrors: [], focused: [], deferredFocus: true }, 'Focus moves to the field once the fieldset re-enables.');
  assert.deepEqual(await saveWith('http://127.0.0.1:4101', reject(refused), { canChangeDomain: true }), { calls: 1, fieldErrors: [refused], formErrors: [], focused: [], deferredFocus: true }, 'An unchanged short address cannot be the refused value.');
  const many = Array.from({ length: 11 }, (_, index) => `https://site${index}.example.com`).join('\n');
  assert.deepEqual(await saveWith(many, () => assert.fail('Too many origins are never sent.')), { calls: 0, fieldErrors: ['Add at most 10 website addresses.'], formErrors: [], focused: ['origins'], deferredFocus: false });
  const domain = await saveWith('https://www.example.com', reject(refused), { canChangeDomain: true, settingsForm: { shortBaseUrl: 'https://10.0.0.1', allowedWebsiteOrigins: 'https://www.example.com' } });
  assert.deepEqual([domain.fieldErrors, domain.formErrors], [[], ['Short address or website addresses: ' + refused]], 'With both changed the refused value is ambiguous, so it stays form-level and names both fields.');
  const onlyDomain = await saveWith('https://www.example.com', reject(refused), { canChangeDomain: true, settings: { shortBaseUrl: 'https://go.example.com', allowedWebsiteOrigins: ['https://www.example.com'] }, settingsForm: { shortBaseUrl: 'https://10.0.0.1', allowedWebsiteOrigins: 'https://www.example.com' } });
  assert.deepEqual([onlyDomain.fieldErrors, onlyDomain.formErrors], [[], ['Short address: ' + refused]], 'Saved origins were already accepted, so with only the short address changed the error names it.');
  const role = await saveWith('https://www.example.com', reject('Only workspace administrators can change tracking settings.', 403));
  assert.deepEqual([role.fieldErrors, role.formErrors], [[], ['Only workspace administrators can change tracking settings.']]);
  assert.match(source, /<Field label="Your website addresses \(one per line\)" description="[^"]*https:\/\/www\.example\.com[^"]*Local and http:\/\/ sites can’t send analytics\.[^"]*" error=\{originsError \|\| undefined\}><Textarea ref=\{originsRef\}/);
  assert.match(source, /useEffect\(\(\) => \{ if \(focusOrigins\.current && !busy\) \{ focusOrigins\.current = false; originsRef\.current\?\.focus\(\); \} \}, \[busy, originsError\]\);/);
  const html = renderToStaticMarkup(React.createElement(UI.Field, { label: 'Your website addresses (one per line)', description: 'Hint', error: refused }, React.createElement(UI.Textarea)));
  assert.match(html, /<textarea[^>]*aria-invalid="true"/); assert.match(html, /role="alert"[^>]*>Use a public HTTPS domain/);
});

test('#115 row actions name the link they act on, and so does the disable confirmation', async () => {
  const start = source.indexOf('rowActions={item => ') + 'rowActions={item => '.length, end = source.indexOf('}/> : <EmptyState', start);
  assert.ok(start > 20 && end > start);
  const { code } = await transformWithOxc(`function Actions({ item, busy, readOnly, setSelected, setEditing, setArchiving, renameReturn }) { return ${source.slice(start, end)}; }`, 'LinkActions.tsx', { jsx: { runtime: 'classic' } });
  const Actions = new Function('React', ...Object.keys(UI), code + '; return Actions;')(React, ...Object.values(UI));
  const render = (item: Row) => renderToStaticMarkup(React.createElement(Actions, { item: { id: 'a', name: 'Billboard Downtown QR', shortUrl: 'https://go.example.com/s/abc', ...item }, busy: '', readOnly: false, setSelected() {}, setEditing() {}, setArchiving() {}, renameReturn: { current: null } }));
  const html = render({});
  assert.match(html, /role="group"[^>]*aria-label="Actions for Billboard Downtown QR"/, 'Copy link is announced within a group named for its link.');
  for (const name of ['QR code for Billboard Downtown QR', 'Rename Billboard Downtown QR', 'Disable Billboard Downtown QR']) assert.match(html, new RegExp(`<button[^>]*aria-label="${name}"`), name);
  assert.match(render({ archived: true }), /<button[^>]*aria-label="Restore Billboard Downtown QR"/);
  assert.match(source, /<ConfirmDialog open=\{!!archiving\}[^\n]*title=\{archiving\?\.archived \? `Restore “\$\{archiving\.name\}” and its QR code\?` : `Disable “\$\{archiving\?\.name\}”\?`\}/);
});

test('#115 the rename and QR panels take focus when opened, which scrolls them into view, and rename returns focus to its row', () => {
  assert.match(source, /\{editing && !readOnly && <Card key=\{editing\.id\} as="section"[^\n]*<Input autoFocus required maxLength=\{120\} value=\{editing\.name\}/, 'Each rename remounts the form, so its name field takes focus.');
  assert.match(source, /\{chosen && <Card id="campaign-link-qr" tabIndex=\{-1\} as="section"/);
  assert.match(source, /useEffect\(\(\) => \{ if \(selected\) document\.getElementById\('campaign-link-qr'\)\?\.focus\(\); \}, \[selected\]\);/);
  assert.match(source, /onClick=\{event => \{ renameReturn\.current = event\.currentTarget; setEditing\(\{ id: item\.id, name: item\.name \}\); \}\}/);
  assert.match(source, /useEffect\(\(\) => \{ const trigger = renameReturn\.current; if \(editing \|\| busy \|\| !trigger\) return; renameReturn\.current = null; if \(trigger\.isConnected\) trigger\.focus\(\); \}, \[editing, busy\]\);/, 'Focus returns to the Rename button once the form closes and the row is enabled again.');
});
