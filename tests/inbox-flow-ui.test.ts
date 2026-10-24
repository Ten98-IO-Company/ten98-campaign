import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import { renderToStaticMarkup } from 'react-dom/server';

// Issue #129: the inbox loads on view, offers views by state, separates "All caught up" from "No matches", shows one
// banner per affected account and answers j/k/e/r. The actual components run with ordered hook stubs and a stub transport.
const source = await readFile(new URL('../src/UnifiedInbox.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .*;\r?$/gm, '').replace('export default function', 'function'), 'UnifiedInbox.tsx', { jsx: { runtime: 'classic' } });
const settle = () => new Promise(resolve => setImmediate(resolve));
// Walks every element-valued prop, so list, detail, emptyMessage and actions slots are searched too.
const elements = (node: any): any[] => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...Object.values(node.props as Record<string, unknown>).flatMap(elements)] : [];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : React.isValidElement(node) ? text((node.props as any).children) : node == null || typeof node === 'boolean' ? '' : String(node);
const find = (tree: any, type: any, test: (props: any) => boolean = () => true) => elements(tree).filter(node => node.type === type && test(node.props));
const named = (tree: any, name: string) => elements(tree).filter(node => typeof node.type === 'function' && node.type.name === name);

function mount(name: string, globals: Record<string, unknown> = {}) {
  const states: any[] = [], refs: any[] = [], effects: any[] = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0;
  const useState = (initial: any) => { const index = stateIndex++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], (value: any) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; };
  const useRef = (initial: any) => refs[refIndex++] ||= { current: initial };
  const useEffect = (callback: () => any, deps: any[]) => { const index = effectIndex++, previous = effects[index]; if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) effects[index] = { deps, callback, cleanup: previous?.cleanup }; };
  const window = { addEventListener() {}, removeEventListener() {}, setInterval: () => 1, clearInterval() {} };
  const scope = { React, useState, useRef, useEffect, useLayoutEffect: (callback: () => void) => { callback(); }, useFocusReturn: () => () => {}, WhatsAppTemplate: () => null, templateRestriction: () => '', validPostInstant: (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)), window, document: undefined, ...globals, ...ui };
  const Component = new Function(...Object.keys(scope), code + '; return ' + name + ';')(...Object.values(scope));
  return {
    render(props: any) { stateIndex = refIndex = effectIndex = 0; return Component(props); },
    flush() { for (const effect of effects) if (effect.callback) { effect.cleanup?.(); effect.cleanup = effect.callback(); effect.callback = null; } },
    unmount() { effects.forEach(effect => effect.cleanup?.()); },
  };
}

