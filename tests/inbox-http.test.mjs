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
  const accounts = [['fb', 'facebook'], ['ig', 'instagram'], ['yt', 'youtube'], ['gb', 'googlebusiness'], ['bs', 'bluesky'], ['ads', 'metaads'], ['tt', 'tiktok'], ['sl', 'slack'], ['rc', 'rcs'], ['sm', 'sms'], ['wa', 'whatsapp'], ['xx', 'twitter'], ['rd', 'reddit']].map(([_id, platform]) => ({ _id, platform, profileId: 'inbox-profile', username: `${platform}-account`, isActive: true }));
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
    return { status: response.status, data: response.headers.get('content-type')?.startsWith('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer()), headers: response.headers, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const setup = await request('/api/auth/setup', 'POST', { name: 'Inbox owner', email: 'inbox-owner@example.test', password: 'inbox fixture passphrase long enough', sample: false }); assert.equal(setup.status, 201); cookie = setup.cookie; projectId = setup.data.projectId;
  await request(`/api/projects/${projectId}`, 'PATCH', { zernioProfileId: 'inbox-profile' }); const path = `/api/projects/${projectId}/integrations/inbox`;
  return { app, projectId, path, calls, comments, review, accounts, request, writes: () => calls.filter(call => call.options.method !== 'GET' && !call.url.pathname.includes('/tools/validate/')), setHook(value) { hook = value; }, setForeign(value) { sourceForeign = value; }, setMalformedHistory(value) { malformedHistory = value; }, setIncoming(value) { lastIncoming = value; }, async close() { await app.close(); globalThis.fetch = originalFetch; await rm(dataDir, { recursive: true, force: true }); } };
}

async function actionFixture(platform = 'telegram') {
  const f = await fixture(), account = f.accounts.find(item => item.platform === platform) || { _id: 'action-account', platform, profileId: 'inbox-profile', isActive: true };
  if (!f.accounts.includes(account)) f.accounts.push(account);
  const state = { messages: [{ id: 'own-message', message: 'Original sent text', direction: 'outgoing', createdAt: new Date(Date.now() - 60000).toISOString(), attachments: [], reactions: [] }, { id: 'incoming-message', message: 'A recent question', senderId: 'participant-a', direction: 'incoming', createdAt: new Date(Date.now() - 30000).toISOString(), attachments: [], reactions: [] }], control: 'app', pendingRequest: false, malformed: false, unchanged: false, readFailure: false, wrote: false, hold: null };
  f.setHook(async (url, options) => {
    if (url.pathname.endsWith('/inbox/conversations/thread-1') && options.method === 'GET') return Response.json({ data: { id: 'thread-1', accountId: account._id, platform, participantId: 'participant-a', participantName: 'Alex', lastMessage: state.messages.at(-1)?.message || '', updatedTime: state.messages.at(-1)?.createdAt || new Date().toISOString(), status: 'active', threadControl: state.control } });
    if (url.pathname.endsWith('/inbox/conversations') && options.method === 'GET' && url.searchParams.get('folder') === 'requests') return Response.json({ data: state.pendingRequest ? [{ id: 'thread-1', accountId: account._id, platform, participantId: 'participant-a', folder: 'requests', status: 'active' }] : [], pagination: { hasMore: false, nextCursor: null } });
    if (url.pathname.endsWith('/messages') && options.method === 'GET') {
      if (state.wrote && state.readFailure) return Response.json({ error: 'Unavailable' }, { status: 502 });
      return Response.json({ messages: state.messages.map(item => ({ ...item, accountId: account._id, platform, conversationId: 'thread-1' })), pagination: { hasMore: false, nextCursor: null }, sortOrderApplied: 'desc' });
    }
    const messageAction = /\/messages\/([^/]+)(\/reactions)?$/.exec(url.pathname);
    if (messageAction) {
      const target = state.messages.find(item => item.id === decodeURIComponent(messageAction[1])); assert.ok(target);
      state.wrote = true; state.onWrite?.(); if (state.hold) await state.hold;
      const payload = options.body ? JSON.parse(options.body) : null;
      if (messageAction[2]) {
        if (!state.unchanged) target.reactions = [...target.reactions.filter(row => !row.fromMe), ...(options.method === 'POST' ? [{ emoji: payload.emoji, fromMe: true, reactedAt: new Date().toISOString() }] : [])];
        return Response.json(state.malformed ? { success: true, messageId: 'stored-message', platformMessageId: 'wrong-message' } : { success: true, messageId: 'stored-message', platformMessageId: target.id });
      }
      if (options.method === 'PATCH') { if (!state.unchanged) { target.editHistory = [{ text: target.message, attachments: [], editedAt: new Date().toISOString() }]; target.message = payload.text; target.isEdited = true; target.editedAt = new Date().toISOString(); } return Response.json(state.malformed ? {} : { success: true, data: { messageId: target.id } }); }
      assert.equal(options.method, 'DELETE'); if (!state.unchanged) { if (['bluesky', 'reddit'].includes(platform)) state.messages.splice(state.messages.indexOf(target), 1); else target.isDeleted = true; } return Response.json(state.malformed ? {} : { success: true });
    }
    if (url.pathname.endsWith('/thread-control')) {
      const payload = JSON.parse(options.body); state.wrote = true;
      const owner = payload.action === 'take' ? 'app' : payload.action === 'pass' ? 'other' : platform === 'whatsapp' ? 'ai_agent' : payload.action === 'request' ? state.control : 'other';
      if (!state.unchanged) state.control = owner;
      return Response.json(state.malformed ? {} : { success: true, control: { owner, ...(payload.action === 'pass' ? { ownerAppId: payload.targetAppId } : {}) } });
    }
    if (url.pathname.endsWith('/accept')) {
      const payload = JSON.parse(options.body); state.wrote = true; if (!state.unchanged) { state.pendingRequest = false; state.messages.push({ id: 'acceptance-reply', direction: 'outgoing', message: payload.message, createdAt: new Date().toISOString(), attachments: [], reactions: [] }); }
      return Response.json(state.malformed ? {} : { success: true, data: { messageId: 'acceptance-reply' } });
    }
  });
  const thread = () => f.request(`${f.path}/conversations/thread-1/messages?accountId=${account._id}`);
  const write = (message, verb, extra = {}, key = randomUUID()) => f.request(`${f.path}/conversations/thread-1/messages/${encodeURIComponent(message.id)}/${verb}`, 'POST', { accountId: account._id, expectedMessageVersion: message.version, ...extra }, key);
  return { ...f, state, account, thread, write };
}

test('attachment resolution proves account, conversation, message and index before requesting a fresh public link', async () => {
  const f = await fixture(); let mode = 'valid';
  f.setHook((url, options) => {
    if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'media/message', conversationId: 'thread-1', accountId: 'ig', platform: 'instagram', direction: 'incoming', createdAt: new Date().toISOString(), attachments: [{ type: 'image', url: 'https://cdn.example.test/expired.jpg', refreshUrl: 'https://evil.example.test/never-follow' }] }], pagination: { hasMore: false, nextCursor: null } });
    if (url.pathname.endsWith('/attachments/0')) {
      assert.equal(options.method, 'GET'); assert.equal(url.searchParams.get('format'), 'json'); assert.equal(url.searchParams.get('accountId'), 'ig');
      return mode === 'expired' ? Response.json({}, { status: 404 }) : Response.json({ status: 'success', url: mode === 'private' ? 'https://127.0.0.1/private' : 'https://cdn.example.test/fresh.jpg', refreshed: true });
    }
  });
  try {
    const target = `${f.path}/conversations/thread-1/messages/media%2Fmessage/attachments/0?accountId=ig`;
    let result = await f.request(target); assert.equal(result.status, 200); assert.deepEqual(result.data.attachment, { type: 'image', url: 'https://cdn.example.test/fresh.jpg', refreshed: true });
    const count = f.calls.filter(call => call.url.pathname.endsWith('/attachments/0')).length;
    assert.equal((await f.request(target.replace('/attachments/0', '/attachments/1'))).status, 404);
    assert.equal((await f.request(target.replace('media%2Fmessage', 'foreign-message'))).status, 404);
    assert.equal((await f.request(target.replace('accountId=ig', 'accountId=foreign'))).status, 403);
    assert.equal(f.calls.filter(call => call.url.pathname.endsWith('/attachments/0')).length, count);
    mode = 'private'; assert.equal((await f.request(target)).status, 502);
    mode = 'expired'; assert.equal((await f.request(target)).status, 410);
    assert.equal(f.calls.some(call => call.url.hostname === 'evil.example.test'), false); assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('WhatsApp attachment downloads keep credentials server-side and reject unsafe, expired, oversized and changed-access responses', async () => {
  const f = await fixture(); let mode = 'valid', mediaUrl = 'https://zernio.com/api/v1/whatsapp/media/media-id?accountId=wa';
  f.setHook((url, options) => {
    if (url.pathname.endsWith('/messages')) return Response.json({ messages: [{ id: 'media-message', accountId: 'wa', platform: 'whatsapp', conversationId: 'thread-1', direction: 'incoming', createdAt: new Date().toISOString(), attachments: [{ type: 'image', url: mediaUrl, payload: { id: 'media-id' } }] }], pagination: { hasMore: false, nextCursor: null } });
    if (url.pathname.endsWith('/whatsapp/media/media-id')) {
      assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, 'Bearer inbox-fixture-key');
      assert.equal(url.searchParams.get('accountId'), 'wa');
      if (mode === 'expired') return Response.json({}, { status: 400 });
      if (mode === 'redirect') return new Response(null, { status: 302, headers: { Location: 'https://evil.example.test/never-follow' } });
      if (mode === 'stream-oversized') return new Response(Buffer.alloc(6 * 1024 * 1024), { headers: { 'Content-Type': 'image/jpeg' } });
      if (mode === 'access') f.app.db.prepare("UPDATE memberships SET role='viewer'").run();
      return new Response(Buffer.from('image bytes'), { headers: { 'Content-Type': mode === 'html' ? 'text/html' : 'image/jpeg', 'Content-Length': mode === 'oversized' ? String(6 * 1024 * 1024) : '11' } });
    }
  });
  try {
    const target = `${f.path}/conversations/thread-1/messages/media-message/attachments/0?accountId=wa`;
    let result = await f.request(target); assert.equal(result.status, 200); assert.equal(result.data.attachment.url, undefined); assert.equal(result.data.attachment.downloadUrl, target + '&download=1');
    assert.equal(f.calls.some(call => call.url.pathname.includes('/whatsapp/media/')), false, 'Descriptor loading does not fetch the binary or generate a read receipt.');
    result = await f.request(target + '&download=1'); assert.equal(result.status, 200); assert.equal(result.data.toString(), 'image bytes'); assert.equal(result.headers.get('content-disposition'), 'attachment; filename="inbox-attachment.jpg"'); assert.equal(result.headers.get('cache-control'), 'private, no-store');
    for (mode of ['html', 'oversized', 'stream-oversized', 'redirect', 'expired']) { result = await f.request(target + '&download=1'); assert.equal(result.status, mode === 'expired' ? 410 : 502, JSON.stringify(result.data)); }
    mediaUrl = 'https://evil.example.test/api/v1/whatsapp/media/media-id?accountId=wa'; assert.equal((await f.request(target + '&download=1')).status, 502);
    mediaUrl = 'https://zernio.com/api/v1/whatsapp/media/media-id?accountId=other'; assert.equal((await f.request(target + '&download=1')).status, 502);
    mediaUrl = 'https://zernio.com/api/v1/whatsapp/media/media-id'; mode = 'valid'; assert.equal((await f.request(target + '&download=1')).status, 200, 'A verified attachment without the query receives the scoped account parameter.');
    mode = 'access'; assert.equal((await f.request(target + '&download=1')).status, 403);
  } finally { await f.close(); }
});

