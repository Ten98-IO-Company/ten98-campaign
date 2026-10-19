import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const composer = await readFile(new URL('../src/AdComposer.tsx', import.meta.url), 'utf8'), details = await readFile(new URL('../src/AdDetails.tsx', import.meta.url), 'utf8'), analytics = await readFile(new URL('../src/SocialAnalytics.tsx', import.meta.url), 'utf8');
const javascript = value => value.replaceAll('event: React.FormEvent<HTMLFormElement>', 'event').replace(/ as Record<string, string>/g, '').replace(/: Record<string, (?:string\[\]|string|any)>/g, '').replaceAll('(err as Error)', 'err').replaceAll(' as SubmitEvent | undefined', '');
class FormValues { constructor(values) { return Object.entries(values); } }
const lines = value => (value || '').split(/\r?\n/).map(item => item.trim()).filter(Boolean);
const form = { countries: 'ae, sa, AE', name: 'QA campaign', budgetAmount: '50', headline: 'Main headline', body: 'Ad description', linkUrl: 'https://brand.example.com/launch', additionalHeadlines: 'Second headline\nThird headline', additionalDescriptions: 'Second description', keywords: 'launch campaign', businessName: 'QA brand', landscape: 'https://cdn.example.com/landscape.jpg', square: 'https://cdn.example.com/square.jpg', logo: 'https://cdn.example.com/logo.jpg', headlines: 'First headline\nSecond headline\nThird headline', descriptions: 'First description\nSecond description', longHeadline: 'A longer launch headline', longHeadlines: 'A longer video headline', youtubeVideoIds: 'abcdefghijk', videoUrl: 'https://cdn.example.com/video.mp4', thumbnailUrl: 'https://cdn.example.com/thumb.jpg', imageUrl: 'https://cdn.example.com/image.jpg', callToAction: 'LEARN_MORE', organizationId: '123456', boardId: 'board-a', bidAmount: '2', pixelId: 'reddit-pixel', customEventType: 'PURCHASE', postId: 'published-reddit-post', cardHeadline0: 'First card', cardHeadline1: 'Second card', cardImage0: 'https://cdn.example.com/card-one.jpg', cardImage1: 'https://cdn.example.com/card-two.jpg' };
test('Reddit pixel lookup cannot replace a newer advertising account or closed composer', async () => {
  const source = stripTypeScriptTypes(composer.slice(composer.indexOf('async function loadPixels('), composer.indexOf('  async function submit(')));
  let finish; const mounted = { current: true }; const accepted = [], calls = [], pixelRead = { current: 0 };
  const context = { accountId: 'reddit /a', adAccountId: 'native /a', platform: 'reddit', pixelBusy: false, pixelRead, pixelScope: 'account-a', currentPixelScope: { current: 'account-a' }, mounted, setPixelBusy() {}, setPixelError() {}, setPixels: value => accepted.push(value), setPixelsLoaded() {}, requester: { current: path => { calls.push(path); return new Promise(resolve => { finish = resolve; }); } } };
  const load = new Function(...Object.keys(context), `return (${source});`)(...Object.values(context));
  const first = load(); pixelRead.current++; finish({ tags: [{ id: 'old-account' }] }); await first; assert.deepEqual(accepted, []);
  const second = load(); mounted.current = false; finish({ tags: [{ id: 'closed-view' }] }); await second; assert.deepEqual(accepted, []);
  mounted.current = true; const third = load(); finish({ tags: [{ id: 'scoped-pixel' }] }); await third; assert.deepEqual(accepted, [[{ id: 'scoped-pixel' }]]);
  assert.equal(calls[0], 'measurement/reddit%20%2Fa/tags?adAccountId=native%20%2Fa');
});
const submitSource = javascript(composer.slice(composer.indexOf('async function submit('), composer.indexOf('  return <form')));
async function createAd(changes = {}, values = {}, expectedError = '') {
  const calls = [], errors = [], saved = [];
  const context = { busy: false, budgetType: 'daily', bidding: 'automatic', setValidation() {}, isCurrent: () => true, FormData: FormValues, setError: error => errors.push(error), connection: { platform: 'googleads' }, adAccount: { id: 'native-account' }, currency: 'AED', accountId: 'connection-a', adAccountId: 'native-account', platform: 'google', boosting: false, assets: false, format: 'search', goal: 'traffic', video: false, carousel: false, cards: 2, lines, setBusy: () => {}, requester: { current: async (path, payload) => calls.push({ path, payload }) }, onCreated: () => saved.push(true), ...changes };
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
  const current = composer.match(/const isCurrent = (.+);/)[1];
  for (const stale of ['unmounted', 'changed-identity', 'project-abort']) {
    const mounted = { current: false }, identity = 'original-ad', currentIdentity = { current: identity }, busy = [], errors = [];
    const unmount = compile(lifecycle, { mounted })(), isCurrent = compile(current, { mounted, identity, currentIdentity });
    let finish, fail, modal = 'ad';
    const context = { busy: false, budgetType: 'daily', bidding: 'automatic', setValidation() {}, isCurrent, FormData: FormValues, setError: error => errors.push(error), connection: { platform: 'googleads' }, adAccount: { id: 'native-account' }, currency: 'AED', accountId: 'connection-a', adAccountId: 'native-account', platform: 'google', boosting: false, assets: false, format: 'search', goal: 'traffic', video: false, carousel: false, cards: 2, lines, setBusy: value => busy.push(value), requester: { current: () => new Promise((resolve, reject) => { finish = resolve; fail = reject; }) }, onCreated: () => { modal = null; } };
    const pending = compile(submitSource, context)({ preventDefault() {}, currentTarget: form });
    if (stale === 'unmounted') unmount();
    if (stale === 'changed-identity') currentIdentity.current = 'different-ad';
    modal = 'unsaved-asset-draft';
    if (stale === 'project-abort') fail(new DOMException('Project changed.', 'AbortError')); else finish({});
    await pending;
    assert.equal(modal, 'unsaved-asset-draft'); assert.deepEqual(errors, ['']);
    assert.deepEqual(busy, stale === 'project-abort' ? [true, false] : [true]);
  }
});

