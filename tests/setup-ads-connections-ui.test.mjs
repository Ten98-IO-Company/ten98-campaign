import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';

const tick = () => new Promise(resolve => setImmediate(resolve));
const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children), ...elements(node.props.actions)] : [];
const button = (tree, text) => elements(tree).find(node => node.type === ui.Button && node.props.children === text);
class FormValues { constructor(values) { return new Map(Object.entries(values)); } }
const event = values => ({ preventDefault() {}, currentTarget: values });
const browser = {};
const isForm = node => node.props.as === 'form', isShoppingAccount = node => node.type?.name === 'ShoppingAccount';
let rendering;

// Execute the real transformed components and effects with controlled requests, following the repository's UI test pattern.
const hooks = {
  useState(initial) {
    const owner = rendering, index = owner.cursor++;
    owner.hooks[index] ||= { value: typeof initial === 'function' ? initial() : initial };
    const entry = owner.hooks[index];
    return [entry.value, next => { entry.value = typeof next === 'function' ? next(entry.value) : next; }];
  },
  useRef(initial) {
    const owner = rendering, index = owner.cursor++;
    owner.hooks[index] ||= { current: initial };
    return owner.hooks[index];
  },
  useEffect(run, dependencies) {
    const owner = rendering, index = owner.cursor++, previous = owner.hooks[index];
    if (!previous || dependencies.some((value, position) => !Object.is(value, previous.dependencies[position]))) {
      owner.hooks[index] = { dependencies, cleanup: previous?.cleanup, run };
      owner.effects.push(index);
    }
  },
};

function view(Component, initialProps) {
  let props = initialProps;
  const owner = { hooks: [], cursor: 0, effects: [] };
  const instance = {
    render(changes = {}) {
      props = { ...props, ...changes }; owner.cursor = 0;
      const previous = rendering; rendering = owner;
      try { return Component(props); } finally { rendering = previous; }
    },
    async update(changes) {
      instance.render(changes);
      for (const index of owner.effects.splice(0)) { const effect = owner.hooks[index]; effect.cleanup?.(); effect.cleanup = effect.run(); }
      await tick();
      return instance.render();
    },
    close() { for (const entry of owner.hooks) entry.cleanup?.(); },
  };
  return instance;
}

const variants = await Promise.all([
  { name: 'NativeGoogleAds', endpoint: 'native-google-ads', status: { configured: true, mapped: true, customerId: '1234567890' } },
  { name: 'MicrosoftAds', endpoint: 'microsoft-ads', status: { configured: true, mapping: { customerId: '42', accountId: '314', name: 'QA Microsoft account', currency: 'AED' }, latestReport: { id: 'saved-report', status: 'Pending' } } },
].map(async variant => {
  const source = await readFile(new URL(`../src/${variant.name}.tsx`, import.meta.url), 'utf8');
  const { code } = await transformWithOxc(source.replace(/^import .*;\r?$/gm, '').replace('export default function', 'function'), `${variant.name}.tsx`, { jsx: { runtime: 'classic' } });
  const Component = new Function('React', ...Object.keys(hooks), ...Object.keys(ui), 'FormData', 'window', `${code}; return ${variant.name};`)(React, ...Object.values(hooks), ...Object.values(ui), FormValues, browser);
  return { ...variant, Component };
}));
const props = request => ({ projectId: 'project / exact', canWrite: true, isOperator: true, canManageProject: true, role: 'owner', request });

test('connection mode mounts and refreshes status only, even with mapped accounts and a saved report', async () => {
  for (const variant of variants) {
    const requests = [], prefix = '/projects/project%20%2F%20exact/' + variant.endpoint;
    const instance = view(variant.Component, { ...props(async path => { requests.push(path); assert.equal(path, prefix + '/status'); return variant.status; }), mode: 'connection' });
    let tree = await instance.update();
    const html = renderToStaticMarkup(tree);
    assert.doesNotMatch(html, /Create paused|Performance export|Shopping and standard Video performance|Check report status|Open integrations/);
    assert.equal(elements(tree).some(isShoppingAccount), false, 'Connection mode must not mount the Google account reader.');
    assert.deepEqual(requests, [prefix + '/status']);
    await button(tree, variant.name === 'NativeGoogleAds' ? 'Refresh Google Shopping' : 'Refresh Microsoft account').props.onClick();
    tree = await instance.update();
    assert.deepEqual(requests, [prefix + '/status', prefix + '/status']);
    assert.doesNotMatch(renderToStaticMarkup(tree), /Request performance export|Load Shopping and Video campaigns/);
    instance.close();
  }
});

