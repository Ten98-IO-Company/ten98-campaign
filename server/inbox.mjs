import { createHash } from 'node:crypto';
import { IntegrationError, operation, redact, zernioClient, scopedAccounts, requireAccount } from './integrations.mjs';
import { listWhatsAppTemplates, validateWhatsAppTemplate } from './direct-providers.mjs';
import { publicMediaUrl } from '../shared/social-posts.mjs';

const fail = (status, code, message, uncertain = false) => { throw new IntegrationError(status, code, message, uncertain); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => { if (typeof value !== 'string' || !value || value.length > 2000 || /[\s\u0000-\u001f\u007f]/.test(value)) fail(400, 'INVALID_INBOX_ID', 'Choose a valid inbox item.'); return value; };
const str = (value, label, max = 10000) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(400, 'INVALID_INBOX_CONTENT', `Enter a valid ${label} of at most ${max} characters.`); return value; };
const fields = (body, allowed) => { if (!plain(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_INBOX_FIELD', 'Use only the fields shown for this inbox action.'); };
const pick = (row, keys) => Object.fromEntries(keys.filter(key => row?.[key] !== undefined).map(key => [key, redact(row[key])]));
const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 2000 && !/[\s\u0000-\u001f\u007f]/.test(value);
const invalid = (uncertain = false) => fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return a complete, scoped inbox response. Reconcile any external action before retrying.', uncertain);
const DM = new Set(['facebook', 'instagram', 'twitter', 'bluesky', 'reddit', 'telegram', 'whatsapp', 'imessage', 'slack', 'tiktok', 'sms', 'rcs']);
const MESSAGE_LIMITS = { facebook: 2000, instagram: 1000, telegram: 4096, whatsapp: 4096, imessage: 9999, tiktok: 6000, slack: 40000, sms: 1600, rcs: 3072 };
const DOCUMENT_MIMES = new Set(['application/pdf', 'text/plain', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']);
const COMMENTS = new Set(['facebook', 'instagram', 'twitter', 'bluesky', 'threads', 'youtube', 'linkedin', 'reddit', 'tiktok', 'metaads']);
const HIDE = new Set(['facebook', 'instagram', 'threads', 'twitter', 'tiktok']);
const LIKE = new Set(['facebook', 'twitter', 'bluesky', 'reddit', 'linkedin']);
const REVIEWS = new Set(['facebook', 'googlebusiness']);
const WRITERS = new Set(['owner', 'admin', 'editor']);
const conversationFields = ['id', 'platform', 'accountId', 'accountUsername', 'participantId', 'participantName', 'participantPicture', 'participantVerifiedType', 'businessScopedUserId', 'whatsappUsername', 'lastMessage', 'lastMessageAt', 'updatedTime', 'status', 'unreadCount', 'threadControl', 'folder', 'url', 'instagramProfile', 'metadata'];
const messageFields = ['id', 'conversationId', 'accountId', 'platform', 'message', 'senderId', 'senderName', 'direction', 'createdAt', 'attachments', 'subject', 'storyReply', 'isStoryMention', 'noRenderableContent', 'isEdited', 'editedAt', 'isDeleted', 'deletedAt', 'deliveryStatus', 'reactions', 'sentVia'];
const postFields = ['id', 'platform', 'accountId', 'accountUsername', 'content', 'picture', 'permalink', 'createdTime', 'commentCount', 'likeCount', 'cid', 'subreddit', 'isAd', 'adId', 'placement'];
const commentFields = ['id', 'message', 'createdTime', 'from', 'likeCount', 'replyCount', 'platform', 'url', 'repliesHasMore', 'canReply', 'canDelete', 'canHide', 'canLike', 'isHidden', 'isLiked', 'likeUri', 'cid', 'parentId', 'rootUri', 'rootCid'];
const reviewFields = ['id', 'platform', 'accountId', 'accountUsername', 'locationId', 'locationName', 'reviewer', 'rating', 'recommendationType', 'text', 'created', 'hasReply', 'hasPhotos', 'photoCount', 'photos', 'reply', 'reviewUrl'];

function renderFields(row, strings = [], numbers = [], booleans = []) {
  if (!plain(row) || strings.some(key => row[key] != null && typeof row[key] !== 'string') || numbers.some(key => row[key] != null && (typeof row[key] !== 'number' || !Number.isFinite(row[key]) || row[key] < 0)) || booleans.some(key => row[key] != null && typeof row[key] !== 'boolean')) invalid();
}
function validateConversation(row) {
  renderFields(row, conversationFields.filter(key => !['unreadCount', 'instagramProfile', 'metadata'].includes(key)), ['unreadCount']);
  if (row.instagramProfile != null) renderFields(row.instagramProfile, ['fetchedAt'], ['followerCount'], ['isFollower', 'isFollowing', 'isVerified']);
  if (row.metadata != null && !plain(row.metadata)) invalid();
}
function validateReview(row) {
  renderFields(row, reviewFields.filter(key => !['rating', 'photoCount', 'hasReply', 'hasPhotos', 'reviewer', 'photos', 'reply'].includes(key)), ['rating', 'photoCount'], ['hasReply', 'hasPhotos']);
  if (row.reviewer != null) renderFields(row.reviewer, ['id', 'name', 'profileImage']);
  if (row.reply != null) renderFields(row.reply, ['id', 'text', 'created']);
  if (row.photos != null) { if (!Array.isArray(row.photos)) invalid(); row.photos.forEach(photo => renderFields(photo, ['url'])); }
}

export function inboxCapabilities(platform) {
  return { messages: DM.has(platform), comments: COMMENTS.has(platform), reviews: REVIEWS.has(platform), reply: DM.has(platform), messageLimit: MESSAGE_LIMITS[platform] || 10000, attachments: ['facebook', 'instagram', 'telegram', 'whatsapp', 'imessage', 'tiktok', 'sms'].includes(platform), attachmentTypes: platform === 'tiktok' ? ['image'] : platform === 'sms' ? ['image', 'video'] : platform === 'instagram' ? ['image', 'video', 'audio'] : ['image', 'video', 'audio', 'file'], archive: DM.has(platform), read: DM.has(platform), commentReply: COMMENTS.has(platform), commentHide: HIDE.has(platform), commentLike: LIKE.has(platform), commentDelete: COMMENTS.has(platform), commentModerate: platform === 'youtube', reviewReply: REVIEWS.has(platform), reviewDeleteReply: platform === 'googlebusiness' };
}
function supported(account, feature) { if (!inboxCapabilities(account.platform)[feature] || account.isActive === false) fail(422, 'INBOX_FEATURE_UNSUPPORTED', 'This account does not support this inbox action. Reconnect the account if its permissions changed.'); }
function scoped(row, accounts, expectedAccount) {
  if (!plain(row) || !valid(row.id) || !valid(row.accountId)) invalid();
  const account = accounts.find(item => item._id === row.accountId);
  if (!account || expectedAccount && account._id !== expectedAccount || row.platform !== account.platform && !(row.isAd && ['facebook', 'instagram'].includes(row.platform) && ['metaads', 'facebook', 'instagram'].includes(account.platform))) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned inbox data outside this project account.');
  return account;
}
function pagination(value, comment = false, allowCursorless = false) {
  if (!plain(value) || typeof value.hasMore !== 'boolean') invalid();
  const cursor = value.nextCursor ?? value.cursor ?? null;
  if (cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > 8192 || /[\u0000-\u001f]/.test(cursor)) || value.hasMore && !cursor && !allowCursorless) invalid();
  return { hasMore: value.hasMore, nextCursor: cursor, ...(comment ? { cursor } : {}) };
}
function query(url, type) {
  const result = { limit: type === 'reviews' ? 25 : 50 }, rules = { status: ['active', 'archived'], folder: ['inbox', 'requests'], sortOrder: ['asc', 'desc'] };
  for (const name of ['cursor', 'status', 'folder', 'sortOrder']) {
    const value = url.searchParams.get(name); if (value === null || value === '') continue;
    if (value.length > 8192 || /[\u0000-\u001f]/.test(value) || rules[name] && !rules[name].includes(value)) fail(400, 'INVALID_INBOX_FILTER', 'Choose valid inbox filters.'); result[name] = value;
  }
  if (url.searchParams.has('limit')) { const value = Number(url.searchParams.get('limit')); if (!Number.isInteger(value) || value < 1 || value > (type === 'reviews' ? 50 : 100)) fail(400, 'INVALID_INBOX_FILTER', 'Choose a valid inbox page size.'); result.limit = value; }
  if (type !== 'conversations') { delete result.status; delete result.folder; if (type !== 'messages') delete result.sortOrder; }
  return result;
}
function metadata(value, accounts) {
  if (!value) return {};
  if (!plain(value)) invalid();
  const result = pick(value, ['lastUpdated', 'accountsQueried', 'accountsFailed']);
  for (const key of ['failedAccounts', 'accountsSkipped']) if (value[key] !== undefined) {
    if (!Array.isArray(value[key]) || value[key].some(row => !plain(row) || !accounts.some(account => account._id === row.accountId))) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned inbox diagnostics outside this project.');
    result[key] = value[key].map(row => ({ ...pick(row, ['accountId', 'platform', 'code', 'retryAfter']), ...(key === 'failedAccounts' ? { error: 'The provider could not read this account. Check its connection and permissions.' } : {}) }));
  }
  return result;
}
function conversationContact(context, row, incoming = false) {
  if (row.platform !== 'facebook' || !valid(row.participantId)) return undefined;
  const identity = { accountId: row.accountId, participantId: row.participantId, conversationId: row.id, ...(typeof row.participantName === 'string' ? { name: row.participantName.slice(0, 200) } : {}) };
  if (row.participantPicture) try { identity.avatarUrl = publicMediaUrl(row.participantPicture); } catch { /* A missing profile picture must not prevent reading a conversation. */ }
  if (incoming) context.contacts?.fromMessenger?.(context.project.id, identity);
  return context.contacts?.findMessenger?.(context.project.id, row.accountId, row.participantId) || undefined;
}
async function conversation(api, accounts, account, conversationId) {
  const result = await api(`/inbox/conversations/${encodeURIComponent(conversationId)}`, { accountId: account._id }), row = result.data;
  scoped(row, accounts, account._id);
  validateConversation(row);
  // Meta lists platform thread IDs but detail/send can return a different stored ID.
  return pick(row, conversationFields);
}
async function history(api, account, conversationId, params = {}, resolvedId = conversationId) {
  const result = await api(`/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, { accountId: account._id, limit: 100, sortOrder: 'desc', ...params });
  if (!Array.isArray(result.messages) || result.messages.length > 100) invalid();
  for (const row of result.messages) if (!plain(row) || !valid(row.id) || row.accountId !== undefined && row.accountId !== account._id || row.platform !== undefined && row.platform !== account.platform || row.conversationId !== undefined && ![conversationId, resolvedId].includes(row.conversationId) || !['incoming', 'outgoing'].includes(row.direction) || row.attachments !== undefined && (!Array.isArray(row.attachments) || row.attachments.length > 100 || row.attachments.some(item => !plain(item) || typeof item.type !== 'string' || item.url !== undefined && typeof item.url !== 'string')) || row.reactions !== undefined && (!Array.isArray(row.reactions) || row.reactions.some(item => !plain(item) || typeof item.emoji !== 'string'))) invalid();
  for (const row of result.messages) {
    renderFields(row, messageFields.filter(key => !['attachments', 'storyReply', 'reactions', 'isStoryMention', 'noRenderableContent', 'isEdited', 'isDeleted'].includes(key)), [], ['isStoryMention', 'noRenderableContent', 'isEdited', 'isDeleted']);
    for (const attachment of row.attachments || []) renderFields(attachment, ['id', 'type', 'originalType', 'mimeType', 'url', 'refreshUrl', 'name', 'filename', 'previewUrl']);
    for (const reaction of row.reactions || []) renderFields(reaction, ['emoji', 'reactedAt'], [], ['fromMe']);
    if (row.storyReply != null) renderFields(row.storyReply, ['storyId', 'storyUrl']);
  }
  return { messages: result.messages.map(row => pick(row, messageFields)), pagination: pagination(result.pagination), sortOrderApplied: result.sortOrderApplied || 'desc' };
}
async function aggregate(api, accounts, account, kind, params) {
  const result = await api(`/inbox/${kind}`, { profileId: account.profileId?._id || account.profileId, accountId: account._id, ...params });
  if (!Array.isArray(result.data) || result.data.length > (kind === 'reviews' ? 50 : 100)) invalid();
  result.data.forEach(row => {
    scoped(row, accounts, account._id);
    if (kind === 'conversations') validateConversation(row);
    else if (kind === 'reviews') validateReview(row);
    else renderFields(row, postFields.filter(key => !['commentCount', 'likeCount', 'isAd'].includes(key)), ['commentCount', 'likeCount'], ['isAd']);
  });
  return { rows: result.data, pagination: pagination(result.pagination, false, kind === 'conversations' && params.folder === 'requests'), meta: metadata(result.meta, accounts), ...(result.summary ? { summary: pick(result.summary, ['totalReviews', 'averageRating']) } : {}) };
}
async function findRow(api, accounts, account, kind, resourceId) {
  let cursor; const seen = new Set();
  // ponytail: scope checks scan at most 2,000 posts or 1,000 reviews; use a persisted resource index for older items.
  for (let page = 0; page < 20; page++) {
    const result = await aggregate(api, accounts, account, kind, { limit: kind === 'reviews' ? 50 : 100, ...(cursor ? { cursor } : {}) }), row = result.rows.find(item => item.id === resourceId);
    if (row) return row;
    if (!result.pagination.hasMore) fail(403, 'INBOX_ITEM_OUTSIDE_PROJECT', 'This item was not found in this project account.');
    cursor = result.pagination.nextCursor; if (seen.has(cursor)) invalid(); seen.add(cursor);
  }
  fail(503, 'INCOMPLETE_PROVIDER_DATA', 'This inbox feed exceeds the scope-check limit. Use the provider dashboard for older items.');
}
function normalizedComment(row, platform, depth = 0) {
  if (!plain(row) || !valid(row.id) || row.platform && row.platform !== platform || depth > 3) invalid();
  renderFields(row, commentFields.filter(key => !['from', 'likeCount', 'replyCount', 'repliesHasMore', 'canReply', 'canDelete', 'canHide', 'canLike', 'isHidden', 'isLiked'].includes(key)), ['likeCount', 'replyCount'], ['repliesHasMore', 'canReply', 'canDelete', 'canHide', 'canLike', 'isHidden', 'isLiked']);
  if (row.from != null) renderFields(row.from, ['id', 'name', 'username', 'picture', 'verifiedType'], [], ['isOwner']);
  const result = pick(row, commentFields);
  if (row.replies !== undefined) { if (!Array.isArray(row.replies) || row.replies.length > 100) invalid(); result.replies = row.replies.map(item => normalizedComment(item, platform, depth + 1)); }
  return result;
}
async function thread(api, accounts, account, post, params = {}) {
  const result = post.isAd ? await api(`/ads/${encodeURIComponent(id(post.adId))}/comments`, { placement: post.placement, limit: 100, ...params }) : await api(`/inbox/comments/${encodeURIComponent(post.id)}`, { accountId: account._id, limit: 100, ...(post.subreddit ? { subreddit: post.subreddit } : {}), ...params });
  if (!Array.isArray(result.comments) || result.comments.length > 100 || !plain(result.meta) || result.meta.accountId !== account._id) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned another account’s comment thread.');
  const platform = result.meta.platform;
  if (platform !== account.platform && !(post.isAd && ['facebook', 'instagram'].includes(platform) && ['metaads', 'facebook', 'instagram'].includes(account.platform))) invalid();
  if (post.isAd && (result.meta.adId !== post.adId || !['facebook', 'instagram'].includes(post.placement) || platform !== post.placement || result.meta.placement !== undefined && result.meta.placement !== post.placement)) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned another ad or placement’s comment thread.');
  if (!post.isAd && result.meta.postId !== undefined && result.meta.postId !== post.id && result.meta.postUrn !== post.id) invalid();
  const comments = result.comments.map(row => normalizedComment(row, platform)), parent = result.comment ? normalizedComment(result.comment, platform) : undefined;
  if (params.commentId && parent && parent.id !== params.commentId) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned another comment’s replies.');
  return { comments, ...(parent ? { parent } : {}), post: pick(post, postFields), pagination: pagination(result.pagination, true), meta: pick(result.meta, ['platform', 'postId', 'accountId', 'subreddit', 'postUrn', 'adId', 'effectiveStoryId', 'facebookAccountId', 'instagramAccountId', 'placement', 'adComments']) };
}
const flatten = rows => rows.flatMap(row => [row, ...flatten(row.replies || [])]);
async function findComment(api, accounts, account, post, commentId) {
  let cursor; const seen = new Set();
  for (let page = 0; page < 20; page++) {
    const result = await thread(api, accounts, account, post, { ...(cursor ? { cursor } : {}) }), row = flatten(result.comments).find(item => item.id === commentId);
    if (row) return { row, thread: result };
    if (!result.pagination.hasMore) {
      if (!post.isAd && ['facebook', 'instagram'].includes(account.platform)) {
        const focused = await thread(api, accounts, account, post, { commentId });
        if (focused.parent?.id === commentId && (focused.meta.postId === post.id || focused.meta.postUrn === post.id)) return { row: focused.parent, thread: focused };
      }
      fail(403, 'COMMENT_OUTSIDE_POST', 'This comment was not found on the selected post.');
    }
    cursor = result.pagination.nextCursor; if (seen.has(cursor)) invalid(); seen.add(cursor);
  }
  fail(503, 'INCOMPLETE_PROVIDER_DATA', 'This post exceeds the comment scope-check limit. Open it in the provider dashboard.');
}
function priorHiddenComment(context, account, post, commentId) {
  if (account.platform !== 'instagram' && post.placement !== 'instagram') return null;
  // Instagram via Facebook Login omits hidden comments. Only this app's completed, scoped hide receipt can substitute for a missing fresh row.
  // ponytail: search the latest 500 receipts; use an indexed resource table if operators need older hidden-comment recovery.
  const receipts = context.db.prepare("SELECT response FROM integration_operations WHERE project_id=? AND status='complete' ORDER BY rowid DESC LIMIT 500").all(context.project.id);
  for (const receipt of receipts) {
    const proof = JSON.parse(receipt.response)?.hiddenCommentProof;
    if (proof?.profileId === context.project.zernioProfileId && proof.accountId === account._id && proof.postId === post.id && proof.comment?.id === commentId) return proof.hidden === true ? { row: proof.comment, thread: { meta: proof.meta } } : null;
  }
  return null;
}
export const inboxReplyVersion = row => createHash('sha256').update(JSON.stringify([row.id, row.accountId, row.hasReply, row.reply?.id || null, row.reply?.text || null, row.reply?.created || null])).digest('hex');
const review = row => ({ ...pick(row, reviewFields), replyVersion: inboxReplyVersion(row) });

export async function handleInbox(context) {
  const { req, url, project, role, send, body = {} } = context, prefix = `/api/projects/${encodeURIComponent(project.id)}/integrations/inbox`;
  if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return false;
  const path = url.pathname.slice(prefix.length).replace(/^\//, '');
  const route = path.match(/^conversations\/([^/]+)(?:\/(messages|reply|read|status))?$/), action = path.match(/^(comments|reviews)\/(reply|hide|unhide|delete|like|unlike|moderate|delete-reply)$/);
  if (!['status', 'accounts', 'updates', 'conversations', 'comments', 'comments/thread', 'reviews'].includes(path) && !route && !action || action && (action[1] === 'reviews' && !['reply', 'delete-reply'].includes(action[2]) || action[1] === 'comments' && action[2] === 'delete-reply')) { send(404, { error: { code: 'INBOX_ROUTE_NOT_FOUND', message: 'This inbox action was not found.' } }); return true; }
  try {
    if (!['GET', 'POST'].includes(req.method)) fail(405, 'METHOD_NOT_ALLOWED', 'Use the available inbox controls.');
    const mutation = Boolean(route && ['reply', 'read', 'status'].includes(route[2]) || action);
    if (req.method !== (mutation ? 'POST' : 'GET')) fail(405, 'METHOD_NOT_ALLOWED', 'This inbox action does not support that method.');
    if (mutation && !WRITERS.has(role)) fail(403, 'WRITE_PERMISSION_REQUIRED', 'Editing permission is required for this inbox action.');
    const env = { ...(context.config?.env || process.env), ...(context.config || {}) }, profileId = project.zernioProfileId, assertMapping = () => context.assertProjectMapping?.(profileId);
    if (path === 'updates') {
      const accountId = id(url.searchParams.get('accountId')), after = url.searchParams.has('after') ? Number(url.searchParams.get('after')) : undefined;
      if (after !== undefined && (!Number.isSafeInteger(after) || after < 0)) fail(400, 'INVALID_INBOX_FILTER', 'Choose a valid update cursor.');
      assertMapping(); send(200, context.webhooks?.updates?.(project.id, { accountId, after, limit: 100 }) || { updates: [], cursor: after || 0, hasMore: false, checkedAt: new Date().toISOString() }); return true;
    }
    if (path === 'status' && (!env.ZERNIO_API_KEY || !profileId)) { send(200, { configured: Boolean(env.ZERNIO_API_KEY), mapped: Boolean(profileId), webhookConfigured: Boolean(env.ZERNIO_WEBHOOK_SECRET), accounts: [] }); return true; }
    if (!env.ZERNIO_API_KEY) fail(503, 'ZERNIO_NOT_CONFIGURED', 'Configure Zernio in Integrations to open the inbox.');
    if (!valid(profileId)) fail(409, 'ZERNIO_NOT_MAPPED', 'Map a Zernio profile to this project first.');
    const api = zernioClient(env.ZERNIO_API_KEY, assertMapping), accounts = await scopedAccounts(api, profileId);
    accounts.forEach(account => renderFields(account, ['_id', 'platform', 'displayName', 'username', 'name'], [], ['isActive']));
    if (['status', 'accounts'].includes(path)) { send(200, { configured: true, mapped: true, webhookConfigured: Boolean(env.ZERNIO_WEBHOOK_SECRET), accounts: accounts.filter(account => { const c = inboxCapabilities(account.platform); return c.messages || c.comments || c.reviews; }).map(account => ({ id: account._id, platform: account.platform, name: account.displayName || account.username || account.name || account.platform, capabilities: inboxCapabilities(account.platform) })) }); return true; }
    const accountId = id(req.method === 'GET' ? url.searchParams.get('accountId') : body.accountId), account = requireAccount(accounts, accountId);
    const run = async key => {
      if (path === 'conversations') {
        supported(account, 'messages'); const result = await aggregate(api, accounts, account, 'conversations', query(url, 'conversations'));
        return { conversations: result.rows.map(row => ({ ...pick(row, conversationFields), ...(conversationContact(context, row) ? { contact: conversationContact(context, row) } : {}) })), pagination: result.pagination, meta: result.meta };
      }
      if (route) {
        supported(account, 'messages'); const conversationId = id(decodeURIComponent(route[1])), row = await conversation(api, accounts, account, conversationId);
        if (!route[2]) return { conversation: row, contact: conversationContact(context, row) };
        if (route[2] === 'messages') {
          const result = await history(api, account, conversationId, query(url, 'messages'), row.id), incoming = result.messages.some(message => message.direction === 'incoming' && message.senderId === row.participantId);
          return { ...result, conversation: row, contact: conversationContact(context, row, incoming) };
        }
        if (route[2] === 'status') {
          fields(body, ['accountId', 'status']); if (!['active', 'archived'].includes(body.status)) fail(400, 'INVALID_INBOX_STATUS', 'Choose active or archived.');
          const result = await api(`/inbox/conversations/${encodeURIComponent(conversationId)}`, {}, { accountId, status: body.status }, key, 'PUT');
          if (result.success !== true || result.data?.accountId !== accountId || result.data?.platform !== account.platform || result.data?.status !== body.status || ![conversationId, row.id].includes(result.data?.id)) invalid(true);
          return { conversation: { ...row, status: body.status } };
        }
        if (route[2] === 'read') {
          fields(body, ['accountId']); const result = await api(`/inbox/conversations/${encodeURIComponent(conversationId)}/read`, {}, { accountId }, key);
          if (result.success !== true || !Number.isSafeInteger(result.markedCount) || result.markedCount < 0) invalid(true); return { read: true, markedCount: result.markedCount };
        }
        fields(body, ['accountId', 'message', 'attachmentUrl', 'attachmentType', 'attachmentName', 'replyTo', 'messageTag', 'templateName', 'templateLanguage', 'templateComponents']);
        const payload = { accountId };
        if (body.message !== undefined && body.message !== '') payload.message = str(body.message, 'message', inboxCapabilities(account.platform).messageLimit);
        if (body.attachmentUrl) {
          supported(account, 'attachments'); if (!['image', 'video', 'audio', 'file'].includes(body.attachmentType)) fail(400, 'INVALID_ATTACHMENT', 'Choose an image, video, audio file or document.');
          try { payload.attachmentUrl = publicMediaUrl(body.attachmentUrl); } catch { fail(400, 'INVALID_ATTACHMENT', 'Use a public HTTPS media file URL.'); }
          payload.attachmentType = body.attachmentType; if (body.attachmentName) payload.attachmentName = str(body.attachmentName, 'attachment filename', 255);
          if (!inboxCapabilities(account.platform).attachmentTypes.includes(payload.attachmentType) || account.platform === 'tiktok' && payload.message) fail(422, 'ATTACHMENT_UNSUPPORTED', 'This platform does not support that attachment or a combined text and media message.');
          if (payload.message && ['telegram', 'whatsapp'].includes(account.platform) && payload.message.length > 1024) fail(400, 'ATTACHMENT_CAPTION_TOO_LONG', 'Keep the attachment caption to 1024 characters.');
          if (['whatsapp', 'tiktok', 'sms'].includes(account.platform)) {
            let checked;
            try { checked = await api('/tools/validate/media', {}, { url: payload.attachmentUrl }); } catch (error) { if (error instanceof IntegrationError) error.uncertain = false; throw error; }
            if (checked.valid !== true || !Number.isSafeInteger(checked.size) || checked.size < 1 || typeof checked.contentType !== 'string') fail(409, 'ATTACHMENT_NOT_VERIFIED', 'The provider could not verify this attachment’s file type and size.');
            const mime = checked.contentType.split(';')[0].toLowerCase(), limit = account.platform === 'tiktok' ? 3 : account.platform === 'sms' ? 1 : payload.attachmentType === 'image' ? 5 : payload.attachmentType === 'file' ? 100 : 16;
            if (checked.size > limit * 1024 * 1024 || payload.attachmentType === 'image' && !['image/jpeg', 'image/png', ...(account.platform === 'sms' ? ['image/gif', 'image/webp'] : [])].includes(mime) || payload.attachmentType === 'video' && !['video/mp4', 'video/3gpp'].includes(mime) || payload.attachmentType === 'audio' && !['audio/mpeg', 'audio/ogg', 'audio/amr', 'audio/aac', 'audio/mp4'].includes(mime) || payload.attachmentType === 'file' && !DOCUMENT_MIMES.has(mime)) fail(400, 'ATTACHMENT_RESTRICTION', `Choose a supported attachment within the ${limit} MB limit.`);
          }
        } else if (body.attachmentType || body.attachmentName) fail(400, 'INVALID_ATTACHMENT', 'Choose an attachment URL before setting its type or filename.');
        if (body.replyTo) { if (!['whatsapp', 'telegram', 'slack'].includes(account.platform)) fail(422, 'QUOTE_REPLY_UNSUPPORTED', 'This platform does not support quoted replies.'); payload.replyTo = id(body.replyTo); }
        if (body.templateName) {
          if (account.platform !== 'whatsapp' || payload.message || payload.attachmentUrl) fail(400, 'INVALID_TEMPLATE', 'Send a WhatsApp template by itself.');
          const templates = await listWhatsAppTemplates({ env, project, accountId, assertMapping }), draft = { ...body, accountId }, approved = templates.templates.find(item => item.name === body.templateName && item.language === body.templateLanguage);
          payload.template = { elements: [validateWhatsAppTemplate(draft, approved)] };
        }
        if (!payload.message && !payload.attachmentUrl && !payload.template) fail(400, 'EMPTY_MESSAGE', 'Enter a message or choose an attachment or approved template.');
        if (['facebook', 'instagram', 'whatsapp', 'tiktok'].includes(account.platform) && !payload.template) {
          const messages = await history(api, account, conversationId, {}, row.id), seen = new Set();
          // ponytail: scan at most 2,000 recent messages; use the provider dashboard for longer reply-window history.
          for (let page = 1; !messages.messages.some(message => message.direction === 'incoming' && Number.isFinite(Date.parse(message.createdAt))) && messages.pagination.hasMore; page++) {
            if (page >= 20) fail(503, 'INCOMPLETE_PROVIDER_DATA', 'This conversation exceeds the reply-window history limit. Open it in the provider dashboard.');
            const cursor = messages.pagination.nextCursor; if (seen.has(cursor)) invalid(); seen.add(cursor);
            const next = await history(api, account, conversationId, { cursor }, row.id); messages.messages.push(...next.messages); messages.pagination = next.pagination;
          }
          const lastIncoming = messages.messages.filter(message => message.direction === 'incoming').map(message => Date.parse(message.createdAt)).filter(Number.isFinite).sort((a, b) => b - a)[0], age = Date.now() - lastIncoming;
          if (account.platform === 'tiktok' && (!(age >= 0 && age <= 2 * 86400000) || messages.messages.filter(message => message.direction === 'outgoing' && Date.parse(message.createdAt) >= lastIncoming).length >= 10)) fail(409, 'MESSAGING_WINDOW_CLOSED', 'TikTok permits up to ten replies within 48 hours of the customer’s last message.');
          if (body.messageTag) {
            const tags = account.platform === 'instagram' ? ['HUMAN_AGENT'] : account.platform === 'facebook' ? ['CONFIRMED_EVENT_UPDATE', 'POST_PURCHASE_UPDATE', 'ACCOUNT_UPDATE', 'HUMAN_AGENT'] : [];
            if (!tags.includes(body.messageTag) || body.messageTag === 'HUMAN_AGENT' && !(age >= 0 && age <= 7 * 86400000)) fail(400, 'INVALID_MESSAGE_TAG', 'Choose a supported message tag within its permitted reply window.');
            payload.messagingType = 'MESSAGE_TAG'; payload.messageTag = body.messageTag;
          } else if (account.platform !== 'tiktok' && !(age >= 0 && age <= 86400000)) fail(409, 'MESSAGING_WINDOW_CLOSED', account.platform === 'whatsapp' ? 'Choose an approved WhatsApp template outside the 24-hour reply window.' : 'Choose a permitted non-promotional message tag outside the 24-hour reply window.');
        } else if (body.messageTag) fail(422, 'MESSAGE_TAG_UNSUPPORTED', 'Message tags are only available for Facebook and Instagram.');
        const result = await api(`/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, {}, payload, key);
        if (result.success !== true || !plain(result.data) || account.platform !== 'reddit' && !valid(result.data.messageId) || result.data.accountId !== undefined && result.data.accountId !== accountId || result.data.platform !== undefined && result.data.platform !== account.platform || result.data.conversationId !== undefined && !valid(result.data.conversationId) || !['facebook', 'instagram', 'bluesky', 'reddit'].includes(account.platform) && result.data.conversationId !== undefined && ![conversationId, row.id].includes(result.data.conversationId)) invalid(true);
        if (result.warnings != null && (!Array.isArray(result.warnings) || result.warnings.length > 100 || result.warnings.some(warning => typeof warning !== 'string' && (!plain(warning) || ['code', 'param', 'message'].some(field => warning[field] != null && typeof warning[field] !== 'string'))))) invalid(true);
        return { sent: true, ...pick(result.data, ['messageId', 'conversationId', 'messageIds', 'attachments', 'partialFailure']), warnings: (result.warnings || []).map(warning => typeof warning === 'string' ? warning : pick(warning, ['code', 'param', 'message'])) };
      }
      if (path === 'comments') { supported(account, 'comments'); const result = await aggregate(api, accounts, account, 'comments', query(url, 'comments')); return { posts: result.rows.map(row => pick(row, postFields)), pagination: result.pagination, meta: result.meta }; }
      if (path === 'comments/thread' || action?.[1] === 'comments') {
        supported(account, 'comments'); const postId = id(req.method === 'GET' ? url.searchParams.get('postId') : body.postId), post = await findRow(api, accounts, account, 'comments', postId);
        if (req.method === 'GET') return thread(api, accounts, account, post, { ...query(url, 'comments'), ...(url.searchParams.get('commentId') ? { commentId: id(url.searchParams.get('commentId')) } : {}) });
        fields(body, ['accountId', 'postId', 'commentId', 'message', 'moderationStatus', 'banAuthor']);
        const verb = action[2]; let target = null;
        if (body.commentId) {
          const commentId = id(body.commentId);
          try { target = await findComment(api, accounts, account, post, commentId); }
          catch (error) { if (verb !== 'unhide' || error.code !== 'COMMENT_OUTSIDE_POST' || !(target = priorHiddenComment(context, account, post, commentId))) throw error; }
        }
        if (verb !== 'reply' && !target) fail(400, 'COMMENT_REQUIRED', 'Choose a comment first.');
        let moderationAccount = account, moderationPostId = post.id;
        if (post.isAd) {
          const meta = (target?.thread || await thread(api, accounts, account, post)).meta, bridgeId = meta.platform === 'instagram' ? meta.instagramAccountId : meta.facebookAccountId;
          moderationAccount = requireAccount(accounts, id(bridgeId)); moderationPostId = id(meta.effectiveStoryId);
          if (moderationAccount.platform !== meta.platform) fail(403, 'INBOX_ITEM_OUTSIDE_PROJECT', 'The ad’s moderation account is not connected to this project.');
        }
        const platform = moderationAccount.platform, endpoint = `/inbox/comments/${encodeURIComponent(moderationPostId)}`, commentEndpoint = target ? `${endpoint}/${encodeURIComponent(target.row.id)}` : endpoint, payload = { accountId: moderationAccount._id };
        if (verb === 'reply') {
          if (target?.row.canReply === false) fail(422, 'COMMENT_ACTION_UNSUPPORTED', 'This comment cannot be replied to through the provider.');
          payload.message = str(body.message, 'comment reply'); if (target) payload.commentId = target.row.id;
          if (platform === 'bluesky') { const root = target?.row || post; if (!valid(root.cid)) fail(409, 'COMMENT_REFERENCE_REQUIRED', 'Refresh this Bluesky thread before replying.'); payload.parentCid = root.cid; payload.rootUri = target?.row.rootUri || post.id; payload.rootCid = target?.row.rootCid || post.cid; if (!valid(payload.rootCid)) fail(409, 'COMMENT_REFERENCE_REQUIRED', 'Refresh the Bluesky post reference before replying.'); }
          const result = await api(endpoint, {}, payload, key); if (result.success !== true || !valid(result.data?.commentId)) invalid(true); return { replied: true, ...pick(result.data, ['commentId', 'isReply', 'cid']) };
        }
        if (['hide', 'unhide'].includes(verb)) {
          if (!HIDE.has(platform) || target.row.canHide === false) fail(422, 'COMMENT_ACTION_UNSUPPORTED', 'This comment cannot be hidden through the provider.');
          const result = await api(`${commentEndpoint}/hide`, verb === 'unhide' ? payload : {}, verb === 'hide' ? payload : undefined, key, verb === 'hide' ? 'POST' : 'DELETE');
          if (result.status !== 'success' || result.commentId !== target.row.id || result.platform !== platform || result.hidden !== (verb === 'hide')) invalid(true);
          return { commentId: target.row.id, hidden: result.hidden, ...(platform === 'instagram' ? { hiddenCommentProof: { profileId, accountId, postId: post.id, comment: pick(target.row, ['id', 'platform', 'canHide']), meta: target.thread.meta, hidden: result.hidden } } : {}) };
        }
        if (['like', 'unlike'].includes(verb)) {
          if (!LIKE.has(platform) || target.row.canLike === false) fail(422, 'COMMENT_ACTION_UNSUPPORTED', 'This comment cannot be liked through the provider.');
          if (platform === 'bluesky') { if (!valid(verb === 'like' ? target.row.cid : target.row.likeUri)) fail(409, 'COMMENT_REFERENCE_REQUIRED', 'Refresh this Bluesky comment before changing its like.'); if (verb === 'like') payload.cid = target.row.cid; else payload.likeUri = target.row.likeUri; }
          const result = await api(`${commentEndpoint}/like`, verb === 'unlike' ? payload : {}, verb === 'like' ? payload : undefined, key, verb === 'like' ? 'POST' : 'DELETE');
          if (result.status !== 'success' || result.commentId !== target.row.id || result.platform !== platform || result.liked !== (verb === 'like')) invalid(true); return { commentId: target.row.id, liked: result.liked, ...pick(result, ['likeUri', 'alreadyReacted']) };
        }
        if (verb === 'delete') {
          if (target.row.canDelete !== true) fail(422, 'COMMENT_ACTION_UNSUPPORTED', 'The provider did not grant permission to delete this comment.');
          const result = await api(endpoint, { ...payload, commentId: target.row.id }, undefined, key, 'DELETE'); if (result.success !== true) invalid(true); return { commentId: target.row.id, deleted: true };
        }
        if (verb === 'moderate') {
          if (platform !== 'youtube' || !['published', 'rejected', 'heldForReview'].includes(body.moderationStatus) || body.banAuthor !== undefined && typeof body.banAuthor !== 'boolean' || body.banAuthor === true && body.moderationStatus !== 'rejected') fail(400, 'INVALID_MODERATION', 'Choose a valid YouTube moderation status. Banning an author requires rejection.');
          const result = await api(`${commentEndpoint}/moderation`, {}, { ...payload, platform, moderationStatus: body.moderationStatus, ...(body.banAuthor !== undefined ? { banAuthor: body.banAuthor } : {}) }, key); if (result.success !== true) invalid(true); return { commentId: target.row.id, moderationStatus: body.moderationStatus };
        }
        fail(404, 'INBOX_ROUTE_NOT_FOUND', 'This comment action was not found.');
      }
      if (path === 'reviews') { supported(account, 'reviews'); const result = await aggregate(api, accounts, account, 'reviews', query(url, 'reviews')); return { reviews: result.rows.map(review), pagination: result.pagination, meta: result.meta, summary: result.summary }; }
      if (action?.[1] === 'reviews') {
        supported(account, 'reviews'); fields(body, ['accountId', 'reviewId', 'message', 'expectedReplyVersion', 'confirmReplace']);
        const row = await findRow(api, accounts, account, 'reviews', id(body.reviewId)), version = inboxReplyVersion(row), deleting = action[2] === 'delete-reply';
        if (!['reply', 'delete-reply'].includes(action[2])) fail(404, 'INBOX_ROUTE_NOT_FOUND', 'This review action was not found.');
        if (body.expectedReplyVersion !== version || row.hasReply && body.confirmReplace !== true) fail(409, 'REVIEW_REPLY_CHANGED', 'Refresh this review and confirm replacing its current reply.');
        if (deleting && account.platform !== 'googlebusiness') fail(422, 'REVIEW_DELETE_UNSUPPORTED', 'Only Google Business Profile review replies can be deleted.');
        const payload = { accountId, ...(!deleting ? { message: str(body.message, 'review reply', account.platform === 'googlebusiness' ? 4096 : 10000) } : {}) }, result = await api(`/inbox/reviews/${encodeURIComponent(row.id)}/reply`, {}, payload, key, deleting ? 'DELETE' : 'POST');
        if (result.status !== 'success' || result.platform !== account.platform || !deleting && (!plain(result.reply) || result.reply.text !== payload.message)) invalid(true);
        return { reviewId: row.id, ...(deleting ? { deleted: true } : { reply: pick(result.reply, ['id', 'text', 'created']) }) };
      }
      fail(404, 'INBOX_ROUTE_NOT_FOUND', 'This inbox action was not found.');
    };
    if (mutation) { const result = await operation(context, run); send(result.status, result.data); } else send(200, await run());
  } catch (error) { if (!(error instanceof IntegrationError)) throw error; send(error.status, { error: { code: error.code, message: error.message } }); }
  return true;
}
