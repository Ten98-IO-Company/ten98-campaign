import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import { PLATFORM_RULES } from '../shared/social-posts.ts';
import { reviewKeyAction } from '../src/review-keys.ts';
import { adSpendActionLabel, adSpendPlatformLabel, formatMinorUnits } from '../src/approval-status.ts';

// Issue #125: Approvals is a review workspace. A list of waiting posts and spend changes sits beside the open review,
// requesting changes needs a comment, and an edited post shows what changed since its review. The actual component runs
// with ordered hook stubs and a recording transport; no provider or approval request leaves the test.
const source = await readFile(new URL('../src/ContentApprovals.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .*;\r?$/gm, '').replace('export default function', 'function'), 'ContentApprovals.tsx', { jsx: { runtime: 'classic' } });
const settle = () => new Promise(resolve => setImmediate(resolve));
// Walks every element-valued prop; the app's own spend review card is rendered so its controls are searched too.
const elements = (node: any): any[] => Array.isArray(node) ? node.flatMap(elements) : !React.isValidElement(node) ? [] : (node.type as any).name === 'SpendReview' ? elements((node.type as any)(node.props)) : [node, ...Object.values(node.props as Record<string, unknown>).flatMap(elements)];
const text = (node: any): string => Array.isArray(node) ? node.map(text).join('') : React.isValidElement(node) ? text((node.props as any).children) : node == null || typeof node === 'boolean' ? '' : String(node);
const find = (tree: any, type: any, test: (props: any) => boolean = () => true) => elements(tree).filter(node => node.type === type && test(node.props));
const button = (tree: any, label: string) => find(tree, ui.Button, props => text(props.children) === label)[0];
const html = (tree: any) => renderToStaticMarkup(tree).replace(/<!-- -->/g, '');

function mount(props: Record<string, unknown>) {
  const states: any[] = [], refs: any[] = [], effects: any[] = [], focused: string[] = [];
  let stateIndex = 0, refIndex = 0, effectIndex = 0;
  const useState = (initial: any) => { const index = stateIndex++; if (!(index in states)) states[index] = typeof initial === 'function' ? initial() : initial; return [states[index], (value: any) => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; };
  const useRef = (initial: any) => refs[refIndex++] ||= { current: initial };
  const useEffect = (callback: () => any, deps: any[]) => { const index = effectIndex++, previous = effects[index]; if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) effects[index] = { deps, callback, cleanup: previous?.cleanup }; };
  const document = { getElementById: (id: string) => ({ id, focus: () => focused.push(id) }), activeElement: null, body: {} };
  const scope = { React, useState, useRef, useEffect, PostVariantPreview: ({ platform, variant }: any) => React.createElement('output', null, `Preview ${platform}: ${variant.content}`), PLATFORM_RULES, reviewKeyAction, adSpendActionLabel, adSpendPlatformLabel, formatMinorUnits, document, ...ui, useFocusReturn: () => () => {} };
  const Component = new Function(...Object.keys(scope), code + '; return ContentApprovals;')(...Object.values(scope));
  const render = () => { stateIndex = refIndex = effectIndex = 0; return Component(props); };
  const flush = () => { for (const effect of effects) if (effect.callback) { effect.cleanup?.(); effect.cleanup = effect.callback(); effect.callback = null; } };
  return { render, states, focused, async settle() { for (let round = 0; round < 3; round++) { render(); flush(); await settle(); } return render(); } };
}

const path = '/projects/project-one/approvals';
const post = (id: string, status: string, extra: Record<string, any> = {}) => ({ post: { id, content: `Caption ${id}`, platforms: ['instagram'], accounts: ['ig-1'], platformOverrides: {}, accountOverrides: {}, mediaItems: [], ...(extra.post || {}) }, status, queue: null, assets: [], asset: null, review: { id: 'review-' + id, status: status === 'stale' ? 'approved' : status, requestedAt: '2030-01-01T09:00:00.000Z', requestedBy: { id: 'editor', name: 'Casey Editor' }, ...(extra.review || {}) } });
const spendReview = (extra: Record<string, any> = {}) => ({ id: 'spend-1', status: 'pending', kind: 'ad_spend', consumed: false, requestedBy: { id: 'editor', name: 'Casey Editor' }, requestedAt: '2029-12-31T09:00:00.000Z', reviewedBy: null, reviewedAt: null, note: null, selfApproved: false, snapshot: { subjectId: 'set-1', platform: 'facebook', action: 'ads/adset-budget', amount: 2500, currency: 'AED', currentAmount: 2000, activates: false }, ...extra });
function transport(calls: any[][], posts: any[], reviews: any[] = []) {
  return async (...args: any[]) => {
    calls.push(args); const [url, method] = args;
    if (!method && url.endsWith('/posts')) return { requireApproval: true, requireAdApproval: true, posts };
    if (!method && url.endsWith('/ad-spend')) return { requireAdApproval: true, reviews };
    if (url.endsWith('/ad-spend/review')) return { review: { ...reviews[0], status: args[2].decision } };
    return { item: { ...posts.find(row => url.includes(`/posts/${row.post.id}/`)), status: args[2].decision } };
  };
}
const queue = () => [
  post('later', 'pending', { post: { scheduledAt: '2030-03-02T09:00:00.000Z' } }),
  post('sooner', 'pending', { post: { scheduledAt: '2030-03-01T09:00:00.000Z' } }),
  post('unscheduled-new', 'pending', { review: { requestedAt: '2030-01-02T09:00:00.000Z' } }),
  post('unscheduled-old', 'pending', { review: { requestedAt: '2030-01-01T08:00:00.000Z' } }),
  post('mine', 'pending', { review: { requestedBy: { id: 'me', name: 'Olive Owner' } } }),
  post('returned', 'rejected', { review: { note: 'Shorter, please.' } }),
  post('draft', 'not_requested', { review: null }),
];

test('reviewers open on "Waiting on me": soonest scheduled first, then oldest request, with the first review open', async () => {
  const calls: any[][] = [], view = mount({ projectId: 'project-one', role: 'owner', currentUserId: 'me', request: transport(calls, queue(), [spendReview()]) });
  const tree = await view.settle();
  assert.deepEqual(calls.filter(call => !call[1]).map(call => call[0]).sort(), [path + '/ad-spend', path + '/posts'], 'One read each of the queue and the spend reviews.');
  const views = find(tree, ui.SegmentedControl)[0].props;
  assert.equal(views.value, 'waiting');
  assert.deepEqual(views.options.map((option: any) => option.label), ['Waiting on me · 5', 'All pending · 6', 'Changes requested · 1', 'Approved', 'All · 8'], 'Counts show only on views that hold something.');
  const list = find(tree, ui.SelectableList)[0].props;
  assert.deepEqual(list.items.map((item: any) => item.id), ['sooner', 'later', 'spend:spend-1', 'unscheduled-old', 'unscheduled-new'], 'My own request is not waiting on me.');
  assert.equal(list.selectedId, 'sooner');
  const workspace = find(tree, ui.DetailWorkspace)[0].props;
  assert.equal(workspace.selected, true, 'The first review is open without a click.');
  const detail = html(workspace.detail);
  assert.match(detail, /Caption sooner/); assert.match(detail, />Approve post</); assert.match(detail, />Request changes</);
  assert.equal(elements(tree).filter(node => typeof node.props?.onCheckedChange === 'function').length, 0, 'No settings on the page.');
  assert.match(html(list.items[2].status), /Spend/, 'A spend change carries a Spend chip in the same list.');
});

test('requesting changes needs a comment, from the button and from the R key', async () => {
  const calls: any[][] = [], view = mount({ projectId: 'project-one', role: 'owner', currentUserId: 'me', request: transport(calls, queue()) });
  let tree = await view.settle(); calls.length = 0;
  button(tree, 'Request changes').props.onClick(); await settle();
  const card = find(tree, ui.Card, props => props.id === 'review-sooner')[0];
  card.props.onKeyDown({ key: 'r', altKey: false, ctrlKey: false, metaKey: false, target: 'card', currentTarget: 'card', preventDefault() {} }); await settle();
  assert.deepEqual(calls, [], 'Nothing is sent without a comment.');
  tree = view.render();
  assert.match(html(find(tree, ui.DetailWorkspace)[0].props.detail), /Add a comment so the author knows what to change/);
  assert.ok(view.focused.includes('review-note-sooner'), 'The comment field takes focus.');
  find(tree, ui.Textarea, props => props.id === 'review-note-sooner')[0].props.onChange({ target: { value: 'Shorter caption, please.' } });
  tree = view.render(); assert.doesNotMatch(html(find(tree, ui.DetailWorkspace)[0].props.detail), /Add a comment so/, 'Typing clears the error.');
  button(tree, 'Request changes').props.onClick(); await settle();
  assert.deepEqual(calls[0], [`${path}/posts/sooner/review`, 'POST', { decision: 'rejected', note: 'Shorter caption, please.', reviewId: 'review-sooner' }]);
});

test('a spend change opens from the same list with before, after and the change, and decides through its own route', async () => {
  const calls: any[][] = [], changed: boolean[] = [];
  const view = mount({ projectId: 'project-one', role: 'admin', currentUserId: 'me', request: transport(calls, [], [spendReview()]), onChanged: async () => { changed.push(true); } });
  let tree = await view.settle();
  const list = find(tree, ui.SelectableList)[0].props;
  assert.deepEqual(list.items.map((item: any) => item.id), ['spend:spend-1']);
  const detail = html(find(tree, ui.DetailWorkspace)[0].props.detail);
  assert.match(detail, /Raise ad set budget · Facebook/); assert.match(detail, /Ad set set-1/);
  const before = formatMinorUnits(2000, 'AED'), after = formatMinorUnits(2500, 'AED'), delta = formatMinorUnits(500, 'AED');
  for (const value of [before, after, '+' + delta, '+25%']) assert.ok(detail.includes(value), value);
  calls.length = 0; button(tree, 'Request changes').props.onClick(); await settle();
  assert.deepEqual(calls, [], 'A spend change also needs a comment before changes are requested.');
  tree = view.render(); button(tree, 'Approve spend change').props.onClick(); await settle(); await settle();
  assert.deepEqual(calls, [[`${path}/ad-spend/review`, 'POST', { reviewId: 'spend-1', decision: 'approved', note: '' }], [`${path}/ad-spend`]], 'The decision uses the ad spend route, then the spend list refreshes.');
  assert.deepEqual(changed, [true]);
  const editor = await mount({ projectId: 'project-one', role: 'editor', currentUserId: 'me', request: transport([], [], [spendReview()]) }).settle();
  assert.equal(button(editor, 'Approve spend change'), undefined, 'Editors see spend changes without decision controls.');
});

test('spend changes stay reviewable when the post queue cannot be read', async () => {
  const spendOnly = transport([], [], [spendReview()]), calls: any[][] = [];
  const request = async (...args: any[]) => { calls.push(args); if (args[0].endsWith('/posts')) throw new Error('Queue unavailable'); return spendOnly(...args); };
  const tree = await mount({ projectId: 'project-one', role: 'owner', currentUserId: 'me', request }).settle();
  assert.match(html(tree), /Queue unavailable/);
  assert.deepEqual(find(tree, ui.SelectableList)[0]?.props.items.map((item: any) => item.id), ['spend:spend-1']);
  assert.equal(calls.filter(call => call[0].endsWith('/ad-spend')).length, 1);
});

test('authors find their returned posts under "Waiting on me" and viewers start on everything', async () => {
  const posts = [post('returned-to-me', 'rejected', { review: { requestedBy: { id: 'ed', name: 'Ed' }, note: 'Fix the link.' } }), post('returned-to-other', 'rejected'), post('pending', 'pending')];
  const editor = await mount({ projectId: 'project-one', role: 'editor', currentUserId: 'ed', request: transport([], posts) }).settle();
  assert.deepEqual(find(editor, ui.SelectableList)[0].props.items.map((item: any) => item.id), ['returned-to-me']);
  const detail = html(find(editor, ui.DetailWorkspace)[0].props.detail);
  assert.match(detail, /Fix the link/); assert.match(detail, />Request review</); assert.doesNotMatch(detail, /Approve post/);
  const viewer = await mount({ projectId: 'project-one', role: 'viewer', currentUserId: 'v', request: transport([], posts) }).settle();
  const views = find(viewer, ui.SegmentedControl)[0].props;
  assert.equal(views.value, 'all'); assert.ok(!views.options.some((option: any) => option.value === 'waiting'), 'Nothing can wait on a viewer.');
});

test('an empty "Waiting on me" says so and offers every review', async () => {
  const view = mount({ projectId: 'project-one', role: 'owner', currentUserId: 'me', request: transport([], [post('draft', 'not_requested', { review: null })]) });
  let tree = await view.settle();
  assert.match(html(tree), /Nothing waiting for you/); assert.equal(find(tree, ui.DetailWorkspace).length, 0);
  button(tree, 'Show all reviews').props.onClick(); tree = view.render();
  assert.equal(find(tree, ui.SegmentedControl)[0].props.value, 'all'); assert.deepEqual(find(tree, ui.SelectableList)[0].props.items.map((item: any) => item.id), ['draft']);
});

test('a post edited after approval shows what changed since its review', async () => {
  const edited = post('edited', 'stale', { post: { content: 'New caption', scheduledAt: '2030-03-01T09:00:00.000Z' }, review: { snapshot: { content: 'Old caption', scheduledAt: '2030-03-01T09:00:00.000Z', accounts: ['ig-1'], platforms: ['instagram'], mediaItems: [] } } });
  const tree = await mount({ projectId: 'project-one', role: 'viewer', request: transport([], [edited]) }).settle();
  const detail = html(find(tree, ui.DetailWorkspace)[0].props.detail);
  assert.match(detail, /Edited after approval/);
  assert.match(detail, /scope="row">Text<\/th><td>[^]*?Old caption[^]*?<\/td><td>[^]*?New caption/);
  assert.doesNotMatch(detail, /scope="row">Schedule</, 'Only changed fields are listed.');
});
