import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as ui from '@ten98/ui';
import { AuthErrorBoundary, Option, Select } from '@ten98/ui';
import { transformWithOxc } from 'vite';

test('campaign rows open the matching native advertising view and manual records open their campaign page', async () => {
  const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'), start = source.indexOf('function openCampaign('), end = source.indexOf('  const campaignTable', start);
  assert.ok(start > 0 && end > start);
  const calls = [], record = name => (...value) => calls.push([name, ...value]);
  const { open, add, openItem } = new Function('setPage', 'setAdsView', 'setModal', 'navigate', 'setAddIntent', 'state', `${stripTypeScriptTypes(source.slice(start, end))}; return { open: openCampaign, add: addToCampaign, openItem: openCampaignItem };`)(record('page'), record('view'), record('modal'), record('navigate'), record('intent'), { projectId: 'project-a', campaigns: [{ id: 'c1', startDate: '2999-03-01', endDate: '2999-03-31' }, { id: 'past', startDate: '2001-01-01', endDate: '2001-01-31' }] });
  for (const [provider, view] of [['googleAdsNative', 'shopping'], ['microsoft', 'microsoft']]) { calls.length = 0; open({ nativeProvider: provider, id: 'native' }); assert.deepEqual(calls, [['page', 'Ads manager', view]]); }
  calls.length = 0; open({ id: 'manual' }); assert.deepEqual(calls, [['navigate', { page: 'Campaigns', section: '', projectId: 'project-a', item: 'manual' }]]);
  // Add creates posts and bookings linked to the campaign and inside its dates; work made on another page opens there with the campaign set.
  calls.length = 0; for (const kind of ['post', 'placement', 'activation', 'message', 'ad', 'link']) add(kind, 'c1');
  assert.deepEqual(calls, [['modal', { type: 'post', campaignId: 'c1', day: '2999-03-01T09:00' }], ['modal', { type: 'placement', campaignId: 'c1', dates: { start: '2999-03-01', end: '2999-03-31' } }],
    ['intent', { page: 'Field activity', campaignId: 'c1' }], ['page', 'Field activity'], ['intent', { page: 'Direct campaigns', campaignId: 'c1' }], ['page', 'Direct campaigns'], ['page', 'Ads manager'], ['intent', { page: 'Links & tracking', campaignId: 'c1' }], ['page', 'Links & tracking']]);
  calls.length = 0; add('post', 'past'); assert.deepEqual(calls, [['modal', { type: 'post', campaignId: 'past' }]], 'A campaign that already started leaves the post time to the composer default.');
  calls.length = 0; const post = { id: 'p1' }; openItem('post', post); openItem('activation', { id: 'a1' }); assert.deepEqual(calls, [['modal', { type: 'post', item: post }], ['page', 'Field activity']]);
});

test('Shopping product-bid handlers send scoped confirmed changes and ignore readback after leaving the view', async () => {
  const source = await readFile(new URL('../src/NativeGoogleAds.tsx', import.meta.url), 'utf8');
  const compile = (from, to, context) => { const start = source.indexOf(from), end = source.indexOf(to, start); assert.ok(start > 0 && end > start); return new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source.slice(start, end))});`)(...Object.values(context)); };
  let finish, bids = {}, notice = '', requests = [];
  const active = { current: true }, context = { active, act: action => action(), path: '/projects/project-a/native-google-ads', request: (...args) => { requests.push(args); return new Promise(resolve => { finish = resolve; }); }, setProductBids: update => { bids = update(bids); }, setNotice: value => { notice = value; } };
  const load = compile('async function loadProductBid(', '  async function saveProductBid(', context);
  const pending = load({ id: '123' }); active.current = false; finish({ maxCpcMicros: '1500000' }); await pending;
  assert.deepEqual(bids, {}); assert.equal(requests[0][0], '/projects/project-a/native-google-ads/campaign/cpc?campaignId=123');
  active.current = true;
  const save = compile('async function saveProductBid(', '  const selectedCampaign =', { ...context, write: async (...args) => { requests.push(args); return { maxCpcMicros: '2000000' }; } });
  await save({ id: '123' }, 2); assert.deepEqual(requests[1], [{ campaignId: '123', maxCpc: 2, confirmChange: true }, 'campaign/cpc']); assert.equal(bids['123'].maxCpcMicros, '2000000'); assert.match(notice, /confirmed/);
});

test('Shopping budget, bid and confirmation controls share campaign-specific React identity even when bids match', async () => {
  const source = await readFile(new URL('../src/NativeGoogleAds.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('<Stack key={selectedCampaign.id}'), closing = 'Read only · Google API limit</Text>}</Stack>', end = source.indexOf(closing, start) + closing.length;
  assert.ok(start > 0 && end > start);
  const { code } = await transformWithOxc(`const render = (selectedCampaign, productBids) => (${source.slice(start, end)});`, 'ShoppingControls.tsx', { jsx: { runtime: 'classic' } });
  const noop = () => {}, confirmations = [], FormData = class { constructor(values) { return values; } };
  const render = new Function('React', ...Object.keys(ui), 'FormData', 'busy', 'currency', 'digits', 'updateCampaign', 'loadProductBid', 'saveProductBid', 'setConfirming', code + '\nreturn render;')(React, ...Object.values(ui), FormData, false, 'USD', 2, () => assert.fail('Campaign changes must be confirmed first.'), noop, noop, value => confirmations.push(value));
  const campaigns = ['shopping-a', 'shopping-b'].map(id => ({ id, channel: 'SHOPPING', status: 'PAUSED', budgetPeriod: 'DAILY', appManaged: true }));
  const bids = Object.fromEntries(campaigns.map(row => [row.id, { maxCpcMicros: '1500000' }])), controls = campaigns.map(row => render(row, bids));
  const elements = node => React.isValidElement(node) ? [node, ...[node.props.children].flat(Infinity).flatMap(elements)] : [];
  for (const [index, control] of controls.entries()) {
    assert.equal(control.key, campaigns[index].id, 'A different campaign must reset every uncontrolled input and its confirmation.');
    const nodes = elements(control);
    assert.deepEqual(nodes.filter(node => node.type === ui.Input && node.props.name).map(node => node.props.name).sort(), ['dailyBudget', 'maxCpc']);
    assert.ok(nodes.some(node => node.type === ui.Checkbox && node.props.required));
    nodes.find(node => node.type === ui.Button && /^Enable campaign/.test(node.props.children)).props.onClick();
    nodes.find(node => node.props.as === 'form' && node.key == null).props.onSubmit({ preventDefault() {}, currentTarget: new Map([['dailyBudget', '40']]) });
  }
  assert.notEqual(controls[0].key, controls[1].key);
  assert.deepEqual(confirmations.slice(0, 2).map(item => [item.row.id, item.changes, item.title, item.description]), [['shopping-a', { status: 'ENABLED', enableCreatedChildren: true }, 'Enable shopping-a and its app-created ad group and ad?', 'This can start paid delivery using its existing budget.'], ['shopping-a', { dailyBudget: 40 }, 'Replace the daily campaign budget with 40 USD?', '']]);
});

test('Shopping confirmed writes refresh the shared campaign plan, validation and failed provider writes do not', async () => {
  const source = await readFile(new URL('../src/NativeGoogleAds.tsx', import.meta.url), 'utf8'), start = source.indexOf('async function write('), end = source.indexOf('  async function create(', start);
  assert.ok(start > 0 && end > start);
  for (const mode of ['confirmed', 'validation', 'provider-error', 'refresh-error']) {
    let refreshes = 0, error = '';
    const result = { campaign: { id: 'shopping-a' } }, active = { current: true };
    const context = { active, path: '/projects/project-a/native-google-ads', keys: { current: new Map() }, crypto, request: async () => { if (mode === 'provider-error') throw new Error('Provider unavailable'); return result; }, onChanged: async () => { refreshes++; if (mode === 'refresh-error') throw new Error('Plan unavailable'); }, setError: value => { error = value; } };
    const write = new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source.slice(start, end))});`)(...Object.values(context));
    if (mode === 'provider-error') await assert.rejects(write({ campaignId: '123', status: 'PAUSED' }, 'campaign/update'), /Provider unavailable/);
    else assert.equal(await write({ campaignId: '123', validateOnly: mode === 'validation' }, 'campaign/update'), result);
    assert.equal(refreshes, ['confirmed', 'refresh-error'].includes(mode) ? 1 : 0);
    assert.equal(Boolean(error), mode === 'refresh-error');
    if (error) assert.match(error, /Google confirmed.*Reload the app/);
  }
});

