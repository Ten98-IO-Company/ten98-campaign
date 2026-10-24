import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import { postDisplayStatus } from '../shared/post-schedule.ts';

// The campaign page with controlled hook state; it only calls the callbacks the app passes in.
type Row = { id: string; [key: string]: any };
const raw = await readFile(new URL('../src/CampaignDetail.tsx', import.meta.url), 'utf8');
const body = raw.replace(/^import .*;\r?\n/gm, '').replace(/^export type .*;\r?\n/gm, '').replace(/^export (default )?function/gm, 'function');
const { code } = await transformWithOxc(body, 'CampaignDetail.tsx', { jsx: { runtime: 'classic' }, lang: 'tsx' });
const names = ['Button', 'Card', 'DataTable', 'EmptyState', 'Heading', 'Icon', 'Inline', 'MetricCard', 'MetricGrid', 'Popover', 'SegmentedControl', 'Stack', 'Tabs', 'Text'] as const;
const { CampaignDetail, campaignItems, campaignResults } = new Function('React', 'useState', 'useEffect', 'postDisplayStatus', ...names, code + '; return { CampaignDetail, campaignItems, campaignResults };')(
  React, (initial: unknown) => [initial, () => {}], () => {}, postDisplayStatus, ...names.map(name => (ui as Record<string, unknown>)[name]));

const campaign = { id: 'c1', name: 'Autumn launch', status: 'active', startDate: '2030-10-01', endDate: '2030-10-31', budget: 1000, spent: 250, currency: 'AED' };
const posts = [{ id: 'p1', campaignId: 'c1', status: 'scheduled', scheduledAt: '2999-01-02T09:00:00.000Z', content: 'Hello' }, { id: 'p2', campaignId: 'other', status: 'draft', content: 'Elsewhere' }];
const placements = [{ id: 'b1', campaignId: 'c1', name: 'Sheikh Zayed Road', status: 'booked', startDate: '2030-10-05' }];
const activations = [{ id: 'a1', campaignId: 'c1', name: 'Mall roadshow', status: 'planned', startAt: '2030-10-10T10:00:00.000Z' }];
const props = (extra: Record<string, unknown> = {}) => ({ campaign, posts, placements, activations, canWrite: true, money: (value: unknown, currency = 'AED') => `${currency} ${value}`, date: (value: string) => value.slice(0, 10), statusBadge: (status: string) => React.createElement('span', null, status), postTitle: (post: Row) => post.content, onBack() {}, onEdit() {}, onAdd() {}, onOpen() {}, ...extra });

test('a campaign gathers every post, billboard booking and field activity that names it, newest first', () => {
  const items = campaignItems('c1', posts, placements, activations, (post: Row) => post.content);
  assert.deepEqual(items.map((item: { kind: string; row: Row }) => item.kind + ':' + item.row.id), ['post:p1', 'activation:a1', 'placement:b1']);
  assert.equal(campaignItems('none', posts, placements, activations, () => '').length, 0);
});

test('the page shows budget, spent and remaining, and offers Add and Edit only to people who can change it', () => {
  const html = renderToStaticMarkup(React.createElement(CampaignDetail, props()));
  assert.match(html, /Autumn launch/); assert.match(html, /AED 1000/); assert.match(html, /AED 250/); assert.match(html, /AED 750/);
  assert.match(html, />Add</); assert.match(html, />Edit</); assert.match(html, /Items · 3/); assert.match(html, /All campaigns/);
  const readOnly = renderToStaticMarkup(React.createElement(CampaignDetail, props({ canWrite: false })));
  assert.doesNotMatch(readOnly, />Add</); assert.doesNotMatch(readOnly, />Edit</);
});

