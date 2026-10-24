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
const body = raw.replace(/^import .*;\r?\n/gm, '').replace(/^export type .*;\r?\n/gm, '').replace('export function campaignItems', 'function campaignItems').replace('export default function', 'function');
const { code } = await transformWithOxc(body, 'CampaignDetail.tsx', { jsx: { runtime: 'classic' }, lang: 'tsx' });
const names = ['Button', 'Card', 'DataTable', 'EmptyState', 'Heading', 'Icon', 'Inline', 'MetricCard', 'MetricGrid', 'Popover', 'SegmentedControl', 'Stack', 'Tabs', 'Text'] as const;
const { CampaignDetail, campaignItems } = new Function('React', 'useState', 'postDisplayStatus', ...names, code + '; return { CampaignDetail, campaignItems };')(
  React, (initial: unknown) => [initial, () => {}], postDisplayStatus, ...names.map(name => (ui as Record<string, unknown>)[name]));

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
