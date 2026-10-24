import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/database.ts';
import { handleApprovals, assertPublishingApproval, assertProviderPostEdit, recordApprovedReschedule } from '../server/approvals.ts';
import { blockWrites, postgresSkip, singleConnection, testDatabase } from './postgres.mjs';

test('content approval policy binds current posts and creative to audited review requests and enforces role and project boundaries', { skip: postgresSkip }, async t => {
  const { db, pool, sql } = await testDatabase(t);
  await pool.query("INSERT INTO users (id, name, email) VALUES ('owner','Workspace owner','owner@example.test'),('admin','Reviewer','admin@example.test'),('editor','Author','editor@example.test'),('viewer','Reader','viewer@example.test'); INSERT INTO workspaces (id, name) VALUES ('w','W'); INSERT INTO projects (id, workspace_id, name) VALUES ('project-a','w','A'),('project-b','w','B'); INSERT INTO memberships VALUES ('w','owner','owner'),('w','admin','admin'),('w','editor','editor'),('w','viewer','viewer')");
  const store = createStore(db), project = { id: 'project-a' }, foreignProject = { id: 'project-b' };
  const context = (role = 'editor', selectedProject = project) => ({ db, store, project: selectedProject, role, user: { id: role, name: { owner: 'Workspace owner', admin: 'Reviewer', editor: 'Author', viewer: 'Reader' }[role] } });
  async function invoke(path, { method = 'GET', body = {}, role = 'editor', selectedProject = project } = {}) {
    let result;
    const handled = await handleApprovals({ ...context(role, selectedProject), req: { method }, url: new URL(`http://localhost/api/projects/${selectedProject.id}/approvals/${path}`), body, send(status, data) { result = { status, data }; } });
    assert.equal(handled, true); return result;
  }
  const post = await store.create(project.id, 'posts', { content: 'Reviewed campaign text', platforms: ['facebook'], accounts: ['brand-account-a'], status: 'draft', mediaItems: [], scheduledAt: '2027-01-20T10:00:00Z', approvalStatus: 'approved', approvedBy: 'forged-owner' });
  const asset = await store.create(project.id, 'assets', { name: 'Creative', kind: 'image', url: 'https://cdn.example.test/creative.jpg', deliveryUrl: 'https://cdn.example.test/delivery.jpg', approval: 'approved', size: 100, modifiedTime: '2026-10-18T09:00:00Z', md5Checksum: 'old-checksum', tags: ['brand'] });
  const foreignPost = await store.create(foreignProject.id, 'posts', { content: 'OTHER_PROJECT_PRIVATE_TEXT', platforms: ['instagram'], status: 'draft' });
  const assertRejected = (selectedPost, code, role = 'editor') => assert.rejects(async () => assertPublishingApproval(context(role), await selectedPost), error => error.code === code);
  const current = () => store.get(project.id, 'posts', post.id);
  const item = async () => (await invoke('posts')).data.posts.find(row => row.post.id === post.id);
  const requestReview = () => invoke(`posts/${post.id}/request`, { method: 'POST' });
  const review = (reviewId, decision = 'approved', options = {}) => invoke(`posts/${post.id}/review`, { method: 'POST', role: 'admin', body: { reviewId, decision, note: 'Reviewed against the brief.' }, ...options });
  {
    assert.deepEqual((await invoke('policy', { role: 'viewer' })).data, { requireApproval: false, requireAdApproval: false, updatedBy: null, updatedAt: null });
    await assert.doesNotReject(async () => assertPublishingApproval(context(), (await current())));
    assert.equal((await invoke('policy', { method: 'POST', role: 'viewer', body: { requireApproval: true } })).status, 403);
    assert.equal((await invoke('policy', { method: 'POST', body: { requireApproval: true } })).status, 403);
    assert.equal((await invoke('policy', { method: 'POST', role: 'owner', body: { requireApproval: 'yes' } })).status, 400);
    assert.equal((await invoke('policy', { method: 'POST', role: 'owner', body: { requireApproval: true, approvedBy: 'editor' } })).status, 400);
    let result = await invoke('policy', { method: 'POST', role: 'owner', body: { requireApproval: true } });
    assert.equal(result.status, 200); assert.equal(result.data.requireApproval, true); assert.equal(result.data.updatedBy, 'owner'); assert.ok(result.data.updatedAt);
    await assertRejected((await current()), 'PUBLISHING_APPROVAL_REQUIRED'); await assertRejected((await current()), 'PUBLISHING_APPROVAL_REQUIRED', 'owner');
    assert.equal((await item()).status, 'not_requested', 'Client-forged approval metadata cannot bypass the authoritative review table.');
    assert.equal(JSON.stringify((await invoke('posts', { role: 'viewer' })).data).includes('OTHER_PROJECT_PRIVATE_TEXT'), false);
    assert.equal((await invoke(`posts/${foreignPost.id}/request`, { method: 'POST' })).status, 404);
    assert.equal((await invoke(`posts/${post.id}/request`, { method: 'POST', role: 'viewer' })).status, 403);
    assert.equal((await invoke(`posts/${post.id}/request`, { method: 'POST', body: { fingerprint: 'forged' } })).status, 400);
    result = await requestReview(); assert.equal(result.status, 200); assert.equal(result.data.item.status, 'pending');
    const firstReviewId = result.data.item.review.id;
    assert.equal(result.data.item.review.requestedBy.id, 'editor'); assert.equal(result.data.item.review.requestedBy.name, 'Author'); assert.ok(result.data.item.review.requestedAt);
    assert.equal((await requestReview()).data.item.review.id, firstReviewId, 'Repeated identical review requests do not add duplicate pending reviews.');
    assert.equal((await review(firstReviewId, 'approved', { role: 'editor' })).status, 403);
    assert.equal((await review(firstReviewId, 'approved', { role: 'viewer' })).status, 403);
    assert.equal((await review(firstReviewId, 'approved', { body: { decision: 'approved', note: '' } })).status, 400);
    result = await review(firstReviewId); assert.equal(result.status, 200); assert.equal(result.data.item.status, 'approved');
    assert.equal(result.data.item.review.reviewedBy.id, 'admin'); assert.ok(result.data.item.review.reviewedAt); assert.equal(result.data.item.review.note, 'Reviewed against the brief.');
    await assert.doesNotReject(async () => assertPublishingApproval(context(), (await current())));
    assert.equal((await review(firstReviewId)).status, 409, 'A completed review cannot silently change its decision.');
    const originalPost = (await current());
    await store.update(project.id, 'posts', post.id, { accountOverrides: {} }); await assert.doesNotReject(async () => assertPublishingApproval(context(), (await current())), 'Empty account customizations keep legacy approval fingerprints unchanged.');
    for (const changed of [{ tags: ['changed keywords'] }, { content: 'Changed copy' }, { platforms: ['instagram'] }, { accounts: ['another-brand-account'] }, { mediaItems: [{ type: 'image', url: 'https://cdn.example.test/new.jpg' }] }, { campaignId: 'changed-campaign' }, { accountOverrides: { 'brand-account-a': { platform: 'facebook', content: 'Account caption', options: {}, mediaItems: [] } } }]) {
      // A time-only move is covered by the #125 test below.
      await store.update(project.id, 'posts', post.id, changed); await assertRejected((await current()), 'PUBLISHING_APPROVAL_STALE'); assert.equal((await item()).status, 'stale'); await store.update(project.id, 'posts', post.id, originalPost);
    }
    await store.update(project.id, 'posts', post.id, { assetId: asset.id }); await assertRejected((await current()), 'PUBLISHING_APPROVAL_STALE');
    const assetReview = (await requestReview()).data.item.review.id; assert.equal((await review(assetReview)).status, 200); await assert.doesNotReject(async () => assertPublishingApproval(context(), (await current())));
    const originalAsset = await store.get(project.id, 'assets', asset.id);
    for (const changed of [{ url: 'https://cdn.example.test/new-original.jpg' }, { deliveryUrl: 'https://cdn.example.test/new-delivery.jpg' }, { kind: 'video' }, { size: 200 }, { modifiedTime: '2026-10-18T12:00:00Z' }, { md5Checksum: 'changed-checksum' }]) {
      await store.update(project.id, 'assets', asset.id, changed); await assertRejected((await current()), 'PUBLISHING_APPROVAL_STALE'); await store.update(project.id, 'assets', asset.id, originalAsset);
    }
    await store.update(project.id, 'assets', asset.id, { name: 'Cosmetic rename', tags: ['new-tag'], updatedAt: '2026-10-18T12:00:00Z' });
    await assert.doesNotReject(async () => assertPublishingApproval(context(), (await current())), 'Cosmetic asset edits preserve approval.');
    await store.update(project.id, 'assets', asset.id, { approval: 'pending' }); await assertRejected((await current()), 'APPROVAL_ASSET_REQUIRED');
    const pendingAssetReview = (await requestReview()).data.item.review.id;
    assert.equal((await review(pendingAssetReview)).status, 409); assert.equal((await review(pendingAssetReview, 'rejected')).status, 200);
    await store.update(project.id, 'assets', asset.id, originalAsset);
    await store.update(project.id, 'posts', post.id, { assetId: '', accountOverrides: { 'brand-account-a': { platform: 'facebook', content: '', assetId: asset.id, options: {}, scheduledAt: '2027-01-22T10:00:00Z' } } });
    const accountRequest = await requestReview(), accountCopy = accountRequest.data.item.post.accountOverrides['brand-account-a'];
    assert.equal(accountCopy.content, ''); assert.equal(accountCopy.mediaItems[0].url, originalAsset.deliveryUrl); assert.deepEqual(accountCopy.options, {}); assert.equal(accountCopy.scheduledAt, '2027-01-22T10:00:00Z');
    assert.equal((await review(accountRequest.data.item.review.id)).status, 200);
    await store.update(project.id, 'assets', asset.id, { deliveryUrl: 'https://cdn.example.test/changed-account-asset.jpg' }); await assertRejected((await current()), 'PUBLISHING_APPROVAL_STALE'); await store.update(project.id, 'assets', asset.id, originalAsset);
    await store.update(project.id, 'posts', post.id, { assetId: asset.id, accountOverrides: {} });
    const reRequested = (await requestReview()).data.item.review.id; assert.notEqual(reRequested, pendingAssetReview);
    assert.equal((await review(pendingAssetReview)).status, 409, 'An old rendered review ID cannot approve a newer request.');
    assert.equal((await review(reRequested)).status, 200);
    const beforeEdit = (await current()); await store.update(project.id, 'posts', post.id, { content: 'Edited after provider preflight began' });
    await assertRejected(beforeEdit, 'APPROVAL_POST_CHANGED');
    const changedPending = (await requestReview()).data.item.review.id; await store.update(project.id, 'posts', post.id, { content: 'Edited again during administrator review' });
    assert.equal((await review(changedPending)).status, 409, 'Reviewing a stale content fingerprint fails closed.');
    const newestPending = (await requestReview()).data.item.review.id; assert.equal((await review(changedPending)).status, 409); assert.equal((await review(newestPending)).status, 200);
    await assert.rejects(async () => assertProviderPostEdit(context()), error => error.code === 'APPROVED_PROVIDER_EDIT_RESTRICTED');
    await assert.rejects(async () => assertProviderPostEdit(context('viewer')), error => error.status === 403);
    await assert.doesNotReject(async () => assertProviderPostEdit(context('owner'))); await assert.doesNotReject(async () => assertProviderPostEdit(context('admin')));
    await store.update(project.id, 'posts', post.id, { externalId: 'remote-post-id' });
    assert.equal((await item()).status, 'submitted'); assert.equal((await requestReview()).status, 409); await assert.doesNotReject(async () => assertPublishingApproval(context(), (await current())), 'An approved failed provider post may be retried if its reviewed content is unchanged.');
    await store.update(project.id, 'posts', post.id, { status: 'failed', providerResults: [{ accountId: 'brand-account-a', status: 'failed' }], content: 'Changed in provider dashboard, then reconciled by status refresh', mediaItems: [{ type: 'image', url: 'https://cdn.example.test/provider-edited.jpg' }] });
    assert.equal((await item()).status, 'stale'); assert.equal((await item()).post.providerFailed, true); await assertRejected((await current()), 'PUBLISHING_APPROVAL_STALE');
    const failedReview = (await requestReview()).data.item.review.id; assert.equal((await review(failedReview)).status, 200);
    await assert.doesNotReject(async () => assertPublishingApproval(context(), { ...(await current()), content: 'Changed in provider dashboard, then reconciled by status refresh', mediaItems: [{ type: 'image', url: 'https://cdn.example.test/provider-edited.jpg' }] }), 'A fully failed provider post can receive a fresh approval for its reconciled content before retry.');
    await assertRejected({ ...(await current()), content: 'Another provider edit not yet reconciled' }, 'APPROVAL_POST_CHANGED');
    await store.update(project.id, 'posts', post.id, { providerResults: [{ status: 'failed' }, { status: 'published' }] }); assert.equal((await requestReview()).status, 409); assert.equal((await item()).status, 'submitted');
    await store.update(project.id, 'posts', post.id, { providerResults: [{ status: 'publishing' }] }); assert.equal((await requestReview()).status, 409);
    await store.update(project.id, 'posts', post.id, { providerResults: [] }); assert.equal((await requestReview()).status, 409, 'A failed aggregate without verified copy outcomes is insufficient for review.');
    await store.update(project.id, 'posts', post.id, { externalId: '', providerResults: [], status: 'draft', mediaItems: [] });
    const sample = await store.create(project.id, 'posts', { content: 'Sample', status: 'draft', sample: true }); assert.equal((await invoke(`posts/${sample.id}/request`, { method: 'POST' })).status, 409);
    await assertRejected({ ...(await current()), id: foreignPost.id }, 'APPROVAL_POST_NOT_FOUND');
    result = await invoke('policy', { method: 'POST', role: 'admin', body: { requireApproval: false } }); assert.equal(result.status, 200);
    await store.update(project.id, 'posts', post.id, { content: 'Optional review permits a new unreviewed draft' }); await assert.doesNotReject(async () => assertPublishingApproval(context(), (await current()))); await assert.doesNotReject(async () => assertProviderPostEdit(context()));
    const prepared = { ...(await current()), mediaItems: [{ type: originalAsset.kind, url: originalAsset.deliveryUrl }] };
    await store.update(project.id, 'assets', asset.id, { deliveryUrl: 'https://cdn.example.test/changed-during-preflight.jpg' });
    await assertRejected(prepared, 'APPROVAL_POST_CHANGED', 'owner');
    assert.equal((await invoke('policy', { selectedProject: foreignProject })).data.requireApproval, false);
    const hostedAsset = await store.create(project.id, 'assets', { name: 'Hosted delivery', kind: 'image', url: 'https://drive.google.com/file/d/original/view', deliveryUrl: 'https://media.zernio.com/temp/approved.png', approval: 'approved', deliverySource: 'zernio', deliveryUploadedAt: '2026-10-19T00:00:00Z', deliveryExpiresAt: '2026-10-26T00:00:00Z', deliveryKey: 'temp/approved.png', deliveryAttemptId: 'upload-one', deliveryKind: 'image', deliveryMimeType: 'image/png', deliverySize: 100, deliveryFilename: 'approved.png' });
    await store.update(project.id, 'posts', post.id, { assetId: hostedAsset.id });
    await invoke('policy', { method: 'POST', role: 'owner', body: { requireApproval: true } });
    assert.equal((await review((await requestReview()).data.item.review.id)).status, 200);
    for (const changed of [{ deliveryExpiresAt: '2026-10-27T00:00:00Z' }, { deliveryUploadedAt: '2026-10-20T00:00:00Z' }, { deliveryKey: 'temp/replaced.png' }, { deliveryAttemptId: 'upload-two' }, { deliverySize: 200 }, { deliveryMimeType: 'image/webp' }, { deliveryKind: 'video' }, { deliveryFilename: 'replacement.png' }]) {
      await store.update(project.id, 'assets', hostedAsset.id, changed); await assertRejected((await current()), 'PUBLISHING_APPROVAL_STALE'); await store.update(project.id, 'assets', hostedAsset.id, hostedAsset);
    }
    assert.ok((await sql.get('SELECT count(*) AS count FROM post_approval_reviews WHERE project_id=? AND post_id=?', project.id, post.id)).count >= 5);
    assert.ok((await sql.all('SELECT message FROM activity WHERE project_id=?', project.id)).some(row => row.message.includes('Content approved by Reviewer')));
  }
});

