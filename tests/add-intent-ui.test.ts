// ten98-campaign#216: the campaign page's Add menu hands the target page a one-time intent (createFor / createNew).
// Each receiving component is compiled with recorded hooks so its mount effects really run; no request leaves the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import * as shared from '../shared/offline-activations.ts';
import { hooks, nodes } from './hook-recorder.ts';

type Row = Record<string, any>;
const strip = (text: string) => text.replace(/^import .+;\r?\n/gm, '').replace(/^export (default )?/gm, '');
const compile = async (file: string) => (await transformWithOxc(strip(await readFile(new URL('../src/' + file, import.meta.url), 'utf8')), file, { jsx: { runtime: 'classic' } })).code;
// The recorded hooks are not React's, so the library's useFocusReturn (React hooks inside) is replaced by a no-op.
const library: Record<string, unknown> = { ...ui, useFocusReturn: () => () => {} };
const campaigns = [{ id: 'c1', name: 'Autumn launch', currency: 'AED' }, { id: 'c2', name: 'Spring sampling', currency: 'AED', startDate: '2026-10-26', endDate: '2026-11-30' }];
const request = () => new Promise(() => {});

const offlineCode = await compile('OfflineActivations.tsx'), offlineLibrary = { ...shared, ...library };
function mountOffline(props: Row) {
  const h = hooks(), { OfflineActivations } = new Function('React', 'useEffect', 'useRef', 'useState', ...Object.keys(offlineLibrary), offlineCode + '; return { OfflineActivations };')(React, h.useEffect, h.useRef, h.useState, ...Object.values(offlineLibrary));
  const all = { projectId: 'p1', brand: 'Brand', campaigns, activations: [], request, onChanged() {}, ...props };
  h.render(OfflineActivations, all); h.flush();
  return nodes(h.render(OfflineActivations, all));
}
test('Field activity opens a new activation in the campaign it was asked for, once', () => {
  let handled = 0;
  const tree = mountOffline({ createFor: 'c2', onCreateHandled: () => handled++ });
  const dialog = tree.find(node => node.type === ui.Dialog);
  assert.equal(dialog.props.open, true, 'The new activation editor is open.');
  assert.ok(nodes(dialog.props.children).some(node => node.type === ui.Select && node.props.value === 'c2'), 'Its campaign is the one from the campaign page.');
  assert.ok(tree.some(node => node.type === ui.Select && node.props.value === 'c2' && node !== nodes(dialog.props.children).find(item => item.type === ui.Select && item.props.value === 'c2')), 'The list is filtered to that campaign.');
  assert.equal(handled, 1);
  for (const props of [{ readOnly: true }, { createFor: 'missing' }]) {
    let calls = 0; const view = mountOffline({ createFor: 'c2', ...props, onCreateHandled: () => calls++ });
    assert.equal(view.find(node => node.type === ui.Dialog).props.open, false, JSON.stringify(props) + ' opens nothing');
    assert.equal(calls, 1, 'The app still clears the intent.');
  }
  let none = 0; mountOffline({ onCreateHandled: () => none++ }); assert.equal(none, 0, 'Without an intent nothing happens.');
});
const fieldTime = (tree: any[], label: string) => nodes(tree.find(node => node.type === ui.Dialog).props.children).find(node => node.type === ui.DateTimeField && node.props.label === label)?.props.value;
test('a new activation from a campaign starts with the campaign’s dates', () => {
  const dated = mountOffline({ createFor: 'c2' });
  assert.equal(fieldTime(dated, 'Starts'), '2026-10-26T09:00', 'Starts on the campaign’s first day.');
  assert.equal(fieldTime(dated, 'Ends'), '2026-11-30T17:00', 'Ends on the campaign’s last day.');
  const undated = mountOffline({ createFor: 'c1' });
  assert.equal(fieldTime(undated, 'Starts'), '', 'A campaign without dates leaves them for the user.'); assert.equal(fieldTime(undated, 'Ends'), '');
});

