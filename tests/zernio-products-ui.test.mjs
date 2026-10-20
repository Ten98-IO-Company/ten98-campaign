import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { Alert } from '@ten98/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppField as Field } from '@ten98/ui/app';
import { transformWithOxc } from 'vite';

const source = await readFile(new URL('../src/ZernioProducts.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .+;\r?\n/gm, '').replaceAll('export type ', 'type ').replace('export default function ', 'function ').replaceAll('export function ', 'function '), 'ProductsInteraction.tsx', { jsx: { runtime: 'classic' } });
const accounts = ['shop/a', 'shop/b'].map(id => ({ id, platform: 'shopify', name: id, isActive: true, needsReconnection: false }));
const coverage = { imagesLimit: 20, variantsLimit: 100 };
const store = (id = accounts[0].id) => ({ accountId: id, platform: 'shopify', name: 'Shop', domain: 'shop.example', url: 'https://shop.example', currency: 'USD', country: null, capabilities: ['products.read'], missingCapabilities: [], grantPermissionsUrl: null });
const product = (id = 'product/a', accountId = accounts[0].id) => ({ id, accountId, platform: 'shopify', title: 'Provider product', descriptionHtml: '<img src="https://never.example/a" onerror="bad()"><script>bad()</script>', handle: null, vendor: 'Provider vendor', productType: null, tags: ['<tag>'], status: 'active', platformStatus: 'ACTIVE', featuredImage: { id: null, url: 'https://never.example/featured', altText: '<featured>' }, images: [{ id: null, url: 'javascript:bad()', altText: null }], options: [{ name: 'Size', values: ['S'] }], variants: [{ id: 'variant/a', title: 'Small', sku: null, barcode: null, price: { amount: '12345678901234567890.00100', currency: 'USD' }, compareAtPrice: { amount: '00030.0000', currency: 'AED' }, inventoryQuantity: 0, availableForSale: false, options: [{ name: 'Size', value: 'S' }] }], totalInventory: 0, url: 'javascript:bad()', seo: { title: null, description: '<seo>' }, createdAt: null, updatedAt: null, publishedAt: null, platformData: { secret: 'SHOULD_NOT_RENDER' } });
const page = (rows = [product()], nextCursor = null) => ({ products: rows, nextCursor, coverage });
const detail = (row = product()) => ({ product: row, coverage });
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

test('every product recovery caller checks receipts only while retaining its exact reviewed action', async () => {
  for (const [name, make, prepare, read] of [
    ['collection', collectionEditor, reviewCollectionTitle, collectionEdit], ['content', editor, reviewUpdate, editDetail],
    ['create', creator, reviewCreation, creationReview], ['price', priceEditor, reviewPrice, priceDetail],
    ['deactivate', stateReview, reviewState, stateDetail], ['archive', archiveReview, reviewArchive, stateDetail],
    ['activate', activationReview, reviewActivation, () => stateDetail(draftStateProduct())],
    ['delete', deletionReview, reviewDeletion, () => stateDetail(archivedStateProduct())],
  ]) {
    const ui = await make(async (_path, body) => { if (!body) return read(); throw new Error('Original request acknowledgement missing'); });
    await prepare(ui); await ui.submit(); await ui.tick(); await ui.submit(); await ui.tick();
    const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 2, name);
    assert.equal(writes[0][3], false, name); assert.equal(writes[1][3], true, name);
    assert.equal(writes[1][0], writes[0][0], name); assert.deepEqual(writes[1][1], writes[0][1], name);
    assert.match(ui.html(), /outcome is unknown/, name);
  }
});

async function browser(respond, connected = accounts, options = {}) {
  const { kind = 'ZernioProducts', ...initialProps } = options;
  const hooks = [], queued = [], calls = []; let activeHooks = hooks, children = new Map(), seen = new Set(), cursor = 0, dirty = true, tree, props = initialProps;
  const state = initial => { const frame = activeHooks, index = cursor++; if (!frame[index]) frame[index] = { value: typeof initial === 'function' ? initial() : initial }; return [frame[index].value, value => { const next = typeof value === 'function' ? value(frame[index].value) : value; if (!Object.is(next, frame[index].value)) { frame[index].value = next; dirty = true; } }]; };
  const ref = initial => { const index = cursor++; return activeHooks[index] ||= { current: initial }; };
  const memo = (make, dependencies) => { const frame = activeHooks, index = cursor++, old = frame[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) frame[index] = { value: make(), dependencies }; return frame[index].value; };
  const effect = (run, dependencies) => { const frame = activeHooks, index = cursor++, old = frame[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) { frame[index] = { dependencies, close: old?.close }; queued.push(() => { frame[index].close?.(); frame[index].close = run(); }); } };
  const request = async (...args) => { calls.push(args); if (args[0] === 'products/accounts') return { accounts: connected }; return respond(...args); };
  let renderingRequest = request;
  const runtimeReact = { ...React, createElement: (type, attributes, ...content) => {
    if (type.name !== 'CollectionsBrowser') return React.createElement(type, attributes, ...content);
    const key = attributes.key; seen.add(key); if (!children.has(key)) children.set(key, []);
    const parentHooks = activeHooks, parentCursor = cursor; activeHooks = children.get(key); cursor = 0; const result = type(attributes); activeHooks = parentHooks; cursor = parentCursor; return result;
  } };
  const Component = new Function('React', 'Field', 'Alert', 'useState', 'useRef', 'useEffect', 'useLayoutEffect', 'useMemo', code + `;return ${kind};`)(runtimeReact, Field, Alert, state, ref, effect, effect, memo);
  function paint() { for (let pass = 0; dirty; pass++) { assert.ok(pass < 20, 'Rendering settles.'); dirty = false; cursor = 0; activeHooks = hooks; seen = new Set(); tree = Component({ ...props, request: renderingRequest }); for (const [key, frame] of children) if (!seen.has(key)) { frame.forEach(hook => hook.close?.()); children.delete(key); } while (queued.length) queued.shift()(); } }
  const tick = async () => { await new Promise(resolve => setImmediate(resolve)); paint(); };
  const html = () => renderToStaticMarkup(tree);
  const find = predicate => nodes(tree).find(predicate), button = text => find(node => node.type === 'button' && React.Children.toArray(node.props.children).join('') === text);
  function field(label) { const shared = find(node => node.type === Field && node.props.label === label), native = find(node => node.type === 'label' && nodes(node).some(child => child.type === 'span' && child.props.children === label)); return shared ? nodes(Field(shared.props)).find(node => ['input', 'textarea'].includes(node.type)) : nodes(native).find(node => ['select', 'input', 'textarea'].includes(node.type)); }
  async function change(label, value) { const input = field(label); assert.ok(input, label); input.props.onChange({ target: { value } }); await tick(); }
  const click = text => { const control = button(text); assert.ok(control, text); assert.equal(!!control.props.disabled, false, text); const pending = control.props.onClick(); paint(); return pending; };
  const submit = () => { const pending = find(node => node.type === 'form').props.onSubmit({ preventDefault() {} }); paint(); return pending; };
  paint(); await tick();
  return { calls, tick, html, change, click, submit, field, button, find,
    confirm: (checked = true) => { const input = find(node => node.type === 'input' && node.props.type === 'checkbox'); assert.ok(input); input.props.onChange({ target: { checked } }); paint(); },
    setProps: changes => { props = { ...props, ...changes }; dirty = true; paint(); },
    renewRequest: () => { renderingRequest = (...args) => request(...args); dirty = true; paint(); },
    discardProps: changes => { const oldProps = props, oldTree = tree, oldHooks = hooks.slice(), oldQueued = queued.slice(), oldChildren = new Map([...children].map(([key, frame]) => [key, frame.slice()])); props = { ...props, ...changes }; cursor = 0; activeHooks = hooks; Component({ ...props, request }); props = oldProps; tree = oldTree; hooks.splice(0, hooks.length, ...oldHooks); children = oldChildren; queued.splice(0, queued.length, ...oldQueued); },
    unmount: () => [...hooks, ...[...children.values()].flat()].forEach(hook => hook.close?.()) };
}

test('actual browser preserves platform filters, paginates opaque cursors, reads details and renders provider content inert', async () => {
  const paths = [], responses = [page([product()], 'opaque+/=&?'), page(), detail()];
  const ui = await browser(async path => { paths.push(path); return path.endsWith('/store') ? { store: store() } : responses.shift(); });
  await ui.change('Shopify account', accounts[0].id); const initial = ui.calls.length;
  const query = '  title:"Blue & red" OR vendor:Acme  '; await ui.change('Platform product query', query); await ui.change('Product status', 'pending_review'); assert.equal(ui.calls.length, initial, 'Typing does not fetch.');
  ui.submit(); await ui.tick();
  let params = new URL(paths[1], 'https://app.example').searchParams; assert.equal(params.get('query'), query); assert.equal(params.get('status'), 'pending_review'); assert.equal(params.get('limit'), '20'); assert.match(ui.html(), /Page 1/);
  await ui.click('Next page'); await ui.tick(); params = new URL(paths[3], 'https://app.example').searchParams; assert.equal(params.get('cursor'), 'opaque+/=&?'); assert.equal(params.get('query'), query); assert.match(ui.html(), /Page 2/);
  await ui.click('Read Provider product'); await ui.tick(); assert.equal(paths.at(-1), 'products/shop%2Fa/product%2Fa');
  const html = ui.html(); assert.match(html, /12345678901234567890\.00100 USD/); assert.match(html, /00030\.0000 AED/); assert.match(html, /&lt;script&gt;bad\(\)&lt;\/script&gt;/); assert.match(html, /javascript:bad\(\)/); assert.match(html, /first 20 images/); assert.match(html, /first 100 variants/); assert.match(html, /partial list/); assert.match(html, /<td>0<\/td><td>No<\/td>/);
  assert.doesNotMatch(html, /<img|<script|<iframe|<a\s|SHOULD_NOT_RENDER|Create product|Edit product|Delete product|Publish product/); assert.ok(ui.calls.every(args => args.length === 1), 'Every request is a read without a mutation body.');
});

test('A to B to A and filter changes invalidate pending reads before fresh renders', async () => {
  const reads = [], ui = await browser(async path => path.endsWith('/store') ? { store: store(decodeURIComponent(path.split('/')[1])) } : (reads.push(deferred()), reads.at(-1).promise));
  await ui.change('Shopify account', accounts[0].id); ui.submit(); await ui.tick(); assert.equal(reads.length, 1);
  await ui.change('Shopify account', accounts[1].id); await ui.change('Shopify account', accounts[0].id); reads[0].resolve(page([product('stale-a')])); await ui.tick(); assert.doesNotMatch(ui.html(), /Provider vendor|No products were returned|Page 1|Next page/);
  ui.submit(); await ui.tick(); await ui.change('Platform product query', 'new query'); reads[1].reject(new Error('STALE_ERROR')); await ui.tick(); assert.doesNotMatch(ui.html(), /STALE_ERROR|No products were returned/);
  ui.submit(); await ui.tick(); reads[2].resolve(page([product('fresh-a')])); await ui.tick(); assert.match(ui.html(), /Provider vendor/);
  await ui.change('Product status', 'draft'); assert.doesNotMatch(ui.html(), /Provider vendor|No products were returned|Next page|Page 1/); ui.submit(); await ui.tick(); ui.unmount(); reads[3].resolve(page([product('unmounted')])); await ui.tick(); assert.doesNotMatch(ui.html(), /Provider vendor/);
});

test('fresh permission, rate limit and provider failures leave unknown results without a false empty page', async () => {
  let mode = 'allowed', productReads = 0;
  const ui = await browser(async path => {
    if (path.endsWith('/store')) return { store: { ...store(), ...(mode === 'denied' ? { capabilities: [], missingCapabilities: ['products.read'], grantPermissionsUrl: 'https://never.example/grant' } : {}) } };
    productReads++; if (mode === 'limited') throw Object.assign(new Error('Provider response'), { status: 429 }); if (mode === 'failed') throw new Error('Provider unavailable'); return page([product()], 'next');
  });
  await ui.change('Shopify account', accounts[0].id); ui.submit(); await ui.tick(); assert.match(ui.html(), /Provider vendor|Next page/);
  mode = 'denied'; ui.submit(); assert.doesNotMatch(ui.html(), /Provider vendor|Next page|No products were returned/); await ui.tick(); assert.equal(productReads, 1); assert.match(ui.html(), /Product read permission is missing/); assert.match(ui.html(), /https:\/\/never.example\/grant/); assert.doesNotMatch(ui.html(), /<a\s/);
  for (const [value, message] of [['limited', /rate limited/], ['failed', /Provider unavailable/]]) { mode = value; ui.submit(); await ui.tick(); assert.match(ui.html(), message); assert.doesNotMatch(ui.html(), /No products were returned|Next page|Provider vendor/); }
});

test('malformed pages, repeated cursors and mismatched details are rejected by actual handlers', async () => {
  let response = page([product()], 'repeat'); const ui = await browser(async path => path.endsWith('/store') ? { store: store() } : response);
  await ui.change('Shopify account', accounts[0].id); ui.submit(); await ui.tick(); await ui.click('Next page'); await ui.tick(); assert.match(ui.html(), /next page could not be verified/); assert.doesNotMatch(ui.html(), /Provider vendor|No products were returned|Next page/);
  for (const invalid of [page([product('bad', 'other')]), page([product(), product()]), page(Array.from({ length: 21 }, (_, index) => product(String(index)))), { ...page(), nextCursor: {} }, { ...page(), coverage: { imagesLimit: 21, variantsLimit: 100 } }]) { response = invalid; ui.submit(); await ui.tick(); assert.match(ui.html(), /could not be verified/); assert.doesNotMatch(ui.html(), /Provider vendor|No products were returned/); }
  response = page(); ui.submit(); await ui.tick(); response = detail(product('different')); await ui.click('Read Provider product'); await ui.tick(); assert.match(ui.html(), /selected product could not be verified/); assert.doesNotMatch(ui.html(), /Raw description HTML|Provider vendor|No products were returned/);
});

test('invalid filters are rejected before any store read and empty pages are shown only after a verified read', async () => {
  const ui = await browser(async path => path.endsWith('/store') ? { store: store() } : page([])); await ui.change('Shopify account', accounts[0].id);
  await ui.change('Platform product query', 'x'.repeat(501)); ui.submit(); await ui.tick(); assert.equal(ui.calls.length, 1); assert.match(ui.html(), /at most 500/); assert.doesNotMatch(ui.html(), /No products were returned/);
  await ui.change('Platform product query', ''); await ui.change('Product status', 'published'); ui.submit(); await ui.tick(); assert.equal(ui.calls.length, 1); assert.match(ui.html(), /listed product status/);
  await ui.change('Product status', ''); ui.submit(); await ui.tick(); assert.match(ui.html(), /No products were returned for this page and these filters/); await ui.change('Platform product query', 'new'); assert.doesNotMatch(ui.html(), /No products were returned/);
});

test('late detail and store results cannot restore content after account or filter changes', async () => {
  let pending = null, holdStore = false; const ui = await browser(async path => {
    if (path.endsWith('/store')) return holdStore ? pending.promise : { store: store() };
    return path.includes('?') ? page() : pending.promise;
  });
  await ui.change('Shopify account', accounts[0].id); ui.submit(); await ui.tick(); pending = deferred(); const read = ui.click('Read Provider product'); await ui.tick(); await ui.change('Product status', 'archived'); pending.resolve(detail()); await read; await ui.tick(); assert.doesNotMatch(ui.html(), /Raw description HTML|Provider vendor|No products were returned/);
  pending = deferred(); holdStore = true; ui.submit(); await ui.tick(); await ui.change('Shopify account', accounts[1].id); pending.resolve({ store: store() }); await ui.tick(); assert.doesNotMatch(ui.html(), /shop.example|Raw description HTML|No products were returned/);
});

test('only verified Shopify accounts can be selected and inactive connections cannot read', async () => {
  const invalid = await browser(async () => assert.fail('Unexpected provider read'), [{ ...accounts[0], platform: 'wordpress' }]); assert.match(invalid.html(), /Shopify accounts could not be verified/); assert.doesNotMatch(invalid.html(), /No Shopify account is connected|shop\/a/);
  const inactive = await browser(async () => assert.fail('Unexpected provider read'), [{ ...accounts[0], isActive: false }]); await inactive.change('Shopify account', accounts[0].id); inactive.submit(); await inactive.tick(); assert.equal(inactive.calls.length, 1); assert.match(inactive.html(), /Reconnect this Shopify account/); assert.match(inactive.html(), /disabled="">Load first page/);
  const empty = await browser(async () => assert.fail('Unexpected provider read'), []); assert.match(empty.html(), /No Shopify account is connected/);
});

test('store permission guidance does not conceal changed project access', async () => {
  let permission = true;
  const ui = await browser(async () => { throw Object.assign(new Error(permission ? 'Store grant unavailable' : 'Your project access changed. Refresh before continuing.'), { status: 403, code: permission ? 'PRODUCT_READ_PERMISSION_REQUIRED' : 'PROJECT_ACCESS_CHANGED' }); });
  await ui.change('Shopify account', accounts[0].id); ui.submit(); await ui.tick(); assert.match(ui.html(), /Check your store connection and permissions/);
  permission = false; ui.submit(); await ui.tick(); assert.match(ui.html(), /Your project access changed/); assert.doesNotMatch(ui.html(), /Check your store connection and permissions/);
});

const collectionStore = () => ({ ...store(), capabilities: ['collections.read'], missingCapabilities: ['products.read'] });
const collection = (id = 'gid://shopify/Collection/7001') => ({ id, accountId: accounts[0].id, platform: 'shopify', title: 'Returned collection', handle: null, descriptionHtml: '<img src="https://never.example/collection"><script>collection()</script>', image: { id: null, url: 'javascript:collection()', altText: '<collection image>' }, sortOrder: null, productCount: 0, seo: { title: null, description: '<collection seo>' }, updatedAt: null });
const collectionPage = (rows = [collection()], nextCursor = null) => ({ accountId: accounts[0].id, store: collectionStore(), collections: rows, nextCursor });
const collectionDetail = (row = collection()) => ({ accountId: accounts[0].id, store: collectionStore(), collection: row });
const collectionBrowser = (respond = async () => collectionPage(), props = {}) => browser(respond, accounts, { kind: 'CollectionsBrowser', account: accounts[0], ...props });

const collectionWriteStore = () => ({ ...collectionStore(), capabilities: ['collections.read', 'collections.write'] });
const collectionEdit = (row = collection(), version = 'collection-version') => ({ accountId: accounts[0].id, store: collectionWriteStore(), collection: row, version });
const collectionReceipt = () => ({ ...collectionEdit({ ...collection(), title: 'Renamed collection' }, 'renamed-version'), readback: true, operation: { id: 'collection-rename-operation', status: 'complete' } });
const collectionEditor = (respond = async (_path, body) => body ? collectionReceipt() : collectionEdit(), props = {}) => browser(respond, accounts, { kind: 'CollectionTitleEditor', account: accounts[0], store: collectionWriteStore(), collection: collection(), ...props });
async function reviewCollectionTitle(ui) { await ui.change('Collection title', '  Renamed collection  '); await ui.click('Review collection title'); await ui.tick(); ui.confirm(); }

test('collection rename entry needs a current detail, explicit read/write grants and a committed callback', async () => {
  for (const mode of ['allowed', 'no-callback', 'no-write', 'missing-read', 'missing-write']) {
    const chosenStore = collectionWriteStore(); if (mode === 'no-write') chosenStore.capabilities = ['collections.read']; if (mode.startsWith('missing-')) chosenStore.missingCapabilities = [mode === 'missing-read' ? 'collections.read' : 'collections.write'];
    const opened = [], onRename = (...args) => opened.push(args), ui = await collectionBrowser(async path => ({ ...(path.includes('?') ? collectionPage() : collectionDetail()), store: chosenStore }), { onRename: mode === 'no-callback' ? undefined : onRename });
    await ui.click('Load collections'); await ui.tick(); assert.equal(ui.button('Rename collection title'), undefined, 'A list cannot authorize rename.');
    if (mode === 'missing-read') continue; await ui.click('Read collection Returned collection'); await ui.tick();
    if (mode !== 'allowed') { assert.equal(ui.button('Rename collection title'), undefined); continue; }
    const retained = ui.button('Rename collection title').props.onClick; await ui.click('Rename collection title'); assert.deepEqual(opened[0], [accounts[0], chosenStore, collection()]);
    ui.setProps({ onRename: undefined }); retained(); ui.setProps({ onRename }); retained(); assert.equal(opened.length, 1);
    ui.discardProps({ onRename: undefined }); await ui.click('Rename collection title'); assert.equal(opened.length, 2);
    await ui.change('Platform collection query', 'different'); retained(); assert.equal(opened.length, 2); assert.doesNotMatch(ui.html(), /Rename collection title/);
    assert.ok(ui.calls.every(call => call.length === 1), 'Entry and browsing remain reads.');
  }
  const opened = [], ui = await browser(async path => path.includes('?') ? { ...collectionPage(), store: collectionWriteStore() } : { ...collectionDetail(), store: collectionWriteStore() }, accounts, { onRenameCollection: (...args) => opened.push(args) });
  await ui.change('Shopify account', accounts[0].id); await ui.click('Load collections'); await ui.tick(); await ui.click('Read collection Returned collection'); await ui.tick();
  const retained = ui.button('Rename collection title').props.onClick; await ui.click('Rename collection title'); assert.deepEqual(opened[0], [accounts[0], collectionWriteStore(), collection()]);
  await ui.change('Shopify account', accounts[1].id); await ui.change('Shopify account', accounts[0].id); retained(); assert.equal(opened.length, 1);
});

test('collection title editor uses fresh exact review, literal text and one acknowledgement before its bounded rename', async () => {
  let validated = 0; const ui = await collectionEditor(async (path, body, validate) => { if (!body) { assert.equal(path, 'products/shop%2Fa/collections/gid%3A%2F%2Fshopify%2FCollection%2F7001/edit'); return collectionEdit(); } const result = collectionReceipt(); validate(result); validated++; return result; });
  assert.equal(ui.field('Collection title').type, 'input'); assert.match(ui.html(), /Current collection title: Returned collection/); assert.match(ui.html(), /membership and publication are unknown/);
  await ui.change('Collection title', '  Renamed collection  '); await ui.click('Review collection title'); await ui.tick();
  assert.equal(ui.calls.length, 2); assert.equal(ui.button('Save collection title').props.disabled, true); await ui.submit(); assert.equal(ui.calls.length, 2);
  assert.match(ui.html(), /Review Shopify collection title.*Account shop\/a.*shop.example.*Native collection gid:\/\/shopify\/Collection\/7001.*Before: Returned collection.*After: Renamed collection/);
  assert.doesNotMatch(ui.html(), /collection-version|<img|<script|<iframe|<a\s/); ui.confirm(); await ui.submit(); await ui.tick();
  const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 1); assert.equal(writes[0][0], 'products/shop%2Fa/collections/gid%3A%2F%2Fshopify%2FCollection%2F7001/rename'); assert.deepEqual(writes[0][1], { version: 'collection-version', title: 'Renamed collection' }); assert.equal(validated, 1);
  assert.match(ui.html(), /Collection title confirmed by Shopify readback/); assert.equal(ui.field('Collection title').props.value, '  Renamed collection  '); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 1);
  const inert = await collectionEditor(async () => collectionEdit({ ...collection(), title: '<script>title()</script>' })); assert.match(inert.html(), /&lt;script&gt;title\(\)&lt;\/script&gt;/); assert.doesNotMatch(inert.html(), /<script/);
});

