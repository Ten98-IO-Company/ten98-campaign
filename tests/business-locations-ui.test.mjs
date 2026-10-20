import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as social from '../shared/social-posts.ts';

const source = await readFile(new URL('../src/PostComposer.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .*;\r?\n/gm, '').replace('export default function PostComposer', 'function PostComposer').replace('export function PostVariantPreview', 'function PostVariantPreview').replace('export const accountLabel', 'const accountLabel'), 'BusinessLocations.tsx', { jsx: { runtime: 'classic' } });
const accounts = ['account-a', 'account-b'].map(id => ({ id, platform: 'googlebusiness', displayName: id, isActive: true }));
const location = (id = 'locations/123') => ({ id, name: '<Bakery>', accountId: 'accounts/native-google', accountName: 'Business owner', address: 'Dubai', category: 'Bakery', storeCode: 'store-01' });
const page = (id = accounts[0].id, locations = [location()]) => ({ accountId: id, platform: 'googlebusiness', locations, selectedLocationId: 'account-default', cached: null, hasMore: null });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
function InstagramToolsProbe() { return null; }
function TikTokToolsProbe() { return null; }

function browser(kind, initialProps) {
  const hooks = [], queued = []; let cursor = 0, dirty = true, tree, props = initialProps;
  const useState = initial => { const index = cursor++; hooks[index] ||= { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, update => { const next = typeof update === 'function' ? update(hooks[index].value) : update; if (!Object.is(next, hooks[index].value)) { hooks[index].value = next; dirty = true; } }]; };
  const useRef = initial => { const index = cursor++; return hooks[index] ||= { current: initial }; };
  const useEffect = (run, dependencies) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) { hooks[index] = { dependencies, close: old?.close }; queued.push(() => { hooks[index].close?.(); hooks[index].close = run(); }); } };
  const context = { React, useState, useRef, useEffect, useMemo: compute => compute(), InstagramPublishingTools: InstagramToolsProbe, TikTokPublishingTools: TikTokToolsProbe, ...social };
  const components = new Function(...Object.keys(context), code + ';return { PostComposer, PublishingDestinations };')(...Object.values(context));
  function paint() { for (let pass = 0; dirty; pass++) { assert.ok(pass < 20, 'Rendering settles.'); dirty = false; cursor = 0; tree = components[kind](props); while (queued.length) queued.shift()(); } }
  const tick = async () => { await new Promise(resolve => setImmediate(resolve)); paint(); };
  const field = label => { const native = nodes(tree).find(node => node.type === 'label' && nodes(node).some(child => child.type === 'span' && child.props.children === label)); return nodes(native).find(node => ['input', 'select', 'textarea'].includes(node.type)); };
  const find = predicate => nodes(tree).find(predicate);
  const snapshot = () => JSON.parse(find(node => node.type === 'input' && node.props.name === 'draftSnapshot').props.value);
  paint();
  return { tick, field, find, snapshot, html: () => renderToStaticMarkup(tree), paint,
    change: async (label, value) => { const input = field(label); assert.ok(input, label); input.props.onChange({ target: { value } }); paint(); await tick(); },
    click: text => { const button = find(node => node.type === 'button' && React.Children.toArray(node.props.children).join('') === text); assert.ok(button, text); const pending = button.props.onClick(); paint(); return pending; },
    setProps: changes => { props = { ...props, ...changes }; dirty = true; paint(); },
    unmount: () => hooks.forEach(hook => hook.close?.()),
  };
}

function picker(respond = async () => page(), changes = {}) {
  const calls = [], writes = [];
  const ui = browser('PublishingDestinations', { platform: 'googlebusiness', accounts: [accounts[0]], options: { topicType: 'STANDARD', locationId: 'locations/manual' }, lookup: async (...args) => { calls.push(args); return respond(...args); }, onChange: options => { writes.push(options); ui.setProps({ options }); }, ...changes });
  return { ...ui, calls, writes };
}

test('actual GBP picker reads only on request, preserves native IDs and metadata, and omits the account-default selection', async () => {
  const ui = picker();
  await ui.change('Search location names (optional)', 'Bakery & tea'); assert.equal(ui.calls.length, 0);
  await ui.click('Load available locations'); await ui.tick();
  assert.deepEqual(ui.calls, [['account-a', 'gmb-locations', { search: 'Bakery & tea' }]]);
  assert.match(ui.html(), /&lt;Bakery&gt;.*Business owner.*Dubai.*Bakery.*store-01.*locations\/123/);
  assert.match(ui.html(), /Cache status not reported/); assert.match(ui.html(), /Completeness not reported/); assert.match(ui.html(), /Reported account default: account-default/);
  assert.match(ui.html(), /Current location · locations\/manual/); assert.equal(ui.writes.length, 0);
  await ui.change('Google Business Profile location', 'locations/123'); assert.deepEqual(ui.writes[0], { topicType: 'STANDARD', locationId: 'locations/123' });
  await ui.change('Google Business Profile location', ''); assert.deepEqual(ui.writes[1], { topicType: 'STANDARD' });
  assert.doesNotMatch(ui.html(), /<img|<script|<a\s|Assign location|Save default/);
});

