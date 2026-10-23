import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import * as social from '../shared/social-posts.ts';

// Evaluate Campaign's real PostComposer with React's hooks mocked by call order, as the other composer tests do.
const source = await readFile(new URL('../src/PostComposer.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .*;\r?\n/gm, '').replace('export default function PostComposer', 'function PostComposer').replace('export function PostVariantPreview', 'function PostVariantPreview').replace('export const accountLabel', 'const accountLabel'), 'PostComposer.tsx', { jsx: { runtime: 'classic' } });
type Node = { type: unknown; props: Record<string, any> };
const nodes = (node: any): Node[] => !node || typeof node !== 'object' ? [] : [node, ...[...React.Children.toArray(node.props?.children), ...(node.props?.items || []).map((item: any) => item?.content)].flatMap(nodes)];
const text = (node: any): string => typeof node === 'string' || typeof node === 'number' ? String(node) : !node || typeof node !== 'object' ? '' : React.Children.toArray(node.props?.children).map(text).join('');
const tick = () => new Promise(resolve => setImmediate(resolve));
function ToolsProbe() { return null; }

function mount(initialProps: Record<string, any>) {
  const hooks: any[] = [], queued: (() => void)[] = []; let cursor = 0, dirty = true, tree: any, props = initialProps;
  const useState = (initial: unknown) => { const index = cursor++; hooks[index] ||= { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, (update: unknown) => { const next = typeof update === 'function' ? update(hooks[index].value) : update; if (!Object.is(next, hooks[index].value)) { hooks[index].value = next; dirty = true; } }]; };
  const useRef = (initial: unknown) => { const index = cursor++; return hooks[index] ||= { current: initial }; };
  const useEffect = (run: () => (() => void) | void, dependencies: unknown[]) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) { hooks[index] = { dependencies, close: old?.close }; queued.push(() => { hooks[index].close?.(); hooks[index].close = run(); }); } };
  const context = { ...ui, ...social, MediaImage: ui.Image, React, useState, useRef, useEffect, useMemo: (compute: () => unknown) => compute(), useId: () => 'composer', createPortal: (node: unknown) => node, InstagramPublishingTools: ToolsProbe, TikTokPublishingTools: ToolsProbe };
  const Composer = new Function(...Object.keys(context), code + ';return PostComposer;')(...Object.values(context));
  function paint() { for (let pass = 0; dirty; pass++) { assert.ok(pass < 20, 'Rendering settles.'); dirty = false; cursor = 0; tree = Composer(props); while (queued.length) queued.shift()!(); } }
  const find = (predicate: (node: Node) => boolean) => nodes(tree).find(predicate);
  const all = (predicate: (node: Node) => boolean) => nodes(tree).filter(predicate);
  const button = (label: string) => find(node => node.type === ui.Button && text(node) === label);
  paint();
  return {
    find, all, button, paint,
    html: () => renderToStaticMarkup(tree),
    snapshot: () => JSON.parse(find(node => node.props?.name === 'draftSnapshot')!.props.value),
    field: (label: string) => nodes(find(node => node.type === ui.Field && node.props.label === label)).find(node => [ui.Input, ui.Select, ui.Textarea].includes(node.type as any)),
    click: async (label: string) => { const target = button(label); assert.ok(target, label); const pending = target.props.onClick?.({ preventDefault() {} }); paint(); await pending; await tick(); paint(); },
    type: (label: string, value: string) => { const input = nodes(find(node => node.type === ui.Field && node.props.label === label)).find(node => [ui.Input, ui.Select, ui.Textarea].includes(node.type as any)); assert.ok(input, label); input.props.onChange({ target: { value } }); paint(); },
    pick: (ids: string[]) => { find(node => node.type === ui.DestinationPicker)!.props.onSelectionChange(ids); paint(); },
    key: async (event: Record<string, unknown>) => { find(node => node.type === ui.Form)!.props.onKeyDown({ preventDefault() {}, ...event }); paint(); await tick(); paint(); },
    settle: async () => { await tick(); paint(); },
  };
}
const accounts = [{ id: 'fb-a', platform: 'facebook', displayName: 'Brand page', isActive: true }, { id: 'ig-a', platform: 'instagram', displayName: 'Brand gram', isActive: true }];
// The editor passes onLoadAccounts only to projects with a social publishing connection.
const base = { assets: [], campaigns: [{ id: 'launch', name: 'Launch' }], canWrite: true, onSubmit: async () => {}, onLoadAccounts: async () => ({}) };

