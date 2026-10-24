import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AppField } from '@ten98/ui/app';
import * as designSystem from '@ten98/ui';
import { transformWithOxc } from 'vite';
import * as adsView from '../src/ads-view.ts';
import { adSpendBlock } from '../src/approval-status.ts';

const composer = await readFile(new URL('../src/AdComposer.tsx', import.meta.url), 'utf8'), details = await readFile(new URL('../src/AdDetails.tsx', import.meta.url), 'utf8'), analytics = await readFile(new URL('../src/SocialAnalytics.tsx', import.meta.url), 'utf8');
const javascript = value => stripTypeScriptTypes(value);
function interactionContext(values) {
  const frame = {}, context = { frame, currentFrame: { current: frame }, readOnly: false, loading: false, loadingAds: false, selectedInterests: [], ...values };
  context.canInteract = new Function(...Object.keys(context), `return (${javascript(composer.match(/\bcanInteract = (.+);/)[1])});`)(...Object.values(context));
  return context;
}
class FormValues { constructor(values) { return Object.entries(values); } }
const lines = value => (value || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
const form = { countries: 'ae, sa, AE', name: 'QA campaign', budgetAmount: '50', headline: 'Main headline', body: 'Ad description', linkUrl: 'https://brand.example.com/launch', additionalHeadlines: 'Second headline\nThird headline', additionalDescriptions: 'Second description', keywords: 'launch campaign', businessName: 'QA brand', landscape: 'https://cdn.example.com/landscape.jpg', square: 'https://cdn.example.com/square.jpg', logo: 'https://cdn.example.com/logo.jpg', headlines: 'First headline\nSecond headline\nThird headline', descriptions: 'First description\nSecond description', longHeadline: 'A longer launch headline', longHeadlines: 'A longer video headline', youtubeVideoIds: 'abcdefghijk', videoUrl: 'https://cdn.example.com/video.mp4', thumbnailUrl: 'https://cdn.example.com/thumb.jpg', imageUrl: 'https://cdn.example.com/image.jpg', callToAction: 'LEARN_MORE', organizationId: '123456', boardId: 'board-a', bidAmount: '2', pixelId: 'reddit-pixel', customEventType: 'PURCHASE', postId: 'published-reddit-post', cardHeadline0: 'First card', cardHeadline1: 'Second card', cardImage0: 'https://cdn.example.com/card-one.jpg', cardImage1: 'https://cdn.example.com/card-two.jpg' };
test('Reddit pixel lookup cannot replace a newer advertising account or closed composer', async () => {
  const source = javascript(composer.match(/async function loadPixels\([\s\S]*?\n  \}/)[0]);
  let finish; const mounted = { current: true }; const accepted = [], calls = [], pixelRead = { current: 0 };
  const context = { accountId: 'reddit /a', adAccountId: 'native /a', platform: 'reddit', pixelBusy: false, pixelRead, pixelScope: 'account-a', currentPixelScope: { current: 'account-a' }, mounted, setPixelBusy() {}, setPixelError() {}, setPixels: value => accepted.push(value), setPixelsLoaded() {}, requester: { current: path => { calls.push(path); return new Promise(resolve => { finish = resolve; }); } } };
  const load = new Function(...Object.keys(context), `return (${source});`)(...Object.values(context));
  const first = load(); pixelRead.current++; finish({ tags: [{ id: 'old-account' }] }); await first; assert.deepEqual(accepted, []);
  const second = load(); mounted.current = false; finish({ tags: [{ id: 'closed-view' }] }); await second; assert.deepEqual(accepted, []);
  mounted.current = true; const third = load(); finish({ tags: [{ id: 'scoped-pixel' }] }); await third; assert.deepEqual(accepted, [[{ id: 'scoped-pixel' }]]);
  assert.equal(calls[0], 'measurement/reddit%20%2Fa/tags?adAccountId=native%20%2Fa');
});
const submitSource = javascript(composer.match(/async function submit\([\s\S]*?\n  \}/)[0]);
async function createAd(changes = {}, values = {}, expectedError = '') {
  const calls = [], errors = [], saved = [];
  const context = interactionContext({ busy: false, budgetType: 'daily', bidding: 'automatic', setValidation() {}, isCurrent: () => true, FormData: FormValues, setError: error => errors.push(error), connection: { platform: 'googleads' }, adAccount: { id: 'native-account' }, currency: 'AED', accountId: 'connection-a', adAccountId: 'native-account', platform: 'google', boosting: false, assets: false, format: 'search', goal: 'traffic', video: false, carousel: false, cards: 2, lines, setBusy: () => {}, requester: { current: async (path, payload) => calls.push({ path, payload }) }, onCreated: () => saved.push(true), ...changes });
  const submit = new Function(...Object.keys(context), `return (${submitSource});`)(...Object.values(context));
  await submit({ preventDefault() {}, currentTarget: { ...form, ...values } });
  if (expectedError) { assert.equal(errors.at(-1), expectedError); assert.deepEqual(saved, []); assert.deepEqual(calls, []); return; }
  assert.equal(errors.at(-1), '', errors.at(-1)); assert.deepEqual(saved, [true]);
  return calls[0];
}

test('actual ad composer submits all supported creative families paused with their correct provider fields', async () => {
  const search = await createAd(); assert.equal(search.payload.status, 'PAUSED'); assert.equal(search.payload.campaignType, 'search'); assert.deepEqual(search.payload.countries, ['AE', 'SA']); assert.equal(search.payload.additionalHeadlines.length, 2);
  const display = await createAd({ format: 'display' }); assert.deepEqual(display.payload.images, { landscape: form.landscape, square: form.square });
  const pmax = await createAd({ format: 'pmax', assets: true }); assert.equal(pmax.payload.assetGroup.youtubeVideoId, 'abcdefghijk'); assert.equal(pmax.payload.goal, undefined);
  const demandVideo = await createAd({ format: 'demand_video', assets: true, video: true }); assert.deepEqual(demandVideo.payload.demandGen.youtubeVideoIds, ['abcdefghijk']); assert.equal(demandVideo.payload.demandGen.images.landscape, undefined);
  const demandCarousel = await createAd({ format: 'demand_carousel', assets: true, carousel: true }, { headlines: 'Carousel title', descriptions: 'Carousel description' }); assert.equal(demandCarousel.payload.demandGen.carouselCards.length, 2); assert.equal(demandCarousel.payload.demandGen.headlines.length, 1);
  const meta = await createAd({ platform: 'facebook', format: 'video', video: true }); assert.deepEqual(meta.payload.video, { url: form.videoUrl, thumbnailUrl: form.thumbnailUrl }); assert.equal(meta.payload.imageUrl, undefined);
  const carousel = await createAd({ platform: 'facebook', format: 'carousel', carousel: true }); assert.equal(carousel.payload.carouselCards.length, 2); assert.equal(carousel.payload.imageUrl, undefined);
  const tiktok = await createAd({ platform: 'tiktok', format: 'video', video: true }); assert.equal(tiktok.payload.imageUrl, form.videoUrl); assert.equal(tiktok.payload.video, undefined); assert.equal(tiktok.payload.headline, undefined);
  const linkedin = await createAd({ platform: 'linkedin', format: 'video', video: true }); assert.equal(linkedin.payload.organizationId, '123456'); assert.equal(linkedin.payload.video.url, form.videoUrl);
  const reddit = await createAd({ platform: 'reddit', format: 'text' }, { linkUrl: '', callToAction: '' }); assert.equal(reddit.payload.creativeFormat, 'text'); assert.equal(reddit.payload.imageUrl, undefined); assert.equal(reddit.payload.linkUrl, undefined); assert.equal(reddit.payload.callToAction, undefined);
  const pinterest = await createAd({ platform: 'pinterest', format: 'image' }); assert.equal(pinterest.payload.imageUrl, form.imageUrl); assert.equal(pinterest.payload.boardId, 'board-a');
  const twitter = await createAd({ platform: 'twitter', format: 'image' }); assert.equal(twitter.payload.imageUrl, form.imageUrl); assert.equal(twitter.payload.callToAction, undefined);
  const openai = await createAd({ platform: 'openai', format: 'image', goal: 'awareness' }); assert.equal(openai.payload.bidStrategy, 'LOWEST_COST_WITH_BID_CAP'); assert.equal(openai.payload.bidAmount, 2);
});

test('Google calendar dates are preserved and partial posts can boost only their selected published account copy', async () => {
  const google = await createAd({}, { startDate: '2030-01-01', endDate: '2030-01-01' }); assert.equal(google.payload.startDate, '2030-01-01T00:00:00Z'); assert.equal(google.payload.endDate, google.payload.startDate);
  const meta = await createAd({ platform: 'facebook', format: 'image' }, { startDate: '2030-01-01T08:00' }); assert.equal(meta.payload.startDate, new Date('2030-01-01T08:00').toISOString());
  const expression = composer.match(/const publishedPosts = (.+);/)[1].replace('copy: any', 'copy');
  const eligible = new Function('posts', 'accountId', 'platform', `return (${expression});`);
  const posts = [{ id: 'partial', status: 'partial', externalId: 'remote-a', providerResults: [{ accountId: { _id: 'fb-a' }, platform: 'facebook', status: 'published' }, { accountId: 'ig-a', platform: 'instagram', status: 'failed' }] }, { id: 'legacy', status: 'published', externalId: 'remote-b' }, { id: 'draft', status: 'published', externalId: 'remote-c', providerResults: [{ accountId: 'tt-a', platform: 'tiktok', status: 'published', platformSpecificData: { isDraft: true } }] }];
  assert.deepEqual(eligible(posts, 'fb-a').map(post => post.id), ['partial', 'legacy']); assert.deepEqual(eligible(posts, 'ig-a').map(post => post.id), ['legacy']); assert.deepEqual(eligible(posts, 'tt-a').map(post => post.id), ['legacy']);
  assert.deepEqual(eligible([...posts, { id: 'reddit', status: 'published', externalId: 'remote-reddit', providerResults: [{ accountId: 'organic-reddit', platform: 'reddit', status: 'published' }] }], 'reddit-ads', 'reddit').map(post => post.id), ['legacy', 'reddit']);
});

test('Reddit create and boost submissions carry a pixel for every goal and website leads never send retired form IDs', async () => {
  for (const boosting of [false, true]) for (const goal of ['traffic', 'awareness', 'video_views', 'conversions', 'lead_generation']) {
    const result = await createAd({ platform: 'reddit', format: 'video', video: true, boosting, goal, budgetType: 'lifetime' }, { endDate: '2070-01-04T12:00', leadGenFormId: '' });
    assert.equal(result.path, boosting ? 'ads/boost' : 'ads/create'); assert.equal(result.payload.status, 'PAUSED'); assert.equal(result.payload.budgetType, 'lifetime'); assert.equal(result.payload.promotedObject.pixelId, 'reddit-pixel'); assert.equal(result.payload.leadGenFormId, undefined);
    if (goal === 'lead_generation') assert.equal(result.payload.promotedObject.customEventType, 'LEAD');
    if (goal === 'conversions') assert.equal(result.payload.promotedObject.customEventType, 'PURCHASE');
    if (boosting) { assert.equal(result.payload.postId, 'published-reddit-post'); assert.equal(result.payload.linkUrl, form.linkUrl); assert.equal(result.payload.video, undefined); }
    await createAd({ platform: 'reddit', format: 'video', video: true, boosting, goal }, { pixelId: ' ' }, 'Every Reddit ad group needs a pixel from this advertising account.');
  }
  const goals = new Function('platform', 'video', 'boosting', 'format', `return (${composer.match(/const goals = (.+);/)[1]});`);
  assert.deepEqual(goals('reddit', true, false, 'video'), ['traffic', 'awareness', 'video_views', 'conversions', 'lead_generation']);
  assert.deepEqual(goals('reddit', false, true, 'image'), ['traffic', 'awareness', 'video_views', 'conversions', 'lead_generation']);
  assert.deepEqual(goals('reddit', false, false, 'text'), ['traffic', 'awareness', 'conversions']);
});

test('an ad creation finishing after its dialog closes or changes cannot close a newer draft dialog', async () => {
  const compile = (code, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context));
  const lifecycle = composer.match(/useEffect\((\(\) => \{ mounted.current = true; return \(\) => \{ mounted.current = false; \}; \}), \[\]\);/)[1];
  const current = composer.match(/\bisCurrent = (.+);/)[1];
  for (const stale of ['unmounted', 'changed-identity', 'project-abort']) {
    const mounted = { current: false }, view = { identity: 'original-ad' }, currentIdentity = { current: view }, busy = [], errors = [];
    const unmount = compile(lifecycle, { mounted })(), isCurrent = compile(current, { mounted, view, currentIdentity });
    let finish, fail, modal = 'ad';
    const context = interactionContext({ busy: false, budgetType: 'daily', bidding: 'automatic', setValidation() {}, isCurrent, FormData: FormValues, setError: error => errors.push(error), connection: { platform: 'googleads' }, adAccount: { id: 'native-account' }, currency: 'AED', accountId: 'connection-a', adAccountId: 'native-account', platform: 'google', boosting: false, assets: false, format: 'search', goal: 'traffic', video: false, carousel: false, cards: 2, lines, setBusy: value => busy.push(value), requester: { current: () => new Promise((resolve, reject) => { finish = resolve; fail = reject; }) }, onCreated: () => { modal = null; } });
    const pending = compile(submitSource, context)({ preventDefault() {}, currentTarget: form });
    if (stale === 'unmounted') unmount();
    if (stale === 'changed-identity') currentIdentity.current = { identity: 'different-ad' };
    modal = 'unsaved-asset-draft';
    if (stale === 'project-abort') fail(new DOMException('Project changed.', 'AbortError')); else finish({});
    await pending;
    assert.equal(modal, 'unsaved-asset-draft'); assert.deepEqual(errors, ['']);
    assert.deepEqual(busy, stale === 'project-abort' ? [true, false] : [true]);
  }
});

