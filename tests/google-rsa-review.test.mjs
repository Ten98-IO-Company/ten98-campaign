import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleIntegration } from '../server/integrations.mjs';

// Independent provider contract: GET /ads/{id} enriches RSA creative only with
// explicit cache metadata; cachedAt:null + stale:false is successful enrichment.
// https://docs.zernio.com/ad-campaigns/get-ad
// https://docs.zernio.com/platforms/google-ads/create-ads#edit-responsive-search-ad-text
async function fixture(run) {
  const db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch;
  const project = { id: 'rsa-project', zernioProfileId: 'rsa-profile' };
  const ad = { _id: 'rsa-ad', profileId: project.zernioProfileId, platform: 'google', accountId: 'rsa-connection', platformAdAccountId: '1234567890', platformCampaignId: '12345', platformAdSetId: '67890', platformAdId: '111', advertisingChannelType: 'SEARCH', status: 'paused' };
  const initial = { headlines: [{ text: 'Pinned headline', pinnedField: 'HEADLINE_1' }, { text: 'Second headline' }, { text: 'Third headline' }], descriptions: [{ text: 'Pinned description', pinnedField: 'DESCRIPTION_1' }, { text: 'Second description' }], finalUrls: ['https://brand.example/one', 'https://brand.example/two'] };
  const state = { creative: structuredClone(initial), metadata: { cachedAt: null, stale: false }, detailOverrides: {}, apply: true, loseReadback: false, denied: false, remapped: false, afterDetail: null, calls: [], writes: [] };
  let sequence = 0;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target), method = options.method || 'GET', payload = options.body && JSON.parse(options.body);
    assert.equal(url.origin, 'https://zernio.com', 'This fixture must not reach a real provider.');
    state.calls.push({ path: url.pathname, method });
    if (url.pathname === '/api/v1/ads') return Response.json({ ads: [ad], pagination: { pages: 1 } });
    if (url.pathname === '/api/v1/ads/rsa-ad' && method === 'GET') {
      if (state.loseReadback && state.writes.length) throw new Error('Synthetic lost readback');
      const result = { ad: { ...ad, creative: structuredClone(state.creative), ...state.detailOverrides }, ...state.metadata };
      state.afterDetail?.(); return Response.json(result);
    }
    if (url.pathname === '/api/v1/ads/rsa-ad' && method === 'PUT') {
      state.writes.push(payload);
      if (state.apply) for (const key of ['headlines', 'descriptions', 'finalUrls']) if (payload[key] !== undefined) state.creative[key] = structuredClone(payload[key]);
      state.afterWrite?.();
      return Response.json({ ad: { ...ad } });
    }
    if (url.pathname === '/api/v1/ads/rsa-ad/status' && method === 'PUT') { state.writes.push(payload); return Response.json({ configuredStatus: payload.status.toUpperCase() }); }
    throw new Error('Unexpected synthetic provider endpoint: ' + method + ' ' + url.pathname);
  };
  async function invoke(path, body, key, role = 'editor') {
    let response;
    await handleIntegration({ req: { method: body ? 'POST' : 'GET', headers: { 'idempotency-key': key || 'rsa-review-' + ++sequence } }, url: new URL('http://localhost/api/projects/rsa-project/integrations/' + path), project, db, store: { list: () => [] }, body, role, config: { env: { ZERNIO_API_KEY: 'synthetic-rsa-key' } }, assertProjectMapping(expected) { if (state.denied) throw Object.assign(new Error('Session or workspace access changed'), { status: 403 }); if (state.remapped || expected !== project.zernioProfileId) throw Object.assign(new Error('Project mapping changed'), { status: 409 }); }, send(status, data) { response = { status, data }; } });
    return response;
  }
  const review = async () => { const result = await invoke('ads/details?adId=rsa-ad'); assert.equal(result.status, 200, JSON.stringify(result)); return result.data.creativeReview; };
  try { await run({ state, ad, initial, invoke, review }); } finally { globalThis.fetch = originalFetch; db.close(); }
}

test('RSA reviews require explicit recent creative enrichment and verified native scope', () => fixture(async ({ state, review, invoke }) => {
  for (const metadata of [{ cachedAt: null, stale: false }, { cachedAt: new Date().toISOString(), stale: false }]) {
    state.metadata = metadata; const current = await review();
    assert.match(current.version, /^[a-f0-9]{64}$/); assert.ok(Date.parse(current.expiresAt) > Date.now()); assert.ok(Date.parse(current.observedAt) <= Date.now());
  }
  for (const metadata of [{}, { stale: false }, { cachedAt: null }, { cachedAt: null, stale: true }, { cachedAt: 'not-a-date', stale: false }, { cachedAt: new Date(Date.now() - 301000).toISOString(), stale: false }, { cachedAt: new Date(Date.now() + 60000).toISOString(), stale: false }]) {
    state.metadata = metadata; assert.equal(await review(), null, JSON.stringify(metadata));
  }
  state.metadata = { cachedAt: null, stale: false };
  for (const detailOverrides of [{ profileId: 'other-profile' }, { accountId: 'other-connection' }, { platformAdAccountId: '9999999999' }, { platformCampaignId: 'another-campaign' }, { platformAdId: '222' }, { platform: 'facebook' }, { advertisingChannelType: 'DISPLAY' }]) {
    state.detailOverrides = detailOverrides; assert.equal((await invoke('ads/details?adId=rsa-ad')).status, 502);
  }
  assert.equal(state.writes.length, 0);
}));