test('manual and existing IDs survive exclusion, failed reads, and nullable completeness', async () => {
  let result = { ...page('account-a', []), cached: true, hasMore: true };
  const ui = picker(async () => { if (result instanceof Error) throw result; return result; });
  await ui.change('Google Business Profile location ID', 'manual-bare-id');
  await ui.click('Load available locations'); await ui.tick();
  assert.equal(ui.field('Google Business Profile location').props.value, 'manual-bare-id'); assert.match(ui.html(), /Cached choices returned.*Partial list/); assert.match(ui.html(), /No locations returned for this account and search/);
  result = new Error('Permission denied'); await ui.change('Search location names (optional)', 'Elsewhere'); await ui.click('Load available locations'); await ui.tick();
  assert.match(ui.html(), /Permission denied/); assert.doesNotMatch(ui.html(), /No locations returned/); assert.equal(ui.field('Google Business Profile location ID').props.value, 'manual-bare-id');
  result = { ...page(), cached: false, hasMore: false }; await ui.click('Load available locations'); await ui.tick(); assert.match(ui.html(), /Provider reports uncached choices.*no additional locations for this search/);
});

test('account A to B to A, changed searches, disabled scopes and unmount invalidate pending results', async () => {
  const reads = [], ui = picker(() => { const pending = deferred(); reads.push(pending); return pending.promise; });
  const first = ui.click('Load available locations');
  ui.setProps({ accounts: [accounts[1]] }); ui.setProps({ accounts: [accounts[0]] }); reads[0].resolve(page('account-a', [location('stale-account')])); await first; await ui.tick(); assert.doesNotMatch(ui.html(), /stale-account/);
  const second = ui.click('Load available locations'); await ui.change('Search location names (optional)', 'new'); reads[1].reject(new Error('STALE_SEARCH_ERROR')); await second; await ui.tick(); assert.doesNotMatch(ui.html(), /STALE_SEARCH_ERROR|No locations returned/);
  const third = ui.click('Load available locations'); ui.setProps({ disabled: true }); reads[2].resolve(page('account-a', [location('stale-disabled')])); await third; await ui.tick(); assert.doesNotMatch(ui.html(), /stale-disabled/);
  ui.setProps({ disabled: false }); const last = ui.click('Load available locations'); ui.unmount(); reads[3].resolve(page('account-a', [location('stale-unmounted')])); await last; await ui.tick(); assert.doesNotMatch(ui.html(), /stale-unmounted/);
});

test('malformed or foreign pages and oversized search fail without replacing the manual location', async () => {
  for (const response of [{ ...page(), accountId: 'foreign' }, { ...page(), platform: 'instagram' }, page('account-a', [location(), location()]), page('account-a', Array.from({ length: 101 }, (_, index) => location(String(index)))), { ...page(), hasMore: 'yes' }, page('account-a', [{ ...location(), address: {} }])]) {
    const ui = picker(async () => response); await ui.click('Load available locations'); await ui.tick(); assert.match(ui.html(), /available locations could not be verified/); assert.equal(ui.field('Google Business Profile location').props.value, 'locations/manual'); assert.deepEqual(ui.writes, []);
  }
  const ui = picker(); await ui.change('Search location names (optional)', 'x'.repeat(201)); await ui.click('Load available locations'); await ui.tick(); assert.equal(ui.calls.length, 0); assert.match(ui.html(), /at most 200/);
});

test('multiple GBP accounts cannot read or mutate a location and disabled handlers stay inert', async () => {
  const ui = picker(undefined, { accounts });
  assert.match(ui.html(), /Choose one account in Customise destination/); assert.equal(ui.field('Google Business Profile location').props.disabled, true); assert.equal(ui.field('Google Business Profile location ID').props.disabled, true);
  await ui.click('Load available locations'); await ui.change('Google Business Profile location', 'locations/123'); await ui.change('Google Business Profile location ID', 'bare'); assert.deepEqual(ui.calls, []); assert.deepEqual(ui.writes, []);
  const disabled = picker(undefined, { disabled: true }); assert.match(disabled.html(), /<fieldset disabled=""/); await disabled.click('Load available locations'); await disabled.change('Google Business Profile location', 'locations/123'); assert.deepEqual(disabled.calls, []); assert.deepEqual(disabled.writes, []);
});

