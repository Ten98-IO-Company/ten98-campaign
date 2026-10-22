import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import * as social from '../shared/social-posts.ts';
import { PLATFORM_RULES, normalizePostVariants, normalizePostTags, normalizeAccountVariants, publicMediaUrl, resolveVariant } from '../shared/social-posts.ts';

const source = await readFile(new URL('../src/PostComposer.tsx', import.meta.url), 'utf8');

test('provider post updates and lifecycle actions display retained-media warnings returned by the server', async () => {
  const management = await readFile(new URL('../src/PostManagement.tsx', import.meta.url), 'utf8'), notices = [], saved = [], post = { id: 'post' }, warning = 'Existing provider media was retained. Its temporary library link has expired.';
  const context = { ambiguousCopies: false, divergentCopies: false, accountCopiesReady: true, replaceVariants: false, post, setBusy() {}, setError() {}, setNotice: value => notices.push(value), setCurrent: value => saved.push(value), requester: { current: async () => ({ post, validationWarnings: [warning, null] }) }, onChanged() {} };
  for (const [name, next, args] of [['act', '  async function update(', ['social/retry', {}, 'Retry submitted.']], ['update', '\n  return <Card as="section"', [{ content: 'Caption', scheduledAt: '2070-01-02T00:00:00Z' }]]]) {
    const start = management.indexOf('async function ' + name + '('), declaration = stripTypeScriptTypes(management.slice(start, management.indexOf(next, start)).trim());
    await new Function(...Object.keys(context), `return (${declaration});`)(...Object.values(context))(...args);
    assert.match(notices.at(-1), /Existing provider media was retained/);
  }
  assert.equal(saved.length, 2);
});

