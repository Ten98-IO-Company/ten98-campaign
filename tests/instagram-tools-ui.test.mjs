import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';

const source = await readFile(new URL('../src/InstagramPublishingTools.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .*;\r?$/gm, '').replace('export type ', 'type ').replace('export default function ', 'function '), 'InstagramPublishingTools.tsx', { jsx: { runtime: 'classic' } });
const names = Object.keys(ui).filter(name => /^[A-Z]/.test(name));
const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const account = { _id: 'instagram/a', displayName: 'Our Instagram', metadata: { loginMethod: 'facebook_login' } };
const audio = (audioId = '123') => ({ audioId, title: '<Track>', audioType: 'music', durationInMs: 0, displayArtist: null, igUsername: null, isAdsEligible: false, downloadUrl: 'https://never.example/audio', onPlatformAudioPreviewLink: 'https://never.example/preview' });
const binding = (row = account) => ({ accountId: row._id || row.id, platform: 'instagram', loginMethod: row.metadata?.loginMethod === 'facebook_login' ? 'facebook_login' : 'instagram_login' });

function browser(respond = async () => assert.fail('Unexpected read'), extra = {}) {
  const hooks = [], effects = [], calls = [], changes = []; let cursor = 0, dirty = true, tree;
  const state = initial => { const index = cursor++; if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, value => { const next = typeof value === 'function' ? value(hooks[index].value) : value; if (!Object.is(next, hooks[index].value)) { hooks[index].value = next; dirty = true; } }]; };
  const ref = initial => { const index = cursor++; return hooks[index] ||= { current: initial }; };
  const effect = (run, dependencies) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) { hooks[index] = { dependencies, close: old?.close }; effects.push(() => { hooks[index].close?.(); hooks[index].close = run(); }); } };
  const Component = new Function('React', 'useState', 'useRef', 'useEffect', ...names, code + '; return InstagramPublishingTools;')(React, state, ref, effect, ...names.map(name => ui[name]));
  let props = { account, mediaItems: [{ type: 'video', url: 'https://example.test/video.mp4' }], options: { shareToFeed: true, audioConfiguration: { audioId: '99', volume: 0.4, originalAudioVolume: 0.7 } }, lookup: async (...args) => { calls.push(args); return respond(...args); }, onChange: value => changes.push(value), ...extra };
  function paint() { for (let pass = 0; dirty; pass++) { assert.ok(pass < 20, 'Rendering settles.'); dirty = false; cursor = 0; tree = Component(props); while (effects.length) effects.shift()(); } }
  const tick = async () => { await new Promise(resolve => setImmediate(resolve)); paint(); };
  const button = label => { const found = elements(tree).find(node => node.type === ui.Button && React.Children.toArray(node.props.children).join('') === label); assert.ok(found, label); return found; };
  const click = label => { const found = button(label); assert.equal(!!found.props.disabled, false, label); const result = found.props.onClick(); paint(); return result; };
  const change = (label, value) => { const field = elements(tree).find(node => node.type === ui.Field && node.props.label === label); assert.ok(field, label); const input = elements(field).find(node => [ui.Input, ui.Select].includes(node.type)); input.props.onChange({ target: { value } }); paint(); };
  paint();
  return { calls, changes, props: () => props, tick, button, click, change, html: () => renderToStaticMarkup(tree), update: patch => { props = { ...props, ...patch }; dirty = true; paint(); }, unmount: () => hooks.forEach(hook => hook.close?.()) };
}

test('tools render an explicit single account, respect Login and Reel eligibility, and never auto-read', () => {
  for (const props of [{ account: null }, { account: { id: 'ig/direct', username: 'Direct' } }, { account: { ...account, metadata: { loginMethod: 'instagram_login' } } }]) {
    const ui = browser(undefined, props), html = ui.html(); assert.deepEqual(ui.calls, []); assert.deepEqual(ui.changes, []);
    if (!props.account) assert.match(html, /Choose one Instagram account/);
    else { assert.match(html, /Instagram Login/); assert.match(html, /Read publishing limit/); assert.doesNotMatch(html, /Search audio|Look up audio ID|Use this audio/); }
  }
  for (const mediaItems of [[], [{ type: 'image' }], [{ type: 'video' }, { type: 'video' }]]) {
    const ui = browser(undefined, { mediaItems }); assert.match(ui.html(), /requires a single video Reel/); assert.equal(ui.button('Use this audio for this account').props.disabled, true);
  }
  assert.match(browser(undefined, { options: { contentType: 'story' } }).html(), /requires a single video Reel/);
  assert.doesNotMatch(browser().html(), /requires a single video Reel/);
});