test('typing is an explicit scoped action and a provider no-op never becomes delivered', async () => {
  const f = await fixture(); let delivered = false;
  f.setHook(url => url.pathname.endsWith('/typing') ? Response.json({ success: delivered }) : undefined);
  try {
    const target = `${f.path}/conversations/thread-1/typing`;
    assert.equal((await f.request(target, 'POST', { accountId: 'wa' })).status, 400);
    assert.equal((await f.request(target, 'POST', { accountId: 'xx', confirmTyping: true })).status, 422);
    let result = await f.request(target, 'POST', { accountId: 'wa', confirmTyping: true }); assert.equal(result.status, 200); assert.equal(result.data.delivered, false); assert.equal(result.data.mayMarkRead, true);
    delivered = true; result = await f.request(target, 'POST', { accountId: 'wa', confirmTyping: true }); assert.equal(result.data.delivered, true);
    const count = f.writes().length; f.app.db.prepare("UPDATE memberships SET role='viewer'").run(); assert.equal((await f.request(target, 'POST', { accountId: 'wa', confirmTyping: true })).status, 403); assert.equal(f.writes().length, count);
  } finally { await f.close(); }
});

test('stored-copy deletion binds the latest message and protects completed or unknown outcomes across fresh keys', async () => {
  for (const outcome of ['success', 'malformed', 'network']) {
    const f = await fixture(); let latest = 'message-a', retryAllowed = false;
    f.setHook((url, options) => {
      if (url.pathname.endsWith('/messages')) return Response.json({ messages: [...new Set(['message-a', latest])].map(id => ({ id, accountId: 'fb', platform: 'facebook', conversationId: 'thread-1', direction: 'incoming', senderId: 'participant-a', message: id, createdAt: '2026-10-18T12:00:00Z', attachments: [] })), pagination: { hasMore: false, nextCursor: null }, sortOrderApplied: 'desc' });
      if (url.pathname.endsWith('/inbox/conversations/thread-1') && options.method === 'DELETE') {
        if (outcome === 'network' && !retryAllowed) throw new Error('Lost deletion receipt');
        return Response.json({ success: true, data: { id: outcome === 'malformed' ? 'other-thread' : 'thread-1', accountId: 'fb', platform: 'facebook', deletedMessages: 2 } });
      }
    });
    try {
      const target = `${f.path}/conversations/thread-1`, detail = await f.request(target + '/messages?accountId=fb');
      const body = { accountId: 'fb', expectedDeleteVersion: detail.data.conversation.deleteVersion, confirmConversationId: 'thread-1' }, contactCount = f.app.db.prepare('SELECT COUNT(*) AS count FROM direct_contacts').get().count;
      latest = '0-new-arrival'; assert.equal((await f.request(target + '/delete', 'POST', body)).status, 409); assert.equal(f.writes().length, 0, 'An arrival with the same timestamp invalidates review even when its ID sorts below the old latest message.');
      body.expectedDeleteVersion = (await f.request(target + '/messages?accountId=fb')).data.conversation.deleteVersion;
      const result = await f.request(target + '/delete', 'POST', body, 'stored-delete-key'); assert.equal(result.status, outcome === 'success' ? 200 : 409);
      if (outcome === 'success') { assert.equal(result.data.scope, 'zernio_copy'); assert.equal(result.data.deletedMessages, 2); }
      assert.equal((await f.request(target + '/delete', 'POST', body, 'stored-delete-fresh-key')).status, 409); assert.equal(f.writes().length, 1);
      assert.equal(f.app.db.prepare('SELECT COUNT(*) AS count FROM direct_contacts').get().count, contactCount);
      assert.equal(f.calls.some(call => /\/contacts\//.test(call.url.pathname)), false);
      if (outcome !== 'success') {
        const review = await f.request(`/api/projects/${f.projectId}/operations/${result.data.operation.id}/review`, 'POST', { resolution: outcome === 'network' ? 'not_applied' : 'applied', confirmChecked: true, note: 'Fixture operator checked the provider outcome.' }); assert.equal(review.status, 200);
        retryAllowed = true;
        const retried = await f.request(target + '/delete', 'POST', body, 'stored-delete-after-review'); assert.equal(retried.status, outcome === 'network' ? 200 : 409); assert.equal(f.writes().length, outcome === 'network' ? 2 : 1, 'Only an explicit not-applied review releases the original resource fence.');
        assert.equal((await f.request(target + '/delete', 'POST', body, 'stored-delete-key')).status, 409, 'An operator-reviewed original key always remains closed.');
      }
    } finally { await f.close(); }
  }
});

test('own text edits and platform deletions revalidate scoped snapshots and confirm exact message history', async () => {
  const f = await actionFixture();
  try {
    let history = await f.thread(), own = history.data.messages.find(item => item.direction === 'outgoing'); assert.equal(own.actions.canEdit, true); assert.match(own.version, /^[a-f0-9]{64}$/); assert.equal(history.data.messages.find(item => item.direction === 'incoming').actions.canDelete, false);
    const key = randomUUID(), accepted = await f.write(own, 'edit', { text: 'Updated sent text' }, key); assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.equal(accepted.data.message.message, 'Updated sent text'); assert.equal(accepted.data.message.editHistory[0].text, 'Original sent text'); assert.equal(f.writes().at(-1).options.method, 'PATCH'); assert.deepEqual(f.writes().at(-1).body, { accountId: f.account._id, text: 'Updated sent text' });
    const writes = f.writes().length; assert.equal((await f.write(own, 'edit', { text: 'Updated sent text' }, key)).status, 200); assert.equal(f.writes().length, writes);
    assert.equal((await f.write(own, 'edit', { text: 'Stale edit' })).status, 409); own = (await f.thread()).data.messages.find(item => item.direction === 'outgoing');
    assert.equal((await f.write(own, 'delete')).status, 400); const deleted = await f.write(own, 'delete', { confirmMessageId: own.id }); assert.equal(deleted.status, 200); assert.equal(deleted.data.message.isDeleted, true); assert.equal(deleted.data.deleteScope, 'platform');
    history = await f.thread(); assert.equal(history.data.messages.find(item => item.id === own.id).actions.canEdit, false); assert.equal(history.data.messages.find(item => item.id === own.id).actions.canReact, false);
  } finally { await f.close(); }
});

test('iMessage time windows and self-only deletion stay distinct from unsupported or incoming-message actions', async () => {
  const apple = await actionFixture('imessage');
  try {
    let own = (await apple.thread()).data.messages[0]; assert.equal(own.actions.canEdit, true); assert.equal(own.actions.canDelete, true); assert.equal(own.actions.deleteScope, 'unsend');
    apple.state.messages[0].createdAt = new Date(Date.now() - 3 * 60000).toISOString(); own = (await apple.thread()).data.messages[0]; assert.equal(own.actions.canEdit, true); assert.equal(own.actions.canDelete, false); assert.equal((await apple.write(own, 'delete', { confirmMessageId: own.id })).status, 409);
    apple.state.messages[0].createdAt = new Date(Date.now() - 16 * 60000).toISOString(); own = (await apple.thread()).data.messages[0]; assert.equal(own.actions.canEdit, false); assert.equal((await apple.write(own, 'edit', { text: 'Late edit' })).status, 409); assert.equal(apple.writes().length, 0);
  } finally { await apple.close(); }
  for (const platform of ['bluesky', 'reddit', 'facebook']) {
    const f = await actionFixture(platform);
    try {
      const rows = (await f.thread()).data.messages, own = rows[0], incoming = rows[1];
      assert.ok([409, 422].includes((await f.write(incoming, 'delete', { confirmMessageId: incoming.id })).status));
      if (platform === 'facebook') { assert.equal(own.actions.canDelete, false); assert.equal((await f.write(own, 'delete', { confirmMessageId: own.id })).status, 422); }
      else { const result = await f.write(own, 'delete', { confirmMessageId: own.id }); assert.equal(result.status, 200); assert.equal(result.data.deleteScope, 'self'); assert.equal(f.state.messages.some(item => item.id === own.id), false); }
    } finally { await f.close(); }
  }
});

test('reactions preserve contact reactions, enforce Meta windows and Slack names, and distinguish acceptance from observation', async () => {
  for (const platform of ['telegram', 'facebook', 'slack']) {
    const f = await actionFixture(platform);
    try {
      let target = (await f.thread()).data.messages[1], emoji = platform === 'slack' ? ':thumbsup:' : '👍';
      f.state.messages[1].reactions = [{ emoji: '❤️', fromMe: false }]; target = (await f.thread()).data.messages[1];
      const before = f.writes().length; assert.equal((await f.write(target, 'unreact')).status, 409); assert.equal((await f.write(target, 'react', { emoji: platform === 'slack' ? '👍' : 'not-an-emoji' })).status, 400); assert.equal(f.writes().length, before);
      let result = await f.write(target, 'react', { emoji }); assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.observed, true); assert.equal(result.data.message.reactions.length, 2);
      target = result.data.message; result = await f.write(target, 'unreact'); assert.equal(result.status, 200); assert.equal(result.data.observed, true); assert.deepEqual(result.data.message.reactions.map(item => item.fromMe), [false]); assert.equal(f.writes().at(-1).options.method, 'DELETE');
      target = result.data.message; f.state.unchanged = true; result = await f.write(target, 'react', { emoji }); assert.equal(result.status, 200); assert.equal(result.data.accepted, true); assert.equal(result.data.observed, false, 'A success receipt alone cannot establish reaction placement.');
      if (platform === 'facebook') { f.state.messages[1].createdAt = new Date(Date.now() - 2 * 86400000).toISOString(); target = (await f.thread()).data.messages[1]; assert.equal(target.actions.canReact, false); assert.equal((await f.write(target, 'react', { emoji })).status, 409); }
    } finally { await f.close(); }
  }
});

test('message actions reject foreign scope and preserve unknown mutation receipts without sending duplicates', async () => {
  for (const mode of ['malformed', 'readFailure', 'unchanged']) {
    const f = await actionFixture();
    try {
      const own = (await f.thread()).data.messages[0]; f.state[mode] = true;
      const result = await f.write(own, 'edit', { text: 'Unconfirmed edit' }); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); const writes = f.writes().length;
      assert.equal((await f.write(own, 'edit', { text: 'Unconfirmed edit' })).status, 409); assert.equal(f.writes().length, writes);
    } finally { await f.close(); }
  }
  const f = await actionFixture();
  try {
    const own = (await f.thread()).data.messages[0], before = f.writes().length;
    assert.equal((await f.request(f.path + '/conversations/thread-1/messages/missing/edit', 'POST', { accountId: f.account._id, expectedMessageVersion: own.version, text: 'Wrong item' })).status, 403);
    assert.equal((await f.request(f.path + '/conversations/thread-1/messages/own-message/edit', 'POST', { accountId: 'foreign', expectedMessageVersion: own.version, text: 'Wrong tenant' })).status, 403);
    assert.equal((await f.request(f.path + '/conversations/%broken/messages/own-message/edit', 'POST', { accountId: f.account._id, expectedMessageVersion: own.version, text: 'Wrong path' })).status, 400); assert.equal(f.writes().length, before);
  } finally { await f.close(); }
});

