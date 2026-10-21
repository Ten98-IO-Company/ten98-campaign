import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';

const source = await readFile(new URL('../src/TikTokPublishingTools.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .*;\r?$/gm, '').replace('export type ', 'type ').replace('export default function ', 'function '), 'TikTokPublishingTools.tsx', { jsx: { runtime: 'classic' } });
const names = Object.keys(ui).filter(name => /^[A-Z]/.test(name));
const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const account = { _id: 'tiktok/a', platform: 'tiktok', displayName: 'Our TikTok', metadata: { tiktokAccountType: 'creator' } };
const track = (id = 'full-track', clip = { id: 'clip-one', durationSec: 20, previewUrl: 'https://never.example/clip' }) => ({ id, commercialMusicId: 'reference-only', name: '<Track>', artist: null, durationSec: 0, genres: null, previewUrl: 'https://never.example/audio', thumbnailUrl: 'https://never.example/image', rank: 1, clip });
const place = (id = 'place-one') => ({ id, name: '<Exact venue>', address: null });
const binding = (row = account) => ({ accountId: row._id || row.id, platform: 'tiktok' });

function browser(respond = async () => assert.fail('Unexpected read'), extra = {}) {
  const hooks = [], effects = [], calls = [], changes = []; let cursor = 0, dirty = true, tree;
  const state = initial => { const index = cursor++; if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, value => { const next = typeof value === 'function' ? value(hooks[index].value) : value; if (!Object.is(next, hooks[index].value)) { hooks[index].value = next; dirty = true; } }]; };
  const ref = initial => { const index = cursor++; return hooks[index] ||= { current: initial }; };
  const effect = (run, dependencies) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) { hooks[index] = { dependencies, close: old?.close }; effects.push(() => { hooks[index].close?.(); hooks[index].close = run(); }); } };
  const Component = new Function('React', 'useState', 'useRef', 'useEffect', ...names, code + '; return TikTokPublishingTools;')(React, state, ref, effect, ...names.map(name => ui[name]));
  let props = { account, mediaItems: [{ type: 'video', url: 'https://example.test/video.mp4' }], options: { privacyLevel: 'PUBLIC_TO_EVERYONE', musicSoundInfo: { musicSoundId: 'old', musicSoundVolume: 60, musicSoundStart: 4 }, videoOriginalSoundVolume: 30, locationId: 'old-place', locationName: 'Old place' }, lookup: async (...args) => { calls.push(args); return respond(...args); }, onChange: value => changes.push(value), ...extra };
  function paint() { for (let pass = 0; dirty; pass++) { assert.ok(pass < 20, 'Rendering settles.'); dirty = false; cursor = 0; tree = Component(props); while (effects.length) effects.shift()(); } }
  const tick = async () => { await new Promise(resolve => setImmediate(resolve)); paint(); };
  const button = label => { const found = elements(tree).find(node => node.type === ui.Button && React.Children.toArray(node.props.children).join('') === label); assert.ok(found, label); return found; };
  const click = label => { const found = button(label); assert.equal(!!found.props.disabled, false, label); const result = found.props.onClick(); paint(); return result; };
  const change = (label, value) => { const field = elements(tree).find(node => node.type === ui.Field && node.props.label === label); assert.ok(field, label); const input = elements(field).find(node => [ui.Input, ui.Select].includes(node.type)); input.props.onChange({ target: { value } }); paint(); };
  paint();
  return { calls, changes, props: () => props, tick, button, click, change, html: () => renderToStaticMarkup(tree), update: patch => { props = { ...props, ...patch }; dirty = true; paint(); }, unmount: () => hooks.forEach(hook => hook.close?.()) };
}

