import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { transformWithOxc } from 'vite';

test('campaign rows open the matching native advertising view and manual records retain their editor', async () => {
  const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'), start = source.indexOf('function openCampaign('), end = source.indexOf('  const campaignTable', start);
  assert.ok(start > 0 && end > start);
  const calls = [], open = new Function('setPage', 'setAdsView', 'setModal', `return (${stripTypeScriptTypes(source.slice(start, end))});`)(value => calls.push(['page', value]), value => calls.push(['view', value]), value => calls.push(['modal', value]));
  for (const [provider, view] of [['googleAdsNative', 'shopping'], ['microsoft', 'microsoft']]) { calls.length = 0; open({ nativeProvider: provider, id: 'native' }); assert.deepEqual(calls, [['page', 'Ads manager'], ['view', view]]); }
  calls.length = 0; const manual = { id: 'manual' }; open(manual); assert.deepEqual(calls, [['modal', { type: 'campaign', item: manual }]]);
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
  const start = source.search(/<div\b[^>]*className="shopping-actions"[^>]*>/), end = source.indexOf('</div>}</section>', start);
  assert.ok(start > 0 && end > start);
  const { code } = await transformWithOxc(`const render = (selectedCampaign, productBids) => (${source.slice(start, end + 6)});`, 'ShoppingControls.tsx', { jsx: { runtime: 'classic' } });
  const noop = () => {}, render = new Function('React', 'busy', 'currency', 'digits', 'updateCampaign', 'loadProductBid', 'saveProductBid', code + '\nreturn render;')(React, false, 'USD', 2, noop, noop, noop);
  const campaigns = ['shopping-a', 'shopping-b'].map(id => ({ id, channel: 'SHOPPING', status: 'PAUSED', budgetPeriod: 'DAILY', appManaged: true }));
  const bids = Object.fromEntries(campaigns.map(row => [row.id, { maxCpcMicros: '1500000' }])), controls = campaigns.map(row => render(row, bids));
  const elements = node => React.isValidElement(node) ? [node, ...[node.props.children].flat(Infinity).flatMap(elements)] : [];
  for (const [index, control] of controls.entries()) {
    assert.equal(control.key, campaigns[index].id, 'A different campaign must reset every uncontrolled input and its confirmation.');
    const inputs = elements(control).filter(node => node.type === 'input');
    assert.deepEqual(inputs.filter(node => node.props.name).map(node => node.props.name).sort(), ['dailyBudget', 'maxCpc']);
    assert.ok(inputs.some(node => node.props.type === 'checkbox' && node.props.required));
  }
  assert.notEqual(controls[0].key, controls[1].key);
});