test('parallel review requests open one pending review and a parallel approve and reject record one decision', { skip: postgresSkip }, async t => {
  const { db, pool, sql } = await testDatabase(t);
  await pool.query("INSERT INTO users (id, name, email) VALUES ('admin','Reviewer','admin@example.test'),('editor','Author','editor@example.test'); INSERT INTO workspaces (id, name) VALUES ('w','W'); INSERT INTO projects (id, workspace_id, name) VALUES ('project-a','w','A'); INSERT INTO memberships VALUES ('w','admin','admin'),('w','editor','editor')");
  const store = createStore(db), project = { id: 'project-a' };
  const post = await store.create(project.id, 'posts', { content: 'Race fixture', platforms: ['facebook'], accounts: ['brand-account-a'], status: 'draft', mediaItems: [] });
  const invoke = async (path, role, body = {}) => { let result; await handleApprovals({ db, store, project, role, user: { id: role, name: role }, req: { method: 'POST' }, url: new URL(`http://localhost/api/projects/${project.id}/approvals/${path}`), body, send(status, data) { result = { status, data }; } }); return result; };
  // Both requests see no pending review before either inserts; only the per-post lock keeps them to one.
  let gate = await blockWrites(pool, 'post_approval_reviews');
  const requests = [invoke(`posts/${post.id}/request`, 'editor'), invoke(`posts/${post.id}/request`, 'editor')];
  await gate.waiting(2); await gate.release();
  assert.deepEqual((await Promise.all(requests)).map(result => result.status), [200, 200]);
  const pending = await sql.all("SELECT id FROM post_approval_reviews WHERE post_id = ? AND status = 'pending'", post.id);
  assert.equal(pending.length, 1);
  // Both decisions pass the pending check before either writes; only the conditional update keeps one decision.
  gate = await blockWrites(pool, 'post_approval_reviews');
  const decisions = ['approved', 'rejected'].map(decision => invoke(`posts/${post.id}/review`, 'admin', { reviewId: pending[0].id, decision, note: 'Parallel decision.' }));
  await gate.waiting(2); await gate.release();
  assert.deepEqual((await Promise.all(decisions)).map(result => result.status).sort(), [200, 409]);
  const decided = await sql.all('SELECT status FROM post_approval_reviews WHERE post_id = ?', post.id);
  assert.equal(decided.length, 1); assert.ok(['approved', 'rejected'].includes(decided[0].status));
});