test('RSA native ad identity cannot change between the reviewed snapshot and dispatch', () => fixture(async ({ state, ad, review, invoke }) => {
  const current = await review(), body = { adId: ad._id, expectedCreativeVersion: current.version, finalUrls: ['https://brand.example/changed'] };
  state.detailOverrides = { platformAdId: '222' };
  const mismatched = await invoke('ads/edit', body);
  assert.equal(mismatched.status, 502); assert.equal(mismatched.data.error.code, 'INVALID_PROVIDER_SCOPE');
  state.detailOverrides = {}; ad.platformAdId = '222';
  const changed = await invoke('ads/edit', body);
  assert.equal(changed.status, 409); assert.equal(changed.data.error.code, 'GOOGLE_CREATIVE_REVIEW_CHANGED');
  assert.notEqual((await review()).version, current.version, 'A new native ad with identical text needs its own reviewed version.');
  assert.equal(state.writes.length, 0, 'Neither a list/detail mismatch nor a changed native ad may reach the provider mutation.');
}));

test('RSA full-list edits preserve pins and all retained URLs, confirm readback and replay the same receipt', () => fixture(async ({ state, initial, review, invoke }) => {
  const current = await review(), body = { adId: 'rsa-ad', expectedCreativeVersion: current.version, headlines: ['Third headline', 'Pinned headline', 'Changed second headline'], finalUrls: ['https://brand.example/new', initial.finalUrls[1]] };
  const result = await invoke('ads/edit', body, 'rsa-success-receipt');
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.data.operation.status, 'complete');
  assert.deepEqual(state.writes[0], { headlines: [{ text: 'Third headline' }, { text: 'Pinned headline', pinnedField: 'HEADLINE_1' }, { text: 'Changed second headline' }], finalUrls: body.finalUrls });
  assert.deepEqual(state.creative.descriptions, initial.descriptions, 'An omitted description list keeps its text and pins.');
  assert.deepEqual(await invoke('ads/edit', body, 'rsa-success-receipt'), result); assert.equal(state.writes.length, 1);
  assert.equal(state.calls.filter(call => call.path === '/api/v1/ads/rsa-ad' && call.method === 'GET').length, 3, 'Review, pre-dispatch check and confirmed post-write readback all use the actual detail endpoint.');
}));

test('RSA structured lists can replace pinned text, move pins, unpin and remove entries after a current review', () => fixture(async ({ state, initial, review, invoke }) => {
  const headlines = [{ text: 'Replacement pinned headline', pinnedField: 'HEADLINE_3' }, { text: 'Second headline', pinnedField: 'HEADLINE_1' }, { text: 'Third headline' }, { text: 'Fourth headline' }];
  let body = { adId: 'rsa-ad', expectedCreativeVersion: (await review()).version, headlines, descriptions: [{ text: 'Pinned description' }, { text: 'Second description', pinnedField: 'DESCRIPTION_2' }] };
  let result = await invoke('ads/edit', body, 'rsa-structured-update');
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.deepEqual(state.writes[0], { headlines, descriptions: body.descriptions });
  assert.deepEqual(state.creative.finalUrls, initial.finalUrls, 'Every omitted destination remains unchanged.');
  assert.deepEqual(await invoke('ads/edit', body, 'rsa-structured-update'), result); assert.equal(state.writes.length, 1);
  body = { adId: 'rsa-ad', expectedCreativeVersion: (await review()).version, headlines: headlines.slice(1).map(({ text }) => ({ text })) };
  result = await invoke('ads/edit', body);
  assert.equal(result.status, 200, JSON.stringify(result)); assert.deepEqual(state.creative.headlines, [{ text: 'Second headline' }, { text: 'Third headline' }, { text: 'Fourth headline' }]);
  assert.deepEqual(state.creative.descriptions, [{ text: 'Pinned description' }, { text: 'Second description', pinnedField: 'DESCRIPTION_2' }]);
}));