test('caption usage counts each network against its own limit and names the reason it is over', () => {
  const post = { content: 'a'.repeat(2201), platforms: ['instagram', 'twitter', 'facebook'], mediaItems: [] };
  const usage = social.captionUsage(post, post.platforms, []);
  assert.deepEqual(usage.map(row => [row.label, row.count, row.limit, row.tone]), [['Instagram', 2201, 2200, 'error'], ['X', 2201, 280, 'warning'], ['Facebook', 2201, 63206, 'ok']]);
  assert.equal(usage[0].message, 'Caption has 2,201 characters; Instagram allows 2,200.');
  assert.match(usage[1].message || '', /paid X account/);
  assert.equal(usage[2].message, undefined);
  assert.deepEqual(social.captionUsage({ content: '', platforms: ['whatsapp'] }, ['whatsapp'], []), [], 'Platforms without social posting have no counter.');
});

test('the composer is two panes: destinations and caption first, the live preview beside them', () => {
  const view = mount({ ...base, accounts }), html = view.html();
  const panes = view.find(node => node.type === ui.Grid && node.props.columns === 2);
  assert.ok(panes, 'The editor and preview sit in a two-column grid.');
  const [editor, preview] = React.Children.toArray(panes.props.children) as any[];
  assert.ok(nodes(editor).some(node => node.type === ui.Field && node.props.label === 'Caption'), 'The caption is in the editor pane.');
  assert.equal(preview.props['aria-label'], 'Post preview');
  assert.doesNotMatch(html, /Start with shared content/, 'No intro paragraph above the work.');
  assert.doesNotMatch(html, /<h3[^>]*>\d\. /, 'No numbered steps.');
  assert.ok(html.indexOf('Post to') < html.indexOf('>Caption<'), 'Destinations come before the caption.');
  view.pick(['ig-a']); view.type('Caption', 'Hello launch');
  assert.match(renderToStaticMarkup(view.find(node => node.props?.['aria-label'] === 'Post preview') as any), /Hello launch/, 'The preview follows the caption as you type.');
});

test('connected accounts are the destinations; platform boxes appear only without accounts', () => {
  const view = mount({ ...base, accounts });
  const picker = view.find(node => node.type === ui.DestinationPicker)!;
  assert.deepEqual(picker.props.accounts.map((row: any) => row.id), ['fb-a', 'ig-a'], 'Every connected account is offered before any platform is chosen.');
  assert.equal(view.find(node => node.type === ui.CheckboxGroup), undefined);
  view.pick(['ig-a']); assert.deepEqual(view.snapshot().platforms, ['instagram']); assert.deepEqual(view.snapshot().accounts, ['ig-a']);
  view.pick(['ig-a', 'fb-a']); assert.deepEqual(view.snapshot().platforms, ['instagram', 'facebook']);
  view.pick(['fb-a']); assert.deepEqual(view.snapshot().platforms, ['facebook'], 'Removing the last account of a network removes the network.');
  view.button('Select all')!.props.onClick(); view.paint(); assert.deepEqual(view.snapshot().accounts, ['fb-a', 'ig-a']);
  const empty = mount({ ...base, accounts: [] });
  assert.ok(empty.find(node => node.type === ui.CheckboxGroup), 'Without accounts the platform boxes allow a platform draft.');
  assert.match(empty.html(), /No social accounts connected/);
  const kept = mount({ ...base, accounts, post: { content: 'Saved', platforms: ['linkedin', 'facebook'], accounts: ['fb-a'], mediaItems: [] } });
  assert.ok(kept.find(node => node.type === ui.CheckboxGroup), 'A saved platform without a connected account stays removable.');
  kept.pick(['fb-a', 'ig-a']); assert.deepEqual(kept.snapshot().platforms, ['linkedin', 'facebook', 'instagram'], 'Adding an account keeps the saved platforms.');
});

