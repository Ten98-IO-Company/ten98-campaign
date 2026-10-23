import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes as stripTypes } from 'node:module';
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
    openSchedule: async () => { find(node => node.type === ui.Popover)!.props.onOpenChange(true); paint(); await tick(); paint(); },
    confirm: () => nodes(find(node => node.type === ui.Popover)).find(node => node.type === ui.Button && node.props.variant === 'primary'),
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
  assert.equal(view.find(node => node.type === ui.MultiCombobox), undefined);
  view.pick(['ig-a']); assert.deepEqual(view.snapshot().platforms, ['instagram']); assert.deepEqual(view.snapshot().accounts, ['ig-a']);
  view.pick(['ig-a', 'fb-a']); assert.deepEqual(view.snapshot().platforms, ['instagram', 'facebook']);
  view.pick(['fb-a']); assert.deepEqual(view.snapshot().platforms, ['facebook'], 'Removing the last account of a network removes the network.');
  view.button('Select all')!.props.onClick(); view.paint(); assert.deepEqual(view.snapshot().accounts, ['fb-a', 'ig-a']);
  const empty = mount({ ...base, accounts: [] });
  assert.ok(empty.find(node => node.type === ui.MultiCombobox), 'Without accounts the platform choice allows a platform draft.');
  assert.match(empty.html(), /No social accounts connected/);
  const kept = mount({ ...base, accounts, post: { content: 'Saved', platforms: ['linkedin', 'facebook'], accounts: ['fb-a'], mediaItems: [] } });
  assert.ok(kept.find(node => node.type === ui.MultiCombobox), 'A saved platform without a connected account stays removable.');
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
  const menu = view.find(node => node.type === ui.Popover)!; assert.equal(menu.props.triggerVariant, 'primary');
  await view.openSchedule();
  assert.equal(checked.length, 1, 'The post check runs when scheduling starts.');
  assert.equal(view.confirm()!.props.disabled, true, 'Confirming waits for a time.');
  assert.match(view.html(), /Choose a time or the next free slot\./, 'A blocked confirm says why.');
  await view.click('Tomorrow 9 AM');
  assert.notEqual(view.confirm()!.props.disabled, true);
  assert.ok(view.find(node => node.type === ui.Text && text(node).includes('Brand page · Facebook')), 'The step lists the destinations.');
  await view.confirm()!.props.onClick(); await view.settle();
  assert.equal(saved.length, 1); assert.equal(saved[0].status, 'scheduled'); assert.ok(saved[0].scheduledAt);
  assert.deepEqual(saved[0].accounts, ['fb-a']);
});

test('Next free slot chooses the default publishing queue instead of a fixed time', async () => {
  const saved: any[] = [], queues = [{ _id: 'paused', name: 'Old', timezone: 'UTC', active: false, slots: [{ dayOfWeek: 1, time: '09:00' }], version: 'v0' }, { _id: 'main', name: 'Weekdays', timezone: 'UTC', active: true, isDefault: true, slots: [{ dayOfWeek: 1, time: '09:00' }], version: 'v1' }];
  const view = mount({ ...base, accounts, initialScheduledAt: '2070-01-01T09:00', onSubmit: async (values: any) => { saved.push(values); }, onLoadQueues: async () => ({ queues }) });
  view.pick(['fb-a']); view.type('Caption', 'Queued');
  await view.openSchedule(); await view.click('Next free slot'); await view.settle();
  assert.equal(view.snapshot().queueId, 'main'); assert.equal(view.snapshot().queueVersion, 'v1'); assert.equal(view.snapshot().scheduledAt, '', 'A queue clears the fixed time.');
  assert.notEqual(view.confirm()!.props.disabled, true);
  await view.confirm()!.props.onClick(); assert.equal(saved[0].queueId, 'main');
});

test('Cmd or Ctrl+Enter runs the primary action', async () => {
  const saved: any[] = [];
  const view = mount({ ...base, accounts, initialScheduledAt: '2070-01-01T09:00', onSubmit: async (values: any) => { saved.push(values); } });
  view.pick(['fb-a']); view.type('Caption', 'Shortcut');
  await view.key({ key: 'Enter', metaKey: true });
  assert.equal(view.find(node => node.type === ui.Popover)!.props.open, true, 'The first press opens the Schedule step.');
  await view.key({ key: 'Enter', ctrlKey: true });
  assert.equal(saved.length, 1, 'The second press confirms.'); assert.equal(saved[0].status, 'scheduled');
  await view.key({ key: 'Enter' }); assert.equal(saved.length, 1, 'Enter alone does nothing.');
});

test('the composer never names the provider', async () => {
  const post = { content: 'Hi', platforms: ['facebook'], accounts: ['fb-a'], mediaItems: [{ type: 'image', url: 'https://cdn.example.test/a.jpg' }] };
  const view = mount({ ...base, accounts, post, onValidate: async () => ({ valid: false, errors: [{ message: 'Account needs reconnecting.' }] }), onInspectMedia: async () => ({}), onLoadQueues: async () => ({ queues: [] }), onShortenLinks: async () => ({ content: '', platformOverrides: {} }), onLoadGroups: async () => ({ groups: [], accounts: [] }) });
  await view.openSchedule();
  assert.doesNotMatch(view.html(), /Zernio/);
  assert.match(view.html(), /Account needs reconnecting/, 'The provider check shows in the confirm step.');
});