test('publishing limit reads only on demand for both Login methods and shows the returned rolling window', async () => {
  for (const loginMethod of ['facebook_login', 'instagram_login']) {
    const chosen = { ...account, metadata: { loginMethod } }, ui = browser(async () => ({ ...binding(chosen), quotaUsage: 7, quotaTotal: 31, quotaDurationSeconds: 43200 }), { account: chosen });
    await ui.click('Read publishing limit'); await ui.tick(); assert.deepEqual(ui.calls, [[account._id, 'instagram-publishing-limit', undefined]]); assert.match(ui.html(), /7 \/ 31 used in the rolling 43200-second window/); assert.match(ui.html(), /does not reserve capacity or provide a reset time/); assert.deepEqual(ui.changes, []);
    ui.update({ account: { ...chosen, _id: 'instagram/b' } }); assert.doesNotMatch(ui.html(), /7 \/ 31/);
  }
  const ui = browser(async () => ({ ...binding(), quotaUsage: 0, quotaTotal: 0, quotaDurationSeconds: 1 })); await ui.click('Read publishing limit'); await ui.tick(); assert.match(ui.html(), /0 \/ 0 used in the rolling 1-second window/);
});

test('search, trending and fresh ID lookup are explicit reads; only Use merges this account audio ID', async () => {
  const ui = browser(async (_id, resource) => ({ ...binding(), audio: resource === 'instagram-audio' ? [audio()] : audio() })), original = structuredClone(ui.props().options);
  ui.change('Audio search query', '  blue & red  '); ui.change('Audio catalog type', 'original_sound'); assert.deepEqual(ui.calls, []);
  await ui.click('Read trending audio'); await ui.tick(); assert.deepEqual(ui.calls.at(-1), [account._id, 'instagram-audio', { audioType: 'original_sound' }]); assert.deepEqual(ui.changes, []);
  await ui.click('Search audio'); await ui.tick(); assert.deepEqual(ui.calls.at(-1), [account._id, 'instagram-audio', { audioType: 'original_sound', q: 'blue & red' }]);
  ui.click('Choose audio ID 123'); assert.equal(ui.button('Use this audio for this account').props.disabled, true); assert.equal(ui.calls.length, 2);
  await ui.click('Look up audio ID'); await ui.tick(); assert.deepEqual(ui.calls.at(-1), [account._id, 'instagram-audio-lookup', { audioId: '123' }]);
  const html = ui.html(); assert.match(html, /&lt;Track&gt;/); assert.match(html, /Duration: 0 ms/); assert.match(html, /Ad eligibility metadata: Not eligible/); assert.match(html, /Artist: Not reported/); assert.match(html, /https:\/\/never.example\/audio/); assert.doesNotMatch(html, /<img|<audio|<iframe|<a\s|<script/); assert.deepEqual(ui.changes, []);
  ui.click('Use this audio for this account'); assert.deepEqual(ui.changes, [{ ...original, audioConfiguration: { ...original.audioConfiguration, audioId: '123' } }]); assert.deepEqual(ui.props().options, original); assert.equal(ui.button('Use this audio for this account').props.disabled, true); assert.equal(ui.calls.length, 3);
});

test('account, media, options, input and callback generations reject late lookup results including A to B to A', async () => {
  const changes = [
    ui => { ui.update({ account: { ...account, _id: 'instagram/b' } }); ui.update({ account }); },
    ui => { ui.update({ mediaItems: [{ type: 'video', url: 'https://example.test/other.mp4' }] }); },
    ui => { ui.update({ options: { ...ui.props().options, shareToFeed: false } }); },
    ui => ui.change('Audio search query', 'new query'),
    ui => ui.change('Audio catalog type', 'original_sound'),
    ui => { ui.change('Instagram audio ID', '456'); ui.change('Instagram audio ID', '123'); },
    ui => ui.update({ lookup: async () => assert.fail('Replacement callback was not explicitly called') }),
    ui => ui.update({ onChange: () => assert.fail('Stale draft write') }),
    ui => { ui.update({ disabled: true }); ui.update({ disabled: false }); },
    ui => ui.unmount(),
  ];
  for (const change of changes) {
    const request = deferred(), ui = browser(async () => request.promise); ui.change('Instagram audio ID', '123'); const read = ui.click('Look up audio ID'); change(ui); request.resolve({ ...binding(), audio: audio() }); await read; await ui.tick(); assert.doesNotMatch(ui.html(), /Audio ID: 123/); assert.equal(ui.button('Use this audio for this account').props.disabled, true); assert.deepEqual(ui.changes, []);
  }
});