const linksCode = await compile('CampaignLinks.tsx');
function mountLinks(props: Row) {
  const h = hooks(), { CampaignLinks } = new Function('React', 'useEffect', 'useRef', 'useState', ...Object.keys(library), linksCode + '; return { CampaignLinks };')(React, h.useEffect, h.useRef, h.useState, ...Object.values(library));
  const all = { projectId: 'p1', request, campaigns, ...props }, focused: string[] = [];
  const first = nodes(h.render(CampaignLinks, all));
  // Stand in for the DOM input the destination ref points at.
  const destination = first.find(node => node.type === ui.Input && node.props.ref && node.props.type === 'url');
  if (destination) destination.props.ref.current = { focus: () => focused.push('destination') };
  h.flush();
  return { tree: nodes(h.render(CampaignLinks, all)), focused };
}
test('Link or QR code sets the new link’s campaign and focuses its destination, once', () => {
  let handled = 0;
  const { tree, focused } = mountLinks({ createFor: 'c1', onCreateHandled: () => handled++ });
  const campaignField = tree.find(node => node.type === ui.Field && node.props.label === 'Campaign (optional)');
  assert.equal(nodes(campaignField.props.children).find(node => node.type === ui.Select).props.value, 'c1');
  assert.deepEqual(focused, ['destination']); assert.equal(handled, 1);
  for (const props of [{ readOnly: true }, { createFor: 'missing' }]) {
    let calls = 0; const view = mountLinks({ createFor: 'c1', ...props, onCreateHandled: () => calls++ });
    const field = view.tree.find(node => node.type === ui.Field && node.props.label === 'Campaign (optional)');
    if (field) assert.equal(nodes(field.props.children).find(node => node.type === ui.Select).props.value, '', JSON.stringify(props) + ' leaves the link uncategorised');
    assert.deepEqual(view.focused, []); assert.equal(calls, 1);
  }
});

const templateCode = await compile('WhatsAppTemplate.tsx'), directCode = await compile('DirectCampaigns.tsx');
const template = new Function('React', ...Object.keys(library), templateCode + '; return { WhatsAppTemplate, templateRestriction, templatePreviewText, templateMissing };')(React, ...Object.values(library));
function mountDirect(props: Row) {
  const h = hooks(), { DirectCampaigns } = new Function('React', 'useEffect', 'useRef', 'useState', 'WhatsAppTemplate', 'templateRestriction', 'templatePreviewText', 'templateMissing', 'useRevealPanel', ...Object.keys(library), directCode + '; return { DirectCampaigns };')(
    React, h.useEffect, h.useRef, h.useState, template.WhatsAppTemplate, template.templateRestriction, template.templatePreviewText, template.templateMissing, () => {}, ...Object.values(library));
  const all = { projectId: 'p1', request, ...props };
  h.render(DirectCampaigns, all); h.flush();
  return nodes(h.render(DirectCampaigns, all));
}
const campaignSelect = (tree: any[]) => { const field = tree.find(node => node.type === ui.Field && node.props.label === 'Campaign (optional)'); return field && nodes(field.props.children).find(node => node.type === ui.Select); };
test('Email or SMS opens a new message draft linked to the campaign it was asked for, once', () => {
  let handled = 0; const saved: Row[] = [];
  const recording = (path: string, method?: string, body?: Row) => { if (method === 'POST' && path.endsWith('/direct/campaigns')) saved.push(body!); return request(); };
  const tree = mountDirect({ createFor: 'c2', plannerCampaigns: campaigns, request: recording, onCreateHandled: () => handled++ });
  assert.ok(tree.some(node => node.type === ui.Heading && node.props.children === 'New Email campaign'), 'A new draft is open, not the list.');
  assert.equal(campaignSelect(tree)?.props.value, 'c2', 'The draft is linked to the campaign from the campaign page.');
  assert.equal(handled, 1);
  tree.find(node => node.type === ui.Form).props.onSubmit(undefined, { preventDefault() {} });
  assert.equal(saved[0]?.campaignId, 'c2', 'Saving the draft keeps the link.');
  for (const props of [{ readOnly: true }, { createFor: 'missing' }]) {
    let calls = 0; const view = mountDirect({ createFor: 'c2', plannerCampaigns: campaigns, ...props, onCreateHandled: () => calls++ });
    assert.equal(campaignSelect(view), undefined, JSON.stringify(props) + ' opens no draft'); assert.equal(calls, 1, 'The app still clears the intent.');
  }
  let none = 0; assert.equal(campaignSelect(mountDirect({ plannerCampaigns: campaigns, onCreateHandled: () => none++ })), undefined); assert.equal(none, 0);
});

test('an intent the target page did not use is dropped when the page changes', async () => {
  const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const line = main.match(/  useEffect\(\(\) => \{ if \(addIntent && addIntent\.page !== navigation\.page\) setAddIntent\(null\); \}, \[navigation\.page\]\);/)?.[0];
  assert.ok(line, 'main.tsx clears a stale intent on page change.');
  const run = (addIntent: Row | null, page: string) => { const cleared: unknown[] = []; new Function('useEffect', 'addIntent', 'navigation', 'setAddIntent', line + ';')((effect: () => void) => effect(), addIntent, { page }, (value: unknown) => cleared.push(value)); return cleared; };
  assert.deepEqual(run({ page: 'Field activity', campaignId: 'c1' }, 'Calendar'), [null]);
  assert.deepEqual(run({ page: 'Field activity', campaignId: 'c1' }, 'Field activity'), [], 'Arriving at the target page keeps it for the component.');
  assert.deepEqual(run(null, 'Calendar'), []);
});