test('collection title validation and missing grants prevent review reads or mutations', async () => {
  for (const value of [' ', 'bad\nname', 'bad\u0000name', 'x'.repeat(10001), '  Returned collection  ']) {
    const ui = await collectionEditor(); await ui.change('Collection title', value); await ui.click('Review collection title'); await ui.tick(); await ui.submit(); assert.equal(ui.calls.length, 1); assert.match(ui.html(), /Enter a collection title|Change the collection title/);
  }
  for (const props of [{ readOnly: true }, { account: { ...accounts[0], isActive: false } }, { account: { ...accounts[0], needsReconnection: true } }, { store: collectionStore() }, { store: { ...collectionWriteStore(), missingCapabilities: ['collections.read'] } }, { store: { ...collectionWriteStore(), missingCapabilities: ['collections.write'] } }, { collection: { ...collection(), accountId: 'other' } }]) {
    const ui = await collectionEditor(async () => assert.fail('Ineligible editor must not request'), props); await ui.button('Review collection title').props.onClick(); await ui.submit(); assert.equal(ui.calls.length, 0); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true);
  }
});

test('collection fresh review refuses drift and malformed scopes while retaining the authored title', async () => {
  for (const mutate of [r => { r.accountId = 'other'; }, r => { r.collection.id = 'other'; }, r => { r.collection.accountId = 'other'; }, r => { r.store.domain = 'other.example'; }, r => { r.store.missingCapabilities = ['collections.write']; }, r => { r.version = ''; }, r => { r.version = 'changed-version'; }]) {
    let first = true; const ui = await collectionEditor(async () => { const value = collectionEdit(); if (!first) mutate(value); first = false; return value; }); await ui.change('Collection title', 'Keep authored title'); await ui.click('Review collection title'); await ui.tick(); await ui.submit();
    assert.doesNotMatch(ui.html(), /Review Shopify collection title/); assert.match(ui.html(), /could not be verified|collection changed/); assert.equal(ui.field('Collection title').props.value, 'Keep authored title'); assert.equal(ui.calls.filter(call => call[1]).length, 0);
  }
});

test('collection retained review, acknowledgement and submit cannot survive committed changes or edited content', async () => {
  for (const mode of ['read-only', 'inactive', 'store-grant', 'collection-refresh', 'account-refresh', 'store-refresh', 'A-B-A', 'edit', 'unconfirm', 'refresh']) {
    const ui = await collectionEditor(); await reviewCollectionTitle(ui); const submit = ui.find(node => node.type === 'form').props.onSubmit, confirm = ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange;
    if (mode === 'read-only') ui.setProps({ readOnly: true }); if (mode === 'inactive') ui.setProps({ account: { ...accounts[0], isActive: false } }); if (mode === 'store-grant') ui.setProps({ store: { ...collectionWriteStore(), missingCapabilities: ['collections.write'] } }); if (mode === 'collection-refresh') ui.setProps({ collection: collection() }); if (mode === 'account-refresh') ui.setProps({ account: { ...accounts[0] } }); if (mode === 'store-refresh') ui.setProps({ store: collectionWriteStore() }); if (mode === 'A-B-A') { ui.setProps({ readOnly: true }); ui.setProps({ readOnly: false }); } if (mode === 'edit') await ui.change('Collection title', 'Newer authored title'); if (mode === 'unconfirm') ui.confirm(false); if (mode === 'refresh') { await ui.click('Refresh current collection review'); await ui.tick(); }
    if (mode !== 'unconfirm') confirm({ target: { checked: true } }); await submit({ preventDefault() {} }); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0, mode); assert.equal(ui.field('Collection title').props.value, mode === 'edit' ? 'Newer authored title' : '  Renamed collection  ');
  }
  const ui = await collectionEditor(); await reviewCollectionTitle(ui); ui.discardProps({ readOnly: true }); await ui.submit(); await ui.tick(); assert.match(ui.html(), /Collection title confirmed/);
});

test('collection malformed receipts require explicit permission-gated checks of the same action without automatic retries', async () => {
  for (const requestValidates of [false, true]) for (const mutate of [r => { r.accountId = 'other'; }, r => { r.collection.id = 'other'; }, r => { r.collection.title = 'Wrong accepted title'; }, r => { r.store.domain = 'other.example'; }, r => { r.store.missingCapabilities = ['collections.write']; }, r => { r.readback = false; }, r => { r.operation.status = 'pending'; }, r => { r.operation.id = ''; }]) {
    let malformed = true; const ui = await collectionEditor(async (_path, body, validate) => { if (!body) return collectionEdit(); const value = collectionReceipt(); if (malformed) mutate(value); if (requestValidates) validate(value); return value; }); await reviewCollectionTitle(ui); await ui.submit(); await ui.tick();
    assert.match(ui.html(), /outcome is unknown/); assert.doesNotMatch(ui.html(), /Collection title confirmed|Review Shopify collection title|Refresh current collection review/); assert.equal(ui.field('Collection title').props.value, '  Renamed collection  '); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true); assert.equal(ui.calls.filter(call => call[1]).length, 1);
    const retained = ui.find(node => node.type === 'form').props.onSubmit; ui.setProps({ readOnly: true }); await retained({ preventDefault() {} }); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 1); assert.equal(ui.button('Check outcome').props.disabled, true);
    ui.setProps({ readOnly: false }); malformed = false; await ui.submit(); await ui.tick(); const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 2); assert.deepEqual(writes[0].slice(0, 2), writes[1].slice(0, 2)); assert.match(ui.html(), /Collection title confirmed/);
  }
});

test('collection known-unsent and failed attempts withdraw recovery, retain title and require fresh review and a new action key', async () => {
  for (const rejection of [{ code: 'OPERATION_NOT_SENT' }, { code: 'COLLECTION_PREVIOUS_OUTCOME_UNRESOLVED', operation: { id: 'own-failed', status: 'failed' } }]) {
    let terminal = false, sequence = 0; const attempts = [], keys = new Map(); const ui = await collectionEditor(async (path, body, validate) => {
      if (!body) return collectionEdit(undefined, terminal ? 'fresh-after-not-sent' : 'collection-version');
      const payload = JSON.stringify([path, body]); if (!keys.has(payload)) keys.set(payload, ++sequence); attempts.push({ payload, key: keys.get(payload) });
      if (attempts.length === 1) throw new Error('Response lost');
      if (!terminal) { terminal = true; keys.delete(payload); throw Object.assign(new Error('Earlier request was not sent'), { status: 409, ...rejection }); }
      const value = collectionReceipt(); validate(value); return value;
    }); await reviewCollectionTitle(ui); await ui.submit(); await ui.tick(); const retained = ui.find(node => node.type === 'form').props.onSubmit; assert.match(ui.html(), /outcome is unknown/); assert.ok(ui.button('Check outcome')); await ui.submit(); await ui.tick();
    assert.deepEqual(attempts[0], attempts[1]); assert.match(ui.html(), /Earlier request was not sent.*Refresh.*review a new action/); assert.doesNotMatch(ui.html(), /outcome is unknown|Review Shopify/); assert.equal(ui.field('Collection title').props.value, '  Renamed collection  ');
    await retained({ preventDefault() {} }); await ui.submit(); await ui.button('Review collection title').props.onClick(); assert.equal(attempts.length, 2);
    await ui.click('Refresh current collection review'); await ui.tick(); await ui.click('Review collection title'); await ui.tick(); await ui.submit(); assert.equal(attempts.length, 2); ui.confirm(); await ui.submit(); await ui.tick(); assert.equal(attempts.length, 3); assert.notEqual(attempts[0].key, attempts[2].key); assert.match(attempts[2].payload, /fresh-after-not-sent/); assert.match(ui.html(), /Collection title confirmed/);
  }
});

test('collection closure and definitive rejection retain title but require an explicit fresh review', async () => {
  for (const problem of [{ status: 409, code: 'OPERATION_REVIEWED', operation: { id: 'closed-collection', status: 'reviewed-failed' } }, { status: 403, code: 'PROJECT_ACCESS_CHANGED' }]) {
    let writes = 0; const ui = await collectionEditor(async (_path, body) => { if (!body) return collectionEdit(undefined, writes ? 'after-rejection' : 'collection-version'); writes++; if (writes === 1) throw Object.assign(new Error('Title change rejected'), problem); return collectionReceipt(); });
    await reviewCollectionTitle(ui); await ui.submit(); await ui.tick(); assert.doesNotMatch(ui.html(), /outcome is unknown|Review Shopify collection title/); assert.equal(ui.field('Collection title').props.value, '  Renamed collection  '); await ui.submit(); await ui.button('Review collection title').props.onClick(); assert.equal(writes, 1);
    await ui.click('Refresh current collection review'); await ui.tick(); await ui.click('Review collection title'); await ui.tick(); await ui.submit(); assert.equal(writes, 1); ui.confirm(); await ui.submit(); await ui.tick(); assert.equal(writes, 2); assert.equal(ui.calls.filter(call => call[1]).at(-1)[1].version, 'after-rejection'); assert.match(ui.html(), /Collection title confirmed/);
  }
});

test('collection late reads and receipts cannot revive old A to B to A resource contexts or unmounted drafts', async () => {
  const reads = [], ui = await collectionEditor(async () => { reads.push(deferred()); return reads.at(-1).promise; }); ui.setProps({ collection: collection('other-collection') }); await ui.tick(); ui.setProps({ collection: collection() }); await ui.tick();
  reads[0].resolve(collectionEdit({ ...collection(), title: 'STALE A' })); reads[1].resolve(collectionEdit({ ...collection('other-collection'), title: 'STALE B' })); await ui.tick(); assert.equal(ui.field('Collection title').props.value, ''); reads[2].resolve(collectionEdit()); await ui.tick(); assert.equal(ui.field('Collection title').props.value, 'Returned collection');
  for (const mode of ['resource', 'unmount', 'safety']) {
    const held = deferred(); let reading = false; const changing = await collectionEditor(async (path, body) => body || reading ? held.promise : collectionEdit());
    if (mode === 'safety') { reading = true; await changing.change('Collection title', 'Keep title'); const pending = changing.click('Review collection title'); changing.setProps({ readOnly: true }); changing.setProps({ readOnly: false }); held.resolve(collectionEdit()); await pending; await changing.tick(); assert.doesNotMatch(changing.html(), /Review Shopify collection title/); assert.equal(changing.field('Collection title').props.value, 'Keep title'); continue; }
    await reviewCollectionTitle(changing); const pending = changing.submit(); if (mode === 'resource') { changing.setProps({ collection: collection('other-collection') }); await changing.tick(); changing.setProps({ collection: collection() }); await changing.tick(); } else changing.unmount(); held.resolve(collectionReceipt()); await pending; await changing.tick(); assert.doesNotMatch(changing.html(), /Collection title confirmed|outcome is unknown/);
  }
});

test('collections use only their read grant, explicit real handlers, opaque IDs and inert provider content in the existing panel', async () => {
  const ui = await browser(async path => { assert.doesNotMatch(path, /\/store$/); return path.includes('?') ? collectionPage() : collectionDetail(); });
  await ui.change('Shopify account', accounts[0].id); assert.equal(ui.calls.length, 1, 'Selection does not fetch collections.'); await ui.click('Load collections'); await ui.tick();
  assert.equal(ui.calls[1][0], 'products/shop%2Fa/collections?limit=20'); assert.match(ui.html(), /Collection page 1/); assert.match(ui.html(), /<td>0<\/td>/); assert.doesNotMatch(ui.html(), /Product read permission is missing/);
  await ui.click('Read collection Returned collection'); await ui.tick(); assert.equal(ui.calls.at(-1)[0], 'products/shop%2Fa/collections/gid%3A%2F%2Fshopify%2FCollection%2F7001');
  const html = ui.html(); assert.match(html, /Native collection gid:\/\/shopify\/Collection\/7001/); assert.match(html, /&lt;script&gt;collection\(\)&lt;\/script&gt;/); assert.match(html, /javascript:collection\(\)/); assert.match(html, /Product count<\/dt><dd>0/); assert.match(html, /Sort order<\/dt><dd>Unknown/); assert.match(html, /Visibility, publication, collection type, rules and member products are unknown/); assert.match(html, /Product counts can lag membership/); assert.match(html, /completeness and provider freshness are unknown/);
  assert.doesNotMatch(html, /<img|<script|<iframe|<a\s|Create collection|Publish collection|Delete collection/); assert.ok(ui.calls.every(args => args.length === 1), 'All backend calls are GET reads without bodies.');
});

test('collection queries preserve exact native text, pages preserve opaque cursors and repeated cursors clear stale rows', async () => {
  let response = collectionPage(undefined, 'qa-collections-next+/='), ui = await collectionBrowser(async () => response);
  const query = '  title:"Blue & red"  '; await ui.change('Platform collection query', query); assert.equal(ui.calls.length, 0); await ui.click('Load collections'); await ui.tick();
  let params = new URL(ui.calls.at(-1)[0], 'https://app.example').searchParams; assert.equal(params.get('query'), query); assert.equal(params.get('limit'), '20'); assert.equal(params.has('cursor'), false);
  response = collectionPage([{ ...collection('collection:unknown'), title: 'Unknown collection', productCount: null, descriptionHtml: null, image: null }]); await ui.click('Next collection page'); await ui.tick(); params = new URL(ui.calls.at(-1)[0], 'https://app.example').searchParams; assert.equal(params.get('cursor'), 'qa-collections-next+/='); assert.equal(params.get('query'), query); assert.match(ui.html(), /Collection page 2/); assert.match(ui.html(), /<td>Unknown<\/td>/);
  response = collectionDetail({ ...collection('collection:unknown'), title: 'Unknown collection', productCount: null, descriptionHtml: null, image: null }); await ui.click('Read collection Unknown collection'); await ui.tick(); assert.match(ui.html(), /Image unknown|Description HTML unknown/); assert.doesNotMatch(ui.html(), /Product count<\/dt><dd>0/);
  for (const repeated of ['same', 'cycle']) {
    response = collectionPage(undefined, 'same'); await ui.click('Refresh first collection page'); await ui.tick(); response = collectionPage(undefined, repeated === 'cycle' ? 'other' : 'same'); await ui.click('Next collection page'); await ui.tick(); if (repeated === 'cycle') { response = collectionPage(undefined, 'same'); await ui.click('Next collection page'); await ui.tick(); }
    assert.match(ui.html(), /next page could not be verified/); assert.doesNotMatch(ui.html(), /Read collection|Next collection page|No collections were returned/);
  }
  const count = ui.calls.length; await ui.change('Platform collection query', 'x'.repeat(501)); await ui.click('Load collections'); await ui.tick(); assert.equal(ui.calls.length, count); assert.match(ui.html(), /at most 500/);
});

test('collection validation rejects wrong scopes, grants, duplicate IDs, malformed optional evidence and mismatched detail identities', async () => {
  for (const mutate of [r => { r.accountId = 'other'; }, r => { r.store.accountId = 'other'; }, r => { r.store.platform = 'other'; }, r => { r.store.capabilities = ['products.read']; }, r => { r.store.missingCapabilities = ['collections.read']; }, r => { r.collections[0].accountId = 'other'; }, r => { r.collections[0].platform = 'other'; }, r => { r.collections[0].id = '../bad'; }, r => { r.collections[0].id = 'bad id'; }, r => { r.collections.push(r.collections[0]); }, r => { r.collections = Array.from({ length: 21 }, (_, index) => collection(String(index))); }, r => { r.collections[0].sortOrder = 'automatic'; }, r => { r.collections[0].productCount = -1; }, r => { r.collections[0].productCount = 0.5; }, r => { r.collections[0].image.altText = false; }, r => { delete r.collections[0].handle; }, r => { delete r.nextCursor; }]) {
    const ui = await collectionBrowser(async () => { const result = collectionPage(); mutate(result); return result; }); await ui.click('Load collections'); await ui.tick(); assert.match(ui.html(), /could not be verified|permission is missing/); assert.doesNotMatch(ui.html(), /Read collection|No collections were returned|Collection page 1/);
  }
  for (const mutate of [r => { r.collection.id = 'different'; }, r => { r.store.domain = 'different.example'; }, r => { r.collection.accountId = 'other'; }, r => { r.store.missingCapabilities = ['collections.read']; }]) {
    let response = collectionPage(); const ui = await collectionBrowser(async () => response); await ui.click('Load collections'); await ui.tick(); response = collectionDetail(); mutate(response); await ui.click('Read collection Returned collection'); await ui.tick(); assert.match(ui.html(), /could not be verified|permission is missing/); assert.doesNotMatch(ui.html(), /Raw collection description HTML|Read collection|No collections were returned/);
  }
});

