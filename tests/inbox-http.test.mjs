import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createApp } from '../server/index.mjs';

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-inbox-')), originalFetch = globalThis.fetch, calls = [], env = { ZERNIO_API_KEY: 'inbox-fixture-key', ZERNIO_WEBHOOK_SECRET: 'inbox-fixture-signing-secret' };
  const app = createApp({ dataDir, env, appUrl: 'https://campaign.example.test', directScheduler: false });
  const accounts = [['fb', 'facebook'], ['ig', 'instagram'], ['yt', 'youtube'], ['gb', 'googlebusiness'], ['bs', 'bluesky'], ['ads', 'metaads'], ['tt', 'tiktok'], ['sl', 'slack'], ['rc', 'rcs'], ['sm', 'sms'], ['wa', 'whatsapp']].map(([_id, platform]) => ({ _id, platform, profileId: 'inbox-profile', username: `${platform}-account`, isActive: true }));
  const review = { id: 'review-1', accountId: 'gb', platform: 'googlebusiness', rating: 5, reviewer: { name: 'Alex' }, text: 'Good service', hasReply: false, reply: null }, comments = [{ id: 'comment-1', platform: 'facebook', message: 'Question', from: { id: 'participant-a', name: 'Alex', isOwner: false }, canReply: true, canHide: true, canLike: true, canDelete: true, isHidden: false, isLiked: false }];
  let base, cookie, projectId, hook, lastIncoming = Date.now(), sourceForeign = false, malformedHistory = false;
  const json = data => Response.json(data), paging = { hasMore: false, nextCursor: null };
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target); if (url.hostname === '127.0.0.1') return originalFetch(target, options);
    assert.equal(url.hostname, 'zernio.com'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, `Bearer ${env.ZERNIO_API_KEY}`);
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined });
    if (hook) { const result = await hook(url, options); if (result !== undefined) return result; }
    if (url.pathname.endsWith('/accounts')) { assert.equal(url.searchParams.get('profileId'), 'inbox-profile'); return json({ accounts: [...accounts, { _id: 'foreign', profileId: 'foreign-profile', platform: 'facebook' }] }); }
    const accountId = url.searchParams.get('accountId') || (options.body ? JSON.parse(options.body).accountId : undefined), account = accounts.find(item => item._id === accountId), platform = account?.platform;
    const thread = { id: 'thread-1', accountId: sourceForeign ? 'foreign' : accountId, platform, participantId: 'participant-a', participantName: 'Alex Messenger', participantPicture: null, status: 'active', lastMessage: 'Question', updatedTime: new Date(lastIncoming).toISOString(), unreadCount: 1 };
    if (url.pathname.endsWith('/inbox/conversations')) return json({ data: [thread], pagination: paging, meta: { accountsQueried: 1 } });
    if (url.pathname.endsWith('/inbox/conversations/thread-1')) {
      if (options.method === 'PUT') return json({ success: true, data: { ...thread, status: JSON.parse(options.body).status } });
      return json({ data: thread });
    }
    if (url.pathname.endsWith('/messages')) {
      if (options.method === 'POST') return json({ success: true, data: { messageId: 'sent-message-1', conversationId: 'thread-1' } });
      return json({ messages: [{ id: 'received-1', conversationId: malformedHistory ? 'foreign-thread' : 'thread-1', accountId, platform, message: 'Please help', senderId: 'participant-a', senderName: 'Alex', direction: 'incoming', createdAt: new Date(lastIncoming).toISOString(), attachments: [] }], pagination: paging, sortOrderApplied: 'desc' });
    }
    if (url.pathname.endsWith('/read')) return json({ success: true, markedCount: 1 });
    if (url.pathname.endsWith('/inbox/comments')) return json({ data: accountId === 'ads' ? [{ id: 'ad-1:instagram', adId: 'ad-1', isAd: true, placement: 'instagram', platform: 'instagram', accountId: 'ads', content: 'Dark ad', commentCount: 1 }] : [{ id: 'post-1', platform, accountId: sourceForeign ? 'foreign' : accountId, content: 'A campaign post', cid: 'post-cid', commentCount: comments.length }], pagination: paging });
    if (url.pathname.endsWith('/ads/ad-1/comments')) return json({ status: 'success', comments: [{ ...comments[0], platform: 'instagram' }], pagination: paging, meta: { platform: 'instagram', accountId: 'ads', adId: 'ad-1', effectiveStoryId: 'ad-media-1', instagramAccountId: 'ig', placement: 'instagram' } });
    if (url.pathname.endsWith('/inbox/comments/post-1') || url.pathname.endsWith('/inbox/comments/ad-media-1')) {
      if (options.method === 'POST') return json({ success: true, data: { commentId: 'new-comment-1', isReply: true } });
      if (options.method === 'DELETE') return json({ success: true, data: { message: 'Deleted' } });
      return json({ status: 'success', comments: comments.map(row => ({ ...row, platform })), pagination: paging, meta: { accountId, platform, postId: 'post-1' } });
    }
    if (/\/comments\/[^/]+\/comment-1\/(hide|like)$/.test(url.pathname)) {
      const hiding = url.pathname.endsWith('/hide'), enabled = options.method === 'POST'; comments[0][hiding ? 'isHidden' : 'isLiked'] = enabled;
      return json({ status: 'success', commentId: 'comment-1', platform, [hiding ? 'hidden' : 'liked']: enabled });
    }
    if (url.pathname.endsWith('/moderation')) return json({ success: true });
    if (url.pathname.endsWith('/inbox/reviews')) return json({ status: 'success', data: [{ ...review, accountId, platform }], pagination: paging, summary: { totalReviews: 1, averageRating: 5 } });
    if (url.pathname.endsWith('/inbox/reviews/review-1/reply')) {
      if (options.method === 'DELETE') { review.reply = null; review.hasReply = false; return json({ status: 'success', platform, message: 'Deleted' }); }
      review.hasReply = true; review.reply = { id: 'review-reply', text: JSON.parse(options.body).message, created: new Date().toISOString() }; return json({ status: 'success', platform, reply: review.reply });
    }
    if (url.pathname.endsWith('/tools/validate/media')) return json({ valid: true, size: 1024, contentType: 'image/jpeg' });
    assert.fail(`Unexpected provider call: ${options.method} ${url}`);
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${app.server.address().port}`;
  async function request(path, method = 'GET', body, key = randomUUID()) {
    const response = await fetch(base + path, { method, headers: { Origin: 'https://campaign.example.test', ...(cookie ? { Cookie: cookie } : {}), ...(method !== 'GET' ? { 'Content-Type': 'application/json', 'Idempotency-Key': key } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const setup = await request('/api/auth/setup', 'POST', { name: 'Inbox owner', email: 'inbox-owner@example.test', password: 'inbox fixture passphrase long enough', sample: false }); assert.equal(setup.status, 201); cookie = setup.cookie; projectId = setup.data.projectId;
  await request(`/api/projects/${projectId}`, 'PATCH', { zernioProfileId: 'inbox-profile' }); const path = `/api/projects/${projectId}/integrations/inbox`;
  return { app, projectId, path, calls, comments, review, accounts, request, writes: () => calls.filter(call => call.options.method !== 'GET' && !call.url.pathname.includes('/tools/validate/')), setHook(value) { hook = value; }, setForeign(value) { sourceForeign = value; }, setMalformedHistory(value) { malformedHistory = value; }, setIncoming(value) { lastIncoming = value; }, async close() { await app.close(); globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); } };
}

test('inbox reads are scoped, side-effect-free and create identity-only contacts from verified incoming Messenger history', async () => {
  const f = await fixture();
  try {
    const before = f.calls.length;
    for (const route of ['/thread/messages?accountId=fb', '/thread/reply', '/reviews/hide']) assert.equal((await f.request(f.path + route)).status, 404);
    assert.equal(f.calls.length, before);
    const updates = await f.request(f.path + '/updates?accountId=fb'); assert.equal(updates.status, 200); assert.equal(f.calls.length, before, 'Local update polling does not make provider calls.');
    const status = await f.request(f.path + '/status'); assert.equal(status.status, 200); assert.equal(status.data.webhookConfigured, true); assert.equal(status.data.accounts.some(row => row.id === 'foreign'), false); assert.equal(status.data.accounts.find(row => row.id === 'yt').capabilities.messages, false); assert.equal(status.data.accounts.find(row => row.id === 'ig').capabilities.commentLike, false);
    const list = await f.request(f.path + '/conversations?accountId=fb'); assert.equal(list.data.conversations.length, 1);
    assert.equal(f.app.direct.contacts.list(f.projectId).length, 0, 'A list preview does not imply an incoming participant.');
    const messages = await f.request(f.path + '/conversations/thread-1/messages?accountId=fb'); assert.equal(messages.status, 200); assert.equal(messages.data.messages[0].message, 'Please help'); assert.ok(messages.data.contact.id); assert.equal(messages.data.contact.email, ''); assert.equal(messages.data.contact.phone, ''); assert.deepEqual(messages.data.contact.consents, { email: false, sms: false, whatsapp: false });
    await f.request(f.path + '/conversations/thread-1/messages?accountId=fb'); assert.equal(f.app.direct.contacts.list(f.projectId).length, 1);
    assert.equal(f.writes().length, 0); assert.equal(f.app.db.prepare("SELECT count(*) AS total FROM sqlite_master WHERE name='integration_operations'").get().total, 0);
    const beforeForeign = f.calls.length; assert.equal((await f.request(f.path + '/conversations?accountId=foreign')).status, 403); assert.equal(f.calls.length, beforeForeign + 1);
    f.setForeign(true); assert.equal((await f.request(f.path + '/conversations?accountId=fb')).status, 502); f.setForeign(false);
    f.setMalformedHistory(true); assert.equal((await f.request(f.path + '/conversations/thread-1/messages?accountId=fb')).status, 502);
  } finally { await f.close(); }
});

test('inbox replies, read and archive use durable receipts, platform windows, limits and uncertain retry protection', async () => {
  const f = await fixture();
  try {
    const url = f.path + '/conversations/thread-1/reply', body = { accountId: 'fb', message: 'Hello Alex' }, key = randomUUID();
    const first = await f.request(url, 'POST', body, key); assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(first.data.sent, true); const writes = f.writes().length;
    assert.equal((await f.request(url, 'POST', body, key)).status, 200); assert.equal(f.writes().length, writes); assert.equal((await f.request(url, 'POST', { ...body, message: 'Changed' }, key)).status, 409);
    const read = await f.request(f.path + '/conversations/thread-1/read', 'POST', { accountId: 'fb' }); assert.equal(read.data.markedCount, 1);
    const archive = await f.request(f.path + '/conversations/thread-1/status', 'POST', { accountId: 'fb', status: 'archived' }); assert.equal(archive.data.conversation.status, 'archived'); assert.equal(f.writes().at(-1).options.method, 'PUT');
    const beforeBad = f.writes().length; assert.equal((await f.request(url, 'POST', { accountId: 'fb', message: 'x'.repeat(2001) })).status, 400); assert.equal((await f.request(url, 'POST', { accountId: 'fb', message: 'Reply', voiceNote: true })).status, 400); assert.equal(f.writes().length, beforeBad);
    f.setIncoming(Date.now() - 3 * 86400000); assert.equal((await f.request(url, 'POST', { ...body, message: 'Outside window' })).status, 409); assert.equal((await f.request(url, 'POST', { ...body, messageTag: 'ACCOUNT_UPDATE' })).status, 200);
    assert.equal((await f.request(url, 'POST', { accountId: 'ig', message: 'Reply', messageTag: 'ACCOUNT_UPDATE' })).status, 400);
    f.setIncoming(Date.now()); assert.equal((await f.request(url, 'POST', { accountId: 'tt', message: 'Caption', attachmentUrl: 'https://cdn.example.com/image.jpg', attachmentType: 'image' })).status, 422);
    for (const [accountId, length] of [['ig', 1001], ['wa', 4097], ['rc', 3073]]) assert.equal((await f.request(url, 'POST', { accountId, message: 'x'.repeat(length) })).status, 400);
    f.setHook(target => target.pathname.endsWith('/tools/validate/media') ? Response.json({ valid: true, size: 3 * 1024 * 1024 + 1, contentType: 'image/jpeg' }) : undefined);
    const beforeMedia = f.writes().length;
    assert.equal((await f.request(url, 'POST', { accountId: 'tt', attachmentUrl: 'https://cdn.example.com/image.jpg', attachmentType: 'image' })).status, 400); assert.equal(f.writes().length, beforeMedia);
    f.setHook(undefined); assert.equal((await f.request(url, 'POST', { accountId: 'tt', attachmentUrl: 'https://cdn.example.com/image.jpg', attachmentType: 'image' })).status, 200);
    f.setHook((target, options) => { if (target.pathname.endsWith('/messages') && options.method === 'POST') throw new Error('Provider acknowledgement lost'); });
    const uncertain = { ...body, message: 'Unique uncertain reply' }, beforeUncertain = f.writes().length, uncertainKey = randomUUID(); const result = await f.request(url, 'POST', uncertain, uncertainKey); assert.equal(result.data.operation.status, 'uncertain');
    assert.equal((await f.request(url, 'POST', uncertain, uncertainKey)).status, 409); assert.equal((await f.request(url, 'POST', uncertain)).status, 409); assert.equal(f.writes().length, beforeUncertain + 1);
    f.app.db.prepare("UPDATE memberships SET role='viewer'").run(); const beforeViewer = f.calls.length; assert.equal((await f.request(f.path + '/conversations/thread-1/read', 'POST', { accountId: 'fb' })).status, 403); assert.equal(f.calls.length, beforeViewer);
  } finally { await f.close(); }
});

test('comments scope posts and individual permissions, route Meta ad moderation correctly and validate acknowledgements', async () => {
  const f = await fixture();
  try {
    const list = await f.request(f.path + '/comments?accountId=fb'); assert.equal(list.data.posts[0].id, 'post-1');
    const thread = await f.request(f.path + '/comments/thread?accountId=fb&postId=post-1'); assert.equal(thread.data.comments[0].canReply, true);
    const payload = { accountId: 'fb', postId: 'post-1', commentId: 'comment-1' };
    for (const action of ['reply', 'hide', 'unhide', 'like', 'unlike', 'delete']) { const result = await f.request(f.path + '/comments/' + action, 'POST', { ...payload, ...(action === 'reply' ? { message: 'Thanks for asking' } : {}) }); assert.equal(result.status, 200, `${action}: ${JSON.stringify(result.data)}`); }
    const beforeMissing = f.writes().length; assert.equal((await f.request(f.path + '/comments/reply', 'POST', { ...payload, commentId: 'not-this-post', message: 'Never sent' })).status, 403); assert.equal(f.writes().length, beforeMissing);
    f.comments[0].canDelete = false; assert.equal((await f.request(f.path + '/comments/delete', 'POST', payload)).status, 422); f.comments[0].canDelete = true;
    const moderation = await f.request(f.path + '/comments/moderate', 'POST', { ...payload, accountId: 'yt', moderationStatus: 'rejected', banAuthor: true }); assert.equal(moderation.status, 200); assert.equal(f.writes().at(-1).body.platform, 'youtube');
    const ad = await f.request(f.path + '/comments/reply', 'POST', { accountId: 'ads', postId: 'ad-1:instagram', commentId: 'comment-1', message: 'Ad reply' }); assert.equal(ad.status, 200, JSON.stringify(ad.data)); assert.equal(f.writes().at(-1).url.pathname, '/api/v1/inbox/comments/ad-media-1'); assert.equal(f.writes().at(-1).body.accountId, 'ig');
    const instagram = { accountId: 'ig', postId: 'post-1', commentId: 'comment-1' };
    assert.equal((await f.request(f.path + '/comments/hide', 'POST', instagram)).status, 200);
    f.setHook((url, options) => url.pathname.endsWith('/inbox/comments/post-1') && options.method === 'GET' && url.searchParams.get('accountId') === 'ig' ? Response.json({ comments: [], pagination: { hasMore: false, cursor: null }, meta: { accountId: 'ig', platform: 'instagram', postId: 'post-1' } }) : undefined);
    assert.equal((await f.request(f.path + '/comments/unhide', 'POST', instagram)).status, 200, 'A completed scoped hide receipt allows unhide when Meta omits the hidden row.');
    assert.equal((await f.request(f.path + '/comments/unhide', 'POST', { ...instagram, commentId: 'arbitrary-hidden-comment' })).status, 403);
    f.setHook((url, options) => url.pathname.endsWith('/hide') && options.method === 'POST' ? Response.json({ status: 'success', commentId: 'wrong-comment', hidden: true, platform: 'facebook' }) : undefined);
    const result = await f.request(f.path + '/comments/hide', 'POST', payload); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain');
  } finally { await f.close(); }
});

test('review replies require current versions and replacement confirmation and preserve uncertain outcomes', async () => {
  const f = await fixture();
  try {
    const list = await f.request(f.path + '/reviews?accountId=gb'), first = list.data.reviews[0], route = f.path + '/reviews/reply'; assert.match(first.replyVersion, /^[a-f0-9]{64}$/);
    const payload = { accountId: 'gb', reviewId: first.id, message: 'Thank you', expectedReplyVersion: first.replyVersion };
    const before = f.writes().length; assert.equal((await f.request(route, 'POST', { ...payload, expectedReplyVersion: 'stale' })).status, 409); assert.equal(f.writes().length, before);
    assert.equal((await f.request(route, 'POST', payload)).status, 200);
    const current = (await f.request(f.path + '/reviews?accountId=gb')).data.reviews[0]; assert.equal((await f.request(route, 'POST', { ...payload, message: 'Edited', expectedReplyVersion: current.replyVersion })).status, 409);
    assert.equal((await f.request(route, 'POST', { ...payload, message: 'Edited', expectedReplyVersion: current.replyVersion, confirmReplace: true })).status, 200);
    const updated = (await f.request(f.path + '/reviews?accountId=gb')).data.reviews[0]; assert.equal((await f.request(f.path + '/reviews/delete-reply', 'POST', { accountId: 'gb', reviewId: first.id, expectedReplyVersion: updated.replyVersion, confirmReplace: true })).status, 200); assert.equal(f.writes().at(-1).options.method, 'DELETE');
    const fb = (await f.request(f.path + '/reviews?accountId=fb')).data.reviews[0]; assert.equal((await f.request(f.path + '/reviews/delete-reply', 'POST', { accountId: 'fb', reviewId: fb.id, expectedReplyVersion: fb.replyVersion, confirmReplace: true })).status, 422);
    const fresh = (await f.request(f.path + '/reviews?accountId=gb')).data.reviews[0]; f.setHook((url, options) => url.pathname.endsWith('/reviews/review-1/reply') && options.method === 'POST' ? Response.json({ status: 'success', platform: 'facebook', reply: { text: 'Unknown' } }) : undefined);
    const unknown = await f.request(route, 'POST', { ...payload, message: 'Unknown', expectedReplyVersion: fresh.replyVersion }); assert.equal(unknown.data.operation.status, 'uncertain');
  } finally { await f.close(); }
});

test('visible paged child comments can be replied to and moderated only with exact focused parent and post proof', async () => {
  const f = await fixture(); let focusMode = 'valid';
  const parent = { ...f.comments[0], id: 'parent-1', replies: [{ ...f.comments[0], id: 'reply-1', parentId: 'parent-1' }], repliesHasMore: true }, child = { ...f.comments[0], id: 'reply-2', parentId: 'parent-1' };
  f.setHook((url, options) => {
    if (options.method === 'GET' && url.pathname.endsWith('/inbox/comments/post-1')) {
      const focused = url.searchParams.get('commentId'), meta = { platform: 'facebook', accountId: 'fb', postId: 'post-1' }, paging = { hasMore: false, cursor: null };
      if (focused === 'parent-1') return Response.json({ comments: [child], comment: parent, pagination: paging, meta });
      if (focused === 'reply-2') return Response.json({ comments: [], comment: focusMode === 'wrong-parent' ? { ...child, id: 'foreign-parent' } : child, pagination: paging, meta: focusMode === 'wrong-post' ? { ...meta, postId: 'foreign-post' } : focusMode === 'wrong-account' ? { ...meta, accountId: 'ig' } : meta });
      return Response.json({ comments: [parent], pagination: paging, meta });
    }
    if (options.method === 'POST' && url.pathname.endsWith('/reply-2/hide')) return Response.json({ status: 'success', commentId: 'reply-2', platform: 'facebook', hidden: true });
  });
  try {
    const visible = await f.request(f.path + '/comments/thread?accountId=fb&postId=post-1&commentId=parent-1'); assert.equal(visible.status, 200); assert.equal(visible.data.comments[0].id, 'reply-2');
    const body = { accountId: 'fb', postId: 'post-1', commentId: 'reply-2' };
    assert.equal((await f.request(f.path + '/comments/reply', 'POST', { ...body, message: 'Reply to the loaded child' })).status, 200); assert.equal(f.writes().at(-1).body.commentId, 'reply-2');
    assert.equal((await f.request(f.path + '/comments/hide', 'POST', body)).status, 200);
    const writes = f.writes().length;
    for (const mode of ['wrong-parent', 'wrong-post', 'wrong-account']) { focusMode = mode; const result = await f.request(f.path + '/comments/reply', 'POST', { ...body, message: `Do not send ${mode}` }); assert.equal(result.status, 502, JSON.stringify(result.data)); }
    assert.equal(f.writes().length, writes, 'Foreign focused comments never reach a provider mutation.');
  } finally { await f.close(); }
});

test('ad comment bridges reject another ad or contradictory placement before any moderation write', async () => {
  const f = await fixture(); let mode = 'ad';
  f.setHook((url, options) => options.method === 'GET' && url.pathname.endsWith('/ads/ad-1/comments') ? Response.json({ status: 'success', comments: [{ ...f.comments[0], platform: 'instagram' }], pagination: { hasMore: false, cursor: null }, meta: { platform: 'instagram', accountId: 'ads', adId: mode === 'ad' ? 'different-ad' : 'ad-1', effectiveStoryId: 'different-post', instagramAccountId: 'ig', placement: mode === 'placement' ? 'facebook' : 'instagram' } }) : undefined);
  try {
    for (const value of ['ad', 'placement']) { mode = value; const result = await f.request(f.path + '/comments/reply', 'POST', { accountId: 'ads', postId: 'ad-1:instagram', commentId: 'comment-1', message: `Never send ${mode}` }); assert.equal(result.status, 502); }
    assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('inbox rejects malformed rendered names, message text, comment authors and nested review replies before returning data', async () => {
  const f = await fixture();
  const cases = [
    { route: '/conversations?accountId=fb', path: '/inbox/conversations', data: { data: [{ id: 'thread-1', accountId: 'fb', platform: 'facebook', participantName: { unsafe: true } }], pagination: { hasMore: false, nextCursor: null } } },
    { route: '/conversations/thread-1/messages?accountId=fb', path: '/messages', data: { messages: [{ id: 'msg-1', accountId: 'fb', platform: 'facebook', conversationId: 'thread-1', direction: 'incoming', message: { unsafe: true }, senderName: 'Alex' }], pagination: { hasMore: false, nextCursor: null } } },
    { route: '/conversations/thread-1/messages?accountId=fb', path: '/messages', data: { messages: [{ id: 'msg-1', accountId: 'fb', platform: 'facebook', conversationId: 'thread-1', direction: 'incoming', message: 'Hi', attachments: [{ type: 'image', url: 'https://cdn.example.com/file.jpg', filename: { unsafe: true } }] }], pagination: { hasMore: false, nextCursor: null } } },
    { route: '/comments/thread?accountId=fb&postId=post-1', path: '/inbox/comments/post-1', data: { comments: [{ id: 'comment-1', platform: 'facebook', message: 'Hello', from: { name: { unsafe: true } } }], pagination: { hasMore: false, cursor: null }, meta: { platform: 'facebook', accountId: 'fb', postId: 'post-1' } } },
    { route: '/reviews?accountId=gb', path: '/inbox/reviews', data: { data: [{ id: 'review-1', accountId: 'gb', platform: 'googlebusiness', reviewer: { name: { unsafe: true } }, text: 'Good' }], pagination: { hasMore: false, nextCursor: null } } },
    { route: '/reviews?accountId=gb', path: '/inbox/reviews', data: { data: [{ id: 'review-1', accountId: 'gb', platform: 'googlebusiness', reviewer: { name: 'Alex' }, reply: { text: { unsafe: true } } }], pagination: { hasMore: false, nextCursor: null } } },
  ];
  try {
    for (const item of cases) { f.setHook((url, options) => options.method === 'GET' && url.pathname.endsWith(item.path) ? Response.json(item.data) : undefined); const result = await f.request(f.path + item.route); assert.equal(result.status, 502, item.route); assert.equal(result.data.error.code, 'INVALID_PROVIDER_RESPONSE'); }
    f.setHook((url, options) => options.method === 'GET' && url.pathname.endsWith('/inbox/conversations') ? Response.json({ data: [{ id: 'thread-1', accountId: 'fb', platform: 'facebook', participantName: null, lastMessage: null, instagramProfile: null, unreadCount: null }], pagination: { hasMore: false, nextCursor: null } }) : undefined);
    assert.equal((await f.request(f.path + '/conversations?accountId=fb')).status, 200, 'Optional null values remain valid.'); assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('membership changes while a provider read is pending stop writes and prevent returning inbox data', async () => {
  const f = await fixture(); let revoke = 'viewer';
  f.setHook(url => { if (url.pathname.endsWith('/accounts')) { if (revoke === 'viewer') f.app.db.prepare("UPDATE memberships SET role='viewer'").run(); else f.app.db.prepare('DELETE FROM memberships').run(); } });
  try {
    const denied = await f.request(f.path + '/conversations/thread-1/reply', 'POST', { accountId: 'fb', message: 'No permission to send' }); assert.equal(denied.status, 403); assert.equal(f.writes().length, 0); assert.equal(JSON.stringify(denied.data).includes('Alex Messenger'), false);
    revoke = 'removed'; const hidden = await f.request(f.path + '/conversations?accountId=fb'); assert.equal(hidden.status, 404); assert.equal(JSON.stringify(hidden.data).includes('participant-a'), false);
  } finally { await f.close(); }
});

test('WhatsApp replies round-trip delivery history, enforce the session and use exact approved templates outside it', async () => {
  const f = await fixture(), route = f.path + '/conversations/thread-1/reply';
  const template = { id: 'appointment-template', name: 'appointment_update', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Your appointment is now on {{1}}.' }] };
  let sent, deliveryStatus = 'sent', mode = 'normal';
  f.setHook((url, options) => {
    if (url.pathname.endsWith('/whatsapp/templates')) { assert.equal(url.searchParams.get('accountId'), 'wa'); assert.equal(url.searchParams.get('status'), 'APPROVED'); return Response.json({ success: true, templates: [template] }); }
    if (!url.pathname.endsWith('/messages')) return;
    if (options.method === 'POST') {
      sent = JSON.parse(options.body);
      if (mode === 'timeout') throw new Error('Synthetic provider acknowledgement lost');
      return Response.json({ success: true, data: { messageId: 'wamid.sent-reply', conversationId: 'thread-1' }, warnings: mode === 'bad-warning' ? [{ message: { unexpected: true } }] : [{ code: 'test_warning', message: 'Synthetic provider warning', apiKey: 'never-return-this' }] });
    }
    if (sent) return Response.json({ messages: [{ id: 'wamid.sent-reply', accountId: 'wa', platform: 'whatsapp', conversationId: 'thread-1', message: sent.message || 'Your appointment is now on Friday.', direction: 'outgoing', senderId: 'business-account', createdAt: new Date().toISOString(), deliveryStatus }], pagination: { hasMore: false, nextCursor: null }, sortOrderApplied: 'desc' });
  });
  try {
    const status = await f.request(f.path + '/status'); assert.equal(status.data.accounts.find(row => row.id === 'wa').capabilities.reply, true);
    const conversations = await f.request(f.path + '/conversations?accountId=wa'); assert.equal(conversations.data.conversations[0].accountId, 'wa');
    assert.equal((await f.request(f.path + '/conversations/thread-1/messages?accountId=wa')).data.messages[0].direction, 'incoming');
    const body = { accountId: 'wa', message: 'Friday works for your appointment.' }, key = randomUUID();
    const accepted = await f.request(route, 'POST', body, key); assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.equal(accepted.data.sent, true);
    assert.deepEqual(accepted.data.warnings, [{ code: 'test_warning', message: 'Synthetic provider warning' }]);
    assert.deepEqual(sent, body); assert.equal(f.writes().at(-1).options.headers['Idempotency-Key'], key);
    const beforeReplay = f.writes().length; assert.equal((await f.request(route, 'POST', body, key)).status, 200); assert.equal(f.writes().length, beforeReplay);
    deliveryStatus = 'read'; const readBack = await f.request(f.path + '/conversations/thread-1/messages?accountId=wa'); assert.equal(readBack.data.messages[0].message, body.message); assert.equal(readBack.data.messages[0].deliveryStatus, 'read');

    sent = undefined; f.setIncoming(Date.now());
    const mediaBody = { accountId: 'wa', message: 'Appointment details', attachmentUrl: 'https://cdn.example.com/appointment.jpg', attachmentType: 'image' };
    assert.equal((await f.request(route, 'POST', mediaBody)).status, 200); assert.deepEqual(sent, mediaBody);
    sent = undefined; f.setIncoming(Date.now() - 25 * 3600000);
    const beforeClosed = f.writes().length, closed = await f.request(route, 'POST', { accountId: 'wa', message: 'Closed session must not send' });
    assert.equal(closed.status, 409); assert.equal(closed.data.error.code, 'MESSAGING_WINDOW_CLOSED'); assert.equal(f.writes().length, beforeClosed);
    const templateBody = { accountId: 'wa', templateName: 'appointment_update', templateLanguage: 'en', templateComponents: [{ type: 'body', parameters: [{ type: 'text', text: 'Friday' }] }] };
    const missing = await f.request(route, 'POST', { ...templateBody, templateComponents: [] }); assert.equal(missing.status, 400); assert.equal(f.writes().length, beforeClosed);
    assert.equal((await f.request(route, 'POST', templateBody)).status, 200);
    assert.deepEqual(sent, { accountId: 'wa', template: { elements: [{ name: 'appointment_update', language: 'en', components: templateBody.templateComponents }] } });
    const beforeInvalid = f.writes().length;
    assert.equal((await f.request(route, 'POST', { ...templateBody, templateLanguage: 'en_US' })).data.error.code, 'TEMPLATE_NOT_APPROVED'); assert.equal(f.writes().length, beforeInvalid);

    sent = undefined; f.setIncoming(Date.now()); mode = 'bad-warning';
    const uncertainBody = { accountId: 'wa', message: 'Warning acknowledgement requires review' }, uncertainKey = randomUUID(), beforeUncertain = f.writes().length;
    const malformed = await f.request(route, 'POST', uncertainBody, uncertainKey); assert.equal(malformed.status, 409); assert.equal(malformed.data.operation.status, 'uncertain');
    assert.equal((await f.request(route, 'POST', uncertainBody, uncertainKey)).status, 409); assert.equal((await f.request(route, 'POST', uncertainBody)).status, 409); assert.equal(f.writes().length, beforeUncertain + 1);
    const recovery = await f.request(`/api/projects/${f.projectId}/operations/${malformed.data.operation.id}/review`, 'POST', { resolution: 'applied', confirmChecked: true, note: 'Verified the synthetic message was accepted in the provider fixture.', reference: 'wamid.sent-reply' }); assert.equal(recovery.status, 200);
    assert.equal((await f.request(route, 'POST', uncertainBody)).status, 409); assert.equal(f.writes().length, beforeUncertain + 1);

    sent = undefined; mode = 'timeout'; const lostBody = { accountId: 'wa', message: 'Different message with a lost acknowledgement' }, beforeTimeout = f.writes().length;
    assert.equal((await f.request(route, 'POST', lostBody)).data.operation.status, 'uncertain'); assert.equal((await f.request(route, 'POST', lostBody)).status, 409); assert.equal(f.writes().length, beforeTimeout + 1);
    f.app.db.prepare("UPDATE memberships SET role='viewer'").run(); const beforeViewer = f.calls.length;
    assert.equal((await f.request(route, 'POST', templateBody)).status, 403); assert.equal(f.calls.length, beforeViewer);
  } finally { await f.close(); }
});