test('a provider post keeps Save changes as its one action and edits its time inline', () => {
  const view = mount({ ...base, accounts, providerPost: true, post: { id: 'p', externalId: 'remote', content: 'Hi', platforms: ['facebook'], accounts: ['fb-a'], mediaItems: [], scheduledAt: '2070-01-01T09:00:00Z' } });
  assert.equal(view.find(node => node.type === ui.Popover), undefined);
  assert.equal(view.button('Save changes')!.props.variant, 'primary');
  assert.ok(view.find(node => node.type === ui.DateTimeField), 'The planned time stays editable in the form.');
});

test('destinations span both panes, problems read "Network (Account): message" and the preview says whether its network is ready', () => {
  const view = mount({ ...base, accounts, post: { content: 'Launch', platforms: ['instagram', 'facebook'], accounts: ['ig-a', 'fb-a'], mediaItems: [] } });
  const panes = view.find(node => node.type === ui.Grid && node.props.columns === 2)!;
  assert.equal(nodes(panes).some(node => node.type === ui.DestinationPicker), false, 'The To row sits above the two panes.');
  assert.ok(view.find(node => node.type === ui.DestinationPicker));
  assert.ok(view.find(node => node.type === ui.Text && node.props.tone === 'danger' && text(node) === 'Instagram (Brand gram): Instagram requires media.'));
  const status = (platform: string) => { view.find(node => node.type === ui.SegmentedControl && node.props.label === 'Preview network')!.props.onValueChange(platform); view.paint(); const aside = view.find(node => node.props?.['aria-label'] === 'Post preview')!; return nodes(aside).filter(node => node.type === ui.Badge).map(node => [node.props.tone, text(node)]); };
  assert.deepEqual(status('instagram'), [['danger', 'Needs a fix']]);
  assert.deepEqual(status('facebook'), [['success', 'Ready']]);
});

test('Schedule submits to the scheduler when publishing is open; otherwise the action reads Save to calendar and says why', async () => {
  const published: any[] = [], saved: any[] = [], opened: boolean[] = [];
  const props = { ...base, accounts, initialScheduledAt: '2070-01-01T09:00', onSubmit: async (values: any) => { saved.push(values); }, onSchedule: async (values: any) => { published.push(values); }, onOpenIntegrations: () => opened.push(true) };
  const menu = (view: ReturnType<typeof mount>) => view.find(node => node.type === ui.Popover)!;
  const ready = mount(props); ready.pick(['fb-a']); ready.type('Caption', 'Go');
  assert.equal(menu(ready).props.triggerLabel, 'Schedule');
  await ready.openSchedule(); assert.equal(text(ready.confirm()), 'Schedule');
  await ready.confirm()!.props.onClick(); await ready.settle();
  assert.equal(published.length, 1, 'Schedule submits through the publish path.'); assert.equal(saved.length, 0); assert.equal(published[0].status, 'scheduled');
  const offline = mount({ ...props, onLoadAccounts: undefined }); offline.pick(['fb-a']); offline.type('Caption', 'Plan');
  assert.equal(menu(offline).props.triggerLabel, 'Save to calendar');
  await offline.openSchedule(); assert.equal(text(offline.confirm()), 'Save to calendar');
  assert.match(offline.html(), /Connect Zernio in Integrations to publish\./);
  nodes(menu(offline)).find(node => node.type === ui.Button && text(node) === 'Open integrations')!.props.onClick(); assert.deepEqual(opened, [true]);
  await offline.confirm()!.props.onClick(); await offline.settle();
  assert.equal(saved.length, 1, 'Save to calendar saves the plan.'); assert.equal(published.length, 1);
  const reason = 'This project requires approval before publishing. Request a review first.';
  const blocked = mount({ ...props, publishBlock: reason }); blocked.pick(['fb-a']); blocked.type('Caption', 'Needs review');
  assert.equal(menu(blocked).props.triggerLabel, 'Save to calendar');
  assert.ok(nodes(menu(blocked)).some(node => node.type === ui.Text && text(node) === reason), 'The block reason sits beside the action.');
  const invalid = mount({ ...props, post: { content: 'Reel', platforms: ['instagram'], accounts: ['ig-a'], mediaItems: [] } });
  assert.equal(menu(invalid).props.triggerLabel, 'Save to calendar');
  assert.ok(nodes(menu(invalid)).some(node => node.type === ui.Text && text(node) === 'Instagram (Brand gram): Instagram requires media.'));
});

