import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleEngagement } from '../server/engagement.mjs';

test('organic comments and reviews use scoped provider receipts, opaque pages, safe replacement and durable replies', async () => {
  const db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, calls = [], writes = [];
  const project = { id: 'project-a', zernioProfileId: 'profile-a' }, social = { _id: 'facebook-a', profileId: 'profile-a', platform: 'facebook', displayName: 'Brand' }, google = { _id: 'google-a', profileId: 'profile-a', platform: 'googlebusiness' }, bluesky = { _id: 'bluesky-a', profileId: 'profile-a', platform: 'bluesky' };
  const accounts = [social, google, bluesky, { _id: 'foreign-account', profileId: 'profile-b', platform: 'facebook' }], opaque = 'opaque /+==? value';
  let feedScope = false, threadScope = false, failedAccounts = false, canReply = true, sampleComment = false, mapping = 'profile-a', remapOnWrite = false, ambiguous = false, currentReply = null;
  const reviewId = 'accounts/123/locations/456/reviews/789'; let sequence = 0;
  async function invoke(path, body, { role = 'editor', key = `engagement-${++sequence}`, selectedProject = project, env = { ZERNIO_API_KEY: 'private-key' } } = {}) {
    let response; const handled = await handleEngagement({ req: { method: body === undefined ? 'GET' : 'POST', headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${selectedProject.id}/engagement/${path}`), body: body || {}, project: selectedProject, role, db, store: { activity() {} }, config: { env }, assertProjectMapping(expected) { if (expected !== mapping) throw new Error('Mapping changed'); }, send(status, data) { response = { status, data }; } }); assert.equal(handled, true); return response;
  }
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target), method = options.method || 'GET'; calls.push({ url, options });
    assert.equal(url.origin, 'https://zernio.com'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer private-key');
    let result;
    if (url.pathname === '/api/v1/accounts') result = { accounts };
    else if (method === 'POST') {
      const payload = JSON.parse(options.body); writes.push({ url, payload, key: options.headers['Idempotency-Key'] }); if (ambiguous) throw new Error('Response lost');
      if (url.pathname.endsWith('/reply')) { currentReply = { id: 'reply-one', text: payload.message, created: '2026-10-18T10:00:00Z' }; result = { status: 'success', platform: 'googlebusiness', reply: currentReply }; }
      else result = { success: true, data: { commentId: 'sent-comment', isReply: true, accessToken: 'never-expose' } };
      if (remapOnWrite) mapping = 'profile-b';
    } else if (url.pathname === '/api/v1/inbox/comments') {
      assert.equal(url.searchParams.get('profileId'), 'profile-a'); assert.equal(url.searchParams.get('sortBy'), 'date'); assert.equal(url.searchParams.get('sortOrder'), 'desc');
      const accountId = url.searchParams.get('accountId'), platform = accountId === bluesky._id ? 'bluesky' : 'facebook', next = url.searchParams.get('cursor');
      result = { data: [{ id: accountId === bluesky._id ? 'at://did:plc:brand/app.bsky.feed.post/post-a' : next ? 'post-two' : 'post-one', accountId: feedScope ? 'foreign-account' : accountId, platform, content: 'Campaign launch', cid: 'root-cid', secretToken: 'never-expose' }], pagination: { hasMore: !next, nextCursor: !next ? opaque : null }, meta: { accountsFailed: failedAccounts ? 1 : 0 } };
    } else if (url.pathname.startsWith('/api/v1/inbox/comments/')) {
      const accountId = url.searchParams.get('accountId'), platform = accountId === bluesky._id ? 'bluesky' : 'facebook';
      const focused = url.searchParams.get('commentId'), next = url.searchParams.get('cursor');
      const top = { id: focused ? 'child-comment' : next ? 'comment-two' : 'comment-one', message: 'A customer comment', platform, from: { name: 'Customer' }, canReply, sample: sampleComment, cid: 'parent-cid', rootCid: 'root-cid', rootUri: 'at://did:plc:brand/app.bsky.feed.post/post-a', replies: focused || next ? [] : [{ id: 'inline-child', message: 'A nested comment', platform, canReply: true }] };
      result = { comments: [top], comment: focused ? { id: focused, message: 'Parent', platform, canReply: true } : null, pagination: { hasMore: !next, cursor: !next ? opaque : null }, meta: { accountId: threadScope ? 'foreign-account' : accountId, platform } };
    } else if (url.pathname === '/api/v1/inbox/reviews') {
      assert.equal(url.searchParams.get('accountId'), google._id); assert.equal(url.searchParams.get('platform'), 'googlebusiness');
      result = { data: [{ id: reviewId, accountId: google._id, platform: 'googlebusiness', text: 'Great service', rating: 5, hasReply: Boolean(currentReply), reply: currentReply }], pagination: { hasMore: false }, meta: { accountsFailed: failedAccounts ? 1 : 0 } };
    } else throw new Error(`Unexpected URL ${url}`);
    return new Response(JSON.stringify(result), { status: 200 });
  };
  try {
    let result = await invoke('status'); assert.deepEqual(result.data, { configured: true, mapped: true }); assert.equal(calls.length, 0);
    result = await invoke('accounts'); assert.deepEqual(result.data.accounts.map(row => row.id), ['facebook-a', 'google-a', 'bluesky-a']); assert.equal(JSON.stringify(result).includes('private-key'), false);
    const beforeViewer = calls.length;
    result = await invoke('comments/reply', { accountId: social._id, postId: 'post-one', commentId: 'comment-one', message: 'Reply' }, { role: 'viewer' }); assert.equal(result.status, 403); assert.equal(calls.length, beforeViewer);
    result = await invoke('comments?accountId=foreign-account'); assert.equal(result.status, 403); assert.equal(writes.length, 0);
    result = await invoke('comments/thread?accountId=facebook-a&postId=injected-post'); assert.equal(result.data.error.code, 'ENGAGEMENT_OUTSIDE_PROJECT');
    feedScope = true; result = await invoke('comments?accountId=facebook-a'); assert.equal(result.status, 502); feedScope = false;
    failedAccounts = true; result = await invoke('comments?accountId=facebook-a'); assert.equal(result.status, 503); failedAccounts = false;
    result = await invoke('comments?accountId=facebook-a'); assert.equal(result.status, 200); assert.equal(result.data.posts[0].id, 'post-one'); assert.equal(JSON.stringify(result).includes('never-expose'), false); assert.equal(result.data.pagination.nextCursor, opaque);
    result = await invoke('comments?' + new URLSearchParams({ accountId: social._id, cursor: opaque })); assert.equal(result.data.posts[0].id, 'post-two'); assert.equal(calls.at(-1).url.searchParams.get('cursor'), opaque);
    threadScope = true; result = await invoke('comments/thread?accountId=facebook-a&postId=post-one'); assert.equal(result.status, 502); threadScope = false;
    result = await invoke('comments/reply', { accountId: social._id, postId: 'post-one', commentId: 'injected-comment', message: 'Reply' }); assert.equal(result.status, 403); assert.equal(writes.length, 0);
    result = await invoke('comments/thread?accountId=facebook-a&postId=post-one'); assert.equal(result.status, 200); assert.equal(result.data.comments[0].replies[0].id, 'inline-child'); assert.equal(result.data.pagination.nextCursor, opaque);
    result = await invoke('comments/thread?' + new URLSearchParams({ accountId: social._id, postId: 'post-one', cursor: opaque })); assert.equal(result.data.comments[0].id, 'comment-two');
    result = await invoke('comments/thread?accountId=facebook-a&postId=post-one&commentId=comment-one'); assert.equal(result.status, 200); assert.equal(result.data.parent.id, 'comment-one'); assert.equal(calls.at(-1).url.searchParams.get('commentId'), 'comment-one');
    const reply = { accountId: social._id, postId: 'post-one', commentId: 'comment-two', message: 'Thank you!\nWe appreciate it.' };
    canReply = false; result = await invoke('comments/reply', reply); assert.equal(result.data.error.code, 'COMMENT_REPLY_UNAVAILABLE'); assert.equal(writes.length, 0); canReply = true;
    sampleComment = true; result = await invoke('comments/reply', reply); assert.equal(result.status, 502); assert.equal(writes.length, 0); sampleComment = false;
    result = await invoke('comments/reply', reply, { key: 'comment-reply01' }); assert.equal(result.status, 200); assert.equal(writes.length, 1); assert.equal(writes[0].key, 'comment-reply01'); assert.equal(writes[0].url.pathname, '/api/v1/inbox/comments/post-one'); assert.deepEqual(writes[0].payload, { accountId: social._id, message: reply.message, commentId: 'comment-two' }); assert.equal(JSON.stringify(result).includes('never-expose'), false);
    assert.deepEqual(await invoke('comments/reply', reply, { key: 'comment-reply01' }), result); assert.equal(writes.length, 1);
    assert.equal((await invoke('comments/reply', { ...reply, message: 'Different' }, { key: 'comment-reply01' })).status, 409);
    result = await invoke('comments/reply', reply, { selectedProject: { id: 'project-b', zernioProfileId: 'profile-a' } }); assert.equal(result.status, 403); assert.equal(writes.length, 1);
    result = await invoke('comments?accountId=bluesky-a'); const bluePost = result.data.posts[0].id;
    await invoke('comments/thread?' + new URLSearchParams({ accountId: bluesky._id, postId: bluePost }));
    result = await invoke('comments/reply', { accountId: bluesky._id, postId: bluePost, commentId: 'comment-one', message: 'Blue reply' }); assert.equal(result.status, 200); assert.equal(writes.at(-1).payload.parentCid, 'parent-cid'); assert.equal(writes.at(-1).payload.rootCid, 'root-cid'); assert.equal(writes.at(-1).payload.rootUri, bluePost);
    result = await invoke('reviews?accountId=facebook-a'); assert.equal(result.status, 502, 'Unexpected provider requests fail closed.');
    result = await invoke('reviews?accountId=google-a'); assert.equal(result.status, 200); const review = result.data.reviews[0]; assert.match(review.replyVersion, /^[a-f0-9]{64}$/);
    const reviewReply = { accountId: google._id, reviewId, message: 'Thanks for visiting.', expectedReplyVersion: review.replyVersion };
    result = await invoke('reviews/reply', { ...reviewReply, reviewId: 'injected-review' }); assert.equal(result.status, 403);
    currentReply = { id: 'provider-reply', text: 'An unseen reply', created: '2026-10-18T09:00:00Z' };
    const beforeReview = writes.length;
    result = await invoke('reviews/reply', reviewReply); assert.equal(result.data.error.code, 'REVIEW_REPLY_CHANGED'); assert.equal(writes.length, beforeReview);
    result = await invoke('reviews?accountId=google-a'); reviewReply.expectedReplyVersion = result.data.reviews[0].replyVersion;
    result = await invoke('reviews/reply', reviewReply); assert.equal(result.data.error.code, 'REVIEW_REPLACEMENT_CONFIRMATION_REQUIRED'); assert.equal(writes.length, beforeReview);
    result = await invoke('reviews/reply', { ...reviewReply, confirmReplace: true }, { key: 'review-reply01' }); assert.equal(result.status, 200); assert.equal(result.data.review.reply.text, reviewReply.message); assert.equal(writes.at(-1).url.pathname, '/api/v1/inbox/reviews/accounts%2F123%2Flocations%2F456%2Freviews%2F789/reply'); assert.deepEqual(writes.at(-1).payload, { accountId: google._id, message: reviewReply.message });
    const writtenReviews = writes.length; await invoke('reviews/reply', { ...reviewReply, confirmReplace: true }, { key: 'review-reply01' }); assert.equal(writes.length, writtenReviews);
    remapOnWrite = true; result = await invoke('comments/reply', { ...reply, message: 'Mapping race' }); assert.equal(result.data.operation.status, 'uncertain'); remapOnWrite = false; mapping = 'profile-a';
    ambiguous = true; const lost = { ...reply, message: 'Lost response' };
    result = await invoke('comments/reply', lost, { key: 'comment-lost01' }); assert.equal(result.data.operation.status, 'uncertain'); const lostWrites = writes.length;
    result = await invoke('comments/reply', lost, { key: 'comment-lost02' }); assert.equal(result.data.error.code, 'OPERATION_UNCERTAIN'); assert.equal(writes.length, lostWrites);
    result = await invoke('comments/thread?accountId=facebook-a&postId=..'); assert.equal(result.status, 400);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});