test('Display editing forwards replacement creative fields and unchanged or stale forms do not submit another write', async () => {
  const handler = javascript(details.slice(details.indexOf('async function edit('), details.indexOf('  async function editSet('))), calls = [], errors = [];
  const base = { FormData: FormValues, busy: false, needsRefresh: false, live: { _id: 'display-ad', name: 'Existing ad' }, platform: 'google', channel: 'display', creative: {}, lines, copy: value => (value || []).join('\n'), setError: error => errors.push(error), act: async action => action(), scopedRequest: async (path, payload) => calls.push({ path, payload }), confirmForm() {}, readAd: async () => {} };
  async function edit(values, extra = {}) { const context = { ...base, ...extra }; await new Function(...Object.keys(context), `return (${handler});`)(...Object.values(context))({ preventDefault() {}, currentTarget: values }); }
  await edit({ longHeadline: 'New long headline', businessName: 'New brand', imageUrl: 'https://cdn.example.com/new.jpg', squareImageUrl: 'https://cdn.example.com/new-square.jpg' });
  assert.deepEqual(calls[0], { path: 'ads/edit', payload: { adId: 'display-ad', creative: { longHeadline: 'New long headline', businessName: 'New brand', imageUrl: 'https://cdn.example.com/new.jpg', squareImageUrl: 'https://cdn.example.com/new-square.jpg' } } });
  await edit({}); assert.equal(calls.length, 1); assert.equal(errors.at(-1), 'Choose at least one field to change.');
  await edit({ longHeadline: 'Another change' }, { needsRefresh: true }); assert.equal(calls.length, 1);
  await edit({ name: 'Unsupported rename' }, { platform: 'tiktok', channel: '' }); assert.equal(calls.length, 1);
});

test('RSA editing submits the reviewed full URL list and blocks missing, expired or unreadable creative reviews', async () => {
  const renderCopy = new Function(`return ${stripTypeScriptTypes('(' + details.match(/const copy = (.+);/)[1] + ')')};`)();
  assert.equal(renderCopy({ unexpected: 'stored data' }), ''); assert.equal(renderCopy([null, { text: {} }, 'https://brand.example/two']), '\n\nhttps://brand.example/two');
  const rsaValues = new Function(`return ${stripTypeScriptTypes('(' + details.match(/const rsaValues = (.+);/)[1] + ')')};`)();
  const handler = javascript(details.slice(details.indexOf('async function edit('), details.indexOf('  async function editSet('))), calls = [], errors = [];
  const creative = { headlines: [{ text: 'Pinned first', pinnedField: 'HEADLINE_1' }, { text: 'Second' }, { text: 'Third' }], descriptions: [{ text: 'First description' }, { text: 'Second description' }], finalUrls: ['https://brand.example/one', 'https://brand.example/two'] };
  const base = { FormData: FormValues, busy: false, needsRefresh: false, live: { _id: 'search-ad' }, selected: { creativeReview: { version: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString() } }, platform: 'google', channel: 'search', creative, rsaValues, lines, copy: value => (value || []).map(row => typeof row === 'string' ? row : row.text).join('\n'), setError: error => errors.push(error), act: async action => action(), scopedRequest: async (path, payload) => calls.push({ path, payload }), confirmForm() {}, readAd: async () => {} };
  async function edit(values, extra = {}) { const context = { ...base, ...extra }; await new Function(...Object.keys(context), `return (${handler});`)(...Object.values(context))({ preventDefault() {}, currentTarget: values }); }
  await edit({ finalUrls: 'https://brand.example/new\nhttps://brand.example/two' });
  assert.deepEqual(calls[0], { path: 'ads/edit', payload: { adId: 'search-ad', finalUrls: ['https://brand.example/new', 'https://brand.example/two'], expectedCreativeVersion: 'a'.repeat(64) } });
  for (const selected of [null, { creativeReview: null }, { creativeReview: { version: 'a'.repeat(64), expiresAt: new Date(Date.now() - 1000).toISOString() } }, { creativeReview: { version: 'a'.repeat(64), expiresAt: 'unreadable' } }]) {
    await edit({ rsa_headlines_0: 'Pinned first', rsa_headlines_pin_0: 'HEADLINE_1', rsa_headlines_1: 'Changed second', rsa_headlines_2: 'Third' }, { selected });
    assert.match(errors.at(-1), /Refresh ad details/); assert.equal(calls.length, 1);
  }
  await edit({ countries: 'AE' }, { selected: null });
  assert.deepEqual(calls.at(-1).payload, { adId: 'search-ad', targeting: { countries: ['AE'] } }, 'Unrelated audience settings do not require RSA creative enrichment.');
  const edits = { rsa_headlines_0: 'Changed pinned text', rsa_headlines_pin_0: 'HEADLINE_3', rsa_headlines_1: 'Second', rsa_headlines_2: 'Third', rsa_descriptions_0: 'First description', rsa_descriptions_pin_0: 'DESCRIPTION_2', rsa_descriptions_1: 'Second description' };
  await edit(edits);
  assert.deepEqual(calls.at(-1).payload, { adId: 'search-ad', headlines: [{ text: 'Changed pinned text', pinnedField: 'HEADLINE_3' }, { text: 'Second' }, { text: 'Third' }], descriptions: [{ text: 'First description', pinnedField: 'DESCRIPTION_2' }, { text: 'Second description' }], expectedCreativeVersion: 'a'.repeat(64) });
  await edit({ ...edits, rsa_headlines_pin_0: '' }); assert.equal(calls.at(-1).payload.headlines[0].pinnedField, undefined, 'Choosing Unpinned explicitly removes its fixed position.');
  const beforeInvalid = calls.length;
  for (const invalid of [{ ...edits, rsa_headlines_0: '' }, { ...edits, rsa_headlines_0: 'Second' }, { ...edits, rsa_headlines_0: 'x'.repeat(31) }]) { await edit(invalid); assert.match(errors.at(-1), /Keep 3–15 distinct headlines/); assert.equal(calls.length, beforeInvalid); }
  await edit({ ...edits, rsa_headlines_0: '', rsa_headlines_3: 'Replacement after removal' }); assert.deepEqual(calls.at(-1).payload.headlines, [{ text: 'Second' }, { text: 'Third' }, { text: 'Replacement after removal' }]);
});

test('a failed readback after a confirmed ad write requires refresh without claiming the write failed', async () => {
  const helper = stripTypeScriptTypes(details.slice(details.indexOf('async function readAd('), details.indexOf('  async function edit(')));
  const refreshStates = [], selections = [], errors = [], revisions = [];
  const context = { isCurrent: () => true, setNeedsRefresh: value => refreshStates.push(value), setSelected: value => selections.push(value), setReadVersion: update => revisions.push(update(2)), setDraftDirty() {}, setError: error => errors.push(error), requester: { current: async () => { throw new Error('Read timed out.'); } }, scopedRequest: (...args) => context.requester.current(...args) };
  const read = new Function(...Object.keys(context), `return (${helper});`)(...Object.values(context));
  await read('ad-a', true); assert.deepEqual(refreshStates, [true]); assert.equal(selections.length, 0); assert.match(errors[0], /provider confirmed the change/);
  context.requester.current = async () => ({ ad: { _id: 'ad-a' }, statusReadAt: null });
  await read('ad-a'); assert.equal(refreshStates.at(-1), false); assert.deepEqual(revisions, [3]); assert.equal(selections.length, 1);
});

test('closed or changed ad scopes never notify the parent or swallow an aborted post-write read', async () => {
  const compile = (code, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context));
  const requestSource = details.slice(details.indexOf('async function scopedRequest('), details.indexOf('  const live ='));
  const actionSource = details.slice(details.indexOf('async function act('), details.indexOf('  async function readAd('));
  const readSource = details.slice(details.indexOf('async function readAd('), details.indexOf('  async function edit('));
  for (const stale of ['unmounted', 'changed-identity', 'project-abort']) {
    let mounted = true, identity = 'campaign-a', reject;
    const notices = [], changes = [], selections = [], errors = [], requests = [];
    const isCurrent = () => mounted && identity === 'campaign-a';
    const scopedRequest = compile(requestSource, { isCurrent, requester: { current: path => { requests.push(path); return new Promise((_, fail) => { reject = fail; }); } } });
    const readAd = compile(readSource, { scopedRequest, isCurrent, setNeedsRefresh() {}, setSelected: value => selections.push(value), setReadVersion() {}, setError: value => errors.push(value) });
    const act = compile(actionSource, { isCurrent, setBusy() {}, setSpendBlock() {}, adSpendBlock, setError: value => errors.push(value), setNotice: value => notices.push(value), onChanged: () => changes.push(true) });
    const work = act(() => readAd('ad-a', true), 'Changes saved');
    if (stale === 'unmounted') mounted = false;
    if (stale === 'changed-identity') identity = 'campaign-b';
    reject(new DOMException('Project changed.', 'AbortError')); await work;
    assert.deepEqual(changes, []); assert.deepEqual(selections, []); assert.deepEqual(notices, ['']); assert.deepEqual(errors, ['']);
    if (stale !== 'project-abort') { await assert.rejects(scopedRequest('ads/ad-status', {}), { name: 'AbortError' }); assert.equal(requests.length, 1, 'A stale continuation must not send another provider request.'); }
  }
});

