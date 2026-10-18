import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/index.mjs';

test('HTTP account copies retain separate caption, DAM media, options, approvals and schedules through publication, edit, status and retry', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-account-posts-')), distDir = join(dataDir, 'dist');
  await mkdir(distDir); await writeFile(join(distDir, 'index.html'), '<title>Account publishing check</title>');
  const origin = 'http://127.0.0.1:3000', profileId = 'account-fixture-profile', app = createApp({ dataDir, distDir, appUrl: origin, env: { ZERNIO_API_KEY: 'account-fixture-key' } });
  const originalFetch = globalThis.fetch, writes = [], remotePosts = new Map(), groups = [], accounts = ['first', 'second'].map(id => ({ _id: id, platform: 'facebook', displayName: `Brand ${id}`, profileId, isActive: true }));
  let sequence = 0, ownerCookie, loseReceipt = false, validationHook;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.headers.Authorization, 'Bearer account-fixture-key');
    const method = options.method || 'GET', payload = options.body ? JSON.parse(options.body) : undefined; let result;
    if (url.pathname === '/api/v1/accounts') result = { accounts: [...accounts, { ...accounts[0], _id: 'foreign', profileId: 'other-project' }] };
    else if (url.pathname === '/api/v1/account-groups') result = { groups };
    else if (url.pathname === '/api/v1/profiles/' + profileId) result = { profile: { _id: profileId, name: 'Account publishing fixture', timezone: 'UTC' } };
    else if (url.pathname === '/api/v1/tools/validate/post') { if (validationHook) { const hook = validationHook; validationHook = null; hook(); } result = { valid: true, warnings: [] }; }
    else if (url.pathname === '/api/v1/posts' && method === 'POST') {
      writes.push({ method, payload });
      const remote = { ...payload, _id: `remote-${++sequence}`, status: payload.scheduledFor ? 'scheduled' : 'published', mediaItems: payload.mediaItems || [], platforms: payload.platforms.map(copy => ({ ...copy, status: payload.scheduledFor ? 'pending' : 'published' })) };
      remotePosts.set(remote._id, remote); result = { post: remote };
      if (loseReceipt) { loseReceipt = false; return new Response(JSON.stringify({ error: 'Synthetic response lost after acceptance' }), { status: 502 }); }
    } else if (url.pathname.startsWith('/api/v1/posts/')) {
      const parts = url.pathname.split('/'), remote = remotePosts.get(parts[4]); assert.ok(remote, 'Only fixture post IDs may be read or written.');
      if (method === 'GET') result = { post: remote };
      else if (method === 'PUT') { writes.push({ method, payload }); Object.assign(remote, payload, { status: payload.isDraft ? 'draft' : 'scheduled' }); result = { post: remote }; }
      else if (method === 'POST' && parts[5] === 'retry') { writes.push({ method, payload }); remote.status = 'publishing'; remote.platforms = remote.platforms.map(copy => copy.status === 'failed' ? { ...copy, status: 'pending' } : copy); result = { post: remote }; }
      else throw new Error(`Unexpected synthetic post write: ${method} ${url.pathname}`);
    } else throw new Error(`Unknown external request blocked: ${method} ${url.pathname}`);
    return new Response(JSON.stringify(result), { status: 200 });
  };
  await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, method = 'GET', body, key) {
    const response = await fetch(base + path, { method, headers: { ...(method !== 'GET' ? { Origin: origin } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(ownerCookie ? { Cookie: ownerCookie } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  try {
    const setup = await request('/api/auth/setup', 'POST', { name: 'Account publishing QA', email: 'account-publishing@example.test', password: 'synthetic publishing password long enough', sample: false }); assert.equal(setup.status, 201); ownerCookie = setup.cookie;
    const state = (await request('/api/state')).data, project = `/api/projects/${state.projectId}`, social = project + '/integrations/social';
    assert.equal((await request(project, 'PATCH', { zernioProfileId: profileId })).status, 200);
    const assetResult = await request(project + '/assets', 'POST', { name: 'Second brand creative', kind: 'image', url: 'https://cdn.example.test/account.jpg', deliveryUrl: 'https://cdn.example.test/account.jpg', approval: 'approved', width: 1080, height: 1080, size: 1000 }); assert.equal(assetResult.status, 201, JSON.stringify(assetResult.data)); const asset = assetResult.data.record;
    const fields = { content: '', platforms: ['facebook'], accounts: ['first', 'second'], mediaItems: [], platformOverrides: { facebook: { options: { firstComment: 'Platform comment' } } }, accountOverrides: { first: { platform: 'facebook', content: 'First brand caption', mediaItems: [], options: { firstComment: 'First brand comment' } }, second: { platform: 'facebook', content: '', assetId: asset.id, options: {} } } };
    async function draft(extra = {}) { const result = await request(project + '/posts', 'POST', { ...fields, ...extra }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.record; }
    async function approve(record) {
      const asked = await request(`${project}/approvals/posts/${record.id}/request`, 'POST', {}); assert.equal(asked.status, 200, JSON.stringify(asked.data));
      const approved = await request(`${project}/approvals/posts/${record.id}/review`, 'POST', { reviewId: asked.data.item.review.id, decision: 'approved', note: 'Reviewed each distinct account copy and fixed time.' }); assert.equal(approved.status, 200, JSON.stringify(approved.data)); return approved.data.item;
    }
    assert.equal((await request(project + '/approvals/policy', 'POST', { requireApproval: true })).status, 200);
    const immediate = await draft(), reviewed = await approve(immediate);
    assert.equal(reviewed.post.accountOverrides.first.content, fields.accountOverrides.first.content); assert.equal(reviewed.post.accountOverrides.second.content, ''); assert.equal(reviewed.post.accountOverrides.second.mediaItems[0].url, asset.deliveryUrl); assert.deepEqual(reviewed.post.accountOverrides.second.options, {});
    assert.equal((await request(project + '/assets/' + asset.id, 'DELETE')).status, 409, 'An account-only DAM reference prevents deleting the creative.');
    app.store.update(state.projectId, 'assets', asset.id, { deliveryUrl: 'https://cdn.example.test/changed.jpg' });
    let result = await request(social + '/publish', 'POST', { postId: immediate.id }, 'account-stale-asset'); assert.equal(result.status, 409); assert.equal(writes.length, 0, 'Changing account-only creative invalidates its approved publication.'); app.store.update(state.projectId, 'assets', asset.id, asset);
    result = await request(social + '/publish', 'POST', { postId: immediate.id }, 'account-immediate'); assert.equal(result.status, 200, JSON.stringify(result.data));
    let sent = writes.at(-1).payload; assert.equal(sent.publishNow, true); assert.equal(sent.platforms.length, 2);
    assert.equal(sent.platforms[0].customContent, fields.accountOverrides.first.content); assert.deepEqual(sent.platforms[0].customMedia, []); assert.deepEqual(sent.platforms[0].platformSpecificData, { firstComment: 'First brand comment' });
    assert.equal(sent.platforms[1].customContent, ''); assert.equal(sent.platforms[1].customMedia[0].url, asset.deliveryUrl); assert.deepEqual(sent.platforms[1].platformSpecificData, {});
    const beforeReplay = writes.length; assert.equal((await request(social + '/publish', 'POST', { postId: immediate.id }, 'account-immediate')).status, 200); assert.equal(writes.length, beforeReplay);
    const firstRemote = remotePosts.get(result.data.post.externalId); firstRemote.status = 'failed'; firstRemote.platforms = firstRemote.platforms.map(copy => ({ ...copy, status: 'failed' }));
    result = await request(social + '/status?postId=' + immediate.id); assert.equal(result.status, 200);
    result = await request(social + '/retry', 'POST', { postId: immediate.id, confirmPublish: true }, 'account-unchanged-approved-retry'); assert.equal(result.status, 200, 'Refreshing unchanged account copies must preserve their existing approval: ' + JSON.stringify(result.data));
    const timed = { ...fields.accountOverrides, second: { ...fields.accountOverrides.second, scheduledAt: '2070-02-02T09:00:00Z' } }, scheduled = await draft({ status: 'scheduled', scheduledAt: '2070-02-01T09:00:00Z', accountOverrides: timed }); await approve(scheduled);
    result = await request(social + '/publish', 'POST', { postId: scheduled.id }, 'account-schedule'); assert.equal(result.status, 200, JSON.stringify(result.data));
    sent = writes.at(-1).payload; assert.equal(sent.scheduledFor, '2070-02-01T09:00:00.000Z'); assert.equal(sent.platforms[1].scheduledFor, timed.second.scheduledAt); assert.equal(sent.platforms[0].scheduledFor, undefined);
    assert.equal(result.data.post.accountOverrides.second.scheduledAt, timed.second.scheduledAt); const remote = remotePosts.get(result.data.post.externalId);
    const ownTime = new Date(Date.now() + 3600000).toISOString(), expiring = await draft({ status: 'scheduled', scheduledAt: '2070-01-01T09:00:00Z', accountOverrides: { ...fields.accountOverrides, first: { ...fields.accountOverrides.first, scheduledAt: ownTime } } }); await approve(expiring);
    const realNow = Date.now, beforeExpired = writes.length; validationHook = () => { Date.now = () => Date.parse(ownTime) + 1000; };
    try { result = await request(social + '/publish', 'POST', { postId: expiring.id }, 'account-expiring-time'); } finally { Date.now = realNow; }
    assert.equal(result.status, 409, JSON.stringify(result.data)); assert.equal(writes.length, beforeExpired, 'An account schedule that expires during preflight must not reach the provider write.');
    const singleRemote = { _id: 'single-own-time', profileId, status: 'scheduled', content: 'Single-target upstream post', mediaItems: [], scheduledFor: '2070-03-01T09:00:00Z', platforms: [{ platform: 'facebook', accountId: 'first', status: 'scheduled', scheduledFor: '2070-03-02T09:00:00Z' }] }; remotePosts.set(singleRemote._id, singleRemote);
    const single = app.store.create(state.projectId, 'posts', { content: singleRemote.content, platforms: ['facebook'], accounts: ['first'], status: 'scheduled', scheduledAt: singleRemote.scheduledFor, mediaItems: [], externalId: singleRemote._id, zernioProfileId: profileId });
    result = await request(social + '/status?postId=' + single.id); assert.equal(result.status, 200); assert.equal(result.data.post.accountOverrides.first.scheduledAt, singleRemote.platforms[0].scheduledFor, 'A platform with one account still exposes its separate upstream time.');
    const recurrence = project + '/integrations/recycling/posts/' + single.id, detail = await request(recurrence); assert.equal(detail.status, 200); assert.equal(detail.data.canEnable, false); assert.match(detail.data.unavailable, /Separate account times/);
    result = await request(recurrence + '/review', 'POST', { expectedFingerprint: detail.data.fingerprint, confirmReview: true, configuration: { enabled: true, gap: 1, gapFreq: 'week', startDate: '2070-04-01T09:00:00Z', expireDate: null, expireCount: 3, contentVariations: [] } }); assert.equal(result.status, 422); assert.equal(writes.length, beforeExpired, 'Unsupported recurring account offsets are rejected before writes.');
    const updatedCopies = { first: { platform: 'facebook', content: 'Edited first account', mediaItems: [], options: {} }, second: { platform: 'facebook', content: 'Edited second account', mediaItems: [{ type: 'image', url: asset.deliveryUrl }], options: { firstComment: 'Second account only' }, scheduledAt: '2070-02-03T09:00:00Z' } };
    result = await request(social + '/update', 'POST', { postId: scheduled.id, content: 'Shared unchanged fallback', platformOverrides: {}, accountOverrides: updatedCopies, mode: 'scheduled', scheduledAt: '2070-02-01T09:00:00Z' }, 'account-edit'); assert.equal(result.status, 200, JSON.stringify(result.data));
    assert.equal(writes.at(-1).payload.platforms[0].customContent, updatedCopies.first.content); assert.equal(writes.at(-1).payload.platforms[1].customContent, updatedCopies.second.content); assert.equal(remote.platforms[1].scheduledFor, updatedCopies.second.scheduledAt);
    result = await request(social + '/status?postId=' + scheduled.id); assert.equal(result.status, 200); assert.equal(result.data.post.accountOverrides.first.content, updatedCopies.first.content); assert.equal(result.data.post.accountOverrides.second.content, updatedCopies.second.content);
    result = await request(social + '/update', 'POST', { postId: scheduled.id, mode: 'scheduled', scheduledAt: '2070-02-05T09:00:00Z' }, 'account-parent-reschedule'); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(remote.platforms[1].scheduledFor, updatedCopies.second.scheduledAt, 'Changing only the parent time preserves a separate account time.');
    result = await request(social + '/update', 'POST', { postId: scheduled.id, accountOverrides: { ...updatedCopies, second: { ...updatedCopies.second, scheduledAt: '' } }, mode: 'scheduled', scheduledAt: '2070-02-04T09:00:00Z' }, 'account-clear-time'); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.notEqual(remote.platforms[1].scheduledFor, updatedCopies.second.scheduledAt, 'An explicit inherited-time choice cannot retain the obsolete account time.');
    const beforeInvalid = writes.length;
    for (const overrides of [{ foreign: { platform: 'facebook', content: 'Wrong project' } }, { first: { platform: 'twitter', content: 'Wrong platform' } }]) { result = await request(social + '/validate', 'POST', { ...fields, accountOverrides: overrides }); assert.ok([400, 403, 422].includes(result.status), JSON.stringify(result)); }
    const queueTimed = await request(social + '/validate', 'POST', { ...fields, queueId: 'synthetic-queue', queueVersion: 'a'.repeat(64), accountOverrides: timed }); assert.ok(queueTimed.status >= 400); assert.equal(writes.length, beforeInvalid);
    remote.platforms.push({ ...structuredClone(remote.platforms[0]), customContent: 'Second destination on first account' });
    result = await request(social + '/update', 'POST', { postId: scheduled.id, accountOverrides: updatedCopies, mode: 'scheduled', scheduledAt: '2070-02-04T09:00:00Z' }, 'account-ambiguous-edit'); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'AMBIGUOUS_POST_DESTINATIONS'); assert.equal(writes.length, beforeInvalid); remote.platforms.pop();
    remote.status = 'failed'; remote.platforms = remote.platforms.map(copy => ({ ...copy, status: 'failed' }));
    result = await request(social + '/status?postId=' + scheduled.id); assert.equal(result.status, 200); await approve(result.data.post);
    result = await request(social + '/retry', 'POST', { postId: scheduled.id, confirmPublish: true }, 'account-retry'); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.post.accountOverrides.first.content, updatedCopies.first.content); assert.equal(result.data.post.accountOverrides.second.content, updatedCopies.second.content);
    const bulk = Array.from({ length: 25 }, (_, index) => ({ ...accounts[0], _id: `bulk-${index}`, displayName: `Campaign page ${index}` })); accounts.push(...bulk); groups.push({ _id: 'bulk-group', name: 'Twenty-five campaign pages', accountIds: bulk.map(row => row._id) });
    const overview = await request(project + '/integrations/admin/overview'); assert.equal(overview.status, 200, JSON.stringify(overview.data)); assert.equal(overview.data.groups[0].accountIds.length, 25);
    const groupDraft = await draft({ accounts: [...overview.data.groups[0].accountIds], accountOverrides: {} }); assert.equal(groupDraft.accounts.length, 25, 'A reviewed group larger than twenty accounts can be saved.'); groups[0].accountIds.pop();
    assert.equal(app.store.get(state.projectId, 'posts', groupDraft.id).accounts.length, 25, 'Later provider group edits do not alter saved explicit recipient IDs.');
    assert.equal((await request(project + '/posts', 'POST', { ...fields, accountOverrides: {}, accounts: Array.from({ length: 51 }, (_, index) => 'account-' + index) })).status, 400, 'Fifty-one recipients are rejected before publication.');
    const uncertain = await draft(); await approve(uncertain); loseReceipt = true;
    result = await request(social + '/publish', 'POST', { postId: uncertain.id }, 'account-uncertain'); assert.equal(result.status, 409, JSON.stringify(result.data)); assert.equal(result.data.error.code, 'OPERATION_UNCERTAIN'); const writesAfterLostReceipt = writes.length;
    result = await request(social + '/publish', 'POST', { postId: uncertain.id }, 'account-uncertain'); assert.ok(result.status >= 400); assert.equal(writes.length, writesAfterLostReceipt, 'Replaying an uncertain logical publication must not create another provider post.');
  } finally { globalThis.fetch = originalFetch; await new Promise(resolve => app.server.close(resolve)); app.db.close(); await rm(dataDir, { recursive: true, force: true }); }
});