test('handover requires fresh deliberate review, gates Instagram Login and confirms actual owner rather than a request', async () => {
  const f = await actionFixture('facebook'), route = f.path + '/conversations/thread-1/thread-control';
  try {
    let conversation = (await f.thread()).data.conversation;
    assert.deepEqual(conversation.controlActions, ['take', 'request', 'pass', 'release']);
    assert.equal((await f.request(route, 'POST', { accountId: f.account._id, action: 'pass', targetAppId: '263902037430900', expectedConversationVersion: conversation.version })).status, 409); assert.equal(f.writes().length, 0);
    const transfer = { accountId: f.account._id, action: 'pass', targetAppId: '263902037430900', metadata: 'Customer asked for Page Inbox', expectedConversationVersion: conversation.version, confirmControl: true }, accepted = await f.request(route, 'POST', transfer); assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.equal(accepted.data.conversation.threadControl, 'other');
    assert.equal((await f.request(route, 'POST', { ...transfer, action: 'take', targetAppId: undefined })).status, 409);
    conversation = (await f.thread()).data.conversation; const requested = await f.request(route, 'POST', { accountId: f.account._id, action: 'request', expectedConversationVersion: conversation.version, confirmControl: true }); assert.equal(requested.status, 200); assert.equal(requested.data.requested, true); assert.equal(requested.data.control.owner, 'other');
    f.state.malformed = true; const unknown = await f.request(route, 'POST', { accountId: f.account._id, action: 'take', expectedConversationVersion: conversation.version, confirmControl: true }); assert.equal(unknown.status, 409); assert.equal(unknown.data.operation.status, 'uncertain');
  } finally { await f.close(); }
  const instagram = await actionFixture('instagram');
  try { const conversation = (await instagram.thread()).data.conversation; assert.deepEqual(conversation.controlActions, ['pass', 'release']); const result = await instagram.request(instagram.path + '/conversations/thread-1/thread-control', 'POST', { accountId: instagram.account._id, action: 'take', expectedConversationVersion: conversation.version, confirmControl: true }); assert.equal(result.status, 422); assert.equal(instagram.writes().length, 0); }
  finally { await instagram.close(); }
});