test('TikTok tools read only on demand, avoid OAuth app guesses and block Use for photos or Creator Inbox drafts', async () => {
  const empty = browser(undefined, { account: null }); assert.match(empty.html(), /Choose one TikTok account/); assert.deepEqual(empty.calls, []);
  for (const metadata of [{ tiktokAccountType: 'business' }, { tiktokAccountType: 'creator' }, {}]) { const ui = browser(undefined, { account: { ...account, metadata } }); assert.equal(ui.button('Read commercial music').props.disabled, false); assert.match(ui.html(), /business category does not confirm/); assert.deepEqual(ui.calls, []); }
  for (const patch of [{ mediaItems: [] }, { mediaItems: [{ type: 'image' }] }, { mediaItems: [{ type: 'video' }, { type: 'video' }] }, { options: { mediaType: 'photo' } }, { options: { draft: true } }]) { const ui = browser(async () => ({ ...binding(), tracks: [track()] }), patch); await ui.click('Read commercial music'); await ui.tick(); ui.change('Commercial music track', 'full-track'); assert.equal(ui.button('Use this music for this account').props.disabled, true); assert.match(ui.html(), /Creator Inbox drafts ignore these fields/); assert.deepEqual(ui.changes, []); }
  const inactive = browser(undefined, { account: { ...account, needsReconnection: true } }); assert.equal(inactive.button('Read commercial music').props.disabled, true);
});

test('music reads global or country charts and only Use chooses clip ID while preserving volume, timing and other options', async () => {
  const ui = browser(async () => ({ ...binding(), tracks: [track()] })), original = structuredClone(ui.props().options);
  await ui.click('Read commercial music'); await ui.tick(); assert.deepEqual(ui.calls, [[account._id, 'tiktok-commercial-music', undefined]]); assert.deepEqual(ui.changes, []);
  ui.change('Music chart country code (optional)', 'ae'); await ui.click('Read commercial music'); await ui.tick(); assert.deepEqual(ui.calls.at(-1), [account._id, 'tiktok-commercial-music', { countryCode: 'AE' }]);
  ui.change('Commercial music track', 'full-track'); const html = ui.html(); assert.match(html, /Selected sound ID: clip-one/); assert.match(html, /reference-only/); assert.match(html, /&lt;Track&gt;/); assert.match(html, /Track duration: 0 seconds/); assert.match(html, /https:\/\/never.example\/clip/); assert.doesNotMatch(html, /<img|<audio|<iframe|<a\s|<script/); assert.deepEqual(ui.changes, []);
  ui.click('Use this music for this account'); assert.deepEqual(ui.changes, [{ ...original, musicSoundInfo: { ...original.musicSoundInfo, musicSoundId: 'clip-one' } }]); assert.deepEqual(ui.props().options, original); assert.equal(ui.button('Use this music for this account').props.disabled, true); assert.equal(ui.calls.length, 2);
});

test('music fallback uses the full track ID and location Use preserves the exact provider ID and name', async () => {
  const music = browser(async () => ({ ...binding(), tracks: [track('fallback-track', null)] })); await music.click('Read commercial music'); await music.tick(); music.change('Commercial music track', 'fallback-track'); assert.match(music.html(), /Full track fallback/); music.click('Use this music for this account'); assert.equal(music.changes[0].musicSoundInfo.musicSoundId, 'fallback-track'); assert.notEqual(music.changes[0].musicSoundInfo.musicSoundId, 'reference-only');
  const ui = browser(async () => ({ ...binding(), locations: [place()] })), original = structuredClone(ui.props().options);
  ui.change('TikTok place search', '  venue & city  '); assert.deepEqual(ui.calls, []); await ui.click('Search TikTok locations'); await ui.tick(); assert.deepEqual(ui.calls, [[account._id, 'tiktok-locations', { query: 'venue & city' }]]); assert.deepEqual(ui.changes, []);
  ui.change('TikTok location tag', 'place-one'); assert.match(ui.html(), /&lt;Exact venue&gt;/); assert.match(ui.html(), /closest or fuzzy matches/); assert.match(ui.html(), /does not establish that a place is missing/); ui.click('Use this location for this account'); assert.deepEqual(ui.changes, [{ ...original, locationId: 'place-one', locationName: '<Exact venue>' }]); assert.deepEqual(ui.props().options, original);
});