const accounts = [{ id: 'ig', platform: 'instagram', name: 'Studio IG', capabilities: { messages: true, reply: true } }, { id: 'tg', platform: 'telegram', name: 'Support TG', capabilities: { messages: true, reply: true } }];
const rows = [{ id: 'a', participantName: 'Ada', lastMessage: 'Hello' }, { id: 'b', participantName: 'Ben', lastMessage: 'Price?' }, { id: 'c', participantName: 'Cy', lastMessage: 'Thanks' }, { id: 'd', participantName: 'Di', lastMessage: 'Later' }];
const triage = [{ resourceId: 'a', status: 'open', assigneeId: 'me', updatedAt: null }, { resourceId: 'b', status: 'pending', assigneeId: null, updatedAt: null }, { resourceId: 'c', status: 'resolved', assigneeId: null, updatedAt: null }, { resourceId: 'd', status: 'snoozed', assigneeId: 'me', updatedAt: null }];
function transport(calls: any[][], { conversations = rows, states = triage, meta, status = {}, pagination = {} }: { conversations?: any[]; states?: any[]; meta?: any; status?: any; pagination?: any } = {}) {
  return async (...args: any[]) => {
    calls.push(args); const [target, method, body] = args, url = new URL(target, 'https://app.test'), route = url.pathname;
    if (route.endsWith('/integrations/inbox/status')) return { configured: true, mapped: true, webhookConfigured: true, accounts, ...status };
    if (route === '/session') return { user: { id: 'me' } };
    if (route.endsWith('/assignees')) return { members: [] };
    if (route.endsWith('/updates')) return { updates: [], cursor: 0 };
    if (route.endsWith('/item-states') && method === 'PATCH') return { state: { accountId: body.accountId, kind: body.kind, resourceId: body.resourceId, status: body.status ?? 'open', assigneeId: null, updatedAt: '2026-10-24T10:00:00.000Z' } };
    if (route.endsWith('/item-states')) return { states: url.searchParams.getAll('id').map(id => states.find(state => state.resourceId === id)).filter(Boolean).map(state => ({ accountId: url.searchParams.get('accountId'), kind: url.searchParams.get('kind'), ...state })) };
    if (route.endsWith('/item-notes')) return { notes: [] };
    if (route.endsWith('/conversations')) return { conversations, pagination, ...(meta ? { meta } : {}) };
    if (route.endsWith('/integrations/inbox/comments')) return { posts: [{ id: 'post-1', content: 'Launch post', commentCount: 2 }], pagination: {} };
    if (/\/conversations\/[^/]+\/messages$/.test(route)) return { conversation: {}, messages: [], pagination: {} };
    throw new Error('Unexpected request ' + target);
  };
}
async function open(options: { conversations?: any[]; states?: any[]; meta?: any; status?: any; pagination?: any; props?: any } = {}) {
  const calls: any[][] = [], h = mount('ZernioInbox');
  const props = { projectId: 'project-a', request: transport(calls, options), role: 'editor', tab: 'messages', onDraftChange() {}, onSwitch: (change: () => unknown) => change(), ...options.props };
  const step = async (rounds = 8) => { for (let round = 0; round < rounds; round++) { h.render(props); h.flush(); await settle(); } return h.render(props); };
  return { calls, h, props, step, tree: await step() };
}
const listReads = (calls: any[][]) => calls.filter(([target, method]) => !method && /\/integrations\/inbox\/conversations\?/.test(target));
const list = (tree: any) => find(tree, ui.SelectableList, props => props.label === 'Conversation list')[0];
const shown = (tree: any) => list(tree).props.items.map((item: any) => item.id);

test('opening the inbox lists the first connected account’s conversations without a click, with one list read', async () => {
  const { calls, tree } = await open();
  const reads = listReads(calls);
  assert.equal(reads.length, 1, 'Auto-load makes the one list read the Load button made, and no more.');
  assert.deepEqual(Object.fromEntries(new URL(reads[0][0], 'https://app.test').searchParams), { accountId: 'ig', status: 'active' });
  assert.deepEqual(shown(tree), ['a', 'b'], 'The default Open view hides done and snoozed conversations.');
  assert.equal(find(tree, ui.Button, props => /^Load /.test(text(props.children))).length, 0, 'No Load button gates the list.');
});

test('a WhatsApp campaign link still loads only its own account, and an unavailable one is never replaced by a guess', async () => {
  const whatsapp = [{ id: 'wa-other', platform: 'whatsapp', name: 'Other', capabilities: { messages: true } }, { id: 'wa-campaign', platform: 'whatsapp', name: 'Campaign', capabilities: { messages: true } }];
  const linked = await open({ status: { accounts: whatsapp }, props: { initialChannel: 'whatsapp', initialAccountId: 'wa-campaign' } });
  assert.deepEqual(listReads(linked.calls).map(([target]) => new URL(target, 'https://app.test').searchParams.get('accountId')), ['wa-campaign']);
  const missing = await open({ status: { accounts: whatsapp }, props: { initialChannel: 'whatsapp', initialAccountId: 'gone' } });
  assert.equal(listReads(missing.calls).length, 0);
  assert.match(text(find(missing.tree, ui.Alert, props => props.tone === 'danger')[0]?.props.children), /unavailable/);
});