test('collection failures and backend permission loss clear old evidence and offer actionable fresh reads', async () => {
  for (const [status, message] of [[403, /permission is missing.*connection and permissions/], [404, /not found.*Refresh the first page/], [429, /rate limited.*later/]]) {
    let failure = false; const ui = await collectionBrowser(async () => { if (failure) throw Object.assign(new Error('Provider failure'), { status }); return collectionPage(undefined, 'next'); }); await ui.click('Load collections'); await ui.tick(); failure = true; const pending = ui.click('Refresh first collection page'); assert.doesNotMatch(ui.html(), /Read collection|Next collection page|No collections were returned/); await pending; await ui.tick(); assert.match(ui.html(), message); assert.doesNotMatch(ui.html(), /Read collection|Next collection page|No collections were returned|Collection page 1/);
  }
  const empty = await collectionBrowser(async () => collectionPage([])); await empty.click('Load collections'); await empty.tick(); assert.match(empty.html(), /No collections were returned for this page and query. Collection completeness is unknown/); await empty.change('Platform collection query', 'new'); assert.doesNotMatch(empty.html(), /No collections were returned/);
  const lost = await collectionBrowser(async () => { throw Object.assign(new Error('Your project access changed. Refresh before continuing.'), { status: 403, code: 'PROJECT_ACCESS_CHANGED' }); }); await lost.click('Load collections'); await lost.tick(); assert.match(lost.html(), /Your project access changed/);
});

test('committed collection query and account changes suppress pending replies and retained actions including account A to B to A', async () => {
  for (const mode of ['query', 'account-A-B-A', 'unmount']) {
    const held = deferred(), ui = await browser(async () => held.promise); await ui.change('Shopify account', accounts[0].id); const retained = ui.button('Load collections').props.onClick, reading = ui.click('Load collections'); await ui.button('Load collections').props.onClick(); assert.equal(ui.calls.length, 2, 'A pending read cannot send twice.');
    if (mode === 'query') await ui.change('Platform collection query', 'new'); if (mode === 'account-A-B-A') { await ui.change('Shopify account', accounts[1].id); await ui.change('Shopify account', accounts[0].id); } if (mode === 'unmount') ui.unmount();
    held.resolve(collectionPage()); await reading; await ui.tick(); assert.doesNotMatch(ui.html(), /Read collection|No collections were returned|Collection page 1/); const count = ui.calls.length; await retained(); await ui.tick(); assert.equal(ui.calls.length, count, mode);
  }
  for (const props of [{ account: { ...accounts[0] } }, { account: { ...accounts[0], isActive: false } }, { account: { ...accounts[0], needsReconnection: true } }]) {
    const held = deferred(), ui = await collectionBrowser(async () => held.promise), reading = ui.click('Load collections'); ui.setProps(props); held.reject(new Error('STALE_COLLECTION_ERROR')); await reading; await ui.tick(); assert.doesNotMatch(ui.html(), /STALE_COLLECTION_ERROR|Read collection|No collections were returned/);
  }
});

test('collection detail events cannot read old rows after refreshing or changing query and request callback churn retains the same meaningful scope', async () => {
  let held; const ui = await collectionBrowser(async path => held ? held.promise : path.includes('?') ? collectionPage() : collectionDetail()); await ui.click('Load collections'); await ui.tick(); const readOld = ui.button('Read collection Returned collection').props.onClick;
  ui.renewRequest(); assert.ok(ui.button('Read collection Returned collection')); await ui.click('Read collection Returned collection'); await ui.tick(); assert.match(ui.html(), /Raw collection description HTML/); const count = ui.calls.length; await readOld(); assert.equal(ui.calls.length, count);
  held = deferred(); const refreshing = ui.click('Refresh first collection page'); ui.renewRequest(); held.resolve(collectionPage()); await refreshing; await ui.tick(); assert.ok(ui.button('Read collection Returned collection')); const retained = ui.button('Read collection Returned collection').props.onClick; await ui.change('Platform collection query', 'different'); const before = ui.calls.length; await retained(); assert.equal(ui.calls.length, before); assert.doesNotMatch(ui.html(), /Raw collection description HTML|Read collection|Next collection page/);
  const inactive = await collectionBrowser(async () => assert.fail('Disconnected accounts cannot read'), { account: { ...accounts[0], isActive: false } }); await inactive.button('Load collections').props.onClick(); assert.equal(inactive.calls.length, 0);
});

const writeStore = () => ({ ...store(), capabilities: ['products.read', 'products.update'] });
const collectionProductStore = () => ({ ...writeStore(), capabilities: ['products.read', 'products.update', 'collections.read'] });
const filteredProductPage = (rows = [product()], nextCursor = null) => ({ ...page(rows, nextCursor), accountId: accounts[0].id, store: collectionProductStore(), collection: collection() });
async function productsWithCollections(respond = async () => filteredProductPage(), props = {}) {
  const ui = await browser(async path => path.includes('/collections') ? { ...(path.includes('?') ? collectionPage() : collectionDetail()), store: collectionProductStore() } : path.endsWith('/store') ? { store: collectionProductStore() } : respond(path), accounts, props);
  await ui.change('Shopify account', accounts[0].id); return ui;
}
async function chooseProductCollection(ui) {
  await ui.click('Load collections'); await ui.tick(); assert.equal(ui.button('Use this collection as product filter'), undefined, 'A collection page alone does not authorize selection.');
  await ui.click('Read collection Returned collection'); await ui.tick(); await ui.click('Use this collection as product filter'); await ui.tick();
}

test('a verified collection explicitly filters product pages while preserving query, cursor and native product detail/edit identity', async () => {
  const opened = [], ui = await productsWithCollections(async path => {
    if (!path.includes('?')) return detail();
    const params = new URL(path, 'https://app.example').searchParams;
    return params.has('collectionId') ? filteredProductPage(undefined, params.has('cursor') ? null : 'collection-products+/=&?') : page();
  }, { onEdit: (...args) => opened.push(args) });
  const query = '  title:"Blue & red"  '; await ui.change('Platform product query', query); await ui.change('Product status', 'draft'); ui.submit(); await ui.tick();
  const oldEdit = ui.button('Edit product Provider product').props.onClick; await chooseProductCollection(ui); oldEdit(); assert.equal(opened.length, 0); assert.doesNotMatch(ui.html(), /Provider vendor/);
  assert.match(ui.html(), /Product listing filter: Returned collection.*Native collection gid:\/\/shopify\/Collection\/7001/); assert.match(ui.html(), /Selected\. Load the first product page above/);
  const selectedCalls = ui.calls.length; await ui.tick(); assert.equal(ui.calls.length, selectedCalls, 'Selection waits for the explicit first product page read.');
  ui.submit(); await ui.tick(); let params = new URL(ui.calls.at(-1)[0], 'https://app.example').searchParams;
  assert.equal(params.get('collectionId'), collection().id); assert.equal(params.get('query'), query); assert.equal(params.get('status'), 'draft'); assert.equal(params.get('limit'), '20'); assert.equal(params.has('cursor'), false);
  await ui.click('Next page'); await ui.tick(); params = new URL(ui.calls.at(-1)[0], 'https://app.example').searchParams; assert.equal(params.get('collectionId'), collection().id); assert.equal(params.get('cursor'), 'collection-products+/=&?'); assert.equal(params.get('query'), query); assert.match(ui.html(), /Page 2/);
  await ui.click('Read Provider product'); await ui.tick(); assert.equal(ui.calls.at(-1)[0], 'products/shop%2Fa/product%2Fa'); assert.match(ui.html(), /Product listing filter/); assert.match(ui.html(), /Raw description HTML/);
  await ui.click('Edit product Provider product'); assert.deepEqual(opened.at(-1), [accounts[0], collectionProductStore(), product()]);
  await ui.change('Platform product query', 'new exact query'); await ui.change('Product status', 'active'); assert.match(ui.html(), /Product listing filter/); assert.doesNotMatch(ui.html(), /Raw description HTML|Next page|Provider vendor/);
  ui.submit(); await ui.tick(); params = new URL(ui.calls.at(-1)[0], 'https://app.example').searchParams; assert.equal(params.get('collectionId'), collection().id); assert.equal(params.get('query'), 'new exact query'); assert.equal(params.get('status'), 'active'); assert.equal(params.has('cursor'), false);
  const count = ui.calls.length; await ui.click('Return to all products'); await ui.tick(); assert.equal(ui.calls.length, count); assert.doesNotMatch(ui.html(), /Product listing filter|Selected\. Load|Provider vendor|Next page/);
  ui.submit(); await ui.tick(); assert.equal(new URL(ui.calls.at(-1)[0], 'https://app.example').searchParams.has('collectionId'), false); assert.ok(ui.calls.every(args => args.length === 1), 'Collection browsing and selection never send a provider write.');
});

test('collection product entry needs both explicit read grants and a current detail callback', async () => {
  for (const mode of ['allowed', 'no-products', 'missing-products', 'missing-collections', 'no-callback']) {
    const selectedStore = collectionProductStore(); if (mode === 'no-products') selectedStore.capabilities = ['collections.read']; if (mode.startsWith('missing-')) selectedStore.missingCapabilities = [mode === 'missing-products' ? 'products.read' : 'collections.read'];
    const selected = [], onBrowse = (...args) => selected.push(args), ui = await collectionBrowser(async path => ({ ...(path.includes('?') ? collectionPage() : collectionDetail()), store: selectedStore }), { onBrowse: mode === 'no-callback' ? undefined : onBrowse });
    await ui.click('Load collections'); await ui.tick(); if (mode === 'missing-collections') { assert.doesNotMatch(ui.html(), /Read collection|Use this collection/); continue; }
    assert.equal(ui.button('Use this collection as product filter'), undefined); await ui.click('Read collection Returned collection'); await ui.tick();
    if (mode !== 'allowed') { assert.match(ui.html(), /Raw collection description HTML/); assert.equal(ui.button('Use this collection as product filter'), undefined); continue; }
    const retained = ui.button('Use this collection as product filter').props.onClick; await ui.click('Use this collection as product filter'); assert.deepEqual(selected[0], [accounts[0], selectedStore, collection()]);
    ui.setProps({ onBrowse: undefined }); retained(); ui.setProps({ onBrowse }); retained(); assert.equal(selected.length, 1, 'Restoring a callback cannot revive an old collection selection.');
    ui.discardProps({ onBrowse: undefined }); await ui.click('Use this collection as product filter'); assert.equal(selected.length, 2, 'Discarded renders do not withdraw committed actions.');
    ui.setProps({ account: accounts[1] }); ui.setProps({ account: accounts[0] }); retained(); assert.equal(selected.length, 2); assert.doesNotMatch(ui.html(), /Use this collection as product filter/);
  }
});

test('retained collection selections and all-products events cannot cross refreshed metadata, filters or account A to B to A', async () => {
  for (const mode of ['metadata-query', 'metadata-refresh', 'product-query', 'account-A-B-A']) {
    const ui = await productsWithCollections(); await chooseProductCollection(ui); const retained = ui.button('Use this collection as product filter').props.onClick, all = ui.button('Return to all products').props.onClick;
    if (mode === 'metadata-query') await ui.change('Platform collection query', 'other');
    if (mode === 'metadata-refresh') { await ui.click('Refresh first collection page'); await ui.tick(); }
    if (mode === 'product-query') await ui.change('Platform product query', 'other');
    if (mode === 'account-A-B-A') { await ui.change('Shopify account', accounts[1].id); await ui.change('Shopify account', accounts[0].id); }
    const count = ui.calls.length; await retained(); await ui.tick(); assert.equal(ui.calls.length, count);
    if (mode === 'account-A-B-A') assert.doesNotMatch(ui.html(), /Product listing filter|Selected\. Load/);
    if (mode === 'product-query') { await all(); await ui.tick(); assert.match(ui.html(), /Product listing filter/, 'An old return action cannot clear a newer selection scope.'); }
  }
});

test('filtered product replies cannot cross query, status, return-to-all or account changes and selection never revives', async () => {
  for (const mode of ['query', 'status', 'all', 'account-A-B-A']) {
    const held = deferred(), ui = await productsWithCollections(async () => held.promise); await chooseProductCollection(ui); const retained = ui.button('Use this collection as product filter').props.onClick; ui.submit(); await ui.tick();
    if (mode === 'query') await ui.change('Platform product query', 'new'); if (mode === 'status') await ui.change('Product status', 'draft'); if (mode === 'all') await ui.click('Return to all products'); if (mode === 'account-A-B-A') { await ui.change('Shopify account', accounts[1].id); await ui.change('Shopify account', accounts[0].id); }
    held.resolve(filteredProductPage([{ ...product(), title: 'STALE COLLECTION PRODUCT' }], 'stale-next')); await ui.tick(); assert.doesNotMatch(ui.html(), /STALE COLLECTION PRODUCT|Next page|Provider vendor/);
    await retained(); await ui.tick(); if (mode === 'query' || mode === 'status') assert.match(ui.html(), /Product listing filter/); else assert.doesNotMatch(ui.html(), /Product listing filter|Selected\. Load/);
  }
});

test('filtered pages reject missing, malformed and mismatched collection/store evidence, grants, products and coverage', async () => {
  for (const mutate of [r => { delete r.accountId; }, r => { r.accountId = 'other'; }, r => { delete r.collection; }, r => { r.collection.id = 'gid://shopify/Collection/7002'; }, r => { r.collection.accountId = 'other'; }, r => { r.collection.productCount = -1; }, r => { r.store.domain = 'other.example'; }, r => { r.store.capabilities = ['products.read']; }, r => { r.store.missingCapabilities = ['products.read']; }, r => { r.store.missingCapabilities = ['collections.read']; }, r => { r.coverage = {}; }, r => { r.products[0].accountId = 'other'; }, r => { delete r.nextCursor; }]) {
    const ui = await productsWithCollections(async () => { const result = filteredProductPage(); mutate(result); return result; }); await chooseProductCollection(ui); ui.submit(); await ui.tick(); assert.match(ui.html(), /could not be verified/); assert.doesNotMatch(ui.html(), /Product listing filter|Provider vendor|Next page|No products were returned/);
  }
});

test('fresh filtered reads dismiss selected collection and prior product actions on store/grant drift and 404 failures', async () => {
  for (const mode of ['store', 'products-grant', 'collections-grant', '404', '403']) {
    let changed = false; const ui = await browser(async path => {
      if (path.includes('/collections')) return { ...(path.includes('?') ? collectionPage() : collectionDetail()), store: collectionProductStore() };
      if (path.endsWith('/store')) { const value = collectionProductStore(); if (changed && mode === 'store') value.domain = 'changed.example'; if (changed && mode.endsWith('-grant')) value.missingCapabilities = [mode === 'products-grant' ? 'products.read' : 'collections.read']; return { store: value }; }
      if (changed && /^40/.test(mode)) throw Object.assign(new Error('Filtered collection unavailable'), { status: Number(mode) }); return filteredProductPage();
    }, accounts, { onEdit: () => assert.fail('Stale filtered products cannot enter an edit action.') });
    await ui.change('Shopify account', accounts[0].id); await chooseProductCollection(ui); ui.submit(); await ui.tick(); const edit = ui.button('Edit product Provider product').props.onClick, selectCollection = ui.button('Use this collection as product filter').props.onClick; changed = true; ui.submit(); await ui.tick(); edit(); selectCollection(); await ui.tick(); assert.match(ui.html(), /could not be verified|permission is missing|unavailable/); assert.doesNotMatch(ui.html(), /Product listing filter|Provider vendor|Next page|Edit product|Use this collection as product filter|Raw collection description HTML/); assert.ok(ui.button('Load collections'), 'Filtered scope failure withdraws old metadata and requires an explicit new collection read.');
  }
  const ordinary = await productsWithCollections(async () => { throw new Error('Ordinary product read failed'); }); await ordinary.click('Load collections'); await ordinary.tick(); await ordinary.click('Read collection Returned collection'); await ordinary.tick(); ordinary.submit(); await ordinary.tick(); assert.ok(ordinary.button('Use this collection as product filter'), 'Ordinary product failures preserve independent collection metadata.');
});

const editDetail = (row = product(), version = 'product-version') => ({ product: row, store: writeStore(), version });
const updateReceipt = (row = { ...product(), title: 'Updated title', descriptionHtml: '<p>Canonical HTML</p>' }) => ({ accountId: accounts[0].id, product: row, store: writeStore(), readback: true, operation: { id: 'product-operation', status: 'complete' } });
const editor = (respond = async () => editDetail(), props = {}) => browser(respond, accounts, { kind: 'ProductEditor', account: accounts[0], store: writeStore(), product: product(), ...props });
async function reviewUpdate(ui, html = ' <p>Submitted HTML</p> ') { await ui.change('Product title', '  Updated title  '); if (html !== null) await ui.change('Description HTML', html); await ui.click('Review product changes'); await ui.tick(); ui.confirm(); }

test('product type and full tags keep exact labels and complete before/after values in the existing reviewed update', async () => {
  const original = { ...product(), productType: 'Original type', tags: ['first, tag', ' Case ', 'case'] }, tags = ['Blue,Red', ' Case ', 'case', 'case', '', 'line\nbreak'];
  let validated = false; const ui = await editor(async (path, body, validate) => {
    if (!body) return editDetail(original);
    assert.equal(path, 'products/shop%2Fa/product%2Fa/update'); assert.deepEqual(body, { version: 'product-version', confirmUpdate: true, productType: '  Exact, Type  ', tags });
    const result = updateReceipt({ ...original, productType: body.productType, tags: [...body.tags].reverse() }); validate(result); validated = true; return result;
  }, { product: original });
  assert.equal(ui.field('Product type').type, 'input'); assert.equal(ui.field('Tag 1').type, 'textarea');
  await ui.change('Product type', '  Exact, Type  '); await ui.click('Clear all tags');
  for (const [index, value] of tags.entries()) { await ui.click('Add tag'); await ui.change(`Tag ${index + 1}`, value); }
  await ui.click('Review product changes'); await ui.tick();
  for (const value of ['Product type: "Original type"', 'Product type: "  Exact, Type  "', 'Tags: ' + JSON.stringify(original.tags), 'Tags: ' + JSON.stringify(tags)]) { const block = ui.find(node => node.type === 'pre' && React.Children.toArray(node.props.children).join('') === value); assert.ok(block, value); assert.deepEqual(block.props.style, { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }); }
  assert.match(ui.html(), /Changes: Product type, Tags/); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
  ui.confirm(); await ui.submit(); await ui.tick(); assert.equal(validated, true); assert.match(ui.html(), /Product update confirmed/);
  assert.equal(ui.field('Product type').props.value, '  Exact, Type  '); for (const [index, value] of tags.entries()) assert.equal(ui.field(`Tag ${index + 1}`).props.value, value);
  assert.ok(ui.find(node => node.type === 'pre' && React.Children.toArray(node.props.children).join('') === 'Accepted tags: ' + JSON.stringify([...tags].reverse())));
});

test('null product type stays untouched until explicit replacement and clearing all tags requires the exact reviewed empty list', async () => {
  for (const selected of ['untouched', 'empty-type', 'empty-tags']) {
    const ui = await editor(async (_path, body, validate) => {
      if (!body) return editDetail();
      const fields = selected === 'untouched' ? { title: 'Only title' } : selected === 'empty-type' ? { productType: '' } : { tags: [] };
      assert.deepEqual(body, { version: 'product-version', confirmUpdate: true, ...fields }); const result = updateReceipt({ ...product(), ...fields }); validate(result); return result;
    });
    assert.equal(ui.field('Product type'), undefined); assert.match(ui.html(), /Product type was not returned.*empty replacement sends an empty string/);
    if (selected === 'untouched') { await ui.change('Product title', 'Only title'); await ui.change('Tag 1', '<tag>'); }
    if (selected === 'empty-type') { await ui.click('Replace unavailable product type'); assert.equal(ui.field('Product type').props.value, ''); }
    if (selected === 'empty-tags') { await ui.click('Clear all tags'); assert.equal(ui.field('Tag 1'), undefined); }
    await ui.click('Review product changes'); await ui.tick(); if (selected === 'empty-tags') assert.match(ui.html(), /All tags will be cleared/); if (selected === 'empty-type') assert.match(ui.html(), /\(empty string\)/);
    await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0); ui.confirm(); await ui.submit(); await ui.tick(); assert.match(ui.html(), /Product update confirmed/);
  }
});