test('Display editing forwards replacement creative fields and unchanged or stale forms do not submit another write', async () => {
  const handler = javascript(details.slice(details.indexOf('async function edit('), details.indexOf('  async function editSet('))), calls = [], errors = [];
  const base = { FormData: FormValues, busy: false, needsRefresh: false, live: { _id: 'display-ad', name: 'Existing ad' }, platform: 'google', channel: 'display', creative: {}, lines, copy: value => (value || []).join('\n'), setError: error => errors.push(error), act: async action => action(), scopedRequest: async (path, payload) => calls.push({ path, payload }), readAd: async () => {} };
  async function edit(values, extra = {}) { const context = { ...base, ...extra }; await new Function(...Object.keys(context), `return (${handler});`)(...Object.values(context))({ preventDefault() {}, currentTarget: values }); }
  await edit({ longHeadline: 'New long headline', businessName: 'New brand', imageUrl: 'https://cdn.example.com/new.jpg', squareImageUrl: 'https://cdn.example.com/new-square.jpg' });
  assert.deepEqual(calls[0], { path: 'ads/edit', payload: { adId: 'display-ad', creative: { longHeadline: 'New long headline', businessName: 'New brand', imageUrl: 'https://cdn.example.com/new.jpg', squareImageUrl: 'https://cdn.example.com/new-square.jpg' } } });
  await edit({}); assert.equal(calls.length, 1); assert.equal(errors.at(-1), 'Choose at least one field to change.');
  await edit({ longHeadline: 'Another change' }, { needsRefresh: true }); assert.equal(calls.length, 1);
  await edit({ name: 'Unsupported rename' }, { platform: 'tiktok', channel: '' }); assert.equal(calls.length, 1);
});