test('request acceptance sends one reviewed reply only for a freshly proven pending Meta request', async () => {
  const f = await actionFixture('facebook'), route = f.path + '/conversations/thread-1/accept';
  try {
    const conversation = (await f.thread()).data.conversation, body = { accountId: f.account._id, expectedConversationVersion: conversation.version, message: 'Thanks for your request', confirmSend: true };
    assert.equal((await f.request(route, 'POST', { ...body, confirmSend: false })).status, 409); assert.equal((await f.request(route, 'POST', body)).status, 409); assert.equal(f.writes().length, 0);
    f.state.pendingRequest = true; const key = randomUUID(), accepted = await f.request(route, 'POST', body, key); assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.equal(accepted.data.sent, true); assert.equal(f.state.pendingRequest, false); assert.equal(f.state.messages.at(-1).message, body.message);
    const writes = f.writes().length; assert.equal((await f.request(route, 'POST', body, key)).status, 200); assert.equal(f.writes().length, writes);
  } finally { await f.close(); }
});

test('inbox message actions share a conversation lock and viewers cannot dispatch them', async () => {
  const f = await actionFixture(); let release, entered;
  try {
    const own = (await f.thread()).data.messages[0]; f.state.hold = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { entered = resolve; }); f.state.onWrite = entered;
    const pending = f.write(own, 'edit', { text: 'Held edit' }); await started;
    const simultaneous = await f.write(own, 'delete', { confirmMessageId: own.id }); assert.equal(simultaneous.status, 409); assert.equal(simultaneous.data.error.code, 'PROVIDER_RESOURCE_BUSY'); assert.equal(f.writes().some(call => call.options.method === 'DELETE'), false);
    release(); f.state.hold = null; assert.equal((await pending).status, 200);
    const fresh = (await f.thread()).data.messages[0]; f.app.db.prepare("UPDATE memberships SET role='viewer'").run(); const writes = f.writes().length;
    assert.equal((await f.write(fresh, 'delete', { confirmMessageId: fresh.id })).status, 403); assert.equal(f.writes().length, writes);
  } finally { release?.(); await f.close(); }
});