test('viewers and network-managed campaigns get View details, which opens the same read-only dialog', () => {
  const walk = (node: any): any[] => Array.isArray(node) ? node.flatMap(walk) : !React.isValidElement(node) ? [] : [node, ...Object.values(node.props as Record<string, unknown>).flatMap(value => Array.isArray(value) || React.isValidElement(value) ? walk(value) : [])];
  for (const [label, extra] of [['viewer', { canWrite: false }], ['synced from an ad network', { campaign: { ...campaign, externalId: 'meta-123' } }], ['native Google campaign', { campaign: { ...campaign, nativeProvider: 'googleAdsNative' } }]] as const) {
    let opened = 0;
    const button = walk(CampaignDetail(props({ ...extra, onEdit: () => { opened++; } }))).find(node => node.type === ui.Button && node.props.children === 'View details');
    assert.ok(button, label + ' sees View details'); button.props.onClick(); assert.equal(opened, 1, label + ' opens the campaign dialog');
  }
  assert.ok(walk(CampaignDetail(props())).some(node => node.type === ui.Button && node.props.children === 'Edit'), 'An editor of a local campaign sees Edit.');
});

test('Add lists every kind of work, and choosing one hands that kind to the app', () => {
  const added: string[] = [];
  const tree = CampaignDetail(props({ onAdd: (kind: string) => added.push(kind) }));
  const walk = (node: any): any[] => Array.isArray(node) ? node.flatMap(walk) : !React.isValidElement(node) ? [] : [node, ...Object.values(node.props as Record<string, unknown>).flatMap(value => Array.isArray(value) || React.isValidElement(value) ? walk(value) : [])];
  const popover = walk(tree).find(node => node.type === ui.Popover);
  const choices = walk(popover.props.children).filter(node => node.type === ui.Button);
  assert.deepEqual(choices.map(node => node.props.children), ['Post', 'Billboard booking', 'Field activity', 'Email or SMS', 'Ad', 'Link or QR code']);
  for (const choice of choices) choice.props.onClick();
  assert.deepEqual(added, ['post', 'placement', 'activation', 'message', 'ad', 'link']);
});

test('a dated local post reads Planned; only a post a network holds reads Scheduled', () => {
  assert.equal(postDisplayStatus({ status: 'scheduled' }), 'planned');
  assert.equal(postDisplayStatus({ status: 'scheduled', externalId: 'zernio-1' }), 'scheduled');
  assert.equal(postDisplayStatus({ status: 'published', externalId: 'zernio-1' }), 'published');
  assert.equal(postDisplayStatus({}), 'draft');
  const items = campaignItems('c1', [{ id: 'p1', campaignId: 'c1', status: 'scheduled', scheduledAt: '2999-01-02T09:00:00.000Z' }, { id: 'p2', campaignId: 'c1', status: 'scheduled', externalId: 'x', scheduledAt: '2999-01-03T09:00:00.000Z' }], [], [], () => 'Post');
  assert.deepEqual(items.map((item: { row: Row; status: string }) => item.row.id + ':' + item.status), ['p2:scheduled', 'p1:planned']);
});

test('Results add up what this campaign produced and say Not reported instead of 0 when a source has nothing yet', () => {
  const results = (loaded: Record<string, unknown>) => Object.fromEntries(campaignResults({ ...campaign, impressions: 1200, conversions: undefined }, [{ id: 'p1', campaignId: 'c1', status: 'published' }, { id: 'p2', campaignId: 'c1', status: 'draft' }, { id: 'p3', campaignId: 'other', status: 'published' }],
    [{ id: 'b1', campaignId: 'c1', status: 'live' }, { id: 'b2', campaignId: 'c1', status: 'draft' }], [{ id: 'a1', campaignId: 'c1', reached: 40 }, { id: 'a2', campaignId: 'c1', reached: 10 }, { id: 'a3', campaignId: 'other', reached: 99 }], loaded).map((result: { label: string; value: number | null }) => [result.label, result.value]));
  const full = results({ links: { totals: { clicks: 5, qrScans: 2 } }, activations: { a1: { leads: 3 }, a2: { leads: 1 }, a3: { leads: 50 } } });
  assert.deepEqual(full, { 'Link clicks': 5, 'QR scans': 2, 'Leads captured': 4, 'People reached': 50, 'Posts published': 1, 'Billboards booked': 1, Impressions: 1200, Conversions: null });
  const empty = results({});
  assert.deepEqual([empty['Link clicks'], empty['QR scans'], empty['Leads captured']], [null, null, null], 'Unloaded or failed sources are not reported, not zero.');
  assert.equal(Object.fromEntries(campaignResults(campaign, [], [], [], { activations: {} }).map((result: { label: string; value: number | null }) => [result.label, result.value]))['Leads captured'], null, 'No field activity means no leads to report, not 0.');
});