// Council decision ten98-code-system#30: self-review is refused unless the requester is the single active owner/admin.
async function selfReviewFixture(t, members, poolOptions) {
  const { db, pool, sql } = await testDatabase(t, poolOptions);
  await pool.query("INSERT INTO users (id, name, email) VALUES ('blair','Blair Owner','blair@example.test'),('avery','Avery Admin','avery@example.test'),('casey','Casey Editor','casey@example.test'),('dana','Dana Admin','dana@example.test'),('abe','Abe Admin','abe@example.test'); INSERT INTO workspaces (id, name) VALUES ('w','W'); INSERT INTO projects (id, workspace_id, name) VALUES ('project-a','w','A')");
  const addMember = (id, role) => pool.query('INSERT INTO memberships VALUES ($1, $2, $3)', ['w', id, role]);
  for (const [id, role] of members) await addMember(id, role);
  const store = createStore(db), project = { id: 'project-a' }, roles = Object.fromEntries(members);
  const names = { blair: 'Blair Owner', avery: 'Avery Admin', casey: 'Casey Editor', dana: 'Dana Admin', abe: 'Abe Admin' };
  async function invoke(path, userId, body = {}) {
    let result;
    await handleApprovals({ db, store, project, role: roles[userId], user: { id: userId, name: names[userId] }, req: { method: 'POST' }, url: new URL(`http://localhost/api/projects/${project.id}/approvals/${path}`), body, send(status, data) { result = { status, data }; } });
    return result;
  }
  const post = await store.create(project.id, 'posts', { content: 'Self-review fixture', platforms: ['facebook'], accounts: ['brand-account-a'], status: 'draft', mediaItems: [] });
  const request = async userId => { const result = await invoke(`posts/${post.id}/request`, userId); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.item.review.id; };
  const review = (userId, reviewId, decision = 'approved') => invoke(`posts/${post.id}/review`, userId, { reviewId, decision, note: 'Checked.' });
  const stored = reviewId => sql.get('SELECT status, self_approved FROM post_approval_reviews WHERE id = ?', reviewId);
  const setPolicy = async (userId, requireApproval) => assert.equal((await invoke('policy', userId, { requireApproval })).status, 200);
  return { db, pool, sql, store, project, post, roles, addMember, invoke, request, review, stored, setPolicy };
}

test('with approval required, a requester cannot approve their own review while another owner or administrator is active', { skip: postgresSkip }, async t => {
  const f = await selfReviewFixture(t, [['blair', 'owner'], ['avery', 'admin']]);
  await f.setPolicy('blair', true);
  const reviewId = await f.request('avery');
  let result = await f.review('avery', reviewId);
  assert.equal(result.status, 403); assert.equal(result.data.error.code, 'APPROVAL_SELF_REVIEW');
  assert.match(result.data.error.message, /Blair Owner/); assert.doesNotMatch(result.data.error.message, /Avery Admin/, 'The error names only the other eligible reviewers.');
  assert.deepEqual(await f.stored(reviewId), { status: 'pending', self_approved: false });
  result = await f.review('blair', reviewId); assert.equal(result.status, 200);
  assert.equal(result.data.item.review.reviewedBy.id, 'blair'); assert.equal(result.data.item.review.selfApproved, false);
  assert.deepEqual(await f.stored(reviewId), { status: 'approved', self_approved: false });
  await f.store.update(f.project.id, 'posts', f.post.id, { content: 'Withdrawn by its requester' });
  const withdrawn = await f.request('avery');
  result = await f.review('avery', withdrawn, 'rejected'); assert.equal(result.status, 200, 'A requester may still reject (withdraw) their own request.');
  assert.deepEqual(await f.stored(withdrawn), { status: 'rejected', self_approved: false });
  await f.setPolicy('blair', false);
  await f.store.update(f.project.id, 'posts', f.post.id, { content: 'Optional review keeps the previous behaviour' });
  const optional = await f.request('avery');
  result = await f.review('avery', optional); assert.equal(result.status, 200, 'Without required approval self-review is unchanged.'); assert.equal(result.data.item.review.selfApproved, false);
  assert.deepEqual(await f.stored(optional), { status: 'approved', self_approved: false });
});

