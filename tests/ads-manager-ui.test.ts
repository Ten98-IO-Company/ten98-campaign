import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import * as adsView from '../src/ads-view.ts';

// Issue #126: one ads table with level tabs (Campaigns · Ad sets · Ads), one period, network and status filters,
// a totals footer and row-click details. The actual component runs with ordered hook stubs and a stub transport.
const source = await readFile(new URL('../src/AdsManager.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .*;\r?$/gm, '').replace('export default function', 'function'), 'AdsManager.tsx', { jsx: { runtime: 'classic' } });
const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const elements = (node: any): any[] => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...Object.values(node.props as Record<string, unknown>).flatMap(elements)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : React.isValidElement(node) ? text((node.props as any).children) : node == null || typeof node === 'boolean' ? '' : String(node);
const find = (tree: any, type: any, where: (props: any) => boolean = () => true) => elements(tree).filter(node => node.type === type && where(node.props)).map(node => node.props);
const now = new Date('2026-10-21T15:30:00Z');

function mount() {
  const states: any[] = [], refs: any[] = [], effects: any[] = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0;
  const useState = (initial: any) => { const index = stateIndex++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], (value: any) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; };
  const useRef = (initial: any) => refs[refIndex++] ||= { current: initial };
  const useEffect = (callback: () => any, deps: any[]) => { const index = effectIndex++, previous = effects[index]; if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) effects[index] = { deps, callback, cleanup: previous?.cleanup }; };
  const scope = { React, useState, useRef, useEffect, ...ui, ...adsView };
  const Component = new Function(...Object.keys(scope), code + '; return AdsManager;')(...Object.values(scope));
  return {
    render(props: any) { stateIndex = refIndex = effectIndex = 0; return Component(props); },
    flush() { for (const effect of effects) if (effect.callback) { effect.cleanup?.(); effect.cleanup = effect.callback(); effect.callback = null; } },
    unmount() { effects.forEach(effect => effect.cleanup?.()); },
  };
}

const campaigns = [
  { id: 'c1', platformCampaignId: 'p1', name: 'Autumn', platform: 'facebook', accountId: 'meta-1', status: 'ACTIVE', currency: 'AED', adCount: 2, metrics: { spend: 120, impressions: 1000, clicks: 50 }, adSets: [{ platformAdSetId: 's1', adSetName: 'Prospecting', status: 'active', metrics: { spend: 80 } }, { platformAdSetId: 's2', adSetName: 'Retarget', status: 'paused' }] },
  { id: 'c2', platformCampaignId: 'p2', name: 'Brand search', platform: 'google', accountId: 'g-1', status: 'PAUSED', reviewStatus: 'in_review', currency: 'AED', metrics: { spend: 480, impressions: 3000, clicks: 150 }, adSets: [{ platformAdSetId: 'g1', adSetName: 'Exact', status: 'paused' }] },
  { id: 'c3', platformCampaignId: 'p3', name: 'Old', platform: 'tiktok', accountId: 't-1', status: 'completed', currency: 'USD', metrics: {} },
];
const figure = (key: string) => (row: any) => { const value = adsView.campaignFigure(row, key); return value === undefined ? '—' : String(value) + (key === 'spend' ? ' ' + row.currency : ''); };
const columnsFor = (rows: any[]) => [
  { key: 'name', header: 'Campaign', rowHeader: true, sortValue: (row: any) => row.name, render: (row: any) => row.name },
  { key: 'platform', header: 'Network', render: (row: any) => row.platform },
  { key: 'status', header: 'Delivery', render: (row: any) => row.status },
  ...['spend', 'impressions', 'clicks'].map(key => ({ key, header: key, numeric: true, hidden: !rows.some(row => adsView.campaignFigure(row, key) !== undefined), sortValue: (row: any) => adsView.campaignSortValue(row, key), render: figure(key) })),
];