test('the campaign page has a Results tab next to Overview and Items', () => {
  const walk = (node: any): any[] => Array.isArray(node) ? node.flatMap(walk) : !React.isValidElement(node) ? [] : [node, ...Object.values(node.props as Row).flatMap(value => Array.isArray(value) || React.isValidElement(value) ? walk(value) : [])];
  const tabs = walk(CampaignDetail(props())).find(node => node.type === ui.Tabs);
  assert.deepEqual(tabs.props.items.map((item: Row) => item.value), ['overview', 'results', 'items']);
});

test('Results reads this campaign’s links and field results only when its tab opens, and says when a read fails', async () => {
  const { hooks, nodes } = await import('./hook-recorder.ts');
  const tick = () => new Promise(resolve => setImmediate(resolve));
  const mount = async (extra: Record<string, unknown>, answer: (path: string) => Promise<unknown>) => {
    const h = hooks(), reads: string[] = [];
    const { CampaignDetail: Detail } = new Function('React', 'useState', 'useEffect', 'postDisplayStatus', ...names, code + '; return { CampaignDetail };')(React, h.useState, h.useEffect, postDisplayStatus, ...names.map(name => (ui as Record<string, unknown>)[name]));
    const all = props({ projectId: 'p 1', request: (path: string) => { reads.push(path); return answer(path); }, ...extra });
    const tabs = () => nodes(h.render(Detail, all)).find(node => node.type === ui.Tabs);
    tabs(); h.flush(); await tick();
    const closed = [...reads];
    tabs().props.onValueChange('results'); tabs(); h.flush(); await tick(); await tick();
    const shown = nodes(nodes(h.render(Detail, all)).find(node => node.type === ui.Tabs).props.items.find((item: Row) => item.value === 'results').content);
    const card = (label: string) => shown.find(node => node.type === ui.MetricCard && node.props.label === label).props;
    return { closed, reads, card };
  };
  const day = 86400000, ago = (days: number) => new Date(Date.now() - days * day).toISOString().slice(0, 10);
  const ok = async (path: string) => path.includes('/links/analytics') ? { totals: { clicks: 7, qrScans: 3 } } : { results: { a1: { leads: 2 } } };
  const opened = await mount({ campaign: { ...campaign, id: 'c/1', startDate: ago(9) } }, ok);
  assert.deepEqual(opened.closed, [], 'Nothing is read while the Results tab is closed.');
  assert.deepEqual(opened.reads, ['/projects/p%201/links/analytics?days=10&campaignId=c%2F1', '/projects/p%201/activations/results'], 'Links are filtered to this campaign, over the campaign so far.');
  assert.equal(opened.card('Link clicks').value, '7'); assert.equal(opened.card('QR scans').value, '3');
  for (const [start, days] of [[ago(900), 365], [new Date(Date.now() + 5 * day).toISOString().slice(0, 10), 1], ['', 30]] as const) {
    const view = await mount({ campaign: { ...campaign, startDate: start } }, ok);
    assert.match(view.reads[0], new RegExp('[?]days=' + days + '&'), `start ${start || 'unset'} reads ${days} days`);
  }
  const refused = await mount({ campaign: { ...campaign }, activations: [{ id: 'a1', campaignId: 'c1', reached: 4 }] }, async () => { throw new Error('Forbidden'); });
  assert.equal(refused.card('Link clicks').unavailable, 'Couldn’t load', 'A refused read says so instead of looking like no data.');
  assert.equal(refused.card('Leads captured').unavailable, 'Couldn’t load');
  assert.equal(refused.card('Conversions').unavailable, 'Not reported yet', 'A total nobody entered is simply not reported.');
});