test('ad refresh and selection wait for explicit discard, while uncertain saves retain the draft and other forms keep their own dirty state', async () => {
  const compile = (code, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context));
  const source = (start, end) => details.slice(details.indexOf(start), details.indexOf(end));
  class Input { constructor(value, defaultValue) { this.value = value; this.defaultValue = defaultValue; } }
  class Textarea extends Input {}
  const input = new Textarea('Unsaved headline', 'Original headline'), events = [], errors = [];
  let dirty = true, pending = null, calls = 0, resets = 0;
  const form = { elements: [input], reset() { resets++; input.value = input.defaultValue; }, dispatchEvent(event) { events.push(event); } };
  const context = {
    isCurrent: () => true, draftDirty: true, editorForm: { current: form }, actionTrigger: { current: null }, pendingContinuation: { current: null },
    document: { activeElement: { id: 'refresh-button' } }, HTMLInputElement: Input, HTMLTextAreaElement: Textarea,
    setDraftDirty: value => { dirty = value; }, setPendingAction: value => { pending = value; },
    setBusy() {}, setSpendBlock() {}, adSpendBlock, setError: value => errors.push(value), setNotice() {},
  };
  context.confirmForm = compile(source('function confirmForm(', '  function discardDraft('), context);
  context.hasDraft = compile(source('function hasDraft(', '  function trackDraft('), context);
  context.act = compile(source('async function act(', '  async function readAd('), context);
  const track = compile(source('function trackDraft(', '  const budgetPanel'), context);
  track({ currentTarget: form }); assert.equal(dirty, true);
  input.value = input.defaultValue; track({ currentTarget: form }); assert.equal(dirty, false, 'Reverting an edit needs no discard confirmation.');
  assert.equal(events.at(-1).detail.outcome, 'restored'); events.length = 0;
  input.value = 'Unsaved headline'; track({ currentTarget: form });
  await context.act(async () => { calls++; }, '', true);
  assert.equal(calls, 0); assert.equal(pending.message, ''); assert.equal(input.value, 'Unsaved headline');
  assert.equal(context.actionTrigger.current.id, 'refresh-button');
  const discard = compile(source('function discardDraft(', '  function hasDraft('), { ...context, pendingAction: pending });
  discard(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(resets, 1); assert.equal(dirty, false); assert.equal(pending, null);
  assert.equal(events[0].type, 'campaign:editor-saved'); assert.equal(events[0].bubbles, true);
  assert.equal(events[0].detail.form, form); assert.equal(events[0].detail.outcome, 'discarded');

  dirty = true;
  const otherForm = { dispatchEvent: event => events.push(event) };
  context.confirmForm(otherForm); assert.equal(dirty, true, 'A campaign/ad-set save must not clear an unsaved creative.');
  assert.equal(events.at(-1).detail.form, otherForm);
  const editContext = {
    ...context, FormData: FormValues, busy: false, needsRefresh: false, live: { _id: 'display-ad' }, platform: 'google', channel: 'display',
    creative: {}, lines, copy: () => '', readAd: async () => {},
    scopedRequest: async () => { throw new Error('Provider outcome unknown.'); },
  };
  await compile(source('async function edit(', '  async function editSet('), editContext)({ preventDefault() {}, currentTarget: { longHeadline: 'New headline' } });
  assert.equal(dirty, true); assert.equal(errors.at(-1), 'Provider outcome unknown.');
  const savedForm = { longHeadline: 'New headline', dispatchEvent: event => events.push(event) };
  context.editorForm.current = savedForm;
  await compile(source('async function edit(', '  async function editSet('), { ...editContext, scopedRequest: async () => ({ success: true }) })({ preventDefault() {}, currentTarget: savedForm });
  assert.equal(dirty, false); assert.equal(events.at(-1).detail.form, savedForm); assert.equal(events.at(-1).detail.outcome, 'saved');
});

test('saving a campaign or ad set reviews sibling drafts before its full refresh and submits only the chosen form', async () => {
  const compile = (code, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context));
  const source = (start, end) => details.slice(details.indexOf(start), details.indexOf(end));
  const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  class Input { constructor(value, defaultValue) { this.type = 'text'; this.value = value; this.defaultValue = defaultValue; } }
  for (const saving of ['ad-set', 'campaign']) {
    const dirtyScopes = { current: new Map() }, events = [], requests = [];
    let pending = null, retry = 0, parentDirty = true;
    const editorSaved = compile(main.slice(main.indexOf('function editorSaved('), main.indexOf('  function inboxDraftChanged(')), { dirtyScopes, setDraftDirty: value => { parentDirty = value; } });
    function makeForm(value, original) {
      const input = new Input(value, original);
      return { get name() { return input.value; }, amount: '', elements: [input], reset() { input.value = input.defaultValue; }, dispatchEvent(event) { events.push(event); editorSaved(event.detail.form); } };
    }
    const submitted = makeForm('Chosen save', 'Original name'), sibling = makeForm('Unsaved sibling set', 'Original sibling set');
    dirtyScopes.current.set(submitted, 1); dirtyScopes.current.set(sibling, 1);
    const context = {
      isCurrent: () => true, draftDirty: false, editorForm: { current: null }, detailsSection: { current: { querySelectorAll: () => [submitted, sibling] } },
      actionTrigger: { current: null }, pendingContinuation: { current: null }, document: { activeElement: { focus() {} } }, HTMLInputElement: Input,
      HTMLTextAreaElement: class {}, HTMLSelectElement: class {}, setPendingAction: value => { pending = value; },
      setDraftDirty() {}, setBusy() {}, setSpendBlock() {}, adSpendBlock, setError() {}, setNotice() {}, campaignId: 'campaign-a', platform: 'facebook', data: { campaign: { name: 'Original name' } },
      FormData: FormValues, scopedRequest: async (path, payload) => { requests.push({ path, payload }); }, setRetry: update => { retry = update(retry); },
    };
    context.hasDraft = compile(source('function hasDraft(', '  function trackDraft('), context);
    context.confirmForm = compile(source('function confirmForm(', '  function discardDraft('), context);
    context.act = compile(source('async function act(', '  async function readAd('), context);
    const handler = compile(saving === 'ad-set' ? source('async function editSet(', '  async function loadBudgetReview(') : source('async function editCampaign(', '  function confirmForm('), context);
    await handler({ preventDefault() {}, currentTarget: submitted }, { platformAdSetId: 'set-a', adSetName: 'Original name' });
    assert.deepEqual(requests, []); assert.equal(retry, 0, 'The refresh cannot unmount sibling forms while review is pending.');
    assert.deepEqual(pending.forms, [sibling]); assert.equal(submitted.name, 'Chosen save'); assert.equal(sibling.name, 'Unsaved sibling set');
    assert.equal(parentDirty, true); assert.equal(dirtyScopes.current.size, 2);
    compile(source('function discardDraft(', '  function hasDraft('), { ...context, pendingAction: pending })();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sibling.name, 'Original sibling set'); assert.equal(submitted.name, 'Chosen save', 'Discarding siblings must keep the submitted form values.');
    assert.equal(requests.length, 1); assert.equal(requests[0].path, saving === 'ad-set' ? 'ads/adset' : 'ads/campaign');
    assert.equal(requests[0].payload.name, 'Chosen save'); assert.equal(requests[0].payload.adSetId, saving === 'ad-set' ? 'set-a' : undefined);
    assert.equal(retry, 1); assert.equal(dirtyScopes.current.size, 0); assert.equal(parentDirty, false);
    assert.deepEqual(events.map(event => [event.detail.form, event.detail.outcome]), [[sibling, 'discarded'], [submitted, 'saved']]);
  }
});

test('analytics date validation and failed refresh preserve the last successful report', async () => {
  const handler = javascript(analytics.slice(analytics.indexOf('async function load('), analytics.indexOf('  return <Card'))), errors = [], reports = [], requests = [];
  const base = { busy: false, connected: true, from: '2030-01-01', to: '2030-01-31', setError: error => errors.push(error), setBusy: () => {}, request: async path => { requests.push(path); return { totals: { impressions: 0 }, daily: [] }; }, setReport: value => reports.push(value) };
  async function load(extra = {}) { const context = { ...base, ...extra }; await new Function(...Object.keys(context), `return (${handler});`)(...Object.values(context))({ preventDefault() {} }); }
  await load(); assert.equal(reports.length, 1); assert.equal(reports[0].data.totals.impressions, 0); assert.match(requests[0], /fromDate=2030-01-01&toDate=2030-01-31/);
  await load({ from: '2030-02-01', to: '2030-01-01' }); assert.equal(requests.length, 1);
  await load({ request: async () => { throw new Error('Provider unavailable.'); } }); assert.equal(reports.length, 1); assert.equal(errors.at(-1), 'Provider unavailable.');
  await load({ from: '2030-01-01', to: '2031-01-02' }); assert.equal(requests.length, 1, '367 inclusive reporting days must fail before a provider request.');
  await load({ from: '2030-01-01', to: '2031-01-01' }); assert.equal(requests.length, 2, '366 inclusive reporting days are allowed.');
});

const { code: detailsCode } = await transformWithOxc(details.replace(/^import .+;\r?\n/gm, '').replace('export default function ', 'function '), 'AdSetStatusInteraction.tsx', { jsx: { runtime: 'classic' } });
// DataTable cells and row actions are supplied as functions; walk them like children.
const detailNodes = node => !React.isValidElement(node) ? [] : [node, ...[...React.Children.toArray(node.props.children), ...(node.type === designSystem.DataTable ? node.props.rows.flatMap(row => [node.props.rowActions?.(row), ...node.props.columns.map(column => column.render?.(row))]) : [])].flatMap(detailNodes)];
// ReviewConfirm renders its own confirm and cancel buttons; expose them by label with the app's handlers and lock.
const reviewButtons = node => [[node.props.confirmLabel, node.props.disabledReason != null || !!node.props.busy, node.props.onConfirm], [node.props.cancelLabel ?? 'Cancel', !!node.props.busy, node.props.onCancel]];
const detailsImports = details.match(/import \{ ([^}]+) \} from '@ten98\/ui';/)[1].replaceAll(' as ', ': ');
const detailText = node => !React.isValidElement(node) ? String(node ?? '') : React.Children.toArray(node.props.children).map(detailText).join('');
const deferredStatus = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const statusItems = (platform = 'facebook', extra = {}) => ({ campaign: { platformCampaignId: 'campaign/a', platform, campaignName: 'Campaign A', status: 'paused', currency: 'AED', adSets: [{ platformAdSetId: 'set/a', adSetName: 'Set A', status: 'paused' }, { platformAdSetId: 'set/b', adSetName: 'Set B', status: 'active' }], ...extra }, ads: [] });
const statusReceipt = (body, extra = {}) => ({ operation: { id: 'status-operation', status: 'complete' }, statusAcceptance: { campaignId: body.campaignId, platform: body.platform, adSetId: body.adSetId, requestedStatus: body.status, deliveryStatus: 'paused', platformAdSetStatus: 'CAMPAIGN_PAUSED', platformCampaignStatus: 'PAUSED', statusReadAt: '2026-10-19T10:00:00.000Z', updated: 1, skipped: 0, skippedReasons: [], ...extra } });

