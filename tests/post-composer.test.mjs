import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PLATFORM_RULES, normalizePostVariants, publicMediaUrl, resolveVariant } from '../shared/social-posts.mjs';

const source = await readFile(new URL('../src/PostComposer.tsx', import.meta.url), 'utf8');
const expression = source.match(/const values = useMemo\(\(\) => \((.+)\), \[content,/)[1];
function draft(changes = {}) {
  const state = { content: 'Shared caption', platforms: ['facebook', 'instagram'], post: undefined, selectedAccounts: [], accountsTouched: false, accounts: [], baseMode: 'asset', assetId: 'shared-creative', campaignId: '', scheduledAt: '', baseMedia: [], overrides: { instagram: { content: '', mediaItems: [], options: { contentType: 'story' } } }, ...changes };
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

test('an empty custom-media editor and an empty asset selector retain their selected editing mode', () => {
  const mode = source.match(/const mediaMode = (.+);/)[1];
  const evaluate = (override, platformMediaModes = {}) => new Function('own', 'override', 'platformMediaModes', 'selected', `return (${mode});`)((item, key) => Object.hasOwn(item, key), override, platformMediaModes, 'instagram');
  assert.equal(evaluate({ mediaItems: [] }, { instagram: 'custom' }), 'custom');
  assert.equal(evaluate({ assetId: '' }, { instagram: 'asset' }), 'asset');
  assert.equal(evaluate({ mediaItems: [] }), 'none');
  assert.equal(evaluate({}), 'shared');
});

test('composer saves incomplete platform drafts but blocks malformed options and preserves entries on a failed save', async () => {
  const handler = source.slice(source.indexOf('async function submit('), source.indexOf('  async function checkWithProvider(')).replace('event: React.FormEvent<HTMLFormElement>', 'event').replace('(failure as Error)', 'failure');
  function submit(values, changes = {}) {
    const errors = [], calls = [], saving = [], focused = [];
    const context = { disabled: false, setError: error => errors.push(error), platforms: values.platforms, optionErrors: {}, normalizePostVariants, values, setSaving: value => saving.push(value), onSubmit: async value => calls.push(value), headingRef: { current: { focus: () => focused.push(true) } }, ...changes };
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
  const guard = source.slice(source.indexOf('function previewUrl('), source.indexOf('\nconst bytesLabel')).replace('value: string', 'value');
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