test('actual composer stores location choices on the exact account and exposes those changes to the draft guard', async () => {
  const post = { id: 'draft', content: 'Update', platforms: ['googlebusiness'], accounts: ['account-a'], mediaItems: [], platformOverrides: { googlebusiness: { options: { topicType: 'STANDARD' } } }, accountOverrides: { 'account-a': { platform: 'googlebusiness', options: { topicType: 'EVENT', languageCode: 'en' } } } };
  const ui = browser('PostComposer', { post, accounts, canWrite: true, onSubmit: async () => {}, onLookupDestinations: async () => page() });
  const widget = () => ui.find(node => typeof node.type === 'function' && node.type.name === 'PublishingDestinations');
  const before = ui.snapshot(); assert.deepEqual(widget().props.options, { topicType: 'EVENT', languageCode: 'en' });
  widget().props.onChange({ ...widget().props.options, locationId: 'locations/123' }); ui.paint();
  const chosen = ui.snapshot(); assert.notDeepEqual(chosen, before); assert.equal(chosen.accountOverrides['account-a'].options.locationId, 'locations/123'); assert.equal(chosen.platformOverrides.googlebusiness.options.locationId, undefined);
  assert.equal(ui.find(node => node.props.name === 'draftSnapshot').props.readOnly, true);
  const sibling = ui.find(node => node.type === 'label' && nodes(node).some(child => child.type === 'span' && React.Children.toArray(child.props.children)[0] === 'account-b'));
  nodes(sibling).find(node => node.type === 'input').props.onChange({ target: { checked: true } }); ui.paint();
  const multiple = ui.snapshot(); assert.equal(social.resolveVariant(multiple, 'googlebusiness', [], 'account-b').options.locationId, undefined); assert.equal(widget().props.accounts.length, 2);
  widget().props.onChange({ locationId: 'cannot-fan-out' }); ui.paint(); assert.deepEqual(ui.snapshot(), multiple);
  await ui.change('Customise destination', 'account-b'); widget().props.onChange({ topicType: 'STANDARD', locationId: 'bare-456' }); ui.paint();
  assert.equal(ui.snapshot().accountOverrides['account-b'].options.locationId, 'bare-456'); assert.equal(ui.snapshot().accountOverrides['account-a'].options.locationId, 'locations/123');
  widget().props.onChange({ topicType: 'STANDARD' }); ui.paint(); assert.equal(Object.hasOwn(ui.snapshot().accountOverrides['account-b'].options, 'locationId'), false);
});

test('SSR composer shows one location picker, keeps account-only options visible and disables read-only controls', () => {
  const hooks = { useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useRef: initial => ({ current: initial }), useEffect() {}, useMemo: compute => compute() };
  const context = { React, ...hooks, ...social }, Composer = new Function(...Object.keys(context), code + ';return PostComposer;')(...Object.values(context));
  const props = { post: { content: 'Update', platforms: ['googlebusiness'], accounts: ['account-a'], mediaItems: [], accountOverrides: { 'account-a': { platform: 'googlebusiness', options: { locationId: 'locations/saved' } } } }, accounts, canWrite: true, readOnly: true, onSubmit: async () => {}, onLookupDestinations: async () => page() };
  const html = renderToStaticMarkup(Composer(props)); assert.equal((html.match(/>Google Business Profile location</g) || []).length, 1); assert.match(html, /Current location · locations\/saved/); assert.match(html, /name="draftSnapshot"/); assert.match(html, /<fieldset disabled=""/); assert.match(html, /Enter a location ID manually/);
});

test('Reddit destination choices and account default survive choosing a subreddit', async () => {
  const ui = picker(async () => ({ subreddits: [{ id: 'r1', name: 'programming', title: 'Programming' }], defaultSubreddit: 'programming' }), { platform: 'reddit', accounts: [{ ...accounts[0], platform: 'reddit' }], options: {} });
  await ui.click('Load subreddits'); await ui.tick(); assert.match(ui.html(), /Choose a connected subreddit/);
  await ui.change('Choose a connected subreddit', 'programming');
  assert.match(ui.html(), /Choose a connected subreddit/); assert.match(ui.html(), /Account default: r\/programming/);
  assert.equal(ui.writes.at(-1).subreddit, 'programming');
});