test('the single active owner or administrator may approve their own request, which is recorded as a self-approval', { skip: postgresSkip }, async t => {
  const f = await selfReviewFixture(t, [['blair', 'owner'], ['casey', 'editor']]);
  await f.setPolicy('blair', true);
  const reviewId = await f.request('blair');
  const result = await f.review('blair', reviewId);
  assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.item.status, 'approved'); assert.equal(result.data.item.review.selfApproved, true);
  assert.deepEqual(await f.stored(reviewId), { status: 'approved', self_approved: true });
  assert.ok((await f.sql.all('SELECT message FROM activity WHERE project_id = ?', f.project.id)).some(row => row.message === 'Content self-approved by Blair Owner (only administrator).'));
});

test('the self-approval exception counts active owners and administrators at review time, not at request time', { skip: postgresSkip }, async t => {
  const f = await selfReviewFixture(t, [['blair', 'owner'], ['casey', 'editor']]);
  await f.setPolicy('blair', true);
  const reviewId = await f.request('blair');
  await f.addMember('dana', 'admin');
  let result = await f.review('blair', reviewId);
  assert.equal(result.status, 403); assert.equal(result.data.error.code, 'APPROVAL_SELF_REVIEW'); assert.match(result.data.error.message, /: Dana Admin\.$/);
  await f.addMember('abe', 'admin');
  result = await f.review('blair', reviewId);
  assert.equal(result.status, 403); assert.match(result.data.error.message, /: Abe Admin, Dana Admin\.$/, 'Eligible reviewers are listed in name order.');
  assert.deepEqual(await f.stored(reviewId), { status: 'pending', self_approved: false });
});

// Council decision ten98-code-system#30 (Q2 amendment): a submitted post takes a review of a proposed provider update.
async function proposalFixture(t, members, poolOptions) {
  const { db, pool, sql } = await testDatabase(t, poolOptions), originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  await pool.query("INSERT INTO users (id, name, email) VALUES ('blair','Blair Owner','blair@example.test'),('avery','Avery Admin','avery@example.test'),('casey','Casey Editor','casey@example.test'); INSERT INTO workspaces (id, name) VALUES ('w','W'); INSERT INTO projects (id, workspace_id, name, zernio_profile_id) VALUES ('project-a','w','A','profile-a')");
  for (const [id, role] of members) await pool.query('INSERT INTO memberships VALUES ($1, $2, $3)', ['w', id, role]);
  const store = createStore(db), project = { id: 'project-a', zernioProfileId: 'profile-a' }, roles = Object.fromEntries(members), names = { blair: 'Blair Owner', avery: 'Avery Admin', casey: 'Casey Editor' };
  const account = { _id: 'facebook-a', profileId: project.zernioProfileId, platform: 'facebook' }, remote = { _id: 'remote-a', status: 'scheduled', content: 'Live caption', scheduledFor: '2070-01-01T09:00:00Z', platforms: [{ platform: 'facebook', accountId: account._id, status: 'pending' }] };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target), method = options.method || 'GET';
    if (method === 'GET' && url.pathname === '/api/v1/accounts') return new Response(JSON.stringify({ accounts: [account] }), { status: 200 });
    if (method === 'GET' && url.pathname === '/api/v1/posts/remote-a') return new Response(JSON.stringify({ post: remote }), { status: 200 });
    throw new Error(`Unexpected provider call ${method} ${url.pathname}`);
  };
  async function invoke(path, userId, body = {}) {
    let result;
    await handleApprovals({ db, store, project, role: roles[userId], user: { id: userId, name: names[userId] }, config: { env: {}, ZERNIO_API_KEY: 'sk_test_stub' }, assertProjectMapping: async () => {}, req: { method: 'POST' }, url: new URL(`http://localhost/api/projects/${project.id}/approvals/${path}`), body, send(status, data) { result = { status, data }; } });
    return result;
  }
  const post = await store.create(project.id, 'posts', { content: 'Live caption', platforms: ['facebook'], accounts: [account._id], status: 'scheduled', scheduledAt: remote.scheduledFor, mediaItems: [] });
  await store.update(project.id, 'posts', post.id, { externalId: remote._id, zernioProfileId: project.zernioProfileId });
  assert.equal((await invoke('policy', members.find(([, role]) => role === 'owner')[0], { requireApproval: true })).status, 200);
  const request = (userId, body) => invoke(`posts/${post.id}/request`, userId, body);
  const review = (userId, reviewId, decision = 'approved') => invoke(`posts/${post.id}/review`, userId, { reviewId, decision, note: 'Checked the proposed update.' });
  const stored = reviewId => sql.get('SELECT status, note, requested_by, self_approved FROM post_approval_reviews WHERE id = ?', reviewId);
  const count = async () => Number((await sql.get('SELECT count(*) AS count FROM post_approval_reviews WHERE post_id = ?', post.id)).count);
  return { sql, request, review, stored, count };
}

test('a submitted post still needs a proposal to request review, and an invalid proposal opens no review', { skip: postgresSkip }, async t => {
  const f = await proposalFixture(t, [['blair', 'owner'], ['avery', 'admin'], ['casey', 'editor']]);
  let result = await f.request('casey', {});
  assert.equal(result.status, 409); assert.equal(result.data.error.code, 'APPROVAL_LOCAL_POST_REQUIRED');
  for (const [proposal, code] of [[{ content: 'Proposed caption' }, 'INVALID_POST_MODE'], [{ content: 7, mode: 'draft' }, 'INVALID_CONTENT'], [{ mode: 'scheduled', scheduledAt: '2020-01-01T09:00:00Z' }, 'SCHEDULE_PASSED'], [{ mode: 'draft', postId: 'another-post' }, 'INVALID_APPROVAL_FIELDS'], [{ mode: 'draft', accountOverrides: { 'another-account': { platform: 'facebook', content: 'Elsewhere' } } }, 'ACCOUNT_VARIANT_MISMATCH']]) {
    result = await f.request('casey', { proposal });
    assert.ok(result.status >= 400 && result.status < 500, JSON.stringify(result.data)); assert.equal(result.data.error.code, code);
  }
  assert.equal(await f.count(), 0, 'An invalid proposal cannot be reviewed or approved.');
});