async function adSetUi(respond = async (path, body) => body ? statusReceipt(body) : statusItems(), initial = {}) {
  const hooks = [], queued = [], calls = [], forms = [], events = [], keys = new Map(); let cursor = 0, dirty = true, tree, unmounted = false, props = initial, changed = 0;
  class Input { constructor() { this.type = 'text'; this.value = this.defaultValue = 'Original'; } }
  const state = initial => { const index = cursor++; if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, value => { assert.equal(unmounted, false, 'No state updates after unmount.'); const next = typeof value === 'function' ? value(hooks[index].value) : value; if (!Object.is(next, hooks[index].value)) { hooks[index].value = next; dirty = true; } }]; };
  const ref = initial => { const index = cursor++; return hooks[index] ||= { current: initial }; };
  const effect = (run, dependencies) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) { hooks[index] = { dependencies, close: old?.close }; queued.push(() => { hooks[index].close?.(); hooks[index].close = run(); }); } };
  const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'), integrateCode = javascript(main.match(/async function integrate\([\s\S]*?\n  \}/)[0]);
  const request = new Function('state', 'activeProject', 'pendingKeys', 'crypto', 'api', 'endpoint', `return (${integrateCode});`)({ projectId: 'project-a' }, { current: 'project-a' }, { current: keys }, { randomUUID: () => 'key-' + calls.length }, async (path, method, body, key) => { const route = path.replace('integrations/', ''); calls.push({ path: route, body, key, method }); return respond(route, body); }, path => path);
  const Component = new Function('React', 'AppField', 'useState', 'useRef', 'useEffect', 'window', 'document', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'FormData', 'detailsView', `const { ${detailsImports}, adCreativeView, adMetricCells, readHideAmounts, adSpendBlock, AdSpendNotice } = detailsView;` + detailsCode + ';return AdDetails;')(React, AppField, state, ref, effect, { confirm() { assert.fail('Ad-set tests must use the explicit in-page confirmation buttons.'); } }, { activeElement: { focus() {} } }, Input, class {}, class {}, class { constructor(form) { return Object.entries(form.values || {}); } }, { ...designSystem, ...adsView, adSpendBlock, AdSpendNotice: () => null });
  function paint() { if (unmounted) return; for (let pass = 0; dirty; pass++) { assert.ok(pass < 25, 'Rendering settles.'); dirty = false; cursor = 0; tree = Component({ campaign: { platformCampaignId: 'campaign/a', platform: 'facebook' }, canWrite: true, request, onChanged() { changed++; }, ...props }); const formNodes = detailNodes(tree).filter(node => node.type === designSystem.Form); for (let i = 0; i < formNodes.length; i++) { forms[i] ||= { values: {}, elements: [new Input()], reset() { this.elements.forEach(input => { input.value = input.defaultValue; }); }, dispatchEvent(event) { events.push(event); } }; if (formNodes[i].props.ref) formNodes[i].props.ref.current = forms[i]; } const section = detailNodes(tree).find(node => node.props?.as === 'section'); section.props.ref.current = { querySelectorAll: () => forms.slice(0, formNodes.length) }; while (queued.length) queued.shift()(); } }
  const tick = async () => { for (let turn = 0; turn < 2; turn++) { await new Promise(resolve => setImmediate(resolve)); paint(); } };
  const button = (label, index = 0) => detailNodes(tree).flatMap(node => node.type === designSystem.Button && detailText(node) === label ? [node] : node.type === designSystem.ReviewConfirm ? reviewButtons(node).filter(([text]) => text === label).map(([, disabled, onClick]) => ({ props: { disabled, onClick } })) : [])[index];
  const click = (label, index = 0) => { const node = button(label, index); assert.ok(node, label); assert.equal(!!node.props.disabled, false, label); const pending = node.props.onClick(); paint(); return pending; };
  const submit = async (label, values, index = 0) => { const node = button(label, index); assert.ok(node, label); assert.equal(!!node.props.disabled, false); const formNodes = detailNodes(tree).filter(node => node.type === designSystem.Form), formIndex = formNodes.map((form, position) => detailNodes(form).some(child => child.type === designSystem.Button && detailText(child) === label) ? position : -1).filter(position => position >= 0)[index]; assert.ok(formIndex >= 0); const form = forms[formIndex]; form.values = values; const pending = formNodes[formIndex].props.onSubmit(undefined, { preventDefault() {}, currentTarget: form }); paint(); await pending; await tick(); };
  const edit = (label, values, index = 0) => { const node = button(label, index), formNodes = detailNodes(tree).filter(node => node.type === designSystem.Form), formIndex = formNodes.map((form, position) => detailNodes(form).some(child => child.type === designSystem.Button && detailText(child) === label) ? position : -1).filter(position => position >= 0)[index]; forms[formIndex].values = values; formNodes[formIndex].props.onChange?.({ currentTarget: forms[formIndex] }); paint(); };
  paint(); await tick();
  return { calls, keys, forms, events, tick, click, button, submit, edit, html: () => renderToStaticMarkup(tree), get changed() { return changed; }, scope: async next => { props = { ...props, ...next }; dirty = true; paint(); await tick(); }, unmount() { hooks.forEach(hook => hook.close?.()); unmounted = true; } };
}

test('ad-set status actions send only exact native identity/status, explicitly confirm spending and separate acceptance from delivery', async () => {
  const ui = await adSetUi();
  assert.ok(ui.button('Pause ad set'), ui.html() + JSON.stringify(ui.calls)); assert.ok(ui.button('Enable ad set')); await ui.click('Enable ad set'); assert.equal(ui.calls.filter(call => call.body).length, 0); assert.match(ui.html(), /can spend/);
  const cancelled = ui.button('Confirm enable ad set').props.onClick; await ui.click('Cancel enable ad set'); await cancelled(); await ui.tick(); assert.equal(ui.calls.filter(call => call.body).length, 0);
  await ui.click('Enable ad set'); await ui.click('Confirm enable ad set'); await ui.tick();
  assert.deepEqual(ui.calls.find(call => call.body).body, { campaignId: 'campaign/a', platform: 'facebook', adSetId: 'set/a', status: 'active' });
  assert.match(ui.html(), /Enable ad set request accepted/); assert.match(ui.html(), /Delivery reported: paused/); assert.match(ui.html(), /CAMPAIGN_PAUSED/); assert.doesNotMatch(ui.html(), /Ad set enabled/); assert.equal(ui.keys.size, 0);
  await ui.click('Pause ad set', 1); await ui.tick(); assert.deepEqual(ui.calls.filter(call => call.body).at(-1).body, { campaignId: 'campaign/a', platform: 'facebook', adSetId: 'set/b', status: 'paused' });
  const x = await adSetUi(async (path, body) => body ? statusReceipt(body, { platformAdSetStatus: null, platformCampaignStatus: null, statusReadAt: null, updated: 0, skipped: 1, skippedReasons: ['Already paused'] }) : statusItems('twitter'), { campaign: { platformCampaignId: 'campaign/a', platform: 'twitter' } });
  await x.click('Pause ad set'); await x.tick(); assert.match(x.html(), /Live ad set switch read unavailable/); assert.match(x.html(), /no write was needed/); assert.match(x.html(), /Already paused/);
});

test('ad-set actions protect every dirty campaign/ad-set form and Keep editing sends no write, while discard executes one reviewed action', async () => {
  const ui = await adSetUi(); ui.forms[0].elements[0].value = 'Dirty campaign'; ui.forms[1].elements[0].value = 'Dirty set';
  await ui.click('Pause ad set'); assert.match(ui.html(), /Discard unsaved changes/); assert.equal(ui.calls.filter(call => call.body).length, 0);
  await ui.click('Keep editing'); assert.equal(ui.forms[1].elements[0].value, 'Dirty set'); assert.equal(ui.calls.filter(call => call.body).length, 0);
  await ui.click('Enable ad set'); await ui.click('Confirm enable ad set'); const withdrawnDiscard = ui.button('Discard changes and continue').props.onClick; await ui.click('Keep editing'); await withdrawnDiscard(); await ui.tick(); assert.equal(ui.calls.filter(call => call.body).length, 0);
  await ui.click('Enable ad set'); assert.ok(ui.button('Confirm enable ad set')); await ui.click('Confirm enable ad set'); const discard = ui.button('Discard changes and continue').props.onClick; discard(); discard(); await ui.tick();
  assert.equal(ui.calls.filter(call => call.body).length, 1); assert.equal(ui.calls.find(call => call.body).body.status, 'active'); assert.equal(ui.forms[0].elements[0].value, 'Original'); assert.equal(ui.forms[1].elements[0].value, 'Original'); assert.equal(ui.events.filter(event => event.detail.outcome === 'discarded').length >= 2, true);
});

test('unknown or malformed ad-set outcomes retain action identity and block repeats through failed refresh until explicit successful refresh', async () => {
  for (const failure of ['unknown', 'receipt', 'scope', 'status', 'counts', 'timestamp', 'read']) {
    let writes = 0, refreshFails = false;
    const ui = await adSetUi(async (path, body) => {
      if (!body) { if (refreshFails) throw new Error('Refresh unavailable'); return statusItems(); }
      writes++; if (failure === 'unknown') throw new Error('Provider outcome unknown');
      const result = statusReceipt(body); if (failure === 'receipt') result.operation.status = 'pending'; if (failure === 'scope') result.statusAcceptance.adSetId = 'other'; if (failure === 'status') result.statusAcceptance.requestedStatus = 'paused'; if (failure === 'counts') result.statusAcceptance.updated = 2; if (failure === 'timestamp') result.statusAcceptance.statusReadAt = '0'; if (failure === 'read') { refreshFails = true; } return result;
    });
    const retained = ui.button('Enable ad set').props.onClick; await ui.click('Enable ad set'); await ui.click('Confirm enable ad set'); await ui.tick(); assert.equal(writes, 1); assert.equal(ui.keys.has('project-a:ads/adset:' + JSON.stringify(ui.calls.find(call => call.body).body)), failure !== 'read', 'Only the mutation key determines whether the status action can be replayed.');
    await retained(); await ui.tick(); assert.equal(writes, 1, failure);
    refreshFails = true; const refresh = ui.button('Refresh ad sets') || ui.button('Reload ads'); await refresh.props.onClick(); await ui.tick(); assert.equal(writes, 1);
    refreshFails = false; await ui.button('Reload ads').props.onClick(); await ui.tick(); assert.equal(ui.button('Enable ad set').props.disabled, false); assert.equal(writes, 1, 'Reads never replay a write.');
  }
});

test('ad-set status callbacks reject duplicates, departed scopes, terminal resources and viewers', async () => {
  const delayed = deferredStatus(); const ui = await adSetUi(async (path, body) => body ? delayed.promise : statusItems());
  const send = ui.button('Pause ad set').props.onClick, refresh = ui.button('Refresh ad sets').props.onClick; const pending = send(); send(); refresh(); await ui.tick(); assert.equal(ui.calls.filter(call => call.body).length, 1); assert.equal(ui.calls.filter(call => !call.body).length, 1);
  await ui.scope({ canWrite: false }); await ui.scope({ canWrite: true }); delayed.resolve(statusReceipt({ campaignId: 'campaign/a', platform: 'facebook', adSetId: 'set/a', status: 'paused' })); await pending; await ui.tick(); assert.equal(ui.changed, 0); assert.doesNotMatch(ui.html(), /request accepted/); assert.equal(ui.keys.size, 1);
  const before = ui.calls.length; await send(); await ui.tick(); assert.equal(ui.calls.length, before);
  const viewer = await adSetUi(undefined, { canWrite: false }); assert.equal(viewer.button('Pause ad set'), undefined); assert.equal(viewer.button('Enable ad set'), undefined);
  for (const terminal of ['ARCHIVED', 'deleted', 'rejected', 'completed', 'cancelled']) {
    const blocked = await adSetUi(async () => statusItems('facebook', { status: terminal })); assert.equal(blocked.button('Enable ad set').props.disabled, true); await blocked.button('Pause ad set').props.onClick(); assert.equal(blocked.calls.filter(call => call.body).length, 0);
  }
});

test('an ad-set enable confirmation cannot revive after refresh, scope cycles, another target, cancellation or unmount', async () => {
  for (const transition of ['refresh', 'campaign', 'role', 'target', 'cancel', 'unmount']) {
    const ui = await adSetUi(); await ui.click('Enable ad set'); const confirm = ui.button('Confirm enable ad set').props.onClick;
    if (transition === 'refresh') { await ui.click('Refresh ad sets'); await ui.tick(); }
    if (transition === 'campaign') { await ui.scope({ campaign: { platformCampaignId: 'campaign/b', platform: 'facebook' } }); await ui.scope({ campaign: { platformCampaignId: 'campaign/a', platform: 'facebook' } }); }
    if (transition === 'role') { await ui.scope({ canWrite: false }); await ui.scope({ canWrite: true }); }
    if (transition === 'target') await ui.click('Enable ad set', 1);
    if (transition === 'cancel') await ui.click('Cancel enable ad set');
    if (transition === 'unmount') ui.unmount();
    const before = ui.calls.length; await confirm(); await ui.tick(); assert.equal(ui.calls.length, before, transition); assert.equal(ui.calls.filter(call => call.body).length, 0, transition);
    if (transition !== 'unmount' && transition !== 'target') assert.equal(ui.button('Confirm enable ad set'), undefined, transition);
  }
});

test('withdrawn or replaced Pause and Refresh discard callbacks cannot reset forms or continue the old action', async () => {
  for (const action of ['Pause ad set', 'Refresh ad sets']) {
    const ui = await adSetUi(); ui.forms[1].elements[0].value = 'Keep this ad-set draft';
    await ui.click(action); const oldDiscard = ui.button('Discard changes and continue').props.onClick;
    await ui.click('Keep editing'); const before = ui.calls.length; await oldDiscard(); await ui.tick();
    assert.equal(ui.calls.length, before, action); assert.equal(ui.forms[1].elements[0].value, 'Keep this ad-set draft'); assert.equal(ui.events.length, 0);
    await ui.click(action); await oldDiscard(); await ui.tick();
    assert.equal(ui.calls.length, before, 'An older callback cannot accept its replacement.'); assert.ok(ui.button('Discard changes and continue')); assert.equal(ui.forms[1].elements[0].value, 'Keep this ad-set draft');
    const currentDiscard = ui.button('Discard changes and continue').props.onClick; currentDiscard(); currentDiscard(); await ui.tick();
    assert.equal(ui.forms[1].elements[0].value, 'Original'); assert.equal(ui.calls.filter(call => call.body).length, action === 'Pause ad set' ? 1 : 0); assert.equal(ui.calls.filter(call => !call.body).length, 2, 'The accepted continuation refreshes exactly once.');
  }
});