test('unreadable reactions and accepted request replies remain uncertain without a second provider write', async () => {
  for (const action of ['react', 'accept']) {
    const f = await actionFixture('facebook');
    try {
      const history = await f.thread(), target = history.data.messages[1], conversation = history.data.conversation;
      f.state.malformed = true; f.state.pendingRequest = true;
      const route = action === 'react' ? `${f.path}/conversations/thread-1/messages/${target.id}/react` : `${f.path}/conversations/thread-1/accept`, body = action === 'react' ? { accountId: f.account._id, expectedMessageVersion: target.version, emoji: '👍' } : { accountId: f.account._id, expectedConversationVersion: conversation.version, message: 'Do not send twice', confirmSend: true };
      const result = await f.request(route, 'POST', body); assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); const writes = f.writes().length;
      assert.equal((await f.request(route, 'POST', body)).status, 409); assert.equal(f.writes().length, writes);
    } finally { await f.close(); }
  }
});

test('full-history search forwards the scoped query and opaque pages, validates snippets and reports skipped accounts', async () => {
  const f = await fixture(); let mode = 'normal';
  f.setHook(url => {
    if (!url.pathname.endsWith('/inbox/conversations/search')) return;
    const accountId = url.searchParams.get('accountId'), account = f.accounts.find(row => row._id === accountId);
    assert.equal(url.searchParams.get('profileId'), 'inbox-profile'); assert.equal(url.searchParams.get('query'), 'old invoice');
    if (accountId === 'bs') return Response.json({ data: [], pagination: { hasMore: false, nextCursor: null }, meta: { accountsQueried: 0, accountsSkipped: [{ accountId, platform: 'bluesky' }] } });
    const paged = url.searchParams.has('cursor'); if (paged) assert.equal(url.searchParams.get('cursor'), 'opaque +/cursor');
    return Response.json({ data: [{ conversation: { id: paged ? 'older-thread' : 'thread-1', accountId: mode === 'foreign' ? 'foreign' : accountId, platform: account.platform, participantName: 'Older conversation', participantUsername: 'older', status: 'archived', lastMessage: 'A different recent preview' }, matchCount: 1, matches: [{ id: 'old-message', text: mode === 'bad-text' ? {} : 'Your old invoice', direction: mode === 'bad-direction' ? 'outgoing' : 'incoming', timestamp: '2023-01-01T00:00:00Z', apiKey: 'do-not-return' }] }], pagination: { hasMore: !paged, nextCursor: paged ? null : 'opaque +/cursor' }, meta: mode === 'bad-meta' ? { accountsSkipped: [{ accountId: 'foreign', platform: 'facebook' }] } : { accountsQueried: 1 } });
  });
  try {
    const route = f.path + '/conversations/search?', params = new URLSearchParams({ accountId: 'fb', query: 'old invoice', direction: 'incoming', limit: '20' });
    const first = await f.request(route + params); assert.equal(first.status, 200, JSON.stringify(first.data)); assert.equal(first.data.conversations[0].matches[0].text, 'Your old invoice'); assert.equal(first.data.conversations[0].matches[0].apiKey, undefined); assert.equal(first.data.conversations[0].status, 'archived');
    params.set('cursor', first.data.pagination.nextCursor); const next = await f.request(route + params); assert.equal(next.data.conversations[0].id, 'older-thread'); assert.equal(next.data.pagination.hasMore, false);
    const skipped = await f.request(route + new URLSearchParams({ accountId: 'bs', query: 'old invoice' })); assert.equal(skipped.data.meta.accountsSkipped[0].accountId, 'bs'); assert.deepEqual(skipped.data.conversations, []);
    for (mode of ['foreign', 'bad-text', 'bad-direction', 'bad-meta']) assert.equal((await f.request(route + params)).status, 502, mode);
    const before = f.calls.length; for (const bad of ['accountId=fb&query=x', 'accountId=fb&query=old+invoice&limit=51', 'accountId=fb&query=old+invoice&direction=both']) assert.equal((await f.request(route + bad)).status, 400);
    assert.equal(f.calls.length, before + 3, 'Invalid search filters make only the scoped account read, never a search call.'); assert.equal(f.writes().length, 0); assert.equal(f.app.direct.contacts.list(f.projectId).length, 0, 'Search snippets are not proof of a new inbound Messenger contact.');
    assert.equal((await f.request(route + 'accountId=foreign&query=old+invoice')).status, 403);
  } finally { await f.close(); }
});

