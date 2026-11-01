import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import { hooks, nodes } from './hook-recorder.ts';

type Row = Record<string, any>;
const strip = (source: string) => source.replace(/^import .+;\r?\n/gm, '').replace(/^export (default )?/gm, '');
const compile = async (file: string) => (await transformWithOxc(strip(await readFile(new URL('../src/' + file, import.meta.url), 'utf8')), file, { jsx: { runtime: 'classic' } })).code;
const library: Record<string, unknown> = { ...ui, useFocusReturn: () => () => {} };
const templateCode = await compile('WhatsAppTemplate.tsx'), directCode = await compile('DirectCampaigns.tsx');
const template = new Function('React', ...Object.keys(library), templateCode + '; return { WhatsAppTemplate, templateRestriction, templatePreviewText, templateMissing };')(React, ...Object.values(library));
const tick = () => new Promise(resolve => setImmediate(resolve));
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : React.isValidElement(node) ? text((node.props as Row).children) : node == null || node === false ? '' : String(node);

async function fixture(overrides: Row = {}) {
  const h = hooks(), calls: Row[] = [], guards: Row[] = [];
  const { DirectCampaigns } = new Function('React', 'useEffect', 'useRef', 'useState', 'WhatsAppTemplate', 'templateRestriction', 'templatePreviewText', 'templateMissing', 'useRevealPanel', ...Object.keys(library), directCode + '; return { DirectCampaigns };')(
    React, h.useEffect, h.useRef, h.useState, template.WhatsAppTemplate, template.templateRestriction, template.templatePreviewText, template.templateMissing, () => {}, ...Object.values(library));
  const props: Row = { projectId: 'p1', onGuardChange: (guard: Row) => guards.push(guard), request: async (path: string, method?: string, body?: Row) => {
    calls.push({ path, method, body });
    if (path.endsWith('/status')) return { providers: { email: true, sms: true, whatsapp: true }, emailProvider: 'ses', marketingAvailable: true, publicCallbacks: true, accounts: [] };
    if (path.endsWith('/contacts')) return { contacts: [] };
    if (!method && path.endsWith('/campaigns')) return { campaigns: [] };
    if (method === 'POST' && path.endsWith('/campaigns')) return { campaign: { ...body, id: 'm1', status: 'draft' } };
    throw new Error('Unexpected request ' + method + ' ' + path);
  }, ...overrides };
  const settle = async () => { for (let round = 0; round < 5; round++) { h.render(DirectCampaigns, props); h.flush(); await tick(); } return nodes(h.render(DirectCampaigns, props)); };
  const guard = () => guards.at(-1)!;
  return { props, calls, guards, settle, guard };
}

const intent = (destination: string, changes: Row = {}) => ({ id: 1, projectId: 'p1', destination, ...changes });
const heading = (tree: Row[]) => tree.find(node => node.type === ui.Heading && node.props.level === 2);

test('New campaign delegates to the shared launcher and removes the local channel chooser', async () => {
  let opened = 0;
  const f = await fixture({ onCreateCampaign: () => { opened++; } }), tree = await f.settle();
  tree.find(node => node.type === ui.Button && text(node.props.children) === 'New campaign').props.onClick();
  assert.equal(opened, 1);
  assert.equal(tree.some(node => node.type === ui.Popover && node.props.label === 'Choose a channel'), false);
  assert.equal(f.calls.some(call => call.method), false);
});

test('typed creation opens each selected direct channel once, scoped to its project and parent plan', async () => {
  for (const channel of ['email', 'sms', 'whatsapp']) {
    let handled = 0;
    const f = await fixture({ createIntent: intent(channel, { campaignId: 'plan1' }), plannerCampaigns: [{ id: 'plan1' }], onCreateHandled: () => { handled++; } });
    let tree = await f.settle();
    assert.match(text(heading(tree)), new RegExp(channel === 'sms' ? 'SMS' : channel === 'email' ? 'Email' : 'WhatsApp'));
    assert.ok(tree.some(node => node.type === ui.Select && node.props.value === 'plan1'));
    assert.equal(handled, 1); assert.equal(f.guard().dirty, false);
    const name = tree.find(node => node.type === ui.Input && node.props.maxLength === 120);
    name.props.onChange({ target: { value: 'Keep this draft' } });
    f.props.createIntent = { ...f.props.createIntent };
    tree = await f.settle();
    assert.ok(tree.some(node => node.type === ui.Input && node.props.value === 'Keep this draft'));
    assert.equal(handled, 1, 'A repeated intent does not overwrite edits.');
    assert.equal(f.calls.some(call => call.method), false, 'Opening the editor performs no writes.');
  }
  for (const changes of [{ projectId: 'other' }, { destination: 'post' }, { campaignId: 'foreign' }]) {
    const f = await fixture({ createIntent: intent('sms', changes), plannerCampaigns: [{ id: 'plan1' }] });
    assert.equal(heading(await f.settle()), undefined);
  }
  const viewer = await fixture({ readOnly: true, createIntent: intent('email') });
  assert.equal(heading(await viewer.settle()), undefined);
});