const diagnosticAd = (id = 'ad/a') => ({ _id: id, platformAdId: 'native-' + id, name: id, status: 'paused', creative: {} });
const diagnosticReview = (adId = 'ad/a', platform = 'facebook', extra = {}) => ({ adId, platform, platformAdId: 'native-' + adId, review: { approved: null, reviewStatus: 'APPROVED', approvalStatus: null, readAt: null, forbiddenPlacements: [], forbiddenAges: [], forbiddenLocations: [], forbiddenOperatingSystems: [], rejections: [], policyTopics: [], reviewFeedback: { global: {}, placementSpecific: {} }, issues: [], ...extra } });
const diagnosticResponse = (path, platform = 'facebook') => path.startsWith('ads/details?') ? { ad: diagnosticAd(new URLSearchParams(path.split('?')[1]).get('adId')), statusReadAt: null } : { ...statusItems(platform), ads: [diagnosticAd(), diagnosticAd('ad/b')] };

test('explicit ad-review reads preserve drafts and render null approval, native time and policy diagnostics as inert text', async () => {
  for (const platform of ['facebook', 'instagram', 'google', 'tiktok']) {
    const native = diagnosticReview('ad/a', platform, { forbiddenPlacements: ['Feed'], forbiddenAges: ['18-24'], forbiddenLocations: ['AE'], forbiddenOperatingSystems: ['Android'], rejections: [{ reasons: ['<script>policy()</script>'], suggestion: 'Edit this content\r\nThen request review', forbiddenPlacements: ['Stories'], forbiddenAges: [], forbiddenLocations: [], content: { type: 'TEXT', text: '<img src=x onerror=bad()>', imageId: 'https://never.example/image', videoId: null, musicId: 'music-42' } }], policyTopics: [{ topic: 'Restricted products', type: 'PROHIBITED', evidences: [{ text: '<b>Evidence</b>' }], constraints: [{ country: 'AE' }] }], reviewFeedback: { global: { policy: '<iframe>literal</iframe>' }, placementSpecific: { story: { note: 'Placement reason' } } }, issues: [{ issue: 'Provider issue', url: 'https://never.example/issue' }] });
    const ui = await adSetUi(async path => path.startsWith('ads/review?') ? native : diagnosticResponse(path, platform), { campaign: { platformCampaignId: 'campaign/a', platform }, canWrite: platform !== 'instagram' });
    await ui.click('View details'); await ui.tick(); assert.equal(ui.calls.some(call => call.path.startsWith('ads/review?')), false);
    const draft = ui.forms.at(-1); if (platform !== 'instagram') draft.elements[0].value = 'Unsaved creative';
    const before = ui.calls.length; await ui.click('Load ad review'); await ui.tick(); assert.equal(ui.calls.length, before + 1); assert.equal(ui.calls.at(-1).path, 'ads/review?adId=ad%2Fa');
    const html = ui.html(); assert.match(html, /Approval: Not reported/); assert.match(html, /Review status: APPROVED/); assert.match(html, /Provider review read time: Not reported/); assert.match(html, /Restricted placements: Feed/); assert.match(html, /Provider advice: Edit this content/); assert.match(html, /music-42/); assert.match(html, /Restricted products/); assert.match(html, /Provider issue/); assert.match(html, /&lt;script&gt;policy/); assert.match(html, /&lt;img src=x/); assert.doesNotMatch(html, /<script|<img|<iframe|href="https:\/\/never|src="https:\/\/never/);
    if (platform !== 'instagram') assert.equal(draft.elements[0].value, 'Unsaved creative'); assert.equal(ui.events.length, 0); assert.equal(ui.changed, 0); assert.ok(ui.calls.every(call => call.body === undefined && call.method === 'GET'));
    native.review.approved = false; native.review.readAt = '2026-10-19T12:34:56.000Z'; await ui.click('Refresh ad review'); await ui.tick(); assert.match(ui.html(), /Approval: Not approved/); assert.match(ui.html(), /2026-10-19T12:34:56.000Z/);
  }
});

test('review loading, provider failures and malformed receipts stay independent of creative/status state', async () => {
  const delayed = deferredStatus(); let response = delayed.promise;
  const ui = await adSetUi(async path => path.startsWith('ads/review?') ? response : diagnosticResponse(path)); await ui.click('View details'); await ui.tick();
  const draft = ui.forms.at(-1); draft.elements[0].value = 'Keep this creative'; const load = ui.button('Load ad review').props.onClick;
  const pending = ui.click('Load ad review'); await load(); await ui.tick(); assert.equal(ui.calls.filter(call => call.path.startsWith('ads/review?')).length, 1); assert.equal(ui.button('Load ad review').props.disabled, true); assert.equal(ui.button('Pause ad set').props.disabled, false);
  delayed.reject(new Error('Review temporarily unavailable')); await pending; await ui.tick(); assert.match(ui.html(), /Review temporarily unavailable/); assert.equal(draft.elements[0].value, 'Keep this creative'); assert.equal(ui.changed, 0);
  for (const malformed of [{ ...diagnosticReview(), adId: 'other' }, { ...diagnosticReview(), platform: 'google' }, { ...diagnosticReview(), platformAdId: 'other' }, diagnosticReview('ad/a', 'facebook', { approved: 'yes' }), diagnosticReview('ad/a', 'facebook', { readAt: '0' }), diagnosticReview('ad/a', 'facebook', { rejections: [{}] }), diagnosticReview('ad/a', 'facebook', { reviewFeedback: { global: {}, placementSpecific: [] } })]) {
    response = malformed; await ui.click('Load ad review'); await ui.tick(); assert.match(ui.html(), /ad review response could not be verified/); assert.equal(draft.elements[0].value, 'Keep this creative'); assert.equal(ui.button('Pause ad set').props.disabled, false);
  }
  assert.equal(ui.events.length, 0); assert.ok(ui.calls.every(call => call.body === undefined));
});

test('ad-review results and retained callbacks reject selection, data, role and campaign cycles or unmount', async () => {
  for (const transition of ['selection', 'data', 'role', 'campaign', 'unmount']) {
    const delayed = deferredStatus(); let first = true;
    const ui = await adSetUi(async path => path.startsWith('ads/review?') ? first ? (first = false, delayed.promise) : diagnosticReview() : diagnosticResponse(path));
    await ui.click('View details'); await ui.tick(); const oldLoad = ui.button('Load ad review').props.onClick, pending = ui.click('Load ad review');
    if (transition === 'selection') { await ui.click('View details', 1); await ui.tick(); await ui.click('View details'); await ui.tick(); }
    if (transition === 'data') { await ui.click('Refresh ad sets'); await ui.tick(); await ui.click('View details'); await ui.tick(); }
    if (transition === 'role') { await ui.scope({ canWrite: false }); await ui.scope({ canWrite: true }); }
    if (transition === 'campaign') { await ui.scope({ campaign: { platformCampaignId: 'campaign/b', platform: 'facebook' } }); await ui.scope({ campaign: { platformCampaignId: 'campaign/a', platform: 'facebook' } }); await ui.click('View details'); await ui.tick(); }
    if (transition === 'unmount') ui.unmount();
    delayed.resolve(diagnosticReview('ad/a', 'facebook', { reviewStatus: 'DEPARTED REVIEW' })); await pending; await ui.tick(); assert.doesNotMatch(ui.html(), /DEPARTED REVIEW/);
    const before = ui.calls.length; await oldLoad(); await ui.tick(); assert.equal(ui.calls.length, before, transition);
    if (transition !== 'unmount') { await ui.click('Load ad review'); await ui.tick(); assert.match(ui.html(), /Approval: Not reported/); }
    assert.ok(ui.calls.every(call => call.body === undefined));
  }
  const unsupported = await adSetUi(async path => diagnosticResponse(path, 'twitter'), { campaign: { platformCampaignId: 'campaign/a', platform: 'twitter' } }); await unsupported.click('View details'); await unsupported.tick(); assert.equal(unsupported.button('Load ad review'), undefined);
});

const campaignCopyReference = (platform = 'facebook', extra = {}) => ({ sourceCampaignId: 'campaign/a', platform, copiedCampaignId: 'copy/one', discovery: 'triggered', requestedStatus: 'PAUSED', verification: 'pending', statusReadAt: null, ...extra });
const campaignCopyReview = (platform = 'facebook', extra = {}) => ({ source: { sourceCampaignId: 'campaign/a', platform, accountId: 'connection/a', adAccountId: 'native/a', name: '<script>Source campaign</script>', currency: null, budgetLevel: null, campaignBudget: null, adCount: null, adSetCount: null }, version: 'a'.repeat(64), canCopy: true, previousCopy: null, unresolved: false, ...extra });

test('campaign copying reviews fixed scope and unknown budgets, cancels safely and sends one owned paused-copy request after discard', async () => {
  let review = campaignCopyReview(); const ui = await adSetUi(async (path, body) => path === 'ads/copy' ? { operation: { id: 'copy-action', status: 'complete' }, campaignCopy: campaignCopyReference() } : path.startsWith('ads/copy-review?') ? review : path.startsWith('ads/copy-status?') ? { campaignCopy: campaignCopyReference('facebook', { verification: 'paused', statusReadAt: '2026-10-19T15:00:00.000Z' }) } : statusItems());
  assert.equal(ui.calls.length, 1); await ui.click('Load copy review'); await ui.tick(); assert.equal(ui.calls.at(-1).path, 'ads/copy-review?campaignId=campaign%2Fa&platform=facebook'); assert.match(ui.html(), /Budget scope: Unknown/); assert.match(ui.html(), /Campaign budget: Unknown/); assert.match(ui.html(), /Reported source ads: Unknown/); assert.match(ui.html(), /whole-campaign copy including child ad sets, ads, creatives and targeting/); assert.match(ui.html(), /&lt;script&gt;Source campaign/); assert.doesNotMatch(ui.html(), /<script>/);
  const cancelled = ui.button('Confirm paused campaign copy').props.onClick; await ui.click('Cancel campaign copy'); await cancelled(); await ui.tick(); assert.equal(ui.calls.filter(call => call.body).length, 0);
  ui.forms[1].elements[0].value = 'Keep this draft'; await ui.click('Refresh copy review'); await ui.tick(); await ui.click('Confirm paused campaign copy'); const oldDiscard = ui.button('Discard changes and continue').props.onClick; await ui.click('Keep editing'); await oldDiscard(); await ui.tick(); assert.equal(ui.calls.filter(call => call.body).length, 0); assert.equal(ui.forms[1].elements[0].value, 'Keep this draft');
  await ui.click('Refresh copy review'); await ui.tick(); await ui.click('Confirm paused campaign copy'); const discard = ui.button('Discard changes and continue').props.onClick; discard(); discard(); await ui.tick();
  assert.equal(ui.calls.filter(call => call.body).length, 1); assert.deepEqual(ui.calls.find(call => call.body).body, { campaignId: 'campaign/a', platform: 'facebook', version: 'a'.repeat(64), confirmDuplicate: true }); assert.equal(ui.keys.size, 0); assert.match(ui.html(), /Provider-reported copied campaign: copy\/one/); assert.match(ui.html(), /ownership and paused state remain unverified/); assert.equal(ui.calls.some(call => call.path.startsWith('ads/copy-status?')), false);
  await ui.click('Check copy'); await ui.tick(); assert.equal(ui.calls.at(-1).path, 'ads/copy-status?campaignId=campaign%2Fa&platform=facebook&copiedCampaignId=copy%2Fone'); assert.match(ui.html(), /paused state verified by an explicit provider check/); assert.match(ui.html(), /Child completeness is unknown/); assert.equal(ui.changed, 0);
  review = campaignCopyReview('facebook', { canCopy: false, previousCopy: campaignCopyReference() }); await ui.click('Refresh copy review'); await ui.tick(); assert.equal(ui.button('Confirm paused campaign copy'), undefined); assert.ok(ui.button('Check copy'));
});

