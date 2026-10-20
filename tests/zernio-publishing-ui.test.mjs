import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';

const source = (await readFile(new URL('../src/PostComposer.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const compile = (code, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context));
const guards = () => ({ disabled: false, locationBlocked: false, business: false, source: null, search: '', generation: { current: 0 } });

test('publishing selectors read exact account/subreddit choices and retain drafts when lookups fail', async () => {
  const calls = [], states = [], errors = [], pending = { current: false }, scope = 'reddit:account:programming';
  const context = { ...guards(), sourceAccount: 'account/reddit', subreddit: 'programming', pending, scope, requester: { current: async (...args) => { calls.push(args); return args[1] === 'reddit-rules' ? { rules: [{ shortName: 'On topic' }], siteRules: ['No spam'] } : { flairs: [{ id: 'news', text: 'News' }] }; } }, current: { current: scope }, active: { current: true }, setBusy() {}, setError: value => errors.push(value), setData: update => states.push(update({ subreddits: [{ id: 'existing', name: 'programming' }] })) };
  await compile(section('async function load(resource:', '  function change('), context)('reddit-details');
  assert.deepEqual(calls, [['account/reddit', 'reddit-rules', { subreddit: 'programming' }], ['account/reddit', 'reddit-flairs', { subreddit: 'programming' }]]); assert.equal(states[0].rules[0].shortName, 'On topic'); assert.equal(states[0].flairs[0].id, 'news'); assert.equal(states[0].subreddits[0].id, 'existing'); assert.equal(states[0].subredditScope, 'programming');
  context.requester = { current: async () => { throw new Error('Permission expired'); } }; await compile(section('async function load(resource:', '  function change('), context)('pinterest-boards'); assert.equal(states.length, 1); assert.equal(errors.at(-1), 'Permission expired'); assert.equal(pending.current, false);
});

test('publishing selector ignores late account, subreddit and unmounted responses', async () => {
  for (const change of ['account', 'unmount']) {
    let finish; const accepted = [], pending = { current: false }, context = { ...guards(), sourceAccount: 'old-account', subreddit: 'programming', pending, scope: 'old-view', requester: { current: async () => new Promise(resolve => { finish = resolve; }) }, current: { current: 'old-view' }, active: { current: true }, setBusy() {}, setError() {}, setData: value => accepted.push(value) };
    const load = compile(section('async function load(resource:', '  function change('), context), request = load('pinterest-boards');
    context.generation.current++;
    if (change === 'account') { context.current.current = 'different-account-or-subreddit'; pending.current = false; } else context.active.current = false;
    finish({ boards: [{ id: 'old-board', name: 'Wrong project' }] }); await request; assert.deepEqual(accepted, [], change);
    if (change === 'account') assert.equal(pending.current, false, 'The new scope keeps its own pending state.');
  }
});

test('same-scope parent callback changes do not discard a valid publishing lookup', async () => {
  let finish; const accepted = [], context = { ...guards(), sourceAccount: 'same-account', subreddit: '', pending: { current: false }, scope: 'same-view', requester: { current: async () => new Promise(resolve => { finish = resolve; }) }, current: { current: 'same-view' }, active: { current: true }, setBusy() {}, setError() {}, setData: update => accepted.push(update({})) };
  const load = compile(section('async function load(resource:', '  function change('), context), request = load('pinterest-boards');
  context.requester.current = async () => ({ boards: [] }); finish({ boards: [{ id: 'current-board', name: 'Still current' }] }); await request;
  assert.equal(accepted[0].boards[0].id, 'current-board');
});

test('changing subreddit removes stale flair while preserving separate captions, media and unrelated post options', () => {
  const options = { subreddit: 'oldcommunity', flairId: 'old-flair', flairText: 'Old custom text', title: 'Keep title', nsfw: true }, updated = [];
  const change = compile(section('function change(key:', '  const loaded ='), { ...guards(), active: { current: true }, options, onChange: value => updated.push(value) });
  change('subreddit', 'programming'); assert.deepEqual(updated[0], { subreddit: 'programming', title: 'Keep title', nsfw: true }); assert.equal(options.flairId, 'old-flair', 'The current options object is not mutated.');
  change('flairId', 'new-flair'); assert.equal(updated[1].flairId, 'new-flair'); assert.equal(updated[1].subreddit, 'oldcommunity');
  change('playlistId', ''); assert.equal(Object.hasOwn(updated[2], 'playlistId'), false);
});

test('the actual YouTube selector leaves an empty playlist empty and requires explicitly choosing the saved default', async () => {
  const start = source.indexOf('  return <section className="post-tiktok-permissions"', source.indexOf('function PublishingDestinations(')), end = source.indexOf('\n}\n\nfunction MediaEditor', start);
  const jsx = source.slice(start + '  return '.length, end).trim().replace(/;$/, '');
  const { code } = await transformWithOxc(`const render = () => (${jsx});`, 'PublishingDestinations.tsx', { jsx: { runtime: 'classic' } });
  function render(loaded, options = {}) {
    const context = { ...guards(), React, platform: 'youtube', PLATFORM_RULES: { youtube: { label: 'YouTube' } }, sourceAccount: 'yt-account', accounts: [{ id: 'yt-account', name: 'Our channel' }], busy: '', accountId: row => row.id, accountLabel: row => row.name, setSourceId() {}, load() {}, resource: 'youtube-playlists', options, change() {}, loaded, details: {}, error: '', subreddit: '' };
    return renderToStaticMarkup(new Function(...Object.keys(context), code + ';return render();')(...Object.values(context)));
  }
  const loaded = { defaultPlaylistId: 'PL-default', playlists: [{ id: 'PL-default', title: 'Default collection', privacy: 'private' }] };
  const empty = render(loaded); assert.match(empty, /<option value="" selected="">No playlist<\/option>/); assert.doesNotMatch(empty, /Use account default playlist/); assert.match(empty, /Choose it explicitly/); assert.equal((empty.match(/value="PL-default"/g) || []).length, 1, 'A listed default is not duplicated.');
  const selected = render(loaded, { playlistId: 'PL-default' }); assert.match(selected, /<option value="PL-default" selected="">Default collection/);
  const missing = render({ defaultPlaylistId: 'PL-default', playlists: [] }); assert.match(missing, /<option value="PL-default">Saved default playlist/); assert.match(missing, /<option value="" selected="">No playlist/);
});
