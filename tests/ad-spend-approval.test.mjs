import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createStore } from '../server/database.ts';
import { handleIntegration } from '../server/integrations.ts';
import { handleApprovals, assertAdSpendApproval } from '../server/approvals.ts';
import { handleNativeGoogleAds } from '../server/native-google-ads.ts';
import { handleMicrosoftAds } from '../server/native-microsoft-ads.ts';
import { blockWrites, postgresSkip, singleConnection, testDatabase } from './postgres.mjs';

// Council decision ten98-code-system#35 (Q1): with require_ad_approval on, a write that starts spend or raises a budget
// needs an approved review of exactly (subject id, platform, action, amount in minor units, currency). Every provider
// transport here is stubbed; `writes` records each provider write, and no paid provider call is made.
const googleEnv = { GOOGLE_ADS_CLIENT_ID: 'fixture-client.apps.googleusercontent.com', GOOGLE_ADS_CLIENT_SECRET: 'fixture-secret', GOOGLE_ADS_REFRESH_TOKEN: 'fixture-refresh', GOOGLE_ADS_DEVELOPER_TOKEN: 'fixture-developer' };
const microsoftEnv = { MICROSOFT_ADS_CLIENT_ID: 'fixture-client', MICROSOFT_ADS_REFRESH_TOKEN: 'fixture-refresh', MICROSOFT_ADS_DEVELOPER_TOKEN: 'fixture-developer' };
const people = { owner: 'Olive Owner', admin: 'Avery Admin', editor: 'Casey Editor', viewer: 'Val Viewer' };