test('copy review supports only the native platforms, readers cannot confirm, and reopened Meta aliases check only the returned own reference', async () => {
  for (const platform of ['facebook', 'instagram', 'tiktok', 'linkedin']) {
    const ui = await adSetUi(async path => path.startsWith('ads/copy-review?') ? campaignCopyReview(platform) : statusItems(platform), { campaign: { platformCampaignId: 'campaign/a', platform }, canWrite: false }); await ui.click('Load copy review'); await ui.tick(); assert.equal(ui.button('Confirm paused campaign copy'), undefined); assert.equal(ui.calls.filter(call => call.body).length, 0);
  }
  const alias = campaignCopyReference('facebook'); const ui = await adSetUi(async path => path.startsWith('ads/copy-review?') ? campaignCopyReview('instagram', { canCopy: false, previousCopy: alias }) : path.startsWith('ads/copy-status?') ? { campaignCopy: alias } : statusItems('instagram'), { campaign: { platformCampaignId: 'campaign/a', platform: 'instagram' } });
  await ui.click('Load copy review'); await ui.tick(); await ui.click('Check copy'); await ui.tick(); assert.match(ui.calls.at(-1).path, /platform=facebook&copiedCampaignId=copy%2Fone/); assert.equal(ui.button('Confirm paused campaign copy'), undefined);
  const blocked = await adSetUi(async path => path.startsWith('ads/copy-review?') ? campaignCopyReview('facebook', { canCopy: false, unresolved: true, previousCopy: campaignCopyReference('facebook', { copiedCampaignId: null, discovery: null }) }) : statusItems()); await blocked.click('Load copy review'); await blocked.tick(); assert.match(blocked.html(), /previous provider outcome is unresolved/); assert.equal(blocked.button('Check copy'), undefined); assert.equal(blocked.button('Confirm paused campaign copy'), undefined);
  const unsupported = await adSetUi(async () => statusItems('google'), { campaign: { platformCampaignId: 'campaign/a', platform: 'google' } }); assert.equal(unsupported.button('Load copy review'), undefined);
});

test('unknown and malformed campaign-copy acknowledgements retain their mutation key and never auto-resend on source review', async () => {
  for (const failure of ['unknown', 'operation', 'identity', 'discovery', 'verified']) {
    let written = false; const ui = await adSetUi(async (path, body) => {
      if (path.startsWith('ads/copy-review?')) return campaignCopyReview('facebook', written ? { canCopy: false, unresolved: true, previousCopy: campaignCopyReference('facebook', { copiedCampaignId: null, discovery: null }) } : {});
      if (!body) return statusItems(); written = true; if (failure === 'unknown') throw new Error('Copy outcome unknown');
      const result = { operation: { id: 'copy-action', status: 'complete' }, campaignCopy: campaignCopyReference() }; if (failure === 'operation') result.operation.status = 'pending'; if (failure === 'identity') result.campaignCopy.sourceCampaignId = 'other'; if (failure === 'discovery') result.campaignCopy.discovery = 'invalid'; if (failure === 'verified') Object.assign(result.campaignCopy, { verification: 'paused', statusReadAt: '2026-10-19T15:00:00.000Z' }); return result;
    });
    await ui.click('Load copy review'); await ui.tick(); const confirm = ui.button('Confirm paused campaign copy').props.onClick; await ui.click('Confirm paused campaign copy'); await ui.tick(); assert.equal(ui.calls.filter(call => call.body).length, 1); assert.equal(ui.keys.has('project-a:ads/copy:' + JSON.stringify(ui.calls.find(call => call.body).body)), true, failure); assert.match(ui.html(), /Provider outcomes/);
    await confirm(); await ui.tick(); assert.equal(ui.calls.filter(call => call.body).length, 1); await ui.click('Refresh copy review'); await ui.tick(); assert.equal(ui.button('Confirm paused campaign copy'), undefined); assert.match(ui.html(), /previous provider outcome is unresolved/); assert.equal(ui.calls.filter(call => call.body).length, 1);
  }
});

test('campaign-copy review and confirmation ownership rejects fresh versions, data/role/campaign cycles and unmount', async () => {
  for (const transition of ['review', 'data', 'role', 'campaign', 'unmount']) {
    let version = 'a'.repeat(64); const ui = await adSetUi(async path => path.startsWith('ads/copy-review?') ? campaignCopyReview('facebook', { version }) : statusItems()); await ui.click('Load copy review'); await ui.tick(); const confirm = ui.button('Confirm paused campaign copy').props.onClick;
    if (transition === 'review') { version = 'b'.repeat(64); await ui.click('Refresh copy review'); await ui.tick(); }
    if (transition === 'data') { await ui.click('Refresh ad sets'); await ui.tick(); }
    if (transition === 'role') { await ui.scope({ canWrite: false }); await ui.scope({ canWrite: true }); }
    if (transition === 'campaign') { await ui.scope({ campaign: { platformCampaignId: 'campaign/b', platform: 'facebook' } }); await ui.scope({ campaign: { platformCampaignId: 'campaign/a', platform: 'facebook' } }); }
    if (transition === 'unmount') ui.unmount(); const before = ui.calls.length; await confirm(); await ui.tick(); assert.equal(ui.calls.length, before, transition); assert.equal(ui.calls.filter(call => call.body).length, 0);
  }
  const delayed = deferredStatus(); const ui = await adSetUi(async path => path.startsWith('ads/copy-review?') ? delayed.promise : statusItems()); const pending = ui.click('Load copy review'); await ui.scope({ canWrite: false }); await ui.scope({ canWrite: true }); delayed.resolve(campaignCopyReview()); await pending; await ui.tick(); assert.equal(ui.button('Confirm paused campaign copy'), undefined);
});

test('copy status checks reject mismatched references and departed responses without granting another copy', async () => {
  const delayed = deferredStatus(); let response = { campaignCopy: campaignCopyReference('facebook', { copiedCampaignId: 'foreign-copy' }) };
  const ui = await adSetUi(async path => path.startsWith('ads/copy-review?') ? campaignCopyReview('facebook', { canCopy: false, previousCopy: campaignCopyReference() }) : path.startsWith('ads/copy-status?') ? response : statusItems());
  await ui.click('Load copy review'); await ui.tick(); await ui.click('Check copy'); await ui.tick(); assert.match(ui.html(), /another campaign copy/); assert.match(ui.html(), /ownership and paused state remain unverified/); assert.equal(ui.button('Confirm paused campaign copy'), undefined);
  response = delayed.promise; const pending = ui.click('Check copy'); await ui.scope({ canWrite: false }); await ui.scope({ canWrite: true }); delayed.resolve({ campaignCopy: campaignCopyReference('facebook', { verification: 'paused', statusReadAt: '2026-10-19T15:00:00.000Z' }) }); await pending; await ui.tick(); assert.doesNotMatch(ui.html(), /paused state verified/); assert.equal(ui.calls.filter(call => call.body).length, 0);
});


const budgetItems = () => statusItems('facebook', { budgetLevel: 'adset' });
const budgetReview = path => { const query = new URLSearchParams(path.split('?')[1]); return { budgetReview: { campaignId: query.get('campaignId'), platform: query.get('platform'), adSetId: query.get('adSetId'), accountId: 'metaads', adAccountId: 'act_123', currency: query.get('currency'), currentAmount: 20, proposedAmount: Number(query.get('amount')), type: 'daily', budgetLevel: 'adset', readAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 240000).toISOString(), version: 'b'.repeat(64) } }; };
const budgetReceipt = body => ({ operation: { id: 'budget-operation', status: 'complete' }, budgetAcceptance: { campaignId: body.campaignId, platform: body.platform, adSetId: body.adSetId, accountId: 'metaads', adAccountId: 'act_123', currency: body.currency, requestedAmount: body.budget.amount, acknowledgedAmount: body.budget.amount, observedAmount: body.budget.amount, readAt: new Date().toISOString() } });
const budgetRespond = async (path, body) => path.startsWith('ads/adset-budget-review?') ? budgetReview(path) : body?.budget ? budgetReceipt(body) : body ? { operation: { id: 'name-operation', status: 'complete' }, result: {} } : budgetItems();

test('actual daily-budget review separates name-only saves, before/after cost review, cancel and one confirmed scoped budget write', async () => {
  const ui = await adSetUi(budgetRespond);
  await ui.submit('Save ad set', { name: 'Renamed set', amount: '999' }); await ui.tick(); assert.deepEqual(ui.calls.find(call => call.body).body, { campaignId: 'campaign/a', platform: 'facebook', adSetId: 'set/a', name: 'Renamed set' });
  await ui.submit('Review daily budget', { amount: '30.25' }); assert.match(ui.html(), /Current daily budget: 20 AED/); assert.match(ui.html(), /Proposed daily budget: 30.25 AED/); assert.match(ui.html(), /every ad in this ad set/);
  const cancelled = ui.button('Confirm daily budget').props.onClick; await ui.click('Cancel daily budget'); await cancelled(); assert.equal(ui.calls.filter(call => call.body?.budget).length, 0);
  await ui.submit('Review daily budget', { amount: '30.25' }); const confirm = ui.button('Confirm daily budget').props.onClick; await confirm(); await confirm(); await ui.tick();
  const writes = ui.calls.filter(call => call.body?.budget); assert.equal(writes.length, 1); assert.deepEqual(Object.keys(writes[0].body).sort(), ['adSetId', 'budget', 'campaignId', 'confirmBudget', 'currency', 'platform', 'reviewExpiresAt', 'version']); assert.deepEqual(writes[0].body.budget, { amount: 30.25, type: 'daily' }); assert.equal(writes[0].body.confirmBudget, true); assert.equal(writes[0].body.currency, 'AED'); assert.equal(ui.keys.size, 0); assert.match(ui.html(), /Daily budget request accepted/); assert.match(ui.html(), /Independent live budget read: 30.25 AED/);
});

test('budget edits and Keep editing withdraw one-use approvals; all sibling drafts need discard and stale callbacks cannot send', async () => {
  for (const transition of ['edit', 'cancel', 'keep', 'refresh', 'campaign', 'role', 'unmount']) {
    const ui = await adSetUi(budgetRespond); await ui.submit('Review daily budget', { amount: '30' }); const confirm = ui.button('Confirm daily budget').props.onClick;
    if (transition === 'edit') ui.edit('Review daily budget', { amount: '31' });
    if (transition === 'cancel') await ui.click('Cancel daily budget');
    if (transition === 'keep') { ui.forms[0].elements[0].value = 'Dirty campaign'; await confirm(); await ui.tick(); const discard = ui.button('Discard changes and continue').props.onClick; await ui.click('Keep editing'); await discard(); assert.equal(ui.forms[0].elements[0].value, 'Dirty campaign'); }
    if (transition === 'refresh') { await ui.click('Refresh ad sets'); await ui.tick(); }
    if (transition === 'campaign') { await ui.scope({ campaign: { platformCampaignId: 'campaign/b', platform: 'facebook' } }); await ui.scope({ campaign: { platformCampaignId: 'campaign/a', platform: 'facebook' } }); }
    if (transition === 'role') { await ui.scope({ canWrite: false }); await ui.scope({ canWrite: true }); }
    if (transition === 'unmount') ui.unmount();
    await confirm(); await ui.tick(); assert.equal(ui.calls.filter(call => call.body).length, 0, transition);
  }
  const ui = await adSetUi(budgetRespond); ui.forms[0].elements[0].value = 'Dirty campaign'; ui.forms[1].elements[0].value = 'Dirty set'; await ui.submit('Review daily budget', { amount: '30' }); await ui.click('Confirm daily budget'); const discard = ui.button('Discard changes and continue').props.onClick; await discard(); await discard(); await ui.tick(); assert.equal(ui.calls.filter(call => call.body).length, 1); assert.equal(ui.forms[0].elements[0].value, 'Original');
});

