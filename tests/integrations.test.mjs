import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { generateKeyPairSync, verify } from 'node:crypto';
import { handleIntegration, providerRequest, scopedAccounts } from '../server/integrations.mjs';

test('shared connected-account reads reject unreadable labels and activity flags while preserving optional values and profile scope', async () => {
  const base = { _id: 'account-a', platform: 'whatsapp', profileId: 'profile-a' }, read = account => scopedAccounts(async () => ({ accounts: [account] }), 'profile-a');
  for (const key of ['displayName', 'username', 'name']) for (const value of [{ invalid: true }, ['invalid'], 1, true]) {
    await assert.rejects(read({ ...base, [key]: value }), error => error.status === 502 && error.code === 'INVALID_PROVIDER_RESPONSE', key);
  }
  for (const value of ['false', 0, {}]) await assert.rejects(read({ ...base, isActive: value }), error => error.status === 502 && error.code === 'INVALID_PROVIDER_RESPONSE');
  for (const optional of [{}, { displayName: null, username: null, name: null, isActive: null }, { displayName: 'Business', username: '', name: 'Legacy label', isActive: false }]) assert.deepEqual(await read({ ...base, ...optional }), [{ ...base, ...optional }]);
  assert.deepEqual(await scopedAccounts(async () => ({ accounts: [{ ...base, profileId: 'foreign-profile', displayName: {} }, base] }), 'profile-a'), [base]);
});

