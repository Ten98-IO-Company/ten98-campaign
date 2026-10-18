import { createHash } from 'node:crypto';
import { IntegrationError, operation, redact, zernioClient, scopedAccounts, requireAccount } from './integrations.mjs';

const COMMENTS = new Set(['facebook', 'instagram', 'twitter', 'bluesky', 'threads', 'youtube', 'linkedin', 'reddit', 'tiktok']);
const REVIEWS = new Set(['facebook', 'googlebusiness']);
const WRITERS = new Set(['owner', 'admin', 'editor']);
const fail = (status, code, message, uncertain = false) => { throw new IntegrationError(status, code, message, uncertain); };
function input(value, name, max = 2000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(400, 'INVALID_ENGAGEMENT_INPUT', `Enter a valid ${name}.`);
  return value.trim();
}
function id(value, name) { const result = input(value, name); if (/\s/.test(result) || ['.', '..'].includes(result)) fail(400, 'INVALID_ENGAGEMENT_INPUT', `Enter a valid ${name}.`); return result; }
function fields(body, allowed) { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_ENGAGEMENT_FIELDS', 'Use the supported reply fields.'); }
function cursor(value) { if (value === undefined || value === null || value === '') return ''; if (typeof value !== 'string' || value.length > 16000 || /[\u0000-\u001f\u007f]/.test(value)) fail(400, 'INVALID_CURSOR', 'The provider page cursor is invalid. Reload this list.'); return value; }
function page(value) {
  const hasMore = value?.hasMore === true, nextCursor = cursor(value?.nextCursor ?? value?.cursor);
  if (hasMore && !nextCursor) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return the next page cursor.');
  return { hasMore, nextCursor: hasMore ? nextCursor : null };
}
const version = row => createHash('sha256').update(JSON.stringify([row.hasReply === true, row.reply?.id ?? null, row.reply?.text ?? null, row.reply?.created ?? null])).digest('hex');
function flatten(comments, parent) {
  const rows = []; let count = 0;
  function visit(items, depth = 0) {
    if (!Array.isArray(items) || depth > 12) fail(502, 'INVALID_PROVIDER_RESPONSE', 'The provider comment thread is invalid or too deeply nested.');
    for (const item of items) {
      if (!item || typeof item.id !== 'string' || !item.id || ++count > 2000) fail(502, 'INVALID_PROVIDER_RESPONSE', 'The provider comment thread is incomplete or exceeds this page’s limit.');
      rows.push(item); if (item.replies?.length) visit(item.replies, depth + 1);
    }
  }
  if (parent && Object.keys(parent).length) visit([parent]); visit(comments); return rows;
}

export async function handleEngagement(context) {
  const { req, url, body = {}, project, role, db, store, send } = context, prefix = `/api/projects/${encodeURIComponent(project.id)}/engagement/`;
  if (!url.pathname.startsWith(prefix)) return false;
  const path = url.pathname.slice(prefix.length), env = { ...(context.config?.env === undefined ? process.env : context.config.env), ...(context.config || {}) };
  try {
    if (!['owner', 'admin', 'editor', 'viewer'].includes(role)) fail(403, 'PROJECT_ACCESS_REQUIRED', 'Project membership is required.');
    if (!['GET', 'POST'].includes(req.method)) fail(405, 'METHOD_NOT_ALLOWED', 'This engagement action does not support that method.');
    if (req.method === 'POST' && !WRITERS.has(role)) fail(403, 'WRITE_PERMISSION_REQUIRED', 'Editing permission is required to reply.');
    if (path === 'status' && req.method === 'GET') { send(200, { configured: Boolean(env.ZERNIO_API_KEY), mapped: Boolean(project.zernioProfileId) }); return true; }
    if (path === 'updates' && req.method === 'GET') {
      const accountId = id(url.searchParams.get('accountId'), 'account ID'), kind = url.searchParams.get('kind');
      if (!['comments', 'reviews'].includes(kind)) fail(400, 'INVALID_ENGAGEMENT_INPUT', 'Choose comments or reviews.');
      const exists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='webhook_engagement_updates'").get();
      const row = exists && project.zernioProfileId ? db.prepare('SELECT revision,last_event_at FROM webhook_engagement_updates WHERE project_id=? AND profile_id=? AND account_id=? AND kind=?').get(project.id, project.zernioProfileId, accountId, kind) : null;
      send(200, { revision: row?.revision || 0, lastEventAt: row?.last_event_at || null }); return true;
    }
    if (!env.ZERNIO_API_KEY) fail(503, 'ZERNIO_NOT_CONFIGURED', 'Configure Zernio in Integrations settings.');
    if (!project.zernioProfileId) fail(409, 'ZERNIO_NOT_MAPPED', 'Map a Zernio profile to this project first.');
    const profileId = String(project.zernioProfileId), assertMapping = () => { context.assertIntegrationSettings?.(); context.assertProjectMapping?.(profileId); };
    const api = zernioClient(env.ZERNIO_API_KEY, assertMapping);
    db.exec('CREATE TABLE IF NOT EXISTS engagement_resources(project_id TEXT NOT NULL,profile_id TEXT NOT NULL,account_id TEXT NOT NULL,kind TEXT NOT NULL,resource_id TEXT NOT NULL,parent_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(project_id,profile_id,account_id,kind,resource_id,parent_id))');
    function saveProof(account, kind, resourceId, parentId, data) {
      try { assertMapping(); } catch { fail(409, 'PROJECT_CONNECTION_CHANGED', 'The project connection changed. Reload this list.'); }
      db.prepare('INSERT INTO engagement_resources VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,profile_id,account_id,kind,resource_id,parent_id) DO UPDATE SET data=excluded.data').run(project.id, profileId, account._id, kind, resourceId, parentId, JSON.stringify(data));
    }
    function proof(account, kind, resourceId, parentId = '') {
      const row = db.prepare('SELECT data FROM engagement_resources WHERE project_id=? AND profile_id=? AND account_id=? AND kind=? AND resource_id=? AND parent_id=?').get(project.id, profileId, account._id, kind, resourceId, parentId);
      if (!row) fail(403, 'ENGAGEMENT_OUTSIDE_PROJECT', 'Load this resource through the current project’s provider feed before opening or replying to it.');
      return JSON.parse(row.data);
    }
    async function accountFor(value, kind) {
      const account = requireAccount(await scopedAccounts(api, profileId), id(value, 'account ID'));
      if (!(kind === 'comments' ? COMMENTS : REVIEWS).has(account.platform)) fail(422, 'ENGAGEMENT_UNSUPPORTED', 'This account does not support this inbox surface through Zernio.');
      return account;
    }
    function checkedList(result, account) {
      if (!Array.isArray(result.data)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return an engagement list.');
      if (result.meta?.accountsFailed) fail(503, 'INCOMPLETE_PROVIDER_DATA', 'The provider could not read this account. Reconnect it before continuing.');
      for (const row of result.data) if (row.accountId !== account._id || row.platform !== account.platform || typeof row.id !== 'string' || !row.id || row.sample === true || row.isSample === true || row.isAd === true) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned engagement data outside the requested organic account.');
      return result.data;
    }
    async function reviews(account, currentCursor = '') {
      const result = await api('/inbox/reviews', { profileId, accountId: account._id, platform: account.platform, limit: 50, sortBy: 'date', sortOrder: 'desc', cursor: currentCursor });
      const rows = checkedList(result, account).map(row => ({ ...redact(row), replyVersion: version(row) }));
      for (const row of rows) saveProof(account, 'review', row.id, '', { cursor: currentCursor });
      return { reviews: rows, pagination: page(result.pagination), lastUpdated: result.meta?.lastUpdated || null };
    }
    async function thread(account, postId, query = {}) {
      const post = proof(account, 'post', postId);
      const currentCursor = cursor(query.cursor), focusedComment = query.commentId ? id(query.commentId, 'comment ID') : '';
      if (focusedComment) {
        if (!['facebook', 'instagram', 'reddit', 'tiktok'].includes(account.platform)) fail(422, 'COMMENT_FOCUS_UNSUPPORTED', 'This platform does not support a separately paged reply thread. Inline replies remain visible.');
        proof(account, 'comment', focusedComment, postId);
      }
      const result = await api(`/inbox/comments/${encodeURIComponent(postId)}`, { accountId: account._id, limit: 100, cursor: currentCursor, commentId: focusedComment, ...(post.subreddit ? { subreddit: post.subreddit } : {}) });
      if (result.meta?.accountId !== account._id || result.meta?.platform !== account.platform || !Array.isArray(result.comments)) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio did not return a thread for the selected account.');
      const all = flatten(result.comments, result.comment);
      for (const item of all) if ((item.platform && item.platform !== account.platform) || (item.accountId && item.accountId !== account._id) || item.sample === true) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned a comment outside the selected account.');
      for (const item of all) saveProof(account, 'comment', item.id, postId, { cursor: currentCursor, commentId: focusedComment });
      return { comments: redact(result.comments), parent: redact(result.comment || null), pagination: page(result.pagination), all, post };
    }
    if (path === 'accounts' && req.method === 'GET') {
      const accounts = (await scopedAccounts(api, profileId)).filter(account => COMMENTS.has(account.platform) || REVIEWS.has(account.platform)).map(account => ({ id: account._id, name: account.displayName || account.username || account.name || account.platform, platform: account.platform, active: account.isActive !== false, comments: COMMENTS.has(account.platform), reviews: REVIEWS.has(account.platform) }));
      send(200, { accounts }); return true;
    }
    if (path === 'comments' && req.method === 'GET') {
      const account = await accountFor(url.searchParams.get('accountId'), 'comments'), currentCursor = cursor(url.searchParams.get('cursor'));
      const result = await api('/inbox/comments', { profileId, accountId: account._id, platform: account.platform, limit: 50, minComments: 0, sortBy: 'date', sortOrder: 'desc', cursor: currentCursor });
      const rows = checkedList(result, account);
      for (const row of rows) saveProof(account, 'post', row.id, '', { cid: row.cid || null, subreddit: typeof row.subreddit === 'string' ? row.subreddit : null });
      send(200, { posts: redact(rows), pagination: page(result.pagination), lastUpdated: result.meta?.lastUpdated || null }); return true;
    }
    if (path === 'comments/thread' && req.method === 'GET') {
      const account = await accountFor(url.searchParams.get('accountId'), 'comments'), result = await thread(account, id(url.searchParams.get('postId'), 'post ID'), { cursor: url.searchParams.get('cursor'), commentId: url.searchParams.get('commentId') });
      send(200, { comments: result.comments, parent: result.parent, pagination: result.pagination }); return true;
    }
    if (path === 'reviews' && req.method === 'GET') { const account = await accountFor(url.searchParams.get('accountId'), 'reviews'); send(200, await reviews(account, cursor(url.searchParams.get('cursor')))); return true; }
    if (['comments/reply', 'reviews/reply'].includes(path) && req.method === 'POST') {
      fields(body, path === 'comments/reply' ? ['accountId', 'postId', 'commentId', 'message'] : ['accountId', 'reviewId', 'message', 'expectedReplyVersion', 'confirmReplace']);
      const message = input(body.message, 'reply', 10000), accountId = id(body.accountId, 'account ID');
      const outcome = await operation(context, async key => {
        const account = await accountFor(accountId, path.startsWith('comments') ? 'comments' : 'reviews');
        if (account.isActive === false) fail(409, 'ACCOUNT_UNAVAILABLE', 'Reconnect this account before replying.');
        if (path === 'comments/reply') {
          const postId = id(body.postId, 'post ID'), commentId = id(body.commentId, 'comment ID'), original = proof(account, 'comment', commentId, postId);
          const result = await thread(account, postId, original), target = result.all.find(item => item.id === commentId);
          if (!target) fail(409, 'COMMENT_CHANGED', 'The comment moved or is no longer on this provider page. Reload the thread before replying.');
          if (target.canReply === false) fail(422, 'COMMENT_REPLY_UNAVAILABLE', 'The provider does not allow a reply to this comment.');
          const payload = { accountId, message, commentId };
          if (account.platform === 'bluesky') {
            if (!target.cid || !(target.rootCid || result.post.cid)) fail(409, 'COMMENT_CONTEXT_MISSING', 'Bluesky did not provide the content identifiers needed for a safe reply. Reload the thread.');
            Object.assign(payload, { parentCid: target.cid, rootUri: target.rootUri || postId, rootCid: target.rootCid || result.post.cid });
          }
          const replied = await api(`/inbox/comments/${encodeURIComponent(postId)}`, {}, payload, key);
          if (replied.success !== true || typeof replied.data?.commentId !== 'string') fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not confirm the comment reply.', true);
          store.activity(project.id, 'Replied to a provider comment.'); return { reply: redact(replied.data), platform: account.platform };
        }
        const reviewId = id(body.reviewId, 'review ID'), original = proof(account, 'review', reviewId), fresh = await reviews(account, original.cursor), review = fresh.reviews.find(item => item.id === reviewId);
        if (!review) fail(409, 'REVIEW_CHANGED', 'This review moved or is no longer on the provider page. Reload it before replying.');
        if (body.expectedReplyVersion !== review.replyVersion) fail(409, 'REVIEW_REPLY_CHANGED', 'The existing review reply changed. Reload it and review the current reply before saving.');
        if ((review.hasReply || review.reply) && body.confirmReplace !== true) fail(409, 'REVIEW_REPLACEMENT_CONFIRMATION_REQUIRED', 'This review already has a reply. Confirm updating or adding its provider reply.');
        const replied = await api(`/inbox/reviews/${encodeURIComponent(reviewId)}/reply`, {}, { accountId, message }, key);
        if (replied.status !== 'success' || typeof replied.reply?.text !== 'string' || (replied.platform && replied.platform !== account.platform)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not confirm the review reply.', true);
        const updated = { ...review, hasReply: true, reply: redact(replied.reply) }; updated.replyVersion = version(updated);
        store.activity(project.id, 'Replied to a provider review.'); return { reply: updated.reply, review: updated, reviewId, platform: account.platform };
      }); send(outcome.status, outcome.data); return true;
    }
    fail(404, 'ENGAGEMENT_ACTION_NOT_FOUND', 'This engagement action was not found.');
  } catch (error) {
    send(error instanceof IntegrationError ? error.status : 500, { error: { code: error instanceof IntegrationError ? error.code : 'ENGAGEMENT_ERROR', message: error instanceof IntegrationError ? error.message : 'The engagement request could not be completed.' } }); return true;
  }
}