test('unknown or malformed budget outcomes retain keys and block automatic repeats until an explicit successful refresh', async () => {
  for (const failure of ['unknown', 'amount', 'scope', 'currency', 'timestamp', 'operation', 'refresh']) {
    let refreshFails = false;
    const ui = await adSetUi(async (path, body) => {
      if (path.startsWith('ads/adset-budget-review?')) return budgetReview(path);
      if (!body) { if (refreshFails) throw new Error('Read failed'); return budgetItems(); }
      if (failure === 'unknown') throw new Error('Unknown outcome');
      const result = budgetReceipt(body); if (failure === 'amount') result.budgetAcceptance.observedAmount = 31; if (failure === 'scope') result.budgetAcceptance.accountId = 'foreign'; if (failure === 'currency') result.budgetAcceptance.currency = 'USD'; if (failure === 'timestamp') result.budgetAcceptance.readAt = '0'; if (failure === 'operation') result.operation.status = 'pending'; if (failure === 'refresh') refreshFails = true; return result;
    });
    await ui.submit('Review daily budget', { amount: '30' }); const confirm = ui.button('Confirm daily budget').props.onClick; await confirm(); await ui.tick(); assert.equal(ui.calls.filter(call => call.body).length, 1); assert.equal(ui.keys.has('project-a:ads/adset:' + JSON.stringify(ui.calls.find(call => call.body).body)), failure !== 'refresh', failure + ': only the mutation key determines safe replay.'); await confirm(); await ui.tick(); assert.equal(ui.calls.filter(call => call.body).length, 1); if (failure !== 'refresh') assert.equal(ui.button('Pause ad set').props.disabled, true);
    refreshFails = false; await (ui.button('Refresh ad sets') || ui.button('Reload ads')).props.onClick(); await ui.tick(); assert.equal(ui.calls.filter(call => call.body).length, 1, 'Refreshing never repeats a budget write.');
  }
});

test('budget review reads reject malformed, expired or departed responses and unsupported editors cannot offer budget controls', async () => {
  for (const failure of ['currency', 'proposal', 'expired', 'read', 'account']) {
    const ui = await adSetUi(async (path, body) => { if (!path.startsWith('ads/adset-budget-review?')) return budgetItems(); const value = budgetReview(path); if (failure === 'currency') value.budgetReview.currency = 'USD'; if (failure === 'proposal') value.budgetReview.proposedAmount++; if (failure === 'expired') value.budgetReview.expiresAt = new Date(0).toISOString(); if (failure === 'read') value.budgetReview.readAt = '0'; if (failure === 'account') value.budgetReview.accountId = ''; return value; });
    await ui.submit('Review daily budget', { amount: '30' }); assert.equal(ui.button('Confirm daily budget'), undefined); assert.equal(ui.calls.filter(call => call.body).length, 0);
  }
  const delayed = deferredStatus(), ui = await adSetUi(async path => path.startsWith('ads/adset-budget-review?') ? delayed.promise : budgetItems()); const pending = ui.submit('Review daily budget', { amount: '30' }); await ui.tick(); ui.edit('Review daily budget', { amount: '31' }); delayed.resolve(budgetReview('ads/adset-budget-review?campaignId=campaign%2Fa&platform=facebook&adSetId=set%2Fa&amount=30&currency=AED')); await pending; assert.equal(ui.button('Confirm daily budget'), undefined);
  for (const props of [{ canWrite: false }, { campaign: { platformCampaignId: 'campaign/a', platform: 'tiktok' } }]) { const blocked = await adSetUi(budgetRespond, props); assert.equal(blocked.button('Review daily budget'), undefined); }
});


test('a pending budget write cannot publish acceptance or clear its key after role/campaign cycles or unmount', async () => {
  for (const transition of ['role', 'campaign', 'unmount']) {
    const delayed = deferredStatus(), ui = await adSetUi(async (path, body) => path.startsWith('ads/adset-budget-review?') ? budgetReview(path) : body ? delayed.promise : budgetItems());
    await ui.submit('Review daily budget', { amount: '30' }); const send = ui.button('Confirm daily budget').props.onClick, pending = send(); await ui.tick(); assert.equal(ui.calls.filter(call => call.body).length, 1);
    if (transition === 'role') { await ui.scope({ canWrite: false }); await ui.scope({ canWrite: true }); }
    if (transition === 'campaign') { await ui.scope({ campaign: { platformCampaignId: 'campaign/b', platform: 'facebook' } }); await ui.scope({ campaign: { platformCampaignId: 'campaign/a', platform: 'facebook' } }); }
    if (transition === 'unmount') ui.unmount();
    delayed.resolve(budgetReceipt(ui.calls.find(call => call.body).body)); await pending; await ui.tick(); assert.equal(ui.changed, 0, transition); assert.equal(ui.keys.has('project-a:ads/adset:' + JSON.stringify(ui.calls.find(call => call.body).body)), true); assert.doesNotMatch(ui.html(), /Daily budget request accepted/, transition); await send(); assert.equal(ui.calls.filter(call => call.body).length, 1);
  }
});


const campaignBudgetItems = () => statusItems('facebook', { budgetLevel: 'adset', campaignBudget: null }); // Synced ownership may lag native CBO.
const campaignBudgetReview = path => { const result = budgetReview(path); result.budgetReview.adSetId = null; result.budgetReview.budgetLevel = 'campaign'; return result; };
const campaignBudgetReceipt = body => { const result = budgetReceipt({ ...body, adSetId: null }); return result; };
const campaignBudgetRespond = async (path, body) => path.startsWith('ads/campaign-budget-review?') ? campaignBudgetReview(path) : body?.budget ? campaignBudgetReceipt(body) : body ? { operation: { id: 'name-operation', status: 'complete' }, result: {} } : campaignBudgetItems();

test('campaign-owned daily budget controls review live before/after amounts, cancel, and submit one budget-only proposal while Meta names stay separate', async () => {
  const ui = await adSetUi(campaignBudgetRespond); await ui.submit('Save campaign', { name: 'New Meta campaign name', amount: '999' }); assert.deepEqual(ui.calls.find(call => call.body).body, { campaignId: 'campaign/a', platform: 'facebook', name: 'New Meta campaign name' });
  await ui.submit('Review daily campaign budget', { amount: '35.25' }); assert.match(ui.calls.at(-1).path, /^ads\/campaign-budget-review\?/); assert.doesNotMatch(ui.calls.at(-1).path, /adSetId/); assert.match(ui.html(), /Current daily budget: 20 AED/); assert.match(ui.html(), /Proposed daily budget: 35.25 AED/); assert.match(ui.html(), /shared by its ad sets and ads/);
  const cancelled = ui.button('Confirm daily campaign budget').props.onClick; await ui.click('Cancel daily campaign budget'); await cancelled(); assert.equal(ui.calls.filter(call => call.body?.budget).length, 0);
  await ui.submit('Review daily campaign budget', { amount: '35.25' }); const confirm = ui.button('Confirm daily campaign budget').props.onClick; await confirm(); await confirm(); await ui.tick(); const writes = ui.calls.filter(call => call.body?.budget); assert.equal(writes.length, 1); assert.equal(writes[0].path, 'ads/campaign'); assert.deepEqual(Object.keys(writes[0].body).sort(), ['budget', 'campaignId', 'confirmBudget', 'currency', 'platform', 'reviewExpiresAt', 'version']); assert.deepEqual(writes[0].body.budget, { amount: 35.25, type: 'daily' }); assert.match(ui.html(), /Daily campaign budget request accepted: 35.25 AED/); assert.match(ui.html(), /Independent live budget read: 35.25 AED/); assert.equal(ui.keys.size, 0);
});

test('campaign budget approvals withdraw on edits, cancellation, dirty Keep editing, refresh and scope cycles; discard permits one reviewed action', async () => {
  for (const transition of ['edit', 'cancel', 'keep', 'refresh', 'campaign', 'role', 'unmount']) {
    const ui = await adSetUi(campaignBudgetRespond); await ui.submit('Review daily campaign budget', { amount: '35' }); const confirm = ui.button('Confirm daily campaign budget').props.onClick;
    if (transition === 'edit') ui.edit('Review daily campaign budget', { amount: '36' }); if (transition === 'cancel') await ui.click('Cancel daily campaign budget');
    if (transition === 'keep') { ui.forms[2].elements[0].value = 'Unsaved child set'; await confirm(); await ui.tick(); const discard = ui.button('Discard changes and continue').props.onClick; await ui.click('Keep editing'); await discard(); assert.equal(ui.forms[2].elements[0].value, 'Unsaved child set'); }
    if (transition === 'refresh') { await ui.click('Refresh ad sets'); await ui.tick(); }
    if (transition === 'campaign') { await ui.scope({ campaign: { platformCampaignId: 'campaign/b', platform: 'facebook' } }); await ui.scope({ campaign: { platformCampaignId: 'campaign/a', platform: 'facebook' } }); }
    if (transition === 'role') { await ui.scope({ canWrite: false }); await ui.scope({ canWrite: true }); } if (transition === 'unmount') ui.unmount();
    await confirm(); await ui.tick(); assert.equal(ui.calls.filter(call => call.body).length, 0, transition);
  }
  const ui = await adSetUi(campaignBudgetRespond); ui.forms[2].elements[0].value = 'Discard child set draft'; await ui.submit('Review daily campaign budget', { amount: '35' }); await ui.click('Confirm daily campaign budget'); const discard = ui.button('Discard changes and continue').props.onClick; await discard(); await discard(); await ui.tick(); assert.equal(ui.calls.filter(call => call.body?.budget).length, 1); assert.equal(ui.forms[2].elements[0].value, 'Original');
});

test('campaign budget unknown, malformed or departed acknowledgements retain mutation keys and never automatically resend', async () => {
  for (const failure of ['unknown', 'amount', 'level', 'currency', 'timestamp', 'refresh', 'role', 'campaign', 'unmount']) {
    let refreshFails = false; const delayed = deferredStatus(), ui = await adSetUi(async (path, body) => {
      if (path.startsWith('ads/campaign-budget-review?')) return campaignBudgetReview(path); if (!body) { if (refreshFails) throw new Error('Refresh unavailable'); return campaignBudgetItems(); }
      if (failure === 'unknown') throw new Error('Unknown provider budget outcome'); if (['role', 'campaign', 'unmount'].includes(failure)) return delayed.promise;
      const result = campaignBudgetReceipt(body); if (failure === 'amount') result.budgetAcceptance.observedAmount = 36; if (failure === 'level') result.budgetAcceptance.adSetId = 'child-set'; if (failure === 'currency') result.budgetAcceptance.currency = 'USD'; if (failure === 'timestamp') result.budgetAcceptance.readAt = '0'; if (failure === 'refresh') refreshFails = true; return result;
    });
    await ui.submit('Review daily campaign budget', { amount: '35' }); const confirm = ui.button('Confirm daily campaign budget').props.onClick, pending = confirm(); await ui.tick();
    if (failure === 'role') { await ui.scope({ canWrite: false }); await ui.scope({ canWrite: true }); } if (failure === 'campaign') { await ui.scope({ campaign: { platformCampaignId: 'campaign/b', platform: 'facebook' } }); await ui.scope({ campaign: { platformCampaignId: 'campaign/a', platform: 'facebook' } }); } if (failure === 'unmount') ui.unmount();
    if (['role', 'campaign', 'unmount'].includes(failure)) delayed.resolve(campaignBudgetReceipt(ui.calls.find(call => call.body).body)); await pending; await ui.tick();
    const writes = ui.calls.filter(call => call.body); assert.equal(writes.length, 1); assert.equal(ui.keys.has('project-a:ads/campaign:' + JSON.stringify(writes[0].body)), failure !== 'refresh', failure); await confirm(); await ui.tick(); assert.equal(ui.calls.filter(call => call.body).length, 1);
    if (!['role', 'campaign', 'unmount'].includes(failure)) { refreshFails = false; await (ui.button('Refresh ad sets') || ui.button('Reload ads')).props.onClick(); await ui.tick(); assert.equal(ui.calls.filter(call => call.body).length, 1); }
  }
});