test('views by state: Open, Mine, Unassigned, Snoozed and Done filter the loaded conversations', async () => {
  const { h, props, step } = await open();
  const views = () => find(h.render(props), ui.SegmentedControl, control => control.label === 'View')[0];
  assert.deepEqual(views().props.options.map((option: any) => option.value), ['active', 'mine', 'unassigned', 'snoozed', 'resolved']);
  for (const [view, expected] of [['mine', ['a']], ['unassigned', ['b']], ['snoozed', ['d']], ['resolved', ['c']], ['active', ['a', 'b']]] as const) {
    views().props.onValueChange(view); assert.deepEqual(shown(await step(1)), expected, view);
  }
});

test('the View switcher is sized to its content and counts each view once every page and state is loaded', async () => {
  const { tree } = await open();
  const sized = find(tree, ui.Inline, inline => React.isValidElement(inline.children) && inline.children.type === ui.SegmentedControl && (inline.children.props as any).label === 'View');
  assert.equal(sized.length, 1, 'An Inline row keeps the control at its content width instead of the column width.');
  const labels = (view: any) => find(view, ui.SegmentedControl, control => control.label === 'View')[0].props.options.map((option: any) => option.label);
  assert.deepEqual(labels(tree), ['Open 2', 'Mine 1', 'Unassigned 1', 'Snoozed 1', 'Done 1'], 'Each count is what that view lists.');
  assert.deepEqual(labels((await open({ conversations: [] })).tree), ['Open 0', 'Mine 0', 'Unassigned 0', 'Snoozed 0', 'Done 0']);
  assert.deepEqual(labels((await open({ pagination: { hasMore: true, nextCursor: 'next' } })).tree), ['Open', 'Mine', 'Unassigned', 'Snoozed', 'Done'], 'More pages mean the counts are not known yet.');
});

test('an empty view says All caught up, while a search with no results says No matches and clears its filters', async () => {
  const empty = await open({ conversations: [] });
  assert.equal(list(empty.tree).props.emptyMessage.props.title, 'All caught up');
  const { h, props, step } = await open();
  const search = find(h.render(props), ui.Field, field => /^Search loaded/.test(field.label))[0];
  find(search, ui.Input)[0].props.onChange({ target: { value: 'nobody matches this' } });
  const missing = list(await step(1)).props.emptyMessage;
  assert.equal(missing.props.title, 'No matches');
  const clear = find(missing, ui.Button, button => text(button.children) === 'Clear filters')[0]; assert.ok(clear);
  clear.props.onClick(); assert.deepEqual(shown(await step()), ['a', 'b']);
});

test('applied filters show as removable chips above the list', async () => {
  const { h, props, step } = await open();
  find(find(h.render(props), ui.Field, field => /^Search loaded/.test(field.label))[0], ui.Input)[0].props.onChange({ target: { value: 'Ada' } });
  const chips = find(await step(1), ui.AppliedFilters, filters => filters.label === 'Applied filters')[0];
  assert.deepEqual(chips.props.filters.map((filter: any) => [filter.label, filter.value]), [['Search', 'Ada']]);
  chips.props.onRemove('search'); const tree = await step(1);
  assert.deepEqual(shown(tree), ['a', 'b']); assert.equal(find(tree, ui.AppliedFilters, filters => filters.label === 'Applied filters').length, 0, 'No chips without applied filters.');
});

test('each account the provider could not read gets its own banner with Reconnect', async () => {
  const opened: string[] = [];
  const failedAccounts = [{ accountId: 'ig', platform: 'instagram', error: 'The provider could not read this account. Check its connection and permissions.' }, { accountId: 'tg', platform: 'telegram', error: 'The provider could not read this account. Check its connection and permissions.', retryAfter: 30 }];
  const { tree } = await open({ meta: { failedAccounts }, props: { onOpenIntegrations: () => opened.push('Integrations') } });
  const banners = find(tree, ui.Alert, alert => alert.tone === 'warning' && /could not be loaded/.test(String(alert.title)));
  assert.deepEqual(banners.map(alert => alert.props.title), ['Studio IG · Instagram could not be loaded', 'Support TG · Telegram could not be loaded']);
  assert.match(text(banners[1].props.children), /Retry after 30 seconds/);
  for (const alert of banners) { const reconnect = find(alert.props.actions, ui.Button)[0]; assert.equal(text(reconnect.props.children), 'Reconnect'); reconnect.props.onClick(); }
  assert.deepEqual(opened, ['Integrations', 'Integrations']);
});