test('a newer proposal supersedes the pending one, which can no longer be approved', { skip: postgresSkip }, async t => {
  const f = await proposalFixture(t, [['blair', 'owner'], ['avery', 'admin'], ['casey', 'editor']]);
  let result = await f.request('casey', { proposal: { content: 'First proposal', mode: 'draft' } }); assert.equal(result.status, 200, JSON.stringify(result.data));
  const first = result.data.item.review.id; assert.equal(result.data.item.review.snapshot.content, 'First proposal'); assert.deepEqual(result.data.item.review.snapshot.proposal, { content: 'First proposal', mode: 'draft' });
  assert.equal((await f.request('casey', { proposal: { content: 'First proposal', mode: 'draft' } })).data.item.review.id, first, 'Repeating a pending proposal does not open a duplicate review.');
  result = await f.request('casey', { proposal: { content: 'Second proposal', mode: 'draft' } }); assert.equal(result.status, 200, JSON.stringify(result.data));
  const second = result.data.item.review.id; assert.notEqual(second, first);
  assert.deepEqual(await f.stored(first), { status: 'rejected', note: 'Superseded by a newer proposed update.', requested_by: 'casey', self_approved: false });
  result = await f.review('blair', first); assert.equal(result.status, 409); assert.equal(result.data.error.code, 'APPROVAL_REVIEW_CHANGED');
  assert.equal((await f.stored(first)).status, 'rejected');
  result = await f.review('blair', second); assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(await f.stored(second), { status: 'approved', note: 'Checked the proposed update.', requested_by: 'casey', self_approved: false });
});

test('approving a proposal follows the self-review rule and its single-administrator exception', { skip: postgresSkip }, async t => {
  await t.test('another owner or administrator is active', async t => {
    const f = await proposalFixture(t, [['blair', 'owner'], ['avery', 'admin']]);
    const requested = await f.request('avery', { proposal: { content: 'Admin proposal', mode: 'draft' } }); assert.equal(requested.status, 200, JSON.stringify(requested.data));
    const result = await f.review('avery', requested.data.item.review.id);
    assert.equal(result.status, 403); assert.equal(result.data.error.code, 'APPROVAL_SELF_REVIEW'); assert.match(result.data.error.message, /: Blair Owner\.$/);
    assert.deepEqual(await f.stored(requested.data.item.review.id), { status: 'pending', note: '', requested_by: 'avery', self_approved: false });
  });
  await t.test('the single owner or administrator', async t => {
    const f = await proposalFixture(t, [['blair', 'owner'], ['casey', 'editor']]);
    const requested = await f.request('blair', { proposal: { content: 'Owner proposal', mode: 'draft' } }); assert.equal(requested.status, 200, JSON.stringify(requested.data));
    const result = await f.review('blair', requested.data.item.review.id);
    assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.item.review.selfApproved, true);
    assert.deepEqual(await f.stored(requested.data.item.review.id), { status: 'approved', note: 'Checked the proposed update.', requested_by: 'blair', self_approved: true });
  });
});

test('review requests, proposals and decisions each run on their own transaction connection', { skip: postgresSkip }, async t => {
  // With one pool connection, a transaction that also needs the pool (instead of its own connection) times out.
  const local = await selfReviewFixture(t, [['blair', 'owner'], ['casey', 'editor']], singleConnection);
  await local.setPolicy('blair', true);
  const reviewId = await local.request('casey');
  assert.equal((await local.review('blair', reviewId)).status, 200);
  assert.deepEqual(await local.stored(reviewId), { status: 'approved', self_approved: false });
  const proposed = await proposalFixture(t, [['blair', 'owner'], ['casey', 'editor']], singleConnection);
  const result = await proposed.request('casey', { proposal: { content: 'Proposed on one connection', mode: 'draft' } });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal((await proposed.review('blair', result.data.item.review.id)).status, 200);
});

test('a reviewer demoted after their request started cannot approve or reject', { skip: postgresSkip }, async t => {
  const f = await selfReviewFixture(t, [['blair', 'owner'], ['avery', 'admin'], ['casey', 'editor']]);
  const reviewId = await f.request('casey');
  // The request read Avery as an administrator; the membership changed before the decision took its locks.
  await f.pool.query("UPDATE memberships SET role = 'editor' WHERE user_id = 'avery'");
  for (const decision of ['approved', 'rejected']) {
    const result = await f.review('avery', reviewId, decision);
    assert.equal(result.status, 403); assert.equal(result.data.error.code, 'APPROVAL_ADMIN_REQUIRED');
  }
  assert.deepEqual(await f.stored(reviewId), { status: 'pending', self_approved: false });
});

// Bulk decisions run every item through the single-review path, so each item keeps its own rules and outcome.
test('bulk decisions apply each item independently and repeat idempotently without a second decision', { skip: postgresSkip }, async t => {
  const f = await selfReviewFixture(t, [['blair', 'owner'], ['avery', 'admin'], ['casey', 'editor']]);
  await f.setPolicy('blair', true);
  const bulk = (userId, body) => f.invoke('bulk', userId, body);
  const create = content => f.store.create(f.project.id, 'posts', { content, platforms: ['facebook'], accounts: ['brand-account-a'], status: 'draft', mediaItems: [] });
  const second = await create('Second bulk fixture'), third = await create('Self-requested bulk fixture');
  const requestFor = async (post, userId) => { const result = await f.invoke(`posts/${post.id}/request`, userId); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.item.review.id; };
  const items = [{ postId: f.post.id, reviewId: await requestFor(f.post, 'casey') }, { postId: second.id, reviewId: await requestFor(second, 'casey') }, { postId: third.id, reviewId: await requestFor(third, 'avery') }, { postId: 'missing-post', reviewId: 'missing-review' }];
  assert.equal((await bulk('casey', { decision: 'approved', items })).status, 403);
  for (const body of [{ decision: 'approved', items: [] }, { decision: 'approved', items: Array.from({ length: 51 }, () => items[0]) }, { decision: 'approved', items: [{ ...items[0], extra: true }] }, { decision: 'approved', items: [{ postId: f.post.id }] }, { decision: 'maybe', items }, { decision: 'approved', items, note: 'x'.repeat(2001) }, { decision: 'approved', items, reviewId: 'forged' }]) {
    const result = await bulk('avery', body); assert.equal(result.status, 400, JSON.stringify(result.data));
  }
  assert.equal(Number((await f.sql.get("SELECT count(*) AS count FROM post_approval_reviews WHERE status <> 'pending'")).count), 0, 'An invalid bulk request decides nothing.');
  const activities = async () => Number((await f.sql.get('SELECT count(*) AS count FROM activity WHERE project_id = ?', f.project.id)).count);
  const before = await activities();
  let result = await bulk('avery', { decision: 'approved', note: 'Bulk checked.', items });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.deepEqual(result.data.results.map(row => [row.postId, row.reviewId, row.status, row.error?.code]), [[f.post.id, items[0].reviewId, 'decided', undefined], [second.id, items[1].reviewId, 'decided', undefined], [third.id, items[2].reviewId, 'failed', 'APPROVAL_SELF_REVIEW'], ['missing-post', 'missing-review', 'failed', 'APPROVAL_POST_NOT_FOUND']]);
  assert.equal(result.data.results[0].item.status, 'approved'); assert.equal(result.data.results[0].item.review.note, 'Bulk checked.'); assert.equal(result.data.results[0].item.review.reviewedBy.id, 'avery');
  assert.deepEqual(await f.stored(items[0].reviewId), { status: 'approved', self_approved: false }); assert.deepEqual(await f.stored(items[1].reviewId), { status: 'approved', self_approved: false }); assert.deepEqual(await f.stored(items[2].reviewId), { status: 'pending', self_approved: false });
  assert.equal(await activities(), before + 2, 'Each decided item logs its own activity entry; failed items log none.');
  result = await bulk('avery', { decision: 'approved', note: 'Bulk checked.', items: items.slice(0, 2) });
  assert.deepEqual(result.data.results.map(row => [row.status, row.item?.status]), [['unchanged', 'approved'], ['unchanged', 'approved']], 'A repeated item returns its current state.');
  assert.equal(await activities(), before + 2, 'A repeated item records no second decision or activity entry.');
  result = await bulk('avery', { decision: 'rejected', items: items.slice(0, 1) });
  assert.equal(result.data.results[0].status, 'failed'); assert.equal(result.data.results[0].error.code, 'APPROVAL_REVIEW_CHANGED', 'A decided review cannot be reversed by bulk.');
  assert.equal((await f.review('avery', items[0].reviewId)).status, 409, 'The single route still refuses a repeated decision.');
  result = await bulk('blair', { decision: 'approved', items: [items[2]] });
  assert.equal(result.data.results[0].status, 'decided'); assert.deepEqual(await f.stored(items[2].reviewId), { status: 'approved', self_approved: false });
});