test('campaign review rejects wrong ownership, expired or late reads and is unavailable to viewers or other campaign editors', async () => {
  for (const failure of ['ownership', 'expired', 'currency', 'proposal']) {
    const ui = await adSetUi(async (path, body) => { if (!path.startsWith('ads/campaign-budget-review?')) return campaignBudgetItems(); const result = campaignBudgetReview(path); if (failure === 'ownership') result.budgetReview.budgetLevel = 'adset'; if (failure === 'expired') result.budgetReview.expiresAt = new Date(0).toISOString(); if (failure === 'currency') result.budgetReview.currency = 'USD'; if (failure === 'proposal') result.budgetReview.proposedAmount++; return result; }); await ui.submit('Review daily campaign budget', { amount: '35' }); assert.equal(ui.button('Confirm daily campaign budget'), undefined); assert.equal(ui.calls.filter(call => call.body).length, 0);
  }
  const delayed = deferredStatus(), ui = await adSetUi(async path => path.startsWith('ads/campaign-budget-review?') ? delayed.promise : campaignBudgetItems()); const pending = ui.submit('Review daily campaign budget', { amount: '35' }); await ui.tick(); ui.edit('Review daily campaign budget', { amount: '36' }); delayed.resolve(campaignBudgetReview('ads/campaign-budget-review?campaignId=campaign%2Fa&platform=facebook&amount=35&currency=AED')); await pending; assert.equal(ui.button('Confirm daily campaign budget'), undefined);
  for (const props of [{ canWrite: false }, { campaign: { platformCampaignId: 'campaign/a', platform: 'google' } }, { campaign: { platformCampaignId: 'campaign/a', platform: 'openai' } }]) { const blocked = await adSetUi(campaignBudgetRespond, props); assert.equal(blocked.button('Review daily campaign budget'), undefined); }
});


test('Google, OpenAI and Reddit campaign editors keep their existing budget payloads without Meta review fields', async () => {
  for (const [platform, budgetType] of [['google', 'daily'], ['openai', 'lifetime'], ['reddit', 'daily']]) {
    const ui = await adSetUi(async (path, body) => body ? { operation: { id: 'legacy-campaign', status: 'complete' }, result: {} } : statusItems(platform, { budgetLevel: 'campaign', campaignBudget: { amount: 20, type: budgetType } }), { campaign: { platformCampaignId: 'campaign/a', platform } });
    await ui.submit('Save campaign', { amount: '50', budgetType }); const payload = ui.calls.find(call => call.body); assert.equal(payload.path, 'ads/campaign'); assert.deepEqual(payload.body, { campaignId: 'campaign/a', platform, budget: { amount: 50, type: budgetType } }); assert.equal(ui.button('Review daily campaign budget'), undefined);
  }
});


const discoverySource = await readFile(new URL('../src/AdCampaignDiscovery.tsx', import.meta.url), 'utf8');
const { code: discoveryCode } = await transformWithOxc(discoverySource.replace(/^import .+;\r?\n/gm, '').replace('export default function ', 'function '), 'AdCampaignDiscovery.tsx', { jsx: { runtime: 'classic' } });
const discoveryResult = (accountId = 'meta/a', adAccountId = 'act_123', extra = {}) => ({ accountId, adAccountId, complete: true, campaigns: [{ platformCampaignId: 'empty-campaign', platform: 'facebook', campaignName: '<b>Empty campaign</b>', status: 'paused', platformCampaignStatus: 'PAUSED', adCount: 0 }], ...extra });
async function discoveryUi(respond) {
  const hooks = [], queued = [], calls = []; let cursor = 0, dirty = true, tree, unmounted = false;
  const state = initial => { const index = cursor++; hooks[index] ||= { value: initial }; return [hooks[index].value, value => { assert.equal(unmounted, false, 'No updates after unmount'); const next = typeof value === 'function' ? value(hooks[index].value) : value; if (!Object.is(next, hooks[index].value)) { hooks[index].value = next; dirty = true; } }]; };
  const ref = initial => hooks[cursor++] ||= { current: initial };
  const memo = (run, dependencies) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) hooks[index] = { value: run(), dependencies }; return hooks[index].value; };
  const effect = (run, dependencies) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) { hooks[index] = { dependencies, close: old?.close }; queued.push(() => { hooks[index].close?.(); hooks[index].close = run(); }); } };
  const request = async (...args) => { assert.equal(args.length, 1, 'Discovery only makes reads.'); const path = args[0]; calls.push(path); if (respond) { const result = await respond(path); if (result !== undefined) return result; } if (path === 'accounts') return { accounts: [{ _id: 'meta/a', platform: 'metaads', isActive: true }, { _id: 'meta/b', platform: 'facebook', isActive: true }, { _id: 'google', platform: 'googleads', isActive: true }] }; if (path.startsWith('ads/accounts?')) return { accounts: [{ id: 'act_123', name: 'Scoped advertiser', selectable: true }, { id: 'act_456', name: 'Second advertiser', selectable: true }] }; const query = new URL(path, 'https://example.test').searchParams; return discoveryResult(query.get('accountId'), query.get('adAccountId')); };
  const names = ['Alert', 'Button', 'Card', 'DataTable', 'Field', 'FormGrid', 'Inline', 'Option', 'Select', 'Stack', 'StatusLine', 'Text'];
  const Component = new Function('React', 'accountLabel', 'useState', 'useRef', 'useMemo', 'useEffect', 'useLayoutEffect', ...names, discoveryCode + ';return AdCampaignDiscovery;')(React, row => 'Connection ' + row._id, state, ref, memo, effect, effect, ...names.map(name => designSystem[name]));
  const nodes = node => !React.isValidElement(node) ? [] : [node, ...[node.props.actions, node.props.children].flatMap(value => React.Children.toArray(value)).flatMap(nodes)];
  function paint() { if (unmounted) return; for (let pass = 0; dirty; pass++) { assert.ok(pass < 25); dirty = false; cursor = 0; tree = Component({ request }); while (queued.length) queued.shift()(); } }
  const tick = async () => { for (let turn = 0; turn < 3; turn++) { await new Promise(resolve => setImmediate(resolve)); paint(); } };
  const button = label => nodes(tree).find(node => node.type === designSystem.Button && detailText(node) === label);
  const click = label => { const node = button(label); assert.ok(node, label); assert.equal(!!node.props.disabled, false, label); const promise = node.props.onClick(); paint(); return promise; };
  const change = async (label, value) => { const field = nodes(tree).find(node => node.type === designSystem.Field && node.props.label === label), select = nodes(field).find(node => node.type === designSystem.Select); assert.ok(select, label); select.props.onChange({ target: { value } }); paint(); await tick(); };
  paint(); await tick();
  return { calls, click, button, change, tick, html: () => renderToStaticMarkup(tree), unmount() { hooks.forEach(hook => hook.close?.()); unmounted = true; } };
}
async function openDiscovery(ui) { await ui.click('Load Meta connections'); await ui.tick(); await ui.change('Meta connection', 'meta/a'); await ui.change('Meta advertiser', 'act_123'); }

test('actual Meta discovery controls use explicit connection/advertiser reads and display zero-ad rows without mutation controls', async () => {
  const ui = await discoveryUi(); assert.equal(ui.calls.length, 0); await openDiscovery(ui); assert.doesNotMatch(ui.html(), /value="google"/); await ui.click('Discover campaigns'); await ui.tick();
  for (const name of ['accountId', 'adAccountId']) assert.match(ui.html(), new RegExp('<select[^>]*name="' + name + '"[^>]*autocomplete="off"', 'i'));
  assert.match(ui.html(), /<p[^>]*role="status"[^>]*><span>Connection meta\/a.*1 campaign returned<\/span><\/p>/); assert.doesNotMatch(ui.html(), /<table[^>]*(?:role="status"|aria-live=)/);
  assert.equal(ui.calls.at(-1), 'ads/campaign-discovery?accountId=meta%2Fa&adAccountId=act_123'); assert.match(ui.html(), /&lt;b&gt;Empty campaign&lt;\/b&gt;/); assert.match(ui.html(), /empty-campaign/); assert.match(ui.html(), /<td>0<\/td>/); assert.match(ui.html(), /read-only/); assert.match(ui.html(), /last stored.*not a live/); assert.doesNotMatch(ui.html(), /Manage ads|Pause|Activate|Enable|budget|<b>/);
  const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'); assert.match(main, /connected && <AdCampaignDiscovery key=\{state.projectId\} request=\{integrate\}/); assert.match(main, /<AdsManager [^\n]*>\{connected && <AdCampaignDiscovery /, 'Discovery sits inside the ads manager.');
});

test('discovery distinguishes verified empty from unavailable or malformed results and refresh withdraws earlier rows', async () => {
  for (const value of [new Error('Discovery unavailable'), discoveryResult('foreign'), discoveryResult('meta/a', 'foreign'), discoveryResult('meta/a', 'act_123', { complete: false }), discoveryResult('meta/a', 'act_123', { campaigns: [{ ...discoveryResult().campaigns[0], adCount: -1 }] }), discoveryResult('meta/a', 'act_123', { campaigns: [discoveryResult().campaigns[0], discoveryResult().campaigns[0]] })]) {
    let replacement = false; const ui = await discoveryUi(path => { if (!path.startsWith('ads/campaign-discovery?')) return; if (!replacement) return discoveryResult(); if (value instanceof Error) throw value; return value; }); await openDiscovery(ui); await ui.click('Discover campaigns'); await ui.tick(); replacement = true; await ui.click('Discover campaigns'); await ui.tick(); assert.match(ui.html(), /role="alert"/); assert.doesNotMatch(ui.html(), /Native ID empty-campaign|No campaigns returned/);
  }
  const empty = await discoveryUi(path => path.startsWith('ads/campaign-discovery?') ? discoveryResult('meta/a', 'act_123', { campaigns: [] }) : undefined); await openDiscovery(empty); await empty.click('Discover campaigns'); await empty.tick(); assert.match(empty.html(), /0 campaigns returned/); assert.match(empty.html(), /No campaigns returned for this advertiser/); assert.doesNotMatch(empty.html(), /role="alert"/);
});

test('account/advertiser A to B to A and refresh reject pending discovery responses and retained old callbacks', async () => {
  for (const field of ['Meta connection', 'Meta advertiser', 'refresh']) {
    const held = deferredStatus(); let waiting = true; const ui = await discoveryUi(path => path.startsWith('ads/campaign-discovery?') && waiting ? held.promise : undefined); await openDiscovery(ui); const old = ui.button('Discover campaigns').props.onClick, pending = ui.click('Discover campaigns');
    if (field === 'refresh') { await ui.click('Refresh advertisers'); await ui.tick(); await ui.change('Meta advertiser', 'act_123'); } else { await ui.change(field, field === 'Meta connection' ? 'meta/b' : 'act_456'); await ui.change(field, field === 'Meta connection' ? 'meta/a' : 'act_123'); if (field === 'Meta connection') await ui.change('Meta advertiser', 'act_123'); }
    const count = ui.calls.length; await old(); assert.equal(ui.calls.length, count, 'Retained discovery callbacks have no authority after scope replacement.'); held.resolve(discoveryResult('meta/a', 'act_123', { campaigns: [{ ...discoveryResult().campaigns[0], campaignName: 'STALE CAMPAIGN' }] })); await pending; await ui.tick(); assert.doesNotMatch(ui.html(), /STALE CAMPAIGN|Native ID empty-campaign/); waiting = false; await ui.click('Discover campaigns'); await ui.tick(); assert.match(ui.html(), /Native ID empty-campaign/);
  }
});

test('pending advertiser reads cannot replace another connection and unmounted discovery cannot update state', async () => {
  const held = deferredStatus(); let first = true; const ui = await discoveryUi(path => { if (first && path.startsWith('ads/accounts?accountId=meta%2Fa')) { first = false; return held.promise; } }); await ui.click('Load Meta connections'); await ui.tick(); await ui.change('Meta connection', 'meta/a'); await ui.change('Meta connection', 'meta/b'); held.resolve({ accounts: [{ id: 'foreign-old', name: 'STALE ADVERTISER' }] }); await ui.tick(); assert.doesNotMatch(ui.html(), /STALE ADVERTISER/); await ui.change('Meta advertiser', 'act_123'); await ui.click('Discover campaigns'); await ui.tick(); assert.match(ui.html(), /Connection meta\/b/);
  const closing = deferredStatus(), closed = await discoveryUi(path => path.startsWith('ads/campaign-discovery?') ? closing.promise : undefined); await openDiscovery(closed); const pending = closed.click('Discover campaigns'); closed.unmount(); closing.resolve(discoveryResult()); await pending; await closed.tick();
});
