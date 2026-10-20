import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleIntegration } from '../server/integrations.mjs';

// Provider contracts: https://docs.zernio.com/ad-campaigns/boost-post and /api/openapi.
async function audit(run) {
  const db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, writes = [];
  const project = { id: 'audit-project', zernioProfileId: 'audit-profile' };
  const account = { _id: 'audit-account', profileId: project.zernioProfileId, platform: 'facebook' };
  const campaign = { profileId: project.zernioProfileId, platform: 'facebook', platformCampaignId: 'audit-campaign', currency: 'USD', budgetLevel: 'campaign', campaignBudget: { amount: 500, type: 'lifetime' }, adSets: [{ platformAdSetId: 'audit-set', adSetName: 'Lifetime set', adSetBudget: { amount: 500, type: 'lifetime' } }] };
  const post = { id: 'local-post', externalId: 'remote-post', zernioProfileId: project.zernioProfileId, status: 'published' };
  const store = { get: () => post, list: () => [], create: (_project, _collection, values) => ({ id: 'created-campaign', ...values }), activity() {} }; let sequence = 0;
  async function invoke(path, body) {
    let response;
    await handleIntegration({ req: { method: body ? 'POST' : 'GET', headers: { 'idempotency-key': 'audit-request-' + ++sequence } }, url: new URL('http://localhost/api/projects/audit-project/integrations/' + path), project, db, store, body, role: 'editor', config: { env: { ZERNIO_API_KEY: 'audit-fixture-key' } }, send(status, data) { response = { status, data }; } });
    return response;
  }
  try { await run({ project, account, campaign, post, writes, invoke, mock(handler) { globalThis.fetch = async (target, options = {}) => { const url = new URL(target), method = options.method || 'GET', payload = options.body ? JSON.parse(options.body) : undefined; assert.equal(url.origin, 'https://zernio.com'); if (method !== 'GET') writes.push({ url, payload }); return handler(url, method, payload); }; } }); }
  finally { globalThis.fetch = originalFetch; db.close(); }
}

test('published-post boosts place the chosen countries in Zernio targeting and preserve other audience selections', () => audit(async ({ account, post, mock, writes, invoke }) => {
  mock((url, method, payload) => {
    if (url.pathname === '/api/v1/accounts') return Response.json({ accounts: [account] });
    if (url.pathname === '/api/v1/ads/accounts') return Response.json({ accounts: [{ id: 'native-account', currency: 'USD', selectable: true }] });
    if (url.pathname === '/api/v1/posts/remote-post') return Response.json({ post: { _id: post.externalId, status: 'published', platforms: [{ accountId: account._id, platform: 'facebook', status: 'published' }] } });
    assert.equal(url.pathname, '/api/v1/ads/boost'); assert.equal(method, 'POST');
    if (payload.countries !== undefined || !Array.isArray(payload.targeting?.countries)) return Response.json({ error: 'Geo belongs to targeting on boosts.' }, { status: 400 });
    return Response.json({ ad: { _id: 'created-ad', platformCampaignId: 'created-platform-campaign', platform: 'facebook', status: 'paused' } });
  });
  const result = await invoke('ads/boost', { platform: 'facebook', accountId: account._id, adAccountId: 'native-account', name: 'Scoped boost', goal: 'engagement', budgetAmount: 25, countries: ['AE'], targeting: { ageMin: 25, ageMax: 40 }, postId: post.id });
  assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].payload.targeting, { countries: ['AE'], ageMin: 25, ageMax: 40 }); assert.equal(writes[0].payload.countries, undefined);
}));

test('daily budget editors do not convert the provider campaignBudget or adSetBudget lifetime allocations', () => audit(async ({ campaign, mock, writes, invoke }) => {
  mock((url, method, payload) => {
    if (url.pathname === '/api/v1/ads/tree') return Response.json({ campaigns: [campaign], pagination: { pages: 1 } });
    assert.equal(method, 'PUT'); return Response.json({ updated: 1, budget: payload.budget });
  });
  const results = [], budget = type => type ? { amount: 500, type } : undefined;
  async function update(level) { campaign.budgetLevel = level; return invoke('ads/' + (level === 'campaign' ? 'campaign' : 'adset'), { campaignId: campaign.platformCampaignId, platform: campaign.platform, ...(level === 'adset' ? { adSetId: 'audit-set' } : {}), budget: { amount: 20, type: 'daily' } }); }
  for (const [generic, canonical] of [[undefined, 'lifetime'], ['daily', 'lifetime'], ['lifetime', 'daily']]) {
    campaign.budget = budget(generic); campaign.campaignBudget = budget(canonical); campaign.adSets[0].budget = budget(generic); campaign.adSets[0].adSetBudget = budget(canonical);
    results.push((await update('campaign')).status, (await update('adset')).status);
  }
  assert.deepEqual(results, [400, 400, 400, 400, 400, 400]); assert.equal(writes.length, 0, 'Lifetime allocations must be rejected before any paid-provider write.');
  campaign.budget = campaign.campaignBudget = campaign.adSets[0].budget = campaign.adSets[0].adSetBudget = budget('daily');
  const campaignReview = await update('campaign');
  assert.equal(campaignReview.status, 400); assert.equal(campaignReview.data.error.code, 'BUDGET_REVIEW_REQUIRED'); assert.equal((await update('adset')).status, 400); assert.equal(writes.length, 0, 'Both daily budget levels require their separate reviewed proposals before a provider write.');
}));

test('dashboard fields displayed as text reject objects before they can crash the report UI', () => audit(async ({ mock, invoke }) => {
  const report = { totals: { impressions: 0 }, daily: [], topPosts: [{ postId: 'report-post', platform: 'facebook', metrics: { impressions: 0 } }] };
  mock(() => Response.json(report));
  assert.equal((await invoke('analytics/dashboard?fromDate=2026-10-01&toDate=2026-10-02')).status, 200);
  report.topPosts[0].platform = { unsafe: 'object' };
  const result = await invoke('analytics/dashboard?fromDate=2026-10-01&toDate=2026-10-02');
  assert.equal(result.status, 502); assert.equal(result.data.topPosts, undefined);
}));