test('RSA structured edits validate exact text, positions and complete lists before dispatch', () => fixture(async ({ state, initial, review, invoke }) => {
  const base = { adId: 'rsa-ad', expectedCreativeVersion: (await review()).version };
  for (const headlines of [
    [{ text: 'One' }, { text: 'Two' }],
    [{ text: 'Same' }, { text: 'Same' }, { text: 'Third' }],
    [{ text: 'x'.repeat(31) }, { text: 'Two' }, { text: 'Three' }],
    [{ text: 'One', pinnedField: 'DESCRIPTION_1' }, { text: 'Two' }, { text: 'Three' }],
    [{ text: 'One', pinnedField: '' }, { text: 'Two' }, { text: 'Three' }],
    [{ text: 'One', pinnedField: null }, { text: 'Two' }, { text: 'Three' }],
    [{ text: 'One', unknown: true }, { text: 'Two' }, { text: 'Three' }],
    [{ text: 'One' }, 'Two', { text: 'Three' }],
  ]) assert.equal((await invoke('ads/edit', { ...base, headlines })).status, 400, JSON.stringify(headlines));
  assert.equal((await invoke('ads/edit', { ...base, descriptions: [{ text: 'Description one', pinnedField: 'HEADLINE_1' }, { text: 'Description two' }] })).status, 400);
  assert.equal(state.writes.length, 0); assert.deepEqual(state.creative, initial);
  state.creative.headlines[0].pinnedField = 'HEADLINE_2';
  assert.equal((await invoke('ads/edit', { ...base, headlines: initial.headlines })).data.error.code, 'GOOGLE_CREATIVE_REVIEW_CHANGED');
  assert.equal(state.writes.length, 0, 'Pin-only provider changes invalidate the reviewed version.');
}));

test('RSA pin mismatches after an accepted write retain an uncertain receipt and block duplicate writes', () => fixture(async ({ state, review, invoke }) => {
  const body = { adId: 'rsa-ad', expectedCreativeVersion: (await review()).version, headlines: [{ text: 'Pinned headline' }, { text: 'Second headline' }, { text: 'Third headline', pinnedField: 'HEADLINE_2' }] };
  state.afterWrite = () => { state.creative.headlines[0].pinnedField = 'HEADLINE_1'; };
  const result = await invoke('ads/edit', body, 'rsa-pin-readback');
  assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(state.writes.length, 1);
  assert.equal((await invoke('ads/edit', body, 'rsa-pin-readback')).data.error.code, 'OPERATION_UNCERTAIN'); assert.equal(state.writes.length, 1);
  assert.equal((await invoke('ads/edit', body, 'rsa-pin-new-request')).data.error.code, 'OPERATION_UNCERTAIN'); assert.equal(state.writes.length, 1, 'A new key cannot blindly repeat the same unresolved request.');
}));

test('RSA edits reject missing or changed reviews, pinned removals, stale reads, and role or mapping races before mutation', () => fixture(async ({ state, review, invoke }) => {
  const current = await review(), body = { adId: 'rsa-ad', expectedCreativeVersion: current.version, headlines: ['Pinned headline', 'New second headline', 'Third headline'] };
  assert.equal((await invoke('ads/edit', { ...body, expectedCreativeVersion: undefined })).data.error.code, 'GOOGLE_CREATIVE_REVIEW_REQUIRED');
  assert.equal((await invoke('ads/edit', { ...body, expectedCreativeVersion: '0'.repeat(64) })).data.error.code, 'GOOGLE_CREATIVE_REVIEW_CHANGED');
  assert.equal((await invoke('ads/edit', { ...body, headlines: ['Replacement pin text', 'Second headline', 'Third headline'] })).data.error.code, 'GOOGLE_PINNED_TEXT_CHANGED');
  state.creative.descriptions[1].text = 'Changed in native Ads Manager';
  assert.equal((await invoke('ads/edit', body)).data.error.code, 'GOOGLE_CREATIVE_REVIEW_CHANGED');
  const refreshed = await review(); body.expectedCreativeVersion = refreshed.version;
  for (const metadata of [{}, { cachedAt: null, stale: true }, { cachedAt: new Date(Date.now() - 301000).toISOString(), stale: false }]) {
    state.metadata = metadata; assert.equal((await invoke('ads/edit', body)).data.error.code, 'GOOGLE_CREATIVE_NOT_CURRENT');
  }
  state.metadata = { cachedAt: null, stale: false };
  assert.equal((await invoke('ads/edit', body, undefined, 'viewer')).status, 403);
  state.afterDetail = () => { state.denied = true; };
  assert.equal((await invoke('ads/edit', body)).status, 403); state.denied = false;
  state.afterDetail = () => { state.remapped = true; };
  assert.equal((await invoke('ads/edit', body)).status, 409); state.remapped = false; state.afterDetail = null;
  state.detailOverrides = { accountId: 'other-connection' };
  assert.equal((await invoke('ads/edit', body)).status, 502); state.detailOverrides = {};
  assert.equal(state.writes.length, 0);
  state.metadata = {};
  assert.equal((await invoke('ads/ad-status', { adId: 'rsa-ad', status: 'paused' })).status, 200, 'A creative read outage must not block an independent delivery switch.');
}));

test('RSA unconfirmed creative or unreadable readback preserves an uncertain receipt without another write', async () => {
  for (const mode of ['no-application', 'lost-readback']) await fixture(async ({ state, review, invoke }) => {
    const current = await review(), body = { adId: 'rsa-ad', expectedCreativeVersion: current.version, finalUrls: ['https://brand.example/reviewed-change'] };
    state.apply = mode !== 'no-application'; state.loseReadback = mode === 'lost-readback';
    const result = await invoke('ads/edit', body, 'rsa-unknown-receipt');
    assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(state.writes.length, 1);
    assert.equal((await invoke('ads/edit', body, 'rsa-unknown-receipt')).status, 409); assert.equal(state.writes.length, 1);
  });
});