test('Microsoft status-only changes omit shared or unchanged budgets while explicit daily edits remain possible', async () => {
  const source = await readFile(new URL('../src/MicrosoftAds.tsx', import.meta.url), 'utf8'), start = source.indexOf('function reviewChange('), middle = source.indexOf('  async function change(', start), end = source.indexOf('  async function requestReport(', middle);
  assert.ok(start > 0 && middle > start && end > middle);
  for (const values of [{ status: 'Paused' }, { status: 'Paused', dailyBudget: '25' }, { status: 'Active', dailyBudget: '30' }]) {
    const calls = [], rows = [{ id: 'campaign-a', dailyBudget: 25 }]; let confirming;
    class FormValues { constructor() { return new Map(Object.entries(values)); } }
    const context = { FormData: FormValues, setConfirming: value => { confirming = value; }, path: '/projects/project-a/microsoft-ads', active: { current: true }, action: run => run(), write: async (...args) => { calls.push(args); return { campaign: rows[0] }; }, setCampaigns: update => update(rows), setNotice() {}, onChanged() {} };
    const compile = (from, to) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source.slice(from, to))});`)(...Object.values(context));
    compile(start, middle)({ preventDefault() {}, currentTarget: {} }, rows[0]);
    assert.equal(calls.length, 0, 'Reviewing a change only opens its confirmation.'); assert.equal(confirming.campaign, rows[0]);
    await compile(middle, end)(confirming.campaign, confirming.body);
    assert.equal(calls[0][0], '/projects/project-a/microsoft-ads/campaigns/campaign-a');
    assert.deepEqual(calls[0][1], { status: values.status, confirmed: true, ...(values.dailyBudget === '30' ? { dailyBudget: 30 } : {}) });
  }
});

test('Shopping disconnection remains available when credentials are absent while verification stays disabled', async () => {
  const source = await readFile(new URL('../src/NativeGoogleAds.tsx', import.meta.url), 'utf8'), start = source.indexOf('<Disclosure summary={`Advertising account'), end = source.indexOf('</Disclosure>', start) + '</Disclosure>'.length;
  assert.ok(start > 0 && end > start);
  const { code } = await transformWithOxc(`const render = (status,busy) => (${source.slice(start,end)});`, 'AccountMapping.tsx', { jsx: { runtime: 'classic' } });
  const render = new Function('React', ...Object.keys(ui), 'map', 'setConfirming', code + '; return render;')(React, ...Object.values(ui), () => {}, () => {});
  const all = node => React.isValidElement(node) ? [node, ...[node.props.children].flat(Infinity).flatMap(all)] : [];
  const nodes = all(render({ configured: false, mapped: true, customerId: '1234567890' }, false));
  assert.equal(nodes.find(node => node.props.as === 'fieldset').props.disabled, false);
  assert.equal(nodes.find(node => node.type === ui.Input).props.disabled, true);
  assert.equal(nodes.find(node => node.type === ui.Button && node.props.children === 'Verify and map customer').props.disabled, true);
  assert.notEqual(nodes.find(node => node.type === ui.Button && node.props.children === 'Disconnect customer').props.disabled, true);
});

