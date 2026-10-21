import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import * as designSystem from '@ten98/ui';
import { transformWithOxc } from 'vite';
import * as adsView from '../src/ads-view.ts';

const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'), details = await readFile(new URL('../src/AdDetails.tsx', import.meta.url), 'utf8');
const compile = async (source, name) => (await transformWithOxc(source, name, { jsx: { runtime: 'classic' } })).code;
const helpers = ['numeric', 'money', 'compact', 'title'].map(name => main.match(new RegExp(`^const ${name} = .+$`, 'm'))[0]).join('\n');
const now = new Date('2026-10-21T15:30:00Z');

function adsLoader(range = 'default') {
  const source = main.match(/  async function loadAds\([^\n]+/)[0], calls = [], accepted = [], pending = [];
  const context = { adsRange: range, state: { projectId: 'project-a' }, adsRead: { current: 0 }, activeProject: { current: 'project-a' }, run: work => work(), integrate: path => { calls.push(path); return new Promise(resolve => pending.push(resolve)); }, setRemote: update => accepted.push(update({}).ads), adsPath: value => adsView.adsPath(value, now) };
  return { loadAds: new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source.trim())});`)(...Object.values(context)), calls, accepted, pending };
}

test('the default period sends the unchanged ads request and presets send exact provider dates', async () => {
  assert.equal(adsView.adsPath('default', now), 'ads');
  assert.equal(adsView.adsPath('7', now), 'ads?fromDate=2026-10-15&toDate=2026-10-21');
  assert.equal(adsView.adsPath('30', now), 'ads?fromDate=2026-09-22&toDate=2026-10-21');
  assert.equal(adsView.adsPath('90', now), 'ads?fromDate=2026-07-24&toDate=2026-10-21');
  assert.match(main, /\[adsRange, setAdsRange\] = useState\('default'\)/);
  assert.doesNotMatch(main, /integrate\('ads'\)/);
  const ui = adsLoader();
  const first = ui.loadAds(); ui.pending.shift()({ campaigns: ['default'] }); await first;
  assert.deepEqual(ui.calls, ['ads']);
  const older = ui.loadAds('7'), newer = ui.loadAds('90');
  assert.deepEqual(ui.calls.slice(1), ['ads?fromDate=2026-10-15&toDate=2026-10-21', 'ads?fromDate=2026-07-24&toDate=2026-10-21']);
  ui.pending[1]({ campaigns: ['90 days'] }); await newer; ui.pending[0]({ campaigns: ['7 days'] }); await older;
  assert.deepEqual(ui.accepted, [{ campaigns: ['default'] }, { campaigns: ['90 days'] }], 'An older period response cannot replace a newer one.');
});

const rows = [
  { id: 'a', name: 'Spring', platform: 'facebook', accountId: 'meta-1', platformAdAccountName: 'Brand EU', status: 'ACTIVE', currency: 'EUR', adCount: 3, metrics: { spend: 120, impressions: 9000, clicks: 300, ctr: 3.33 } },
  { id: 'b', name: 'Search', platform: 'google', accountId: 'google-1', reviewStatus: 'in_review', status: 'PAUSED', currency: 'USD', metrics: { spend: 480, impressions: 1200 } },
  { id: 'c', name: 'Retarget', platform: 'facebook', accountId: 'meta-1', status: 'PAUSED', metrics: {} }
];

test('the account filter narrows loaded rows and falls back to all accounts', () => {
  assert.deepEqual(adsView.adAccountOptions(rows, value => value.toUpperCase()), [{ value: 'all', label: 'All accounts' }, { value: 'meta-1', label: 'FACEBOOK · Brand EU' }, { value: 'google-1', label: 'GOOGLE · google-1' }]);
  assert.deepEqual(adsView.filterAdAccount(rows, 'meta-1').map(row => row.id), ['a', 'c']);
  assert.deepEqual(adsView.filterAdAccount(rows, 'all').map(row => row.id), ['a', 'b', 'c']);
  assert.deepEqual(adsView.filterAdAccount(rows, 'removed-account').map(row => row.id), ['a', 'b', 'c']);
});

async function campaignColumns(hideAmounts) {
  const source = main.match(/  const adsFigure = [^\n]+\n  const adsColumns = [\s\S]*?\n  \];/)[0];
  const code = await compile(`${helpers}\n${source}\nreturn adsColumns;`, 'AdsColumns.tsx');
  return new Function('React', 'Stack', 'Text', 'Badge', 'campaignFigure', 'campaignSortValue', 'hiddenAmount', 'hideAmounts', code)(React, designSystem.Stack, designSystem.Text, ({ value }) => value, adsView.campaignFigure, adsView.campaignSortValue, adsView.hiddenAmount, hideAmounts);
}
const cell = (columns, key, row) => renderToStaticMarkup(React.createElement(React.Fragment, null, columns.find(column => column.key === key).render(row)));

test('campaign columns show reported figures only and sort locally', async () => {
  const columns = (await campaignColumns(false))(rows), shown = columns.filter(column => !column.hidden).map(column => column.key);
  assert.deepEqual(shown, ['name', 'platform', 'status', 'adCount', 'spend', 'impressions', 'clicks', 'ctr']);
  assert.equal(cell(columns, 'spend', rows[0]), '€120');
  assert.equal(cell(columns, 'clicks', rows[1]), '—');
  assert.equal(cell(columns, 'ctr', rows[0]), '3.33%');
  assert.match(cell(columns, 'name', rows[1]), /Search[\s\S]*in platform review/);
  const sorted = key => designSystem.filterAndSortRows(rows, columns, '', { key, direction: 'desc' }).map(row => row.id);
  assert.deepEqual(sorted('spend'), ['b', 'a', 'c']);
  assert.deepEqual(designSystem.filterAndSortRows(rows, columns, '', { key: 'spend', direction: 'asc' }).map(row => row.id), ['c', 'a', 'b']);
  assert.deepEqual(sorted('clicks'), ['a', 'b', 'c']);
  assert.deepEqual(designSystem.filterAndSortRows(rows, columns).map(row => row.id), ['a', 'b', 'c'], 'Provider order is kept until a column is sorted.');
});

test('hide amounts masks money, persists per browser and tolerates blocked storage', async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  t.after(() => original ? Object.defineProperty(globalThis, 'localStorage', original) : delete globalThis.localStorage);
  const saved = new Map();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) } });
  assert.equal(adsView.readHideAmounts(), false);
  adsView.saveHideAmounts(true);
  assert.deepEqual([...saved], [['ten98-campaign-hide-amounts', '1']]);
  assert.equal(adsView.readHideAmounts(), true);
  const columns = (await campaignColumns(true))(rows);
  assert.equal(cell(columns, 'spend', rows[0]), '••••');
  assert.equal(cell(columns, 'impressions', rows[0]), '9K');
  assert.deepEqual(adsView.adMetricCells({ spend: 5, cpc: 0.4, clicks: 12 }, 'USD', true), [{ label: 'Spend', value: '••••' }, { label: 'Clicks', value: '12' }, { label: 'CPC', value: '••••' }]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('Blocked', 'SecurityError'); } });
  assert.equal(adsView.readHideAmounts(), false);
  assert.doesNotThrow(() => adsView.saveHideAmounts(true));
});

const { code: insightCode } = await transformWithOxc(details.match(/function AdInsight\([\s\S]*?\n\}\n/)[0] + 'return AdInsight;', 'AdInsight.tsx', { jsx: { runtime: 'classic' } });
const AdInsight = new Function('React', 'Card', 'Image', 'Link', 'MetricCard', 'MetricGrid', 'Stack', 'Text', 'adCreativeView', 'adMetricCells', 'readHideAmounts', insightCode)(React, designSystem.Card, designSystem.Image, designSystem.Link, designSystem.MetricCard, designSystem.MetricGrid, designSystem.Stack, designSystem.Text, adsView.adCreativeView, adsView.adMetricCells, () => false);
const insight = props => renderToStaticMarkup(React.createElement(AdInsight, props));

test('the creative pane renders safe creative fields or an empty note', () => {
  assert.match(insight({ ad: { creative: {} } }), /No creative data\./);
  assert.match(insight({ ad: {} }), /No creative data\./);
  const html = insight({ ad: { creative: { imageUrl: 'http://cdn.example.com/a.jpg', thumbnailUrl: 'https://cdn.example.com/thumb.jpg', headline: 'Launch week', body: 'Shop the range', linkUrl: 'https://brand.example.com/launch' } } });
  assert.match(html, /<img[^>]+src="https:\/\/cdn\.example\.com\/thumb\.jpg"[^>]*>/);
  assert.match(html, /referrerPolicy="no-referrer"|referrerpolicy="no-referrer"/);
  assert.match(html, /Launch week[\s\S]*Shop the range/);
  assert.match(html, /href="https:\/\/brand\.example\.com\/launch"/);
  assert.doesNotMatch(html, /No creative data/);
  const unsafe = insight({ ad: { creative: { imageUrl: 'javascript:alert(1)', linkUrl: 'https://user:pass@brand.example.com/', body: 'Text only' } } });
  assert.doesNotMatch(unsafe, /<img|href=/);
  assert.match(unsafe, /Text only/);
});

test('the metrics grid shows only reported metrics, preferring the listed date-scoped figures', () => {
  assert.deepEqual(adsView.adMetricCells({ spend: 1234.5, impressions: 15400, ctr: 1.234, roas: 2.5 }, 'USD').map(item => [item.label, item.value]), [['Spend', '$1,235'], ['Impressions', '15.4K'], ['CTR', '1.23%'], ['ROAS', '2.50×']]);
  assert.deepEqual(adsView.adMetricCells({ videoPlayActions: 900, videoP25WatchedActions: 400, videoP100WatchedActions: 50 }).map(item => item.label), ['Video plays', '25% watched', '100% watched']);
  assert.deepEqual(adsView.adMetricCells({ videoP25WatchedActions: 400 }), [], 'The video funnel needs reported plays.');
  assert.deepEqual(adsView.adMetricCells(undefined), []);
  const html = insight({ ad: { metrics: { spend: 999, clicks: 1 } }, listed: { spend: 12, conversions: 3 }, currency: 'EUR' });
  assert.match(html, /Spend[\s\S]*€12\.00/); assert.match(html, /Conversions/);
  assert.doesNotMatch(html, /Clicks|CPC|CPM|ROAS|Impressions/);
  assert.doesNotMatch(insight({ ad: { creative: {} } }), /Ad metrics/);
  assert.match(insight({ ad: { metrics: { clicks: 4 } }, listed: {} }), /Clicks/);
});
