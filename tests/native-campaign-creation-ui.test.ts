import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import * as offline from '../shared/offline-activations.ts';
import { adSpendBlock } from '../src/approval-status.ts';

type Row = Record<string, any>;
const tick = () => new Promise(resolve => setImmediate(resolve));
const elements = (node: any): Row[] => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement<Row>(node) ? [node, ...elements(node.props.children), ...elements(node.props.footer), ...elements(node.props.actions)] : [];
const find = (tree: any, type: any, predicate: (props: Row) => boolean = () => true) => elements(tree).find(node => node.type === type && predicate(node.props))!;
class FormValues extends Map<string, string> { constructor(form: { values: Record<string, string> }) { super(Object.entries(form.values)); } }
const form = (values: Row) => ({ values: { ...values }, resets: 0, reset() { this.resets++; this.values = { ...values }; } });
let rendering: any;
const hooks = {
  useState(initial: any) { const owner = rendering, index = owner.cursor++; owner.hooks[index] ||= { value: typeof initial === 'function' ? initial() : initial }; const state = owner.hooks[index]; return [state.value, (next: any) => { state.value = typeof next === 'function' ? next(state.value) : next; }]; },
  useRef(initial: any) { const owner = rendering, index = owner.cursor++; owner.hooks[index] ||= { current: initial }; return owner.hooks[index]; },
  useEffect(run: any, dependencies: any[]) { const owner = rendering, index = owner.cursor++, previous = owner.hooks[index]; if (!previous || dependencies.some((value, position) => !Object.is(value, previous.dependencies[position]))) { owner.hooks[index] = { dependencies, cleanup: previous?.cleanup, run }; owner.effects.push(index); } },
};
function view(Component: any, initial: Row) {
  const owner = { cursor: 0, hooks: [] as any[], effects: [] as number[] }; let props = initial;
  const instance = {
    render(changes: Row = {}) { props = { ...props, ...changes }; owner.cursor = 0; rendering = owner; try { return Component(props); } finally { rendering = undefined; } },
    async update(changes: Row = {}) { let tree = instance.render(changes); for (let round = 0; round < 8; round++) { for (const index of owner.effects.splice(0)) { const effect = owner.hooks[index]; effect.cleanup?.(); effect.cleanup = effect.run(); } await tick(); tree = instance.render(); if (!owner.effects.length) return tree; } throw Error('Component effects did not settle.'); },
    close() { for (const hook of owner.hooks) hook.cleanup?.(); },
  };
  return instance;
}
async function component(name: string, additions: Row = {}) {
  const source = await readFile(new URL(`../src/${name}.tsx`, import.meta.url), 'utf8');
  const { code } = await transformWithOxc(source.replace(/^import .*;\r?$/gm, '').replace(/^export (default )?/gm, ''), name + '.tsx', { jsx: { runtime: 'classic' } });
  const scope = { React, ...hooks, ...ui, ...offline, FormData: FormValues, adSpendBlock, AdSpendNotice: () => null, ...additions };
  return new Function(...Object.keys(scope), code + `; return ${name};`)(...Object.values(scope));
}
const projectId = 'project / exact';
const nativeVariants = [
  { name: 'NativeGoogleAds', destination: 'google-shopping', summary: 'Create paused Standard Shopping campaign', status: { configured: true, mapped: true, customerId: '1234567890' } },
  { name: 'MicrosoftAds', destination: 'microsoft-search', summary: 'Create paused Microsoft search campaign', status: { configured: true, mapping: { accountId: '314', currency: 'AED' } } },
];
async function native(variant: typeof nativeVariants[number], extra: Row = {}, write: (body: Row) => Promise<Row> = async () => ({}), status: Row | Error = variant.status) {
  const requests: Row[] = [], request = async (path: string, method?: string, body?: Row) => { requests.push({ path, method, body }); if (method === 'POST') return write(body!); if (path.endsWith('/status')) { if (status instanceof Error) throw status; return status; } if (path.endsWith('/campaigns')) return { campaigns: [] }; if (path.endsWith('/account')) return { account: { name: 'Exact account', currencyCode: 'AED' } }; throw Error('Unexpected read: ' + path); };
  const parent = view(await component(variant.name), { projectId, canWrite: true, role: 'owner', isOperator: true, canManageProject: true, request, ...extra });
  const tree = await parent.update(), child = elements(tree).find(node => node.type?.name === 'ShoppingAccount');
  const instance = child ? view(child.type, child.props) : parent;
  if (child) await instance.update();
  return { instance, requests, close() { if (child) instance.close(); parent.close(); } };
}
const creationDisclosure = (tree: any, variant: typeof nativeVariants[number]) => find(tree, ui.Disclosure, props => props.summary === variant.summary);
const creationForm = (tree: any, variant: typeof nativeVariants[number]) => elements(creationDisclosure(tree, variant)).find(node => node.props.as === 'form')!;