test('classification validation and every tag edit withdraw prior acknowledgement before any dispatch', async () => {
  for (const [field, value, expected] of [['Product type', 'bad\ntype', /without control/], ['Product type', 'x'.repeat(10001), /10,000/], ['Tag 1', 'bad\u0000tag', /unsupported control/], ['Tag 1', 'x'.repeat(2001), /2,000/], ['Tag 1', '<tag>', /Change the product/]]) {
    const ui = await editor(); if (field === 'Product type') await ui.click('Replace unavailable product type'); await ui.change(field, value); await ui.click('Review product changes'); await ui.tick(); assert.equal(ui.calls.length, 1); assert.match(ui.html(), expected); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
  }
  for (const mode of ['type', 'tag', 'add', 'remove', 'clear', 'scope']) {
    const ui = await editor(); await reviewUpdate(ui); const retained = ui.find(node => node.type === 'form').props.onSubmit;
    if (mode === 'type') await ui.click('Replace unavailable product type'); if (mode === 'tag') await ui.change('Tag 1', 'New, exact tag'); if (mode === 'add') await ui.click('Add tag'); if (mode === 'remove') await ui.click('Remove tag 1'); if (mode === 'clear') await ui.click('Clear all tags'); if (mode === 'scope') ui.setProps({ store: { ...writeStore(), missingCapabilities: ['products.update'] } });
    await retained({ preventDefault() {} }); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0, mode);
  }
});

test('classification receipt mismatches retain exact drafts and check only the same reviewed action', async () => {
  const tags = ['Blue,Red', ' Case ', 'case'];
  for (const validateInRequest of [false, true]) for (const mutate of [row => { row.productType = null; }, row => { row.productType = 'Different type'; }, row => { row.tags.push('case'); }, row => { row.tags = ['Blue', 'Red', 'case']; }, row => { row.tags = []; }]) {
    let malformed = true; const ui = await editor(async (_path, body, validate) => {
      if (!body) return editDetail(); const row = { ...product(), productType: 'Reviewed type', tags: [...tags] }; if (malformed) mutate(row); const value = updateReceipt(row); if (validateInRequest) validate(value); return value;
    });
    await ui.click('Replace unavailable product type'); await ui.change('Product type', 'Reviewed type'); await ui.change('Tag 1', tags[0]); await ui.click('Add tag'); await ui.change('Tag 2', tags[1]); await ui.click('Add tag'); await ui.change('Tag 3', tags[2]); await ui.click('Review product changes'); await ui.tick(); ui.confirm(); await ui.submit(); await ui.tick();
    assert.match(ui.html(), /outcome is unknown/); assert.equal(ui.calls.filter(call => call[1]).length, 1); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true); assert.equal(ui.field('Product type').props.value, 'Reviewed type'); assert.equal(ui.field('Tag 1').props.value, 'Blue,Red');
    malformed = false; await ui.submit(); await ui.tick(); const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 2); assert.deepEqual(writes[0].slice(0, 2), writes[1].slice(0, 2)); assert.equal(writes[0][3], false); assert.equal(writes[1][3], true); assert.match(ui.html(), /Product update confirmed/);
  }
});

test('operator closure preserves classification edits across a deliberate fresh product review', async () => {
  let writes = 0; const tags = ['exact, authored tag']; const ui = await editor(async (_path, body, validate) => {
    if (!body) return editDetail(writes > 1 ? { ...product(), productType: 'External type', tags: ['external tag'] } : product(), writes > 1 ? 'classification-after-closure' : 'product-version');
    writes++; if (writes === 1) throw new Error('Acknowledgement lost'); if (writes === 2) throw Object.assign(new Error('Closed'), { status: 409, code: 'OPERATION_REVIEWED', operation: { id: 'closed-classification', status: 'reviewed-failed' } });
    assert.deepEqual(body, { version: 'classification-after-closure', confirmUpdate: true, productType: '', tags }); const value = updateReceipt({ ...product(), productType: '', tags }); validate(value); return value;
  });
  await ui.click('Replace unavailable product type'); await ui.change('Tag 1', tags[0]); await ui.click('Review product changes'); await ui.tick(); ui.confirm(); await ui.submit(); await ui.tick(); await ui.submit(); await ui.tick();
  assert.equal(writes, 2); assert.equal(ui.field('Product type').props.value, ''); assert.equal(ui.field('Tag 1').props.value, tags[0]); await ui.click('Refresh current product review'); await ui.tick();
  assert.equal(ui.field('Product type').props.value, ''); assert.equal(ui.field('Tag 1').props.value, tags[0]); await ui.click('Review product changes'); await ui.tick(); assert.match(ui.html(), /External type.*external tag/s); await ui.submit(); assert.equal(writes, 2); ui.confirm(); await ui.submit(); await ui.tick(); assert.equal(writes, 3); assert.match(ui.html(), /Product update confirmed/);
});

test('collection and product state outcome recovery renders the real warning Alert with the original guarded submit', async () => {
  for (const [name, make, prepare, snapshot, receipt] of [
    ['collection', collectionEditor, reviewCollectionTitle, collectionEdit, collectionReceipt], ['draft', stateReview, reviewState, stateDetail, stateReceipt],
    ['archive', archiveReview, reviewArchive, stateDetail, archiveReceipt], ['activate', activationReview, reviewActivation, () => stateDetail(draftStateProduct()), activationReceipt],
    ['delete', deletionReview, reviewDeletion, () => stateDetail(archivedStateProduct()), deletionReceipt],
  ]) {
    let uncertain = true; const ui = await make(async (_path, body, validate) => { if (!body) return snapshot(); if (uncertain) throw new Error('Acknowledgement lost'); const value = receipt(); validate(value); return value; });
    await prepare(ui); await ui.submit(); await ui.tick(); const alert = ui.find(node => node.type === Alert); assert.ok(alert, name); assert.equal(alert.props.title, 'Outcome unknown'); assert.equal(alert.props.tone, 'warning'); assert.equal(alert.props.role, 'status');
    const content = alert.props.children; assert.equal(content.type, 'div'); assert.equal(content.props.className, 't98-settings-fields'); assert.deepEqual(React.Children.toArray(content.props.children).map(node => node.type), ['p', 'p', 'button']);
    const rendered = renderToStaticMarkup(alert); assert.match(rendered, /t98-alert t98-tone--warning/); assert.match(rendered, /role="status"/); assert.match(rendered, /t98-alert-title">Outcome unknown/); assert.match(rendered, /t98-alert-description/);
    assert.equal(ui.button('Check outcome').props.type, 'submit'); assert.equal(ui.button('Check outcome').props.name, undefined); const retained = ui.find(node => node.type === 'form').props.onSubmit;
    ui.setProps({ readOnly: true }); assert.equal(ui.button('Check outcome').props.disabled, true); await retained({ preventDefault() {} }); assert.equal(ui.calls.filter(call => call[1]).length, 1, name);
    ui.setProps({ readOnly: false }); uncertain = false; await ui.submit(); await ui.tick(); const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 2, name); assert.deepEqual(writes[0].slice(0, 2), writes[1].slice(0, 2), name); assert.equal(writes[1][3], true, name); assert.doesNotMatch(ui.html(), /Outcome unknown/);
  }
});

test('vendor edits are explicit, changed-only and require fresh acknowledgement before the existing update', async () => {
  for (const vendor of ['Reviewed vendor', '']) {
    let validated = false; const ui = await editor(async (path, body, validate) => { if (!body) return editDetail(); assert.equal(path, 'products/shop%2Fa/product%2Fa/update'); assert.deepEqual(body, { version: 'product-version', confirmUpdate: true, vendor }); const result = updateReceipt({ ...product(), vendor }); validate(result); validated = true; return result; });
    assert.equal(ui.field('Vendor').props.value, 'Provider vendor'); await ui.change('Vendor', vendor); await ui.click('Review product changes'); await ui.tick(); assert.match(ui.html(), /Vendor: Provider vendor/); assert.match(ui.html(), /Changes: Vendor/); if (vendor === '') assert.match(ui.html(), /clear vendor/);
    await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0); ui.confirm(); const retained = ui.find(node => node.type === 'form').props.onSubmit; await ui.change('Vendor', 'Newer vendor'); assert.doesNotMatch(ui.html(), /Review Shopify product update/); await retained({ preventDefault() {} }); assert.equal(ui.calls.filter(call => call[1]).length, 0);
    await ui.change('Vendor', vendor); await ui.click('Review product changes'); await ui.tick(); ui.confirm(); await ui.submit(); await ui.tick(); assert.equal(validated, true); assert.match(ui.html(), /Product update confirmed/); assert.match(ui.html(), vendor ? /Accepted vendor: Reviewed vendor/ : /Accepted vendor: \(empty\)/); assert.equal(ui.calls.filter(call => call[1]).length, 1);
  }
});

test('unavailable vendor stays omitted until a deliberate replacement, including an explicit empty clear', async () => {
  const original = { ...product(), vendor: null };
  for (const replace of [false, true]) {
    const ui = await editor(async (_path, body, validate) => { if (!body) return editDetail(original); const row = { ...original, ...(replace ? { vendor: '' } : { title: 'Only title' }) }, result = updateReceipt(row); assert.deepEqual(body, { version: 'product-version', confirmUpdate: true, ...(replace ? { vendor: '' } : { title: 'Only title' }) }); validate(result); return result; }, { product: original });
    assert.ok(ui.button('Replace unavailable vendor')); assert.match(ui.html(), /Vendor was not returned/);
    if (replace) { await ui.click('Replace unavailable vendor'); assert.equal(ui.field('Vendor').props.value, ''); } else await ui.change('Product title', 'Only title');
    await ui.click('Review product changes'); await ui.tick(); assert.match(ui.html(), replace ? /Vendor: \(clear vendor\)/ : /Vendor: Not returned \(unchanged\)/); ui.confirm(); await ui.submit(); await ui.tick(); assert.match(ui.html(), /Product update confirmed/);
  }
  const absentVendor = product(); delete absentVendor.vendor; const malformed = await editor(async () => editDetail(absentVendor)); assert.match(malformed.html(), /could not be verified/); await malformed.click('Review product changes'); await malformed.submit(); assert.equal(malformed.calls.filter(call => call[1]).length, 0);
});

test('vendor validation and current-snapshot/access changes block stale submissions while preserving authored text', async () => {
  for (const vendor of ['x'.repeat(10001), 'bad\nvendor', 'bad\tvendor', 'bad\u0000vendor']) { const ui = await editor(); await ui.change('Vendor', vendor); await ui.click('Review product changes'); await ui.tick(); assert.match(ui.html(), /Vendor must be at most/); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0); }
  for (const changed of [{ readOnly: true }, { store: { ...writeStore(), missingCapabilities: ['products.update'] } }, { product: product('other') }]) { const ui = await editor(); await ui.change('Vendor', 'Authored vendor'); await ui.click('Review product changes'); await ui.tick(); ui.confirm(); const retained = ui.find(node => node.type === 'form').props.onSubmit; ui.setProps(changed); await retained({ preventDefault() {} }); assert.equal(ui.calls.filter(call => call[1]).length, 0); }
  let fresh = editDetail(); const drift = await editor(async () => fresh); await drift.change('Vendor', 'Authored vendor'); fresh = editDetail({ ...product(), vendor: 'Changed externally' }, 'changed-version'); await drift.click('Review product changes'); await drift.tick(); assert.match(drift.html(), /product changed on Shopify/); assert.equal(drift.field('Vendor').props.value, 'Authored vendor'); await drift.submit(); assert.equal(drift.calls.filter(call => call[1]).length, 0);
  const literal = await editor(); await literal.change('Vendor', '<script>Vendor</script>'); await literal.click('Review product changes'); await literal.tick(); assert.match(literal.html(), /&lt;script&gt;Vendor&lt;\/script&gt;/); assert.doesNotMatch(literal.html(), /<script|<img/);
});

test('vendor receipt mismatches retain exact authored intent and deliberate receipt-only recovery', async () => {
  for (const badVendor of ['Wrong vendor', null]) {
    let malformed = true; const ui = await editor(async (_path, body, validate) => { if (!body) return editDetail(); const result = updateReceipt({ ...product(), vendor: malformed ? badVendor : 'Authored vendor' }); validate(result); return result; });
    await ui.change('Vendor', 'Authored vendor'); await ui.click('Review product changes'); await ui.tick(); ui.confirm(); await ui.submit(); await ui.tick(); assert.match(ui.html(), /outcome is unknown/); assert.equal(ui.field('Vendor').props.value, 'Authored vendor'); assert.equal(ui.calls.filter(call => call[1]).length, 1);
    ui.setProps({ readOnly: true }); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 1); ui.setProps({ readOnly: false }); malformed = false; await ui.submit(); await ui.tick(); const attempts = ui.calls.filter(call => call[1]); assert.equal(attempts.length, 2); assert.deepEqual(attempts[0].slice(0,2), attempts[1].slice(0,2)); assert.equal(attempts[1][3], true); assert.match(ui.html(), /Accepted vendor: Authored vendor/);
  }
});

test('edit entry requires a committed callback, matching active account, explicit read and update grants and a nondeleted product', async () => {
  const opened = [], callback = (...args) => opened.push(args);
  for (const mode of ['allowed', 'no-callback', 'no-update', 'missing-read', 'missing-update', 'deleted']) {
    const selectedStore = writeStore(); if (mode === 'no-update') selectedStore.capabilities = ['products.read']; if (mode.startsWith('missing-')) selectedStore.missingCapabilities = [mode === 'missing-read' ? 'products.read' : 'products.update'];
    const selectedProduct = { ...product(), ...(mode === 'deleted' ? { status: 'deleted' } : {}) }, ui = await browser(async path => path.endsWith('/store') ? { store: selectedStore } : page([selectedProduct]), accounts, { onEdit: mode === 'no-callback' ? undefined : callback });
    await ui.change('Shopify account', accounts[0].id); ui.submit(); await ui.tick();
    if (mode !== 'allowed') { assert.doesNotMatch(ui.html(), /Edit product/); continue; }
    const retained = ui.button('Edit product Provider product').props.onClick;
    await ui.click('Edit product Provider product'); assert.deepEqual(opened.at(-1), [accounts[0], selectedStore, selectedProduct]);
    ui.setProps({ onEdit: undefined }); retained(); assert.equal(opened.length, 1);
    ui.setProps({ onEdit: callback }); retained(); assert.equal(opened.length, 1, 'A callback withdrawn and restored does not revive its old event.');
    ui.discardProps({ onEdit: undefined }); await ui.click('Edit product Provider product'); assert.equal(opened.length, 2, 'An abandoned render cannot withdraw the committed callback.');
    await ui.change('Shopify account', accounts[1].id); await ui.change('Shopify account', accounts[0].id); retained(); assert.equal(opened.length, 2);
  }
});

test('product editor loads fresh content into the real shared native controls and keeps HTML inert in review', async () => {
  const ui = await editor(); assert.equal(ui.calls[0][0], 'products/shop%2Fa/product%2Fa'); assert.equal(ui.field('Product title').type, 'input'); assert.equal(ui.field('Description HTML').type, 'textarea'); assert.equal(ui.field('Description HTML').props.value, product().descriptionHtml);
  await reviewUpdate(ui, '<img src="https://never.example/edited"><script>raw()</script>');
  const html = ui.html(); assert.match(html, /Review Shopify product update|Native product product\/a/); assert.match(html, /Before.*Provider product.*After.*Updated title/); assert.match(html, /live storefront immediately/); assert.match(html, /&lt;script&gt;raw\(\)&lt;\/script&gt;/); assert.doesNotMatch(html, /<img|<script|<iframe|<a\s/);
  await ui.change('Description HTML', '<p>Newer edits</p>'); assert.doesNotMatch(ui.html(), /Review Shopify product update/); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
});

test('only changed selected product fields are sent and receipt validation happens before release with canonical HTML displayed', async () => {
  for (const selected of ['title', 'html', 'both']) {
    const events = [], ui = await editor(async (path, body, validate) => {
      if (!body) return editDetail();
      assert.equal(path, 'products/shop%2Fa/product%2Fa/update'); assert.equal(typeof validate, 'function'); const result = updateReceipt({ ...product(), ...(selected !== 'html' ? { title: 'Updated title' } : {}), ...(selected !== 'title' ? { descriptionHtml: '<p>Canonical HTML</p>' } : {}) }); validate(result); events.push('validated-before-key-release'); return result;
    });
    if (selected !== 'html') await ui.change('Product title', '  Updated title  '); if (selected !== 'title') await ui.change('Description HTML', ' <p>Submitted HTML</p> ');
    await ui.click('Review product changes'); await ui.tick(); ui.confirm(); await ui.submit(); await ui.tick();
    const [path, body] = ui.calls.find(call => call[1]); assert.deepEqual(body, { version: 'product-version', confirmUpdate: true, ...(selected !== 'html' ? { title: 'Updated title' } : {}), ...(selected !== 'title' ? { descriptionHtml: ' <p>Submitted HTML</p> ' } : {}) }); assert.equal(events.length, 1);
    assert.match(ui.html(), /Product update confirmed by Shopify readback/); if (selected !== 'title') { assert.match(ui.html(), /Accepted description HTML.*&lt;p&gt;Canonical HTML&lt;\/p&gt;/); assert.equal(ui.field('Description HTML').props.value, ' <p>Submitted HTML</p> ', 'Accepted content never overwrites the authored draft.'); }
    await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 1);
  }
});

test('unavailable HTML stays unselected until explicit replacement and an explicit empty replacement clears it', async () => {
  const unknown = { ...product(), descriptionHtml: null };
  for (const replace of [false, true]) {
    const ui = await editor(async () => editDetail(unknown), { product: unknown }); assert.equal(ui.field('Description HTML'), undefined); assert.match(ui.html(), /empty replacement clears the description/);
    if (replace) { await ui.click('Replace unavailable description HTML'); assert.equal(ui.field('Description HTML').type, 'textarea'); assert.equal(ui.field('Description HTML').props.value, ''); } else await ui.change('Product title', 'Updated title');
    await ui.click('Review product changes'); await ui.tick(); ui.confirm(); await ui.submit();
    assert.deepEqual(ui.calls.find(call => call[1])[1], { version: 'product-version', confirmUpdate: true, ...(replace ? { descriptionHtml: '' } : { title: 'Updated title' }) });
  }
});

test('invalid product fields and unchanged drafts fail before a review read or a write', async () => {
  for (const [label, value, expected] of [['Product title', ' ', /Enter a title/], ['Product title', 'bad\nname', /Enter a title/], ['Product title', 'x'.repeat(10001), /10,000/], ['Description HTML', 'x'.repeat(1000001), /1,000,000/], ['Description HTML', 'bad\u0000html', /unsupported control/], [null, '', /Change the product/]]) {
    const ui = await editor(); if (label) await ui.change(label, value); await ui.click('Review product changes'); await ui.tick(); assert.equal(ui.calls.length, 1); assert.match(ui.html(), expected); await ui.submit(); assert.equal(ui.calls.length, 1);
  }
});

test('fresh product version, store and permission changes reject review while retaining authored content', async () => {
  for (const fresh of [editDetail(product(), 'new-version'), { ...editDetail(), product: { ...product(), id: 'different' } }, { ...editDetail(), store: { ...writeStore(), domain: 'different.example' } }, { ...editDetail(), store: { ...writeStore(), missingCapabilities: ['products.update'] } }, { ...editDetail(), product: { ...product(), status: 'deleted' } }]) {
    let initial = true; const ui = await editor(async () => { if (initial) { initial = false; return editDetail(); } return fresh; }); await ui.change('Product title', 'Authored product title'); await ui.click('Review product changes'); await ui.tick(); assert.doesNotMatch(ui.html(), /Review Shopify product update/); assert.equal(ui.field('Product title').props.value, 'Authored product title'); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
  }
  for (const result of [new Error('No store access'), { ...editDetail(), version: null }, { ...editDetail(), store: { ...writeStore(), accountId: 'other' } }]) {
    const ui = await editor(async () => { if (result instanceof Error) throw result; return result; }); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true); await ui.button('Review product changes').props.onClick(); await ui.submit(); assert.equal(ui.calls.length, 1);
  }
});

test('retained review, confirmation and save events cannot bypass role, scopes, account changes, edits or withdrawn confirmation', async () => {
  for (const mode of ['read-only', 'inactive', 'reconnect', 'scope', 'deleted', 'edit', 'unconfirm', 'A-B-A']) {
    const ui = await editor(); await reviewUpdate(ui); const retained = ui.find(node => node.type === 'form').props.onSubmit, confirmation = ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange;
    if (mode === 'read-only') ui.setProps({ readOnly: true }); if (mode === 'inactive') ui.setProps({ account: { ...accounts[0], isActive: false } }); if (mode === 'reconnect') ui.setProps({ account: { ...accounts[0], needsReconnection: true } }); if (mode === 'scope') ui.setProps({ store: { ...writeStore(), missingCapabilities: ['products.update'] } }); if (mode === 'deleted') ui.setProps({ product: { ...product(), status: 'deleted' } }); if (mode === 'edit') await ui.change('Description HTML', '<p>Newer edits</p>'); if (mode === 'unconfirm') ui.confirm(false); if (mode === 'A-B-A') { ui.setProps({ readOnly: true }); ui.setProps({ readOnly: false }); }
    if (!['edit', 'unconfirm'].includes(mode)) confirmation({ target: { checked: true } }); await retained({ preventDefault() {} }); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0, mode); assert.equal(ui.field('Product title').props.value, '  Updated title  ');
  }
  const ui = await editor(async (path, body) => body ? updateReceipt() : editDetail()); await reviewUpdate(ui); ui.discardProps({ readOnly: true }); await ui.submit(); await ui.tick(); assert.match(ui.html(), /Product update confirmed/);
});