test('bulk approval keeps the single-administrator self-approval exception and re-checks the reviewer role', { skip: postgresSkip }, async t => {
  const f = await selfReviewFixture(t, [['blair', 'owner'], ['casey', 'editor']]);
  await f.setPolicy('blair', true);
  const reviewId = await f.request('blair');
  let result = await f.invoke('bulk', 'blair', { decision: 'approved', items: [{ postId: f.post.id, reviewId }] });
  assert.equal(result.data.results[0].status, 'decided', JSON.stringify(result.data)); assert.equal(result.data.results[0].item.review.selfApproved, true);
  assert.deepEqual(await f.stored(reviewId), { status: 'approved', self_approved: true });
  assert.ok((await f.sql.all('SELECT message FROM activity WHERE project_id = ?', f.project.id)).some(row => row.message === 'Content self-approved by Blair Owner (only administrator).'));
  await f.store.update(f.project.id, 'posts', f.post.id, { content: 'Changed after approval' });
  const next = await f.request('casey');
  await f.pool.query("UPDATE memberships SET role = 'editor' WHERE user_id = 'blair'");
  result = await f.invoke('bulk', 'blair', { decision: 'approved', items: [{ postId: f.post.id, reviewId: next }] });
  assert.equal(result.data.results[0].error.code, 'APPROVAL_ADMIN_REQUIRED'); assert.deepEqual(await f.stored(next), { status: 'pending', self_approved: false });
});

test('a bulk decision racing a single decision on the same review records exactly one decision', { skip: postgresSkip }, async t => {
  for (const [first, decisions] of [['single', ['approved', 'approved']], ['bulk', ['approved', 'approved']], ['single', ['approved', 'rejected']], ['bulk', ['rejected', 'approved']]]) {
    await t.test(`${first} first, ${decisions.join(' then ')}`, async t => {
      const f = await selfReviewFixture(t, [['blair', 'owner'], ['avery', 'admin'], ['casey', 'editor']]);
      const reviewId = await f.request('casey');
      const single = decision => f.review('blair', reviewId, decision), bulk = decision => f.invoke('bulk', 'avery', { decision, items: [{ postId: f.post.id, reviewId }] });
      // Both pass the pending check first. The leader holds the per-post lock and waits on the blocked write; the other waits on that lock.
      const gate = await blockWrites(f.pool, 'post_approval_reviews');
      const leading = (first === 'single' ? single : bulk)(decisions[0]); await gate.waiting(1);
      const trailing = (first === 'single' ? bulk : single)(decisions[1]); await gate.waiting(2); await gate.release();
      const [lead, trail] = await Promise.all([leading, trailing]), outcome = result => result.data.results ? result.data.results[0].status : result.status;
      assert.equal(outcome(lead), first === 'single' ? 200 : 'decided', JSON.stringify(lead.data));
      if (first === 'single') assert.equal(outcome(trail), decisions[0] === decisions[1] ? 'unchanged' : 'failed', JSON.stringify(trail.data));
      else assert.equal(outcome(trail), 409);
      assert.equal((await f.stored(reviewId)).status, decisions[0]);
      assert.equal((await f.sql.all("SELECT message FROM activity WHERE project_id = ? AND message LIKE 'Content % by %' AND message NOT LIKE 'Content review requested%'", f.project.id)).length, 1, 'Exactly one decision is logged.');
    });
  }
});

// The summary drives the navigation badge and hides Publish; it must agree with the queue and with publishing's gate.
async function summaryFixture(t) {
  const f = await selfReviewFixture(t, [['blair', 'owner'], ['casey', 'editor']]), originalFetch = globalThis.fetch, provider = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async target => { provider.push(String(target)); throw new Error('Synthetic provider unavailable'); };
  const project = { id: f.project.id, zernioProfileId: 'profile-a' }, context = role => ({ db: f.db, store: f.store, project, role, user: { id: role, name: role }, config: { env: {}, ZERNIO_API_KEY: 'sk_test_stub' }, assertProjectMapping: async () => {} });
  const get = async (path, role = 'viewer') => { let result; await handleApprovals({ ...context(role), req: { method: 'GET' }, url: new URL(`http://localhost/api/projects/${project.id}/approvals/${path}`), send(status, data) { result = { status, data }; } }); return result; };
  const create = (content, fields = {}) => f.store.create(project.id, 'posts', { content, platforms: ['facebook'], accounts: ['brand-account-a'], status: 'draft', mediaItems: [], ...fields });
  const requestFor = async post => { const result = await f.invoke(`posts/${post.id}/request`, 'casey'); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.item.review.id; };
  const decide = async (post, decision) => assert.equal((await f.invoke(`posts/${post.id}/review`, 'blair', { reviewId: await requestFor(post), decision })).status, 200);
  return { ...f, provider, context, get, create, requestFor, decide };
}

test('the approvals summary reports every post’s queue status for any member, with no provider calls and a fixed number of queries', { skip: postgresSkip }, async t => {
  const f = await summaryFixture(t);
  await f.pool.query("INSERT INTO projects (id, workspace_id, name) VALUES ('project-b','w','B')");
  assert.deepEqual(await f.get('summary'), { status: 200, data: { requireApproval: false, pending: 0, statuses: { [f.post.id]: 'not_requested' }, pendingAdSpend: 0 } });
  const approved = await f.create('Approved'), rejected = await f.create('Rejected'), stale = await f.create('Stale'), queued = await f.create('Queued', { queueId: 'queue-a', queueVersion: 'a'.repeat(64) });
  const submittedPost = await f.store.create(f.project.id, 'posts', { content: 'Submitted', platforms: ['facebook'], status: 'scheduled', externalId: 'remote-a' });
  await f.requestFor(f.post); await f.decide(approved, 'approved'); await f.decide(rejected, 'rejected');
  await f.requestFor(stale); await f.store.update(f.project.id, 'posts', stale.id, { content: 'Edited while pending' });
  const foreign = await f.store.create('project-b', 'posts', { content: 'Foreign', platforms: ['facebook'], status: 'draft' });
  await f.pool.query("INSERT INTO post_approval_reviews (id,project_id,post_id,fingerprint,snapshot,status,requested_by,requested_at) VALUES ('foreign-review','project-b',$1,'x','{}','pending','casey','2026-10-22T00:00:00Z')", [foreign.id]);
  const expected = { [f.post.id]: 'pending', [approved.id]: 'approved', [rejected.id]: 'rejected', [stale.id]: 'stale', [queued.id]: 'not_requested', [submittedPost.id]: 'submitted' };
  // Count statements on the pool: the summary reads posts, assets, latest reviews and policy whatever the number of posts.
  const query = f.pool.query.bind(f.pool); let queries = 0; f.pool.query = (...args) => { queries++; return query(...args); };
  for (const role of ['viewer', 'editor', 'admin', 'owner']) assert.deepEqual((await f.get('summary', role)).data, { requireApproval: false, pending: 1, statuses: expected, pendingAdSpend: 0 });
  const perRead = queries / 4; assert.ok(perRead >= 1 && perRead <= 4,`The summary used ${perRead} queries.`);
  for (let index = 0; index < 5; index++) await f.requestFor(await f.create(`More ${index}`, { assetId: 'missing-asset' }));
  queries = 0; const larger = (await f.get('summary')).data; assert.equal(queries, perRead, 'More posts and reviews add no queries.'); f.pool.query = query;
  assert.equal(larger.pending, 6); assert.equal(Object.keys(larger.statuses).length, 11); assert.equal(f.provider.length, 0, 'The summary sends no provider request, even with queued posts.');
  // The queue (which may read the provider) reports the same status for every post.
  const queue = (await f.get('posts')).data.posts; assert.ok(f.provider.length > 0, 'The queue, by contrast, reads the provider for queued posts.');
  assert.deepEqual(Object.fromEntries(queue.map(row => [row.post.id, row.status])), larger.statuses);
  await f.store.remove(f.project.id, 'posts', queued.id);
  assert.equal((await f.get('summary')).data.statuses[queued.id], undefined, 'Deleted posts are not reported.');
});