test('social lifecycle updates, cancellation, failed retry, published-copy edits and removal stay scoped and durable', async () => {
  const originalFetch = globalThis.fetch, db = new DatabaseSync(':memory:'), writes = [], records = new Map();
  const project = { id: 'social-project', zernioProfileId: 'profile-social' }, account = { _id: 'facebook-a', profileId: project.zernioProfileId, platform: 'facebook' };
  let remote = { _id: 'remote-social', status: 'scheduled', content: 'Original', scheduledFor: '2070-01-01T10:00:00Z', platforms: [{ platform: 'facebook', accountId: account._id, status: 'pending' }] }, mappedProfile = project.zernioProfileId, remapOnWrite = false, failedReadback = false;
  const store = {
    get(projectId, collection, id) { const record = records.get(id); return record?.projectId === projectId && collection === 'posts' ? { ...record } : null; },
    update(projectId, collection, id, data) { const record = this.get(projectId, collection, id); if (!record) return null; const result = { ...record, ...data }; records.set(id, result); return result; },
    activity() {},
  };
  const local = { id: 'local-post', projectId: project.id, externalId: remote._id, zernioProfileId: project.zernioProfileId, content: 'Original', status: 'scheduled' }; records.set(local.id, local);
  let keySequence = 0;
  async function invoke(path, body, { key = `lifecycle-${++keySequence}`, role = 'editor' } = {}) {
    let response; const method = body === undefined ? 'GET' : 'POST';
    await handleIntegration({ req: { method, headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${project.id}/integrations/${path}`), body: body || {}, project, role, db, store, config: { env: {}, ZERNIO_API_KEY: 'sk_private' }, assertProjectMapping(expected) { if (expected !== mappedProfile) throw new Error('Mapping changed'); }, send(status, data) { response = { status, data }; } }); return response;
  }
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target), method = options.method || 'GET'; let result;
    if (url.pathname === '/api/v1/tools/validate/post') return new Response(JSON.stringify({ valid: true, warnings: [] }));
    if (url.pathname === '/api/v1/accounts') result = { accounts: [account] };
    else if (url.pathname === '/api/v1/posts/remote-social' && method === 'GET') {
      if (failedReadback) throw new Error('Read unavailable'); result = { post: remote };
    } else {
      const payload = options.body ? JSON.parse(options.body) : undefined; writes.push({ url, method, payload, key: options.headers['Idempotency-Key'] });
      if (method === 'PUT') { remote = { ...remote, ...payload, status: payload.isDraft ? 'draft' : 'scheduled' }; result = { post: remote }; }
      else if (method === 'DELETE') result = { message: 'Post deleted successfully' };
      else if (url.pathname.endsWith('/retry')) { remote = { ...remote, status: 'publishing' }; result = { post: remote }; }
      else if (url.pathname.endsWith('/edit')) { remote = { ...remote, content: payload.content }; result = { success: true }; }
      else if (url.pathname.endsWith('/unpublish')) { remote = { ...remote, status: 'cancelled', platforms: remote.platforms.map(item => item.accountId === payload.accountId ? { ...item, status: 'cancelled' } : item) }; result = { success: true }; }
      else throw new Error('Unexpected provider path');
      if (remapOnWrite) mappedProfile = 'other-profile';
    }
    return new Response(JSON.stringify(result), { status: 200 });
  };
  try {
    let result = await invoke('social/update', { postId: local.id, content: 'Changed', mode: 'scheduled', scheduledAt: '2070-02-30T10:00:00Z' });
    assert.equal(result.status, 400); assert.equal(writes.length, 0);
    assert.equal((await invoke('social/update', { postId: local.id, content: 'Changed', mode: 'scheduled', scheduledAt: '2020-01-01T10:00:00Z' })).status, 409);
    assert.equal((await invoke('social/update', { postId: local.id, content: 'Changed', mode: 'draft', publishNow: true })).status, 400);
    result = await invoke('social/update', { postId: local.id, content: 'Changed', mode: 'scheduled', scheduledAt: '2070-02-28T10:00:00+04:00' }, { key: 'update-social-01' });
    assert.equal(result.status, 200); assert.deepEqual(writes.at(-1).payload, { content: 'Changed', isDraft: false, scheduledFor: '2070-02-28T06:00:00.000Z', timezone: 'UTC' }); assert.equal(writes.at(-1).method, 'PUT');
    const beforeReplay = writes.length;
    await invoke('social/update', { postId: local.id, content: 'Changed', mode: 'scheduled', scheduledAt: '2070-02-28T10:00:00+04:00' }, { key: 'update-social-01' }); assert.equal(writes.length, beforeReplay);
    result = await invoke('social/update', { postId: local.id, content: 'Draft text', mode: 'draft' }); assert.equal(result.status, 200); assert.equal(result.data.post.status, 'draft'); assert.equal(result.data.post.scheduledAt, ''); assert.deepEqual(writes.at(-1).payload, { content: 'Draft text', isDraft: true });
    assert.equal((await invoke('social/cancel', { postId: local.id })).status, 400);
    result = await invoke('social/cancel', { postId: local.id, confirmCancellation: true }, { key: 'cancel-social-01' }); assert.equal(result.status, 200); assert.equal(result.data.post.status, 'cancelled'); assert.ok(result.data.post.providerDeletedAt); assert.equal(writes.at(-1).method, 'DELETE');
    const cancelWrites = writes.length;
    await invoke('social/cancel', { postId: local.id, confirmCancellation: true }, { key: 'cancel-social-01' }); assert.equal(writes.length, cancelWrites);
    assert.equal((await invoke('social/status?postId=' + local.id)).data.provider.deleted, true);
    assert.equal((await invoke('social/retry', { postId: local.id, confirmPublish: true })).status, 409);
    records.set(local.id, { ...local, status: 'failed' }); remote = { ...remote, status: 'failed', platforms: [{ platform: 'facebook', accountId: account._id, status: 'failed' }] };
    assert.equal((await invoke('social/retry', { postId: local.id })).status, 400);
    result = await invoke('social/retry', { postId: local.id, confirmPublish: true }); assert.equal(result.status, 200); assert.equal(writes.at(-1).url.pathname, '/api/v1/posts/remote-social/retry');
    remote.status = 'published'; remote.platforms[0].status = 'published';
    assert.equal((await invoke('social/cancel', { postId: local.id, confirmCancellation: true })).status, 409);
    assert.equal((await invoke('social/update', { postId: local.id, content: 'Unsafe', mode: 'draft' })).status, 409);
    assert.equal((await invoke('social/edit-published', { postId: local.id, accountId: 'outside-account', content: 'Unsafe', confirmEdit: true })).status, 403);
    assert.equal((await invoke('social/edit-published', { postId: local.id, accountId: account._id, content: 'Live text', confirmEdit: true }, { role: 'viewer' })).status, 403);
    result = await invoke('social/edit-published', { postId: local.id, accountId: account._id, content: 'Live text', confirmEdit: true }); assert.equal(result.status, 200); assert.equal(result.data.post.content, 'Live text'); assert.deepEqual(writes.at(-1).payload, { platform: 'facebook', accountId: account._id, content: 'Live text' });
    remote.platforms[0].accountId = 'foreign-account'; const beforeForeign = writes.length;
    assert.equal((await invoke('social/unpublish', { postId: local.id, accountId: account._id, confirmRemoval: true })).status, 403); assert.equal(writes.length, beforeForeign); remote.platforms[0].accountId = account._id;
    remote.platforms[0].platform = 'instagram';
    assert.equal((await invoke('social/unpublish', { postId: local.id, accountId: account._id, confirmRemoval: true })).status, 502);
    account.platform = 'instagram';
    assert.equal((await invoke('social/unpublish', { postId: local.id, accountId: account._id, confirmRemoval: true })).status, 422); remote.platforms[0].platform = 'facebook'; account.platform = 'facebook';
    result = await invoke('social/unpublish', { postId: local.id, accountId: account._id, confirmRemoval: true }); assert.equal(result.status, 200); assert.equal(result.data.post.providerResults[0].status, 'cancelled');
    remote.status = 'scheduled'; remote.platforms[0].status = 'pending'; remapOnWrite = true;
    result = await invoke('social/update', { postId: local.id, content: 'Old mapping write', mode: 'draft' }); assert.equal(result.data.operation.status, 'uncertain'); assert.notEqual(records.get(local.id).content, 'Old mapping write');
    mappedProfile = project.zernioProfileId; remapOnWrite = false; remote.status = 'published'; remote.platforms[0].status = 'published';
    const beforeFailedReadback = globalThis.fetch;
    globalThis.fetch = async (target, options) => { const response = await beforeFailedReadback(target, options); if (new URL(target).pathname.endsWith('/edit')) failedReadback = true; return response; };
    result = await invoke('social/edit-published', { postId: local.id, accountId: account._id, content: 'Accepted without readback', confirmEdit: true }); assert.equal(result.data.operation.status, 'uncertain');
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test('provider contracts, tenant boundaries, durable retries, and private Drive metadata', async () => {
  const originalFetch = globalThis.fetch;
  const db = new DatabaseSync(':memory:');
  const records = new Map(); const calls = [];
  const store = {
    get(projectId, collection, id) { const record = records.get(id); return record?.projectId === projectId && record.collection === collection ? { ...record } : null; },
    list(projectId, collection) { return [...records.values()].filter(record => record.projectId === projectId && record.collection === collection); },
    create(projectId, collection, data) { const record = { ...data, projectId, collection, id: `local-${records.size}` }; records.set(record.id, record); return record; },
    update(projectId, collection, id, data) { const previous = this.get(projectId, collection, id); if (!previous) return null; const record = { ...previous, ...data }; records.set(id, record); return record; },
    activity() {},
  };
  const project = { id: 'project-a', workspaceId: 'workspace-a', zernioProfileId: 'profile-a', driveFolderId: 'folder_a' };
  const account = { _id: 'account-a', profileId: 'profile-a', platform: 'instagram', isActive: true };
  let provider = async (url, options) => {
    if (url.pathname.endsWith('/accounts')) return { accounts: [account, { ...account, _id: 'account-b', profileId: 'profile-b', accessToken: 'DO-NOT-EXPOSE' }] };
    throw new Error(`Unexpected request: ${url.pathname}`);
  };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); calls.push({ url, options });
    if (url.pathname === '/api/v1/tools/validate/post') return new Response(JSON.stringify({ valid: true, warnings: [] }));
    assert.equal(url.protocol, 'https:');
    assert.equal(options.redirect, 'error');
    const data = await provider(url, options);
    return data instanceof Response ? data : new Response(JSON.stringify(data), { status: 200 });
  };
  async function invoke(path, { method = 'GET', body = {}, key = 'request-0001', role = 'editor', selectedProject = project, config = { ZERNIO_API_KEY: 'sk_PRIVATE' } } = {}) {
    let response;
    const handled = await handleIntegration({ req: { method, headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${selectedProject.id}/integrations/${path}`), body, project: selectedProject, role, db, store, config, send(status, data) { response = { status, data }; } });
    assert.equal(handled, true); return response;
  }
  try {
    let result = await invoke('accounts');
    assert.deepEqual(result.data.accounts.map(item => item._id), ['account-a']);
    assert.equal(calls.at(-1).url.searchParams.get('profileId'), 'profile-a');
    assert.equal(JSON.stringify(result).includes('DO-NOT-EXPOSE'), false);
    const beforeUnmapped = calls.length;
    result = await invoke('accounts', { selectedProject: { ...project, zernioProfileId: '' } });
    assert.equal(result.status, 409); assert.equal(calls.length, beforeUnmapped);
    result = await invoke('social/publish', { method: 'POST', role: 'viewer' });
    assert.equal(result.status, 403);
    const missedSchedule = store.create(project.id, 'posts', { content: 'A scheduled announcement', platforms: ['instagram'], status: 'scheduled', scheduledAt: new Date(Date.now() - 60000).toISOString() });
    result = await invoke('social/publish', { method: 'POST', body: { postId: missedSchedule.id }, key: 'missed-time01' });
    assert.equal(result.data.error.code, 'SCHEDULE_PASSED');
    assert.equal(calls.some(call => call.options.method === 'POST'), false, 'A missed schedule must never become immediate publishing.');

    const post = store.create(project.id, 'posts', { content: 'Campaign launch', platforms: ['instagram'], accounts: ['account-b'], status: 'draft' });
    result = await invoke('social/publish', { method: 'POST', body: { postId: post.id }, key: 'scope-check' });
    assert.equal(result.status, 403);
    assert.equal(calls.some(call => call.options.method === 'POST'), false);
    store.update(project.id, 'posts', post.id, { accounts: ['account-a'], sample: true });
    result = await invoke('social/publish', { method: 'POST', body: { postId: post.id }, key: 'sample-check' });
    assert.equal(result.data.error.code, 'SAMPLE_RECORD');
    const creative = store.create(project.id, 'assets', { name: 'Launch', kind: 'image', url: 'https://cdn.example.com/launch.jpg' });
    store.update(project.id, 'posts', post.id, { sample: false, assetId: creative.id });
    let sends = 0;
    provider = async (url, options) => {
      if (url.pathname.endsWith('/accounts')) return { accounts: [account] };
      if (url.pathname === '/api/v1/posts') {
        sends++;
        assert.equal(options.headers.Authorization, 'Bearer sk_PRIVATE');
        assert.equal(options.headers['Idempotency-Key'], 'publish-0001');
        assert.deepEqual(JSON.parse(options.body), { content: 'Campaign launch', platforms: [{ platform: 'instagram', accountId: 'account-a' }], mediaItems: [{ type: 'image', url: 'https://cdn.example.com/launch.jpg' }], publishNow: true });
        return { post: { _id: 'remote-post-a', status: 'publishing', platforms: [{ accountId: 'account-a', status: 'pending' }] } };
      }
      throw new Error('Unexpected request');
    };
    result = await invoke('social/publish', { method: 'POST', body: { postId: post.id }, key: 'publish-0001' });
    assert.equal(result.status, 200); assert.equal(result.data.post.status, 'submitted');
    const replay = await invoke('social/publish', { method: 'POST', body: { postId: post.id }, key: 'publish-0001' });
    assert.deepEqual(replay, result); assert.equal(sends, 1);
    const other = store.create(project.id, 'posts', { content: 'Another post', platforms: ['instagram'], assetId: creative.id });
    result = await invoke('social/publish', { method: 'POST', body: { postId: other.id }, key: 'publish-0001' });
    assert.equal(result.data.error.code, 'IDEMPOTENCY_CONFLICT'); assert.equal(sends, 1);

    let ambiguousSends = 0;
    provider = async url => {
      if (url.pathname.endsWith('/accounts')) return { accounts: [account] };
      ambiguousSends++; throw new Error('secret credential from upstream must never be exposed');
    };
    result = await invoke('social/publish', { method: 'POST', body: { postId: other.id }, key: 'uncertain-01' });
    assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain');
    assert.equal(JSON.stringify(result).includes('secret credential'), false);
    result = await invoke('social/publish', { method: 'POST', body: { postId: other.id }, key: 'uncertain-01' });
    assert.equal(result.data.error.code, 'OPERATION_UNCERTAIN');
    await invoke('social/publish', { method: 'POST', body: { postId: other.id }, key: 'new-key-0001' });
    assert.equal(ambiguousSends, 1, 'A fresh action key must not bypass an uncertain publication.');

    const racePost = store.create(project.id, 'posts', { content: 'Submit exactly once', platforms: ['instagram'], assetId: creative.id });
    let reads = 0; let raceSends = 0; let releaseSecond;
    const secondReady = new Promise(resolve => { releaseSecond = resolve; });
    provider = async url => {
      if (url.pathname.endsWith('/accounts')) { if (++reads === 2) await secondReady; return { accounts: [account] }; }
      raceSends++; return { post: { _id: 'race-remote', status: 'publishing', platforms: [{ accountId: 'account-a' }] } };
    };
    const firstSubmission = invoke('social/publish', { method: 'POST', body: { postId: racePost.id }, key: 'race-first-01' });
    const secondSubmission = invoke('social/publish', { method: 'POST', body: { postId: racePost.id }, key: 'race-second-01' });
    assert.equal((await firstSubmission).status, 200); releaseSecond();
    assert.equal((await secondSubmission).data.error.code, 'POST_ALREADY_SUBMITTED');
    assert.equal(raceSends, 1, 'Re-read the post after asynchronous scope checks to prevent stale-snapshot duplicate publication.');

    provider = async url => {
      if (url.pathname.endsWith('/accounts')) return { accounts: [account] };
      if (url.pathname.endsWith('/ads/tree')) return { campaigns: [{ id: 'campaign-a', platform: 'instagram', profileId: project.zernioProfileId }], pagination: { pages: 1 } };
      throw new Error('Unexpected request');
    };
    const callsBeforeRemovedInbox = calls.length;
    result = await invoke('inbox/conversation-b/reply', { method: 'POST', body: { accountId: 'account-a', message: 'Hello' }, key: 'reply-00001' });
    assert.equal(result.status, 404); assert.equal(calls.length, callsBeforeRemovedInbox);
    assert.equal((await invoke('inbox')).status, 404); assert.equal(calls.length, callsBeforeRemovedInbox);
    result = await invoke('ads/status', { method: 'POST', body: { campaignId: 'campaign-b', platform: 'instagram', status: 'active' }, key: 'ad-status01' });
    assert.equal(result.status, 403);

    const metaAccount = { ...account, _id: 'meta-connection', platform: 'metaads' };
    const googleAccount = { ...account, _id: 'google-connection', platform: 'googleads' };
    const pinterestAccount = { ...account, _id: 'pinterest-connection', platform: 'pinterestads' };
    let adCreates = 0;
    provider = async (url, options) => {
      if (url.pathname.endsWith('/api/v1/accounts')) return { accounts: [metaAccount, googleAccount, pinterestAccount] };
      if (url.pathname.endsWith('/ads/accounts')) {
        assert.equal(url.searchParams.get('inScopeOnly'), 'true');
        return { accounts: [{ id: url.searchParams.get('accountId') === 'meta-connection' ? 'act_123' : 'native-123', currency: 'AED', selectable: true, minimumDailyBudget: 1 }] };
      }
      if (url.pathname.endsWith('/ads/create')) {
        adCreates++; const payload = JSON.parse(options.body);
        assert.equal(payload.platform, undefined, 'The provider infers network from accountId.');
        assert.equal(payload.budgetAmount, 20, 'Budgets are whole currency units.');
        assert.equal(payload.status, 'PAUSED', 'New ads default to held delivery.');
        if (payload.accountId === 'meta-connection') {
          assert.equal(payload.currency, 'AED'); assert.equal(payload.imageUrl, creative.url); assert.equal(payload.advantageAudience, 0);
        } else if (payload.accountId === 'google-connection' && payload.campaignType === 'search') {
          assert.equal(payload.currency, undefined); assert.equal(payload.imageUrl, undefined);
          assert.equal(payload.campaignType, 'search');
          assert.deepEqual(payload.additionalHeadlines, ['Explore the collection', 'Discover your next favorite']);
          assert.deepEqual(payload.additionalDescriptions, ['Find your next favorite in our new collection.']);
          assert.deepEqual(payload.keywords, ['new collection']);
        } else if (payload.accountId === 'google-connection') {
          assert.equal(payload.campaignType, 'display'); assert.equal(payload.businessName, 'Ten98');
          assert.deepEqual(payload.images, { landscape: 'https://cdn.example.com/wide.jpg', square: 'https://cdn.example.com/square.jpg' });
        } else assert.equal(payload.callToAction, undefined);
        return { ad: { _id: `remote-ad-${adCreates}`, platformCampaignId: `native-campaign-${adCreates}`, platform: payload.accountId === 'meta-connection' ? 'facebook' : payload.accountId === 'google-connection' ? 'google' : 'pinterest', status: 'pending_review' } };
      }
      throw new Error('Unexpected request');
    };
    const metaAd = { platform: 'facebook', accountId: 'meta-connection', adAccountId: 'act_123', name: 'Launch traffic', goal: 'traffic', budgetAmount: 20, headline: 'Campaign launch', body: 'Discover the new collection.', imageUrl: creative.url, linkUrl: 'https://example.com/collection', callToAction: 'LEARN_MORE', countries: ['AE'], currency: 'AED' };
    result = await invoke('ads/create', { method: 'POST', body: { ...metaAd, adAccountId: 'other-ad-account' }, key: 'ads-outside' });
    assert.equal(result.status, 403); assert.equal(adCreates, 0);
    result = await invoke('ads/create', { method: 'POST', body: { ...metaAd, currency: 'USD' }, key: 'ads-currency' });
    assert.equal(result.data.error.code, 'CURRENCY_MISMATCH'); assert.equal(adCreates, 0);
    result = await invoke('ads/create', { method: 'POST', body: metaAd, key: 'ads-meta-01' });
    assert.equal(result.data.campaign.platformCampaignId, 'native-campaign-1'); assert.equal(result.data.campaign.status, 'paused');
    assert.deepEqual(await invoke('ads/create', { method: 'POST', body: metaAd, key: 'ads-meta-01' }), result);
    assert.equal(adCreates, 1);
    const googleAd = { ...metaAd, platform: 'google', accountId: 'google-connection', adAccountId: 'native-123', campaignType: 'search', additionalHeadlines: ['Explore the collection', 'Discover your next favorite'], additionalDescriptions: ['Find your next favorite in our new collection.'], keywords: ['new collection'] };
    delete googleAd.callToAction; delete googleAd.imageUrl;
    result = await invoke('ads/create', { method: 'POST', body: { ...googleAd, additionalHeadlines: ['Campaign launch', 'Another headline'] }, key: 'ads-google-bad' });
    assert.equal(result.data.error.code, 'DUPLICATE_SEARCH_COPY'); assert.equal(adCreates, 1);
    result = await invoke('ads/create', { method: 'POST', body: googleAd, key: 'ads-google01' });
    assert.equal(result.status, 200); assert.equal(adCreates, 2);
    const pinterestAd = { ...metaAd, platform: 'pinterest', accountId: 'pinterest-connection', adAccountId: 'native-123' };
    delete pinterestAd.callToAction;
    result = await invoke('ads/create', { method: 'POST', body: pinterestAd, key: 'ads-pinterest01' });
    assert.equal(result.status, 200); assert.equal(adCreates, 3);
    const displayAd = { ...googleAd, campaignType: 'display', businessName: 'Ten98', images: { landscape: 'https://cdn.example.com/wide.jpg', square: 'https://cdn.example.com/square.jpg' } };
    delete displayAd.additionalHeadlines; delete displayAd.additionalDescriptions; delete displayAd.keywords;
    result = await invoke('ads/create', { method: 'POST', body: displayAd, key: 'ads-display01' });
    assert.equal(result.status, 200); assert.equal(adCreates, 4);

    const beforeConnect = calls.length;
    result = await invoke('connect?platform=instagram', { role: 'editor' });
    assert.equal(result.status, 403); assert.equal(calls.length, beforeConnect);
    provider = async url => {
      assert.equal(url.pathname, '/api/v1/connect/instagram');
      assert.equal(url.searchParams.get('profileId'), 'profile-a');
      const callback = new URL(url.searchParams.get('redirect_url'));
      assert.equal(callback.origin, 'https://campaign.example.com');
      assert.equal(callback.searchParams.get('view'), 'integrations');
      assert.equal(callback.searchParams.get('project'), project.id);
      return { authUrl: 'https://www.instagram.com/oauth/authorize?state=server-state' };
    };
    result = await invoke('connect?platform=instagram&redirect_url=https://evil.example', { role: 'admin', config: { ZERNIO_API_KEY: 'sk_PRIVATE', appUrl: 'https://campaign.example.com' } });
    assert.equal(result.data.authUrl, 'https://www.instagram.com/oauth/authorize?state=server-state');
    provider = async url => {
      assert.equal(url.pathname, '/api/v1/analytics/dashboard');
      assert.equal(url.searchParams.get('profileId'), 'profile-a');
      assert.equal(url.searchParams.get('fromDate'), '2026-10-01');
      assert.equal(url.searchParams.get('toDate'), '2026-10-17');
      return { data: { totals: { impressions: 42 }, followers: { current: null }, daily: [], dataAsOf: '2026-10-17T00:00:00Z' } };
    };
    result = await invoke('analytics/dashboard?fromDate=2026-10-01&toDate=2026-10-17');
    assert.equal(result.data.totals.impressions, 42); assert.equal(result.data.totals.clicks, undefined); assert.equal(result.data.followers.current, null);

    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    let driveRevision = '1'.repeat(32);
    const driveConfig = { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'service@example.iam.gserviceaccount.com', GOOGLE_PRIVATE_KEY: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
    provider = async (url, options) => {
      if (url.hostname === 'oauth2.googleapis.com') {
        const assertion = new URLSearchParams(options.body).get('assertion');
        const [header, claims, signature] = assertion.split('.');
        assert.equal(verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature, 'base64url')), true);
        assert.equal(JSON.parse(Buffer.from(claims, 'base64url')).scope, 'https://www.googleapis.com/auth/drive');
        return { access_token: 'GOOGLE_PRIVATE_TOKEN' };
      }
      assert.equal(url.pathname, '/drive/v3/files');
      assert.equal(url.searchParams.get('q'), "'folder_a' in parents and trashed = false");
      assert.equal(options.headers.Authorization, 'Bearer GOOGLE_PRIVATE_TOKEN');
      return { files: [{ id: 'drive-image', name: 'Creative', mimeType: 'image/png', webViewLink: 'https://drive.google.com/file/d/drive-image/view', size: '64', modifiedTime: '2026-10-01T10:00:00Z', md5Checksum: driveRevision }] };
    };
    result = await invoke('drive/sync', { method: 'POST', config: driveConfig });
    assert.equal(result.data.synced, 1); assert.equal(result.data.assets[0].source, 'google-drive');
    assert.equal(JSON.stringify(result).includes('GOOGLE_PRIVATE_TOKEN'), false);
    const syncedAsset = result.data.assets[0];
    store.update(project.id, 'assets', syncedAsset.id, { approval: 'approved', deliveryUrl: 'https://cdn.example.com/delivery.png', tags: ['brand'] });
    await invoke('drive/sync', { method: 'POST', config: driveConfig });
    assert.equal(store.list(project.id, 'assets').filter(asset => asset.source === 'google-drive').length, 1, 'Drive sync upserts metadata.');
    assert.equal(store.get(project.id, 'assets', syncedAsset.id).approval, 'approved', 'An unchanged Drive file keeps its reviewed approval.');
    driveRevision = '2'.repeat(32); await invoke('drive/sync', { method: 'POST', config: driveConfig });
    const revisedAsset = store.get(project.id, 'assets', syncedAsset.id);
    assert.equal(revisedAsset.approval, 'pending', 'A changed Drive file must be reviewed again.');
    assert.equal(revisedAsset.deliveryUrl, 'https://cdn.example.com/delivery.png'); assert.deepEqual(revisedAsset.tags, ['brand']);

    let uploaded = 0;
    provider = async (url, options) => {
      if (url.hostname === 'oauth2.googleapis.com') return { access_token: 'GOOGLE_PRIVATE_TOKEN' };
      if (url.pathname === '/drive/v3/files/folder_a') return { id: 'folder_a', mimeType: 'application/vnd.google-apps.folder', driveId: 'shared-drive' };
      assert.equal(url.pathname, '/upload/drive/v3/files');
      assert.equal(url.searchParams.get('uploadType'), 'multipart');
      assert.ok(Buffer.isBuffer(options.body));
      assert.match(options.body.toString(), /"parents":\["folder_a"\]/);
      assert.match(options.body.toString(), /Content-Type: text\/plain/);
      assert.match(options.body.toString(), /Creative notes/); uploaded++;
      return { id: 'drive-upload', name: 'notes.txt', mimeType: 'text/plain', size: '14' };
    };
    result = await invoke('drive/upload', { method: 'POST', body: { name: 'notes.txt', mimeType: 'text/plain', contentBase64: Buffer.from('Creative notes').toString('base64') }, key: 'drive-upload01', config: driveConfig });
    assert.equal(result.status, 200); assert.equal(result.data.asset.driveId, 'drive-upload');
    assert.equal(uploaded, 1);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test('advanced ad formats, paused creation, scoped edits, live switches and published-post boosts', async () => {
  const originalFetch = globalThis.fetch, db = new DatabaseSync(':memory:'), writes = [], records = [];
  const project = { id: 'project-a', zernioProfileId: 'profile-a' };
  const accounts = ['metaads', 'googleads', 'linkedinads', 'tiktokads', 'xads', 'openaiads', 'redditads', 'pinterestads', 'facebook'].map(platform => ({ _id: platform, platform, profileId: 'profile-a', isActive: true }));
  const store = { create(projectId, collection, data) { const value = { ...data, projectId, collection, id: `local-${records.length}` }; records.push(value); return value; }, get(projectId, collection, id) { return records.find(item => item.id === id && item.projectId === projectId && item.collection === collection); }, list(projectId, collection) { return records.filter(item => item.projectId === projectId && item.collection === collection); }, update(projectId, collection, id, data) { const value = this.get(projectId, collection, id); Object.assign(value, data); return value; }, activity() {} };
  const campaign = { platformCampaignId: 'native-campaign', platform: 'facebook', profileId: 'profile-a', currency: 'AED', status: 'paused', adSets: [{ platformAdSetId: 'native-set', adSetName: 'Website visitors', budget: { amount: 20, type: 'daily' } }] };
  let currentAd = { _id: 'ad-in-project', platform: 'facebook', profileId: 'profile-a', platformCampaignId: campaign.platformCampaignId, status: 'paused', configuredStatus: 'ACTIVE', creative: {} }, uncertainCreate = false, confirmStatus = true, mappedProfile = 'profile-a', remapAt = '';
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target), payload = options.body ? JSON.parse(options.body) : undefined;
    if (options.method && options.method !== 'GET') writes.push({ url, options, payload });
    let result;
    if (url.pathname === '/api/v1/accounts') result = { accounts: [...accounts, { _id: 'outside', platform: 'metaads', profileId: 'profile-b' }] };
    else if (url.pathname === '/api/v1/ads/accounts') result = { accounts: [{ id: 'native-account', currency: 'AED', selectable: true }] };
    else if (url.pathname === '/api/v1/ads/create' || url.pathname === '/api/v1/ads/boost') {
      assert.equal(payload.status, 'PAUSED'); assert.equal(payload.platform, undefined); assert.ok(options.headers['Idempotency-Key']);
      if (uncertainCreate) throw new Error('Connection timed out after upload');
      result = { ad: { _id: `created-${writes.length}`, platformCampaignId: `campaign-${writes.length}`, status: 'pending_review', platform: payload.accountId === 'metaads' ? 'facebook' : payload.accountId === 'xads' ? 'twitter' : payload.accountId.replace(/ads$/, '') } };
    } else if (url.pathname === '/api/v1/ads/tree') { assert.equal(url.searchParams.get('profileId'), 'profile-a'); result = { campaigns: [campaign], pagination: { pages: 1 } }; }
    else if (url.pathname === '/api/v1/ads' && !payload) { assert.equal(url.searchParams.get('profileId'), 'profile-a'); result = { ads: [currentAd, { ...currentAd, _id: 'ad-outside', profileId: 'profile-b' }], pagination: { pages: 1 } }; }
    else if (url.pathname === '/api/v1/ads/ad-in-project' && !payload) { assert.equal(url.searchParams.get('live'), 'true'); result = { ad: currentAd, statusReadAt: '2026-10-18T00:00:00Z' }; }
    else if (url.pathname === '/api/v1/ads/ad-in-project') result = { ad: { ...currentAd, ...payload } };
    else if (url.pathname === '/api/v1/ads/ad-in-project/status') result = { configuredStatus: confirmStatus ? payload.status.toUpperCase() : null, status: 'paused', updated: 1 };
    else if (url.pathname === '/api/v1/ads/campaigns/native-campaign/status') result = { platformCampaignStatus: confirmStatus ? payload.status.toUpperCase() : null, statusReadAt: confirmStatus ? '2026-10-18T00:00:00Z' : null, status: payload.status, updated: 1, skipped: 0 };
    else if (url.pathname === '/api/v1/ads/ad-sets/native-set') { if (payload.name) campaign.adSets[0].adSetName = payload.name; if (payload.budget) campaign.adSets[0].budget = payload.budget; result = { updated: 1, ...payload }; }
    else if (url.pathname === '/api/v1/ads/campaigns/native-campaign') result = { updated: 1, ...payload };
    else if (url.pathname === '/api/v1/posts/remote-published') result = { post: { _id: 'remote-published', status: 'published', platforms: [{ platform: 'facebook', accountId: 'facebook', status: 'published' }] } };
    else if (url.pathname === '/api/v1/ads/targeting/search') { assert.equal(url.searchParams.get('accountId'), 'metaads'); assert.equal(url.searchParams.get('adAccountId'), 'native-account'); result = { results: [{ id: '6001', name: 'Design', type: 'interest' }] }; }
    else if (url.pathname === '/calendar/v3/calendars/calendar/events/event' && options.method === 'DELETE') return new Response(null, { status: 204 });
    else throw new Error(`Unexpected endpoint ${url.pathname}`);
    if (url.pathname === remapAt) mappedProfile = 'profile-b';
    return new Response(JSON.stringify(result), { status: 200 });
  };
  let key = 0;
  async function invoke(path, body, requestKey) {
    let response;
    await handleIntegration({ req: { method: body === undefined ? 'GET' : 'POST', headers: { 'idempotency-key': requestKey || `advanced-action-${++key}` } }, url: new URL('http://localhost/api/projects/project-a/integrations/' + path), body: body || {}, project, role: 'editor', db, store, config: { ZERNIO_API_KEY: 'PRIVATE_KEY' }, assertProjectMapping(expected) { if (mappedProfile !== expected) throw new Error('Project mapping changed'); }, send(status, data) { response = { status, data }; } });
    return response;
  }
  const base = { platform: 'facebook', accountId: 'metaads', adAccountId: 'native-account', name: 'Autumn launch', goal: 'traffic', budgetAmount: 20, budgetType: 'daily', headline: 'Explore new arrivals', body: 'Find your next favorite.', linkUrl: 'https://example.com/collection', imageUrl: 'https://cdn.example.com/image.jpg', callToAction: 'LEARN_MORE', countries: ['AE'], currency: 'AED' };
  const clean = (platform, accountId) => { const value = { ...base, platform, accountId }; delete value.callToAction; delete value.imageUrl; return value; };
  try {
    const metaVideo = { ...base, video: { url: 'https://cdn.example.com/video.mp4' } }; delete metaVideo.imageUrl;
    assert.equal((await invoke('ads/create', metaVideo)).status, 200);
    assert.deepEqual(writes.at(-1).payload.video, metaVideo.video);
    const carousel = { ...base, carouselCards: [{ imageUrl: 'https://cdn.example.com/one.jpg', headline: 'Card one' }, { imageUrl: 'https://cdn.example.com/two.jpg', headline: 'Card two', linkUrl: 'https://example.com/two' }] }; delete carousel.imageUrl;
    assert.equal((await invoke('ads/create', carousel)).status, 200);
    assert.deepEqual(writes.at(-1).payload.carouselCards, carousel.carouselCards);
    const assetGroup = { finalUrl: base.linkUrl, headlines: ['New arrivals', 'Shop the collection', 'Made for everyday'], descriptions: ['Discover the new collection.', 'Find your next favorite today.'], longHeadline: 'Discover the newest collection, designed for everyday life.', businessName: 'Ten98', images: { landscape: ['https://cdn.example.com/wide.jpg'], square: ['https://cdn.example.com/square.jpg'], logo: ['https://cdn.example.com/logo.png'] }, youtubeVideoId: 'dQw4w9WgXcQ' };
    const pmax = { platform: 'google', accountId: 'googleads', adAccountId: 'native-account', name: 'Performance campaign', budgetAmount: 20, countries: ['AE'], campaignType: 'pmax', assetGroup };
    assert.equal((await invoke('ads/create', pmax)).status, 200); assert.deepEqual(writes.at(-1).payload.assetGroup, assetGroup); assert.equal(writes.at(-1).payload.headline, undefined); assert.equal(writes.at(-1).payload.goal, undefined);
    const demandGen = { finalUrl: base.linkUrl, businessName: 'Ten98', headlines: ['Discover new arrivals'], descriptions: ['Explore thoughtful designs.'], images: { logo: ['https://cdn.example.com/logo.png'], square: ['https://cdn.example.com/square.jpg'] } };
    const demand = { ...pmax, campaignType: 'demand_gen', demandGen }; delete demand.assetGroup;
    assert.equal((await invoke('ads/create', demand)).status, 200);
    const demandVideo = { ...demand, demandGen: { ...demandGen, images: { logo: demandGen.images.logo }, youtubeVideoIds: ['dQw4w9WgXcQ'], longHeadlines: ['Discover the newest collection'], channels: ['youtube_shorts'] } };
    assert.equal((await invoke('ads/create', demandVideo)).status, 200); assert.deepEqual(writes.at(-1).payload.demandGen.youtubeVideoIds, ['dQw4w9WgXcQ']);
    const demandCarousel = { ...demand, demandGen: { ...demandGen, images: { logo: demandGen.images.logo }, carouselCards: carousel.carouselCards.map(card => ({ headline: card.headline, images: { landscape: card.imageUrl } })) } };
    assert.equal((await invoke('ads/create', demandCarousel)).status, 200);
    for (const [platform, connection] of [['linkedin', 'linkedinads'], ['twitter', 'xads'], ['openai', 'openaiads'], ['reddit', 'redditads']]) {
      const ad = { ...clean(platform, connection), imageUrl: base.imageUrl };
      assert.equal((await invoke('ads/create', ad)).status, 200, platform);
      assert.equal(writes.at(-1).payload.imageUrl, base.imageUrl);
    }
    const linkedVideo = { ...clean('linkedin', 'linkedinads'), goal: 'video_views', organizationId: 'urn:li:organization:123', video: metaVideo.video };
    assert.equal((await invoke('ads/create', linkedVideo)).status, 200);
    const tikTok = { ...clean('tiktok', 'tiktokads'), goal: 'video_views', imageUrl: 'https://cdn.example.com/video.mp4' };
    assert.equal((await invoke('ads/create', tikTok)).status, 200); assert.equal(writes.at(-1).payload.headline, undefined);
    const redditVideo = { ...clean('reddit', 'redditads'), video: { ...metaVideo.video, thumbnailUrl: base.imageUrl } };
    assert.equal((await invoke('ads/create', redditVideo)).status, 200);
    const redditCarousel = { ...clean('reddit', 'redditads'), carouselCards: carousel.carouselCards };
    assert.equal((await invoke('ads/create', redditCarousel)).status, 200);
    const redditText = { ...clean('reddit', 'redditads'), creativeFormat: 'text' }; delete redditText.linkUrl;
    assert.equal((await invoke('ads/create', redditText)).status, 200); assert.equal(writes.at(-1).payload.creativeFormat, undefined); assert.equal(writes.at(-1).payload.linkUrl, undefined);
    const conversion = { ...base, goal: 'conversions', promotedObject: { pixelId: '123', customEventType: 'PURCHASE' }, targeting: { ageMin: 25, ageMax: 55, gender: 'female', languages: ['en'] } };
    assert.equal((await invoke('ads/create', conversion)).status, 200); assert.deepEqual(writes.at(-1).payload.targeting, conversion.targeting);
    const lead = { ...base, goal: 'lead_generation', leadGenFormId: 'lead-form' }; delete lead.linkUrl;
    assert.equal((await invoke('ads/create', lead)).status, 200); assert.equal(writes.at(-1).payload.leadGenFormId, 'lead-form');
    assert.equal((await invoke('ads/create', { ...clean('openai', 'openaiads'), imageUrl: base.imageUrl, goal: 'awareness', bidStrategy: 'LOWEST_COST_WITH_BID_CAP', bidAmount: 1.5 })).status, 200);

    for (const invalid of [
      { ...metaVideo, imageUrl: base.imageUrl }, { ...base, status: 'ACTIVE' }, { ...base, rawTargeting: {} }, { ...base, startDate: '2027-02-30T12:00:00Z' },
      { ...conversion, promotedObject: {} }, { ...lead, leadGenFormId: '' }, { ...base, accountId: 'outside' },
      { ...base, targeting: { ageMin: 50, ageMax: 20 } }, { ...tikTok, budgetAmount: 19 },
      { ...pmax, assetGroup: { ...assetGroup, images: { landscape: assetGroup.images.landscape } } },
      { ...demandVideo, demandGen: { ...demandVideo.demandGen, youtubeVideoIds: ['not-valid'] } },
      { ...demandCarousel, demandGen: { ...demandCarousel.demandGen, carouselCards: [demandCarousel.demandGen.carouselCards[0]] } },
      { ...clean('openai', 'openaiads'), imageUrl: base.imageUrl, targeting: { ageMin: 18 } },
    ]) {
      const before = writes.length, localBefore = records.length, operationsBefore = db.prepare('SELECT COUNT(*) AS count FROM integration_operations').get().count;
      const result = await invoke('ads/create', invalid);
      assert.ok(result.status >= 400, JSON.stringify(invalid)); assert.equal(writes.length, before, 'Invalid format must never call a paid mutation.'); assert.equal(records.length, localBefore); assert.equal(db.prepare('SELECT COUNT(*) AS count FROM integration_operations').get().count, operationsBefore, 'Validation failures must not persist an operation.');
    }
    const once = await invoke('ads/create', metaVideo, 'durable-video-01'); assert.equal(once.status, 200); const sent = writes.length;
    assert.deepEqual(await invoke('ads/create', metaVideo, 'durable-video-01'), once); assert.equal(writes.length, sent);
    uncertainCreate = true;
    assert.equal((await invoke('ads/create', { ...metaVideo, name: 'Uncertain upload' }, 'uncertain-video-01')).data.operation.status, 'uncertain');
    const uncertainSent = writes.length;
    assert.equal((await invoke('ads/create', { ...metaVideo, name: 'Uncertain upload' }, 'uncertain-video-02')).data.error.code, 'OPERATION_UNCERTAIN'); assert.equal(writes.length, uncertainSent); uncertainCreate = false;

    let result = await invoke('ads/items?campaignId=native-campaign&platform=facebook'); assert.equal(result.status, 200); assert.deepEqual(result.data.ads.map(ad => ad._id), ['ad-in-project']);
    campaign.profileId = 'profile-b'; result = await invoke('ads'); assert.equal(result.status, 502); assert.equal(result.data.error.code, 'INVALID_PROVIDER_SCOPE'); assert.equal(result.data.campaigns, undefined);
    delete campaign.profileId; result = await invoke('ads'); assert.equal(result.status, 502); assert.equal(result.data.error.code, 'INVALID_PROVIDER_SCOPE'); campaign.profileId = 'profile-a';
    result = await invoke('ads/details?adId=ad-outside'); assert.equal(result.status, 403);
    assert.equal((await invoke('ads/details?adId=ad-in-project')).status, 200);
    const beforeOutside = writes.length;
    assert.equal((await invoke('ads/edit', { adId: 'ad-outside', creative: { body: 'Wrong tenant' } })).status, 403); assert.equal(writes.length, beforeOutside);
    assert.equal((await invoke('ads/edit', { adId: currentAd._id, creative: { body: 'Updated copy' }, targeting: { countries: ['AE', 'SA'] } })).status, 200);
    assert.deepEqual(writes.at(-1).payload, { creative: { body: 'Updated copy' }, targeting: { countries: ['AE', 'SA'] } });
    currentAd = { ...currentAd, platform: 'google', advertisingChannelType: 'SEARCH' };
    assert.equal((await invoke('ads/edit', { adId: currentAd._id, headlines: ['One headline', 'Second headline', 'Third headline'], descriptions: ['One description', 'Another description'], finalUrls: ['https://example.com/new'] })).status, 200);
    assert.deepEqual(writes.at(-1).payload.headlines, [{ text: 'One headline' }, { text: 'Second headline' }, { text: 'Third headline' }]);
    const beforeWrongChannel = writes.length;
    assert.equal((await invoke('ads/edit', { adId: currentAd._id, assetGroup })).status, 400); assert.equal(writes.length, beforeWrongChannel);
    currentAd = { ...currentAd, advertisingChannelType: 'PERFORMANCE_MAX' };
    assert.equal((await invoke('ads/edit', { adId: currentAd._id, assetGroup: { headlines: assetGroup.headlines, images: { logo: assetGroup.images.logo } } })).status, 200);
    assert.deepEqual(writes.at(-1).payload, { assetGroup: { headlines: assetGroup.headlines, images: { logo: assetGroup.images.logo } } }, 'Asset edits replace only the supplied roles.');
    currentAd = { ...currentAd, advertisingChannelType: 'DEMAND_GEN' };
    assert.equal((await invoke('ads/edit', { adId: currentAd._id, demandGen: { youtubeVideoIds: ['dQw4w9WgXcQ'], longHeadlines: ['The newest collection'] } })).status, 200);
    const beforeCardEdit = writes.length;
    assert.equal((await invoke('ads/edit', { adId: currentAd._id, demandGen: { carouselCards: demandCarousel.demandGen.carouselCards } })).status, 400); assert.equal(writes.length, beforeCardEdit, 'Demand Gen cards are create-only.');
    assert.equal((await invoke('ads/ad-status', { adId: currentAd._id, status: 'active' })).status, 200, 'Delivery can stay paused under a paused campaign while the ad switch is active.');
    currentAd = { ...currentAd, status: 'rejected' };
    const beforeTerminal = writes.length;
    assert.equal((await invoke('ads/ad-status', { adId: currentAd._id, status: 'active' })).status, 409); assert.equal(writes.length, beforeTerminal);
    assert.equal((await invoke('ads/status', { campaignId: 'native-campaign', platform: 'facebook', status: 'active' })).status, 200);
    for (const platform of ['pinterest', 'linkedin', 'twitter']) {
      campaign.platform = platform; confirmStatus = false;
      result = await invoke('ads/status', { campaignId: 'native-campaign', platform, status: 'active' });
      assert.equal(result.status, 200); assert.equal(result.data.verification, 'unavailable'); assert.equal(result.data.requestedStatus, 'active'); assert.equal(result.data.result.platformCampaignStatus, null); assert.equal(result.data.operation.status, 'complete');
    }
    campaign.platform = 'facebook';
    confirmStatus = false;
    assert.equal((await invoke('ads/status', { campaignId: 'native-campaign', platform: 'facebook', status: 'paused' }, 'unconfirmed-switch-01')).data.operation.status, 'uncertain');
    const unconfirmed = writes.length;
    assert.equal((await invoke('ads/status', { campaignId: 'native-campaign', platform: 'facebook', status: 'paused' }, 'unconfirmed-switch-02')).data.error.code, 'OPERATION_UNCERTAIN'); assert.equal(writes.length, unconfirmed); confirmStatus = true;
    assert.equal((await invoke('ads/adset', { campaignId: 'native-campaign', platform: 'facebook', adSetId: 'other-set', name: 'Outside' })).status, 403);
    assert.equal((await invoke('ads/adset', { campaignId: 'native-campaign', platform: 'facebook', adSetId: 'native-set', name: 'New audience name', budget: { amount: 25, type: 'daily' } })).status, 200);
    assert.deepEqual(writes.at(-1).payload, { platform: 'facebook', name: 'New audience name', budget: { amount: 25, type: 'daily' } });
    const beforeWrongBudgetLevel = writes.length;
    assert.equal((await invoke('ads/campaign', { campaignId: 'native-campaign', platform: 'facebook', budget: { amount: 30, type: 'daily' } })).status, 422); assert.equal(writes.length, beforeWrongBudgetLevel);
    campaign.platform = 'google';
    assert.equal((await invoke('ads/campaign', { campaignId: 'native-campaign', platform: 'google', budget: { amount: 30, type: 'daily' } })).status, 200);
    assert.deepEqual(writes.at(-1).payload, { platform: 'google', budget: { amount: 30, type: 'daily' } }); campaign.platform = 'facebook';
    const published = store.create(project.id, 'posts', { content: 'Published launch', status: 'published', externalId: 'remote-published', zernioProfileId: project.zernioProfileId });
    const boost = { platform: 'facebook', accountId: 'facebook', adAccountId: 'native-account', name: 'Boost launch', goal: 'engagement', budgetAmount: 20, countries: ['AE'], postId: published.id };
    assert.equal((await invoke('ads/boost', boost)).status, 200); assert.equal(writes.at(-1).url.pathname, '/api/v1/ads/boost'); assert.equal(writes.at(-1).payload.postId, 'remote-published');
    const beforeBadBoost = writes.length;
    assert.equal((await invoke('ads/boost', { ...boost, postId: 'outside-project' })).status, 400); assert.equal(writes.length, beforeBadBoost);
    assert.equal((await invoke('ads/targeting?accountId=metaads&adAccountId=native-account&dimension=interest&q=design')).status, 200);
    assert.deepEqual(await providerRequest('https://www.googleapis.com/calendar/v3/calendars/calendar/events/event', { method: 'DELETE' }, 'Google Calendar'), {});
    remapAt = '/api/v1/ads/create';
    const beforeRemap = records.length;
    result = await invoke('ads/create', { ...metaVideo, name: 'Remapped while accepted' });
    assert.equal(result.data.operation.status, 'uncertain'); assert.equal(records.length, beforeRemap, 'A successful old-connection write must not persist into the remapped project.');
    mappedProfile = 'profile-a'; remapAt = '/api/v1/ads';
    result = await invoke('ads/items?campaignId=native-campaign&platform=facebook');
    assert.equal(result.status, 409); assert.equal(result.data.error.code, 'PROJECT_CONNECTION_CHANGED'); assert.equal(result.data.ads, undefined);
    mappedProfile = 'profile-a'; remapAt = '';
  } finally { globalThis.fetch = originalFetch; db.close(); }
});