test('Demand Gen exposes target CPC while Performance Max retains conversion-only bidding options', async () => {
  const source = await readFile(new URL('../src/GoogleAdsTools.tsx', import.meta.url), 'utf8'), start = source.indexOf('<Select name="bidStrategy"'), end = source.indexOf('</Select>', start) + '</Select>'.length;
  assert.ok(start > 0 && end > start);
  const { code } = await transformWithOxc(`const render = (campaign,bidding) => (${source.slice(start,end)});`, 'CampaignBidding.tsx', { jsx: { runtime: 'classic' } });
  const render = new Function('React', 'Select', 'Option', code + '; return render;')(React, Select, Option);
  for (const channel of ['SEARCH','DEMAND_GEN','PERFORMANCE_MAX']) {
    const options = [render({ advertisingChannelType: channel }, {}).props.children].flat(Infinity).filter(React.isValidElement);
    const cap = options.find(option => option.props.value === 'LOWEST_COST_WITH_BID_CAP');
    assert.equal(Boolean(cap), channel !== 'PERFORMANCE_MAX');
    if (channel === 'DEMAND_GEN') assert.equal(cap.props.children, 'Target cost per click');
  }
});

test('render and lazy-load failures show a reload action without exposing the original error', async () => {
  const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  // The AuthFrameProvider sits outside the boundary (DS #157), so the fallback takes Campaign's brand from it.
  const mount = source.match(/render\(<AuthFrameProvider brand=\{<Brand product="Campaign" href="\/"\/>\} aside=\{authStory\} passwordPolicy=\{\{ minLength: 12, maxLength: 128 \}\}><AuthErrorBoundary fallback=\{\{ title: '([^']+)', message: '([^']+)', retryLabel: '([^']+)' \}\}><ToastProvider><App\/><\/ToastProvider><\/AuthErrorBoundary><\/AuthFrameProvider>\)/);
  assert.ok(mount, 'The app root is wrapped by the auth frame and the shared boundary with Campaign copy.');
  const [, title, message, retryLabel] = mount;
  assert.equal(retryLabel, 'Reload app'); assert.doesNotMatch(source, /class AppBoundary /);
  let reloads = 0;
  const boundary = new AuthErrorBoundary({ children: 'Ready', fallback: { brand: 'Campaign', title, message, retryLabel }, onReload: () => { reloads++; } });
  assert.equal(boundary.render(), 'Ready');
  boundary.state = AuthErrorBoundary.getDerivedStateFromError(new Error('Private request payload'));
  const html = renderToStaticMarkup(boundary.render());
  assert.match(html, /role="alert"/); assert.match(html, />Reload app</); assert.ok(html.includes(title)); assert.doesNotMatch(html, /Private request payload/);
  boundary.render().props.onRetry(); assert.equal(reloads, 1);
});