test('native ad creation callbacks launch the common flow, while exact project/type intents open only once without writes', async () => {
  for (const variant of nativeVariants) {
    let launched = 0, handled = 0;
    const host = await native(variant, { onCreateCampaign: () => launched++, onCreateHandled: () => handled++ });
    let tree = host.instance.render();
    creationDisclosure(tree, variant).props.onOpenChange(true); tree = await host.instance.update();
    assert.equal(launched, 1); assert.equal(creationDisclosure(tree, variant).props.open, false);
    const intent = { id: 1, projectId, destination: variant.destination };
    for (const rejected of [{ ...intent, projectId: 'other' }, { ...intent, destination: 'activation' }]) { tree = await host.instance.update({ createIntent: rejected }); assert.equal(handled, 0); assert.equal(creationDisclosure(tree, variant).props.open, false); }
    tree = await host.instance.update({ createIntent: intent }); assert.equal(handled, 1); assert.equal(creationDisclosure(tree, variant).props.open, true);
    creationDisclosure(tree, variant).props.onOpenChange(false); await host.instance.update();
    tree = await host.instance.update({ createIntent: { ...intent } }); assert.equal(handled, 1); assert.equal(creationDisclosure(tree, variant).props.open, false, 'A repeated intent must not reopen a closed editor.');
    tree = await host.instance.update({ createIntent: { ...intent, id: 2 } }); assert.equal(handled, 2); assert.equal(creationDisclosure(tree, variant).props.open, true);
    assert.equal(host.requests.filter(item => item.method === 'POST').length, 0); host.close();
    let denied = 0;
    const viewer = await native(variant, { canWrite: false, role: 'viewer', createIntent: intent, onCreateHandled: () => denied++ });
    assert.equal(find(viewer.instance.render(), ui.Disclosure, props => props.summary === variant.summary), undefined); assert.equal(denied, 0); viewer.close();
  }
});

test('unavailable native connections leave setup reachable without consuming or dispatching creation', async () => {
  for (const variant of nativeVariants) for (const status of [{ configured: false, mapped: false, mapping: null }, new Error('Access refused')]) {
    let handled = 0, connections = 0;
    const host = await native(variant, { createIntent: { id: 1, projectId, destination: variant.destination }, onCreateHandled: () => handled++, onOpenIntegrations: () => connections++ }, async () => ({}), status);
    const tree = host.instance.render();
    assert.equal(find(tree, ui.Disclosure, props => props.summary === variant.summary), undefined);
    find(tree, ui.Button, props => props.children === 'Open Connections').props.onClick(); assert.equal(connections, 1);
    assert.equal(handled, 0); assert.equal(host.requests.filter(item => item.method === 'POST').length, 0); host.close();
  }
});