test('direct draft guard tracks edits, saves and explicit discard without sending', async () => {
  const f = await fixture({ createIntent: intent('email') });
  let tree = await f.settle(); assert.equal(f.guard().dirty, false);
  tree.find(node => node.type === ui.Input && node.props.maxLength === 200).props.onChange({ target: { value: 'Receipt' } });
  tree = await f.settle();
  tree.find(node => node.type === ui.Textarea && node.props.maxLength === 100000).props.onChange({ target: { value: 'Thank you' } });
  tree = await f.settle(); const editedRevision = f.guard().revision;
  assert.equal(f.guard().dirty, true);
  tree.find(node => node.type === ui.Button && text(node.props.children) === 'All campaigns').props.onClick();
  tree = await f.settle();
  const prompt = tree.find(node => node.type === ui.ConfirmDialog && node.props.title === 'Discard unsaved campaign changes?');
  assert.equal(prompt.props.open, true);
  prompt.props.onOpenChange(false); tree = await f.settle();
  assert.match(text(heading(tree)), /New Email campaign/);
  await tree.find(node => node.type === ui.Form && node.props.ref).props.onSubmit({}, { preventDefault() {} });
  tree = await f.settle();
  assert.equal(f.guard().dirty, false, 'A completed draft save becomes the clean baseline.');
  assert.notEqual(f.guard().revision, editedRevision, 'The saved ID changes the editor revision.');
  tree.find(node => node.type === ui.Input && node.props.maxLength === 120).props.onChange({ target: { value: 'Changed after saving' } });
  tree = await f.settle(); assert.equal(f.guard().dirty, true);
  tree.find(node => node.type === ui.Button && text(node.props.children) === 'Duplicate as draft').props.onClick();
  tree = await f.settle();
  const duplicatePrompt = tree.find(node => node.type === ui.ConfirmDialog && node.props.title === 'Discard unsaved campaign changes?');
  assert.equal(duplicatePrompt.props.open, true, 'Duplicating also protects changes to the open draft.');
  duplicatePrompt.props.onOpenChange(false); await f.settle();
  f.guard().discard(); tree = await f.settle();
  assert.equal(heading(tree), undefined); assert.equal(f.guard().dirty, false);
  assert.deepEqual(f.calls.filter(call => call.method).map(call => call.path), ['/projects/p1/direct/campaigns']);
});

test('a pending save blocks discard and does not mark newer edits as saved', async () => {
  let resolveSave: (value: Row) => void = () => {};
  const f = await fixture({ createIntent: intent('sms') });
  const original = f.props.request;
  f.props.request = (path: string, method?: string, body?: Row) => method === 'POST' ? new Promise(resolve => { resolveSave = resolve; }) : original(path, method, body);
  let tree = await f.settle();
  tree.find(node => node.type === ui.Textarea && node.props.maxLength === 1500).props.onChange({ target: { value: 'First draft' } }); tree = await f.settle();
  const saving = tree.find(node => node.type === ui.Form && node.props.ref).props.onSubmit({}, { preventDefault() {} });
  tree = await f.settle(); assert.equal(f.guard().busy, true);
  f.guard().discard(); tree = await f.settle(); assert.ok(heading(tree));
  tree.find(node => node.type === ui.Textarea && node.props.maxLength === 1500).props.onChange({ target: { value: 'Newer edit' } }); await f.settle();
  resolveSave({ campaign: { id: 'm1', status: 'draft', channel: 'sms', name: 'First draft', text: 'First draft' } }); await saving;
  tree = await f.settle();
  assert.equal(f.guard().busy, false); assert.equal(f.guard().dirty, true);
  assert.ok(tree.some(node => node.type === ui.Textarea && node.props.value === 'Newer edit'));
});
