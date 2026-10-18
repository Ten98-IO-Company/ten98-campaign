import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';

test('HTTP ads formats, native account dates, durable controls, published-copy boosts and scoped analytics work end to end', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ten98-ads-qa-')), distDir = join(directory, 'dist'); await mkdir(distDir); await writeFile(join(distDir, 'index.html'), '<!doctype html><title>Ads QA</title>');
  const origin = 'http://127.0.0.1:3000', app = createApp({ dataDir: directory, distDir, appUrl: origin, env: { ZERNIO_API_KEY: 'ads-http-fixture-key' } }), originalFetch = globalThis.fetch;
  const profileId = 'ads-http-profile', accounts = ['metaads', 'googleads', 'tiktokads', 'linkedinads', 'pinterestads', 'xads', 'openaiads', 'redditads', 'facebook', 'tiktok', 'reddit'].map(platform => ({ _id: platform, profileId, platform, isActive: true })), calls = [], writes = [];
  const campaign = { profileId, platform: 'facebook', platformCampaignId: 'managed-campaign', campaignName: 'Managed campaign', currency: 'USD', status: 'paused', budgetLevel: 'adset', adSets: [{ platformAdSetId: 'managed-set', adSetName: 'Managed set', budget: { amount: 20, type: 'daily' } }] };
  let ad = { _id: 'managed-ad', profileId, platform: 'facebook', platformCampaignId: 'managed-campaign', name: 'Managed ad', status: 'paused', configuredStatus: 'PAUSED', creative: {} };
  let ownerCookie, projectId, sequence = 0, adSetAcknowledged = true, renameAcknowledged = true, dashboardFailure = '', listFailure = '', scopeChanged = false, createAckFailure = {};
  const remotePost = { _id: 'partial-post', status: 'partial', platforms: [{ platform: 'facebook', accountId: 'facebook', status: 'published', platformPostId: 'published-copy' }, { platform: 'tiktok', accountId: 'tiktok', status: 'failed' }, { platform: 'reddit', accountId: 'reddit', status: 'published', platformPostId: 't3_abc123' }] };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.headers.Authorization, 'Bearer ads-http-fixture-key');
    const method = options.method || 'GET', payload = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, method, payload }); let result;
    if (method !== 'GET') writes.push({ url, method, payload });
    if (url.pathname === '/api/v1/accounts') result = { accounts };
    else if (url.pathname === '/api/v1/ads/accounts') { assert.ok(accounts.some(account => account._id === url.searchParams.get('accountId'))); result = { accounts: [{ id: 'native-account', currency: 'USD', selectable: true }] }; }
    else if (url.pathname === '/api/v1/ads/create' || url.pathname === '/api/v1/ads/boost') {
      assert.equal(payload.status, 'PAUSED'); assert.ok(payload.budgetType === 'daily' || payload.accountId === 'redditads' && payload.budgetType === 'lifetime'); assert.ok(options.headers['Idempotency-Key']);
      result = { ad: { _id: `created-ad-${++sequence}`, platformCampaignId: `created-campaign-${sequence}`, platform: payload.accountId === 'metaads' ? 'facebook' : payload.accountId === 'xads' ? 'twitter' : payload.accountId.replace(/ads$/, ''), status: 'paused', ...createAckFailure } };
      if (scopeChanged) app.db.prepare('UPDATE projects SET zernio_profile_id=? WHERE id=?').run('other-profile', projectId);
    } else if (url.pathname === '/api/v1/ads/tree') result = { campaigns: [campaign], pagination: { pages: 1 } };
    else if (url.pathname === '/api/v1/ads') result = { ads: [ad, { ...ad, _id: 'same-profile-other-campaign', platformCampaignId: 'different-campaign' }, { ...ad, _id: 'same-profile-other-network', platform: 'google' }, { ...ad, _id: 'foreign-profile-ad', profileId: 'private-other-profile' }], pagination: { pages: 1 } };
    else if (url.pathname === '/api/v1/ads/managed-ad' && method === 'GET') result = { ad, statusReadAt: '2026-10-18T12:00:00Z' };
    else if (url.pathname === '/api/v1/ads/managed-ad' && method === 'PUT') { ad = { ...ad, ...payload }; result = { ad }; }
    else if (url.pathname === '/api/v1/ads/managed-ad/status') { ad.configuredStatus = payload.status.toUpperCase(); result = { updated: 1, skipped: 0, configuredStatus: ad.configuredStatus, status: 'paused' }; }
    else if (url.pathname === '/api/v1/ads/campaigns/managed-campaign/status') result = { updated: 1, skipped: 0, status: payload.status, platformCampaignStatus: payload.status.toUpperCase(), statusReadAt: '2026-10-18T12:00:00Z' };
    else if (url.pathname === '/api/v1/ads/ad-sets/managed-set') {
      if (renameAcknowledged && payload.name) campaign.adSets[0].adSetName = payload.name;
      if (adSetAcknowledged && payload.budget) campaign.adSets[0].budget = payload.budget;
      result = { ...(adSetAcknowledged ? { budget: payload.budget } : {}) };
    } else if (url.pathname === '/api/v1/ads/campaigns/managed-campaign') { if (payload.name) campaign.campaignName = payload.name; result = { updated: 1, ...payload }; }
    else if (url.pathname === '/api/v1/posts/partial-post') result = { post: remotePost };
    else if (url.pathname === '/api/v1/ads/targeting/search') result = { results: [{ id: 'interest-1', name: 'Design', type: 'interest' }] };
    else if (url.pathname === '/api/v1/analytics/dashboard') {
      const fromDate = url.searchParams.get('fromDate'), toDate = url.searchParams.get('toDate'); assert.equal(url.searchParams.get('profileId'), profileId);
      result = { dateRange: { fromDate, toDate }, totals: { impressions: 0, reach: null, engagementRate: 0 }, followers: { current: 100, gained: -2, byAccount: [{ accountId: 'facebook', platform: 'facebook', current: 100, gained: -2 }] }, daily: [{ date: fromDate, impressions: 0 }], topPosts: [{ postId: 'report-post', platform: 'facebook', publishedAt: `${fromDate}T12:00:00Z`, metrics: { impressions: null, likes: 0 } }], recentPosts: [], dataAsOf: null };
      if (dashboardFailure === 'scope') result.followers.byAccount[0].accountId = 'foreign-account';
      if (dashboardFailure === 'metrics') result.totals.impressions = 'not-a-number';
      if (dashboardFailure === 'rows') result.topPosts = {};
      if (dashboardFailure === 'window') result.daily[0].date = '1900-01-01';
      if (dashboardFailure === 'duplicate') result.daily.push(result.daily[0]);
    } else if (url.pathname === '/api/v1/analytics') {
      assert.equal(url.searchParams.get('profileId'), profileId);
      result = { posts: [{ _id: 'report-post', profileId, analytics: { impressions: null, likes: 0 }, platforms: [{ accountId: 'facebook', platform: 'facebook' }] }], accounts: [accounts.find(account => account._id === 'facebook')], pagination: { pages: 1, page: 1 }, hasAnalyticsAccess: true };
      if (listFailure === 'profile') result.posts[0].profileId = 'foreign-profile';
      if (listFailure === 'account') result.posts[0].platforms[0].accountId = 'foreign-account';
      if (listFailure === 'shape') result.posts[0].platforms = [null];
    } else if (url.pathname === '/api/v1/analytics/daily-metrics') {
      assert.equal(url.searchParams.get('profileId'), profileId); assert.equal(url.searchParams.get('attribution'), 'received');
      result = { dailyData: [{ date: url.searchParams.get('fromDate'), postCount: 1, metrics: { impressions: 0, reach: null } }], platformBreakdown: [{ platform: 'facebook', impressions: 0 }] };
    } else throw new Error(`Unexpected fixture provider request ${method} ${url.pathname}`);
    return new Response(JSON.stringify(result), { status: 200 });
  };
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, { body, method = body === undefined ? 'GET' : 'POST', cookie = ownerCookie, key } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    const setup = await request('/api/auth/setup', { body: { name: 'Ads QA', email: 'ads-qa@example.test', password: 'a long local ads fixture password', sample: false } }); assert.equal(setup.status, 201); ownerCookie = setup.cookie;
    const state = (await request('/api/state')).data; projectId = state.projectId; const project = `/api/projects/${projectId}`, route = `${project}/integrations`;
    assert.equal((await request(project, { method: 'PATCH', body: { zernioProfileId: profileId } })).status, 200);
    const image = 'https://cdn.example.test/advert.jpg', video = { url: 'https://cdn.example.test/advert.mp4' }, linkUrl = 'https://example.test/launch';
    const basic = { name: 'QA campaign', goal: 'traffic', budgetAmount: 25, countries: ['AE'], headline: 'Launch campaign', body: 'Discover the collection.', linkUrl };
    const connection = platform => ({ ...basic, platform, accountId: platform === 'facebook' || platform === 'instagram' ? 'metaads' : platform === 'twitter' ? 'xads' : `${platform}ads`, adAccountId: 'native-account', ...(platform === 'reddit' ? { promotedObject: { pixelId: 'reddit-pixel' } } : {}) });
    const meta = { ...connection('facebook'), imageUrl: image, callToAction: 'LEARN_MORE' }, cards = [{ imageUrl: image, headline: 'First card' }, { imageUrl: 'https://cdn.example.test/card-two.jpg', headline: 'Second card' }];
    const { imageUrl: unusedImage, ...metaWithoutImage } = meta;
    const group = { finalUrl: linkUrl, businessName: 'QA Campaign', headlines: ['Launch the campaign', 'Explore the collection', 'Designed for every day'], descriptions: ['Discover our collection.', 'Find your favorite item.'], longHeadline: 'Explore the newest collection, designed for everyday life.', images: { landscape: [image], square: [image], logo: [image] } };
    const googleBase = { platform: 'google', accountId: 'googleads', adAccountId: 'native-account', name: 'Google QA', budgetAmount: 25, countries: ['AE'] };
    const demand = { finalUrl: linkUrl, businessName: 'QA Campaign', headlines: ['Discover the launch'], descriptions: ['Explore the collection.'], images: { square: [image], logo: [image] } };
    const formats = [meta, { ...metaWithoutImage, video }, { ...metaWithoutImage, carouselCards: cards }, { ...connection('instagram'), imageUrl: image, callToAction: 'LEARN_MORE' }, { ...connection('google'), campaignType: 'search', additionalHeadlines: ['Browse new arrivals', 'Shop the collection'], additionalDescriptions: ['Explore the newest collection.'], keywords: ['new collection'] }, { ...connection('google'), campaignType: 'display', businessName: 'QA Campaign', images: { landscape: image, square: image } }, { ...googleBase, campaignType: 'pmax', assetGroup: group }, { ...googleBase, campaignType: 'demand_gen', demandGen: demand }, { ...googleBase, campaignType: 'demand_gen', demandGen: { ...demand, images: { logo: [image] }, longHeadlines: ['Explore the latest collection'], youtubeVideoIds: ['dQw4w9WgXcQ'] } }, { ...googleBase, campaignType: 'demand_gen', demandGen: { ...demand, images: { logo: [image] }, carouselCards: cards.map(card => ({ headline: card.headline, images: { square: card.imageUrl } })) } }, { ...connection('tiktok'), imageUrl: video.url }, { ...connection('linkedin'), imageUrl: image }, { ...connection('linkedin'), video, goal: 'video_views', organizationId: 'urn:li:organization:123' }, { ...connection('pinterest'), imageUrl: image }, { ...connection('twitter'), imageUrl: image }, { ...connection('openai'), imageUrl: image }, { ...connection('reddit'), imageUrl: image }, { ...connection('reddit'), video: { ...video, thumbnailUrl: image } }, { ...connection('reddit'), carouselCards: cards }, { ...connection('reddit'), creativeFormat: 'text' }];
    delete formats.at(-1).linkUrl;
    for (const [index, body] of formats.entries()) { const result = await request(route + '/ads/create', { body, key: `format-http-${index}` }); assert.equal(result.status, 200, `${body.platform}/${body.campaignType || 'native'}: ${JSON.stringify(result.data)}`); assert.equal(result.data.campaign.status, 'paused'); }
    for (const goal of ['traffic', 'awareness', 'video_views', 'conversions', 'lead_generation']) {
      const reddit = { ...connection('reddit'), goal, video: { ...video, thumbnailUrl: image }, promotedObject: { pixelId: 'reddit-pixel', ...(goal === 'conversions' ? { customEventType: 'purchase' } : {}) } };
      let result = await request(route + '/ads/create', { body: reddit, key: `reddit-${goal}-create` }); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(writes.at(-1).payload.promotedObject.pixelId, 'reddit-pixel');
      if (goal === 'lead_generation') { assert.equal(writes.at(-1).payload.promotedObject.customEventType, 'LEAD'); assert.equal(writes.at(-1).payload.linkUrl, linkUrl); assert.equal(writes.at(-1).payload.leadGenFormId, undefined); }
      if (goal === 'conversions') assert.equal(writes.at(-1).payload.promotedObject.customEventType, 'PURCHASE');
      const before = writes.length; result = await request(route + '/ads/create', { body: { ...reddit, promotedObject: undefined }, key: `reddit-${goal}-missing-pixel` }); assert.equal(result.status, 400); assert.equal(result.data.error.code, 'REDDIT_PIXEL_REQUIRED'); assert.equal(writes.length, before);
      result = await request(route + '/ads/validate', { body: { ...reddit, promotedObject: undefined } }); assert.equal(result.status, 400); assert.equal(writes.length, before);
    }
    const redditImage = { ...connection('reddit'), imageUrl: image, body: '', callToAction: 'INSTALL_MOBILE_APP' };
    assert.equal((await request(route + '/ads/create', { body: redditImage, key: 'reddit-optional-body' })).status, 200); assert.equal(writes.at(-1).payload.body, undefined);
    const lifetime = { ...redditImage, budgetType: 'lifetime', endDate: '2070-01-04T00:00:00Z' };
    const lifetimeResult = await request(route + '/ads/create', { body: lifetime, key: 'reddit-lifetime' }); assert.equal(lifetimeResult.status, 200); assert.equal(lifetimeResult.data.campaign.budgetType, 'lifetime');
    const redditInvalidWrites = writes.length;
    for (const [index, invalid] of [{ ...lifetime, endDate: undefined }, { ...redditImage, goal: 'lead_generation', leadGenFormId: 'retired-form' }, { ...redditImage, goal: 'conversions' }, { ...redditImage, goal: 'conversions', promotedObject: { pixelId: 'reddit-pixel', customEventType: 'UNSUPPORTED' } }, { ...redditImage, imageUrl: undefined, creativeFormat: 'text', goal: 'lead_generation', linkUrl: undefined, callToAction: undefined, body: 'Website lead text' }].entries()) assert.equal((await request(route + '/ads/create', { body: invalid, key: `reddit-invalid-${index}` })).status, 400);
    assert.equal(writes.length, redditInvalidWrites);
    const beforeReplay = writes.length; await request(route + '/ads/create', { body: formats[0], key: 'format-http-0' }); assert.equal(writes.length, beforeReplay);
    let result = await request(route + '/ads/create', { body: { ...formats[4], startDate: '2070-01-02T00:15:00+04:00', endDate: '2070-01-02T00:15:00+04:00' }, key: 'google-one-day-campaign' }); assert.equal(result.status, 200); assert.equal(writes.at(-1).payload.startDate.slice(0, 10), '2070-01-02'); assert.equal(writes.at(-1).payload.endDate.slice(0, 10), '2070-01-02');
    const beforeInvalid = writes.length; result = await request(route + '/ads/create', { body: { ...meta, startDate: '2070-01-02T10:00:00Z', endDate: '2070-01-02T10:00:00Z' }, key: 'reject-zero-length-meta' }); assert.equal(result.status, 400); assert.equal(writes.length, beforeInvalid);
    result = await request(route + '/ads/items?campaignId=managed-campaign&platform=facebook'); assert.equal(result.status, 200); assert.deepEqual(result.data.ads.map(row => row._id), ['managed-ad']);
    assert.equal((await request(route + '/ads/details?adId=managed-ad')).status, 200);
    for (const platform of ['tiktok', 'reddit']) { ad.platform = platform; const before = writes.length; result = await request(route + '/ads/edit', { body: { adId: ad._id, name: 'Unsupported rename' }, key: `reject-${platform}-rename` }); assert.equal(result.status, 422); assert.equal(writes.length, before); } ad.platform = 'facebook';
    ad.platform = 'tiktok'; ad.isSmartPlus = true; const beforeSmartPlus = writes.length; result = await request(route + '/ads/edit', { body: { adId: ad._id, creative: { body: 'Unsupported Smart+ creative edit' } }, key: 'reject-smart-plus-creative' }); assert.equal(result.status, 422); assert.equal(writes.length, beforeSmartPlus); ad.platform = 'facebook'; delete ad.isSmartPlus;
    result = await request(route + '/ads/edit', { body: { adId: ad._id, name: 'Renamed Meta ad', creative: { body: 'Changed campaign copy' } }, key: 'edit-http-meta-copy' }); assert.equal(result.status, 200);
    assert.equal((await request(route + '/ads/ad-status', { body: { adId: ad._id, status: 'active' }, key: 'enable-http-ad' })).status, 200);
    assert.equal((await request(route + '/ads/status', { body: { campaignId: campaign.platformCampaignId, platform: 'facebook', status: 'active' }, key: 'enable-http-campaign' })).status, 200);
    result = await request(route + '/ads/adset', { body: { campaignId: campaign.platformCampaignId, platform: 'facebook', adSetId: 'managed-set', name: 'Renamed set', budget: { amount: 30, type: 'daily' } }, key: 'edit-http-adset' }); assert.equal(result.status, 200); assert.equal(campaign.adSets[0].adSetName, 'Renamed set');
    adSetAcknowledged = false; const badBudget = { campaignId: campaign.platformCampaignId, platform: 'facebook', adSetId: 'managed-set', budget: { amount: 31, type: 'daily' } }; result = await request(route + '/ads/adset', { body: badBudget, key: 'unconfirmed-http-adset-budget' }); assert.equal(result.data.operation.status, 'uncertain'); const uncertainWrites = writes.length; result = await request(route + '/ads/adset', { body: badBudget, key: 'same-budget-fresh-key' }); assert.equal(result.status, 409); assert.equal(writes.length, uncertainWrites); adSetAcknowledged = true;
    renameAcknowledged = false; result = await request(route + '/ads/adset', { body: { campaignId: campaign.platformCampaignId, platform: 'facebook', adSetId: 'managed-set', name: 'Not actually renamed' }, key: 'unconfirmed-http-adset-name' }); assert.equal(result.data.operation.status, 'uncertain'); renameAcknowledged = true;
    const localPost = app.store.create(projectId, 'posts', { content: 'Partially published launch', status: 'partial', externalId: 'partial-post', zernioProfileId: profileId, platforms: ['facebook', 'tiktok'] });
    const boost = { platform: 'facebook', accountId: 'facebook', adAccountId: 'native-account', name: 'Boost published Facebook copy', goal: 'engagement', budgetAmount: 25, countries: ['AE'], postId: localPost.id };
    result = await request(route + '/ads/boost', { body: boost, key: 'boost-successful-partial-copy' }); assert.equal(result.status, 200);
    const redditBoost = { ...boost, platform: 'reddit', accountId: 'redditads', goal: 'traffic', promotedObject: { pixelId: 'reddit-pixel' } };
    for (const goal of ['traffic', 'awareness', 'video_views', 'conversions', 'lead_generation']) {
      const body = { ...redditBoost, goal, linkUrl, promotedObject: { pixelId: 'reddit-pixel', ...(goal === 'conversions' ? { customEventType: 'PURCHASE' } : {}) } };
      result = await request(route + '/ads/boost', { body, key: `reddit-${goal}-boost` }); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(writes.at(-1).payload.postId, 'partial-post'); assert.deepEqual(writes.at(-1).payload.targeting.countries, ['AE']); assert.equal(writes.at(-1).payload.promotedObject.pixelId, 'reddit-pixel');
      const before = writes.length; result = await request(route + '/ads/boost', { body: { ...body, promotedObject: undefined }, key: `reddit-${goal}-boost-no-pixel` }); assert.equal(result.status, 400); assert.equal(writes.length, before);
    }
    result = await request(route + '/ads/boost', { body: { ...redditBoost, budgetType: 'lifetime', endDate: '2070-01-04T00:00:00Z' }, key: 'reddit-lifetime-boost' }); assert.equal(result.status, 200); assert.equal(result.data.campaign.budgetType, 'lifetime');
    const redditBoostWrites = writes.length; remotePost.platforms[2].accountId = 'foreign-reddit-account'; result = await request(route + '/ads/boost', { body: redditBoost, key: 'reddit-foreign-organic-copy' }); assert.equal(result.status, 403); assert.equal(writes.length, redditBoostWrites); remotePost.platforms[2].accountId = 'reddit';
    const beforeRedditReplay = writes.length; assert.equal((await request(route + '/ads/boost', { body: { ...redditBoost, goal: 'traffic', linkUrl }, key: 'reddit-traffic-boost' })).status, 200); assert.equal(writes.length, beforeRedditReplay);
    const badAcknowledgements = [{ platform: undefined }, { platform: null }, { platform: 'unknown-network' }, { platform: 'google' }, { profileId: 'foreign-profile' }, { accountId: 'foreign-connection' }, { platformAdAccountId: 'foreign-native-account' }, { _id: '' }, { platformCampaignId: 123 }];
    for (const [index, failure] of badAcknowledgements.entries()) {
      createAckFailure = failure;
      for (const action of ['create', 'boost']) {
        const body = { ...(action === 'create' ? meta : boost), name: `Malformed ${action} acknowledgement ${index}` }, before = app.store.list(projectId, 'campaigns').length;
        result = await request(route + '/ads/' + action, { body, key: `bad-${action}-ack-${index}` }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(app.store.list(projectId, 'campaigns').length, before);
        const afterFirst = writes.length; result = await request(route + '/ads/' + action, { body, key: `bad-${action}-ack-retry-${index}` }); assert.equal(result.status, 409); assert.equal(writes.length, afterFirst, 'A fresh action key cannot duplicate a creation whose acknowledgement is unsafe.');
      }
    }
    createAckFailure = {};
    for (const action of ['create', 'boost']) {
      createAckFailure = { platform: 'instagram', profileId: { _id: profileId }, accountId: { _id: action === 'create' ? 'metaads' : 'facebook' }, platformAdAccountId: 'native-account' };
      result = await request(route + '/ads/' + action, { body: { ...(action === 'create' ? meta : boost), name: `Validated Meta acknowledgement ${action}` }, key: `valid-meta-${action}-scope` }); assert.equal(result.status, 200); assert.equal(result.data.campaign.platform, 'instagram', 'The local campaign uses the provider’s validated Meta network, so its management controls can find it again.');
    }
    createAckFailure = {};
    remotePost.platforms[0].platform = 'instagram'; const beforeWrongBoost = writes.length; result = await request(route + '/ads/boost', { body: boost, key: 'reject-mismatched-boost-copy' }); assert.equal(result.status, 403); assert.equal(writes.length, beforeWrongBoost); remotePost.platforms[0].platform = 'facebook';
    remotePost.platforms[1] = { platform: 'tiktok', accountId: 'tiktok', status: 'published', platformSpecificData: { isDraft: true } }; result = await request(route + '/ads/boost', { body: { ...boost, platform: 'tiktok', accountId: 'tiktok' }, key: 'reject-tiktok-draft-boost' }); assert.equal(result.status, 403); assert.equal(writes.length, beforeWrongBoost);
    const window = '?fromDate=2026-10-01&toDate=2026-10-02'; result = await request(route + '/analytics/dashboard' + window); assert.equal(result.status, 200); assert.equal(result.data.totals.impressions, 0); assert.equal(result.data.totals.reach, null); assert.equal(result.data.followers.gained, -2); assert.equal(result.data.topPosts[0].metrics.impressions, null);
    for (const failure of ['scope', 'metrics', 'rows', 'window', 'duplicate']) { dashboardFailure = failure; result = await request(route + '/analytics/dashboard' + window); assert.equal(result.status, 502, failure); assert.equal(result.data.totals, undefined); } dashboardFailure = '';
    result = await request(route + '/analytics/dashboard?fromDate=2025-01-01&toDate=2026-01-01'); assert.equal(result.status, 200); const beforeLongReport = calls.length; result = await request(route + '/analytics/dashboard?fromDate=2025-01-01&toDate=2026-01-02'); assert.equal(result.status, 400); assert.equal(calls.length, beforeLongReport);
    result = await request(route + '/analytics' + window); assert.equal(result.status, 200); assert.equal(result.data.complete, true); assert.equal(result.data.posts[0].analytics.impressions, null);
    for (const failure of ['profile', 'account', 'shape']) { listFailure = failure; result = await request(route + '/analytics' + window); assert.equal(result.status, 502); assert.equal(result.data.posts, undefined); } listFailure = '';
    result = await request(route + '/analytics/daily' + window); assert.equal(result.status, 200); assert.equal(result.data.dailyData[0].metrics.impressions, 0); assert.equal(result.data.dailyData[0].metrics.reach, null);
    assert.equal((await request(route + '/analytics/dashboard' + window, { cookie: null })).status, 401);
    scopeChanged = true; const beforeRemap = app.store.list(projectId, 'campaigns').length; result = await request(route + '/ads/create', { body: { ...meta, name: 'Connection changed during accepted creation' }, key: 'remapped-http-ad-create' }); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(app.store.list(projectId, 'campaigns').length, beforeRemap);
  } finally { globalThis.fetch = originalFetch; await app.close(); await rm(directory, { recursive: true, force: true }); }
});