test('native ad guards track real form changes, reversions and discard without touching provider receipts', async () => {
  for (const variant of nativeVariants) {
    let guard: Row | null = null;
    const host = await native(variant, { onGuardChange: (next: Row | null) => { guard = next; } });
    const tree = host.instance.render(), node = creationForm(tree, variant), draft = form({ name: '', confirmed: '' });
    node.props.ref(draft); await host.instance.update(); assert.equal(guard!.dirty, false);
    draft.values.name = 'Unsaved exact'; node.props.onInput(); await host.instance.update(); assert.equal(guard!.dirty, true); assert.match(guard!.revision, /Unsaved exact/);
    draft.values.name = ''; node.props.onChange(); await host.instance.update(); assert.equal(guard!.dirty, false, 'Restoring the baseline is clean.');
    draft.values.confirmed = 'on'; node.props.onChange(); await host.instance.update(); assert.equal(guard!.dirty, true, 'Confirmation choices are part of the draft.');
    guard!.discard(); await host.instance.update(); assert.equal(draft.resets, 1); assert.equal(guard!.dirty, false); assert.equal(host.requests.filter(item => item.method === 'POST').length, 0);
    host.close(); assert.equal(guard, null, 'Unmount releases the shell guard.');
  }
});

test('native provider creation reports busy, clears only the submitted draft and preserves newer edits', async () => {
  for (const variant of nativeVariants) for (const newerEdit of [false, true]) {
    let guard: Row | null = null, resolveWrite!: (value: Row) => void;
    const writing = new Promise<Row>(resolve => { resolveWrite = resolve; });
    const host = await native(variant, { onGuardChange: (next: Row | null) => { guard = next; } }, () => writing);
    const node = creationForm(host.instance.render(), variant), draft = form({ name: '', merchantId: '123', feedLabel: 'AE', priority: '0', dailyBudget: '20', maxCpc: '1', countries: 'AE', euPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING', finalUrl: 'https://example.test', headlines: 'One\nTwo\nThree', descriptions: 'First\nSecond', keywords: 'planner', matchType: 'Exact', locationIds: '1' });
    node.props.ref(draft); await host.instance.update(); draft.values.name = 'Submitted'; node.props.onInput(); await host.instance.update();
    const saving = node.props.onSubmit({ preventDefault() {}, currentTarget: draft, nativeEvent: { submitter: { getAttribute: () => 'create' } } });
    await host.instance.update(); assert.equal(guard!.busy, true);
    if (newerEdit) { draft.values.name = 'Newer unsaved'; node.props.onInput(); await host.instance.update(); }
    resolveWrite({ campaign: { platformCampaignId: 'google-campaign' }, providerCampaign: { id: 'microsoft-campaign' } }); await saving; await host.instance.update();
    assert.equal(guard!.busy, false); assert.equal(guard!.dirty, newerEdit); assert.equal(draft.resets, newerEdit ? 0 : 1);
    assert.equal(draft.values.name, newerEdit ? 'Newer unsaved' : ''); assert.equal(host.requests.filter(item => item.method === 'POST').length, 1); host.close();
  }
});

test('field creation preserves campaign/date presets, consumes intents once and protects Cancel and page navigation', async () => {
  let guard: Row | null = null, handled = 0, launched = 0, confirm = false, confirmations = 0;
  const requests: Row[] = [], campaign = { id: 'plan', name: 'Launch', startDate: '2099-10-25', endDate: '2099-10-27' };
  const Component = await component('OfflineActivations', { useConfirmDialog: () => [async () => { confirmations++; return confirm; }, null] });
  const instance = view(Component, { projectId, brand: 'Brand', campaigns: [campaign], activations: [], request: async (path: string, method?: string) => { requests.push({ path, method }); return {}; }, onChanged() {}, onCreateCampaign: () => launched++, onCreateHandled: () => handled++, onGuardChange: (next: Row | null) => { guard = next; } });
  let tree = await instance.update(); find(tree, ui.Button, props => props.children === 'New activation').props.onClick(); await instance.update(); assert.equal(launched, 1); assert.equal(find(instance.render(), ui.Dialog).props.open, false);
  const intent = { id: 1, projectId, destination: 'activation', campaignId: campaign.id };
  tree = await instance.update({ createIntent: { ...intent, projectId: 'other' } }); assert.equal(handled, 0);
  tree = await instance.update({ createIntent: intent }); assert.equal(handled, 1); let dialog = find(tree, ui.Dialog);
  assert.equal(dialog.props.open, true); assert.equal(find(dialog, ui.Select, props => props.placeholder === 'Choose a campaign').props.value, campaign.id);
  assert.equal(find(dialog, ui.DateTimeField, props => props.label === 'Starts').props.value, '2099-10-25T09:00');
  find(dialog, ui.Input, props => props.maxLength === 120).props.onChange({ target: { value: 'Unsaved stop' } }); tree = await instance.update(); assert.equal(guard!.dirty, true);
  dialog = find(tree, ui.Dialog); find(dialog, ui.Button, props => props.children === 'Cancel').props.onClick(); await tick(); tree = await instance.update(); assert.equal(confirmations, 1); assert.equal(find(tree, ui.Dialog).props.open, true);
  confirm = true; find(find(tree, ui.Dialog), ui.Button, props => props.children === 'Cancel').props.onClick(); await tick(); tree = await instance.update(); assert.equal(find(tree, ui.Dialog).props.open, false); assert.equal(guard!.dirty, false);
  tree = await instance.update({ createIntent: { ...intent } }); assert.equal(find(tree, ui.Dialog).props.open, false); assert.equal(handled, 1);
  tree = await instance.update({ createIntent: { ...intent, id: 2, campaignId: undefined } }); dialog = find(tree, ui.Dialog);
  const campaignSelect = find(dialog, ui.Select, props => props.placeholder === 'Choose a campaign'); assert.equal(campaignSelect.props.value, ''); assert.equal(campaignSelect.props.required, true, 'An activity still requires choosing a plan.');
  find(dialog, ui.Input, props => props.maxLength === 120).props.onChange({ target: { value: 'Another stop' } }); await instance.update(); guard!.discard(); tree = await instance.update(); assert.equal(find(tree, ui.Dialog).props.open, false);
  assert.equal(requests.filter(item => item.method).length, 0); instance.close(); assert.equal(guard, null);
});

test('field guards stay busy until saving settles and a failed save retains its draft', async () => {
  for (const failed of [false, true]) {
    let guard: Row | null = null, resolveWrite!: () => void, rejectWrite!: (error: Error) => void;
    const writing = new Promise<void>((resolve, reject) => { resolveWrite = resolve; rejectWrite = reject; });
    const Component = await component('OfflineActivations', { useConfirmDialog: () => [async () => true, null] });
    const instance = view(Component, { projectId, brand: 'Brand', campaigns: [{ id: 'plan', name: 'Launch', startDate: '2099-10-25', endDate: '2099-10-27' }], activations: [], request: async (_path: string, method?: string) => { if (method === 'POST') return writing; return {}; }, onChanged() {}, createIntent: { id: 1, projectId, destination: 'activation', campaignId: 'plan' }, onGuardChange: (next: Row | null) => { guard = next; } });
    let tree = await instance.update(), dialog = find(tree, ui.Dialog);
    find(dialog, ui.Input, props => props.maxLength === 120).props.onChange({ target: { value: 'New stop' } }); tree = await instance.update(); dialog = find(tree, ui.Dialog);
    const saving = dialog.props.onSubmit(); await instance.update(); assert.equal(guard!.busy, true);
    if (failed) rejectWrite(new Error('Not saved')); else resolveWrite();
    await saving; tree = await instance.update(); assert.equal(guard!.busy, false); assert.equal(guard!.dirty, failed); assert.equal(find(tree, ui.Dialog).props.open, failed);
    instance.close();
  }
});