test('new text conversations check platform recipients, keep X eligibility enabled and reuse accepted or uncertain receipts', async () => {
  const f = await fixture(), route = f.path + '/conversations/start'; let malformed = false;
  f.setHook((url, options) => {
    if (url.pathname.endsWith('/inbox/conversations') && options.method === 'POST') return Response.json({ success: true, data: { messageId: 'opening-1', conversationId: 'thread-1', participantName: malformed ? {} : 'Alex', apiKey: 'private' } });
    if (url.pathname.endsWith('/slack-members')) return Response.json({ members: [{ id: 'U01ABCDEF', name: 'Alex', username: 'alex' }] });
  });
  try {
    for (const body of [{ accountId: 'xx', participantUsername: '@alex', message: 'Hello Alex' }, { accountId: 'fb', participantUsername: 'alex', message: 'Hello', confirmSend: true }, { accountId: 'xx', participantId: 1234, message: 'Hello', confirmSend: true }, { accountId: 'xx', participantUsername: 'alex', message: 'Hello', confirmSend: true, skipDmCheck: true }]) assert.ok([400, 422].includes((await f.request(route, 'POST', body)).status));
    assert.equal(f.writes().length, 0);
    const body = { accountId: 'xx', participantUsername: '@alex', message: 'Hello Alex', confirmSend: true }, key = randomUUID();
    const accepted = await f.request(route, 'POST', body, key); assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.equal(accepted.data.sent, true); assert.equal(accepted.data.apiKey, undefined); assert.deepEqual(f.writes().at(-1).body, { accountId: 'xx', participantUsername: 'alex', message: 'Hello Alex' });
    const count = f.writes().length; assert.equal((await f.request(route, 'POST', body, key)).status, 200); assert.equal(f.writes().length, count);
    const history = await f.request(f.path + '/conversations/' + accepted.data.conversationId + '/messages?accountId=xx'); assert.equal(history.status, 200);
    for (const [accountId, participantUsername] of [['bs', 'alex.bsky.social'], ['rd', 'u/alex']]) assert.equal((await f.request(route, 'POST', { ...body, accountId, participantUsername })).status, 200);
    const recipients = await f.request(f.path + '/conversations/recipients?accountId=sl'); assert.equal(recipients.data.recipients[0].id, 'U01ABCDEF');
    const beforeSlack = f.writes().length; assert.equal((await f.request(route, 'POST', { accountId: 'sl', participantId: 'UFOREIGN', message: 'Hello', confirmSend: true })).status, 422); assert.equal(f.writes().length, beforeSlack);
    assert.equal((await f.request(route, 'POST', { accountId: 'sl', participantId: 'U01ABCDEF', message: 'Hello coworker', confirmSend: true })).status, 200);
    f.setHook((url, options) => url.pathname.endsWith('/inbox/conversations') && options.method === 'POST' ? Response.json({ success: true, data: { messageId: 'wrong-recipient', conversationId: 'thread-1', participantId: '9999' } }) : undefined);
    const wrongRecipient = await f.request(route, 'POST', { accountId: 'xx', participantId: '1234', message: 'Exact recipient must match', confirmSend: true }); assert.equal(wrongRecipient.data.operation.status, 'uncertain');
    f.setHook((url, options) => url.pathname.endsWith('/inbox/conversations') && options.method === 'POST' ? Response.json({ success: true, data: { messageId: 'opening-1', conversationId: 'thread-1', participantName: {} } }) : undefined);
    malformed = true; const uncertainBody = { ...body, message: 'A unique ambiguous send' }, uncertainKey = randomUUID(), beforeUncertain = f.writes().length;
    assert.equal((await f.request(route, 'POST', uncertainBody, uncertainKey)).data.operation.status, 'uncertain');
    assert.equal((await f.request(route, 'POST', uncertainBody, uncertainKey)).status, 409); assert.equal((await f.request(route, 'POST', uncertainBody)).status, 409); assert.equal(f.writes().length, beforeUncertain + 1);
    f.app.db.prepare("UPDATE memberships SET role='viewer'").run(); const beforeViewer = f.calls.length; assert.equal((await f.request(route, 'POST', body)).status, 403); assert.equal(f.calls.length, beforeViewer);
  } finally { await f.close(); }
});