test('TikTok reads discard stale account, input, callback, media, options and mount generations including A to B to A', async () => {
  const changes = [ui => { ui.update({ account: { ...account, _id: 'tiktok/b' } }); ui.update({ account }); }, ui => { ui.update({ mediaItems: [{ type: 'image' }] }); }, ui => ui.update({ options: { draft: true } }), ui => { ui.change('Music chart country code (optional)', 'AE'); ui.change('Music chart country code (optional)', ''); }, ui => { ui.change('TikTok place search', 'changed'); ui.change('TikTok place search', 'venue'); }, ui => ui.update({ lookup: async () => assert.fail('New callback was not explicitly called') }), ui => ui.update({ onChange: () => assert.fail('Stale write') }), ui => { ui.update({ disabled: true }); ui.update({ disabled: false }); }, ui => ui.unmount()];
  for (const change of changes) {
    const response = deferred(), ui = browser(async () => response.promise); ui.change('TikTok place search', 'venue'); const pending = ui.click('Search TikTok locations'); change(ui); response.resolve({ ...binding(), locations: [place()] }); await pending; await ui.tick(); assert.doesNotMatch(ui.html(), /TikTok location tag/); assert.equal(ui.button('Use this location for this account').props.disabled, true); assert.deepEqual(ui.changes, []);
  }
});

test('retained TikTok Use handlers cannot write after selection changes, scope changes or a pending or failed replacement read', async () => {
  for (const patch of [{ mediaItems: [{ type: 'image' }] }, { options: { draft: true } }, { disabled: true }, { account: { ...account, _id: 'tiktok/b' } }, { onChange: () => assert.fail('Stale callback') }]) {
    const ui = browser(async () => ({ ...binding(), tracks: [track()] })); await ui.click('Read commercial music'); await ui.tick(); ui.change('Commercial music track', 'full-track'); const retained = ui.button('Use this music for this account'); assert.equal(retained.props.disabled, false); ui.update(patch); retained.props.onClick(); assert.deepEqual(ui.changes, []);
  }
  const response = deferred(); let repeat = false;
  const ui = browser(async () => repeat ? response.promise : { ...binding(), tracks: [track(), track('another-track', null)] }); await ui.click('Read commercial music'); await ui.tick(); ui.change('Commercial music track', 'full-track'); const retained = ui.button('Use this music for this account'); ui.change('Commercial music track', 'another-track'); retained.props.onClick(); assert.deepEqual(ui.changes, []);
  const second = ui.button('Use this music for this account'); repeat = true; const pending = ui.click('Read commercial music'); second.props.onClick(); assert.deepEqual(ui.changes, []); response.reject(new Error('Capability denied')); await pending; await ui.tick(); second.props.onClick(); assert.deepEqual(ui.changes, []); assert.match(ui.html(), /Capability denied.*TikTok for Business app.*draft is unchanged/);
});

test('TikTok empty, malformed, duplicate and failed results never alter the draft or offer unverified selections', async () => {
  let result = { ...binding(), tracks: [] };
  const ui = browser(async () => result); await ui.click('Read commercial music'); await ui.tick(); assert.match(ui.html(), /No commercial music returned/); assert.equal(ui.button('Use this music for this account').props.disabled, true);
  for (const invalid of [{ ...binding(), accountId: 'other', tracks: [track()] }, { ...binding(), platform: 'instagram', tracks: [track()] }, { ...binding(), tracks: [track(), track()] }, { ...binding(), tracks: [track('bad', {})] }, { ...binding(), tracks: [{ ...track(), durationSec: -1 }] }]) { result = invalid; await ui.click('Read commercial music'); await ui.tick(); assert.match(ui.html(), /could not be verified/); assert.equal(ui.button('Use this music for this account').props.disabled, true); }
  ui.change('TikTok place search', 'venue'); result = { ...binding(), locations: [] }; await ui.click('Search TikTok locations'); await ui.tick(); assert.match(ui.html(), /No location tags returned/);
  result = { ...binding(), locations: [place(), place()] }; await ui.click('Search TikTok locations'); await ui.tick(); assert.match(ui.html(), /location results could not be verified/); assert.deepEqual(ui.changes, []);
  const count = ui.calls.length; ui.change('Music chart country code (optional)', '123'); await ui.button('Read commercial music').props.onClick(); await ui.tick(); assert.equal(ui.calls.length, count); assert.match(ui.html(), /two-letter country code/);
});