test('independent malformed receipt validation preserves the original body for deliberate uncertain recovery without automatic retry', async () => {
  for (const validateInRequest of [false, true]) for (const mutate of [r => { r.accountId = 'other'; }, r => { r.product.id = 'other'; }, r => { r.product.title = 'Wrong accepted title'; }, r => { r.product.descriptionHtml = null; }, r => { r.store.domain = 'different.example'; }, r => { r.readback = false; }, r => { r.operation.status = 'pending'; }, r => { r.operation.id = ''; }]) {
    let malformed = true; const ui = await editor(async (path, body, validate) => { if (!body) return editDetail(); const result = updateReceipt(); if (malformed) mutate(result); if (validateInRequest) validate(result); return result; }); await reviewUpdate(ui); await ui.submit(); await ui.tick();
    assert.match(ui.html(), /outcome is unknown/); assert.doesNotMatch(ui.html(), /Product update confirmed/); assert.equal(ui.field('Product title').props.value, '  Updated title  '); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true); assert.equal(ui.calls.filter(call => call[1]).length, 1);
    malformed = false; await ui.submit(); await ui.tick(); const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 2); assert.equal(writes[0][0], writes[1][0]); assert.deepEqual(writes[0][1], writes[1][1]); assert.match(ui.html(), /Product update confirmed/);
  }
});

test('pending receipts survive access withdrawal, and late resource reads cannot populate another product', async () => {
  const pending = deferred(), ui = await editor(async (path, body) => body ? pending.promise : editDetail()); await reviewUpdate(ui); const write = ui.submit(); ui.setProps({ readOnly: true }); assert.equal(ui.field('Description HTML').props.value, ' <p>Submitted HTML</p> '); pending.resolve(updateReceipt()); await write; await ui.tick(); assert.match(ui.html(), /Product update confirmed/); assert.equal(ui.field('Description HTML').props.value, ' <p>Submitted HTML</p> ');
  const reads = [], changing = await editor(async () => { reads.push(deferred()); return reads.at(-1).promise; }); changing.setProps({ product: product('product/b') }); await changing.tick(); changing.setProps({ product: product() }); await changing.tick(); reads[0].resolve(editDetail({ ...product(), title: 'STALE A' })); reads[1].resolve(editDetail({ ...product('product/b'), title: 'STALE B' })); await changing.tick(); assert.equal(changing.field('Product title').props.value, ''); reads[2].resolve(editDetail({ ...product(), title: 'Fresh product' })); await changing.tick(); assert.equal(changing.field('Product title').props.value, 'Fresh product');
});

test('read-only and ungranted editor props never read or mutate a product', async () => {
  for (const props of [{ readOnly: true }, { account: { ...accounts[0], isActive: false } }, { store: store() }, { store: { ...writeStore(), missingCapabilities: ['products.read'] } }, { product: { ...product(), status: 'deleted' } }]) { const ui = await editor(async () => assert.fail('Unwritable editor must not request'), props); assert.equal(ui.calls.length, 0); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true); await ui.button('Review product changes').props.onClick(); await ui.submit(); assert.equal(ui.calls.length, 0); }
});

test('uncertain recovery stays permission gated and reuses the reviewed action after access returns', async () => {
  let failed = true; const ui = await editor(async (path, body) => { if (!body) return editDetail(); if (failed) throw Object.assign(new Error('Provider outcome pending'), { status: 409, code: 'OPERATION_PENDING' }); return updateReceipt(); }); await reviewUpdate(ui); await ui.submit(); await ui.tick();
  const retained = ui.find(node => node.type === 'form').props.onSubmit; ui.setProps({ readOnly: true }); await retained({ preventDefault() {} }); assert.equal(ui.calls.filter(call => call[1]).length, 1);
  ui.setProps({ readOnly: false }); failed = false; await ui.submit(); await ui.tick(); const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 2); assert.deepEqual(writes[0][1], writes[1][1]); assert.match(ui.html(), /Product update confirmed/);
});

test('definitive update rejection keeps edits but requires a new fresh review and confirmation', async () => {
  const ui = await editor(async (path, body) => { if (!body) return editDetail(); throw Object.assign(new Error('Your project access changed.'), { status: 403, code: 'PROJECT_ACCESS_CHANGED' }); }); await reviewUpdate(ui); await ui.submit(); await ui.tick(); assert.match(ui.html(), /Your project access changed/); assert.doesNotMatch(ui.html(), /outcome is unknown|Review Shopify product update|Product update confirmed/); assert.equal(ui.field('Description HTML').props.value, ' <p>Submitted HTML</p> '); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 1);
});

test('an operator-closed uncertain action preserves edits and requires an explicit fresh snapshot and review', async () => {
  let writes = 0, reads = 0; const ui = await editor(async (path, body) => {
    if (path.endsWith('/product%2Fb')) return editDetail({ ...product('product/b'), title: 'Other product' }, 'other-version');
    if (!body) { reads++; return writes < 2 ? editDetail() : editDetail({ ...product(), title: 'Current provider title', descriptionHtml: '<p>Current provider HTML</p>' }, 'fresh-after-operator-review'); }
    writes++; if (writes === 1) throw Object.assign(new Error('Outcome pending'), { status: 409, code: 'OPERATION_PENDING' });
    if (writes === 2) throw Object.assign(new Error('Action closed by operator review.'), { status: 409, code: 'OPERATION_REVIEWED', operation: { id: 'closed-product-operation', status: 'reviewed-failed' } });
    return updateReceipt();
  });
  await reviewUpdate(ui); await ui.submit(); await ui.tick(); assert.match(ui.html(), /outcome is unknown/);
  const closedSubmit = ui.find(node => node.type === 'form').props.onSubmit; await ui.submit(); await ui.tick(); assert.equal(writes, 2); assert.equal(reads, 2, 'Closure never reloads or mutates automatically.'); assert.doesNotMatch(ui.html(), /outcome is unknown|Check the same product update|Review Shopify product update|Product update confirmed/);
  assert.match(ui.html(), /closed-product-operation.*reviewed-failed/); assert.equal(ui.field('Product title').props.value, '  Updated title  '); assert.equal(ui.field('Description HTML').props.value, ' <p>Submitted HTML</p> ');
  assert.ok(ui.button('Refresh current product review'), 'A closed operation leaves a usable explicit refresh path.'); await closedSubmit({ preventDefault() {} }); await ui.submit(); assert.equal(writes, 2);
  ui.setProps({ readOnly: true }); assert.doesNotMatch(ui.html(), /Refresh current product review/); ui.setProps({ readOnly: false }); await ui.click('Refresh current product review'); await ui.tick(); assert.equal(reads, 3); assert.equal(writes, 2); assert.equal(ui.field('Product title').props.value, '  Updated title  '); assert.equal(ui.field('Description HTML').props.value, ' <p>Submitted HTML</p> ');
  await ui.submit(); assert.equal(writes, 2); await ui.click('Review product changes'); await ui.tick(); assert.match(ui.html(), /Before.*Current provider title.*Current provider HTML/); assert.equal(ui.button('Save product changes').props.disabled, true); ui.confirm(); await ui.submit(); await ui.tick(); assert.equal(writes, 3); assert.equal(ui.calls.filter(call => call[1]).at(-1)[1].version, 'fresh-after-operator-review'); assert.match(ui.html(), /Product update confirmed/);
  ui.setProps({ product: product('product/b') }); await ui.tick(); assert.equal(ui.field('Product title').props.value, 'Other product'); assert.doesNotMatch(ui.html(), /closed-product-operation/);
});

const createStore = () => ({ ...store(), capabilities: ['products.read', 'products.create'] });
const creationReview = (version = 'creation-version') => ({ store: createStore(), creationVersion: version });
const creationReceipt = () => ({ accountId: accounts[0].id, store: createStore(), product: { ...product('1001'), title: 'Draft title', descriptionHtml: '<p>Canonical HTML</p>', status: 'draft', platformStatus: 'DRAFT', url: null, publishedAt: null, variants: [{ ...product().variants[0], price: { amount: '0012345678901234567890.12000', currency: 'USD' } }] }, readback: true, operation: { id: 'creation-operation', status: 'complete' } });
const creator = (respond = async (_path, body) => body ? creationReceipt() : creationReview(), props = {}) => browser(respond, accounts, { kind: 'ProductCreator', account: accounts[0], store: createStore(), ...props });
async function reviewCreation(ui) { await ui.change('Product title', '  Draft title  '); await ui.change('Description HTML', ' <img src="https://never.example/new"><script>raw()</script> '); await ui.change('Price in USD', '12345678901234567890.12'); await ui.click('Review draft product'); await ui.tick(); ui.confirm(); }

test('draft entry is permission gated and committed callbacks cannot be revived by stale events', async () => {
  let opened = 0; const onCreate = (account, selectedStore) => { assert.deepEqual(account, accounts[0]); assert.deepEqual(selectedStore, createStore()); opened++; };
  for (const mode of ['allowed', 'no-callback', 'no-create', 'missing-create', 'missing-read']) {
    const selectedStore = createStore(); if (mode === 'no-create') selectedStore.capabilities = ['products.read']; if (mode.startsWith('missing-')) selectedStore.missingCapabilities = [mode === 'missing-read' ? 'products.read' : 'products.create'];
    const ui = await browser(async path => path.endsWith('/store') ? { store: selectedStore } : page(), accounts, { onCreate: mode === 'no-callback' ? undefined : onCreate });
    await ui.change('Shopify account', accounts[0].id); ui.submit(); await ui.tick();
    if (mode !== 'allowed') { assert.doesNotMatch(ui.html(), /New draft product/); continue; }
    const retained = ui.button('New draft product').props.onClick; await ui.click('New draft product'); assert.equal(opened, 1);
    ui.setProps({ onCreate: undefined }); retained(); ui.setProps({ onCreate }); retained(); assert.equal(opened, 1);
    ui.discardProps({ onCreate: undefined }); await ui.click('New draft product'); assert.equal(opened, 2);
    await ui.change('Platform product query', 'changed'); retained(); assert.equal(opened, 2);
  }
});

test('new draft uses native literal fields, fresh store review and one decimal string price with validated canonical receipt', async () => {
  let validations = 0; const ui = await creator(async (_path, body, validate) => { if (!body) return creationReview(); const result = creationReceipt(); validate(result); validations++; return result; });
  assert.equal(ui.calls.length, 0); assert.equal(ui.field('Product title').type, 'input'); assert.equal(ui.field('Description HTML').type, 'textarea'); assert.equal(ui.field('Price in USD').props.type, 'text');
  await reviewCreation(ui); assert.equal(ui.calls.length, 1); assert.equal(ui.calls[0][0], 'products/shop%2Fa/store');
  assert.match(ui.html(), /Review Shopify draft product.*Account shop\/a.*shop.example.*Currency USD/); assert.match(ui.html(), /Single variant price: 12345678901234567890.12 USD/); assert.match(ui.html(), /&lt;script&gt;raw\(\)&lt;\/script&gt;/); assert.doesNotMatch(ui.html(), /<img|<script|<iframe|<a\s/);
  await ui.submit(); await ui.tick(); const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 1); assert.equal(writes[0][0], 'products/shop%2Fa/create');
  assert.deepEqual(writes[0][1], { version: 'creation-version', confirmCreate: true, title: 'Draft title', descriptionHtml: ' <img src="https://never.example/new"><script>raw()</script> ', price: '12345678901234567890.12' }); assert.equal(validations, 1);
  assert.match(ui.html(), /Draft product creation confirmed by Shopify readback.*Native product 1001.*draft.*DRAFT/); assert.match(ui.html(), /Accepted single variant price: 0012345678901234567890.12000 USD/); assert.match(ui.html(), /Accepted description HTML.*&lt;p&gt;Canonical HTML&lt;\/p&gt;/);
  assert.equal(ui.field('Product title').props.value, '  Draft title  '); assert.equal(ui.field('Description HTML').props.value, ' <img src="https://never.example/new"><script>raw()</script> '); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 1);
});

test('creation validates title, literal HTML and decimal input before any fresh review or create request', async () => {
  for (const [label, value, expected] of [['Product title', ' ', /Enter a title/], ['Product title', 'bad\nname', /Enter a title/], ['Product title', 'x'.repeat(10001), /10,000/], ['Description HTML', 'bad\u0000html', /unsupported control/], ['Description HTML', 'x'.repeat(1000001), /1,000,000/], ...['-1', '1e2', '1.001', ' 1.00 ', '1.00\n', '1,00', '.5', '', '1'.repeat(101)].map(value => ['Price in USD', value, /decimal price/])]) {
    const ui = await creator(async () => assert.fail('Invalid draft must not request')); await ui.change('Product title', 'Draft title'); await ui.change('Price in USD', '0.00'); await ui.change(label, value); await ui.click('Review draft product'); await ui.tick(); assert.equal(ui.calls.length, 0); assert.match(ui.html(), expected); await ui.submit(); assert.equal(ui.calls.length, 0);
  }
  const ui = await creator(); await ui.change('Product title', 'Draft title'); await ui.change('Price in USD', '0.00'); await ui.click('Review draft product'); await ui.tick(); ui.confirm(); await ui.submit(); assert.deepEqual(ui.calls.find(call => call[1])[1], { version: 'creation-version', confirmCreate: true, title: 'Draft title', price: '0.00' });
});

test('fresh mismatched stores, permissions and missing creation versions reject review without dropping authored content', async () => {
  for (const fresh of [{ ...creationReview(), creationVersion: null }, { ...creationReview(), store: { ...createStore(), accountId: 'other' } }, { ...creationReview(), store: { ...createStore(), currency: 'AED' } }, { ...creationReview(), store: { ...createStore(), domain: 'other.example' } }, { ...creationReview(), store: { ...createStore(), missingCapabilities: ['products.create'] } }]) {
    const ui = await creator(async () => fresh); await ui.change('Product title', 'Keep draft'); await ui.change('Price in USD', '1.00'); await ui.click('Review draft product'); await ui.tick(); assert.match(ui.html(), /could not be verified/); assert.doesNotMatch(ui.html(), /Review Shopify draft product/); assert.equal(ui.field('Product title').props.value, 'Keep draft'); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
  }
});

test('stale draft creation events cannot bypass changed content, access, account or confirmation', async () => {
  for (const mode of ['read-only', 'inactive', 'scope', 'edit', 'unconfirm', 'A-B-A']) {
    const ui = await creator(); await reviewCreation(ui); const retained = ui.find(node => node.type === 'form').props.onSubmit, confirm = ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange;
    if (mode === 'read-only') ui.setProps({ readOnly: true }); if (mode === 'inactive') ui.setProps({ account: { ...accounts[0], isActive: false } }); if (mode === 'scope') ui.setProps({ store: { ...createStore(), missingCapabilities: ['products.create'] } }); if (mode === 'edit') await ui.change('Product title', 'Newer draft'); if (mode === 'unconfirm') ui.confirm(false); if (mode === 'A-B-A') { ui.setProps({ readOnly: true }); ui.setProps({ readOnly: false }); }
    if (!['edit', 'unconfirm'].includes(mode)) confirm({ target: { checked: true } }); await retained({ preventDefault() {} }); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0, mode); assert.equal(ui.field('Product title').props.value, mode === 'edit' ? 'Newer draft' : '  Draft title  ');
  }
  for (const props of [{ readOnly: true }, { account: { ...accounts[0], needsReconnection: true } }, { store: store() }]) { const ui = await creator(async () => assert.fail('Unwritable creation cannot request'), props); await ui.button('Review draft product').props.onClick(); await ui.submit(); assert.equal(ui.calls.length, 0); }
});

test('malformed creation receipts retain the exact original action for explicit permission gated recovery', async () => {
  for (const validateInRequest of [false, true]) for (const mutate of [r => { r.accountId = 'other'; }, r => { r.product.id = ''; }, r => { r.product.id = 'bad\u0000id'; }, r => { r.product.title = 'Wrong title'; }, r => { r.product.status = 'active'; }, r => { r.product.platformStatus = 'ACTIVE'; }, r => { r.product.url = 'https://shop.example/products/new'; }, r => { r.product.publishedAt = '2026-10-19T00:00:00Z'; }, r => { r.product.variants[0].price.amount = '12345678901234567890.13'; }, r => { r.product.variants[0].price.currency = 'AED'; }, r => { r.product.variants.push(r.product.variants[0]); }, r => { r.product.descriptionHtml = null; }, r => { r.store.domain = 'other.example'; }, r => { r.readback = false; }, r => { r.operation.status = 'pending'; }]) {
    let malformed = true; const ui = await creator(async (_path, body, validate) => { if (!body) return creationReview(); const result = creationReceipt(); if (malformed) mutate(result); if (validateInRequest) validate(result); return result; });
    await reviewCreation(ui); await ui.submit(); await ui.tick(); assert.match(ui.html(), /outcome is unknown/); assert.doesNotMatch(ui.html(), /creation confirmed/); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true); assert.equal(ui.calls.filter(call => call[1]).length, 1);
    const retained = ui.find(node => node.type === 'form').props.onSubmit; ui.setProps({ readOnly: true }); await retained({ preventDefault() {} }); assert.equal(ui.calls.filter(call => call[1]).length, 1); ui.setProps({ readOnly: false }); malformed = false;
    await ui.submit(); await ui.tick(); const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 2); assert.deepEqual(writes[0].slice(0, 2), writes[1].slice(0, 2)); assert.match(ui.html(), /Draft product creation confirmed/);
  }
});

test('operator closure preserves the creation draft and requires explicit fresh store review and confirmation', async () => {
  let writes = 0, reads = 0; const ui = await creator(async (_path, body) => { if (!body) { reads++; return creationReview(writes > 1 ? 'after-closure' : 'original-version'); } writes++; if (writes === 1) throw Object.assign(new Error('Pending outcome'), { status: 409, code: 'OPERATION_PENDING' }); if (writes === 2) throw Object.assign(new Error('Closed by operator review'), { status: 409, code: 'OPERATION_REVIEWED', operation: { id: 'closed-create', status: 'reviewed-failed' } }); return creationReceipt(); });
  await reviewCreation(ui); await ui.submit(); await ui.tick(); const retained = ui.find(node => node.type === 'form').props.onSubmit; await ui.submit(); await ui.tick(); assert.equal(reads, 1); assert.equal(writes, 2); assert.match(ui.html(), /closed-create.*reviewed-failed/); assert.doesNotMatch(ui.html(), /outcome is unknown|Review Shopify draft product/); assert.equal(ui.field('Product title').props.value, '  Draft title  ');
  await retained({ preventDefault() {} }); await ui.submit(); assert.equal(writes, 2); await ui.click('Review draft product'); await ui.tick(); assert.equal(reads, 2); assert.equal(ui.button('Create draft product').props.disabled, true); ui.confirm(); await ui.submit(); await ui.tick(); assert.equal(writes, 3); assert.equal(ui.calls.filter(call => call[1]).at(-1)[1].version, 'after-closure'); assert.match(ui.html(), /Draft product creation confirmed/);
});

test('late creation reviews and receipts cannot overwrite another destination or revive withdrawn review access', async () => {
  const heldRead = deferred(), ui = await creator(async () => heldRead.promise); await ui.change('Product title', 'Keep draft'); await ui.change('Price in USD', '1.00'); const reviewing = ui.click('Review draft product'); ui.setProps({ readOnly: true }); heldRead.resolve(creationReview()); await reviewing; await ui.tick(); assert.doesNotMatch(ui.html(), /Review Shopify draft product/); assert.equal(ui.field('Product title').props.value, 'Keep draft');
  const pending = deferred(), changing = await creator(async (_path, body) => body ? pending.promise : creationReview()); await reviewCreation(changing); const write = changing.submit(); changing.setProps({ account: accounts[1], store: { ...createStore(), accountId: accounts[1].id } }); await changing.tick(); await changing.change('Product title', 'Newer destination draft'); pending.resolve(creationReceipt()); await write; await changing.tick(); assert.doesNotMatch(changing.html(), /creation confirmed/); assert.equal(changing.field('Product title').props.value, 'Newer destination draft');
});