function setup(overrides: any = {}) {
  const calls: string[] = [], events: any[] = [], h = mount();
  const props: any = { view: 'campaigns', connected: true, busy: false, canWrite: true, data: { campaigns }, columns: columnsFor, query: '', range: 'default', account: 'all', hideAmounts: false, network: (platform: string) => platform.charAt(0).toUpperCase() + platform.slice(1), empty: React.createElement('p', null, 'connect'),
    request: async (path: string) => { calls.push(path); return { campaign: { ...campaigns[0], currency: 'AED' }, ads: [{ _id: 'ad-1', name: 'Carousel', status: 'active', platformAdSetId: 's1', metrics: { spend: 40 } }, { _id: 'ad-2', name: 'Story', status: 'paused', platformAdSetId: 's2', metrics: {} }] }; },
    onView: (value: string) => events.push(['view', value]), onLoad: () => events.push(['load']), onOpen: (row: any) => events.push(['open', row.id]), onRange: () => {}, onAccount: () => {}, onHideAmounts: () => {}, rowActions: () => null, ...overrides };
  const draw = (next: any = {}) => { Object.assign(props, next); const tree = h.render(props); h.flush(); return tree; };
  return { calls, events, h, props, draw };
}
const table = (tree: any) => find(tree, ui.DataTable)[0];
const select = (tree: any, label: string) => find(tree, ui.Select, props => props['aria-label'] === label)[0];