// #129 visual direction §6: with nothing connected the page is one empty state; the inbox controls wait for an account.
test('an inbox without a connected account shows only Connect social accounts, which opens Integrations', async () => {
  for (const status of [{ configured: false, mapped: false, webhookConfigured: false, accounts: [] }, { configured: true, mapped: true, webhookConfigured: true, accounts: [] }]) {
    const opened: string[] = [];
    const { tree, calls } = await open({ status, props: { onOpenIntegrations: () => opened.push('Integrations') } });
    const empty = find(tree, ui.EmptyState);
    assert.deepEqual(empty.map(state => state.props.title), ['Connect social accounts'], JSON.stringify(status));
    assert.equal(typeof empty[0].props.description, 'string', 'One muted line.');
    const buttons = find(tree, ui.Button);
    assert.deepEqual(buttons.map(button => text(button.props.children)), ['Open Connections'], 'The only control opens Settings › Connections.');
    buttons[0].props.onClick(); assert.deepEqual(opened, ['Integrations']);
    for (const control of [ui.SegmentedControl, ui.Select, ui.Input, ui.Popover, ui.Disclosure, ui.DetailWorkspace, ui.Alert]) assert.equal(find(tree, control).length, 0, control.name + ' waits for an account.');
    assert.equal(listReads(calls).length, 0);
  }
});

// The page header is the h1 and names the page, so the inbox starts at h2 and each heading nests at most one level deeper.
// Heading text is read by splitting on tags in one pass (not a sanitiser): any markup left behind fails the assertion.
const headingText = (html: string) => { const text = html.split(/<[^>]*>/).join(''); assert.ok(!text.includes('<'), 'Heading text still contains markup: ' + html); return text; };
const headings = (tree: any) => [...renderToStaticMarkup(tree).matchAll(/<h([1-6])[^>]*>(.*?)<\/h\1>/g)].map(([, level, name]) => ({ level: Number(level), name: headingText(name) }));
test('inbox headings start below the page heading, nest in order and never repeat', async () => {
  const commentAccounts = [{ id: 'fb', platform: 'facebook', name: 'Studio page', capabilities: { comments: true } }];
  for (const options of [{}, { conversations: [] }, { status: { accounts: commentAccounts }, props: { tab: 'comments' } }]) {
    const found = headings((await open(options)).tree), names = found.map(({ name }) => name), summary = found.map(({ level, name }) => `h${level} ${name}`).join(', ');
    assert.equal(names.includes('Unified inbox'), false, 'The page header already names the page: ' + summary);
    assert.equal(new Set(names).size, names.length, 'No heading text repeats: ' + summary);
    assert.equal(found[0].level, 2, summary);
    found.forEach(({ level }, index) => assert.ok(index === 0 || level <= found[index - 1].level + 1, 'No heading skips a level: ' + summary));
  }
});