const priceStore = () => ({ ...store(), capabilities: ['products.read', 'products.price'] });
const priceProduct = (id = '501') => ({ ...product(id), variants: [{ ...product().variants[0], id: '101' }, { ...product().variants[0], id: '102', title: '<Large>', price: { amount: '00029.9900', currency: 'USD' } }] });
const priceDetail = (row = priceProduct(), version = 'price-version') => ({ product: row, store: priceStore(), version });
const priceReceipt = () => ({ accountId: accounts[0].id, store: priceStore(), product: { ...priceProduct(), variants: [priceProduct().variants[0], { ...priceProduct().variants[1], price: { amount: '0012345678901234567890.12000', currency: 'USD' } }] }, readback: true, operation: { id: 'price-operation', status: 'complete' } });
const priceEditor = (respond = async (_path, body) => body ? priceReceipt() : priceDetail(), props = {}) => browser(respond, accounts, { kind: 'ProductPriceEditor', account: accounts[0], store: priceStore(), product: priceProduct(), ...props });
async function reviewPrice(ui) { await ui.change('Product variant', '102'); await ui.change('New price in USD', '12345678901234567890.12'); await ui.click('Review price change'); await ui.tick(); ui.confirm(); }

test('price entry requires its own grant and committed callback independently of content editing', async () => {
  let opened = 0; const onPrice = (account, selectedStore, row) => { assert.deepEqual(account, accounts[0]); assert.deepEqual(selectedStore, priceStore()); assert.deepEqual(row, priceProduct()); opened++; };
  for (const mode of ['allowed', 'no-callback', 'content-only', 'missing-price', 'missing-read', 'deleted']) {
    const selectedStore = mode === 'content-only' ? writeStore() : priceStore(); if (mode.startsWith('missing-')) selectedStore.missingCapabilities = [mode === 'missing-read' ? 'products.read' : 'products.price']; const selectedProduct = { ...priceProduct(), ...(mode === 'deleted' ? { status: 'deleted' } : {}) };
    const ui = await browser(async path => path.endsWith('/store') ? { store: selectedStore } : path.includes('?') ? page([selectedProduct]) : detail(selectedProduct), accounts, { onPrice: mode === 'no-callback' ? undefined : onPrice }); await ui.change('Shopify account', accounts[0].id); ui.submit(); await ui.tick();
    if (mode !== 'allowed') { assert.doesNotMatch(ui.html(), /Edit price/); continue; }
    assert.doesNotMatch(ui.html(), /Edit product/); const retained = ui.button('Edit price Provider product').props.onClick; await ui.click('Edit price Provider product'); assert.equal(opened, 1);
    ui.setProps({ onPrice: undefined }); retained(); ui.setProps({ onPrice }); retained(); assert.equal(opened, 1); ui.discardProps({ onPrice: undefined }); await ui.click('Edit price Provider product'); assert.equal(opened, 2);
    await ui.click('Read Provider product'); await ui.tick(); await ui.click('Edit price Provider product'); assert.equal(opened, 3); await ui.change('Product status', 'draft'); retained(); assert.equal(opened, 3);
  }
});

test('price editor freshly loads one product, explicitly selects a returned variant and confirms only its decimal string price', async () => {
  let validations = 0; const ui = await priceEditor(async (path, body, validate) => { if (!body) return priceDetail(); assert.equal(path, 'products/shop%2Fa/501/price'); const receipt = priceReceipt(); validate(receipt); validations++; return receipt; });
  assert.equal(ui.calls[0][0], 'products/shop%2Fa/501'); assert.equal(ui.field('Product variant').type, 'select'); assert.equal(ui.field('Product variant').props.value, ''); assert.equal(ui.field('New price in USD').props.type, 'text'); assert.match(ui.html(), /first 100 variants.*partial list/); assert.doesNotMatch(ui.html(), /<img|<script|<iframe|<a\s/);
  await reviewPrice(ui); assert.equal(ui.calls.length, 2); assert.match(ui.html(), /Review Shopify variant price.*Account shop\/a.*shop.example.*Native product 501.*Native variant 102.*&lt;Large&gt;/); assert.match(ui.html(), /Before.*00029.9900 USD.*After.*12345678901234567890.12 USD/); assert.match(ui.html(), /live storefront immediately/); assert.equal(ui.button('Save variant price').props.disabled, false);
  await ui.submit(); await ui.tick(); assert.deepEqual(ui.calls.find(call => call[1])[1], { version: 'price-version', confirmPrice: true, variantId: '102', price: '12345678901234567890.12' }); assert.equal(validations, 1); assert.match(ui.html(), /Variant price confirmed by Shopify readback.*Native product 501.*Native variant 102/); assert.match(ui.html(), /Accepted price: 0012345678901234567890.12000 USD/); assert.equal(ui.field('New price in USD').props.value, '12345678901234567890.12'); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 1);
});

test('price review rejects absent or unknown variants, unchanged values, and invalid decimal strings before any fresh request', async () => {
  for (const invalid of ['', '-1', '+1', '1e2', '1.001', ' 1.00', '1.00 ', '1.00\n', '1.00\r\n', '1.0\u0000', '1,00', '.5', '1'.repeat(101), '29.99']) {
    const ui = await priceEditor(); await ui.change('Product variant', '102'); await ui.change('New price in USD', invalid); await ui.click('Review price change'); await ui.tick(); assert.equal(ui.calls.length, 1); assert.match(ui.html(), invalid === '29.99' ? /Change the selected variant price/ : /decimal price/); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
  }
  for (const id of ['', 'outside-coverage']) { const ui = await priceEditor(); await ui.change('Product variant', id); await ui.change('New price in USD', '1.00'); await ui.click('Review price change'); await ui.tick(); assert.match(ui.html(), /Choose a returned variant/); assert.equal(ui.calls.length, 1); }
  const empty = await priceEditor(async () => priceDetail({ ...priceProduct(), variants: [] })); assert.match(empty.html(), /No variants returned within provider coverage/);
});

test('unverified price snapshots, inactive accounts and missing price grants cannot reach a mutation', async () => {
  for (const invalid of [{ ...priceDetail(), version: null }, priceDetail({ ...priceProduct(), id: 'other' }), { ...priceDetail(), store: { ...priceStore(), currency: 'AED' } }, { ...priceDetail(), store: { ...priceStore(), missingCapabilities: ['products.price'] } }, priceDetail({ ...priceProduct(), variants: [priceProduct().variants[0], priceProduct().variants[0]] }), priceDetail({ ...priceProduct(), variants: [{ ...priceProduct().variants[0], id: 'bad\u0000id' }] }), priceDetail({ ...priceProduct(), variants: [{ ...priceProduct().variants[0], price: { amount: '1.00\n', currency: 'USD' } }] })]) {
    const ui = await priceEditor(async () => invalid); assert.match(ui.html(), /could not be verified/); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true); await ui.button('Review price change').props.onClick(); await ui.submit(); assert.equal(ui.calls.length, 1);
  }
  for (const props of [{ readOnly: true }, { account: { ...accounts[0], isActive: false } }, { account: { ...accounts[0], needsReconnection: true } }, { store: writeStore() }, { store: { ...priceStore(), missingCapabilities: ['products.read'] } }, { product: { ...priceProduct(), status: 'deleted' } }]) { const ui = await priceEditor(async () => assert.fail('No access must not request'), props); await ui.button('Review price change').props.onClick(); await ui.submit(); assert.equal(ui.calls.length, 0); }
});

test('price confirmation and submit events cannot survive edited values, variants, revoked access or A to B to A roles', async () => {
  for (const mode of ['price', 'variant', 'read-only', 'inactive', 'scope', 'deleted', 'unconfirm', 'A-B-A']) {
    const ui = await priceEditor(); await reviewPrice(ui); const retained = ui.find(node => node.type === 'form').props.onSubmit, confirm = ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange;
    if (mode === 'price') await ui.change('New price in USD', '8.00'); if (mode === 'variant') await ui.change('Product variant', '101'); if (mode === 'read-only') ui.setProps({ readOnly: true }); if (mode === 'inactive') ui.setProps({ account: { ...accounts[0], isActive: false } }); if (mode === 'scope') ui.setProps({ store: { ...priceStore(), missingCapabilities: ['products.price'] } }); if (mode === 'deleted') ui.setProps({ product: { ...priceProduct(), status: 'deleted' } }); if (mode === 'unconfirm') ui.confirm(false); if (mode === 'A-B-A') { ui.setProps({ readOnly: true }); ui.setProps({ readOnly: false }); }
    if (!['price', 'variant', 'unconfirm'].includes(mode)) confirm({ target: { checked: true } }); await retained({ preventDefault() {} }); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0, mode); assert.equal(ui.field('New price in USD').props.value, mode === 'price' ? '8.00' : '12345678901234567890.12');
  }
  const ui = await priceEditor(); await reviewPrice(ui); ui.discardProps({ readOnly: true }); await ui.submit(); await ui.tick(); assert.match(ui.html(), /Variant price confirmed/);
});

test('a changed product review and explicit refresh retain authored price while requiring a current version and confirmation', async () => {
  let current = false; const ui = await priceEditor(async (_path, body) => body ? priceReceipt() : priceDetail(undefined, current ? 'fresh-version' : 'price-version')); await ui.change('Product variant', '102'); await ui.change('New price in USD', '12345678901234567890.12'); current = true; await ui.click('Review price change'); await ui.tick(); assert.match(ui.html(), /product changed on Shopify/); assert.doesNotMatch(ui.html(), /Review Shopify variant price/); assert.equal(ui.field('New price in USD').props.value, '12345678901234567890.12');
  await ui.click('Refresh current product prices'); await ui.tick(); assert.equal(ui.field('Product variant').props.value, '102'); assert.equal(ui.field('New price in USD').props.value, '12345678901234567890.12'); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0); await ui.click('Review price change'); await ui.tick(); assert.equal(ui.button('Save variant price').props.disabled, true); ui.confirm(); await ui.submit(); await ui.tick(); assert.equal(ui.calls.find(call => call[1])[1].version, 'fresh-version'); assert.match(ui.html(), /Variant price confirmed/);
});

test('independently rejected price receipts keep the original selected variant and request for explicit permission gated recovery', async () => {
  for (const validateInRequest of [false, true]) for (const mutate of [r => { r.accountId = 'other'; }, r => { r.product.id = 'other'; }, r => { r.product.status = 'deleted'; }, r => { r.store.domain = 'other.example'; }, r => { r.product.variants[1].id = 'different'; }, r => { r.product.variants[1].price.currency = 'AED'; }, r => { r.product.variants[1].price.amount = '12345678901234567890.13'; }, r => { r.product.variants[1].price.amount += '\n'; }, r => { r.product.variants.push(r.product.variants[1]); }, r => { r.readback = false; }, r => { r.operation.status = 'pending'; }, r => { r.operation.id = ''; }]) {
    let malformed = true; const ui = await priceEditor(async (_path, body, validate) => { if (!body) return priceDetail(); const result = priceReceipt(); if (malformed) mutate(result); if (validateInRequest) validate(result); return result; }); await reviewPrice(ui); await ui.submit(); await ui.tick(); assert.match(ui.html(), /outcome is unknown/); assert.doesNotMatch(ui.html(), /Variant price confirmed/); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true); assert.equal(ui.calls.filter(call => call[1]).length, 1);
    const retained = ui.find(node => node.type === 'form').props.onSubmit; ui.setProps({ readOnly: true }); await retained({ preventDefault() {} }); assert.equal(ui.calls.filter(call => call[1]).length, 1); ui.setProps({ readOnly: false }); malformed = false; await ui.submit(); await ui.tick(); const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 2); assert.deepEqual(writes[0].slice(0, 2), writes[1].slice(0, 2)); assert.match(ui.html(), /Variant price confirmed/);
  }
});

test('operator closure requires an explicit product price refresh and fresh review while retaining authored price and variant', async () => {
  let writes = 0, reads = 0; const ui = await priceEditor(async (_path, body) => { if (!body) { reads++; return priceDetail(undefined, writes > 1 ? 'after-price-closure' : 'price-version'); } writes++; if (writes === 1) throw Object.assign(new Error('Pending price outcome'), { status: 409, code: 'OPERATION_PENDING' }); if (writes === 2) throw Object.assign(new Error('Closed price action'), { status: 409, code: 'OPERATION_REVIEWED', operation: { id: 'closed-price', status: 'reviewed-failed' } }); return priceReceipt(); });
  await reviewPrice(ui); await ui.submit(); await ui.tick(); const retained = ui.find(node => node.type === 'form').props.onSubmit; await ui.submit(); await ui.tick(); assert.equal(reads, 2); assert.equal(writes, 2); assert.match(ui.html(), /closed-price.*reviewed-failed/); assert.doesNotMatch(ui.html(), /outcome is unknown|Review Shopify variant price|Variant price confirmed/); assert.equal(ui.field('New price in USD').props.value, '12345678901234567890.12');
  await retained({ preventDefault() {} }); await ui.submit(); assert.equal(writes, 2); await ui.click('Refresh current product prices'); await ui.tick(); assert.equal(reads, 3); assert.equal(ui.field('Product variant').props.value, '102'); assert.equal(ui.field('New price in USD').props.value, '12345678901234567890.12'); await ui.click('Review price change'); await ui.tick(); assert.equal(reads, 4); assert.equal(ui.button('Save variant price').props.disabled, true); ui.confirm(); await ui.submit(); await ui.tick(); assert.equal(writes, 3); assert.equal(ui.calls.filter(call => call[1]).at(-1)[1].version, 'after-price-closure'); assert.match(ui.html(), /Variant price confirmed/);
});

test('late product reads and price receipts cannot replace a newer destination draft', async () => {
  const reads = [], ui = await priceEditor(async () => { reads.push(deferred()); return reads.at(-1).promise; }); ui.setProps({ product: priceProduct('502') }); await ui.tick(); ui.setProps({ product: priceProduct() }); await ui.tick(); reads[0].resolve(priceDetail({ ...priceProduct(), title: 'STALE A' })); reads[1].resolve(priceDetail(priceProduct('502'))); await ui.tick(); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true); reads[2].resolve(priceDetail()); await ui.tick(); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, false); assert.doesNotMatch(ui.html(), /STALE A/);
  const pending = deferred(), changing = await priceEditor(async (path, body) => body ? pending.promise : priceDetail(priceProduct(path.endsWith('/502') ? '502' : '501'))); await reviewPrice(changing); const write = changing.submit(); changing.setProps({ product: priceProduct('502') }); await changing.tick(); await changing.change('Product variant', '102'); await changing.change('New price in USD', '88.00'); pending.resolve(priceReceipt()); await write; await changing.tick(); assert.doesNotMatch(changing.html(), /Variant price confirmed/); assert.equal(changing.field('New price in USD').props.value, '88.00');
});

const stockStore = (id = accounts[0].id) => ({ ...store(id), capabilities: ['products.read', 'inventory.read'] });
const stockCoverage = { ...coverage, inventoryComplete: null, locationsComplete: null, localLocationsLimit: 1000, localInventoryItemsLimit: 10000, localInventoryLevelsLimit: 10000 };
const stockResponse = (id = '501') => ({ accountId: accounts[0].id, product: priceProduct(id), store: stockStore(), locations: [{ id: '901', name: '<Warehouse>', isActive: true, fulfillsOnlineOrders: false, address: { line1: '<img src="https://never.example/address" onerror="bad()">', line2: null, city: '<script>bad()</script>', region: null, postalCode: '00001', countryCode: 'US', phone: 'javascript:bad()' } }, { id: '903', name: null, isActive: null, fulfillsOnlineOrders: null, address: null }], inventory: [{ productId: id, variantId: '101', sku: '<sku>', tracked: true, levels: [{ locationId: '901', available: 0, onHand: -3, committed: 2, incoming: null }, { locationId: '902', available: 5, onHand: 7, committed: -1, incoming: 3 }] }, { productId: id, variantId: '102', sku: null, tracked: false, levels: null }, { productId: id, variantId: '999', sku: 'OUTSIDE-FIRST-100', tracked: null, levels: [] }], coverage: { ...stockCoverage } });
async function stockBrowser(respond = async () => stockResponse(), selectedStore = stockStore(), initial = {}) {
  const ui = await browser(async path => path.endsWith('/inventory') ? respond(path) : path.endsWith('/store') ? { store: selectedStore } : path.includes('?') ? page([priceProduct()]) : detail(priceProduct()), accounts, initial); await ui.change('Shopify account', accounts[0].id); ui.submit(); await ui.tick(); await ui.click('Read Provider product'); await ui.tick(); return ui;
}

test('stock and locations load only after explicit detail action and show returned quantities, unknown coverage and inert native text', async () => {
  const ui = await stockBrowser(); assert.equal(ui.calls.filter(call => call[0].endsWith('/inventory')).length, 0); assert.ok(ui.button('Load stock and locations')); await ui.click('Load stock and locations'); await ui.tick(); assert.equal(ui.calls.at(-1)[0], 'products/shop%2Fa/501/inventory'); assert.ok(ui.calls.every(call => call.length === 1), 'All stock, catalog and detail requests are reads.');
  const html = ui.html(); assert.match(html, /Returned rows only.*Inventory completeness: unknown.*Location completeness: unknown/); assert.match(html, /Loaded at .*browser time.*Provider freshness is unknown/); assert.match(html, /Available<\/th><th>On hand<\/th><th>Committed<\/th><th>Incoming/); assert.match(html, /<td>0<\/td><td>-3<\/td><td>2<\/td><td>Unknown<\/td>/); assert.match(html, /<td>902<\/td><td>Location name not returned<\/td><td>5<\/td><td>7<\/td><td>-1<\/td><td>3<\/td>/);
  assert.match(html, /Native variant 999.*Variant name not returned within product coverage.*OUTSIDE-FIRST-100.*Tracking unknown/); assert.match(html, /Native variant 102.*Untracked.*Location levels unknown/); assert.match(html, /No location level rows returned.*Inventory completeness is unknown/); assert.match(html, /Name not returned.*Unknown.*Unknown.*Address unknown/); assert.match(html, /&lt;Warehouse&gt;|&lt;sku&gt;|&lt;script&gt;bad\(\)&lt;\/script&gt;/); assert.doesNotMatch(html, /<img|<script|<iframe|<a\s|Adjust stock|Save stock|Fresh stock|Stock is current/); assert.ok(ui.button('Refresh stock and locations'));
});

test('stock reading needs explicit product and inventory read grants but no content or price write callbacks', async () => {
  for (const selectedStore of [store(), writeStore(), priceStore(), { ...stockStore(), missingCapabilities: ['inventory.read'] }, { ...stockStore(), missingCapabilities: ['products.read'] }]) { const ui = await stockBrowser(async () => assert.fail('No stock read without grants'), selectedStore); assert.doesNotMatch(ui.html(), /Load stock and locations|Refresh stock and locations/); assert.match(ui.html(), /product read and inventory read permissions/); assert.equal(ui.calls.filter(call => call[0].endsWith('/inventory')).length, 0); }
  const ui = await stockBrowser(); assert.doesNotMatch(ui.html(), /Edit product|Edit price|New draft product/); await ui.click('Load stock and locations'); await ui.tick(); assert.match(ui.html(), /Returned inventory/);
});

test('stock refresh clears old rows during loading and failures leave errors instead of stale current or false empty data', async () => {
  let mode = 'success', hold; const ui = await stockBrowser(async () => { if (mode === 'hold') return hold.promise; if (mode === 'limited') throw Object.assign(new Error('Rate limit'), { status: 429 }); if (mode === 'denied') throw Object.assign(new Error('Inventory permission changed. Refresh this store connection.'), { status: 403, code: 'INVENTORY_READ_PERMISSION_REQUIRED' }); if (mode === 'failed') throw new Error('Stock provider failed'); return stockResponse(); }); await ui.click('Load stock and locations'); await ui.tick(); assert.match(ui.html(), /OUTSIDE-FIRST-100/);
  mode = 'hold'; hold = deferred(); const refreshing = ui.click('Refresh stock and locations'); assert.doesNotMatch(ui.html(), /OUTSIDE-FIRST-100|Returned inventory|Loaded at/); assert.equal(ui.button('Loading stock and locations…').props.disabled, true); hold.reject(new Error('Stock provider failed')); await refreshing; await ui.tick(); assert.match(ui.html(), /Stock provider failed/); assert.doesNotMatch(ui.html(), /OUTSIDE-FIRST-100|No inventory rows returned|Loaded at/);
  for (const [next, expected] of [['limited', /rate limited/], ['denied', /Inventory permission changed/], ['failed', /Stock provider failed/]]) { mode = next; await ui.click('Load stock and locations'); await ui.tick(); assert.match(ui.html(), expected); assert.doesNotMatch(ui.html(), /No inventory rows returned|No location rows returned|OUTSIDE-FIRST-100/); }
});