test('default workflow hides all mapping editors, opens integrations, and preserves account/campaign/report controls', async () => {
  for (const variant of variants) {
    const requests = []; let opened = 0;
    const request = async path => {
      requests.push(path);
      if (path.endsWith('/status')) return variant.status;
      if (path.endsWith('/campaigns')) return { campaigns: [{ id: 'campaign-a', name: 'Paused exact', status: 'Paused', sharedBudget: false, budgetType: 'DailyBudgetStandard', dailyBudget: 15 }] };
      if (path.endsWith('/account')) return { account: { name: 'QA Google account', currencyCode: 'AED' } };
      throw Error('Unexpected workflow read: ' + path);
    };
    const instance = view(variant.Component, { ...props(request), onOpenIntegrations: () => { opened++; } });
    const tree = await instance.update();
    assert.equal(elements(tree).some(node => node.type === ui.Input && ['customerId', 'accountId'].includes(node.props.name)), false);
    const opening = button(tree, 'Open integrations'); assert.ok(opening); assert.equal(opening.props.type, 'button');
    const reads = requests.length; opening.props.onClick(); assert.equal(opened, 1); assert.equal(requests.length, reads);
    assert.equal(button(instance.render({ onOpenIntegrations: undefined }), 'Open integrations'), undefined);
    if (variant.name === 'NativeGoogleAds') {
      const account = elements(tree).find(isShoppingAccount); assert.ok(account);
      const child = view(account.type, account.props), accountTree = await child.update();
      assert.match(renderToStaticMarkup(accountTree), /Create paused Standard Shopping campaign/);
      assert.match(renderToStaticMarkup(accountTree), /Linked Merchant Center account ID/);
      assert.match(renderToStaticMarkup(accountTree), /Load Shopping and Video campaigns/);
      assert.ok(requests.some(path => path.endsWith('/account'))); child.close();
    } else {
      const html = renderToStaticMarkup(tree);
      assert.match(html, /Create paused Microsoft campaign/); assert.match(html, /Review Microsoft campaign change/);
      assert.match(html, /Request performance export/); assert.match(html, /Check report status/);
      assert.ok(requests.some(path => path.endsWith('/campaigns')));
    }
    instance.close();
  }
});

test('connection editors keep operator/workspace permissions and Microsoft explicit assignment confirmation', async () => {
  for (const variant of variants) for (const access of [{}, { isOperator: false }, { canManageProject: false, role: 'editor' }, { role: 'viewer', canManageProject: false }]) {
    const status = variant.name === 'NativeGoogleAds' ? { configured: true, mapped: false, customerId: '' } : { configured: true, mapping: null };
    const instance = view(variant.Component, { ...props(async () => status), ...access, mode: 'connection' });
    const tree = await instance.update(), form = elements(tree).find(isForm);
    assert.equal(Boolean(form), Object.keys(access).length === 0);
    if (form && variant.name === 'MicrosoftAds') assert.ok(elements(form).some(node => node.type === ui.Checkbox && node.props.required));
    instance.close();
  }
});

test('Google connection mapping uses the existing exact project endpoint and refreshes only status', async () => {
  const variant = variants[0], requests = [];
  let status = { configured: true, mapped: false, customerId: '' };
  const request = async (path, method, body) => {
    requests.push({ path, method, body });
    if (method === 'POST') { assert.deepEqual(body, { customerId: '1234567890' }); status = variant.status; return { mapped: true }; }
    assert.ok(path.endsWith('/status')); return status;
  };
  const instance = view(variant.Component, { ...props(request), mode: 'connection' });
  let tree = await instance.update();
  elements(tree).find(isForm).props.onSubmit(event({ customerId: '1234567890' }));
  await tick(); tree = await instance.update();
  const writes = requests.filter(item => item.method === 'POST');
  assert.deepEqual(writes, [{ path: '/projects/project%20%2F%20exact/native-google-ads/connection', method: 'POST', body: { customerId: '1234567890' } }]);
  assert.equal(requests.length, 3); assert.match(renderToStaticMarkup(tree), /Advertising customer 1234567890/); instance.close();
});