test('j and k open the next and previous conversation, e marks it done and r moves to the reply', async () => {
  const { h, props, step, calls } = await open();
  const keys = () => named(h.render(props), 'InboxShortcuts')[0].props.onKey;
  const opened = () => calls.filter(([target]) => /\/conversations\/[^/?]+\/messages\?/.test(target)).map(([target]) => decodeURIComponent(target.match(/conversations\/([^/?]+)\/messages/)[1]));
  keys()('j'); await step(); assert.deepEqual(opened(), ['a'], 'j with nothing open opens the first conversation.');
  keys()('j'); await step(); keys()('k'); await step(); assert.deepEqual(opened(), ['a', 'b', 'a']);
  const field = find(h.render(props), ui.Textarea, area => area.placeholder === 'Write a reply to this conversation…')[0];
  let focused = 0; field.props.ref.current = { focus: () => { focused++; } }; keys()('r'); assert.equal(focused, 1);
  keys()('e'); await step();
  const patch = calls.find(([target, method]) => method === 'PATCH' && target.endsWith('/item-states'));
  assert.deepEqual(patch?.[2], { accountId: 'ig', kind: 'conversation', resourceId: 'a', expectedUpdatedAt: null, status: 'resolved' });
  assert.deepEqual(shown(h.render(props)), ['b'], 'A done conversation leaves the Open view.');
});

test('viewers cannot mark conversations done from the keyboard', async () => {
  const { h, props, step, calls } = await open({ props: { readOnly: true, role: 'viewer' } });
  const keys = () => named(h.render(props), 'InboxShortcuts')[0].props.onKey;
  keys()('j'); await step(); keys()('e'); await step();
  assert.equal(calls.filter(([, method]) => method === 'PATCH').length, 0);
});

test('shortcuts ignore typing in fields, modified keys and open dialogs, and stop listening when removed', () => {
  const listeners = new Map<string, (event: any) => void>(), removed: string[] = [];
  const document = { addEventListener: (type: string, listener: any) => listeners.set(type, listener), removeEventListener: (type: string) => removed.push(type) };
  const h = mount('InboxShortcuts', { document }), pressed: string[] = [];
  h.render({ onKey: (key: string) => pressed.push(key) }); h.flush();
  const press = (key: string, target: any = { closest: () => null }, extra = {}) => { const event = { key, target, defaultPrevented: false, prevented: false, preventDefault() { event.prevented = true; }, ...extra }; listeners.get('keydown')!(event); return event; };
  assert.equal(press('j').prevented, true); press('k'); press('e'); press('r'); press('x');
  press('j', { closest: (selector: string) => selector.includes('textarea') ? {} : null });
  press('j', undefined, { metaKey: true }); press('k', undefined, { ctrlKey: true }); press('e', undefined, { altKey: true }); press('r', undefined, { isComposing: true });
  assert.deepEqual(pressed, ['j', 'k', 'e', 'r']);
  h.render({ onKey: (key: string) => pressed.push('latest:' + key) }); press('j'); assert.equal(pressed.at(-1), 'latest:j', 'The newest handler answers.');
  h.unmount(); assert.deepEqual(removed, ['keydown']);
});

test('SMS replies answer j, k and r too', async () => {
  const calls: any[][] = [], h = mount('SmsInbox');
  const request = async (...args: any[]) => { calls.push(args); const [target] = args; if (target.endsWith('/status')) return { configured: true }; if (target.endsWith('/conversations')) return { conversations: [{ id: 's1', participantId: '+15550000001' }, { id: 's2', participantId: '+15550000002' }], pagination: {} }; if (/\/messages$/.test(target)) return { conversation: null, messages: [], pagination: {} }; throw new Error(target); };
  const props = { projectId: 'project-a', request, onDraftChange() {}, onSwitch: (change: () => unknown) => change() };
  const step = async () => { for (let round = 0; round < 6; round++) { h.render(props); h.flush(); await settle(); } return h.render(props); };
  await step(); const keys = () => named(h.render(props), 'InboxShortcuts')[0].props.onKey;
  keys()('j'); await step(); keys()('j'); await step(); keys()('k'); await step();
  assert.deepEqual(calls.filter(([target]) => /\/messages$/.test(target)).map(([target]) => target.split('/').at(-2)), ['s1', 's2', 's1']);
  const field = find(h.render(props), ui.Textarea, area => area.maxLength === 1600)[0]; let focused = 0; field.props.ref.current = { focus: () => { focused++; } };
  keys()('r'); assert.equal(focused, 1);
});