test('stock responses independently reject wrong scope, permissions, malformed nullable fields, duplicate native IDs and nonintegers', async () => {
  for (const mutate of [r => { r.accountId = 'other'; }, r => { r.product.id = 'other'; }, r => { r.store.domain = 'other.example'; }, r => { r.store.missingCapabilities = ['inventory.read']; }, r => { r.coverage.inventoryComplete = true; }, r => { delete r.coverage.locationsComplete; }, r => { delete r.inventory; }, r => { r.locations = null; }, r => { r.locations[0].id = 'bad\u0000id'; }, r => { r.locations[0].name = 5; }, r => { r.locations[0].isActive = 'yes'; }, r => { r.locations[0].address.city = 5; }, r => { r.locations.push(r.locations[0]); }, r => { r.inventory[0].productId = 'other'; }, r => { r.inventory[0].variantId = ''; }, r => { r.inventory[0].tracked = 'unknown'; }, r => { delete r.inventory[0].levels; }, r => { r.inventory[0].levels[0].available = 1.5; }, r => { r.inventory[0].levels[0].onHand = Number.MAX_SAFE_INTEGER + 1; }, r => { delete r.inventory[0].levels[0].incoming; }, r => { r.inventory[0].levels[0].locationId = 'bad/id'; }, r => { r.inventory[0].levels.push(r.inventory[0].levels[0]); }, r => { r.inventory.push(r.inventory[0]); }]) {
    const ui = await stockBrowser(async () => { const result = stockResponse(); mutate(result); return result; }); await ui.click('Load stock and locations'); await ui.tick(); assert.match(ui.html(), /could not be verified/); assert.doesNotMatch(ui.html(), /Returned inventory|OUTSIDE-FIRST-100|No inventory rows returned|Loaded at/);
  }
});

test('verified empty stock lists remain distinct from null levels and never imply a complete empty store', async () => {
  const ui = await stockBrowser(async () => ({ ...stockResponse(), locations: [], inventory: [] })); await ui.click('Load stock and locations'); await ui.tick(); assert.match(ui.html(), /No location rows returned. Location completeness is unknown/); assert.match(ui.html(), /No inventory rows returned. Inventory completeness is unknown/); assert.doesNotMatch(ui.html(), /Out of stock|Total available|No stock exists|All locations/);
});

test('pending stock cannot survive filter changes, account A to B to A, detail refresh or unmount and retained events cannot restart it', async () => {
  for (const mode of ['filter', 'account-A-B-A', 'detail', 'unmount']) {
    const held = deferred(), ui = await stockBrowser(async () => held.promise), retained = ui.button('Load stock and locations').props.onClick, reading = ui.click('Load stock and locations');
    if (mode === 'filter') await ui.change('Platform product query', 'new query'); if (mode === 'account-A-B-A') { await ui.change('Shopify account', accounts[1].id); await ui.change('Shopify account', accounts[0].id); } if (mode === 'detail') { ui.submit(); await ui.tick(); await ui.click('Read Provider product'); await ui.tick(); } if (mode === 'unmount') ui.unmount();
    held.resolve(stockResponse()); await reading; await ui.tick(); assert.doesNotMatch(ui.html(), /OUTSIDE-FIRST-100|Returned inventory|Loaded at/); const reads = ui.calls.length; await retained(); await ui.tick(); assert.equal(ui.calls.length, reads, mode);
  }
});

test('a changed store grant during stock loading clears the old scope and a stale stock error cannot replace new detail', async () => {
  let selectedStore = stockStore(), hold; const ui = await browser(async path => path.endsWith('/inventory') ? hold.promise : path.endsWith('/store') ? { store: selectedStore } : path.includes('?') ? page([priceProduct()]) : detail(priceProduct())); await ui.change('Shopify account', accounts[0].id); ui.submit(); await ui.tick(); await ui.click('Read Provider product'); await ui.tick(); hold = deferred(); const reading = ui.click('Load stock and locations');
  selectedStore = store(); ui.submit(); await ui.tick(); await ui.click('Read Provider product'); await ui.tick(); hold.reject(new Error('STALE_STOCK_ERROR')); await reading; await ui.tick(); assert.doesNotMatch(ui.html(), /STALE_STOCK_ERROR|Load stock and locations|OUTSIDE-FIRST-100/); assert.match(ui.html(), /product read and inventory read permissions/);
});

test('ordinary parent request callback changes retain verified stock and allow pending reads in the same meaningful scope', async () => {
  let hold; const ui = await stockBrowser(async () => hold ? hold.promise : stockResponse()); await ui.click('Load stock and locations'); await ui.tick(); ui.renewRequest(); assert.match(ui.html(), /OUTSIDE-FIRST-100/); assert.ok(ui.button('Refresh stock and locations'));
  hold = deferred(); const refreshing = ui.click('Refresh stock and locations'); ui.renewRequest(); hold.resolve(stockResponse()); await refreshing; await ui.tick(); assert.match(ui.html(), /OUTSIDE-FIRST-100/); assert.ok(ui.button('Refresh stock and locations'));
});

const stateStore = () => ({ ...store(), capabilities: ['products.read', 'products.status'] });
const stateProduct = (id = '501') => ({ ...product(id), title: '<script>Product title</script>' });
const stateDetail = (row = stateProduct(), version = 'state-version') => ({ product: row, store: stateStore(), version, archiveVersion: 'archive-' + version, activateVersion: 'activate-' + version, deleteVersion: 'delete-' + version });
const stateReceipt = () => ({ accountId: accounts[0].id, product: { ...stateProduct(), status: 'draft', platformStatus: 'DRAFT' }, store: stateStore(), readback: true, operation: { id: 'state-operation', status: 'complete' } });
const stateReview = (respond = async (_path, body) => body ? stateReceipt() : stateDetail(), props = {}) => browser(respond, accounts, { kind: 'ProductStateReview', account: accounts[0], store: stateStore(), product: stateProduct(), ...props });
async function reviewState(ui) { await ui.click('Review move to draft'); await ui.tick(); ui.confirm(); }

const archiveReceipt = () => ({ ...stateReceipt(), product: { ...stateProduct(), status: 'archived', platformStatus: 'ARCHIVED' } });
const archiveReview = (respond = async (_path, body) => body ? archiveReceipt() : stateDetail(), props = {}) => stateReview(respond, { stateAction: 'archive', ...props });
async function reviewArchive(ui) { await ui.click('Review archive'); await ui.tick(); ui.confirm(); }

const draftStateProduct = () => ({ ...stateProduct(), status: 'draft', platformStatus: 'DRAFT' });
const activationReceipt = () => ({ ...stateReceipt(), product: stateProduct() });
const activationReview = (respond = async (_path, body) => body ? activationReceipt() : stateDetail(draftStateProduct()), props = {}) => stateReview(respond, { stateAction: 'activate', product: draftStateProduct(), ...props });
async function reviewActivation(ui) { await ui.click('Review activation'); await ui.tick(); ui.confirm(); }

const archivedStateProduct = () => ({ ...stateProduct(), status: 'archived', platformStatus: 'ARCHIVED' });
const deletionReceipt = () => ({ accountId: accounts[0].id, store: stateStore(), readback: true, operation: { id: 'deletion-operation', status: 'complete' }, deletionAcceptance: { productId: '501', platform: 'shopify', action: 'delete', absenceVerified: true, checkedAt: '2026-10-20T10:00:00.000Z' } });
const deletionReview = (respond = async (_path, body) => body ? deletionReceipt() : stateDetail(archivedStateProduct()), props = {}) => stateReview(respond, { stateAction: 'delete', product: archivedStateProduct(), ...props });
async function reviewDeletion(ui) { await ui.click('Review permanent deletion'); await ui.tick(); ui.confirm(); }

test('permanent deletion entry is archived-only and retains exact committed callback ownership', async () => {
  for (const status of ['draft', 'active', 'archived', 'deleted', 'unknown']) {
    const row = { ...stateProduct(), title: 'Selected product', status, platformStatus: status.toUpperCase() }, opened = [], callback = (...args) => opened.push(args), selectedStore = stateStore();
    const ui = await browser(async path => path.endsWith('/store') ? { store: selectedStore } : page([row]), accounts, { onDeleteProduct: callback }); await ui.change('Shopify account', accounts[0].id); ui.submit(); await ui.tick();
    assert.equal(!!ui.button('Delete Selected product'), status === 'archived'); if (status !== 'archived') continue;
    const retained = ui.button('Delete Selected product').props.onClick; await ui.click('Delete Selected product'); assert.deepEqual(opened[0], [accounts[0], selectedStore, row]); ui.setProps({ onDeleteProduct: undefined }); retained(); ui.setProps({ onDeleteProduct: callback }); retained(); assert.equal(opened.length, 1);
  }
});

test('permanent deletion requires fresh archived review and irreversible acknowledgement then renders a deletion reference', async () => {
  let validated = false; const ui = await deletionReview(async (path, body, validate) => { if (!body) return stateDetail(archivedStateProduct()); assert.equal(path, 'products/shop%2Fa/501/delete'); assert.deepEqual(body, { version: 'delete-state-version', confirmDelete: true }); validate(deletionReceipt()); validated = true; return deletionReceipt(); });
  await ui.click('Review permanent deletion'); await ui.tick(); assert.equal(ui.button('Permanently delete product').props.disabled, true); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
  assert.match(ui.html(), /Before: Archived.*archived.*ARCHIVED/); assert.match(ui.html(), /cannot be undone/); assert.match(ui.html(), /variants and inventory items, sales-channel publications/); assert.doesNotMatch(ui.html(), /<script|<img|After:.*DELETED/);
  ui.confirm(); await ui.submit(); await ui.tick(); assert.equal(validated, true); assert.match(ui.html(), /Product deletion confirmed.*501.*2026-10-20/); assert.doesNotMatch(ui.html(), /Product state confirmed/); assert.equal(ui.calls.filter(call => call[1]).length, 1);
});

test('deletion rejects unavailable sources, missing action version, drift and stale action/access callbacks', async () => {
  for (const props of [{ product: stateProduct() }, { product: draftStateProduct() }, { product: { ...archivedStateProduct(), platformStatus: 'DRAFT' } }, { readOnly: true }, { account: { ...accounts[0], isActive: false } }, { store: { ...stateStore(), missingCapabilities: ['products.status'] } }]) { const ui = await deletionReview(async () => assert.fail('Unavailable deletion must not read'), props); await ui.submit(); assert.equal(ui.calls.length, 0); }
  const missing = await deletionReview(async () => ({ ...stateDetail(archivedStateProduct()), deleteVersion: undefined })); assert.match(missing.html(), /could not be verified/); await missing.submit(); assert.equal(missing.calls.filter(call => call[1]).length, 0);
  let fresh = stateDetail(archivedStateProduct()); const changed = await deletionReview(async () => fresh); fresh = stateDetail(archivedStateProduct(), 'changed'); await changed.click('Review permanent deletion'); await changed.tick(); assert.match(changed.html(), /product changed on Shopify/);
  for (const change of [{ readOnly: true }, { stateAction: 'archive' }, { store: { ...stateStore(), missingCapabilities: ['products.status'] } }]) { const ui = await deletionReview(); await reviewDeletion(ui); const retained = ui.find(node => node.type === 'form').props.onSubmit; ui.setProps(change); await retained({ preventDefault() {} }); ui.setProps({ stateAction: 'delete', readOnly: false, store: stateStore() }); await ui.tick(); await retained({ preventDefault() {} }); assert.equal(ui.calls.filter(call => call[1]).length, 0); }
});

test('deletion accepts only scoped absence references and keeps malformed acknowledgements receipt-only', async () => {
  for (const mutate of [r => { r.deletionAcceptance.productId = 'other'; }, r => { r.deletionAcceptance.action = 'archive'; }, r => { r.deletionAcceptance.platform = 'other'; }, r => { r.deletionAcceptance.absenceVerified = false; }, r => { r.deletionAcceptance.checkedAt = 'not-time'; }, r => { r.product = archivedStateProduct(); }, r => { r.store.domain = 'other'; }, r => { r.accountId = 'other'; }, r => { r.readback = false; }, r => { r.operation.status = 'uncertain'; }]) {
    let malformed = true; const ui = await deletionReview(async (_path, body) => { if (!body) return stateDetail(archivedStateProduct()); const receipt = deletionReceipt(); if (malformed) mutate(receipt); return receipt; }); await reviewDeletion(ui); await ui.submit(); await ui.tick(); assert.match(ui.html(), /outcome is unknown/); assert.equal(ui.calls.filter(call => call[1]).length, 1);
    ui.setProps({ readOnly: true }); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 1); ui.setProps({ readOnly: false }); malformed = false; await ui.submit(); await ui.tick(); const attempts = ui.calls.filter(call => call[1]); assert.equal(attempts.length, 2); assert.deepEqual(attempts[0].slice(0,2), attempts[1].slice(0,2)); assert.equal(attempts[1][3], true); assert.match(ui.html(), /Product deletion confirmed/);
  }
});


test('activation entry is draft-only with a committed callback and leaves archive/deactivation eligibility unchanged', async () => {
  for (const status of ['draft', 'active', 'archived', 'deleted', 'inactive', 'pending_review', 'unknown']) {
    const row = { ...stateProduct(), title: 'Selected product', status, platformStatus: status.toUpperCase() }, opened = [], callback = (...args) => opened.push(args), selectedStore = stateStore();
    const ui = await browser(async path => path.endsWith('/store') ? { store: selectedStore } : page([row]), accounts, { onActivate: callback, onArchive: callback, onDeactivate: callback }); await ui.change('Shopify account', accounts[0].id); ui.submit(); await ui.tick();
    assert.equal(!!ui.button('Activate Selected product'), status === 'draft'); assert.equal(!!ui.button('Move to draft Selected product'), status === 'active'); assert.equal(!!ui.button('Archive Selected product'), ['draft', 'active'].includes(status));
    if (status !== 'draft') continue;
    const retained = ui.button('Activate Selected product').props.onClick; await ui.click('Activate Selected product'); assert.deepEqual(opened[0], [accounts[0], selectedStore, row]); ui.setProps({ onActivate: undefined }); retained(); ui.setProps({ onActivate: callback }); retained(); assert.equal(opened.length, 1);
  }
});

test('activation reviews Draft to Active with explicit availability copy and sends only the action-bound version', async () => {
  let validated = false; const ui = await activationReview(async (path, body, validate) => {
    if (!body) return stateDetail(draftStateProduct()); assert.equal(path, 'products/shop%2Fa/501/activate'); assert.deepEqual(body, { version: 'activate-state-version', confirmActivate: true }); validate(activationReceipt()); validated = true; return activationReceipt();
  });
  await ui.click('Review activation'); await ui.tick(); assert.equal(ui.button('Activate product').props.disabled, true); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
  assert.match(ui.html(), /Before: Draft.*draft.*DRAFT/); assert.match(ui.html(), /After: Active.*active.*ACTIVE/); assert.match(ui.html(), /may affect customer availability/); assert.match(ui.html(), /Channel publication is separately unverified/); assert.doesNotMatch(ui.html(), /<script|<img|<a\s|no storefront impact/i);
  ui.confirm(); await ui.submit(); await ui.tick(); assert.equal(validated, true); assert.equal(ui.calls.filter(call => call[1]).length, 1); assert.match(ui.html(), /Product state confirmed.*active.*ACTIVE/);
});

test('activation rejects unknown or conflicting sources, missing action versions, drift and stale action/access callbacks', async () => {
  for (const props of [{ product: stateProduct() }, { product: { ...draftStateProduct(), platformStatus: 'ACTIVE' } }, { product: { ...draftStateProduct(), status: 'unknown' } }, { readOnly: true }, { account: { ...accounts[0], isActive: false } }, { store: { ...stateStore(), missingCapabilities: ['products.status'] } }]) {
    const ui = await activationReview(async () => assert.fail('Unavailable activation must not read'), props); await ui.submit(); assert.equal(ui.calls.length, 0);
  }
  const missing = await activationReview(async () => ({ ...stateDetail(draftStateProduct()), activateVersion: undefined })); assert.match(missing.html(), /could not be verified/); await missing.submit(); assert.equal(missing.calls.filter(call => call[1]).length, 0);
  let fresh = stateDetail(draftStateProduct()); const changed = await activationReview(async () => fresh); fresh = stateDetail(draftStateProduct(), 'changed-start'); await changed.click('Review activation'); await changed.tick(); assert.match(changed.html(), /product changed on Shopify/); await changed.submit(); assert.equal(changed.calls.filter(call => call[1]).length, 0);
  for (const change of [{ readOnly: true }, { stateAction: 'archive' }, { store: { ...stateStore(), missingCapabilities: ['products.status'] } }]) {
    const ui = await activationReview(); await reviewActivation(ui); const retained = ui.find(node => node.type === 'form').props.onSubmit, confirm = ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange;
    ui.setProps(change); confirm({ target: { checked: true } }); await retained({ preventDefault() {} }); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
    if (change.stateAction) { ui.setProps({ stateAction: 'activate' }); await ui.tick(); await retained({ preventDefault() {} }); assert.equal(ui.calls.filter(call => call[1]).length, 0); }
  }
});

test('malformed activation receipts keep the exact original action for deliberate permission-gated checks', async () => {
  for (const mutate of [r => { r.product.status = 'draft'; }, r => { r.product.platformStatus = 'DRAFT'; }, r => { r.product.status = 'archived'; r.product.platformStatus = 'ARCHIVED'; }, r => { r.product.accountId = 'other'; }, r => { r.readback = false; }, r => { r.operation.id = ''; }]) {
    let malformed = true; const ui = await activationReview(async (_path, body) => { if (!body) return stateDetail(draftStateProduct()); const result = activationReceipt(); if (malformed) mutate(result); return result; }); await reviewActivation(ui); await ui.submit(); await ui.tick(); assert.match(ui.html(), /outcome is unknown/); assert.equal(ui.calls.filter(call => call[1]).length, 1);
    ui.setProps({ readOnly: true }); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 1); ui.setProps({ readOnly: false }); malformed = false; await ui.submit(); await ui.tick(); const attempts = ui.calls.filter(call => call[1]); assert.equal(attempts.length, 2); assert.deepEqual(attempts[0].slice(0, 2), attempts[1].slice(0, 2)); assert.match(ui.html(), /Product state confirmed.*active.*ACTIVE/);
  }
});


test('archive entry allows exact active or draft pairs with its own committed callback and preserves move-to-draft bounds', async () => {
  for (const status of ['active', 'draft', 'archived', 'deleted', 'inactive']) for (const allowed of [true, false]) {
    const row = { ...stateProduct(), title: 'Selected product', status, platformStatus: status.toUpperCase() }, opened = [], callback = (...args) => opened.push(args), selectedStore = stateStore();
    const ui = await browser(async path => path.endsWith('/store') ? { store: selectedStore } : page([row]), accounts, { onArchive: allowed ? callback : undefined, onDeactivate: callback }); await ui.change('Shopify account', accounts[0].id); ui.submit(); await ui.tick();
    assert.equal(!!ui.button('Move to draft Selected product'), status === 'active');
    assert.equal(!!ui.button('Archive Selected product'), allowed && ['active', 'draft'].includes(status));
    if (!ui.button('Archive Selected product')) continue;
    const retained = ui.button('Archive Selected product').props.onClick; await ui.click('Archive Selected product'); assert.deepEqual(opened[0], [accounts[0], selectedStore, row]);
    ui.setProps({ onArchive: undefined }); retained(); ui.setProps({ onArchive: callback }); retained(); assert.equal(opened.length, 1);
  }
  for (const change of [row => { row.platformStatus = 'DRAFT'; }, row => { row.accountId = 'other'; }]) {
    const row = stateProduct(); change(row); const ui = await browser(async path => path.endsWith('/store') ? { store: stateStore() } : page([row]), accounts, { onArchive: () => assert.fail('Invalid archive entry') }); await ui.change('Shopify account', accounts[0].id); ui.submit(); await ui.tick(); assert.doesNotMatch(ui.html(), />Archive /);
  }
});