test('new WhatsApp and Zernio SMS conversations require current local permission and exact approved template values', async () => {
  const f = await fixture(), route = f.path + '/conversations/start', contacts = f.app.direct.contacts;
  const ready = contacts.save(f.projectId, { name: 'Permitted', phone: '+12025550101', consents: { whatsapp: true, sms: true }, consentSource: 'Synthetic opt-in record' });
  const notPermitted = contacts.save(f.projectId, { name: 'No permission', phone: '+12025550102' }); let revoke = false;
  const template = { id: 'approved-template', name: 'appointment_update', language: 'en', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'HEADER', text: 'Appointment {{1}}', format: 'TEXT' }, { type: 'BODY', text: 'Your appointment is {{1}}' }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Details', url: 'https://example.com/{{1}}' }] }] };
  f.setHook((url, options) => {
    if (url.pathname.endsWith('/whatsapp/templates')) { if (revoke) contacts.suppress(f.projectId, ready.id, 'whatsapp', 'Recipient opted out during lookup'); return Response.json({ success: true, templates: [template] }); }
    if (url.pathname.endsWith('/inbox/conversations') && options.method === 'POST') return Response.json({ success: true, data: { messageId: 'opening-1', conversationId: 'thread-1' } });
  });
  try {
    const recipients = await f.request(f.path + '/conversations/recipients?accountId=wa'); assert.deepEqual(recipients.data.recipients.map(row => row.id), [ready.id]);
    const body = { accountId: 'wa', contactId: ready.id, templateName: 'appointment_update', templateLanguage: 'en', templateComponents: [{ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'appointment-1' }] }, { type: 'body', parameters: [{ type: 'text', text: 'Friday' }] }, { type: 'header', parameters: [{ type: 'text', text: 'A1' }] }], confirmSend: true };
    for (const changed of [{ contactId: notPermitted.id }, { contactId: randomUUID() }, { participantId: '+12025550101' }, { message: 'Free-form opening' }, { templateLanguage: 'fr' }, { templateComponents: [] }]) assert.ok([400, 409].includes((await f.request(route, 'POST', { ...body, ...changed })).status));
    assert.equal(f.writes().length, 0);
    const accepted = await f.request(route, 'POST', body); assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.deepEqual(f.writes().at(-1).body, { accountId: 'wa', participantId: '12025550101', templateName: 'appointment_update', templateLanguage: 'en', templateParams: ['A1', 'Friday', 'appointment-1'] });
    assert.equal((await f.request(route, 'POST', { accountId: 'sm', contactId: ready.id, message: 'Your appointment is confirmed', confirmSend: true })).status, 200);
    contacts.suppressSmsGlobally(ready.phone, 'STOP'); const beforeStop = f.writes().length; assert.equal((await f.request(route, 'POST', { accountId: 'sm', contactId: ready.id, message: 'Blocked after STOP', confirmSend: true })).status, 409); assert.equal(f.writes().length, beforeStop);
    revoke = true; const beforeRevoke = f.writes().length; assert.equal((await f.request(route, 'POST', { ...body, templateComponents: body.templateComponents.map(row => row.type === 'body' ? { ...row, parameters: [{ type: 'text', text: 'Saturday' }] } : row) })).status, 409); assert.equal(f.writes().length, beforeRevoke);
  } finally { await f.close(); }
});

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