test('the editor wires Schedule to save then the post card publish path, with the same connection and approval gates', async () => {
  const app = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const composer = app.match(/modal\.type === 'post' \? <PostComposer [^\r\n]+?\/>/)?.[0] || '';
  for (const prop of ['onSchedule={schedulePost}', 'connected={!!connected}', 'publishBlock={composerPublishBlock}', "onOpenIntegrations={() => setPage('Integrations')}"]) assert.ok(composer.includes(prop), prop);
  const schedule = app.slice(app.indexOf('async function schedulePost('), app.indexOf('\n', app.indexOf('async function schedulePost(')));
  const calls: any[] = [];
  const run = new Function('savePost', 'publish', 'modal', `return (${stripTypes(schedule)});`)(async (...args: any[]) => { calls.push(['save', ...args]); return { record: { id: 'new-post', status: 'scheduled' } }; }, async (post: any) => { calls.push(['publish', post]); }, null);
  await run({ content: 'Go' });
  assert.deepEqual(calls, [['save', { content: 'Go' }, ''], ['publish', { id: 'new-post', status: 'scheduled' }]], 'Saved first, then the existing publish(post), with no second notice.');
  const block = app.match(/const composerPublishBlock = (.+);/)![1];
  const approval = app.match(/const composerApproval = (.+);/)![1];
  const gate = (summary: any, connected: any, item: any) => { const modal = { type: 'post', item }, approvalGate = (_: any, id: string) => summary?.[id] ?? null; const composerApproval = new Function('modal', 'approvalGate', 'approvalSummary', `return (${approval});`)(modal, approvalGate, summary); return new Function('connected', 'modal', 'composerApproval', `return (${block});`)(connected, modal, composerApproval); };
  assert.equal(gate(null, false, undefined), 'Connect Zernio in Integrations to publish.');
  assert.equal(gate(null, true, { id: 'p', sample: true }), 'Sample posts cannot be published.');
  assert.equal(gate({ p: { publishable: false, reason: 'Waiting for approval.' } }, true, { id: 'p' }), 'Waiting for approval.');
  assert.equal(gate({ p: { publishable: true, reason: '' } }, true, { id: 'p' }), undefined);
});

test('on narrow screens the footer stays one row and the To row stays short, so the caption is not hidden', () => {
  const hosted = mount({ ...base, accounts: [], actionsHost: {} });
  assert.equal(hosted.button('Cancel'), undefined, 'In the editor dialog its close button cancels; the footer keeps Save draft and the primary only.');
  assert.ok(hosted.button('Save draft'));
  const platformsField = hosted.find(node => node.type === ui.MultiCombobox && node.props.label === 'Post to')!;
  assert.ok(platformsField, 'Without accounts the platforms are one combobox, not 14 checkboxes.');
  assert.equal(hosted.find(node => node.type === ui.CheckboxGroup), undefined);
  platformsField.props.onValuesChange([{ value: 'linkedin', label: 'LinkedIn' }]); hosted.paint();
  assert.deepEqual(hosted.snapshot().platforms, ['linkedin']);
  assert.deepEqual(hosted.find(node => node.type === ui.MultiCombobox)!.props.values.map((option: any) => option.value), ['linkedin']);
  assert.ok(mount({ ...base, accounts: [] }).button('Cancel'), 'Outside the dialog footer Cancel stays.');
});

test('the Schedule step lives in the footer menu: one confirm, one Cancel, and the preview stays in place', async () => {
  const saved: any[] = [];
  const view = mount({ ...base, accounts, onSubmit: async (values: any) => { saved.push(values); } });
  view.pick(['fb-a']); view.type('Caption', 'Launch day');
  await view.openSchedule();
  assert.equal(view.find(node => node.type === ui.ReviewConfirm && node.props.title === 'Schedule this post'), undefined, 'No second confirm panel.');
  assert.equal(nodes(view.find(node => node.props?.['aria-label'] === 'Post preview')).some(node => node.type === ui.DateTimeField), false, 'The preview pane holds only the preview.');
  assert.ok(nodes(view.find(node => node.type === ui.Popover)).some(node => node.type === ui.DateTimeField), 'The time is chosen in the Schedule menu.');
  assert.equal(view.all(node => node.type === ui.Button && text(node) === 'Cancel').length, 1);
  assert.equal(view.all(node => node.type === ui.Button && ['Schedule', 'Save to calendar'].includes(text(node))).length, 1, 'One confirm button.');
  await view.click('Tomorrow 9 AM');
  await view.confirm()!.props.onClick(); await view.settle();
  assert.equal(saved.length, 1); assert.equal(saved[0].status, 'scheduled');
});

test('without a social publishing connection the post check, file check and queues are disabled with a reason and Open integrations (#152)', async () => {
  const calls: string[] = [], opened: boolean[] = [];
  const offline = { ...base, onLoadAccounts: undefined, accounts, post: { content: 'Hi', platforms: ['facebook'], accounts: ['fb-a'], mediaItems: [{ type: 'image', url: 'https://cdn.example.test/a.jpg' }] }, onValidate: async () => { calls.push('validate'); return { valid: true }; }, onInspectMedia: async () => { calls.push('inspect'); return {}; }, onLoadQueues: async () => { calls.push('queues'); return { queues: [] }; }, onOpenIntegrations: () => opened.push(true) };
  const view = mount(offline);
  assert.equal(view.button('Next free slot')!.props.disabled, true);
  assert.match(view.html(), /<button[^>]*disabled=""[^>]*>Check file<\/button>/, 'The media file check waits for a connection.');
  await view.openSchedule();
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