test('RSA editing submits the reviewed full URL list and blocks missing, expired or unreadable creative reviews', async () => {
  const renderCopy = new Function(`return ${stripTypeScriptTypes('(' + details.match(/const copy = (.+);/)[1] + ')')};`)();
  const pins = new Function('creative', `return ${stripTypeScriptTypes('(' + details.match(/const pinnedText = (.+);/)[1] + ')')};`);
  assert.equal(renderCopy({ unexpected: 'stored data' }), ''); assert.equal(renderCopy([null, { text: {} }, 'https://brand.example/two']), '\n\nhttps://brand.example/two');
  assert.deepEqual(pins({ headlines: null, descriptions: [{ text: 'Unverified pin', pinnedField: {} }, null] }), []);
  const handler = javascript(details.slice(details.indexOf('async function edit('), details.indexOf('  async function editSet('))), calls = [], errors = [];
  const creative = { headlines: [{ text: 'Pinned first', pinnedField: 'HEADLINE_1' }, { text: 'Second' }, { text: 'Third' }], descriptions: [{ text: 'First description' }, { text: 'Second description' }], finalUrls: ['https://brand.example/one', 'https://brand.example/two'] };
  const base = { FormData: FormValues, busy: false, needsRefresh: false, live: { _id: 'search-ad' }, selected: { creativeReview: { version: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString() } }, platform: 'google', channel: 'search', creative, lines, copy: value => (value || []).map(row => typeof row === 'string' ? row : row.text).join('\n'), setError: error => errors.push(error), act: async action => action(), scopedRequest: async (path, payload) => calls.push({ path, payload }), readAd: async () => {} };
  async function edit(values, extra = {}) { const context = { ...base, ...extra }; await new Function(...Object.keys(context), `return (${handler});`)(...Object.values(context))({ preventDefault() {}, currentTarget: values }); }
  await edit({ finalUrls: 'https://brand.example/new\nhttps://brand.example/two' });
  assert.deepEqual(calls[0], { path: 'ads/edit', payload: { adId: 'search-ad', finalUrls: ['https://brand.example/new', 'https://brand.example/two'], expectedCreativeVersion: 'a'.repeat(64) } });
  for (const selected of [null, { creativeReview: null }, { creativeReview: { version: 'a'.repeat(64), expiresAt: new Date(Date.now() - 1000).toISOString() } }, { creativeReview: { version: 'a'.repeat(64), expiresAt: 'unreadable' } }]) {
    await edit({ headlines: 'Pinned first\nChanged second\nThird' }, { selected });
    assert.match(errors.at(-1), /Refresh ad details/); assert.equal(calls.length, 1);
  }
  await edit({ countries: 'AE' }, { selected: null });
  assert.deepEqual(calls.at(-1).payload, { adId: 'search-ad', targeting: { countries: ['AE'] } }, 'Unrelated audience settings do not require RSA creative enrichment.');
});

test('a failed readback after a confirmed ad write requires refresh without claiming the write failed', async () => {
  const helper = stripTypeScriptTypes(details.slice(details.indexOf('async function readAd('), details.indexOf('  async function edit(')));
  const refreshStates = [], selections = [], errors = [], revisions = [];
  const context = { isCurrent: () => true, setNeedsRefresh: value => refreshStates.push(value), setSelected: value => selections.push(value), setReadVersion: update => revisions.push(update(2)), setError: error => errors.push(error), requester: { current: async () => { throw new Error('Read timed out.'); } }, scopedRequest: (...args) => context.requester.current(...args) };
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
    const act = compile(actionSource, { isCurrent, setBusy() {}, setError: value => errors.push(value), setNotice: value => notices.push(value), onChanged: () => changes.push(true) });
    const work = act(() => readAd('ad-a', true), 'Changes saved');
    if (stale === 'unmounted') mounted = false;
    if (stale === 'changed-identity') identity = 'campaign-b';
    reject(new DOMException('Project changed.', 'AbortError')); await work;
    assert.deepEqual(changes, []); assert.deepEqual(selections, []); assert.deepEqual(notices, ['']); assert.deepEqual(errors, ['']);
    if (stale !== 'project-abort') { await assert.rejects(scopedRequest('ads/ad-status', {}), { name: 'AbortError' }); assert.equal(requests.length, 1, 'A stale continuation must not send another provider request.'); }
  }
});

test('analytics date validation and failed refresh preserve the last successful report', async () => {
  const handler = javascript(analytics.slice(analytics.indexOf('async function load('), analytics.indexOf('  return <section'))), errors = [], reports = [], requests = [];
  const base = { busy: false, connected: true, from: '2030-01-01', to: '2030-01-31', setError: error => errors.push(error), setBusy: () => {}, request: async path => { requests.push(path); return { totals: { impressions: 0 }, daily: [] }; }, setReport: value => reports.push(value) };
  async function load(extra = {}) { const context = { ...base, ...extra }; await new Function(...Object.keys(context), `return (${handler});`)(...Object.values(context))({ preventDefault() {} }); }
  await load(); assert.equal(reports.length, 1); assert.equal(reports[0].data.totals.impressions, 0); assert.match(requests[0], /fromDate=2030-01-01&toDate=2030-01-31/);
  await load({ from: '2030-02-01', to: '2030-01-01' }); assert.equal(requests.length, 1);
  await load({ request: async () => { throw new Error('Provider unavailable.'); } }); assert.equal(reports.length, 1); assert.equal(errors.at(-1), 'Provider unavailable.');
  await load({ from: '2030-01-01', to: '2031-01-02' }); assert.equal(requests.length, 1, '367 inclusive reporting days must fail before a provider request.');
  await load({ from: '2030-01-01', to: '2031-01-01' }); assert.equal(requests.length, 2, '366 inclusive reporting days are allowed.');
});