test('archive reviews each starting state and submits only its action-bound version after explicit acknowledgement', async () => {
  for (const status of ['active', 'draft']) {
    const row = { ...stateProduct(), status, platformStatus: status.toUpperCase() }; let validated = false;
    const ui = await archiveReview(async (path, body, validate) => {
      if (!body) return stateDetail(row); assert.equal(path, 'products/shop%2Fa/501/archive'); assert.deepEqual(body, { version: 'archive-state-version', confirmArchive: true }); validate(archiveReceipt()); validated = true; return archiveReceipt();
    }, { product: row });
    await ui.click('Review archive'); await ui.tick(); assert.equal(ui.button('Archive product').props.disabled, true); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
    assert.match(ui.html(), /unavailable to customers on sales channels and apps/); assert.match(ui.html(), new RegExp('Before: .*' + status + '.*' + status.toUpperCase())); assert.match(ui.html(), /After: Archived.*archived.*ARCHIVED/); assert.doesNotMatch(ui.html(), /<script|<img|<a\s/);
    ui.confirm(); await ui.submit(); await ui.tick(); assert.equal(validated, true); assert.equal(ui.calls.filter(call => call[1]).length, 1); assert.match(ui.html(), /Product state confirmed.*archived.*ARCHIVED/);
  }
});

test('archive rejects missing action versions, changed starting snapshots and stale action or access callbacks', async () => {
  const missing = await archiveReview(async () => ({ ...stateDetail(), archiveVersion: undefined })); assert.match(missing.html(), /could not be verified/); await missing.submit(); assert.equal(missing.calls.filter(call => call[1]).length, 0);
  let fresh = stateDetail(); const changed = await archiveReview(async () => fresh); fresh = stateDetail({ ...stateProduct(), status: 'draft', platformStatus: 'DRAFT' }, 'changed-start'); await changed.click('Review archive'); await changed.tick(); assert.match(changed.html(), /product changed on Shopify/); await changed.submit(); assert.equal(changed.calls.filter(call => call[1]).length, 0);
  for (const change of [{ readOnly: true }, { stateAction: 'deactivate' }, { store: { ...stateStore(), missingCapabilities: ['products.status'] } }]) {
    const ui = await archiveReview(); await reviewArchive(ui); const retained = ui.find(node => node.type === 'form').props.onSubmit, confirm = ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange;
    ui.setProps(change); confirm({ target: { checked: true } }); await retained({ preventDefault() {} }); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
    if (change.stateAction) { ui.setProps({ stateAction: 'archive' }); await ui.tick(); await retained({ preventDefault() {} }); assert.equal(ui.calls.filter(call => call[1]).length, 0); }
  }
});

test('malformed archive receipts retain the exact action for permission-gated outcome checks without automatic retries', async () => {
  for (const mutate of [r => { r.product.status = 'draft'; }, r => { r.product.platformStatus = 'DRAFT'; }, r => { r.accountId = 'other'; }, r => { r.readback = false; }, r => { r.operation.id = ''; }]) {
    let malformed = true; const ui = await archiveReview(async (_path, body) => { if (!body) return stateDetail(); const result = archiveReceipt(); if (malformed) mutate(result); return result; });
    await reviewArchive(ui); await ui.submit(); await ui.tick(); assert.match(ui.html(), /outcome is unknown/); assert.equal(ui.calls.filter(call => call[1]).length, 1); assert.doesNotMatch(ui.html(), /Product state confirmed|Review Shopify product state/);
    ui.setProps({ readOnly: true }); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 1);
    ui.setProps({ readOnly: false }); malformed = false; await ui.submit(); await ui.tick(); const attempts = ui.calls.filter(call => call[1]); assert.equal(attempts.length, 2); assert.deepEqual(attempts[0].slice(0, 2), attempts[1].slice(0, 2)); assert.match(ui.html(), /Product state confirmed.*ARCHIVED/);
  }
});


test('move to draft entry requires exact active native status, explicit grants and a committed callback', async () => {
  const opened = [], callback = (...args) => opened.push(args);
  for (const mode of ['allowed', 'no-callback', 'no-status', 'missing-read', 'missing-status', 'draft', 'wrong-pair', 'other-account']) {
    const selectedStore = stateStore(); if (mode === 'no-status') selectedStore.capabilities = ['products.read']; if (mode.startsWith('missing-')) selectedStore.missingCapabilities = [mode === 'missing-read' ? 'products.read' : 'products.status'];
    const selectedProduct = { ...stateProduct(), title: 'Selected product', ...(mode === 'draft' ? { status: 'draft', platformStatus: 'DRAFT' } : {}), ...(mode === 'wrong-pair' ? { platformStatus: 'DRAFT' } : {}), ...(mode === 'other-account' ? { accountId: 'other' } : {}) };
    const ui = await browser(async path => path.endsWith('/store') ? { store: selectedStore } : page([selectedProduct]), accounts, { onDeactivate: mode === 'no-callback' ? undefined : callback }); await ui.change('Shopify account', accounts[0].id); ui.submit(); await ui.tick();
    if (mode !== 'allowed') { assert.doesNotMatch(ui.html(), /Move to draft/); continue; }
    const retained = ui.button('Move to draft Selected product').props.onClick; await ui.click('Move to draft Selected product'); assert.deepEqual(opened.at(-1), [accounts[0], selectedStore, selectedProduct]);
    ui.setProps({ onDeactivate: undefined }); retained(); ui.setProps({ onDeactivate: callback }); retained(); assert.equal(opened.length, 1);
    ui.discardProps({ onDeactivate: undefined }); await ui.click('Move to draft Selected product'); assert.equal(opened.length, 2);
    ui.submit(); await ui.tick(); retained(); assert.equal(opened.length, 2, 'Refreshing products invalidates the retained entry callback.');
  }
});

test('product state review loads fresh exact identity, renders provider text inert and sends only the bounded payload', async () => {
  let validated = false; const ui = await stateReview(async (path, body, validate) => {
    if (!body) return stateDetail(); assert.equal(path, 'products/shop%2Fa/501/deactivate'); assert.deepEqual(body, { version: 'state-version', confirmDeactivate: true }); validate(stateReceipt()); validated = true; return stateReceipt();
  });
  assert.equal(ui.calls[0][0], 'products/shop%2Fa/501'); await ui.click('Review move to draft'); await ui.tick(); assert.equal(ui.button('Move to draft').props.disabled, true); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
  const html = ui.html(); assert.match(html, /Move this product from Active to Draft/); assert.match(html, /Account shop\/a.*shop.example.*Native product 501/); assert.match(html, /Before: Active.*ACTIVE.*After: Draft.*DRAFT/); assert.match(html, /&lt;script&gt;Product title&lt;\/script&gt;/); assert.doesNotMatch(html, /<script|<img|<iframe|<a\s|storefront|sales channel|publish|archive|delete/i);
  ui.confirm(); await ui.submit(); await ui.tick(); assert.equal(validated, true); assert.match(ui.html(), /Product state confirmed by Shopify readback.*draft.*DRAFT/); assert.equal(ui.calls.filter(call => !call[1]).length, 2);
});

test('state review refuses read-only, disconnected, mismatched, malformed and contradictory permission scopes', async () => {
  for (const props of [{ readOnly: true }, { account: { ...accounts[0], isActive: false } }, { account: { ...accounts[0], needsReconnection: true } }, { store: writeStore() }, { store: { ...stateStore(), missingCapabilities: ['products.read'] } }, { store: { ...stateStore(), missingCapabilities: ['products.status'] } }, { store: stateStore(), product: { ...stateProduct(), accountId: 'other' } }, { product: { ...stateProduct(), platformStatus: 'DRAFT' } }, { product: { ...stateProduct(), status: 'archived' } }]) {
    const ui = await stateReview(async () => assert.fail('No access must not request'), props); await ui.button('Review move to draft').props.onClick(); await ui.submit(); assert.equal(ui.calls.length, 0); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true);
  }
  for (const mutate of [r => { r.product.id = '502'; }, r => { r.product.accountId = 'other'; }, r => { r.store.domain = 'other.example'; }, r => { r.store.missingCapabilities = ['products.status']; }, r => { r.product.status = 'draft'; }, r => { r.product.platformStatus = 'DRAFT'; }, r => { r.version = ''; }]) {
    const ui = await stateReview(async () => { const result = stateDetail(); mutate(result); return result; }); assert.match(ui.html(), /could not be verified/); await ui.button('Review move to draft').props.onClick(); await ui.submit(); assert.equal(ui.calls.length, 1);
  }
});

test('state acknowledgements and retained submits are withdrawn by every committed context change including A to B to A', async () => {
  for (const mode of ['read-only', 'inactive', 'account-name', 'store-grant', 'product-title', 'product-refresh', 'store-refresh', 'account-refresh', 'A-B-A', 'unconfirm']) {
    const ui = await stateReview(); await reviewState(ui); const retained = ui.find(node => node.type === 'form').props.onSubmit, confirm = ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange;
    if (mode === 'read-only') ui.setProps({ readOnly: true }); if (mode === 'inactive') ui.setProps({ account: { ...accounts[0], isActive: false } }); if (mode === 'account-name') ui.setProps({ account: { ...accounts[0], name: 'Updated name' } }); if (mode === 'store-grant') ui.setProps({ store: { ...stateStore(), missingCapabilities: ['products.status'] } }); if (mode === 'product-title') ui.setProps({ product: { ...stateProduct(), title: 'New title' } }); if (mode === 'product-refresh') ui.setProps({ product: stateProduct() }); if (mode === 'store-refresh') ui.setProps({ store: stateStore() }); if (mode === 'account-refresh') ui.setProps({ account: { ...accounts[0] } }); if (mode === 'A-B-A') { ui.setProps({ readOnly: true }); ui.setProps({ readOnly: false }); } if (mode === 'unconfirm') ui.confirm(false);
    if (mode !== 'unconfirm') confirm({ target: { checked: true } }); await retained({ preventDefault() {} }); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0, mode); if (mode !== 'unconfirm') assert.doesNotMatch(ui.html(), /Review Shopify product state/, mode);
  }
  const ui = await stateReview(); await reviewState(ui); ui.discardProps({ readOnly: true }); await ui.submit(); await ui.tick(); assert.match(ui.html(), /Product state confirmed/);
});

test('state review requires explicit reload after a fresh version changes and never survives a refresh', async () => {
  let version = 'state-version'; const ui = await stateReview(async (_path, body) => body ? stateReceipt() : stateDetail(undefined, version)); version = 'changed-state-version'; await ui.click('Review move to draft'); await ui.tick(); assert.match(ui.html(), /product changed on Shopify/); assert.doesNotMatch(ui.html(), /Review Shopify product state/); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0);
  await ui.click('Refresh current product state'); await ui.tick(); await reviewState(ui); const retained = ui.find(node => node.type === 'form').props.onSubmit; await ui.click('Refresh current product state'); await ui.tick(); await retained({ preventDefault() {} }); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 0); await reviewState(ui); await ui.submit(); await ui.tick(); assert.equal(ui.calls.find(call => call[1])[1].version, 'changed-state-version');
});

test('strict state receipts leave uncertainty and only explicit same-key outcome checks can resolve it', async () => {
  for (const validateInRequest of [false, true]) for (const mutate of [r => { r.accountId = 'other'; }, r => { r.product.id = 'other'; }, r => { r.product.accountId = 'other'; }, r => { r.store.domain = 'other.example'; }, r => { r.store.missingCapabilities = ['products.status']; }, r => { r.product.status = 'active'; }, r => { r.product.platformStatus = 'ACTIVE'; }, r => { r.readback = false; }, r => { r.operation.status = 'pending'; }, r => { r.operation.id = ''; }]) {
    let malformed = true; const ui = await stateReview(async (_path, body, validate) => { if (!body) return stateDetail(); const result = stateReceipt(); if (malformed) mutate(result); if (validateInRequest) validate(result); return result; }); await reviewState(ui); await ui.submit(); await ui.tick(); assert.match(ui.html(), /outcome is unknown/); assert.doesNotMatch(ui.html(), /Product state confirmed|Review Shopify product state|Refresh current product state/); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true); assert.ok(ui.button('Check outcome')); const retained = ui.find(node => node.type === 'form').props.onSubmit;
    ui.setProps({ readOnly: true }); await retained({ preventDefault() {} }); await ui.submit(); assert.equal(ui.calls.filter(call => call[1]).length, 1); assert.equal(ui.button('Check outcome').props.disabled, true);
    ui.setProps({ readOnly: false }); malformed = false; await ui.submit(); await ui.tick(); const writes = ui.calls.filter(call => call[1]); assert.equal(writes.length, 2); assert.deepEqual(writes[0].slice(0, 2), writes[1].slice(0, 2)); assert.match(ui.html(), /Product state confirmed/);
  }
});

test('operator closure withdraws the old action and requires explicit state reload and acknowledgement', async () => {
  let writes = 0; const ui = await stateReview(async (_path, body) => { if (!body) return stateDetail(undefined, writes > 1 ? 'after-closure' : 'state-version'); writes++; if (writes === 1) throw Object.assign(new Error('Pending state outcome'), { status: 409, code: 'OPERATION_PENDING' }); if (writes === 2) throw Object.assign(new Error('Closed state action'), { status: 409, code: 'OPERATION_REVIEWED', operation: { id: 'closed-state', status: 'reviewed-failed' } }); return stateReceipt(); });
  await reviewState(ui); await ui.submit(); await ui.tick(); const retained = ui.find(node => node.type === 'form').props.onSubmit; await ui.submit(); await ui.tick(); assert.match(ui.html(), /closed-state.*reviewed-failed/); assert.doesNotMatch(ui.html(), /outcome is unknown|Review Shopify product state|Product state confirmed/); await retained({ preventDefault() {} }); await ui.submit(); await ui.button('Review move to draft').props.onClick(); assert.equal(writes, 2);
  await ui.click('Refresh current product state'); await ui.tick(); await ui.click('Review move to draft'); await ui.tick(); assert.equal(ui.button('Move to draft').props.disabled, true); await ui.submit(); assert.equal(writes, 2); ui.confirm(); await ui.submit(); await ui.tick(); assert.equal(writes, 3); assert.equal(ui.calls.filter(call => call[1]).at(-1)[1].version, 'after-closure'); assert.match(ui.html(), /Product state confirmed/);
});

test('late state reads and receipts cannot replace a newer product or revive A to B to A reviews', async () => {
  const reads = [], ui = await stateReview(async () => { reads.push(deferred()); return reads.at(-1).promise; }); ui.setProps({ product: stateProduct('502') }); await ui.tick(); ui.setProps({ product: stateProduct() }); await ui.tick(); reads[0].resolve(stateDetail({ ...stateProduct(), title: 'STALE PRODUCT' })); reads[1].resolve(stateDetail(stateProduct('502'))); await ui.tick(); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, true); reads[2].resolve(stateDetail()); await ui.tick(); assert.doesNotMatch(ui.html(), /STALE PRODUCT/); assert.equal(ui.find(node => node.type === 'fieldset').props.disabled, false);
  const pending = deferred(), changing = await stateReview(async (path, body) => body ? pending.promise : stateDetail(stateProduct(path.endsWith('/502') ? '502' : '501'))); await reviewState(changing); const write = changing.submit(); changing.setProps({ product: stateProduct('502') }); await changing.tick(); pending.resolve(stateReceipt()); await write; await changing.tick(); assert.doesNotMatch(changing.html(), /Product state confirmed|outcome is unknown/); await changing.click('Review move to draft'); await changing.tick(); assert.match(changing.html(), /Native product 502/);
});

test('all product mutators withdraw known-unsent attempts after lost replies or failed prior-resource blocks and require fresh review', async () => {
  const cases = [
    { name: 'update', open: editor, initial: reviewUpdate, snapshot: version => editDetail(undefined, version), receipt: updateReceipt, refresh: 'Refresh current product review', review: 'Review product changes', accepted: /Product update confirmed/ },
    { name: 'create', open: creator, initial: reviewCreation, snapshot: creationReview, receipt: creationReceipt, review: 'Review draft product', accepted: /Draft product creation confirmed/ },
    { name: 'price', open: priceEditor, initial: reviewPrice, snapshot: version => priceDetail(undefined, version), receipt: priceReceipt, refresh: 'Refresh current product prices', review: 'Review price change', accepted: /Variant price confirmed/ },
    { name: 'state', open: stateReview, initial: reviewState, snapshot: version => stateDetail(undefined, version), receipt: stateReceipt, refresh: 'Refresh current product state', review: 'Review move to draft', accepted: /Product state confirmed/ },
    { name: 'archive', open: archiveReview, initial: reviewArchive, snapshot: version => stateDetail(undefined, version), receipt: archiveReceipt, refresh: 'Refresh current product state', review: 'Review archive', accepted: /Product state confirmed/ },
    { name: 'delete', open: deletionReview, initial: reviewDeletion, snapshot: version => stateDetail(archivedStateProduct(), version), receipt: deletionReceipt, refresh: 'Refresh current product state', review: 'Review permanent deletion', accepted: /Product deletion confirmed/ },
    { name: 'activation', open: activationReview, initial: reviewActivation, snapshot: version => stateDetail(draftStateProduct(), version), receipt: activationReceipt, refresh: 'Refresh current product state', review: 'Review activation', accepted: /Product state confirmed/ },
  ];
  for (const row of cases) for (const rejected of [{ code: 'OPERATION_NOT_SENT', lost: true }, { code: 'PRODUCT_PREVIOUS_OUTCOME_UNRESOLVED', lost: false }, { code: 'PROVIDER_UNAVAILABLE', status: 502, lost: true }]) {
    let terminal = false, sequence = 0; const attempts = [], keys = new Map();
    const ui = await row.open(async (path, body, validate) => {
      if (!body) return row.snapshot(terminal ? 'fresh-after-not-sent' : 'original-version');
      const payload = JSON.stringify([path, body]); if (!keys.has(payload)) keys.set(payload, ++sequence); attempts.push({ payload, key: keys.get(payload) });
      if (!terminal && rejected.lost && attempts.length === 1) throw new Error('The response was lost.');
      if (!terminal) { terminal = true; keys.delete(payload); throw Object.assign(new Error('This attempt did not reach the provider.'), { status: rejected.status || 409, code: rejected.code, operation: { id: 'unsent-attempt', status: 'failed' } }); }
      const result = row.receipt(); validate(result); return result;
    });
    await row.initial(ui); const originalSubmit = ui.find(node => node.type === 'form').props.onSubmit, originalConfirm = ui.find(node => node.type === 'input' && node.props.type === 'checkbox').props.onChange; await ui.submit(); await ui.tick();
    let outcomeSubmit;
    if (rejected.lost) { assert.match(ui.html(), /outcome is unknown/, row.name); outcomeSubmit = ui.find(node => node.type === 'form').props.onSubmit; await ui.submit(); await ui.tick(); assert.equal(attempts[0].key, attempts[1].key); assert.equal(attempts[0].payload, attempts[1].payload); }
    const writes = attempts.length; assert.equal(writes, rejected.lost ? 2 : 1); assert.match(ui.html(), /Earlier request was not sent\. Refresh.*review a new action/, row.name); assert.doesNotMatch(ui.html(), /outcome is unknown|operator review|Review Shopify/, row.name);
    originalConfirm({ target: { checked: true } }); await originalSubmit({ preventDefault() {} }); if (outcomeSubmit) await outcomeSubmit({ preventDefault() {} }); await ui.submit(); assert.equal(attempts.length, writes, row.name);
    if (row.refresh) { await ui.button(row.review).props.onClick(); assert.equal(attempts.length, writes); await ui.click(row.refresh); await ui.tick(); }
    await ui.submit(); assert.equal(attempts.length, writes); await ui.click(row.review); await ui.tick(); await ui.submit(); assert.equal(attempts.length, writes, 'A fresh review needs a new acknowledgement.'); ui.confirm(); await ui.submit(); await ui.tick();
    assert.equal(attempts.length, writes + 1, row.name); assert.notEqual(attempts.at(-1).key, attempts[0].key); assert.match(attempts.at(-1).payload, /fresh-after-not-sent/); assert.match(ui.html(), row.accepted);
  }
});
