// ten98-campaign#219: Reports › Links, Messages and Field activity. Each report is mounted with recorded hooks so its
// read really runs; the recorded request answers in memory and nothing leaves the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import { hooks, nodes } from './hook-recorder.ts';
import { readText } from './read-text.ts';

type Row = Record<string, any>;
const source = (await readFile(new URL('../src/ChannelReports.tsx', import.meta.url), 'utf8')).replace(/^import .+;\r?\n/gm, '').replace(/^export (default )?/gm, '');
const { code } = await transformWithOxc(source, 'ChannelReports.tsx', { jsx: { runtime: 'classic' }, lang: 'tsx' });
const library = ui as unknown as Record<string, unknown>;
const tick = () => new Promise(resolve => setImmediate(resolve));

async function mount(name: 'LinkReport' | 'MessageReport' | 'FieldReport', props: Row, answer: (path: string) => Promise<unknown>) {
  const h = hooks(), reads: string[] = [];
  const module = new Function('React', 'useEffect', 'useState', ...Object.keys(library), code + '; return { LinkReport, MessageReport, FieldReport };')(React, h.useEffect, h.useState, ...Object.values(library));
  const all = { projectId: 'p 1', request: (path: string) => { reads.push(path); return answer(path); }, ...props };
  const render = () => h.render(module[name], all);
  render(); h.flush(); await tick(); await tick();
  return { reads, render, flush: async () => { h.flush(); await tick(); await tick(); }, text: () => readText(renderToStaticMarkup(React.createElement(React.Fragment, null, render() as React.ReactNode))) };
}
const cards = (tree: unknown) => Object.fromEntries(nodes(tree).filter(node => node.type === ui.MetricCard).map(node => [node.props.label, node.props.value]));
const refuse = async () => { throw new Error('Forbidden'); };

test('Links reads every short link over the last 30 days, shows clicks, scans and visits, and re-reads when the period changes', async () => {
  const view = await mount('LinkReport', {}, async () => ({ totals: { clicks: 12, qrScans: 4, pageviews: 30, events: 2 }, pages: [{ path: '/launch', count: 20 }] }));
  assert.deepEqual(view.reads, ['/projects/p%201/links/analytics?days=30']);
  const tree = view.render();
  assert.deepEqual(cards(tree), { 'Link clicks': '12', 'QR scans': '4', 'Website visits': '30', Actions: '2' });
  assert.ok(nodes(tree).some(node => node.type === ui.BarList && node.props.items[0].label === '/launch'));
  nodes(tree).find(node => node.type === ui.Select).props.onChange({ target: { value: '7' } }); view.render(); await view.flush();
  assert.equal(view.reads.at(-1), '/projects/p%201/links/analytics?days=7');
  assert.match((await mount('LinkReport', {}, refuse)).text(), /Couldn’t load these results/);
});

test('Messages totals every send that went out, never drafts, and says when there is nothing yet', async () => {
  const campaigns = [{ id: 'm1', name: 'Receipt', channel: 'email', status: 'completed', counts: { delivered: 90, failed: 3, suppressed: 7, pending: 0, accepted: 0 } }, { id: 'm2', name: 'Reminder', channel: 'sms', status: 'sending', counts: { delivered: 10, failed: 1, suppressed: 0, pending: 4, accepted: 1 } }, { id: 'm3', name: 'Draft', channel: 'email', status: 'draft', counts: { delivered: 0 } }];
  const view = await mount('MessageReport', {}, async () => ({ campaigns }));
  assert.deepEqual(view.reads, ['/projects/p%201/direct/campaigns']);
  const tree = view.render();
  assert.deepEqual(cards(tree), { Sends: '2', Delivered: '100', 'Not delivered': '4', Skipped: '7' });
  assert.deepEqual(nodes(tree).find(node => node.type === ui.DataTable).props.rows.map((row: Row) => row.id), ['m1', 'm2']);
  assert.match((await mount('MessageReport', {}, async () => ({ campaigns: [campaigns[2]] }))).text(), /No messages sent yet/);
  assert.match((await mount('MessageReport', {}, refuse)).text(), /Couldn’t load these results/);
});

test('Field activity adds leads, reach and spend across activities, and says when leads could not load', async () => {
  const activations = [{ id: 'a1', name: 'Mall stop', campaignId: 'c1', reached: 40, spent: 300 }, { id: 'a2', name: 'Street team', campaignId: 'c1', reached: 10, spent: 200 }];
  const props = { activations, campaigns: [{ id: 'c1', name: 'Launch', currency: 'AED' }], money: (value: unknown, currency = 'AED') => `${currency} ${value}` };
  const view = await mount('FieldReport', props, async () => ({ results: { a1: { leads: 5 }, a2: { leads: 2 } } }));
  assert.deepEqual(view.reads, ['/projects/p%201/activations/results']);
  assert.deepEqual(cards(view.render()), { Activities: '2', 'Leads captured': '7', 'People reached': '50', Spent: 'AED 500' });
  assert.equal(cards((await mount('FieldReport', props, refuse)).render())['Leads captured'], 'Couldn’t load');
  assert.match((await mount('FieldReport', { ...props, activations: [] }, async () => ({ results: {} }))).text(), /No field activity yet/);
});

test('Reports keeps five tabs: Overview, Social accounts, Links, Messages and Field activity', async () => {
  const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.match(main, /Analytics: \['summary', 'accounts', 'links', 'messages', 'offline'\]/);
  assert.match(main, /label: 'Social accounts' \}, \{ page: 'Analytics', sections: \['links'\], label: 'Links' \}, \{ page: 'Analytics', sections: \['messages'\], label: 'Messages' \}, \{ page: 'Analytics', sections: \['offline'\], label: 'Field activity' \}/);
  assert.match(main, /\{page === 'Analytics' && \['summary', 'accounts'\]\.includes\(insightsView\) && /, 'The account report no longer catches the new tabs.');
});

test('Field activity totals spend per currency and never adds amounts in different currencies', async () => {
  const activations = [{ id: 'a1', campaignId: 'dubai', reached: 1, spent: 300 }, { id: 'a2', campaignId: 'dubai', reached: 1, spent: 200 }, { id: 'a3', campaignId: 'london', reached: 1, spent: 150 }];
  const campaigns = [{ id: 'dubai', name: 'Dubai launch', currency: 'AED' }, { id: 'london', name: 'London launch', currency: 'GBP' }];
  const view = await mount('FieldReport', { activations, campaigns, money: (value: unknown, currency = 'AED') => `${currency} ${value}` }, async () => ({ results: {} }));
  const spent = nodes(view.render()).find(node => node.type === ui.MetricCard && node.props.label === 'Spent').props;
  assert.equal(spent.value, 'AED 500 · GBP 150', 'Each currency keeps its own total.');
  assert.equal(spent.hint, 'Per currency, never added together');
  assert.doesNotMatch(spent.value, /650/, 'AED and GBP are never summed into one number.');
  const single = await mount('FieldReport', { activations: activations.slice(0, 2), campaigns, money: (value: unknown, currency = 'AED') => `${currency} ${value}` }, async () => ({ results: {} }));
  assert.equal(nodes(single.render()).find(node => node.type === ui.MetricCard && node.props.label === 'Spent').props.value, 'AED 500');
});