test('late browser and provider media inspections cannot restore removed media or cross platform editors', async () => {
  const compile = (value, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(value)});`)(...Object.values(context));
  const updateSource = source.slice(source.indexOf('function update(index:'), source.indexOf('  async function inspect('));
  const providerSource = source.slice(source.indexOf('async function inspectWithProvider('), source.indexOf('\n  return <', source.indexOf('async function inspectWithProvider(')));
  const browserSource = source.slice(source.indexOf('async function inspect(index:'), source.indexOf('  async function inspectWithProvider('));
  const lifecycle = source.match(/useEffect\((\(\) => \{ active.current = true; return \(\) => \{ active.current = false; \}; \}), \[\]\);/)[1];
  assert.match(source, /<MediaEditor key=\{editKey\} items=\{override.mediaItems/, 'Platform and account tabs must mount separate media editors even when the source URL matches.');
  for (const kind of ['provider', 'browser']) {
    const active = { current: false }, current = { current: [{ type: 'image', url: 'https://cdn.example.com/shared.jpg', altText: 'Instagram creative' }] }, writes = [];
    const unmount = compile(lifecycle, { active })();
    const update = compile(updateSource, { active, current, onChange: value => writes.push(value) });
    let finish;
    class Video {}
    class ImageElement { naturalWidth = 1200; naturalHeight = 800; set src(value) { finish = () => this.onload(); } }
    const context = { active, current, inspecting: -1, update, onInspect: () => new Promise(resolve => { finish = () => resolve({ valid: true, size: 1200, contentType: 'image/jpeg' }); }), setInspecting() {}, setNotice() {}, previewUrl: value => value, Image: ImageElement, HTMLImageElement: ImageElement, HTMLVideoElement: Video, window: { setTimeout: () => 0 }, clearTimeout() {} };
    const check = compile(kind === 'provider' ? providerSource : browserSource, context)(0);
    unmount();
    // The parent has switched to text-only, another asset source, or a different platform.
    finish(); await check;
    assert.deepEqual(writes, [], `${kind} inspection must not reattach media after the editor is removed.`);
    assert.equal(active.current, false);
    compile(lifecycle, { active })(); update(0, { width: 640 });
    assert.equal(writes[0][0].width, 640, 'A live editor can still apply metadata without losing its own caption or media fields.');
    assert.equal(writes[0][0].altText, 'Instagram creative');
  }
});
const expression = source.match(/const values = useMemo\(\(\) => \((.+)\), \[content,/)[1];
function draft(changes = {}) {
  const state = { tagInput: '', content: 'Shared caption', platforms: ['facebook', 'instagram'], post: undefined, selectedAccounts: [], accountsTouched: false, accounts: [], baseMode: 'asset', assetId: 'shared-creative', campaignId: '', scheduledAt: '', queueId: '', queueVersion: '', baseMedia: [], accountOverrides: {}, overrides: { instagram: { content: '', mediaItems: [], options: { contentType: 'story' } } }, ...changes };
  return new Function(...Object.keys(state), 'PLATFORM_RULES', `return (${expression});`)(...Object.values(state), PLATFORM_RULES);
}

test('composer saves separate captions/media, explicit empty overrides, DAM resets and destination selection without data loss', () => {
  const values = draft();
  assert.equal(Object.hasOwn(values, 'accounts'), false, 'Unloaded legacy account selection must remain unspecified.');
  assert.equal(values.mediaItems, null, 'Selecting a DAM creative must clear previously saved custom media.');
  assert.equal(values.assetId, 'shared-creative');
  assert.deepEqual(values.platformOverrides.instagram, { content: '', mediaItems: [], options: { contentType: 'story' } });
  assert.deepEqual(resolveVariant(values, 'instagram'), { platform: 'instagram', content: '', mediaItems: [], options: { contentType: 'story' } });
  assert.deepEqual(draft({ accounts: [{ id: 'fb-account', platform: 'facebook' }] }).accounts, [], 'Visible unchecked account controls mean clear the recipient selection.');
  assert.deepEqual(draft({ post: { accounts: ['saved-account'] }, selectedAccounts: ['saved-account'] }).accounts, ['saved-account']);
  assert.deepEqual(draft({ accountsTouched: true }).accounts, []);
  assert.deepEqual(draft({ baseMode: 'custom', baseMedia: [{ type: 'image', url: 'https://cdn.example.com/image.jpg' }] }).mediaItems, [{ type: 'image', url: 'https://cdn.example.com/image.jpg' }]);
  assert.deepEqual(draft({ baseMode: 'none' }).mediaItems, []);
  assert.equal(draft({ platforms: ['facebook'] }).platformOverrides.instagram, undefined, 'Unselected platform overrides are not submitted.');
  assert.equal(draft({ scheduledAt: '2030-10-18T17:00' }).scheduledAt, new Date('2030-10-18T17:00').toISOString());
  assert.equal(draft({ scheduledAt: '2030-10-18T17:00' }).status, 'scheduled');
});

test('composer saves a reviewed queue as local intent and explicitly clears it when choosing a fixed time', () => {
  const intent = { queueId: 'queue-launch', queueVersion: 'a'.repeat(64) }, queued = draft(intent);
  assert.equal(queued.queueId, intent.queueId); assert.equal(queued.queueVersion, intent.queueVersion);
  assert.equal(queued.scheduledAt, '', 'Queue previews must not become a fixed scheduled date in the saved draft.');
  assert.equal(queued.status, 'draft', 'Saving a queue choice leaves publication as a separate action.');
  const fixed = draft({ post: intent, scheduledAt: '2030-10-18T17:00' });
  assert.equal(fixed.queueId, ''); assert.equal(fixed.queueVersion, '');
  assert.equal(fixed.scheduledAt, new Date('2030-10-18T17:00').toISOString()); assert.equal(fixed.status, 'scheduled');
  assert.equal(Object.hasOwn(draft(), 'queueId'), false, 'Ordinary drafts retain their existing shape.');
});

test('account editor stores changes only for that account and submitting drops unselected account variants', () => {
  const handler = source.slice(source.indexOf('function changeOverride('), source.indexOf('  function togglePlatform('));
  let copies = { first: { platform: 'facebook', content: 'First', options: { firstComment: 'Keep' } }, second: { platform: 'facebook', content: 'Second' } }, platforms = { facebook: { content: 'Default' } }, inputs = { 'facebook:first:firstComment': 'Stale account option', 'facebook:second:firstComment': 'Second option' }, errors = { 'facebook:first:firstComment': 'Old error' };
  const context = { own: Object.hasOwn, selected: 'facebook', editingAccountId: 'first', editKey: 'facebook:first', setAccountOverrides: update => { copies = update(copies); }, setOverrides: update => { platforms = update(platforms); }, setOptionInputs: update => { inputs = update(inputs); }, setOptionErrors: update => { errors = update(errors); } };
  const change = new Function(...Object.keys(context), `return (${stripTypeScriptTypes(handler)});`)(...Object.values(context));
  change({ content: '', mediaItems: [], options: {} });
  assert.deepEqual(copies.first, { platform: 'facebook', content: '', mediaItems: [], options: {} }); assert.equal(copies.second.content, 'Second'); assert.equal(platforms.facebook.content, 'Default');
  assert.deepEqual(inputs, { 'facebook:second:firstComment': 'Second option' }); assert.deepEqual(errors, {});
  change({}, ['content', 'mediaItems', 'options']); assert.deepEqual(copies.first, { platform: 'facebook' }, 'Turning off separate fields restores inheritance.');
  const saved = draft({ platforms: ['facebook'], selectedAccounts: ['second'], accountOverrides: { ...copies, foreign: { platform: 'facebook', content: 'Not selected' } } });
  assert.deepEqual(saved.accountOverrides, { second: copies.second }); assert.equal(Object.hasOwn(draft(), 'accountOverrides'), false, 'Legacy drafts retain their stored shape.');
});

test('actual account composer rendering shows distinct caption, media, options and time controls without changing platform defaults', async () => {
  const { code } = await transformWithOxc(source.replace(/^import .*;\r?\n/gm, '').replace('export default function PostComposer', 'function PostComposer').replace('export function PostVariantPreview', 'function PostVariantPreview').replace('export const accountLabel', 'const accountLabel'), 'PostComposer.tsx', { jsx: { runtime: 'classic' } });
  const accounts = [{ id: 'first', platform: 'facebook', displayName: 'Brand One' }, { id: 'second', platform: 'facebook', displayName: 'Brand Two' }];
  const post = { id: 'post', content: 'Shared caption', platforms: ['facebook'], accounts: ['first', 'second'], scheduledAt: '2070-01-01T09:00:00Z', mediaItems: [], platformOverrides: { facebook: { content: 'Platform caption', options: { firstComment: 'Platform comment' } } }, accountOverrides: { second: { platform: 'facebook', content: 'Second brand caption', mediaItems: [{ type: 'image', url: 'https://cdn.example.test/second.jpg' }], options: {}, scheduledAt: '2070-01-02T09:00:00Z' } } };
  let stateIndex = 0;
  const portals = [], hooks = { useState: initial => { const index = stateIndex++; return [index === 13 ? 'second' : typeof initial === 'function' ? initial() : initial, () => {}]; }, useRef: initial => ({ current: initial }), useEffect() {}, useMemo: compute => compute(), useId: () => 'composer-form' };
  const context = { React, ...hooks, ...social, ...ui, MediaImage: ui.Image, createPortal: (node, host) => { portals.push([node, host]); return null; } };
  const Composer = new Function(...Object.keys(context), code + ';return PostComposer;')(...Object.values(context));
  const html = renderToStaticMarkup(Composer({ post, accounts, assets: [], campaigns: [], canWrite: true, onSubmit: async () => {} }));
  assert.match(html, /<form id="composer-form"[\s\S]*<div class="t98-form-actions">[\s\S]*>Cancel<\/button>[\s\S]*form="composer-form"[^>]*>Save changes<\/button>[\s\S]*<\/form>/, 'Without a footer host (the provider post editor) the actions follow the form.');
  // In the editor Dialog the actions render into its always-visible footer, outside the form, so Save names the form it submits.
  stateIndex = 0; const host = {}, hosted = renderToStaticMarkup(Composer({ post, accounts, assets: [], campaigns: [], canWrite: true, onSubmit: async () => {}, actionsHost: host }));
  assert.doesNotMatch(hosted, />Save changes</); assert.equal(portals.length, 1); assert.equal(portals[0][1], host);
  assert.match(renderToStaticMarkup(portals[0][0]), /^<button type="button"[^>]*>Cancel<\/button><button type="submit"[^>]*form="composer-form"[^>]*>Save changes<\/button>$/);
  assert.match(html, /Customise destination/); assert.match(html, /Brand Two · second/); assert.match(html, /Second brand caption/); assert.match(html, /second\.jpg/); assert.match(html, /Separate account publishing options/); assert.match(html, /Separate account time/); assert.match(html, /2070-01-02/); assert.equal(post.platformOverrides.facebook.content, 'Platform caption');
});

test('group recipient selection copies reviewed IDs, blocks unavailable members and ignores a response after its scope closes', async () => {
  const picker = source.slice(source.indexOf('function AccountGroupPicker('), source.indexOf('function previewUrl(')), compile = (code, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context));
  const members = [{ _id: 'first', platform: 'facebook', displayName: 'First page' }, { _id: 'second', platform: 'facebook', displayName: 'Second page' }], copied = [], notices = [], group = { _id: 'group', name: 'Launch pages', accountIds: ['first', 'second'] }, data = { groups: [group], accounts: members };
  const choose = picker.slice(picker.indexOf('function choose()'), picker.indexOf('\n  return <', picker.indexOf('function choose()')));
  const context = { disabled: false, busy: false, canChoose: true, members, data, group, onChoose: (...args) => copied.push(args), setNotice: value => notices.push(value) };
  compile(choose, context)(); members[0].displayName = 'Changed group directory'; group.accountIds.push('later-account');
  assert.deepEqual(copied[0][0].map(row => row._id), ['first', 'second']); assert.equal(copied[0][0][0].displayName, 'First page'); assert.match(notices[0], /Later group changes will not change/);
  compile(choose, { ...context, canChoose: false })(); assert.equal(copied.length, 1, 'A group with any unavailable member cannot be partly applied.');
  let finish; const accepted = [], active = { current: true }, generation = { current: 0 }, pending = { current: false };
  const refresh = compile(picker.slice(picker.indexOf('async function refresh()'), picker.indexOf('  const group =')), { disabled: false, pending, generation, active, setBusy() {}, setError() {}, load: () => new Promise(resolve => { finish = resolve; }), setData: value => accepted.push(value), setSelectedId() {}, setNotice() {} });
  const loading = refresh(); active.current = false; generation.current++; finish(data); await loading; assert.deepEqual(accepted, []); assert.equal(pending.current, false);
  const { code } = await transformWithOxc(picker, 'AccountGroupPicker.tsx', { jsx: { runtime: 'classic' } });
  let index = 0; const badData = { groups: [{ _id: 'blocked', name: 'Mixed channels', accountIds: ['inactive', 'ads', 'missing'] }], accounts: [{ _id: 'inactive', platform: 'facebook', displayName: 'Disconnected page', isActive: false }, { _id: 'ads', platform: 'google', displayName: 'Ads connection' }] };
  const scope = { ...ui, React, PLATFORM_RULES, accountId: row => row._id || row.id, accountLabel: row => row.displayName || row._id || row.id, useState: initial => [[badData, 'blocked', false, '', ''][index++] ?? initial, () => {}], useRef: initial => ({ current: initial }), useEffect() {} };
  const Picker = new Function(...Object.keys(scope), code + ';return AccountGroupPicker;')(...Object.values(scope)), html = renderToStaticMarkup(Picker({ load: async () => badData, onChoose() {}, disabled: false }));
  assert.match(html, /Reconnection required/); assert.match(html, /Social publishing unavailable/); assert.match(html, /Unavailable in this project/); assert.match(html, /no members will be silently skipped/); assert.match(html, /aria-disabled="true"[^>]*>Replace destinations with these accounts/);
});

test('an empty custom-media editor and an empty asset selector retain their selected editing mode', () => {
  const mode = source.match(/const mediaMode = (.+);/)[1];
  const evaluate = (override, platformMediaModes = {}, editKey = 'instagram:') => new Function('own', 'override', 'platformMediaModes', 'editKey', `return (${mode});`)((item, key) => Object.hasOwn(item, key), override, platformMediaModes, editKey);
  assert.equal(evaluate({ mediaItems: [] }, { 'instagram:': 'custom' }), 'custom');
  assert.equal(evaluate({ assetId: '' }, { 'instagram:': 'asset' }), 'asset');
  assert.equal(evaluate({ mediaItems: [] }, { 'instagram:account-a': 'custom' }, 'instagram:account-b'), 'none', 'Account editor modes cannot leak into a different account.');
  assert.equal(evaluate({ mediaItems: [] }), 'none');
  assert.equal(evaluate({}), 'shared');
});

test('composer saves incomplete platform drafts but blocks malformed options and preserves entries on a failed save', async () => {
  const handler = source.slice(source.indexOf('async function submit('), source.indexOf('  async function checkWithProvider(')).replace('event: React.FormEvent<HTMLFormElement>', 'event').replace('(failure as Error)', 'failure');
  function submit(values, changes = {}) {
    const errors = [], calls = [], saving = [], focused = [];
    const context = { disabled: false, setError: error => errors.push(error), platforms: values.platforms, optionErrors: {}, normalizePostTags, normalizePostVariants, normalizeAccountVariants, values, setSaving: value => saving.push(value), onSubmit: async value => calls.push(value), headingRef: { current: { focus: () => focused.push(true) } }, ...changes };
    const action = new Function(...Object.keys(context), `return (${handler});`)(...Object.values(context));
    return { action, errors, calls, saving, focused };
  }
  const incomplete = draft({ content: '', baseMode: 'none', overrides: {} }), saved = submit(incomplete);
  await saved.action({ preventDefault() {} });
  assert.deepEqual(saved.calls, [incomplete], 'A draft without Instagram media remains saveable; publishing owns restriction enforcement.');
  assert.deepEqual(saved.saving, [true, false]);
  const malformed = submit(draft({ overrides: { instagram: { options: { unsupportedOption: true } } } }));
  await malformed.action({ preventDefault() {} }); assert.equal(malformed.calls.length, 0); assert.match(malformed.errors.at(-1), /unsupportedOption/);
  const invalidRaw = submit(incomplete, { optionErrors: { 'instagram:poll': 'Poll must contain valid JSON.' } });
  await invalidRaw.action({ preventDefault() {} }); assert.equal(invalidRaw.calls.length, 0); assert.equal(invalidRaw.errors.at(-1), 'Poll must contain valid JSON.');
  const failed = submit(incomplete, { onSubmit: async () => { throw new Error('Save interrupted.'); } });
  await failed.action({ preventDefault() {} }); assert.equal(failed.errors.at(-1), 'Save interrupted.'); assert.deepEqual(failed.focused, [true]); assert.equal(incomplete.content, '');
  const readOnly = submit(incomplete, { disabled: true }); await readOnly.action({ preventDefault() {} }); assert.equal(readOnly.calls.length, 0);
});

test('submitted previews resolve DAM variants and preserve each account’s explicit empty caption, media and options', async () => {
  const management = await readFile(new URL('../src/PostManagement.tsx', import.meta.url), 'utf8');
  const helper = management.slice(management.indexOf('function previewCopy('), management.indexOf('\nexport default function')).replace('post: any, copy: any, assets: any[]', 'post, copy, assets');
  const preview = new Function('resolveVariant', `return (${helper});`)(resolveVariant);
  const assets = [{ id: 'instagram-creative', kind: 'image', deliveryUrl: 'https://cdn.example.com/instagram.jpg' }];
  const post = { content: 'Shared caption', platformOverrides: { instagram: { assetId: 'instagram-creative', content: 'Instagram caption', options: { firstComment: 'First comment' } } } };
  assert.deepEqual(preview(post, { platform: 'instagram' }, assets).mediaItems, [{ type: 'image', url: 'https://cdn.example.com/instagram.jpg' }]);
  const actual = preview(post, { platform: 'instagram', customContent: '', customMedia: [], platformSpecificData: {} }, assets);
  assert.equal(actual.content, ''); assert.deepEqual(actual.mediaItems, []); assert.deepEqual(actual.options, {});
  const second = preview(post, { platform: 'instagram', customContent: 'Second account caption', customMedia: [{ type: 'video', url: 'https://cdn.example.com/video.mp4' }], platformSpecificData: { commentsEnabled: false } }, assets);
  assert.equal(second.content, 'Second account caption'); assert.equal(second.mediaItems[0].type, 'video'); assert.equal(second.options.commentsEnabled, false);
});

test('previews show the actual thread sequence and Discord poll choices and reject private media hosts', () => {
  const entries = source.match(/const entries: .+ = (.+);/)[1], answers = source.match(/const pollAnswers = (.+);/)[1].replace('answer: any', 'answer');
  const thread = [{ content: 'First threaded post' }, { content: '', mediaItems: [{ type: 'image', url: 'https://cdn.example.com/image.jpg' }] }];
  const previewEntries = new Function('options', 'variant', `return (${entries});`);
  assert.deepEqual(previewEntries({ threadItems: thread }, { content: 'Ignored shared caption' }), thread);
  assert.deepEqual(previewEntries({}, { content: 'Shared caption' }), [{ content: 'Shared caption' }]);
  const pollAnswers = new Function('options', `return (${answers});`);
  assert.deepEqual(pollAnswers({ poll: { answers: [{ poll_media: { text: 'Yes' } }, { poll_media: { text: 'No' } }] } }), ['Yes', 'No']);
  assert.deepEqual(pollAnswers({ poll: { options: ['Option one', 'Option two'] } }), ['Option one', 'Option two']);
  const guard = source.slice(source.indexOf('function previewUrl('), source.indexOf('\nconst destinationFields')).replace('value: string', 'value');
  const url = new Function('publicMediaUrl', `return (${guard});`)(publicMediaUrl);
  assert.equal(url('https://sub.localhost/image.jpg'), ''); assert.equal(url('https://drive.google.com/file/d/private/view'), ''); assert.equal(url('https://cdn.example.com/creative.gif'), 'https://cdn.example.com/creative.gif');
});

test('TikTok Creator Inbox drafts are labelled as a handoff rather than public delivery', async () => {
  const management = await readFile(new URL('../src/PostManagement.tsx', import.meta.url), 'utf8');
  const expression = management.match(/const deliveryLabel = (.+);/)[1].replace('item: any', 'item');
  const label = new Function(`return (${expression});`)();
  for (const flag of ['isDraft', 'draft']) assert.equal(label({ platform: 'tiktok', status: 'published', platformSpecificData: { [flag]: true } }), 'Handed to TikTok draft — finish in TikTok');
  assert.equal(label({ platform: 'tiktok', status: 'published', platformSpecificData: { isDraft: false } }), 'published');
  assert.equal(label({ platform: 'facebook', status: 'draft', platformSpecificData: { draft: true } }), 'draft');
});

test('legacy unsupported destinations remain removable while new drafts offer only publishing platforms', () => {
  const predicate = source.match(/Object.entries\(PLATFORM_RULES\)\.filter\((.*?)\)\.map/)[1];
  const choices = platforms => Object.entries(PLATFORM_RULES).filter(new Function('platforms', `return (${predicate});`)(platforms)).map(([platform]) => platform);
  assert.equal(choices([]).includes('whatsapp'), false);
  assert.equal(choices(['facebook', 'whatsapp']).includes('whatsapp'), true);
  const handler = source.slice(source.indexOf('function togglePlatform('), source.indexOf('  function updateOption(')).replace('platform: string', 'platform');
  let platforms = ['facebook', 'whatsapp'], selected = ['fb-account', 'wa-account'];
  const toggle = new Function('platforms', 'selectedAccounts', 'socialAccounts', 'accountId', 'setPlatforms', 'setAccounts', 'setActivePlatform', `return (${handler});`)(platforms, selected, [{ id: 'fb-account', platform: 'facebook' }, { id: 'wa-account', platform: 'whatsapp' }], account => account.id, value => { platforms = value; }, value => { selected = value; }, () => {});
  toggle('whatsapp');
  assert.deepEqual(platforms, ['facebook']); assert.deepEqual(selected, ['fb-account']);
  assert.equal(choices(platforms).includes('whatsapp'), false);
});

test('opening a provider post refreshes its parent calendar once and ignores responses after closing', async () => {
  const management = await readFile(new URL('../src/PostManagement.tsx', import.meta.url), 'utf8'), effect = management.match(/useEffect\((.+), \[post.id\]\);/)[1];
  const pending = [], accepted = [], changed = [], busy = [];
  const context = { post: { id: 'post-a', scheduledAt: '2030-01-01T09:00:00Z' }, setCurrent: value => accepted.push(value), setBusy: value => busy.push(value), setError: () => {}, setNotice: () => {}, requester: { current: () => new Promise(resolve => pending.push(resolve)) }, changed: { current: async () => changed.push(true) } };
  const start = new Function(...Object.keys(context), `return (${effect});`)(...Object.values(context));
  const close = start(); pending[0]({ post: { id: 'post-a', scheduledAt: '2030-01-02T09:00:00Z' } }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(changed, [true]); assert.equal(accepted.at(-1).scheduledAt, '2030-01-02T09:00:00Z'); assert.equal(busy.at(-1), false); close();
  const closeAgain = start(); closeAgain(); pending[1]({ post: { id: 'post-a', scheduledAt: '2030-01-03T09:00:00Z' } }); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(changed, [true]); assert.equal(accepted.at(-1).scheduledAt, '2030-01-01T09:00:00Z');
});

test('a confirmed approval stays saved when refreshing its queue fails and closed views do not notify their parent', async () => {
  const approvals = await readFile(new URL('../src/ContentApprovals.tsx', import.meta.url), 'utf8');
  const acceptSource = approvals.match(/function acceptItem\(item: any\) \{[^\r\n]+\}/)[0].replace('item: any', 'item').replaceAll('previous: any', 'previous').replaceAll('entry: any', 'entry');
  const reviewSource = approvals.slice(approvals.indexOf('async function review('), approvals.indexOf('  const posts =')).replace('item: any, decision: string', 'item, decision');
  const pending = { post: { id: 'post-a' }, status: 'pending', review: { id: 'review-a' } }, approved = { ...pending, status: 'approved', review: { id: 'review-a', status: 'approved' } }, active = { current: true }, notices = [], changes = [], errors = [];
  let data = { posts: [pending] }, notes = { 'post-a': 'Approved for launch.' };
  const accept = new Function('active', 'setData', `return (${acceptSource});`)(active, update => { data = update(data); });
  const context = { action: async (_, run) => { try { await run(); } catch (error) { errors.push(error.message); } }, request: async () => ({ item: approved }), path: '/projects/project-a/approvals', notes, active, acceptItem: accept, setNotes: update => { notes = update(notes); }, setNotice: message => notices.push(message), onChanged: async () => changes.push(true), load: async () => { throw new Error('Queue refresh unavailable.'); } };
  const review = new Function(...Object.keys(context), `return (${reviewSource});`)(...Object.values(context));
  await review(pending, 'approved'); assert.equal(data.posts[0].status, 'approved'); assert.equal(notes['post-a'], ''); assert.match(notices[0], /Post approved/); assert.deepEqual(changes, [true]); assert.deepEqual(errors, ['Queue refresh unavailable.']);
  active.current = false; await review(pending, 'approved'); assert.deepEqual(changes, [true]); assert.equal(notices.length, 1);
});


test('YouTube keywords save and reopen as a shared field and reach unpublished updates', async () => {
  const values = draft({ platforms: ['youtube'], tagInput: '#launch, video\nproduct' });
  assert.deepEqual(normalizePostTags(values.tags), ['launch', 'video', 'product']);
  const { code } = await transformWithOxc(source.replace(/^import .*;\r?\n/gm, '').replace('export default function PostComposer', 'function PostComposer').replace('export function PostVariantPreview', 'function PostVariantPreview').replace('export const accountLabel', 'const accountLabel'), 'PostComposer.tsx', { jsx: { runtime: 'classic' } });
  const hooks = { useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useRef: initial => ({ current: initial }), useEffect() {}, useMemo: compute => compute(), useId: () => 'composer' };
  const context = { React, ...hooks, ...social, ...ui, MediaImage: ui.Image }, Composer = new Function(...Object.keys(context), code + ';return PostComposer;')(...Object.values(context));
  const post = { content: 'Video', platforms: ['youtube'], tags: ['launch', 'product'], mediaItems: [] };
  const html = renderToStaticMarkup(Composer({ post, assets: [], accounts: [], campaigns: [], canWrite: true, onSubmit: async () => {} }));
  assert.equal((html.match(/>YouTube keyword tags</g) || []).length, 1); assert.match(html, /launch\nproduct/); assert.match(html, /Shared by every selected YouTube channel/);
  const invalid = renderToStaticMarkup(Composer({ post: { ...post, tags: ['x'.repeat(101)] }, canWrite: true, onSubmit: async () => {} }));
  assert.match(invalid, /aria-invalid="true"/); assert.match(invalid, /at most 100 characters/);
  const management = await readFile(new URL('../src/PostManagement.tsx', import.meta.url), 'utf8'), calls = [];
  const action = management.slice(management.indexOf('async function update('), management.indexOf('\n  return <Card as="section"'));
  const updateContext = { ambiguousCopies: false, divergentCopies: false, accountCopiesReady: true, replaceVariants: false, post: { id: 'post' }, setBusy() {}, setError() {}, setNotice() {}, setCurrent() {}, onChanged() {}, requester: { current: async (...args) => { calls.push(args); return { post }; } } };
  await new Function(...Object.keys(updateContext), `return (${stripTypeScriptTypes(action)});`)(...Object.values(updateContext))(values);
  assert.deepEqual(calls[0][1].tags, values.tags);
});
