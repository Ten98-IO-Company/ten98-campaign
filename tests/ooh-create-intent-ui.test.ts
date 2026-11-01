import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import { hooks } from './hook-recorder.ts';
import type { CampaignEditorGuard } from '../src/campaign-creation.ts';

type Row = Record<string, any>;
const source = await readFile(new URL('../src/OohProviders.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .+;\r?\n/gm, '').replace('export default function', 'function'), 'OohProviders.tsx', { jsx: { runtime: 'classic' } });
const library: Row = { ...ui, useConfirmDialog: () => [async () => false, null] };
const status = { configured: true, environment: 'sandbox', connection: { clientName: 'Media partner', screenIds: [101] } };
const inventory = [{ id: 101, name: 'Airport screen', latitude: null, longitude: null }];
const intent = { id: 1, projectId: 'p1', destination: 'broadsign' };
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve!: (value?: any) => void; const promise = new Promise<any>(yes => { resolve = yes; }); return { promise, resolve }; };
const nodes = (node: any): any[] => Array.isArray(node) ? node.flatMap(nodes) : !React.isValidElement<Row>(node) ? [] : [node, ...nodes(node.props.children), ...nodes(node.props.actions), ...(node.props.items || []).flatMap((item: Row) => nodes(item.content))];

function mount(extra: Row = {}) {
  const h = hooks(), calls: Row[] = [];
  const boundLibrary = { ...library, useConfirmDialog: () => [extra.confirm || (async () => false), null] };
  const Component = new Function('React', 'useEffect', 'useRef', 'useState', 'adSpendBlock', 'AdSpendNotice', ...Object.keys(library), code + '; return OohProviders;')(
    React, h.useEffect, h.useRef, h.useState, () => null, () => null, ...Object.values(boundLibrary));
  const props: Row = { projectId: 'p1', role: 'editor', isOperator: false, bookings: React.createElement(ui.Text, null, 'Saved bookings'),
    request: async (path: string, method?: string, body?: unknown) => {
      calls.push({ path, method, body });
      if (path.endsWith('/status')) return status;
      if (path.endsWith('/inventory')) return { inventory };
      if (path.endsWith('/bookings')) return { bookings: [] };
      throw new Error('Unexpected request: ' + path);
    }, ...extra };
  const paint = () => { const tree = h.render(Component, props); h.flush(); return nodes(tree); };
  paint();
  return { props, calls, paint, async ready() { await tick(); paint(); return paint(); } };
}
const tabs = (tree: any[]) => tree.find(node => node.type === ui.Tabs);

test('the Broadsign creation intent waits for its connection, opens Inventory once, and never writes', async () => {
  const connection = deferred(), calls: string[] = []; let handled = 0;
  const view = mount({ createIntent: intent, onCreateHandled: () => handled++, request: async (path: string, method?: string) => {
    assert.equal(method, undefined, 'Selecting a creation destination performs reads only.'); calls.push(path);
    if (path.endsWith('/status')) return connection.promise;
    return path.endsWith('/inventory') ? { inventory } : { bookings: [] };
  } });
  assert.equal(tabs(view.paint()), undefined); assert.equal(handled, 0);
  connection.resolve(status);
  assert.equal(tabs(await view.ready()).props.value, 'inventory'); assert.equal(handled, 1);
  tabs(view.paint()).props.onValueChange('bookings');
  assert.equal(tabs(view.paint()).props.value, 'bookings', 'The consumed intent cannot reopen Inventory.');
  assert.equal(handled, 1); assert.equal(calls.length, 3);
});

test('foreign, unrelated, connection-mode and viewer intents cannot open a proposal editor', async () => {
  for (const extra of [{ createIntent: { ...intent, projectId: 'other' } }, { createIntent: { ...intent, destination: 'email' } }, { mode: 'connection' }, { role: 'viewer' }]) {
    const view = mount({ createIntent: intent, ...extra });
    const tree = await view.ready();
    assert.notEqual(tabs(tree)?.props.value, 'inventory', JSON.stringify(extra));
    assert.equal(view.calls.some(call => call.method), false);
  }
});

test('an editor without a Broadsign connection receives setup guidance and the intent is consumed', async () => {
  let handled = 0, opened = 0;
  const view = mount({ createIntent: intent, onCreateHandled: () => handled++, onOpenIntegrations: () => opened++, request: async (path: string) => path.endsWith('/status') ? { configured: true, connection: null } : path.endsWith('/inventory') ? { inventory: [] } : { bookings: [] } });
  const tree = await view.ready();
  assert.equal(tabs(tree), undefined); assert.equal(handled, 1);
  assert.ok(tree.some(node => node.type === ui.Text && /Ask an administrator/.test(String(node.props.children))));
  tree.find(node => node.type === ui.Button && node.props.children === 'Open Connections').props.onClick();
  assert.equal(opened, 1); assert.equal(handled, 1);
});

test('unsaved proposal fields and screen selection publish a guard; discard resets them and pending work cannot be discarded', async () => {
  let guard: CampaignEditorGuard | null = null, resets = 0;
  const sync = deferred();
  const view = mount({ onGuardChange: (next: CampaignEditorGuard | null) => { guard = next; }, request: async (path: string, method?: string) => {
    if (method) return sync.promise;
    if (path.endsWith('/status')) return status;
    return path.endsWith('/inventory') ? { inventory } : { bookings: [] };
  } });
  let tree = await view.ready(); assert.equal(guard!.dirty, false);
  const proposal = tree.find(node => node.type === ui.Stack && node.props.as === 'form' && node.props.ref);
  proposal.props.ref.current = { reset: () => resets++ };
  proposal.props.onChangeCapture(); tree = view.paint(); assert.equal(guard!.dirty, true);
  const revision = guard!.revision;
  tree.find(node => node.type === ui.DataTable).props.onSelectionChange(['101']); tree = view.paint();
  assert.notEqual(guard!.revision, revision); assert.deepEqual(tree.find(node => node.type === ui.DataTable).props.selectedKeys, ['101']);
  const pending = tree.find(node => node.type === ui.Button && node.props.children === 'Update partner screens').props.onClick();
  view.paint(); assert.equal(guard!.busy, true);
  guard!.discard(); view.paint(); assert.equal(resets, 0); assert.equal(guard!.dirty, true);
  sync.resolve({ inventory }); await pending; view.paint(); assert.equal(guard!.busy, false);
  guard!.discard(); tree = view.paint(); assert.equal(guard!.dirty, false); assert.equal(resets, 1);
  assert.deepEqual(tree.find(node => node.type === ui.DataTable).props.selectedKeys, []);
});

test('switching away from an unsaved provider proposal keeps editing or explicitly discards fields and screens', async () => {
  const decisions = [false, true], confirmations: Row[] = []; let resets = 0;
  const view = mount({ createIntent: intent, confirm: async (options: Row) => { confirmations.push(options); return decisions.shift(); } });
  let tree = await view.ready();
  const proposal = tree.find(node => node.type === ui.Stack && node.props.as === 'form' && node.props.ref);
  proposal.props.ref.current = { reset: () => resets++ };
  proposal.props.onChangeCapture(); tree.find(node => node.type === ui.DataTable).props.onSelectionChange(['101']); tree = view.paint();
  await tabs(tree).props.onValueChange('bookings'); tree = view.paint();
  assert.equal(tabs(tree).props.value, 'inventory'); assert.equal(resets, 0);
  assert.deepEqual(tree.find(node => node.type === ui.DataTable).props.selectedKeys, ['101']);
  await tabs(tree).props.onValueChange('bookings'); tree = view.paint();
  assert.equal(tabs(tree).props.value, 'bookings'); assert.equal(resets, 1);
  assert.deepEqual(tree.find(node => node.type === ui.DataTable).props.selectedKeys, []);
  assert.deepEqual(confirmations.map(options => [options.confirmLabel, options.cancelLabel]), [['Discard changes', 'Keep editing'], ['Discard changes', 'Keep editing']]);
  assert.equal(view.calls.some(call => call.method), false, 'Discarding a local proposal form sends no provider request.');
});

test('a stale discard response cannot close a changed or pending provider proposal', async () => {
  for (const transition of ['changed', 'pending']) {
    const confirmation = deferred(), sync = deferred(); let resets = 0;
    const view = mount({ createIntent: intent, confirm: () => confirmation.promise, request: async (path: string, method?: string) => {
      if (method) return sync.promise;
      if (path.endsWith('/status')) return status;
      return path.endsWith('/inventory') ? { inventory } : { bookings: [] };
    } });
    let tree = await view.ready();
    const proposal = tree.find(node => node.type === ui.Stack && node.props.as === 'form' && node.props.ref);
    proposal.props.ref.current = { reset: () => resets++ }; proposal.props.onChangeCapture(); tree = view.paint();
    const switching = tabs(tree).props.onValueChange('bookings');
    let work;
    if (transition === 'changed') proposal.props.onChangeCapture();
    else work = tree.find(node => node.type === ui.Button && node.props.children === 'Update partner screens').props.onClick();
    confirmation.resolve(true); await switching; tree = view.paint();
    assert.equal(tabs(tree).props.value, 'inventory', transition); assert.equal(resets, 0);
    if (work) { sync.resolve({ inventory }); await work; }
  }
});
