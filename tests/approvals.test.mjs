import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/database.ts';
import { handleApprovals, assertPublishingApproval, assertProviderPostEdit } from '../server/approvals.mjs';

test('content approval policy binds current posts and creative to audited review requests and enforces role and project boundaries', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE projects(id TEXT PRIMARY KEY);
    CREATE TABLE records(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),collection TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE activity(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,message TEXT NOT NULL,created_at TEXT NOT NULL,sample INTEGER NOT NULL DEFAULT 0);
    INSERT INTO users VALUES('owner','Workspace owner'),('admin','Reviewer'),('editor','Author'),('viewer','Reader');
    INSERT INTO projects VALUES('project-a'),('project-b');`);
  const store = createStore(db), project = { id: 'project-a' }, foreignProject = { id: 'project-b' };
  const context = (role = 'editor', selectedProject = project) => ({ db, store, project: selectedProject, role, user: { id: role, name: { owner: 'Workspace owner', admin: 'Reviewer', editor: 'Author', viewer: 'Reader' }[role] } });
  async function invoke(path, { method = 'GET', body = {}, role = 'editor', selectedProject = project } = {}) {
    let result;
    const handled = await handleApprovals({ ...context(role, selectedProject), req: { method }, url: new URL(`http://localhost/api/projects/${selectedProject.id}/approvals/${path}`), body, send(status, data) { result = { status, data }; } });
    assert.equal(handled, true); return result;
  }
  const post = store.create(project.id, 'posts', { content: 'Reviewed campaign text', platforms: ['facebook'], accounts: ['brand-account-a'], status: 'draft', mediaItems: [], scheduledAt: '2027-01-20T10:00:00Z', approvalStatus: 'approved', approvedBy: 'forged-owner' });
  const asset = store.create(project.id, 'assets', { name: 'Creative', kind: 'image', url: 'https://cdn.example.test/creative.jpg', deliveryUrl: 'https://cdn.example.test/delivery.jpg', approval: 'approved', size: 100, modifiedTime: '2026-10-18T09:00:00Z', md5Checksum: 'old-checksum', tags: ['brand'] });
  const foreignPost = store.create(foreignProject.id, 'posts', { content: 'OTHER_PROJECT_PRIVATE_TEXT', platforms: ['instagram'], status: 'draft' });
  const assertRejected = (selectedPost, code, role = 'editor') => assert.throws(() => assertPublishingApproval(context(role), selectedPost), error => error.code === code);
  const current = () => store.get(project.id, 'posts', post.id);
  const item = async () => (await invoke('posts')).data.posts.find(row => row.post.id === post.id);
  const requestReview = () => invoke(`posts/${post.id}/request`, { method: 'POST' });
  const review = (reviewId, decision = 'approved', options = {}) => invoke(`posts/${post.id}/review`, { method: 'POST', role: 'admin', body: { reviewId, decision, note: 'Reviewed against the brief.' }, ...options });
  try {
    assert.deepEqual((await invoke('policy', { role: 'viewer' })).data, { requireApproval: false, updatedBy: null, updatedAt: null });
    assert.doesNotThrow(() => assertPublishingApproval(context(), current()));
    assert.equal((await invoke('policy', { method: 'POST', role: 'viewer', body: { requireApproval: true } })).status, 403);
    assert.equal((await invoke('policy', { method: 'POST', body: { requireApproval: true } })).status, 403);
    assert.equal((await invoke('policy', { method: 'POST', role: 'owner', body: { requireApproval: 'yes' } })).status, 400);
    assert.equal((await invoke('policy', { method: 'POST', role: 'owner', body: { requireApproval: true, approvedBy: 'editor' } })).status, 400);
    let result = await invoke('policy', { method: 'POST', role: 'owner', body: { requireApproval: true } });
    assert.equal(result.status, 200); assert.equal(result.data.requireApproval, true); assert.equal(result.data.updatedBy, 'owner'); assert.ok(result.data.updatedAt);
    assertRejected(current(), 'PUBLISHING_APPROVAL_REQUIRED'); assertRejected(current(), 'PUBLISHING_APPROVAL_REQUIRED', 'owner');
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
    assert.doesNotThrow(() => assertPublishingApproval(context(), current()));
    assert.equal((await review(firstReviewId)).status, 409, 'A completed review cannot silently change its decision.');
    const originalPost = current();
    store.update(project.id, 'posts', post.id, { accountOverrides: {} }); assert.doesNotThrow(() => assertPublishingApproval(context(), current()), 'Empty account customizations keep legacy approval fingerprints unchanged.');
    for (const changed of [{ tags: ['changed keywords'] }, { content: 'Changed copy' }, { platforms: ['instagram'] }, { accounts: ['another-brand-account'] }, { mediaItems: [{ type: 'image', url: 'https://cdn.example.test/new.jpg' }] }, { campaignId: 'changed-campaign' }, { scheduledAt: '2027-01-21T10:00:00Z' }, { accountOverrides: { 'brand-account-a': { platform: 'facebook', content: 'Account caption', options: {}, mediaItems: [] } } }, { accountOverrides: { 'brand-account-a': { platform: 'facebook', scheduledAt: '2027-01-22T10:00:00Z' } } }]) {
      store.update(project.id, 'posts', post.id, changed); assertRejected(current(), 'PUBLISHING_APPROVAL_STALE'); assert.equal((await item()).status, 'stale'); store.update(project.id, 'posts', post.id, originalPost);
    }
    store.update(project.id, 'posts', post.id, { assetId: asset.id }); assertRejected(current(), 'PUBLISHING_APPROVAL_STALE');
    const assetReview = (await requestReview()).data.item.review.id; assert.equal((await review(assetReview)).status, 200); assert.doesNotThrow(() => assertPublishingApproval(context(), current()));
    const originalAsset = store.get(project.id, 'assets', asset.id);
    for (const changed of [{ url: 'https://cdn.example.test/new-original.jpg' }, { deliveryUrl: 'https://cdn.example.test/new-delivery.jpg' }, { kind: 'video' }, { size: 200 }, { modifiedTime: '2026-10-18T12:00:00Z' }, { md5Checksum: 'changed-checksum' }]) {
      store.update(project.id, 'assets', asset.id, changed); assertRejected(current(), 'PUBLISHING_APPROVAL_STALE'); store.update(project.id, 'assets', asset.id, originalAsset);
    }
    store.update(project.id, 'assets', asset.id, { name: 'Cosmetic rename', tags: ['new-tag'], updatedAt: '2026-10-18T12:00:00Z' });
    assert.doesNotThrow(() => assertPublishingApproval(context(), current()), 'Cosmetic asset edits preserve approval.');
    store.update(project.id, 'assets', asset.id, { approval: 'pending' }); assertRejected(current(), 'APPROVAL_ASSET_REQUIRED');
    const pendingAssetReview = (await requestReview()).data.item.review.id;
    assert.equal((await review(pendingAssetReview)).status, 409); assert.equal((await review(pendingAssetReview, 'rejected')).status, 200);
    store.update(project.id, 'assets', asset.id, originalAsset);
    store.update(project.id, 'posts', post.id, { assetId: '', accountOverrides: { 'brand-account-a': { platform: 'facebook', content: '', assetId: asset.id, options: {}, scheduledAt: '2027-01-22T10:00:00Z' } } });
    const accountRequest = await requestReview(), accountCopy = accountRequest.data.item.post.accountOverrides['brand-account-a'];
    assert.equal(accountCopy.content, ''); assert.equal(accountCopy.mediaItems[0].url, originalAsset.deliveryUrl); assert.deepEqual(accountCopy.options, {}); assert.equal(accountCopy.scheduledAt, '2027-01-22T10:00:00Z');
    assert.equal((await review(accountRequest.data.item.review.id)).status, 200);
    store.update(project.id, 'assets', asset.id, { deliveryUrl: 'https://cdn.example.test/changed-account-asset.jpg' }); assertRejected(current(), 'PUBLISHING_APPROVAL_STALE'); store.update(project.id, 'assets', asset.id, originalAsset);
    store.update(project.id, 'posts', post.id, { assetId: asset.id, accountOverrides: {} });
    const reRequested = (await requestReview()).data.item.review.id; assert.notEqual(reRequested, pendingAssetReview);
    assert.equal((await review(pendingAssetReview)).status, 409, 'An old rendered review ID cannot approve a newer request.');
    assert.equal((await review(reRequested)).status, 200);
    const beforeEdit = current(); store.update(project.id, 'posts', post.id, { content: 'Edited after provider preflight began' });
    assertRejected(beforeEdit, 'APPROVAL_POST_CHANGED');
    const changedPending = (await requestReview()).data.item.review.id; store.update(project.id, 'posts', post.id, { content: 'Edited again during administrator review' });
    assert.equal((await review(changedPending)).status, 409, 'Reviewing a stale content fingerprint fails closed.');
    const newestPending = (await requestReview()).data.item.review.id; assert.equal((await review(changedPending)).status, 409); assert.equal((await review(newestPending)).status, 200);
    assert.throws(() => assertProviderPostEdit(context()), error => error.code === 'APPROVED_PROVIDER_EDIT_RESTRICTED');
    assert.throws(() => assertProviderPostEdit(context('viewer')), error => error.status === 403);
    assert.doesNotThrow(() => assertProviderPostEdit(context('owner'))); assert.doesNotThrow(() => assertProviderPostEdit(context('admin')));
    store.update(project.id, 'posts', post.id, { externalId: 'remote-post-id' });
    assert.equal((await item()).status, 'submitted'); assert.equal((await requestReview()).status, 409); assert.doesNotThrow(() => assertPublishingApproval(context(), current()), 'An approved failed provider post may be retried if its reviewed content is unchanged.');
    store.update(project.id, 'posts', post.id, { status: 'failed', providerResults: [{ accountId: 'brand-account-a', status: 'failed' }], content: 'Changed in provider dashboard, then reconciled by status refresh', mediaItems: [{ type: 'image', url: 'https://cdn.example.test/provider-edited.jpg' }] });
    assert.equal((await item()).status, 'stale'); assert.equal((await item()).post.providerFailed, true); assertRejected(current(), 'PUBLISHING_APPROVAL_STALE');
    const failedReview = (await requestReview()).data.item.review.id; assert.equal((await review(failedReview)).status, 200);
    assert.doesNotThrow(() => assertPublishingApproval(context(), { ...current(), content: 'Changed in provider dashboard, then reconciled by status refresh', mediaItems: [{ type: 'image', url: 'https://cdn.example.test/provider-edited.jpg' }] }), 'A fully failed provider post can receive a fresh approval for its reconciled content before retry.');
    assertRejected({ ...current(), content: 'Another provider edit not yet reconciled' }, 'APPROVAL_POST_CHANGED');
    store.update(project.id, 'posts', post.id, { providerResults: [{ status: 'failed' }, { status: 'published' }] }); assert.equal((await requestReview()).status, 409); assert.equal((await item()).status, 'submitted');
    store.update(project.id, 'posts', post.id, { providerResults: [{ status: 'publishing' }] }); assert.equal((await requestReview()).status, 409);
    store.update(project.id, 'posts', post.id, { providerResults: [] }); assert.equal((await requestReview()).status, 409, 'A failed aggregate without verified copy outcomes is insufficient for review.');
    store.update(project.id, 'posts', post.id, { externalId: '', providerResults: [], status: 'draft', mediaItems: [] });
    const sample = store.create(project.id, 'posts', { content: 'Sample', status: 'draft', sample: true }); assert.equal((await invoke(`posts/${sample.id}/request`, { method: 'POST' })).status, 409);
    assertRejected({ ...current(), id: foreignPost.id }, 'APPROVAL_POST_NOT_FOUND');
    result = await invoke('policy', { method: 'POST', role: 'admin', body: { requireApproval: false } }); assert.equal(result.status, 200);
    store.update(project.id, 'posts', post.id, { content: 'Optional review permits a new unreviewed draft' }); assert.doesNotThrow(() => assertPublishingApproval(context(), current())); assert.doesNotThrow(() => assertProviderPostEdit(context()));
    const prepared = { ...current(), mediaItems: [{ type: originalAsset.kind, url: originalAsset.deliveryUrl }] };
    store.update(project.id, 'assets', asset.id, { deliveryUrl: 'https://cdn.example.test/changed-during-preflight.jpg' });
    assertRejected(prepared, 'APPROVAL_POST_CHANGED', 'owner');
    assert.equal((await invoke('policy', { selectedProject: foreignProject })).data.requireApproval, false);
    const hostedAsset = store.create(project.id, 'assets', { name: 'Hosted delivery', kind: 'image', url: 'https://drive.google.com/file/d/original/view', deliveryUrl: 'https://media.zernio.com/temp/approved.png', approval: 'approved', deliverySource: 'zernio', deliveryUploadedAt: '2026-10-19T00:00:00Z', deliveryExpiresAt: '2026-10-26T00:00:00Z', deliveryKey: 'temp/approved.png', deliveryAttemptId: 'upload-one', deliveryKind: 'image', deliveryMimeType: 'image/png', deliverySize: 100, deliveryFilename: 'approved.png' });
    store.update(project.id, 'posts', post.id, { assetId: hostedAsset.id });
    await invoke('policy', { method: 'POST', role: 'owner', body: { requireApproval: true } });
    assert.equal((await review((await requestReview()).data.item.review.id)).status, 200);
    for (const changed of [{ deliveryExpiresAt: '2026-10-27T00:00:00Z' }, { deliveryUploadedAt: '2026-10-20T00:00:00Z' }, { deliveryKey: 'temp/replaced.png' }, { deliveryAttemptId: 'upload-two' }, { deliverySize: 200 }, { deliveryMimeType: 'image/webp' }, { deliveryKind: 'video' }, { deliveryFilename: 'replacement.png' }]) {
      store.update(project.id, 'assets', hostedAsset.id, changed); assertRejected(current(), 'PUBLISHING_APPROVAL_STALE'); store.update(project.id, 'assets', hostedAsset.id, hostedAsset);
    }
    assert.ok(db.prepare('SELECT count(*) AS count FROM post_approval_reviews WHERE project_id=? AND post_id=?').get(project.id, post.id).count >= 5);
    assert.ok(db.prepare('SELECT message FROM activity WHERE project_id=?').all(project.id).some(row => row.message.includes('Content approved by Reviewer')));
  } finally { db.close(); }
});