async function spendFixture(t, { members = ['owner', 'admin', 'editor', 'viewer'], poolOptions } = {}) {
  const database = await testDatabase(t, poolOptions), { db, pool } = database, store = createStore(db);
  await pool.query(`INSERT INTO users (id, name, email) VALUES ${members.map(id => `('${id}','${people[id]}','${id}@example.test')`).join(',')}; INSERT INTO workspaces (id, name) VALUES ('w','W'); INSERT INTO memberships VALUES ${members.map(id => `('w','${id}','${id}')`).join(',')}; INSERT INTO projects (id, workspace_id, name, zernio_profile_id) VALUES ('spend-project','w','Spend','spend-profile')`);
  await pool.query(`INSERT INTO native_google_connections VALUES ('spend-project','1234567890'); INSERT INTO microsoft_ad_connections VALUES ('spend-project','555','777','{"name":"Fixture","currency":"USD","timeZone":"Dubai"}')`);
  const project = { id: 'spend-project', zernioProfileId: 'spend-profile' };
  const state = { campaignOwned: false, setAmount: 20, campaignAmount: 40, googleAmount: 50, adAmount: 15, nativeMicros: '25000000', nativeStatus: 'PAUSED', nativePeriod: 'DAILY', msStatus: 'Paused', msBudget: 30 };
  const writes = [], hooks = {};
  const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
  const metaCampaign = profileId => ({ platform: 'facebook', platformCampaignId: 'spend-campaign', accountId: 'metaads', platformAdAccountId: 'act_123', campaignName: 'Spend', currency: 'AED', status: 'paused', profileId, budgetLevel: state.campaignOwned ? 'campaign' : 'adset', campaignBudget: state.campaignOwned ? { amount: state.campaignAmount, type: 'daily' } : null, adSets: [{ platformAdSetId: 'spend-set', status: 'paused', configuredStatus: 'PAUSED', ...(state.campaignOwned ? {} : { adSetBudget: { amount: state.setAmount, type: 'daily' } }) }] });
  const googleCampaign = profileId => ({ platform: 'google', platformCampaignId: 'google-campaign', accountId: 'googleads', platformAdAccountId: '1234567890', campaignName: 'Search', currency: 'USD', status: 'active', profileId, budgetLevel: 'campaign', campaignBudget: { amount: state.googleAmount, type: 'daily' } });
  const nativeRow = () => ({ customer: { id: '1234567890' }, campaign: { id: '901', name: 'Shopping', status: state.nativeStatus, advertisingChannelType: 'SHOPPING' }, campaignBudget: { resourceName: 'customers/1234567890/campaignBudgets/3001', period: state.nativePeriod, amountMicros: state.nativeMicros, explicitlyShared: false } });
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target), method = options.method || 'GET', payload = options.body && !String(options.body).includes('grant_type') ? JSON.parse(options.body) : undefined, profileId = url.searchParams.get('profileId');
    const write = async (name, result) => { writes.push({ name, payload }); await hooks.write?.(name); return Response.json(result); };
    if (url.hostname === 'zernio.com') {
      if (url.pathname === '/api/v1/accounts') return Response.json({ accounts: [{ _id: 'metaads', profileId, platform: 'metaads', isActive: true }, { _id: 'googleads', profileId, platform: 'googleads', isActive: true }] });
      if (url.pathname === '/api/v1/ads/accounts') return Response.json({ accounts: [{ id: 'act_123', currency: 'AED', selectable: true }] });
      if (url.pathname === '/api/v1/ads/tree') return Response.json({ campaigns: [metaCampaign(profileId), googleCampaign(profileId)], pagination: { pages: 1 } });
      if (url.pathname === '/api/v1/ads') return Response.json({ ads: [{ _id: 'spend-ad', platform: 'facebook', profileId, status: 'paused', currency: 'AED', budget: { amount: state.adAmount, type: 'daily' }, platformCampaignId: 'spend-campaign' }], pagination: { pages: 1 } });
      if (url.pathname === '/api/v1/ads/accounts/live') {
        const owned = state.campaignOwned, parent = { platformCampaignId: 'spend-campaign', budget: owned ? { amount: state.campaignAmount, type: 'daily' } : null, dailyBudget: owned ? state.campaignAmount : null, lifetimeBudget: null, configuredStatus: 'PAUSED', platformCampaignStatus: 'PAUSED', status: 'paused' };
        const set = { platformAdSetId: 'spend-set', platformCampaignId: 'spend-campaign', budget: owned ? null : { amount: state.setAmount, type: 'daily' }, dailyBudget: owned ? null : state.setAmount, lifetimeBudget: null, configuredStatus: 'PAUSED', platformAdSetStatus: 'CAMPAIGN_PAUSED', status: 'paused' };
        return Response.json({ accountId: 'metaads', adAccountId: 'act_123', platform: 'facebook', currency: 'AED', readAt: new Date().toISOString(), campaigns: [parent], adSets: [set], paging: {} });
      }
      if (method === 'PUT' && url.pathname === '/api/v1/ads/campaigns/spend-campaign/status') return write('campaign-status', { platformCampaignStatus: payload.status === 'active' ? 'ACTIVE' : 'PAUSED', statusReadAt: new Date().toISOString() });
      if (method === 'PUT' && url.pathname === '/api/v1/ads/spend-ad/status') return write('ad-status', { configuredStatus: payload.status.toUpperCase() });
      if (method === 'PUT' && url.pathname === '/api/v1/ads/ad-sets/spend-set/status') return write('adset-status', { status: payload.status, updated: 1, skipped: 0 });
      if (method === 'PUT' && url.pathname === '/api/v1/ads/ad-sets/spend-set') { state.setAmount = payload.budget.amount; return write('adset-budget', { budget: { ...payload.budget }, budgetLevel: 'adset' }); }
      if (method === 'PUT' && url.pathname === '/api/v1/ads/campaigns/spend-campaign') { state.campaignAmount = payload.budget.amount; return write('campaign-budget', { updated: 1, budget: { ...payload.budget }, budgetLevel: 'campaign' }); }
      if (method === 'PUT' && url.pathname === '/api/v1/ads/campaigns/google-campaign') { state.googleAmount = payload.budget.amount; return write('google-budget', { updated: 1, budget: { ...payload.budget } }); }
      if (method === 'POST' && url.pathname === '/api/v1/ads/create') return write('create', {});
    }
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-access', token_type: 'Bearer', expires_in: 3600 });
    if (url.hostname === 'googleads.googleapis.com' && url.pathname === '/v25/customers/1234567890/googleAds:search') {
      if (payload.query.includes('FROM customer LIMIT 1')) return Response.json({ results: [{ customer: { id: '1234567890', descriptiveName: 'Fixture', currencyCode: 'USD', timeZone: 'Asia/Dubai', manager: false } }] });
      if (payload.query.includes('campaign.campaign_budget =')) return Response.json({ results: [{ campaign: { id: '901' } }] });
      if (payload.query.includes('WHERE campaign.resource_name =')) return Response.json({ results: [nativeRow()] });
    }
    if (url.hostname === 'googleads.googleapis.com' && url.pathname === '/v25/customers/1234567890/googleAds:mutate') {
      const responses = payload.mutateOperations.map(row => { const [kind, operation] = Object.entries(row)[0]; if (kind === 'campaignOperation') state.nativeStatus = operation.update.status; if (kind === 'campaignBudgetOperation') state.nativeMicros = operation.update.amountMicros; return { [kind.replace('Operation', 'Result')]: { resourceName: operation.update.resourceName } }; });
      return write('google-native', { mutateOperationResponses: responses });
    }
    if (url.hostname === 'login.microsoftonline.com') return Response.json({ access_token: 'fixture-access', token_type: 'Bearer', scope: 'https://ads.microsoft.com/msads.manage offline_access' });
    if (url.hostname === 'campaign.api.bingads.microsoft.com' && url.pathname.endsWith('/Campaigns/QueryByAccountId')) return Response.json({ Campaigns: [{ Id: 4242, Name: 'Search', Status: state.msStatus, CampaignType: 'Search', BudgetType: 'DailyBudgetStandard', DailyBudget: state.msBudget }] });
    if (url.hostname === 'campaign.api.bingads.microsoft.com' && url.pathname.endsWith('/Campaigns') && method === 'PUT') { const change = payload.Campaigns[0]; if (change.Status) state.msStatus = change.Status; if (change.DailyBudget !== undefined) state.msBudget = change.DailyBudget; return write('microsoft', { PartialErrors: [] }); }
    throw new Error(`Unexpected provider request ${method} ${url.href}`);
  };
  let sequence = 0;
  const base = (role, extra) => ({ db, store, project, role, user: { id: role, name: people[role] }, assertIntegrationSettings: async () => undefined, ...extra });
  const reply = () => { let response; return { send(status, data) { response = { status, data }; }, get: () => response }; };
  async function approvals(path, { role = 'editor', body, method = body === undefined ? 'GET' : 'POST' } = {}) {
    const out = reply(); await handleApprovals({ ...base(role), req: { method }, url: new URL(`http://localhost/api/projects/${project.id}/approvals/${path}`), body: body ?? {}, send: out.send }); return out.get();
  }
  async function integration(path, body, { role = 'editor', key = `spend-key-${++sequence}` } = {}) {
    const out = reply(), method = body === undefined ? 'GET' : 'POST';
    await handleIntegration({ ...base(role), req: { method, headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${project.id}/integrations/${path}`), body: body ?? {}, config: { ZERNIO_API_KEY: 'spend-fixture-key' }, send: out.send }); return out.get();
  }
  async function nativeGoogle(body, { role = 'editor', key = `spend-key-${++sequence}` } = {}) {
    const out = reply(); await handleNativeGoogleAds({ ...base(role), req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${project.id}/native-google-ads/campaign/update`), body, config: { env: googleEnv }, send: out.send }); return out.get();
  }
  async function microsoft(body, { role = 'editor', key = `spend-key-${++sequence}` } = {}) {
    const out = reply(); await handleMicrosoftAds({ ...base(role), req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${project.id}/microsoft-ads/campaigns/4242`), body, config: { env: microsoftEnv }, send: out.send }); return out.get();
  }
  const policy = async (requireAdApproval, role = 'owner') => { const result = await approvals('policy', { role, body: { requireAdApproval } }); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data; };
  const request = async (change, role = 'editor') => { const result = await approvals('ad-spend/request', { role, body: change }); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.review; };
  const decide = (reviewId, role = 'admin', decision = 'approved') => approvals('ad-spend/review', { role, body: { reviewId, decision, note: 'Checked the spend.' } });
  const approve = async (change, requester = 'editor', reviewer = 'admin') => { const review = await request(change, requester), result = await decide(review.id, reviewer); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.review; };
  const reviews = async () => (await approvals('ad-spend')).data.reviews;
  return { database, db, pool, store, project, state, writes, hooks, approvals, integration, nativeGoogle, microsoft, policy, request, decide, approve, reviews };
}

// Each gated route kind: how to send the gated change, the exact change it fingerprints, and its current budget.
// A same-key retry resends the body first sent under that key.
const metaBodies = new Map();
const metaBudget = (f, level, amount) => async options => {
  if (options?.key && metaBodies.has(options.key)) return f.integration('ads/' + level, metaBodies.get(options.key), options);
  const query = new URLSearchParams({ campaignId: 'spend-campaign', platform: 'facebook', ...(level === 'adset' ? { adSetId: 'spend-set' } : {}), currency: 'AED', amount: String(amount) });
  const review = await f.integration(`ads/${level}-budget-review?${query}`); assert.equal(review.status, 200, JSON.stringify(review.data));
  const body = { campaignId: 'spend-campaign', platform: 'facebook', ...(level === 'adset' ? { adSetId: 'spend-set' } : {}), budget: { amount, type: 'daily' }, currency: 'AED', version: review.data.budgetReview.version, reviewExpiresAt: review.data.budgetReview.expiresAt, confirmBudget: true };
  if (options?.key) metaBodies.set(options.key, body);
  return f.integration('ads/' + level, body, options);
};
const routes = {
  'ads/status active': { send: f => options => f.integration('ads/status', { campaignId: 'spend-campaign', platform: 'facebook', status: 'active' }, options), change: { subjectId: 'spend-campaign', platform: 'facebook', action: 'ads/status', amount: 2000, currency: 'AED' }, current: 2000, write: 'campaign-status' },
  'ads/ad-status active': { send: f => options => f.integration('ads/ad-status', { adId: 'spend-ad', status: 'active' }, options), change: { subjectId: 'spend-ad', platform: 'facebook', action: 'ads/ad-status', amount: 1500, currency: 'AED' }, current: 1500, write: 'ad-status' },
  'ads/adset status active': { send: f => options => f.integration('ads/adset', { campaignId: 'spend-campaign', platform: 'facebook', adSetId: 'spend-set', status: 'active' }, options), change: { subjectId: 'spend-set', platform: 'facebook', action: 'ads/adset-status', amount: 2000, currency: 'AED' }, current: 2000, write: 'adset-status' },
  'Meta ad set budget increase': { send: f => metaBudget(f, 'adset', 30), change: { subjectId: 'spend-set', platform: 'facebook', action: 'ads/adset-budget', amount: 3000, currency: 'AED' }, current: 2000, write: 'adset-budget' },
  'Meta campaign budget increase': { setup: f => { f.state.campaignOwned = true; }, send: f => metaBudget(f, 'campaign', 50), change: { subjectId: 'spend-campaign', platform: 'facebook', action: 'ads/campaign-budget', amount: 5000, currency: 'AED' }, current: 4000, write: 'campaign-budget' },
  'campaign budget increase': { send: f => options => f.integration('ads/campaign', { campaignId: 'google-campaign', platform: 'google', budget: { amount: 60, type: 'daily' } }, options), change: { subjectId: 'google-campaign', platform: 'google', action: 'ads/campaign-budget', amount: 6000, currency: 'USD' }, current: 5000, write: 'google-budget' },
  'native Google enable': { send: f => options => f.nativeGoogle({ campaignId: '901', status: 'ENABLED', confirmChange: true }, options), change: { subjectId: '901', platform: 'google', action: 'google-native/campaign-status', amount: 2500, currency: 'USD' }, current: 2500, write: 'google-native' },
  'native Google budget increase': { send: f => options => f.nativeGoogle({ campaignId: '901', dailyBudget: 26, confirmChange: true }, options), change: { subjectId: '901', platform: 'google', action: 'google-native/campaign-budget', amount: 2600, currency: 'USD' }, current: 2500, write: 'google-native' },
  'Microsoft activate': { send: f => options => f.microsoft({ status: 'Active', confirmed: true }, options), change: { subjectId: '4242', platform: 'microsoft', action: 'microsoft/campaign-status', amount: 3000, currency: 'USD' }, current: 3000, write: 'microsoft' },
  'Microsoft budget increase': { send: f => options => f.microsoft({ dailyBudget: 31.5, confirmed: true }, options), change: { subjectId: '4242', platform: 'microsoft', action: 'microsoft/campaign-budget', amount: 3150, currency: 'USD' }, current: 3000, write: 'microsoft' },
};
// One negative control per fingerprint component: an approval that differs only there.
const variants = change => ({ amount: { ...change, amount: change.amount + 1 }, currency: { ...change, currency: change.currency === 'USD' ? 'EUR' : 'USD' }, platform: { ...change, platform: change.platform === 'google' ? 'bing' : 'google' }, subject: { ...change, subjectId: change.subjectId + '-other' }, action: { ...change, action: change.action === 'ads/status' ? 'ads/ad-status' : 'ads/status' } });

for (const [name, route] of Object.entries(routes)) {
  test(`${name}: an editor gets 403 without approval, 409 for any other approved change, and 200 with exactly one write for the approved one`, { skip: postgresSkip }, async t => {
    const f = await spendFixture(t); route.setup?.(f);
    const send = route.send(f), sent = () => f.writes.filter(row => row.name === route.write).length;
    await f.policy(true);
    let result = await send();
    assert.equal(result.status, 403, JSON.stringify(result.data)); assert.equal(result.data.error.code, 'AD_SPEND_APPROVAL_REQUIRED'); assert.equal(f.writes.length, 0);
    // The blocked attempt opened a review of exactly this change, with the current budget the route read.
    let [opened] = await f.reviews();
    assert.equal(opened.status, 'pending'); assert.equal(opened.requestedBy.id, 'editor');
    assert.deepEqual(opened.snapshot, { ...route.change, currentAmount: route.current, activates: route.change.action.endsWith('status') });
    assert.equal((await send()).status, 403, 'A pending review does not allow the write.'); assert.equal(f.writes.length, 0);
    assert.equal((await f.reviews()).filter(row => row.status === 'pending').length, 1, 'A repeated attempt reuses the pending review.');
    for (const [component, other] of Object.entries(variants(route.change))) {
      await f.approve(other);
      result = await send();
      assert.equal(result.status, 409, `${component}: ${JSON.stringify(result.data)}`); assert.equal(result.data.error.code, 'AD_SPEND_APPROVAL_MISMATCH'); assert.equal(f.writes.length, 0, `An approval differing in ${component} sends nothing.`);
      await f.pool.query("DELETE FROM post_approval_reviews WHERE kind='ad_spend' AND status='approved'");
    }
    const approved = await f.approve(route.change);
    assert.equal(approved.snapshot.currentAmount, route.current, 'The review card keeps the current budget the route read.');
    const key = `approved-${route.write}`, before = { ...f.state };
    result = await send({ key });
    assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(sent(), 1); assert.equal(f.writes.length, 1);
    assert.deepEqual(await send({ key }), result, 'A same-key retry replays the receipt.'); assert.equal(f.writes.length, 1);
    // The approval covered one provider write: the same change again (from the same starting budget) needs a new one.
    const consumed = (await f.reviews()).find(row => row.id === approved.id);
    assert.equal(consumed.status, 'approved'); assert.equal(consumed.consumed, true);
    Object.assign(f.state, before);
    result = await send();
    assert.equal(result.status, 403, JSON.stringify(result.data)); assert.equal(f.writes.length, 1);
  });
}

test('ads/create cannot activate spend: an active status is refused with or without an approval and nothing is sent', { skip: postgresSkip }, async t => {
  const f = await spendFixture(t);
  const body = { platform: 'facebook', accountId: 'metaads', adAccountId: 'act_123', name: 'Launch', goal: 'traffic', budgetAmount: 20, headline: 'Launch', body: 'Discover it.', imageUrl: 'https://cdn.example.com/launch.jpg', linkUrl: 'https://example.com/launch', callToAction: 'LEARN_MORE', countries: ['AE'], currency: 'AED', status: 'ACTIVE' };
  for (const on of [false, true]) {
    await f.policy(on);
    const result = await f.integration('ads/create', body);
    assert.equal(result.status, 400); assert.equal(result.data.error.code, 'INVALID_AD_STATUS'); assert.equal(f.writes.length, 0);
  }
});

test('pauses and budget decreases need no approval, and with ad approval off nothing is gated', { skip: postgresSkip }, async t => {
  const f = await spendFixture(t);
  await f.policy(true);
  const unapproved = [
    ['campaign pause', () => f.integration('ads/status', { campaignId: 'spend-campaign', platform: 'facebook', status: 'paused' }), 'campaign-status'],
    ['ad pause', () => f.integration('ads/ad-status', { adId: 'spend-ad', status: 'paused' }), 'ad-status'],
    ['ad set pause', () => f.integration('ads/adset', { campaignId: 'spend-campaign', platform: 'facebook', adSetId: 'spend-set', status: 'paused' }), 'adset-status'],
    ['Meta ad set budget decrease', () => metaBudget(f, 'adset', 10)(), 'adset-budget'],
    ['campaign budget decrease', () => f.integration('ads/campaign', { campaignId: 'google-campaign', platform: 'google', budget: { amount: 40, type: 'daily' } }), 'google-budget'],
    ['native Google pause', () => f.nativeGoogle({ campaignId: '901', status: 'PAUSED', confirmChange: true }), 'google-native'],
    ['native Google budget decrease', () => f.nativeGoogle({ campaignId: '901', dailyBudget: 20, confirmChange: true }), 'google-native'],
    ['Microsoft pause', () => f.microsoft({ status: 'Paused', confirmed: true }), 'microsoft'],
    ['Microsoft budget decrease', () => f.microsoft({ dailyBudget: 12, confirmed: true }), 'microsoft'],
  ];
  for (const [label, send, write] of unapproved) {
    const before = f.writes.filter(row => row.name === write).length, result = await send();
    assert.equal(result.status, 200, `${label}: ${JSON.stringify(result.data)}`); assert.equal(f.writes.filter(row => row.name === write).length, before + 1, label);
  }
  f.state.campaignOwned = true;
  let result = await metaBudget(f, 'campaign', 30)(); assert.equal(result.status, 200, 'Meta campaign budget decrease: ' + JSON.stringify(result.data));
  assert.deepEqual(await f.reviews(), [], 'No review was opened for a pause or decrease.');
  // Off: every gated kind goes straight through.
  await f.policy(false); f.state.campaignOwned = false; f.state.msStatus = 'Paused'; f.state.nativeStatus = 'PAUSED';
  for (const route of Object.values(routes)) {
    route.setup?.(f); const before = f.writes.length;
    result = await route.send(f)();
    assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(f.writes.length, before + 1);
    f.state.campaignOwned = false;
  }
  assert.deepEqual(await f.reviews(), [], 'With ad approval off no review is opened.');
});

test('an activation whose budget cannot be read exactly is refused while ad approval is on', { skip: postgresSkip }, async t => {
  const f = await spendFixture(t);
  await f.policy(true); f.state.nativePeriod = 'CUSTOM_PERIOD';
  let result = await f.nativeGoogle({ campaignId: '901', status: 'ENABLED', confirmChange: true });
  assert.equal(result.status, 409); assert.equal(result.data.error.code, 'AD_SPEND_AMOUNT_UNAVAILABLE'); assert.equal(f.writes.length, 0);
  // Microsoft accepts two decimals in every currency; a JPY budget with decimals has no exact minor-unit amount.
  await f.pool.query(`UPDATE microsoft_ad_connections SET data='{"name":"Fixture","currency":"JPY","timeZone":"Tokyo"}'`);
  result = await f.microsoft({ dailyBudget: 31.5, confirmed: true });
  assert.equal(result.status, 409); assert.equal(result.data.error.code, 'AD_SPEND_AMOUNT_UNAVAILABLE'); assert.equal(f.writes.length, 0);
});

test('the ad spend policy is separate from post approval and is set by owners and administrators only', { skip: postgresSkip }, async t => {
  const f = await spendFixture(t);
  assert.deepEqual((await f.approvals('policy', { role: 'viewer' })).data, { requireApproval: false, requireAdApproval: false, updatedBy: null, updatedAt: null });
  for (const role of ['editor', 'viewer']) assert.equal((await f.approvals('policy', { role, body: { requireAdApproval: true } })).status, 403);
  for (const body of [{}, { requireAdApproval: 'yes' }, { requireAdApproval: true, requireApproval: 1 }, { requireAdApproval: true, extra: true }]) assert.equal((await f.approvals('policy', { role: 'owner', body })).status, 400, JSON.stringify(body));
  let result = await f.policy(true, 'admin'); assert.equal(result.requireAdApproval, true); assert.equal(result.requireApproval, false);
  result = (await f.approvals('policy', { role: 'owner', body: { requireApproval: true } })).data; assert.equal(result.requireApproval, true); assert.equal(result.requireAdApproval, true, 'Setting one flag keeps the other.');
  result = await f.policy(false); assert.equal(result.requireApproval, true); assert.equal(result.requireAdApproval, false);
});

test('ad spend requests are validated, need editing permission, and the summary counts pending ones', { skip: postgresSkip }, async t => {
  const f = await spendFixture(t), change = routes['ads/status active'].change;
  assert.equal((await f.approvals('ad-spend/request', { role: 'viewer', body: change })).status, 403);
  for (const body of [{ ...change, amount: 20.5 }, { ...change, amount: 0 }, { ...change, currency: 'aed' }, { ...change, action: 'ads/create' }, { ...change, subjectId: '' }, { ...change, extra: 1 }, { ...change, platform: 'Face book' }]) assert.equal((await f.approvals('ad-spend/request', { body })).status, 400, JSON.stringify(body));
  const first = await f.request(change);
  assert.equal(first.status, 'pending'); assert.equal(first.kind, 'ad_spend'); assert.equal(first.consumed, false);
  assert.deepEqual(first.snapshot, { ...change, currentAmount: null, activates: true });
  assert.equal((await f.request(change)).id, first.id, 'An identical pending request is reused.');
  const raised = await f.request({ ...change, amount: 2500 });
  assert.notEqual(raised.id, first.id);
  const rows = await f.reviews();
  assert.equal(rows.find(row => row.id === first.id).status, 'rejected', 'A newer amount for the same subject and action supersedes the pending one.');
  assert.equal((await f.decide(first.id)).status, 409);
  await f.request(routes['ads/ad-status active'].change);
  const summary = (await f.approvals('summary', { role: 'viewer' })).data;
  assert.equal(summary.pendingAdSpend, 2); assert.equal(summary.pending, 0); assert.deepEqual(summary.statuses, {});
  for (const role of ['editor', 'viewer']) assert.equal((await f.decide(raised.id, role)).status, 403);
  assert.equal((await f.decide('missing-review')).status, 404);
  assert.equal((await f.decide(raised.id, 'admin', 'rejected')).status, 200);
  assert.equal((await f.approvals('summary')).data.pendingAdSpend, 1);
});

test('the self-review rule applies to ad spend, with the single-administrator exception', { skip: postgresSkip }, async t => {
  await t.test('another owner or administrator is active', async t => {
    const f = await spendFixture(t), change = routes['ads/status active'].change;
    await f.policy(true);
    const review = await f.request(change, 'admin');
    const result = await f.decide(review.id, 'admin');
    assert.equal(result.status, 403); assert.equal(result.data.error.code, 'APPROVAL_SELF_REVIEW'); assert.match(result.data.error.message, /Olive Owner/);
    assert.equal((await f.integration('ads/status', { campaignId: 'spend-campaign', platform: 'facebook', status: 'active' }, { role: 'admin' })).status, 403, 'An administrator also needs an approval.');
    assert.equal(f.writes.length, 0);
    const approved = await f.decide(review.id, 'owner'); assert.equal(approved.status, 200); assert.equal(approved.data.review.selfApproved, false);
    assert.equal((await f.integration('ads/status', { campaignId: 'spend-campaign', platform: 'facebook', status: 'active' }, { role: 'admin' })).status, 200); assert.equal(f.writes.length, 1);
  });
  await t.test('the single owner', async t => {
    const f = await spendFixture(t, { members: ['owner', 'editor'] }), send = () => f.integration('ads/status', { campaignId: 'spend-campaign', platform: 'facebook', status: 'active' }, { role: 'owner' });
    await f.policy(true);
    assert.equal((await send()).status, 403);
    const [opened] = await f.reviews(); assert.equal(opened.requestedBy.id, 'owner');
    const result = await f.decide(opened.id, 'owner'); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.review.selfApproved, true);
    assert.equal((await send()).status, 200); assert.equal(f.writes.length, 1);
  });
});

test('two parallel activations with one approval send at most one provider write', { skip: postgresSkip }, async t => {
  const f = await spendFixture(t), route = routes['ads/status active'];
  await f.policy(true); await f.approve(route.change);
  // Both requests reach the receipt claim together; operation() admits one per provider resource.
  const blocked = await blockWrites(f.pool, 'integration_operations');
  const pending = [route.send(f)({ key: 'parallel-activation-a' }), route.send(f)({ key: 'parallel-activation-b' })];
  await blocked.waiting(2); await blocked.release();
  const results = await Promise.all(pending);
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409], JSON.stringify(results));
  assert.equal(f.writes.length, 1);
  assert.equal((await route.send(f)()).status, 403, 'The consumed approval allows no later write.'); assert.equal(f.writes.length, 1);
});

test('two parallel uses of one approval consume it once, so only one may write', { skip: postgresSkip }, async t => {
  // The approval state is the guard across receipts: the subject's approval lock orders the uses and the first consumes it.
  const f = await spendFixture(t), change = routes['ads/status active'].change;
  await f.policy(true); await f.approve(change);
  const attempt = { subjectId: change.subjectId, platform: change.platform, action: change.action, amount: 20, currency: 'AED', currentAmount: 20, activates: true };
  const context = { db: f.db, store: f.store, project: f.project, role: 'editor', user: { id: 'editor', name: people.editor } };
  const blocked = await blockWrites(f.pool, 'post_approval_reviews');
  const uses = ['use-a', 'use-b'].map(key => assertAdSpendApproval(context, attempt, key).then(() => 'allowed', error => error.code));
  await blocked.waiting(2); await blocked.release();
  assert.deepEqual((await Promise.all(uses)).sort(), ['AD_SPEND_APPROVAL_REQUIRED', 'allowed']);
  // A use whose receipt failed releases the approval for a new attempt; a pending or complete one does not.
  const consumer = (await f.pool.query("SELECT consumed_by FROM post_approval_reviews WHERE kind='ad_spend' AND status='approved'")).rows[0].consumed_by;
  await f.pool.query("INSERT INTO integration_operations (id, project_id, request_key, request_hash, status, created_at, action_path, resource_key, response, http_status) VALUES ('op', 'spend-project', $1, 'h', 'complete', '2026-10-22T00:00:00Z', 'POST /integrations/ads/status', 'r', '{}', 200)", [consumer]);
  await assert.rejects(assertAdSpendApproval(context, attempt, 'use-c'), { code: 'AD_SPEND_APPROVAL_REQUIRED' });
  await f.pool.query("UPDATE integration_operations SET status='failed' WHERE id='op'");
  await assertAdSpendApproval(context, attempt, 'use-d');
});

test('ad spend requests, decisions and the gate each run on their own transaction connection', { skip: postgresSkip }, async t => {
  const f = await spendFixture(t, { poolOptions: singleConnection }), change = routes['ads/status active'].change;
  await f.policy(true);
  const context = { db: f.db, store: f.store, project: f.project, role: 'editor', user: { id: 'editor', name: people.editor } }, attempt = { ...change, amount: 20, currentAmount: 20, activates: true };
  await assert.rejects(assertAdSpendApproval(context, attempt, 'single-a'), { code: 'AD_SPEND_APPROVAL_REQUIRED' });
  const [opened] = await f.reviews();
  assert.equal((await f.decide(opened.id)).status, 200);
  await assertAdSpendApproval(context, attempt, 'single-b');
});

test('migration 0007 copies each project’s post approval setting to ad approval', { skip: postgresSkip }, async t => {
  const { pool } = await testDatabase(t);
  // Undo 0007 on this disposable database, recreate the pre-0007 state, then apply the migration file as shipped.
  await pool.query('DROP INDEX post_approval_reviews_fingerprint; ALTER TABLE post_approval_reviews DROP COLUMN kind, DROP COLUMN consumed_by, DROP COLUMN consumed_at; ALTER TABLE project_approval_policy DROP COLUMN require_ad_approval');
  await pool.query("INSERT INTO users (id, name, email) VALUES ('u','U','u@example.test'); INSERT INTO workspaces (id, name) VALUES ('w','W'); INSERT INTO projects (id, workspace_id, name) VALUES ('on','w','On'),('off','w','Off'),('none','w','None'); INSERT INTO project_approval_policy VALUES ('on', true, 'u', 'now'), ('off', false, 'u', 'now')");
  await pool.query(await readFile(new URL('../migrations/0007_ad_spend_approval.sql', import.meta.url), 'utf8'));
  assert.deepEqual((await pool.query('SELECT project_id, require_approval, require_ad_approval FROM project_approval_policy ORDER BY project_id')).rows, [{ project_id: 'off', require_approval: false, require_ad_approval: false }, { project_id: 'on', require_approval: true, require_ad_approval: true }]);
  await pool.query("INSERT INTO projects (id, workspace_id, name) VALUES ('new','w','New'); INSERT INTO project_approval_policy (project_id, require_approval, updated_by, updated_at) VALUES ('new', true, 'u', 'now')");
  assert.equal((await pool.query("SELECT require_ad_approval FROM project_approval_policy WHERE project_id='new'")).rows[0].require_ad_approval, false, 'Rows written later default to off.');
  assert.equal((await pool.query("SELECT kind FROM post_approval_reviews LIMIT 1")).rowCount, 0);
  await assert.rejects(pool.query("INSERT INTO post_approval_reviews (id,project_id,post_id,kind,fingerprint,snapshot,status,requested_by,requested_at) VALUES ('x','on','p','other','f','{}','pending','u','now')"), /post_approval_reviews_kind_check/);
});