test('Instagram audio selection updates one account snapshot and cannot fan out to a sibling', async () => {
  const instagram = ['ig-a', 'ig-b'].map(id => ({ id, platform: 'instagram', displayName: id, isActive: true, metadata: { loginMethod: 'facebook_login' } }));
  const post = { content: 'Reel', platforms: ['instagram'], accounts: ['ig-a'], mediaItems: [{ type: 'video', url: 'https://example.test/reel.mp4' }], platformOverrides: { instagram: { options: { shareToFeed: true } } }, accountOverrides: { 'ig-a': { platform: 'instagram', options: { audioConfiguration: { audioVolume: 0.4, videoVolume: 0.7 } } } } };
  const ui = browser('PostComposer', { post, accounts: instagram, canWrite: true, onSubmit: async () => {}, onLookupDestinations: async () => ({}) }), widget = () => ui.find(node => node.type === InstagramToolsProbe);
  assert.equal(widget().props.account.id, 'ig-a');
  const original = ui.snapshot(), options = widget().props.options;
  widget().props.onChange({ ...options, audioConfiguration: { ...options.audioConfiguration, audioId: '123' } }); ui.paint();
  const chosen = ui.snapshot(); assert.notDeepEqual(chosen, original); assert.deepEqual(chosen.accountOverrides['ig-a'].options.audioConfiguration, { audioVolume: 0.4, videoVolume: 0.7, audioId: '123' });
  assert.equal(chosen.platformOverrides.instagram.options.audioConfiguration, undefined);
  const sibling = ui.find(node => node.type === 'label' && nodes(node).some(child => child.type === 'span' && React.Children.toArray(child.props.children)[0] === 'ig-b'));
  nodes(sibling).find(node => node.type === 'input').props.onChange({ target: { checked: true } }); ui.paint();
  const multiple = ui.snapshot(); assert.equal(widget().props.account, null); assert.equal(social.resolveVariant(multiple, 'instagram', [], 'ig-b').options.audioConfiguration, undefined);
  widget().props.onChange({ audioConfiguration: { audioId: 'cannot-fan-out' } }); ui.paint(); assert.deepEqual(ui.snapshot(), multiple);
  await ui.change('Customise destination', 'ig-b'); widget().props.onChange({ audioConfiguration: { audioId: '456' } }); ui.paint();
  assert.equal(ui.snapshot().accountOverrides['ig-a'].options.audioConfiguration.audioId, '123'); assert.equal(ui.snapshot().accountOverrides['ig-b'].options.audioConfiguration.audioId, '456');
});

test('TikTok selections preserve one account options and leave inherited sibling drafts unchanged', async () => {
  const accounts = ['tt-a', 'tt-b'].map(id => ({ id, platform: 'tiktok', displayName: id, isActive: true }));
  const options = { privacyLevel: 'PUBLIC_TO_EVERYONE', musicSoundInfo: { musicSoundId: 'old', musicSoundVolume: 40, musicSoundStart: 0 }, videoOriginalSoundVolume: 70 };
  const post = { content: 'Video', platforms: ['tiktok'], accounts: ['tt-a'], mediaItems: [{ type: 'video', url: 'https://example.test/video.mp4' }], accountOverrides: { 'tt-a': { platform: 'tiktok', options } } };
  const ui = browser('PostComposer', { post, accounts, canWrite: true, onSubmit: async () => {}, onLookupDestinations: async () => ({}) }), widget = () => ui.find(node => node.type === TikTokToolsProbe);
  assert.equal(widget().props.account.id, 'tt-a'); assert.equal(widget().props.mediaItems[0].type, 'video');
  const before = ui.snapshot(); widget().props.onChange({ ...widget().props.options, musicSoundInfo: { ...widget().props.options.musicSoundInfo, musicSoundId: 'clip-one' }, locationId: 'place-one', locationName: 'Exact venue' }); ui.paint();
  const chosen = ui.snapshot(); assert.notDeepEqual(chosen, before); assert.deepEqual(chosen.accountOverrides['tt-a'].options, { ...options, musicSoundInfo: { ...options.musicSoundInfo, musicSoundId: 'clip-one' }, locationId: 'place-one', locationName: 'Exact venue' });
  assert.equal(chosen.platformOverrides.tiktok?.options?.locationId, undefined);
  const sibling = ui.find(node => node.type === 'label' && nodes(node).some(child => child.type === 'span' && React.Children.toArray(child.props.children)[0] === 'tt-b'));
  nodes(sibling).find(node => node.type === 'input').props.onChange({ target: { checked: true } }); ui.paint();
  const multiple = ui.snapshot(); assert.equal(widget().props.account, null); assert.equal(social.resolveVariant(multiple, 'tiktok', [], 'tt-b').options.locationId, undefined);
  widget().props.onChange({ locationId: 'cannot-fan-out', locationName: 'Unreviewed place' }); ui.paint(); assert.deepEqual(ui.snapshot(), multiple);
  await ui.change('Customise destination', 'tt-b'); widget().props.onChange({ locationId: 'place-two', locationName: 'Second venue' }); ui.paint();
  assert.equal(ui.snapshot().accountOverrides['tt-a'].options.locationId, 'place-one'); assert.equal(ui.snapshot().accountOverrides['tt-b'].options.locationId, 'place-two');
});