test('per-network counters sit under the caption and an over-limit network is red with its reason', () => {
  const view = mount({ ...base, accounts, post: { content: 'a'.repeat(2201), platforms: ['instagram', 'facebook'], accounts: ['ig-a', 'fb-a'], mediaItems: [] } });
  const over = view.find(node => node.type === ui.Text && node.props.tone === 'danger' && text(node) === 'Instagram 2,201/2,200');
  assert.ok(over, 'Instagram shows a red counter.');
  assert.ok(view.find(node => node.type === ui.Text && node.props.tone === 'danger' && text(node).includes('Caption has 2,201 characters; Instagram allows 2,200.')), 'The reason is named.');
  assert.ok(view.find(node => node.type === ui.Text && node.props.tone === 'muted' && text(node) === 'Facebook 2,201/63,206'));
});

test('per-network tabs open on request and extras are collapsed under More options', () => {
  const fresh = mount({ ...base, accounts, post: { content: 'Hi', platforms: ['facebook'], accounts: ['fb-a'], mediaItems: [] } });
  const customize = fresh.find(node => node.type === ui.Disclosure && node.props.summary === 'Customize per network')!;
  assert.ok(customize); assert.equal(customize.props.defaultOpen, false);
  assert.ok(nodes(customize).some(node => node.type === ui.Tabs), 'The platform tabs live inside the Customize disclosure.');
  const more = fresh.find(node => node.type === ui.Disclosure && node.props.summary === 'More options')!;
  assert.ok(nodes(more).some(node => node.type === ui.Field && node.props.label === 'Campaign'));
  const custom = mount({ ...base, accounts, post: { content: 'Hi', platforms: ['facebook'], accounts: ['fb-a'], mediaItems: [], platformOverrides: { facebook: { content: 'Own copy' } } } });
  assert.equal(custom.find(node => node.type === ui.Disclosure && node.props.summary === 'Customize per network')!.props.defaultOpen, true, 'A post with its own network copy opens with the tabs shown.');
});

test('Schedule picks a time in at most three clicks, runs the post check and saves the planned post', async () => {
  const saved: any[] = [], checked: any[] = [];
  const view = mount({ ...base, accounts, onSubmit: async (values: any) => { saved.push(values); }, onValidate: async (values: any) => { checked.push(values); return { valid: true }; } });
  view.pick(['fb-a']); view.type('Caption', 'Launch day');
  const draft = view.button('Save draft')!; assert.equal(draft.props.variant, 'secondary'); assert.equal(draft.props.type, 'submit');
  const menu = view.find(node => node.type === ui.Popover)!; assert.equal(menu.props.triggerLabel, 'Schedule'); assert.equal(menu.props.triggerVariant, 'primary');
  await view.click('Pick a time');
  const review = () => view.find(node => node.type === ui.ReviewConfirm && node.props.title === 'Schedule this post')!;
  assert.ok(review(), 'Choosing opens the confirm step.'); assert.equal(review().props.autoFocus, true);
  assert.equal(checked.length, 1, 'The post check runs when scheduling starts.');
  assert.ok(review().props.disabledReason, 'Confirming waits for a time.');
  await view.click('Tomorrow 9 AM');
  assert.equal(review().props.disabledReason, undefined);
  assert.match(renderToStaticMarkup(review() as any), /Brand page/, 'The confirm step lists the destinations.');
  await review().props.onConfirm(); await view.settle();
  assert.equal(saved.length, 1); assert.equal(saved[0].status, 'scheduled'); assert.ok(saved[0].scheduledAt);
  assert.deepEqual(saved[0].accounts, ['fb-a']);
});

test('Next free slot chooses the default publishing queue instead of a fixed time', async () => {
  const saved: any[] = [], queues = [{ _id: 'paused', name: 'Old', timezone: 'UTC', active: false, slots: [{ dayOfWeek: 1, time: '09:00' }], version: 'v0' }, { _id: 'main', name: 'Weekdays', timezone: 'UTC', active: true, isDefault: true, slots: [{ dayOfWeek: 1, time: '09:00' }], version: 'v1' }];
  const view = mount({ ...base, accounts, initialScheduledAt: '2070-01-01T09:00', onSubmit: async (values: any) => { saved.push(values); }, onLoadQueues: async () => ({ queues }) });
  view.pick(['fb-a']); view.type('Caption', 'Queued');
  await view.click('Next free slot'); await view.settle();
  assert.equal(view.snapshot().queueId, 'main'); assert.equal(view.snapshot().queueVersion, 'v1'); assert.equal(view.snapshot().scheduledAt, '', 'A queue clears the fixed time.');
  const review = view.find(node => node.type === ui.ReviewConfirm && node.props.title === 'Schedule this post')!;
  assert.equal(review.props.disabledReason, undefined);
  await review.props.onConfirm(); assert.equal(saved[0].queueId, 'main');
});