test('the summary marks a post approved exactly when publishing’s approval gate passes it', { skip: postgresSkip }, async t => {
  const f = await summaryFixture(t);
  await f.setPolicy('blair', true);
  const asset = await f.store.create(f.project.id, 'assets', { name: 'Creative', kind: 'image', url: 'https://cdn.example.test/c.jpg', deliveryUrl: 'https://cdn.example.test/d.jpg', approval: 'approved' });
  const approved = await f.create('Approved'), approvedThenEdited = await f.create('Approved then edited'), assetChanged = await f.create('Asset changed', { assetId: asset.id }), rejected = await f.create('Rejected'), pendingThenEdited = await f.create('Pending then edited'); await f.create('Never requested');
  for (const post of [approved, approvedThenEdited, assetChanged]) await f.decide(post, 'approved');
  await f.decide(rejected, 'rejected'); await f.requestFor(f.post); await f.requestFor(pendingThenEdited);
  await f.store.update(f.project.id, 'posts', approvedThenEdited.id, { content: 'Edited after approval' }); await f.store.update(f.project.id, 'posts', pendingThenEdited.id, { content: 'Edited while pending' });
  await f.store.update(f.project.id, 'assets', asset.id, { deliveryUrl: 'https://cdn.example.test/changed.jpg' });
  const { statuses, requireApproval } = (await f.get('summary')).data; assert.equal(requireApproval, true);
  assert.deepEqual(new Set(Object.values(statuses)), new Set(['approved', 'stale', 'rejected', 'pending', 'not_requested']));
  for (const post of await f.store.list(f.project.id, 'posts')) {
    const gate = await assertPublishingApproval(f.context('owner'), post).then(() => 'passed', error => error.code);
    assert.equal(gate, statuses[post.id] === 'approved' ? 'passed' : statuses[post.id] === 'stale' && (await f.sql.get('SELECT status FROM post_approval_reviews WHERE post_id = ? ORDER BY seq DESC LIMIT 1', post.id))?.status === 'approved' ? 'PUBLISHING_APPROVAL_STALE' : 'PUBLISHING_APPROVAL_REQUIRED', `${statuses[post.id]} post ${post.content}`);
  }
  assert.equal(statuses[approvedThenEdited.id], 'stale'); assert.equal(statuses[assetChanged.id], 'stale'); assert.equal(statuses[approved.id], 'approved');
});

// Approval runs publishing's per-platform restriction check, so a post that would fail to publish cannot be approved.
test('approving a post that fails a platform restriction is refused, singly and in bulk, while rejecting it still works', { skip: postgresSkip }, async t => {
  const f = await selfReviewFixture(t, [['blair', 'owner'], ['casey', 'editor']]);
  const image = { type: 'image', url: 'https://cdn.example.test/creative.jpg' }, decisions = async () => (await f.sql.all("SELECT message FROM activity WHERE project_id = ? AND message LIKE 'Content % by %' AND message NOT LIKE 'Content review requested%'", f.project.id)).length;
  const create = fields => f.store.create(f.project.id, 'posts', { status: 'draft', mediaItems: [], ...fields });
  const requestFor = async post => { const result = await f.invoke(`posts/${post.id}/request`, 'casey'); assert.equal(result.status, 200, JSON.stringify(result.data)); return result.data.item.review.id; };
  const medialess = await create({ content: 'Instagram needs media', platforms: ['instagram'], accounts: ['instagram-a'] }), medialessReview = await requestFor(medialess);
  let result = await f.invoke(`posts/${medialess.id}/review`, 'blair', { reviewId: medialessReview, decision: 'approved' });
  assert.equal(result.status, 422); assert.equal(result.data.error.code, 'APPROVAL_POST_RESTRICTIONS'); assert.match(result.data.error.message, /^instagram: Instagram requires media\./);
  assert.deepEqual(result.data.error.details, [{ platform: 'instagram', field: 'mediaItems', message: 'Instagram requires media.' }]);
  result = await f.invoke('bulk', 'blair', { decision: 'approved', items: [{ postId: medialess.id, reviewId: medialessReview }] });
  assert.equal(result.data.results[0].status, 'failed'); assert.equal(result.data.results[0].error.code, 'APPROVAL_POST_RESTRICTIONS'); assert.equal(result.data.results[0].error.details[0].field, 'mediaItems');
  assert.deepEqual(await f.stored(medialessReview), { status: 'pending', self_approved: false }); assert.equal(await decisions(), 0);
  assert.equal((await f.invoke(`posts/${medialess.id}/review`, 'blair', { reviewId: medialessReview, decision: 'rejected' })).status, 200, 'An unpublishable post can still be rejected.');
  // A customised account is checked with its own copy; the base variant is checked on platforms without a customised account.
  const tooLong = await create({ content: 'Shared caption', mediaItems: [image], platforms: ['facebook', 'instagram'], accounts: ['facebook-a', 'instagram-a'], accountOverrides: { 'instagram-a': { platform: 'instagram', content: 'x'.repeat(2201) } } }), tooLongReview = await requestFor(tooLong);
  result = await f.invoke(`posts/${tooLong.id}/review`, 'blair', { reviewId: tooLongReview, decision: 'approved' });
  assert.equal(result.status, 422); assert.match(result.data.error.message, /^instagram: Caption has 2,201 characters; Instagram allows 2,200\./);
  assert.deepEqual(result.data.error.details, [{ platform: 'instagram', field: 'content', message: 'Caption has 2,201 characters; Instagram allows 2,200.', accountId: 'instagram-a' }]);
  const customised = await create({ content: 'x'.repeat(2201), mediaItems: [image], platforms: ['facebook', 'instagram'], accounts: ['facebook-a', 'instagram-a'], accountOverrides: { 'instagram-a': { platform: 'instagram', content: 'Short Instagram copy' } } });
  assert.equal((await f.invoke(`posts/${customised.id}/review`, 'blair', { reviewId: await requestFor(customised), decision: 'approved' })).status, 200);
});