test('level tabs name objects, never providers, and old provider sections stay addressable for deep links', () => {
  assert.deepEqual(adsView.adsTabs.map(([, label]) => label), ['Campaigns', 'Ad sets', 'Ads', 'Leads', 'Conversions', 'Activity']);
  for (const [, label] of adsView.adsTabs) assert.doesNotMatch(label, /Google|Microsoft|Meta|Zernio|Provider/);
  // main.tsx is large; boolean checks keep a failure message short.
  assert.ok(/sections\('Advertising sections', [^\n]*adsTabs,/.test(main), 'The ads tabs come from adsTabs.');
  assert.ok(/'Ads manager': \['campaigns', 'adsets', 'ads', 'leads', 'measurement', 'events', 'search', 'shopping', 'microsoft'\]/.test(main), 'Level sections are added and provider sections stay valid.');
  assert.ok(!/Load ad campaigns|\['search', 'Google search'\]|\['microsoft', 'Microsoft Advertising'\]/.test(main), 'No manual load button or provider tabs remain.');
  assert.ok(/<AdsManager key=\{state\.projectId\}/.test(main), 'main.tsx renders the ads manager per project.');
});

test('period, keys and item paths keep the existing request shapes', () => {
  assert.deepEqual(adsView.adsRangeQuery('default', now), {});
  assert.deepEqual(adsView.adsRangeQuery('7', now), { fromDate: '2026-10-15', toDate: '2026-10-21' });
  assert.equal(adsView.adsPath('7', now), 'ads?fromDate=2026-10-15&toDate=2026-10-21');
  const legacy = (c: any) => String(c.id || c._id || [c.platform, c.platformCampaignId || c.campaignId, c.campaignName || c.name].join(':'));
  for (const row of [...campaigns, { platform: 'google', campaignId: 'x', campaignName: 'Y' }]) assert.equal(adsView.campaignKey(row), legacy(row));
  // The drawer reads the same path; the period narrows the figures exactly as the campaign list does.
  assert.equal(adsView.adItemsPath(campaigns[0], 'default', now), 'ads/items?campaignId=p1&platform=facebook');
  assert.equal(adsView.adItemsPath({ id: 'a/b', platform: 'google' }, '7', now), 'ads/items?campaignId=a%2Fb&platform=google&fromDate=2026-10-15&toDate=2026-10-21');
});

test('network and delivery filters use the loaded rows, with direct connections as networks', () => {
  const options = adsView.networkOptions(campaigns, (value: string) => value.toUpperCase());
  assert.deepEqual(options.map(option => [option.value, option.label, option.group]), [['all', 'All networks', undefined], ['facebook', 'FACEBOOK', undefined], ['google', 'GOOGLE', undefined], ['tiktok', 'TIKTOK', undefined], ['shopping', 'Google Shopping', 'Direct connections'], ['microsoft', 'Microsoft Advertising', 'Direct connections'], ['search', 'Google search tools', 'Direct connections']]);
  assert.deepEqual(campaigns.map(adsView.deliveryGroup), ['active', 'review', 'ended']);
  assert.equal(adsView.deliveryGroup({ status: 'paused' }), 'paused');
  assert.deepEqual(campaigns.filter(row => adsView.matchesFilters(row, { network: 'google', status: 'any' })).map(row => row.id), ['c2']);
  assert.deepEqual(campaigns.filter(row => adsView.matchesFilters(row, { network: 'all', status: 'ended' })).map(row => row.id), ['c3']);
});

test('ad sets come from the loaded campaign tree and ads are checked against their campaign', () => {
  const sets = adsView.adSetRows(campaigns);
  assert.deepEqual(sets.map(row => [row.key, row.name, row.platform, row.currency, row.campaign.id]), [['c1/s1', 'Prospecting', 'facebook', 'AED', 'c1'], ['c1/s2', 'Retarget', 'facebook', 'AED', 'c1'], ['c2/g1', 'Exact', 'google', 'AED', 'c2']]);
  const ads = adsView.adRows(campaigns[0], { campaign: { currency: 'EUR' }, ads: [{ _id: 'ad-1', name: '', status: 'active', platformAdSetId: 's1' }] });
  assert.deepEqual(ads.map(row => [row.key, row.name, row.platform, row.currency, row.campaign.id]), [['ad-1', 'Untitled ad', 'facebook', 'EUR', 'c1']]);
  for (const malformed of [null, { ads: 'x' }, { ads: [{ name: 'no id' }] }]) assert.throws(() => adsView.adRows(campaigns[0], malformed), /could not be read/);
});

test('totals add reported figures only and refuse to add money across currencies', () => {
  const same = adsView.levelTotals(campaigns.slice(0, 2));
  assert.deepEqual([same.currency, same.metrics.spend, same.metrics.impressions, same.metrics.clicks, same.metrics.ctr, same.adCount, same.mixedCurrency], ['AED', 600, 4000, 200, 5, 2, false]);
  const mixed = adsView.levelTotals([...campaigns, { platform: 'x', currency: 'USD', metrics: { spend: 10 } }]);
  assert.equal(mixed.metrics.spend, undefined); assert.equal(mixed.mixedCurrency, true);
  const none = adsView.levelTotals([campaigns[2]]);
  assert.equal(none.metrics.clicks, undefined, 'Missing figures stay missing, never 0.'); assert.equal(none.metrics.ctr, undefined);
});

test('the campaign list loads on view once, sorts by spend and opens details from a row', async () => {
  const ui1 = setup({ data: undefined });
  ui1.draw(); ui1.draw(); await settle(); ui1.draw();
  assert.deepEqual(ui1.events, [['load']], 'One automatic read per empty view; a failed read does not loop.');
  const ui2 = setup({ connected: false, data: undefined }), tree = ui2.draw();
  assert.deepEqual(ui2.events, []); assert.ok(elements(tree).some(node => node.type === 'p' && text(node) === 'connect'));
  assert.ok(select(tree, 'Network'), 'Direct networks stay reachable without the shared connection.');
  const { draw, events } = setup(), view = draw(), grid = table(view);
  assert.equal(grid.selectable, true); assert.equal(grid.stickyHeader, true); assert.deepEqual(grid.sort, { key: 'spend', direction: 'desc' });
  assert.deepEqual(grid.rows.map((row: any) => row.id), ['c2', 'c1', 'c3']);
  assert.match(text(grid.footerCells[0]), /^Totals · 3 campaigns$/);
  assert.equal(text(grid.footerCells[3]), '600 AED', 'A campaign without reported spend adds no currency.');
  grid.onRowActivate(campaigns[0], 'c1'); assert.deepEqual(events.at(-1), ['open', 'c1']);
  assert.ok(elements(view).some(node => text(node).startsWith('Updated ')));
  find(view, ui.Button, props => text(props.children) === 'Refresh')[0].onClick(); assert.deepEqual(events.at(-1), ['load']);
});

test('network and status filters narrow the table, show as applied filters and clear', () => {
  const { draw } = setup();
  select(draw(), 'Network').onChange({ currentTarget: { value: 'facebook' }, target: { value: 'facebook' } });
  let view = draw(), grid = table(view);
  assert.deepEqual(grid.rows.map((row: any) => row.id), ['c1']);
  assert.match(text(grid.footerCells[0]), /^Totals · 1 campaign \(filtered\)$/);
  assert.equal(text(grid.footerCells[3]), '120 AED');
  const applied = find(view, ui.AppliedFilters)[0];
  assert.deepEqual(applied.filters.map((row: any) => [row.label, row.value]), [['Network', 'Facebook']]);
  applied.onClear(); view = draw();
  assert.equal(table(view).rows.length, 3); assert.equal(find(view, ui.AppliedFilters).length, 0);
  select(view, 'Status').onChange({ currentTarget: { value: 'review' }, target: { value: 'review' } });
  assert.deepEqual(table(draw()).rows.map((row: any) => row.id), ['c2']);
});

test('direct networks open their own view in place of the shared table', () => {
  const { draw, events } = setup();
  select(draw(), 'Network').onChange({ currentTarget: { value: 'shopping' }, target: { value: 'shopping' } });
  assert.deepEqual(events.at(-1), ['view', 'shopping']);
  const view = draw({ view: 'shopping' });
  assert.equal(table(view), undefined); assert.equal(select(view, 'Network').value, 'shopping');
  assert.equal(find(view, ui.SegmentedControl).length, 0, 'The shared period does not apply to a direct connection.');
  select(view, 'Network').onChange({ currentTarget: { value: 'all' }, target: { value: 'all' } });
  assert.deepEqual(events.at(-1), ['view', 'campaigns']);
});

test('selecting campaigns filters ad sets without any request, and ad sets filter ads read for the period', async () => {
  const { draw, calls, events } = setup({ range: '7' });
  let sets = table(draw({ view: 'adsets' }));
  assert.deepEqual(sets.rows.map((row: any) => row.key), ['c1/s1', 'c1/s2', 'c2/g1']);
  assert.ok(sets.columns.some((column: any) => column.key === 'campaign'));
  table(draw({ view: 'campaigns' })).onSelectionChange(['c1']);
  sets = table(draw({ view: 'adsets' }));
  assert.deepEqual(sets.rows.map((row: any) => row.key), ['c1/s1', 'c1/s2']);
  assert.match(text(sets.footerCells[0]), /^Totals · 2 ad sets \(filtered\)$/);
  sets.onRowActivate(sets.rows[0], 'c1/s1'); assert.deepEqual(events.at(-1), ['open', 'c1']);
  assert.deepEqual(calls, []);
  sets.onSelectionChange(['c1/s1']);
  draw({ view: 'ads' }); await settle();
  const ads = table(draw({ view: 'ads' }));
  assert.deepEqual(calls, [adsView.adItemsPath(campaigns[0], '7')]); assert.match(calls[0], /^ads\/items\?campaignId=p1&platform=facebook&fromDate=\d{4}-\d\d-\d\d&toDate=\d{4}-\d\d-\d\d$/);
  assert.deepEqual(ads.rows.map((row: any) => row.key), ['ad-1']);
  draw({ view: 'ads' }); await settle(); assert.equal(calls.length, 1, 'A loaded campaign is not read again.');
});

test('the ads level asks for a selection before reading anything', () => {
  const { draw, calls, events } = setup(), view = draw({ view: 'ads' });
  assert.equal(table(view), undefined); assert.deepEqual(calls, []);
  const empty = find(view, ui.EmptyState)[0]; assert.match(empty.title, /Select campaigns/);
  find(empty.action, ui.Button)[0].onClick(); assert.deepEqual(events.at(-1), ['view', 'campaigns']);
});

test('an empty level says nothing is reported, while filtered rows point to the filters', () => {
  const { draw } = setup({ data: { campaigns: [campaigns[2]] } });
  const sets = table(draw({ view: 'adsets' }));
  assert.deepEqual([sets.emptyTitle, sets.emptyDescription], ['No ad sets reported', 'Ad sets appear here once your networks report them.']);
  select(draw({ view: 'campaigns' }), 'Status').onChange({ currentTarget: { value: 'active' }, target: { value: 'active' } });
  const list = table(draw());
  assert.deepEqual([list.emptyTitle, list.emptyDescription], ['No campaigns match these filters', 'Change or clear the filters above.']);
});