test('Cmd or Ctrl+Enter runs the primary action', async () => {
  const saved: any[] = [];
  const view = mount({ ...base, accounts, initialScheduledAt: '2070-01-01T09:00', onSubmit: async (values: any) => { saved.push(values); } });
  view.pick(['fb-a']); view.type('Caption', 'Shortcut');
  await view.key({ key: 'Enter', metaKey: true });
  assert.ok(view.find(node => node.type === ui.ReviewConfirm && node.props.title === 'Schedule this post'), 'The first press opens the confirm step.');
  await view.key({ key: 'Enter', ctrlKey: true });
  assert.equal(saved.length, 1, 'The second press schedules.'); assert.equal(saved[0].status, 'scheduled');
  await view.key({ key: 'Enter' }); assert.equal(saved.length, 1, 'Enter alone does nothing.');
});

test('the composer never names the provider', async () => {
  const post = { content: 'Hi', platforms: ['facebook'], accounts: ['fb-a'], mediaItems: [{ type: 'image', url: 'https://cdn.example.test/a.jpg' }] };
  const view = mount({ ...base, accounts, post, onValidate: async () => ({ valid: false, errors: [{ message: 'Account needs reconnecting.' }] }), onInspectMedia: async () => ({}), onLoadQueues: async () => ({ queues: [] }), onShortenLinks: async () => ({ content: '', platformOverrides: {} }), onLoadGroups: async () => ({ groups: [], accounts: [] }) });
  await view.click('Pick a time');
  assert.doesNotMatch(view.html(), /Zernio/);
  assert.match(view.html(), /Account needs reconnecting/, 'The provider check shows in the confirm step.');
});

test('a provider post keeps Save changes as its one action and edits its time inline', () => {
  const view = mount({ ...base, accounts, providerPost: true, post: { id: 'p', externalId: 'remote', content: 'Hi', platforms: ['facebook'], accounts: ['fb-a'], mediaItems: [], scheduledAt: '2070-01-01T09:00:00Z' } });
  assert.equal(view.find(node => node.type === ui.Popover), undefined);
  assert.equal(view.button('Save changes')!.props.variant, 'primary');
  assert.ok(view.find(node => node.type === ui.DateTimeField), 'The planned time stays editable in the form.');
});

test('without a social publishing connection the post check, file check and queues are disabled with a reason and Open integrations (#152)', async () => {
  const calls: string[] = [], opened: boolean[] = [];
  const offline = { ...base, onLoadAccounts: undefined, accounts, post: { content: 'Hi', platforms: ['facebook'], accounts: ['fb-a'], mediaItems: [{ type: 'image', url: 'https://cdn.example.test/a.jpg' }] }, onValidate: async () => { calls.push('validate'); return { valid: true }; }, onInspectMedia: async () => { calls.push('inspect'); return {}; }, onLoadQueues: async () => { calls.push('queues'); return { queues: [] }; }, onOpenIntegrations: () => opened.push(true) };
  const view = mount(offline);
  assert.equal(view.button('Next free slot')!.props.disabled, true);
  assert.match(view.html(), /<button[^>]*disabled=""[^>]*>Check file<\/button>/, 'The media file check waits for a connection.');
  await view.click('Pick a time');
  for (const label of ['Check post', 'Load queues']) assert.equal(view.button(label)!.props.disabled, true, label);
  assert.deepEqual(calls, [], 'Opening Schedule does not ask the provider.');
  assert.match(view.html(), /Connect social accounts in Integrations to check posts and use queues\./);
  const action = view.all(node => node.type === ui.Button && text(node) === 'Open integrations');
  assert.ok(action.length > 0); action[0].props.onClick(); assert.deepEqual(opened, [true]);
  const online = mount({ ...offline, onLoadAccounts: async () => ({}) });
  assert.notEqual(online.button('Next free slot')!.props.disabled, true);
  assert.match(online.html(), /<button(?![^>]*disabled)[^>]*>Check file<\/button>/);
  assert.doesNotMatch(online.html(), /Open integrations/);
});