test('archive receipts must identify the requested or resolved conversation and cannot be replayed after mismatch', async () => {
  const f = await fixture(), route = f.path + '/conversations/thread-1/status'; let receiptId = 'stored-thread-1';
  f.setHook((url, options) => {
    if (!url.pathname.endsWith('/inbox/conversations/thread-1')) return;
    return Response.json({ success: true, data: { id: options.method === 'PUT' ? receiptId : 'stored-thread-1', accountId: 'fb', platform: 'facebook', participantId: 'participant-a', status: options.method === 'PUT' ? JSON.parse(options.body).status : 'active' } });
  });
  try {
    assert.equal((await f.request(route, 'POST', { accountId: 'fb', status: 'archived' })).status, 200, 'Meta may return the detail-resolved stored ID.');
    receiptId = 'thread-1'; assert.equal((await f.request(route, 'POST', { accountId: 'fb', status: 'active' })).status, 200, 'The originally requested platform ID remains valid.');
    receiptId = 'other-conversation'; const body = { accountId: 'fb', status: 'archived' }, key = randomUUID(), before = f.writes().length;
    const result = await f.request(route, 'POST', body, key);
    assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain'); assert.equal(result.data.conversation, undefined);
    assert.equal((await f.request(route, 'POST', body, key)).status, 409); assert.equal((await f.request(route, 'POST', body)).status, 409);
    assert.equal(f.writes().length, before + 1, 'An unconfirmed archive must not be repeated with a fresh key.');
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

test('reply-window checks find recent customer messages after paged outgoing history and reject incomplete scans', async () => {
  const f = await fixture(), route = f.path + '/conversations/thread-1/reply'; let mode = 'open';
  f.setHook((url, options) => {
    if (!url.pathname.endsWith('/messages') || options.method !== 'GET') return;
    const accountId = url.searchParams.get('accountId'), platform = f.accounts.find(row => row._id === accountId).platform, cursor = url.searchParams.get('cursor');
    assert.equal(url.searchParams.get('sortOrder'), 'desc');
    const common = { conversationId: 'thread-1', accountId, platform, createdAt: new Date(Date.now() - 3600000).toISOString() };
    if (cursor && !['repeat', 'limit'].includes(mode)) return Response.json({ messages: [{ ...common, id: 'customer-message', direction: 'incoming', message: 'Please help', createdAt: new Date(Date.now() - (mode === 'closed' ? 25 : 2) * 3600000).toISOString() }], pagination: { hasMore: false, nextCursor: null }, sortOrderApplied: 'desc' });
    return Response.json({ messages: Array.from({ length: 100 }, (_, index) => ({ ...common, id: 'business-' + index, direction: 'outgoing', message: 'Status update' })), pagination: { hasMore: true, nextCursor: mode === 'limit' ? String(Number(cursor || 0) + 1) : 'older-messages' }, sortOrderApplied: 'desc' });
  });
  try {
    for (const accountId of ['fb', 'ig', 'wa']) {
      const accepted = await f.request(route, 'POST', { accountId, message: 'Reply with a verified open window' });
      assert.equal(accepted.status, 200, JSON.stringify(accepted.data)); assert.equal(accepted.data.sent, true);
      assert.equal(f.calls.filter(call => call.options.method === 'GET' && call.url.pathname.endsWith('/messages') && call.url.searchParams.get('accountId') === accountId).length, 2);
    }
    mode = 'closed'; const before = f.writes().length;
    assert.equal((await f.request(route, 'POST', { accountId: 'wa', message: 'Do not send outside the window' })).data.error.code, 'MESSAGING_WINDOW_CLOSED');
    mode = 'repeat'; const repeated = await f.request(route, 'POST', { accountId: 'wa', message: 'Do not send after a repeated cursor' });
    assert.equal(repeated.status, 502); assert.equal(f.writes().length, before);
    mode = 'limit'; const reads = f.calls.length, incomplete = await f.request(route, 'POST', { accountId: 'wa', message: 'Do not send after incomplete history' });
    assert.equal(incomplete.status, 503); assert.equal(incomplete.data.error.code, 'INCOMPLETE_PROVIDER_DATA'); assert.equal(f.writes().length, before);
    assert.equal(f.calls.slice(reads).filter(call => call.options.method === 'GET' && call.url.pathname.endsWith('/messages')).length, 20);
  } finally { await f.close(); }
});
