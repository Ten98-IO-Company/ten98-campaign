import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';
import { stripTypeScriptTypes } from 'node:module';

test('Google Ads tools use real HTTP routes, selected customer scope, durable keyword mutations, planner, negatives, targeting and bidding', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ten98-google-tools-')), origin = 'http://127.0.0.1:3000';
  const app = createApp({ dataDir: directory, appUrl: origin, env: { ZERNIO_API_KEY: 'google-tools-test-key' }, directScheduler: false });
  const originalFetch = globalThis.fetch, calls = [], writes = [], profileId = 'google-profile', accountId = 'google-connection', adAccountId = '1234567890';
  const campaign = { platformCampaignId: '12345', platform: 'google', profileId, accountId, platformAdAccountId: adAccountId, campaignName: 'Search fixture', advertisingChannelType: 'SEARCH', adSets: [{ platformAdSetId: '67890', adSetName: 'Products' }] };
  let rows = [{ id: 'first-keyword', platformCriterionId: '1', profileId, accountId, adAccountId, platform: 'google', campaignId: '12345', adSetId: '67890', keyword: 'campaign tools', matchType: 'exact', status: 'active', negative: false }, { id: 'second-keyword', platformCriterionId: '2', profileId, accountId, adAccountId, platform: 'google', campaignId: '12345', adSetId: '67890', keyword: 'free', matchType: 'phrase', status: 'active', negative: true }];
  let negativeRows = [{ criterionId: '55', text: 'jobs', matchType: 'broad' }], badKeywordScope = false, badAck = false, failBidReadback = false, bidWrite = false, portfolio = false;
  let bidSpec = { bidStrategy: 'LOWEST_COST_WITHOUT_CAP' }, cookie;
  const targets = { campaignId: '12345', devices: [{ device: 'MOBILE', included: true, bidModifier: 1 }, { device: 'DESKTOP', included: true, bidModifier: 1 }], locations: [{ geoTargetId: '2784', countryCode: 'AE', type: 'Country', name: 'United Arab Emirates', negative: false }], excludedLocations: [], languages: [{ code: 'en', name: 'English' }], locationTargetingType: 'presence', updated: [] };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.headers.Authorization, 'Bearer google-tools-test-key');
    const method = options.method || 'GET', payload = options.body ? JSON.parse(options.body) : undefined; calls.push({ url, method, payload });
    if (method !== 'GET' && !url.pathname.endsWith('/ideas') && !url.pathname.endsWith('/historical-metrics')) { writes.push({ url, method, payload }); assert.ok(options.headers['Idempotency-Key']); }
    let result;
    if (url.pathname === '/api/v1/accounts') result = { accounts: [{ _id: accountId, profileId, platform: 'googleads', isActive: true }, { _id: 'foreign', profileId: 'private-profile', platform: 'googleads' }] };
    else if (url.pathname === '/api/v1/ads/accounts') result = { accounts: [{ id: adAccountId, currency: 'USD', selectable: true }] };
    else if (url.pathname === '/api/v1/ads/tree') { assert.equal(url.searchParams.get('accountId'), accountId); assert.equal(url.searchParams.get('adAccountId'), adAccountId); result = { campaigns: [campaign, { ...campaign, accountId: 'other-connection', platformAdAccountId: '2222222222' }], pagination: { pages: 1 } }; }
    else if (url.pathname === '/api/v1/ads/keywords' && method === 'GET') {
      assert.equal(url.searchParams.get('profileId'), profileId); assert.equal(url.searchParams.get('adAccountId'), adAccountId);
      const page = Number(url.searchParams.get('page')); result = { keywords: rows.slice(page - 1, page).map(row => ({ ...row, ...(badKeywordScope ? { accountId: 'foreign' } : {}) })), pagination: { page, limit: 100, pages: rows.length, total: rows.length } };
    } else if (url.pathname === '/api/v1/ads/keywords' && method === 'POST') {
      assert.equal(payload.accountId, accountId); assert.equal(payload.adSetId, '67890');
      result = { keywords: payload.keywords.map((row, index) => ({ id: 'new-' + index, keyword: row.text, matchType: row.matchType, negative: payload.negative, adSetId: badAck ? 'foreign-group' : payload.adSetId })) };
    } else if (url.pathname.startsWith('/api/v1/ads/keywords/') && ['PATCH', 'DELETE'].includes(method)) {
      const keywordId = url.pathname.split('/').at(-1), row = rows.find(item => item.id === keywordId); assert.ok(row);
      if (method === 'PATCH') { row.status = payload.status; result = { keyword: { ...row, ...(badAck ? { status: 'different' } : {}) } }; }
      else { rows = rows.filter(item => item !== row); result = { removed: true, keywordId, adSetId: row.adSetId, campaignId: row.campaignId }; }
    } else if (url.pathname.endsWith('/negative-keywords')) {
      if (method === 'PUT') negativeRows = payload.keywords.map((row, index) => ({ criterionId: String(index), ...row }));
      result = { keywords: negativeRows, ...(method === 'GET' ? { cachedAt: '2026-10-18T00:00:00Z', stale: false } : { created: negativeRows.length, removed: 0 }) };
    } else if (url.pathname.endsWith('/search-terms')) {
      assert.equal(url.searchParams.get('adAccountId'), adAccountId); assert.equal(url.searchParams.get('fromDate'), '2026-09-01'); assert.equal(url.searchParams.get('toDate'), '2026-09-30');
      result = { customerId: adAccountId, data: [{ searchTerm: 'campaign manager', campaignId: '12345', adGroupId: '67890', clicks: 5, costMicros: 1500000 }], paging: { ...(url.searchParams.has('pageToken') ? {} : { nextPageToken: 'opaque-cursor' }) }, stale: false };
    } else if (url.pathname.endsWith('/ideas') || url.pathname.endsWith('/historical-metrics')) { assert.equal(payload.adAccountId, adAccountId); result = { customerId: adAccountId, data: [{ text: 'campaign software', keywordIdeaMetrics: { avgMonthlySearches: '1400', lowTopOfPageBidMicros: '1000000', highTopOfPageBidMicros: '3500000' } }] }; }
    else if (url.pathname.endsWith('/targeting')) { if (method === 'PUT') { targets.updated = badAck ? [] : Object.keys(payload.targeting); if (payload.targeting.languages) targets.languages = payload.targeting.languages.map(code => ({ code })); if (payload.targeting.locationTargetingType) targets.locationTargetingType = payload.targeting.locationTargetingType; } result = targets; }
    else if (url.pathname.endsWith('/bidding')) { if (failBidReadback && bidWrite) throw new Error('Read after accepted write failed.'); result = { campaignId: '12345', biddingStrategyType: 'MAXIMIZE_CONVERSIONS', bidSpec, ...(portfolio ? { portfolio: { id: 'shared-portfolio' } } : {}), stale: false }; }
    else if (url.pathname === '/api/v1/ads/campaigns/12345' && method === 'PUT') { bidWrite = true; bidSpec = { ...payload }; delete bidSpec.platform; result = { updated: 1, ...bidSpec }; }
    else throw new Error('Unexpected provider path: ' + method + ' ' + url.pathname);
    return new Response(JSON.stringify(result));
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, body, key = 'google-tool-' + calls.length) { const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': key }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] }; }
  try {
    const setup = await request('/api/auth/setup', { name: 'Google tools QA', email: 'google-tools@example.test', password: 'Google tools fixture password!', sample: false }); assert.equal(setup.status, 201); cookie = setup.cookie;
    const state = (await request('/api/state')).data, projectId = state.projectId;
    app.db.prepare('UPDATE projects SET zernio_profile_id=? WHERE id=?').run(profileId, projectId);
    const route = `/api/projects/${projectId}/integrations/ads/google/`, selection = { accountId, adAccountId, campaignId: '12345' }, query = new URLSearchParams(selection);
    let result = await request(route + 'campaigns?' + new URLSearchParams({ accountId, adAccountId })); assert.equal(result.status, 200); assert.equal(result.data.campaigns.length, 1);
    result = await request(route + 'keywords?' + query); assert.equal(result.status, 200); assert.equal(result.data.keywords[0].id, 'first-keyword');
    assert.equal((await request(route + 'keywords?' + new URLSearchParams({ ...selection, accountId: 'foreign' }))).status, 403);
    assert.equal((await request(route + 'keywords?' + new URLSearchParams({ ...selection, adAccountId: '2222222222' }))).status, 403);
    assert.equal((await request(route + 'keywords?' + new URLSearchParams({ ...selection, campaignId: 'outside' }))).status, 403);
    badKeywordScope = true; assert.equal((await request(route + 'keywords?' + query)).status, 502); badKeywordScope = false;
    const mutation = { ...selection, adSetId: '67890', confirmChange: true };
    const beforeWrites = writes.length; assert.equal((await request(route + 'keywords/add', { ...mutation, confirmChange: false, keywords: ['software'] })).status, 400); assert.equal(writes.length, beforeWrites);
    result = await request(route + 'keywords/add', { ...mutation, keywords: [{ text: 'software', matchType: 'phrase' }], negative: false }, 'add-google-keywords'); assert.equal(result.status, 200); assert.equal(writes.at(-1).payload.keywords[0].matchType, 'phrase');
    const added = writes.length; await request(route + 'keywords/add', { ...mutation, keywords: [{ text: 'software', matchType: 'phrase' }], negative: false }, 'add-google-keywords'); assert.equal(writes.length, added);
    assert.equal((await request(route + 'keyword/status', { ...mutation, keywordId: 'second-keyword', status: 'paused' })).status, 422);
    result = await request(route + 'keyword/status', { ...mutation, keywordId: 'first-keyword', status: 'paused' }); assert.equal(result.status, 200); assert.equal(result.data.result.keyword.status, 'paused');
    const removeBody = { ...mutation, keywordId: 'second-keyword' };
    result = await request(route + 'keyword/remove', removeBody, 'remove-second-page'); assert.equal(result.status, 200); assert.ok(calls.some(call => call.url.pathname === '/api/v1/ads/keywords' && call.url.searchParams.get('page') === '2'));
    const removed = writes.length; result = await request(route + 'keyword/remove', removeBody, 'remove-second-page'); assert.equal(result.status, 200); assert.equal(writes.length, removed);
    const negativeBody = { ...selection, keywords: [{ text: 'jobs', matchType: 'exact' }], confirmChange: true };
    assert.equal((await request(route + 'negatives?' + query)).data.keywords[0].text, 'jobs'); result = await request(route + 'negatives', negativeBody); assert.equal(result.status, 200); assert.equal(result.data.result.keywords[0].matchType, 'exact');
    result = await request(route + 'negatives', { ...negativeBody, keywords: [] }); assert.equal(result.status, 200); assert.deepEqual(result.data.result.keywords, []);
    const reportDates = { fromDate: '2026-09-01', toDate: '2026-09-30' };
    result = await request(route + 'search-terms?' + new URLSearchParams({ ...selection, ...reportDates })); assert.equal(result.status, 200); assert.equal(result.data.data[0].costMicros, 1500000);
    result = await request(route + 'search-terms?' + new URLSearchParams({ ...selection, ...reportDates, pageToken: result.data.paging.nextPageToken })); assert.equal(result.status, 200);
    assert.equal((await request(route + 'search-terms?' + new URLSearchParams({ ...selection, toDate: 'invalid' }))).status, 400);
    for (const mode of ['ideas', 'history']) { result = await request(route + 'planner', { accountId, adAccountId, mode, keywords: ['campaign'], countries: ['AE'], languageConstantId: '1000', network: 'GOOGLE_SEARCH' }); assert.equal(result.status, 200); assert.equal(result.data.data[0].keywordIdeaMetrics.avgMonthlySearches, '1400'); }
    assert.equal((await request(route + 'planner', { accountId, adAccountId, mode: 'ideas', keywords: Array(21).fill('same') })).status, 400);
    result = await request(route + 'targeting', { ...selection, targeting: { languages: ['ar'], locationTargetingType: 'presence' }, confirmChange: true }); assert.equal(result.status, 200); assert.equal(result.data.result.languages[0].code, 'ar');
    assert.equal((await request(route + 'targeting', { ...selection, targeting: { locations: [] }, confirmChange: true })).status, 400);
    assert.equal((await request(route + 'targeting', { ...selection, targeting: { locations: { countries: null } }, confirmChange: true })).status, 400);
    portfolio = true; const beforePortfolio = writes.length; result = await request(route + 'bidding', { ...selection, bidStrategy: 'COST_CAP', bidAmount: 10, confirmChange: true }); assert.equal(result.status, 409); assert.equal(writes.length, beforePortfolio); portfolio = false;
    result = await request(route + 'bidding', { ...selection, bidStrategy: 'COST_CAP', bidAmount: 10, confirmChange: true }); assert.equal(result.status, 200); assert.equal(result.data.result.bidSpec.bidAmount, 10);
    badAck = true; const uncertain = { ...mutation, keywords: ['unconfirmed-add'], negative: true }; result = await request(route + 'keywords/add', uncertain, 'bad-keyword-receipt'); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); const uncertainCount = writes.length;
    result = await request(route + 'keywords/add', uncertain, 'fresh-key-cannot-duplicate'); assert.equal(result.status, 409); assert.equal(writes.length, uncertainCount); badAck = false;
    failBidReadback = true; bidWrite = false; const failedReadback = { ...selection, bidStrategy: 'COST_CAP', bidAmount: 12, confirmChange: true }; result = await request(route + 'bidding', failedReadback, 'bad-bidding-readback'); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain');
    const readbackCount = writes.length; result = await request(route + 'bidding', failedReadback, 'fresh-bidding-key'); assert.equal(result.status, 409); assert.equal(writes.length, readbackCount);
  } finally { globalThis.fetch = originalFetch; await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test('actual Google UI formats match types, micros and stale selection guards without treating strings as whole currency', async () => {
  const source = await readFile(new URL('../src/GoogleAdsTools.tsx', import.meta.url), 'utf8');
  const compile = (code, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context));
  const matching = compile(source.match(/const matching = (.+);/)[1], {}), amount = compile(source.match(/const amount = (.+);/)[1], { number: value => String(value) });
  assert.deepEqual(matching('[campaign software]'), { text: 'campaign software', matchType: 'exact' }); assert.deepEqual(matching('"campaign software"'), { text: 'campaign software', matchType: 'phrase' });
  assert.equal(amount('1500000', 'USD'), '1.5 USD'); assert.equal(amount(null), '—');
  const writeSource = source.slice(source.indexOf('async function write('), source.indexOf('  const readKeywords'));
  const active = { current: true }, calls = []; let finish;
  const write = compile(writeSource, { active, requester: { current: (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); } }, base: { accountId: 'account-one', adAccountId: 'customer-one' } });
  const pending = write('keyword/status', { keywordId: 'first', status: 'paused' }); active.current = false; finish({ result: { confirmed: true } });
  await assert.rejects(pending, error => error.name === 'AbortError'); assert.equal(calls[0][1].confirmChange, true); assert.equal(calls[0][1].accountId, 'account-one');
  await assert.rejects(write('keyword/status', {}), error => error.name === 'AbortError'); assert.equal(calls.length, 1);
  assert.match(source, /\.\.\.termDates, pageToken: terms.paging.nextPageToken/);
});