test('Google connection keeps confirmed disconnection available when credentials are absent', async () => {
  const variant = variants[0], writes = [], status = { ...variant.status, configured: false };
  const instance = view(variant.Component, { ...props(async (_path, method, body) => { if (method === 'POST') writes.push(body); return status; }), mode: 'connection' });
  const tree = await instance.update(), nodes = elements(tree);
  assert.equal(nodes.find(node => node.props.as === 'fieldset').props.disabled, false);
  assert.equal(nodes.find(node => node.type === ui.Input && node.props.name === 'customerId').props.disabled, true);
  assert.equal(button(tree, 'Verify and map customer').props.disabled, true);
  const disconnect = button(tree, 'Disconnect customer'); assert.ok(disconnect); assert.notEqual(disconnect.props.disabled, true);
  const dialog = () => elements(instance.render()).find(node => node.type === ui.ConfirmDialog);
  assert.equal(dialog().props.open, false);
  disconnect.props.onClick(); await tick(); assert.deepEqual(writes, [], 'Disconnection waits for confirmation.');
  assert.equal(dialog().props.open, true); assert.match(dialog().props.title, /^Disconnect the native Google advertising customer/);
  dialog().props.onOpenChange(false); assert.equal(dialog().props.open, false); assert.deepEqual(writes, []);
  disconnect.props.onClick(); await dialog().props.onConfirm(); assert.deepEqual(writes, [{ customerId: '' }]); instance.close();
});

test('Microsoft connection assignment posts the original confirmed IDs and never loads campaigns afterward', async () => {
  const variant = variants[1], requests = []; let status = { configured: true, mapping: null };
  const request = async (path, method, body) => {
    requests.push({ path, method, body });
    if (method === 'POST') { status = variant.status; return { mapping: status.mapping }; }
    assert.ok(path.endsWith('/status')); return status;
  };
  const instance = view(variant.Component, { ...props(request), mode: 'connection' });
  let tree = await instance.update();
  await elements(tree).find(isForm).props.onSubmit(event({ customerId: '42', accountId: '314' }));
  tree = await instance.update();
  assert.deepEqual(requests.filter(item => item.method === 'POST'), [{ path: '/projects/project%20%2F%20exact/microsoft-ads/connection', method: 'POST', body: { customerId: '42', accountId: '314', confirmed: true } }]);
  assert.equal(requests.length, 3); assert.match(renderToStaticMarkup(tree), /QA Microsoft account/);
  assert.equal(elements(tree).some(isForm), false, 'An existing Microsoft mapping stays fixed.'); instance.close();
});

test('late connection status reads after unmount cannot dispatch workflow reads or update the closed screen', async () => {
  for (const variant of variants) {
    const requests = []; let finish;
    const instance = view(variant.Component, { ...props(path => { requests.push(path); return new Promise(resolve => { finish = resolve; }); }), mode: 'connection' });
    const before = await instance.update(); instance.close(); finish(variant.status); await tick();
    assert.equal(renderToStaticMarkup(instance.render()), renderToStaticMarkup(before)); assert.equal(requests.length, 1);
  }
});

test('switching Microsoft from workflow to connection invalidates an older status read before campaign dispatch', async () => {
  const variant = variants[1], requests = []; let finish;
  const request = path => {
    requests.push(path); assert.ok(path.endsWith('/status'));
    return requests.length === 1 ? new Promise(resolve => { finish = resolve; }) : Promise.resolve(variant.status);
  };
  const instance = view(variant.Component, props(request));
  await instance.update(); await instance.update({ mode: 'connection' });
  finish(variant.status); await tick();
  assert.equal(requests.length, 2); assert.doesNotMatch(renderToStaticMarkup(instance.render()), /Performance export|Create paused|Check report status/); instance.close();
});