test('approving a proposal validates the proposed post against the platform restrictions', { skip: postgresSkip }, async t => {
  const f = await proposalFixture(t, [['blair', 'owner'], ['casey', 'editor']]);
  const requested = await f.request('casey', { proposal: { content: 'Proposed caption', mode: 'draft' } }); assert.equal(requested.status, 200, JSON.stringify(requested.data));
  const reviewId = requested.data.item.review.id, snapshot = JSON.parse((await f.sql.get('SELECT snapshot FROM post_approval_reviews WHERE id = ?', reviewId)).snapshot);
  // The reviewed snapshot is what approval binds (its fingerprint is the review's), so an unpublishable one must be refused.
  await f.sql.run('UPDATE post_approval_reviews SET snapshot = ? WHERE id = ?', JSON.stringify({ ...snapshot, platformOverrides: { facebook: { ...snapshot.platformOverrides.facebook, content: 'x'.repeat(63207) } } }), reviewId);
  const result = await f.review('blair', reviewId);
  assert.equal(result.status, 422); assert.equal(result.data.error.code, 'APPROVAL_POST_RESTRICTIONS'); assert.match(result.data.error.message, /^facebook: Caption has 63,207 characters/);
  assert.equal((await f.stored(reviewId)).status, 'pending');
  await f.sql.run('UPDATE post_approval_reviews SET snapshot = ? WHERE id = ?', JSON.stringify(snapshot), reviewId);
  assert.equal((await f.review('blair', reviewId)).status, 200);
});

// Manager decision on #125: moving an approved post only in time, to a future time, keeps its approval and is logged.
// A time of now or in the past, clearing the time, or any other change makes the approval stale.
test('a time-only move to a future time keeps the approval; a move to now or the past makes it stale', { skip: postgresSkip }, async t => {
  const { db, pool, sql } = await testDatabase(t);
  await pool.query("INSERT INTO users (id, name, email) VALUES ('owner','Workspace owner','owner@example.test'),('editor','Author','editor@example.test'); INSERT INTO workspaces (id, name) VALUES ('w','W'); INSERT INTO projects (id, workspace_id, name) VALUES ('project-a','w','A'); INSERT INTO memberships VALUES ('w','owner','owner'),('w','editor','editor')");
  const store = createStore(db), project = { id: 'project-a' };
  const context = role => ({ db, store, project, role, user: { id: role, name: { owner: 'Workspace owner', editor: 'Author' }[role] } });
  const invoke = async (path, role, body = {}, method = 'POST') => { let result; await handleApprovals({ ...context(role), req: { method }, url: new URL(`http://localhost/api/projects/${project.id}/approvals/${path}`), body, send(status, data) { result = { status, data }; } }); return result; };
  assert.equal((await invoke('policy', 'owner', { requireApproval: true })).status, 200);
  const post = await store.create(project.id, 'posts', { content: 'Autumn teaser', platforms: ['facebook'], accounts: ['brand-account-a'], status: 'draft', mediaItems: [], scheduledAt: '2099-10-28T09:00:00Z' });
  const current = () => store.get(project.id, 'posts', post.id);
  const status = async () => (await invoke('posts', 'editor', {}, 'GET')).data.posts.find(row => row.post.id === post.id).status;
  const publishes = async () => { try { await assertPublishingApproval(context('editor'), await current()); return 'passed'; } catch (error) { return error.code; } };
  const approve = async () => { const reviewId = (await invoke(`posts/${post.id}/request`, 'editor')).data.item.review.id; assert.equal((await invoke(`posts/${post.id}/review`, 'owner', { reviewId, decision: 'approved' })).status, 200); return reviewId; };
  // Moves the post through the same path as the post update route, which records a kept approval.
  const move = async changes => { const previous = await current(), record = await store.update(project.id, 'posts', post.id, changes); await recordApprovedReschedule(context('editor'), previous, record); };
  const firstReview = await approve();
  assert.deepEqual([await status(), await publishes()], ['approved', 'passed']);

  await move({ scheduledAt: '2099-10-29T15:30:00Z' });
  assert.deepEqual([await status(), await publishes()], ['approved', 'passed'], 'A move to another future time keeps the approval.');
  assert.equal((await sql.get('SELECT message FROM activity WHERE project_id = ? ORDER BY seq DESC LIMIT 1', project.id)).message, 'Post rescheduled after approval by Author.');
  assert.equal(JSON.parse((await sql.get('SELECT snapshot FROM post_approval_reviews WHERE id = ?', firstReview)).snapshot).schedule.at, '2099-10-29T15:30:00Z', 'The review keeps the new time.');
  await move({ accountOverrides: { 'brand-account-a': { platform: 'facebook', scheduledAt: '2099-10-30T08:00:00Z' } } });
  assert.deepEqual([await status(), await publishes()], ['approved', 'passed'], 'An account’s own future time keeps the approval too.');
  // A queue only picks the next weekly slot, so choosing one (or another version of it) is a time-only move.
  await move({ queueId: 'queue-a', queueVersion: 'a'.repeat(64) });
  assert.equal(await status(), 'approved', 'Choosing a queue keeps the approval.');
  await move({ queueId: 'queue-b', queueVersion: 'b'.repeat(64), scheduledAt: '' });
  assert.equal(await status(), 'approved', 'A queued post with no fixed time keeps the approval.');
  await move({ queueId: '', queueVersion: '', scheduledAt: '2099-10-29T15:30:00Z' });

  for (const changes of [{ scheduledAt: '2020-01-01T09:00:00Z' }, { scheduledAt: new Date(Date.now() - 1000).toISOString() }, { scheduledAt: '' }, { accountOverrides: { 'brand-account-a': { platform: 'facebook', scheduledAt: '2020-01-01T09:00:00Z' } } }]) {
    const before = await current(), logged = (await sql.get('SELECT count(*)::int AS n FROM activity WHERE project_id = ?', project.id)).n;
    await move(changes);
    assert.deepEqual([await status(), await publishes()], ['stale', 'PUBLISHING_APPROVAL_STALE'], 'A move to now, the past or no time needs a new review: ' + JSON.stringify(changes));
    assert.equal((await sql.get('SELECT count(*)::int AS n FROM activity WHERE project_id = ?', project.id)).n, logged, 'A stale move is not logged as a kept approval.');
    await store.update(project.id, 'posts', post.id, before);
  }
  assert.deepEqual([await status(), await publishes()], ['approved', 'passed']);

  // After a move into the past, a request opens a new review instead of answering with the old approval.
  await move({ scheduledAt: '2020-01-01T09:00:00Z' });
  const reopened = (await invoke(`posts/${post.id}/request`, 'editor')).data.item;
  assert.equal(reopened.status, 'pending'); assert.notEqual(reopened.review.id, firstReview);

  // A post approved with no time (to publish on demand) that gains one, even a future one, is a different instruction.
  await store.update(project.id, 'posts', post.id, { scheduledAt: '' }); await approve();
  assert.deepEqual([await status(), await publishes()], ['approved', 'passed']);
  await move({ scheduledAt: '2099-11-01T09:00:00Z' });
  assert.deepEqual([await status(), await publishes()], ['stale', 'PUBLISHING_APPROVAL_STALE'], 'No time, then a time, needs a new review.');

  // Content changes stay stale whatever the time.
  await store.update(project.id, 'posts', post.id, { scheduledAt: '2099-11-01T09:00:00Z' }); await approve();
  await move({ content: 'Edited caption', scheduledAt: '2099-11-02T09:00:00Z' });
  assert.deepEqual([await status(), await publishes()], ['stale', 'PUBLISHING_APPROVAL_STALE']);
});
