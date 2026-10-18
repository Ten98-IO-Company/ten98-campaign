import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleIntegration } from '../server/integrations.mjs';

// Current contract: https://docs.zernio.com/platforms/openai-ads
async function scenario(run) {
  const original = globalThis.fetch, db = new DatabaseSync(':memory:'), writes = [], records = [];
  const project = { id: 'openai-project', zernioProfileId: 'openai-profile' }, account = { _id: 'openai-account', profileId: project.zernioProfileId, platform: 'openaiads', isActive: true };
  const campaign = { platformCampaignId: 'openai-campaign', platform: 'openai', profileId: project.zernioProfileId, currency: 'USD', campaignBudget: { amount: 100, type: 'lifetime' } };
  const draft = { platform: 'openai', accountId: account._id, adAccountId: 'native-account', name: 'Planner launch', goal: 'traffic', budgetAmount: 25, budgetType: 'lifetime', endDate: '2090-02-28T23:59:00Z', bidStrategy: 'LOWEST_COST_WITH_BID_CAP', bidAmount: 2, headline: 'Try the new planner', body: 'Coordinate tasks and meetings.', imageUrl: 'https://cdn.example.com/planner.png', linkUrl: 'https://example.com/planner', countries: ['US'], tracking: { urlTags: [{ key: 'utm_source', value: 'chatgpt' }, { key: 'click_id', value: '{oppref}' }] } };
  let sequence = 0, behavior;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target), payload = options.body ? JSON.parse(options.body) : undefined;
    assert.equal(url.origin, 'https://zernio.com');
    if (url.pathname === '/api/v1/accounts') return Response.json({ accounts: [account] });
    if (url.pathname === '/api/v1/ads/accounts') return Response.json({ accounts: [{ id: 'native-account', currency: 'USD', selectable: true, minimumDailyBudget: 50 }] });
    if (url.pathname === '/api/v1/ads/tree') return Response.json({ campaigns: [campaign], pagination: { pages: 1 } });
    writes.push({ url, payload, options });
    if (behavior) return behavior(url, payload);
    if (url.pathname === '/api/v1/connect/openai-ads/credentials') return Response.json({ accountId: account._id, adAccountName: 'QA Ads', apiKey: 'must-not-leak' });
    if (url.pathname === '/api/v1/ads/create' && payload.validateOnly) return Response.json({ validateOnly: true, results: ['campaign', 'adSet', 'ad'].map(node => ({ node, status: 'validated' })), message: 'Validated; nothing created.' });
    if (url.pathname === '/api/v1/ads/create') return Response.json({ ad: { _id: 'created-ad', platformCampaignId: campaign.platformCampaignId, platform: 'openai', status: 'paused' } }, { status: 201 });
    return Response.json({ updated: 1, budget: payload.budget });
  };
  async function invoke(path, body, { role = 'editor', key = 'openai-check-' + ++sequence } = {}) {
    let result;
    await handleIntegration({ req: { method: 'POST', headers: { 'idempotency-key': key } }, url: new URL('http://localhost/api/projects/' + project.id + '/integrations/' + path), body, project, role, db, config: { env: { ZERNIO_API_KEY: 'zernio-test-key' } }, store: { create(_project, _collection, value) { const record = { id: 'local-campaign', ...value }; records.push(record); return record; }, activity() {} }, send(status, data) { result = { status, data }; } });
    return result;
  }
  try { await run({ invoke, draft, writes, records, campaign, account, db, mock(fn) { behavior = fn; } }); }
  finally { globalThis.fetch = original; db.close(); }
}

test('ChatGPT lifetime ads preserve their spend cap, fixed bid, tracking macros and local budget type', () => scenario(async ({ invoke, draft, writes, records }) => {
  const result = await invoke('ads/create', draft);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(writes[0].payload.budgetType, 'lifetime'); assert.equal(writes[0].payload.status, 'PAUSED');
  assert.deepEqual(writes[0].payload.tracking, draft.tracking); assert.equal(records[0].budgetType, 'lifetime');
  const count = writes.length;
  for (const change of [{ endDate: undefined }, { bidStrategy: undefined, bidAmount: undefined }, { promotedObject: { customEventType: 'order_created' } }, { tracking: { urlTags: [{ key: 'bad key', value: 'x' }] } }, { targeting: { ageMin: 25 } }]) {
    assert.equal((await invoke('ads/create', { ...draft, ...change })).status, 400);
  }
  assert.equal(writes.length, count, 'Invalid lifetime, conversion and targeting inputs cannot reach a provider write.');
  const daily = await invoke('ads/create', { ...draft, budgetType: 'daily', budgetAmount: 50, bidStrategy: undefined, bidAmount: undefined }); assert.equal(daily.status, 200);
}));

test('ChatGPT validation performs provider checks without a local campaign or paid operation receipt', () => scenario(async ({ invoke, draft, records, writes, db, mock }) => {
  const result = await invoke('ads/validate', draft);
  assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.validateOnly, true); assert.equal(writes[0].payload.validateOnly, true); assert.equal(records.length, 0);
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='integration_operations'").get().n, 0);
  mock(() => Response.json({ ad: { _id: 'unexpected-write' } }));
  assert.equal((await invoke('ads/validate', draft)).status, 502);
}));

test('ChatGPT credentials require workspace administration, scoped readback, and never persist or return the key', () => scenario(async ({ invoke, writes, db }) => {
  assert.equal((await invoke('connect/openai-ads', { apiKey: 'sk-ads-fixture' })).status, 403); assert.equal(writes.length, 0);
  const options = { role: 'admin', key: 'credentials-one' }, result = await invoke('connect/openai-ads', { apiKey: 'sk-ads-fixture' }, options);
  assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.accountId, 'openai-account');
  assert.deepEqual(writes[0].payload, { apiKey: 'sk-ads-fixture', profileId: 'openai-profile' });
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM integration_operations').all()).includes('sk-ads-fixture'), false);
  assert.deepEqual(await invoke('connect/openai-ads', { apiKey: 'sk-ads-fixture' }, options), result); assert.equal(writes.length, 1);
}));

test('an unconfirmed ChatGPT connection blocks duplicate credential writes and never exposes provider secrets', () => scenario(async ({ invoke, writes, db, mock }) => {
  mock(() => Response.json({ accountId: 'outside-project', apiKey: 'provider-secret' }));
  const body = { apiKey: 'sk-ads-fixture' }, result = await invoke('connect/openai-ads', body, { role: 'owner', key: 'uncertain-connect' });
  assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(JSON.stringify(result).includes('provider-secret'), false);
  assert.equal((await invoke('connect/openai-ads', body, { role: 'owner', key: 'different-connect-key' })).status, 409); assert.equal(writes.length, 1);
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM integration_operations').all()).includes('sk-ads-fixture'), false);
}));

test('ChatGPT campaign budgets retain lifetime limits or switch to daily, never daily back to lifetime', () => scenario(async ({ invoke, campaign, writes }) => {
  const body = { platform: 'openai', campaignId: campaign.platformCampaignId, budget: { amount: 125, type: 'lifetime' } };
  assert.equal((await invoke('ads/campaign', body)).status, 200);
  assert.deepEqual(writes[0].payload.budget, body.budget);
  assert.equal((await invoke('ads/campaign', { ...body, budget: { amount: 50, type: 'daily' } })).status, 200);
  campaign.campaignBudget.type = 'daily';
  assert.equal((await invoke('ads/campaign', body)).status, 400); assert.equal(writes.length, 2);
}));