test('retained handlers cannot apply a lookup after the draft or callback changes', async () => {
  for (const patch of [{ mediaItems: [{ type: 'image' }] }, { options: { contentType: 'story' } }, { disabled: true }, { account: { ...account, _id: 'instagram/b' } }, { onChange: () => assert.fail('A replaced callback must invalidate Use') }]) {
    const ui = browser(async () => ({ ...binding(), audio: audio() })); ui.change('Instagram audio ID', '123'); await ui.click('Look up audio ID'); await ui.tick(); const retained = ui.button('Use this audio for this account'); assert.equal(retained.props.disabled, false); ui.update(patch); retained.props.onClick(); assert.deepEqual(ui.changes, []);
  }
});

test('empty, nullable, permission errors and malformed responses preserve the existing draft', async () => {
  let result = { ...binding(), audio: [] }, failure;
  const ui = browser(async () => { if (failure) throw failure; return result; }), original = structuredClone(ui.props().options);
  await ui.click('Read trending audio'); await ui.tick(); assert.match(ui.html(), /No audio returned/); assert.deepEqual(ui.changes, []);
  ui.change('Instagram audio ID', '123'); result = { ...binding(), audio: Object.fromEntries(Object.entries(audio()).map(([key, value]) => [key, key === 'audioId' ? value : null])) }; await ui.click('Look up audio ID'); await ui.tick(); assert.match(ui.html(), /Title not reported/); assert.match(ui.html(), /Duration: Not reported/); assert.match(ui.html(), /Ad eligibility metadata: Not reported/);
  failure = new Error('Permission revoked'); await ui.click('Look up audio ID'); await ui.tick(); assert.match(ui.html(), /Permission revoked.*Your draft is unchanged/); assert.equal(ui.button('Use this audio for this account').props.disabled, true);
  failure = null;
  for (const invalid of [{ ...binding(), audio: audio('456') }, { ...binding(), accountId: 'other', audio: audio() }, { ...binding(), audio: { ...audio(), durationInMs: -1 } }]) { result = invalid; await ui.click('Look up audio ID'); await ui.tick(); assert.match(ui.html(), /could not be verified/); assert.equal(ui.button('Use this audio for this account').props.disabled, true); }
  const before = ui.calls.length; ui.change('Instagram audio ID', 'invalid'); await ui.button('Look up audio ID').props.onClick(); await ui.tick(); assert.equal(ui.calls.length, before); assert.match(ui.html(), /1–30 digits/); assert.deepEqual(ui.changes, []); assert.deepEqual(ui.props().options, original);
  result = { ...binding(), quotaUsage: 1, quotaTotal: 2, quotaDurationSeconds: null }; await ui.click('Read publishing limit'); await ui.tick(); assert.match(ui.html(), /publishing limit could not be verified/); assert.doesNotMatch(ui.html(), /Publishing quota:/);
});

test('retained Use cannot bypass a pending or failed replacement lookup', async () => {
  const response = deferred(); let repeat = false;
  const ui = browser(async () => repeat ? response.promise : { ...binding(), audio: audio() });
  ui.change('Instagram audio ID', '123'); await ui.click('Look up audio ID'); await ui.tick();
  const retained = ui.button('Use this audio for this account'); assert.equal(retained.props.disabled, false);
  repeat = true; const pending = ui.click('Look up audio ID'); retained.props.onClick(); assert.deepEqual(ui.changes, []);
  response.reject(new Error('Permission revoked')); await pending; await ui.tick(); retained.props.onClick();
  assert.deepEqual(ui.changes, []); assert.equal(ui.button('Use this audio for this account').props.disabled, true);
});
