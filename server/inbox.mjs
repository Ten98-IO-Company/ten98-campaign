import { createHash } from 'node:crypto';
import { IntegrationError, operation, redact, zernioClient, scopedAccounts, requireAccount } from './provider-core.ts';
import { listWhatsAppTemplates, validateWhatsAppTemplate } from './direct-providers.mjs';
import { publicMediaUrl, assetDeliveryIssue } from '../shared/social-posts.ts';

const fail = (status, code, message, uncertain = false) => { throw new IntegrationError(status, code, message, uncertain); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => { if (typeof value !== 'string' || !value || value.length > 2000 || /[\s\u0000-\u001f\u007f]/.test(value)) fail(400, 'INVALID_INBOX_ID', 'Choose a valid inbox item.'); return value; };
const decodedId = value => { try { return id(decodeURIComponent(value)); } catch (error) { if (error instanceof IntegrationError) throw error; fail(400, 'INVALID_INBOX_ID', 'Choose a valid inbox item.'); } };
const str = (value, label, max = 10000) => { if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(400, 'INVALID_INBOX_CONTENT', `Enter a valid ${label} of at most ${max} characters.`); return value; };
const fields = (body, allowed) => { if (!plain(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_INBOX_FIELD', 'Use only the fields shown for this inbox action.'); };
const pick = (row, keys) => Object.fromEntries(keys.filter(key => row?.[key] !== undefined).map(key => [key, redact(row[key])]));
const valid = value => typeof value === 'string' && value.length > 0 && value.length <= 2000 && !/[\s\u0000-\u001f\u007f]/.test(value);
const invalid = (uncertain = false) => fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return a complete, scoped inbox response. Reconcile any external action before retrying.', uncertain);
const DM = new Set(['facebook', 'instagram', 'twitter', 'bluesky', 'reddit', 'telegram', 'whatsapp', 'imessage', 'slack', 'tiktok', 'sms', 'rcs']);
const MESSAGE_LIMITS = { facebook: 2000, instagram: 1000, telegram: 4096, whatsapp: 4096, imessage: 9999, tiktok: 6000, slack: 40000, sms: 1600, rcs: 3072 };
const DOCUMENT_MIMES = new Set(['application/pdf', 'text/plain', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']);
const REPLY_MEDIA = {
  instagram: {
    image: { maxMB: 8, formats: 'PNG or JPEG', mimes: ['image/png', 'image/jpeg'] },
    video: { maxMB: 25, formats: 'MP4, OGG, AVI, MOV or WebM', mimes: ['video/mp4', 'video/ogg', 'video/x-msvideo', 'video/avi', 'video/quicktime', 'video/webm'] },
    audio: { maxMB: 25, formats: 'AAC, M4A, WAV or MP4; no MP3 or OGG/Opus', mimes: ['audio/aac', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/x-wav', 'audio/vnd.wave', 'video/mp4'] },
    file: { maxMB: 25, formats: 'PDF only', mimes: ['application/pdf'] },
  },
  twitter: { image: { maxMB: 25, formats: 'Image files; X checks the file format', mimePrefix: 'image/' }, video: { maxMB: 25, formats: 'Video files; X checks the codec and container', mimePrefix: 'video/' } },
};
const COMMENTS = new Set(['facebook', 'instagram', 'twitter', 'bluesky', 'threads', 'youtube', 'linkedin', 'reddit', 'tiktok', 'metaads']);
const HIDE = new Set(['facebook', 'instagram', 'threads', 'twitter', 'tiktok']);
const LIKE = new Set(['facebook', 'twitter', 'bluesky', 'reddit', 'linkedin']);
const LINKEDIN_REACTIONS = new Set(['LIKE', 'PRAISE', 'EMPATHY', 'INTEREST', 'APPRECIATION', 'ENTERTAINMENT']);
const REVIEWS = new Set(['facebook', 'googlebusiness']);
const WRITERS = new Set(['owner', 'admin', 'editor']);
const START = new Set(['twitter', 'bluesky', 'reddit', 'slack', 'whatsapp', 'sms']);
const EDIT_MESSAGE = new Set(['telegram', 'imessage']), DELETE_MESSAGE = new Set(['telegram', 'twitter', 'bluesky', 'reddit', 'imessage']), REACT_MESSAGE = new Set(['telegram', 'whatsapp', 'facebook', 'instagram', 'slack', 'imessage']);
const TYPING = new Set(['facebook', 'instagram', 'telegram', 'whatsapp', 'imessage']);
const downloadTypes = new Map([
  ['image/jpeg', ['image', 'jpg', 5]], ['image/png', ['image', 'png', 5]], ['image/webp', ['image', 'webp', 5]],
  ['video/mp4', ['video', 'mp4', 16]], ['video/3gpp', ['video', '3gp', 16]],
  ['audio/aac', ['audio', 'aac', 16]], ['audio/mp4', ['audio', 'm4a', 16]], ['audio/mpeg', ['audio', 'mp3', 16]], ['audio/amr', ['audio', 'amr', 16]], ['audio/ogg', ['audio', 'ogg', 16]],
  ...[...DOCUMENT_MIMES].map((mime, index) => [mime, ['file', ['pdf', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'][index], 100]]),
]);
const conversationFields = ['id', 'platform', 'accountId', 'accountUsername', 'participantId', 'participantName', 'participantUsername', 'participantPicture', 'participantVerifiedType', 'businessScopedUserId', 'whatsappUsername', 'lastMessage', 'lastMessageAt', 'updatedTime', 'status', 'unreadCount', 'threadControl', 'folder', 'url', 'instagramProfile', 'metadata'];
const messageFields = ['id', 'conversationId', 'accountId', 'platform', 'message', 'senderId', 'senderName', 'direction', 'createdAt', 'attachments', 'subject', 'storyReply', 'isStoryMention', 'noRenderableContent', 'isEdited', 'editedAt', 'editCount', 'editHistory', 'isDeleted', 'deletedAt', 'deliveryStatus', 'reactions', 'sentVia'];
const postFields = ['id', 'platform', 'accountId', 'accountUsername', 'content', 'picture', 'permalink', 'createdTime', 'commentCount', 'likeCount', 'cid', 'subreddit', 'isAd', 'adId', 'placement'];
const commentFields = ['id', 'message', 'createdTime', 'from', 'likeCount', 'replyCount', 'platform', 'url', 'repliesHasMore', 'canReply', 'canDelete', 'canHide', 'canLike', 'isHidden', 'isLiked', 'likeUri', 'cid', 'parentId', 'rootUri', 'rootCid'];
const reviewFields = ['id', 'platform', 'accountId', 'accountUsername', 'locationId', 'locationName', 'reviewer', 'rating', 'recommendationType', 'text', 'created', 'hasReply', 'hasPhotos', 'photoCount', 'photos', 'reply', 'reviewUrl'];
const mentionFields = ['id', 'platform', 'accountId', 'accountUsername', 'content', 'permalink', 'authorUrn', 'authorName', 'authorUsername', 'authorPicture', 'organizationalEntity', 'publishedAt', 'createdAt'];

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

export function inboxCapabilities(platform, active = true) {
  return { messages: DM.has(platform), comments: COMMENTS.has(platform), reviews: REVIEWS.has(platform), mentions: platform === 'linkedin' && active, reply: DM.has(platform), replyButtons: platform === 'whatsapp' && active, start: START.has(platform), search: DM.has(platform), messageEdit: EDIT_MESSAGE.has(platform), messageDelete: DELETE_MESSAGE.has(platform), messageReact: REACT_MESSAGE.has(platform), typing: TYPING.has(platform), deleteStoredConversation: DM.has(platform), threadControl: ['facebook', 'instagram', 'whatsapp'].includes(platform), acceptRequest: ['facebook', 'instagram'].includes(platform), messageLimit: MESSAGE_LIMITS[platform] || 10000, attachments: ['facebook', 'instagram', 'twitter', 'telegram', 'whatsapp', 'imessage', 'tiktok', 'sms'].includes(platform), attachmentTypes: platform === 'tiktok' ? ['image'] : ['sms', 'twitter'].includes(platform) ? ['image', 'video'] : ['image', 'video', 'audio', 'file'], ...(REPLY_MEDIA[platform] ? { attachmentRules: REPLY_MEDIA[platform] } : {}), archive: DM.has(platform), read: DM.has(platform), commentReply: COMMENTS.has(platform), commentPrivateReply: ['facebook', 'instagram', 'metaads'].includes(platform), commentEdit: platform === 'reddit', commentHide: HIDE.has(platform), commentLike: LIKE.has(platform), commentDelete: COMMENTS.has(platform), commentModerate: platform === 'youtube', reviewReply: REVIEWS.has(platform), reviewDeleteReply: platform === 'googlebusiness' };
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
  const result = { limit: type === 'reviews' ? 25 : 50 }, rules = { status: ['active', 'archived'], folder: ['inbox', 'requests'], sortOrder: ['asc', 'desc'], sortBy: ['date', 'rating'], hasReply: ['true', 'false'] };
  for (const name of ['cursor', 'status', 'folder', 'sortOrder', ...(type === 'reviews' ? ['minRating', 'maxRating', 'hasReply', 'sortBy'] : [])]) {
    const value = url.searchParams.get(name); if (value === null || value === '') continue;
    if (value.length > 8192 || /[\u0000-\u001f]/.test(value) || rules[name] && !rules[name].includes(value) || ['minRating', 'maxRating'].includes(name) && !/^[1-5]$/.test(value)) fail(400, 'INVALID_INBOX_FILTER', 'Choose valid inbox filters.');
    result[name] = ['minRating', 'maxRating'].includes(name) ? Number(value) : name === 'hasReply' ? value === 'true' : value;
  }
  if (result.minRating > result.maxRating) fail(400, 'INVALID_INBOX_FILTER', 'The minimum review rating cannot exceed the maximum.');
  if (url.searchParams.has('limit')) { const value = Number(url.searchParams.get('limit')); if (!Number.isInteger(value) || value < 1 || value > (type === 'reviews' ? 50 : 100)) fail(400, 'INVALID_INBOX_FILTER', 'Choose a valid inbox page size.'); result.limit = value; }
  if (type !== 'conversations') { delete result.status; delete result.folder; if (!['messages', 'reviews', 'mentions'].includes(type)) delete result.sortOrder; }
  return result;
}
function metadata(value, accounts) {
  if (!value) return {};
  if (!plain(value)) invalid();
  renderFields(value, ['lastUpdated'], ['accountsQueried', 'accountsFailed']);
  const result = pick(value, ['lastUpdated', 'accountsQueried', 'accountsFailed']);
  for (const key of ['failedAccounts', 'accountsSkipped']) if (value[key] !== undefined) {
    if (!Array.isArray(value[key]) || value[key].some(row => !plain(row) || !accounts.some(account => account._id === row.accountId))) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned inbox diagnostics outside this project.');
    for (const row of value[key]) { renderFields(row, ['accountId', 'platform', 'code'], ['retryAfter']); if (row.platform != null && row.platform !== accounts.find(account => account._id === row.accountId)?.platform) invalid(); }
    result[key] = value[key].map(row => ({ ...pick(row, ['accountId', 'platform', 'code', 'retryAfter']), ...(key === 'failedAccounts' ? { error: 'The provider could not read this account. Check its connection and permissions.' } : {}) }));
  }
  return result;
}
async function searchConversations(api, accounts, account, url) {
  const term = str(url.searchParams.get('query')?.trim(), 'search query', 200);
  if (term.length < 2) fail(400, 'INVALID_INBOX_FILTER', 'Enter at least two characters to search message history.');
  const params = query(url, 'search'), direction = url.searchParams.get('direction');
  if (params.limit > 50 || direction !== null && !['incoming', 'outgoing'].includes(direction)) fail(400, 'INVALID_INBOX_FILTER', 'Choose a valid search direction and a page size of at most 50.');
  const result = await api('/inbox/conversations/search', { profileId: account.profileId?._id || account.profileId, accountId: account._id, query: term, ...params, ...(direction ? { direction } : {}) });
  if (!Array.isArray(result.data) || result.data.length > params.limit) invalid();
  const conversations = result.data.map(hit => {
    if (!plain(hit) || !Number.isSafeInteger(hit.matchCount) || hit.matchCount < 0 || !Array.isArray(hit.matches) || hit.matches.length > 3 || hit.matchCount < hit.matches.length) invalid();
    scoped(hit.conversation, accounts, account._id); validateConversation(hit.conversation);
    const matches = hit.matches.map(match => {
      renderFields(match, ['id', 'text', 'direction', 'timestamp']);
      if (!valid(match.id) || !['incoming', 'outgoing'].includes(match.direction) || direction && match.direction !== direction || !Number.isFinite(Date.parse(match.timestamp))) invalid();
      return pick(match, ['id', 'text', 'direction', 'timestamp']);
    });
    return { ...pick(hit.conversation, conversationFields), matchCount: hit.matchCount, matches };
  });
  return { conversations, pagination: pagination(result.pagination), meta: metadata(result.meta, [account]) };
}
async function slackMembers(api, account, search = '') {
  if (account.platform !== 'slack') fail(422, 'INBOX_FEATURE_UNSUPPORTED', 'Choose a Slack account to load workspace members.');
  if (typeof search !== 'string' || search.length > 100 || /[\u0000-\u001f]/.test(search)) fail(400, 'INVALID_INBOX_FILTER', 'Use a member name or handle of at most 100 characters.');
  const result = await api(`/accounts/${encodeURIComponent(account._id)}/slack-members`, { query: search, limit: 2000 });
  if (!Array.isArray(result.members) || result.members.length > 2000) invalid();
  const members = result.members.map(row => { renderFields(row, ['id', 'name', 'username', 'picture']); if (!/^U[A-Z0-9]+$/.test(row.id) || !row.name) invalid(); return pick(row, ['id', 'name', 'username']); });
  if (new Set(members.map(row => row.id)).size !== members.length) invalid();
  return members;
}
function permittedContact(context, channel, contactId) {
  const contact = context.contacts?.get(context.project.id, id(contactId));
  if (!contact || !/^\+[1-9]\d{6,14}$/.test(contact.phone || '') || contact.consents?.[channel] !== true || contact.suppression?.[channel]) fail(409, 'RECIPIENT_PERMISSION_REQUIRED', 'Choose a project contact with recorded permission for this channel and no suppression.');
  return contact;
}
async function startConversation(context, api, account, env, assertMapping, key) {
  const { body } = context;
  supported(account, 'start'); fields(body, ['accountId', 'participantUsername', 'participantId', 'contactId', 'message', 'templateName', 'templateLanguage', 'templateComponents', 'confirmSend']);
  if (body.confirmSend !== true) fail(400, 'SEND_CONFIRMATION_REQUIRED', 'Review the recipient and message before confirming this send.');
  const payload = { accountId: account._id };
  if (['sms', 'whatsapp'].includes(account.platform)) {
    if (body.participantId !== undefined || body.participantUsername !== undefined) fail(400, 'INVALID_RECIPIENT', 'Choose a contact rather than supplying an unverified phone number.');
    payload.participantId = permittedContact(context, account.platform, body.contactId).phone.replace(/^\+/, '');
  } else {
    if (body.contactId !== undefined || Boolean(body.participantId) === Boolean(body.participantUsername)) fail(400, 'INVALID_RECIPIENT', 'Choose exactly one recipient identity.');
    if (account.platform === 'slack') {
      if (!body.participantId || body.participantUsername || !(await slackMembers(api, account)).some(member => member.id === body.participantId)) fail(422, 'RECIPIENT_UNAVAILABLE', 'Choose an eligible member of this connected Slack workspace.');
      payload.participantId = body.participantId;
    } else if (body.participantId) {
      if (account.platform !== 'twitter' || typeof body.participantId !== 'string' || !/^\d{1,25}$/.test(body.participantId)) fail(400, 'INVALID_RECIPIENT', 'Use an X numeric user ID or a supported platform handle.');
      payload.participantId = body.participantId;
    } else {
      const username = str(body.participantUsername, 'recipient handle', 253).trim().replace(account.platform === 'reddit' ? /^(?:u\/|@)/ : /^@/, '');
      if (!(account.platform === 'twitter' ? /^[A-Za-z0-9_]{1,15}$/ : account.platform === 'reddit' ? /^[A-Za-z0-9_-]{3,20}$/ : /^(?:did:plc:[a-z0-9]+|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,})$/).test(username)) fail(400, 'INVALID_RECIPIENT', 'Enter a valid recipient handle for this platform.');
      payload.participantUsername = username;
    }
  }
  if (account.platform === 'whatsapp') {
    if (body.message !== undefined) fail(400, 'TEMPLATE_REQUIRED', 'Use an approved template to start a WhatsApp conversation.');
    const { templates } = await listWhatsAppTemplates({ env, project: context.project, accountId: account._id, assertMapping }), template = validateWhatsAppTemplate(body, templates.find(row => row.name === body.templateName && row.language === body.templateLanguage));
    payload.templateName = template.name; payload.templateLanguage = template.language; payload.templateParams = [];
    for (const part of [...(template.components || [])].sort((a, b) => ({ header: 0, body: 1, button: 2 }[a.type] - { header: 0, body: 1, button: 2 }[b.type]) || Number(a.index || 0) - Number(b.index || 0))) {
      const media = part.type === 'header' && part.parameters[0]?.type !== 'text' ? part.parameters[0] : null;
      if (media) payload.headerMedia = { type: media.type, ...media[media.type] };
      else payload.templateParams.push(...part.parameters.map(parameter => parameter.text));
    }
  } else {
    if (['templateName', 'templateLanguage', 'templateComponents'].some(field => body[field] !== undefined)) fail(400, 'INVALID_TEMPLATE', 'Templates are only available for WhatsApp.');
    payload.message = str(body.message, 'opening message', inboxCapabilities(account.platform).messageLimit);
  }
  // Check the current local opt-out again after recipient/template lookups, immediately before dispatch.
  if (['sms', 'whatsapp'].includes(account.platform) && permittedContact(context, account.platform, body.contactId).phone.replace(/^\+/, '') !== payload.participantId) fail(409, 'RECIPIENT_CHANGED', 'This contact’s phone number changed. Reload recipients and review the new destination.');
  const result = await api('/inbox/conversations', {}, payload, key);
  if (result.success !== true || !plain(result.data) || !valid(result.data.messageId) || !valid(result.data.conversationId)) invalid(true);
  if (['participantId', 'participantName', 'participantUsername'].some(field => result.data[field] != null && typeof result.data[field] !== 'string')) invalid(true);
  if (result.data.accountId !== undefined && result.data.accountId !== account._id || result.data.platform !== undefined && result.data.platform !== account.platform) invalid(true);
  if (payload.participantId && ['twitter', 'slack'].includes(account.platform) && result.data.participantId != null && result.data.participantId !== payload.participantId) invalid(true);
  return { sent: true, ...pick(result.data, ['messageId', 'conversationId', 'participantId', 'participantName', 'participantUsername']), accountId: account._id, platform: account.platform };
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
    renderFields(row, messageFields.filter(key => !['attachments', 'storyReply', 'reactions', 'editCount', 'editHistory', 'isStoryMention', 'noRenderableContent', 'isEdited', 'isDeleted'].includes(key)), ['editCount'], ['isStoryMention', 'noRenderableContent', 'isEdited', 'isDeleted']);
    for (const attachment of row.attachments || []) renderFields(attachment, ['id', 'type', 'originalType', 'mimeType', 'url', 'refreshUrl', 'name', 'filename', 'previewUrl']);
    for (const reaction of row.reactions || []) renderFields(reaction, ['emoji', 'reactedAt'], [], ['fromMe']);
    if (row.editHistory !== undefined) {
      if (!Array.isArray(row.editHistory) || row.editHistory.length > 1000) invalid();
      row.editHistory = row.editHistory.map(entry => { renderFields(entry, ['text', 'editedAt']); if (!Array.isArray(entry.attachments) || entry.attachments.length > 100) invalid(); entry.attachments.forEach(item => renderFields(item, ['type', 'url'])); return { ...pick(entry, ['text', 'editedAt']), attachments: entry.attachments.map(item => pick(item, ['type', 'url'])) }; });
    }
    if (row.storyReply != null) renderFields(row.storyReply, ['storyId', 'storyUrl']);
    if (account.platform === 'whatsapp' && row.direction === 'incoming' && row.metadata != null) {
      renderFields(row.metadata, ['interactiveType', 'interactiveId']);
      if (row.metadata.interactiveType === 'button_reply' && (typeof row.metadata.interactiveId !== 'string' || !row.metadata.interactiveId.trim() || row.metadata.interactiveId.length > 2000 || /[\u0000-\u001f\u007f]/.test(row.metadata.interactiveId))) invalid();
    }
  }
  return { messages: result.messages.map(row => ({ ...pick(row, messageFields), ...(account.platform === 'whatsapp' && row.direction === 'incoming' && row.metadata?.interactiveType === 'button_reply' ? { metadata: pick(row.metadata, ['interactiveType', 'interactiveId']) } : {}) })), pagination: pagination(result.pagination), sortOrderApplied: result.sortOrderApplied || 'desc' };
}
async function recentHistory(api, account, conversationId, resolvedId) {
  const result = await history(api, account, conversationId, {}, resolvedId), seen = new Set();
  // ponytail: scan at most 2,000 recent messages; use the provider dashboard for longer reply-window history.
  for (let page = 1; !result.messages.some(message => message.direction === 'incoming' && Number.isFinite(Date.parse(message.createdAt))) && result.pagination.hasMore; page++) {
    if (page >= 20) fail(503, 'INCOMPLETE_PROVIDER_DATA', 'This conversation exceeds the reply-window history limit. Open it in the provider dashboard.');
    const cursor = result.pagination.nextCursor; if (seen.has(cursor)) invalid(); seen.add(cursor);
    const next = await history(api, account, conversationId, { cursor }, resolvedId); result.messages.push(...next.messages); result.pagination = next.pagination;
  }
  return result.messages;
}
const incomingTime = messages => Math.max(...messages.filter(message => message.direction === 'incoming').map(message => Date.parse(message.createdAt)).filter(Number.isFinite));
const incomingAge = messages => Date.now() - incomingTime(messages);
export const inboxMessageVersion = (message, accountId) => createHash('sha256').update(JSON.stringify([accountId, message.id, message.direction, message.message ?? null, message.createdAt ?? null, message.editedAt ?? null, message.isDeleted || message.deliveryStatus === 'deleted', message.attachments || [], message.reactions || []])).digest('hex');
function messageActions(account, message, windowAge = Infinity) {
  const age = Date.now() - Date.parse(message.createdAt), own = message.direction === 'outgoing', live = account.isActive !== false && !message.isDeleted && message.deliveryStatus !== 'deleted', apple = account.platform === 'imessage';
  return { canEdit: live && own && EDIT_MESSAGE.has(account.platform) && typeof message.message === 'string' && !!message.message.trim() && !message.attachments?.length && (!apple || age >= 0 && age < 15 * 60000), canDelete: live && own && DELETE_MESSAGE.has(account.platform) && (!apple || age >= 0 && age < 2 * 60000), canReact: live && REACT_MESSAGE.has(account.platform) && (!['facebook', 'instagram'].includes(account.platform) || windowAge >= 0 && windowAge <= 86400000), canUnreact: live && REACT_MESSAGE.has(account.platform) && (message.reactions || []).some(reaction => reaction.fromMe === true) && (!['facebook', 'instagram'].includes(account.platform) || windowAge >= 0 && windowAge <= 86400000), deleteScope: ['bluesky', 'reddit'].includes(account.platform) ? 'self' : apple ? 'unsend' : 'platform', ...(apple ? { editUntil: Number.isFinite(age) ? new Date(Date.parse(message.createdAt) + 15 * 60000).toISOString() : null, deleteUntil: Number.isFinite(age) ? new Date(Date.parse(message.createdAt) + 2 * 60000).toISOString() : null } : {}) };
}
async function findMessage(api, account, conversationId, resolvedId, messageId) {
  let cursor; const seen = new Set();
  // ponytail: verify at most 2,000 messages; use the provider dashboard for older actions.
  for (let page = 0; page < 20; page++) {
    const result = await history(api, account, conversationId, cursor ? { cursor } : {}, resolvedId), target = result.messages.find(message => message.id === messageId);
    if (target) return target;
    if (!result.pagination.hasMore) return null;
    cursor = result.pagination.nextCursor; if (seen.has(cursor)) invalid(); seen.add(cursor);
  }
  fail(503, 'INCOMPLETE_PROVIDER_DATA', 'This message is beyond the verified history window. Open it in the provider dashboard.');
}
function deletionVersion(row, messages) {
  if (messages.some(message => !Number.isFinite(Date.parse(message.createdAt)))) return null;
  const latest = [...messages].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id));
  return createHash('sha256').update(JSON.stringify([inboxConversationVersion(row), latest.map(message => inboxMessageVersion(message, row.accountId))])).digest('hex');
}
function deletionTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_conversation_deletions(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,profile_id TEXT NOT NULL,account_id TEXT NOT NULL,conversation_id TEXT NOT NULL,status TEXT NOT NULL,operation_id TEXT NOT NULL DEFAULT '',PRIMARY KEY(project_id,profile_id,account_id,conversation_id))`);
  if (!db.prepare('PRAGMA table_info(inbox_conversation_deletions)').all().some(column => column.name === 'operation_id')) db.exec("ALTER TABLE inbox_conversation_deletions ADD COLUMN operation_id TEXT NOT NULL DEFAULT ''");
}
async function deleteConversation(context, api, account, conversationId, row, key) {
  const { body, db, project } = context;
  fields(body, ['accountId', 'expectedDeleteVersion', 'confirmConversationId']);
  const latest = await history(api, account, conversationId, {}, row.id);
  if (latest.sortOrderApplied !== 'desc' || !deletionVersion(row, latest.messages) || body.expectedDeleteVersion !== deletionVersion(row, latest.messages) || body.confirmConversationId !== conversationId) fail(409, 'CONVERSATION_DELETE_REVIEW_REQUIRED', 'Refresh the latest messages and confirm this stored conversation before deleting it.');
  deletionTable(db);
  const binding = [project.id, project.zernioProfileId, account._id, row.id];
  const previous = db.prepare('SELECT status,operation_id FROM inbox_conversation_deletions WHERE project_id=? AND profile_id=? AND account_id=? AND conversation_id=?').get(...binding);
  if (previous && (!['pending', 'uncertain'].includes(previous.status) || db.prepare('SELECT status FROM integration_operations WHERE id=? AND project_id=?').get(previous.operation_id, project.id)?.status !== 'reviewed-not-applied')) fail(409, 'CONVERSATION_DELETE_RECORDED', 'A deletion of this stored conversation is already complete or needs reconciliation. A new action key cannot repeat it until an operator verifies the original action was not applied.');
  if (previous) db.prepare('DELETE FROM inbox_conversation_deletions WHERE project_id=? AND profile_id=? AND account_id=? AND conversation_id=?').run(...binding);
  const original = db.prepare('SELECT id FROM integration_operations WHERE project_id=? AND request_key=?').get(project.id, context.req.headers['idempotency-key']);
  db.prepare("INSERT INTO inbox_conversation_deletions(project_id,profile_id,account_id,conversation_id,status,operation_id) VALUES(?,?,?,?,'pending',?)").run(...binding, original.id);
  try {
    const result = await api(`/inbox/conversations/${encodeURIComponent(conversationId)}`, { accountId: account._id }, undefined, key, 'DELETE'), receipt = result.data;
    if (result.success !== true || !plain(receipt) || ![conversationId, row.id].includes(receipt.id) || receipt.accountId !== account._id || receipt.platform !== account.platform || !Number.isSafeInteger(receipt.deletedMessages) || receipt.deletedMessages < 0) invalid(true);
    db.prepare("UPDATE inbox_conversation_deletions SET status='deleted' WHERE project_id=? AND profile_id=? AND account_id=? AND conversation_id=?").run(...binding);
    return { accepted: true, deleted: true, scope: 'zernio_copy', conversationId, deletedMessages: receipt.deletedMessages };
  } catch (error) {
    if (!(error instanceof IntegrationError) || error.uncertain) db.prepare("UPDATE inbox_conversation_deletions SET status='uncertain' WHERE project_id=? AND profile_id=? AND account_id=? AND conversation_id=?").run(...binding);
    else db.prepare('DELETE FROM inbox_conversation_deletions WHERE project_id=? AND profile_id=? AND account_id=? AND conversation_id=?').run(...binding);
    throw error;
  }
}
async function attachment(context, api, accounts, account, conversationId, messageId, index, download, apiKey) {
  const row = await conversation(api, accounts, account, conversationId), message = await findMessage(api, account, conversationId, row.id, messageId), item = message?.attachments?.[index];
  if (!item || message.isDeleted || message.deliveryStatus === 'deleted') fail(404, 'ATTACHMENT_NOT_FOUND', 'This attachment was not found in the selected account and conversation.');
  if (account.platform !== 'whatsapp') {
    if (download) fail(400, 'ATTACHMENT_DOWNLOAD_UNSUPPORTED', 'Resolve this platform’s public media link before opening it.');
    let result;
    try { result = await api(`/inbox/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}/attachments/${index}`, { accountId: account._id, format: 'json' }); }
    catch (error) { if (error.providerStatus === 404) fail(410, 'ATTACHMENT_UNAVAILABLE', 'This attachment is unavailable or expired at the provider. Refresh the thread; the media may no longer be recoverable.'); throw error; }
    let url;
    try { url = publicMediaUrl(result.url); } catch { invalid(); }
    if (result.status !== 'success' || typeof result.refreshed !== 'boolean') invalid();
    return { attachment: { type: item.type, url, refreshed: result.refreshed, ...(typeof item.filename === 'string' ? { filename: item.filename.slice(0, 255) } : {}) } };
  }
  let target;
  try {
    target = new URL(item.url);
    const parts = target.pathname.match(/^\/api\/v1\/whatsapp\/media\/([^/]+)$/);
    if (target.origin !== 'https://zernio.com' || target.username || target.password || target.hash || !parts || !valid(decodeURIComponent(parts[1])) || [...target.searchParams.keys()].some(name => name !== 'accountId') || target.searchParams.getAll('accountId').length > 1 || target.searchParams.has('accountId') && target.searchParams.get('accountId') !== account._id || item.payload?.id != null && String(item.payload.id) !== decodeURIComponent(parts[1])) throw new Error();
    target.search = new URLSearchParams({ accountId: account._id }).toString();
  } catch { fail(502, 'INVALID_ATTACHMENT', 'The provider attachment is outside its verified WhatsApp account.'); }
  const downloadUrl = `${context.url.pathname}?${new URLSearchParams({ accountId: account._id, download: '1' })}`;
  if (!download) return { attachment: { type: item.type, downloadUrl, refreshed: false } };
  let response, reader;
  const abort = new AbortController(), closed = () => abort.abort(); context.res.once('close', closed);
  try {
    response = await fetch(target, { headers: { Authorization: `Bearer ${apiKey}` }, redirect: 'error', signal: AbortSignal.any([AbortSignal.timeout(20000), abort.signal]) });
    context.assertProjectMapping?.(context.project.zernioProfileId);
    if (!response.ok) fail(response.status === 400 || response.status === 404 ? 410 : 502, 'ATTACHMENT_UNAVAILABLE', response.status === 400 || response.status === 404 ? 'WhatsApp no longer serves this attachment. It cannot be recovered by retrying.' : 'WhatsApp could not provide this attachment. Try again later.');
    const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase(), details = downloadTypes.get(mime), expected = item.type === 'sticker' ? 'image' : item.type, length = response.headers.get('content-length');
    if (!details || details[0] !== expected || item.mimeType && item.mimeType.split(';')[0].toLowerCase() !== mime || length !== null && (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) < 1 || Number(length) > details[2] * 1024 * 1024)) fail(502, 'ATTACHMENT_UNAVAILABLE', 'WhatsApp returned an unsupported file type or an attachment beyond its download limit.');
    const maximum = details[2] * 1024 * 1024;
    reader = response.body?.[Symbol.asyncIterator](); let part = await reader?.next();
    if (!part || part.done || !part.value.length || part.value.length > maximum) fail(502, 'ATTACHMENT_UNAVAILABLE', 'WhatsApp did not return an attachment within its download limit.');
    context.assertProjectMapping?.(context.project.zernioProfileId);
    context.res.writeHead(200, { 'Content-Type': mime, 'Content-Disposition': `attachment; filename="inbox-attachment.${details[1]}"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    let size = 0;
    while (!part.done) {
      const chunk = part.value;
      size += chunk.length;
      if (size > maximum) fail(502, 'ATTACHMENT_UNAVAILABLE', 'This attachment exceeds its download limit.');
      context.assertProjectMapping?.(context.project.zernioProfileId);
      if (context.res.destroyed) throw new Error();
      if (!context.res.write(chunk)) await new Promise((resolve, reject) => {
        const cleanup = () => { context.res.off('drain', drain); context.res.off('close', close); }, drain = () => { cleanup(); resolve(); }, close = () => { cleanup(); reject(new Error('Download closed')); };
        context.res.once('drain', drain); context.res.once('close', close);
      });
      part = await reader.next();
    }
    if (length !== null && size !== Number(length)) throw new Error();
    context.res.end();
    return null;
  } catch (error) {
    abort.abort(); await reader?.return?.().catch(() => {});
    await response?.body?.cancel().catch(() => {});
    if (context.res.headersSent) { context.res.destroy(); return null; }
    if (error instanceof IntegrationError || error?.status) throw error;
    fail(502, 'ATTACHMENT_UNAVAILABLE', 'This WhatsApp attachment could not be downloaded. Try again later.');
  } finally { context.res.off('close', closed); }
}
function emoji(value, platform) {
  if (typeof value !== 'string' || !value || value.length > 64 || (platform === 'slack' ? !/^:[a-z0-9_+\-]{1,60}:$/i.test(value) : [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)].length !== 1 || !/[\p{Extended_Pictographic}\p{Regional_Indicator}\u20e3]/u.test(value))) fail(400, 'INVALID_REACTION', platform === 'slack' ? 'Use a Slack emoji name such as :thumbsup:.' : 'Choose one standard emoji reaction.');
  return value;
}
async function changeMessage(context, api, account, conversationId, resolvedId, messageId, verb, key) {
  const { body } = context;
  supported(account, verb === 'edit' ? 'messageEdit' : verb === 'delete' ? 'messageDelete' : 'messageReact');
  fields(body, ['accountId', 'expectedMessageVersion', ...(verb === 'edit' ? ['text'] : verb === 'delete' ? ['confirmMessageId'] : verb === 'react' ? ['emoji'] : [])]);
  const target = await findMessage(api, account, conversationId, resolvedId, messageId);
  if (!target) fail(403, 'MESSAGE_OUTSIDE_CONVERSATION', 'This message was not found in the selected account and conversation.');
  if (body.expectedMessageVersion !== inboxMessageVersion(target, account._id)) fail(409, 'MESSAGE_CHANGED', 'This message changed. Refresh the thread before changing it.');
  const age = ['facebook', 'instagram'].includes(account.platform) ? incomingAge(await recentHistory(api, account, conversationId, resolvedId)) : Infinity, eligibility = messageActions(account, target, age);
  if (!eligibility[{ edit: 'canEdit', delete: 'canDelete', react: 'canReact', unreact: 'canUnreact' }[verb]]) fail(409, 'MESSAGE_ACTION_UNAVAILABLE', 'This message cannot be changed now. Check ownership, the edit/unsend or reply window, and whether your account has a reaction to remove.');
  const endpoint = `/inbox/conversations/${encodeURIComponent(conversationId)}/messages/${encodeURIComponent(messageId)}`;
  let payload, result;
  if (verb === 'edit') { payload = { accountId: account._id, text: str(body.text, 'message text', inboxCapabilities(account.platform).messageLimit) }; if (payload.text === target.message) fail(400, 'MESSAGE_UNCHANGED', 'Change the message text before saving.'); result = await api(endpoint, {}, payload, key, 'PATCH'); }
  else if (verb === 'delete') { if (body.confirmMessageId !== messageId) fail(400, 'MESSAGE_CONFIRMATION_REQUIRED', 'Confirm the selected message before deleting it.'); result = await api(endpoint, { accountId: account._id }, undefined, key, 'DELETE'); }
  else { payload = { accountId: account._id, ...(verb === 'react' ? { emoji: emoji(body.emoji, account.platform) } : {}) }; result = await api(endpoint + '/reactions', verb === 'unreact' ? payload : {}, verb === 'react' ? payload : undefined, key, verb === 'react' ? 'POST' : 'DELETE'); }
  if (result.success !== true || verb === 'edit' && !(valid(result.data?.messageId) || Number.isSafeInteger(result.data?.messageId)) || ['react', 'unreact'].includes(verb) && (!valid(result.messageId) || result.platformMessageId !== messageId)) invalid(true);
  let fresh;
  try { fresh = await findMessage(api, account, conversationId, resolvedId, messageId); }
  catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
  if (verb === 'edit' && (!fresh || fresh.isDeleted || fresh.message !== payload.text) || verb === 'delete' && fresh && fresh.isDeleted !== true && fresh.deliveryStatus !== 'deleted') fail(502, 'MESSAGE_CHANGE_NOT_CONFIRMED', 'The latest history has not confirmed this message change. Review the thread before another attempt.', true);
  return { messageId, action: verb, accepted: true, observed: verb === 'edit' || verb === 'delete' || Boolean(fresh) && (verb === 'react' ? (fresh.reactions || []).some(reaction => reaction.fromMe === true && reaction.emoji === payload.emoji) : !(fresh.reactions || []).some(reaction => reaction.fromMe === true)), ...(fresh ? { message: { ...fresh, version: inboxMessageVersion(fresh, account._id), actions: messageActions(account, fresh, age) } } : {}), ...(verb === 'delete' ? { deleteScope: eligibility.deleteScope } : {}) };
}
const controlActions = account => account.isActive === false ? [] : account.platform === 'whatsapp' ? ['take', 'release'] : account.platform === 'facebook' ? ['take', 'request', 'pass', 'release'] : account.platform === 'instagram' ? account.metadata?.loginMethod === 'facebook_login' ? ['take', 'request', 'pass', 'release'] : ['pass', 'release'] : [];
export const inboxConversationVersion = row => createHash('sha256').update(JSON.stringify([row.id, row.accountId, row.platform, row.participantId ?? null, row.lastMessage ?? null, row.lastMessageAt ?? row.updatedTime ?? null, row.threadControl ?? null])).digest('hex');
const conversationView = (account, row) => ({ ...row, version: inboxConversationVersion(row), controlActions: controlActions(account) });
async function changeControl(context, api, accounts, account, conversationId, row, key) {
  const { body } = context;
  supported(account, 'threadControl'); fields(body, ['accountId', 'action', 'targetAppId', 'metadata', 'expectedConversationVersion', 'confirmControl']);
  if (body.confirmControl !== true || body.expectedConversationVersion !== inboxConversationVersion(row)) fail(409, 'CONTROL_CONFIRMATION_REQUIRED', 'Refresh the conversation and review who will answer before changing control.');
  if (!controlActions(account).includes(body.action)) fail(422, 'CONTROL_ACTION_UNSUPPORTED', 'This account does not support that control action. Instagram take/request requires Facebook Login; WhatsApp supports take/release only.');
  if (account.platform === 'whatsapp' && body.action === 'release' && row.threadControl !== 'app') fail(409, 'CONTROL_NOT_HELD', 'The app must hold this conversation before releasing it to the business agent.');
  if (body.action === 'pass' ? typeof body.targetAppId !== 'string' || !/^\d{1,32}$/.test(body.targetAppId) : body.targetAppId !== undefined) fail(400, 'INVALID_CONTROL_TARGET', 'Choose the receiving Meta app only when transferring control.');
  if (body.metadata !== undefined && (typeof body.metadata !== 'string' || body.metadata.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.metadata))) fail(400, 'INVALID_CONTROL_NOTE', 'Use a handover note of at most 2000 characters.');
  const payload = { accountId: account._id, action: body.action, ...(body.targetAppId ? { targetAppId: body.targetAppId } : {}), ...(body.metadata ? { metadata: body.metadata } : {}) }, response = await api(`/inbox/conversations/${encodeURIComponent(conversationId)}/thread-control`, {}, payload, key), control = response.control;
  if (response.success !== true || !plain(control) || !['app', 'ai_agent', 'other'].includes(control.owner) || control.ownerAppId != null && (typeof control.ownerAppId !== 'string' || !/^\d{1,32}$/.test(control.ownerAppId)) || body.action === 'take' && control.owner !== 'app' || body.action === 'pass' && (control.owner !== 'other' || control.ownerAppId !== body.targetAppId) || account.platform === 'whatsapp' && body.action === 'release' && control.owner !== 'ai_agent') invalid(true);
  let fresh;
  try { fresh = await conversation(api, accounts, account, conversationId); }
  catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
  if (body.action !== 'request' && fresh.threadControl !== control.owner) fail(502, 'CONTROL_CHANGE_NOT_CONFIRMED', 'The latest conversation has not confirmed its new owner. Refresh and review before another transfer.', true);
  return { action: body.action, accepted: true, requested: body.action === 'request', control: pick(control, ['owner', 'ownerAppId']), conversation: conversationView(account, fresh) };
}
async function acceptRequest(context, api, accounts, account, conversationId, row, key) {
  const { body } = context;
  supported(account, 'acceptRequest'); fields(body, ['accountId', 'message', 'expectedConversationVersion', 'confirmSend']);
  if (body.confirmSend !== true || body.expectedConversationVersion !== inboxConversationVersion(row)) fail(409, 'REQUEST_CONFIRMATION_REQUIRED', 'Refresh this request and review the reply before sending it.');
  let cursor, found = false; const seen = new Set();
  for (let page = 0; page < 20; page++) {
    const requests = await aggregate(api, accounts, account, 'conversations', { folder: 'requests', status: 'active', limit: 100, ...(cursor ? { cursor } : {}) });
    if (requests.rows.some(item => item.id === conversationId && item.folder === 'requests')) { found = true; break; }
    if (!requests.pagination.hasMore) break;
    cursor = requests.pagination.nextCursor; if (!cursor || seen.has(cursor)) fail(503, 'INCOMPLETE_PROVIDER_DATA', 'This request could not be verified in the provider request folder. Refresh or use the provider dashboard.'); seen.add(cursor);
  }
  if (!found) fail(409, 'REQUEST_NO_LONGER_PENDING', 'This conversation is no longer a pending message request. Refresh before replying.');
  const age = incomingAge(await recentHistory(api, account, conversationId, row.id));
  if (!(age >= 0 && age <= 86400000)) fail(409, 'MESSAGING_WINDOW_CLOSED', 'A request acceptance reply must be within the standard 24-hour messaging window.');
  const payload = { accountId: account._id, message: str(body.message, 'request acceptance reply', inboxCapabilities(account.platform).messageLimit) }, response = await api(`/inbox/conversations/${encodeURIComponent(conversationId)}/accept`, {}, payload, key);
  if (response.success !== true || !valid(response.data?.messageId) || response.data?.accountId !== undefined && response.data.accountId !== account._id || response.data?.platform !== undefined && response.data.platform !== account.platform) invalid(true);
  let sent;
  try { sent = await findMessage(api, account, conversationId, row.id, response.data.messageId); }
  catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
  if (!sent || sent.direction !== 'outgoing' || sent.message !== payload.message) fail(502, 'REQUEST_REPLY_NOT_CONFIRMED', 'The latest history has not confirmed this acceptance reply. Review the conversation before another send.', true);
  return { accepted: true, sent: true, messageId: response.data.messageId };
}
async function aggregate(api, accounts, account, kind, params) {
  const result = await api(`/inbox/${kind}`, { profileId: account.profileId?._id || account.profileId, accountId: account._id, ...params });
  if (!Array.isArray(result.data) || result.data.length > (kind === 'reviews' ? 50 : 100)) invalid();
  result.data.forEach(row => {
    scoped(row, accounts, account._id);
    if (kind === 'conversations') validateConversation(row);
    else if (kind === 'reviews') validateReview(row);
    else if (kind === 'mentions') {
      renderFields(row, mentionFields);
      if (!valid(row.organizationalEntity) || ['publishedAt', 'createdAt'].some(key => row[key] != null && !Number.isFinite(Date.parse(row[key])))) invalid();
    }
    else renderFields(row, postFields.filter(key => !['commentCount', 'likeCount', 'isAd'].includes(key)), ['commentCount', 'likeCount'], ['isAd']);
  });
  const page = pagination(kind === 'mentions' ? { hasMore: result.pagination?.hasMore, cursor: result.pagination?.cursor } : result.pagination, false, kind === 'conversations' && params.folder === 'requests');
  if (kind === 'mentions') {
    if (result.data.length > params.limit || new Set(result.data.map(row => row.id)).size !== result.data.length || page.hasMore && (!result.data.length || page.nextCursor === params.cursor)) invalid();
    if (result.meta != null) {
      renderFields(result.meta, ['sortOrder'], ['total']);
      if (result.meta.total != null && !Number.isSafeInteger(result.meta.total) || result.meta.sortOrder != null && result.meta.sortOrder !== (params.sortOrder || 'desc')) invalid();
    }
  }
  return { rows: result.data, pagination: page, meta: kind === 'mentions' ? pick(result.meta, ['total', 'sortOrder']) : metadata(result.meta, accounts), ...(result.summary ? { summary: pick(result.summary, ['totalReviews', 'averageRating']) } : {}) };
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
  const result = { ...pick(row, commentFields), platform };
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
const privateCommentVersion = row => createHash('sha256').update(JSON.stringify([row.id, row.platform, row.createdTime, row.from?.id, row.from?.isOwner, row.message])).digest('hex');
const editableCommentVersion = (account, postId, row) => createHash('sha256').update(JSON.stringify([account._id, account.platform, account.platformUserId ?? null, postId, row.id, row.message ?? null, row.from?.id ?? null, row.from?.isOwner ?? null])).digest('hex');
function privateCommentEligible(row) {
  const age = Date.now() - Date.parse(row.createdTime);
  return ['facebook', 'instagram'].includes(row.platform) && valid(row.from?.id) && row.from?.isOwner === false && row.canReply !== false && age >= 0 && age < 7 * 86400000;
}
function privateReplyTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_private_replies(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,profile_id TEXT NOT NULL,account_id TEXT NOT NULL,post_id TEXT NOT NULL,comment_id TEXT NOT NULL,status TEXT NOT NULL,operation_id TEXT NOT NULL,PRIMARY KEY(project_id,profile_id,account_id,post_id,comment_id))`);
}
function claimCommentReaction(context, account, postId, commentId, action, reactionType = '') {
  const { db, project, req } = context, nativeId = account.platformUserId ?? '';
  if (account.platformUserId != null && !valid(nativeId)) invalid();
  db.exec(`CREATE TABLE IF NOT EXISTS inbox_comment_reactions(operation_id TEXT PRIMARY KEY,platform TEXT NOT NULL,account_id TEXT NOT NULL,native_account_id TEXT NOT NULL,post_id TEXT NOT NULL,comment_id TEXT NOT NULL,action TEXT NOT NULL,reaction_type TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS inbox_comment_reactions_target ON inbox_comment_reactions(platform,post_id,comment_id);`);
  const operationId = db.prepare('SELECT id FROM integration_operations WHERE project_id=? AND request_key=?').get(project.id, req.headers['idempotency-key']).id;
  // ponytail: missing native IDs conservatively fence the same platform target across aliases; record native IDs to separate accounts.
  const previous = db.prepare(`SELECT r.operation_id FROM inbox_comment_reactions r LEFT JOIN integration_operations o ON o.id=r.operation_id
    WHERE r.platform=? AND r.post_id=? AND r.comment_id=? AND (r.account_id=? OR r.native_account_id='' OR ?='' OR r.native_account_id=?)
    AND (o.status IS NULL OR o.status NOT IN ('complete','failed','reviewed-not-applied','reviewed-applied') OR o.status='reviewed-applied' AND r.action=? AND r.reaction_type=?) LIMIT 1`).get(account.platform, postId, commentId, account._id, nativeId, nativeId, action, reactionType);
  if (previous) fail(409, 'COMMENT_REACTION_UNCERTAIN', 'An earlier change on this native comment needs reconciliation before another edit, reaction or removal.');
  // Earlier releases recorded project-scoped resources only. Preserve exact legacy uncertainty across project/account handoffs too.
  const legacy = db.prepare(`SELECT o.resource_key,o.action_path,o.status FROM integration_operations o WHERE o.id<>? AND o.status IN ('pending','uncertain','reviewed-applied')
    AND NOT EXISTS(SELECT 1 FROM inbox_comment_reactions r WHERE r.operation_id=o.id)
    AND (o.action_path IN ('POST /integrations/inbox/comments/like','POST /integrations/inbox/comments/unlike','POST /integrations/inbox/comments/edit') OR o.action_path='' OR o.resource_key LIKE '%"inbox-comment"%')`).all(operationId);
  for (const row of legacy) {
    if (row.status === 'reviewed-applied' && row.action_path && row.action_path !== 'POST /integrations/inbox/comments/' + action) continue;
    let resource; try { resource = JSON.parse(row.resource_key || 'null')?.[1]; } catch { /* An unreadable legacy identity cannot establish a different target. */ }
    if (Array.isArray(resource) && resource[0] === 'inbox-comment' && (resource[2] !== postId || resource[3] !== commentId)) continue;
    if (Array.isArray(resource) && resource[0] !== 'inbox-comment' && row.action_path === '') continue;
    fail(409, 'COMMENT_REACTION_UNCERTAIN', 'An earlier comment change needs reconciliation before this native target can be changed.');
  }
  // No await between the shared durable lookup and claim, or between this claim and provider dispatch.
  db.prepare('INSERT INTO inbox_comment_reactions VALUES(?,?,?,?,?,?,?,?)').run(operationId, account.platform, account._id, nativeId, postId, commentId, action, reactionType);
}
function privateReplyThread(context, accounts, account, post, result) {
  const accountId = post.isAd ? result.meta.platform === 'instagram' ? result.meta.instagramAccountId : result.meta.facebookAccountId : account._id, postId = post.isAd ? result.meta.effectiveStoryId : post.id;
  const connected = accounts.some(row => row._id === accountId && row.isActive !== false && row.platform === result.meta.platform), exists = context.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='inbox_private_replies'").get();
  const receipts = exists && context.db.prepare('SELECT r.status,o.status AS operationStatus FROM inbox_private_replies r LEFT JOIN integration_operations o ON r.operation_id=o.id AND r.project_id=o.project_id WHERE r.project_id=? AND r.profile_id=? AND r.account_id=? AND r.post_id=? AND r.comment_id=?');
  const decorate = row => {
    const receipt = receipts && receipts.get(context.project.id, context.project.zernioProfileId, accountId || '', postId || '', row.id), prior = receipt && !(receipt.operationStatus === 'reviewed-not-applied' && ['pending', 'uncertain'].includes(receipt.status)) ? receipt : null;
    return { ...row, ...(row.platform === 'reddit' ? { editVersion: editableCommentVersion(account, post.id, row) } : {}), ...(['facebook', 'instagram'].includes(row.platform) ? { privateReplyVersion: privateCommentVersion(row), privateReplyEligible: connected && valid(postId) && !prior && privateCommentEligible(row), ...(prior ? { privateReplyStatus: prior.status } : {}) } : {}), ...(row.replies ? { replies: row.replies.map(decorate) } : {}) };
  };
  return { ...result, comments: result.comments.map(decorate), ...(result.parent ? { parent: decorate(result.parent) } : {}) };
}
function privateReplyElements(body, platform) {
  if (body.buttons !== undefined && body.quickReplies !== undefined) fail(400, 'INVALID_PRIVATE_REPLY', 'Choose buttons or quick replies, rather than both.');
  const payload = {};
  const publicLink = value => { try { return publicMediaUrl(value); } catch { fail(400, 'INVALID_PRIVATE_REPLY', 'Use a public HTTPS link for private-reply buttons and thumbnails.'); } };
  for (const name of ['buttons', 'quickReplies']) if (body[name] !== undefined) {
    if (!Array.isArray(body[name]) || body[name].length < 1 || body[name].length > (name === 'buttons' ? 3 : 13)) fail(400, 'INVALID_PRIVATE_REPLY', 'Use one to three buttons or one to thirteen quick replies.');
    payload[name] = body[name].map(row => {
      const button = name === 'buttons', type = button ? row?.type : 'quick';
      if (button && !['url', 'postback', 'phone'].includes(type) || type === 'phone' && platform !== 'facebook') fail(422, 'INVALID_PRIVATE_REPLY', 'Choose a supported button type. Phone buttons are available only on Facebook.');
      fields(row, button ? ['type', 'title', type === 'url' ? 'url' : type === 'phone' ? 'phone' : 'payload'] : ['title', 'payload', 'imageUrl']);
      const item = { ...(button ? { type } : {}), title: str(row.title, 'button or quick-reply label', 20) };
      if (type === 'url') item.url = publicLink(row.url);
      else if (type === 'phone') { if (typeof row.phone !== 'string' || !/^\+[1-9]\d{6,14}$/.test(row.phone)) fail(400, 'INVALID_PRIVATE_REPLY', 'Enter a phone button number in international format.'); item.phone = row.phone; }
      else item.payload = str(row.payload, 'button or quick-reply value', 1000);
      if (!button && row.imageUrl !== undefined) item.imageUrl = publicLink(row.imageUrl);
      return item;
    });
  }
  return payload;
}
async function privateCommentReply(context, api, account, post, target, moderationAccount, moderationPostId, key) {
  const { body, db, project } = context;
  supported(moderationAccount, 'commentPrivateReply');
  if (!privateCommentEligible(target.row)) fail(422, 'PRIVATE_REPLY_INELIGIBLE', 'Choose another person’s comment with a verified time within the last seven days.');
  if (body.confirmSend !== true || body.expectedCommentVersion !== privateCommentVersion(target.row)) fail(409, 'PRIVATE_REPLY_REVIEW_REQUIRED', 'Refresh this comment and review its author, account and message before sending privately.');
  const payload = { accountId: moderationAccount._id, message: str(body.message, 'private comment reply', MESSAGE_LIMITS[moderationAccount.platform]), ...privateReplyElements(body, moderationAccount.platform) };
  const fresh = await scopedAccounts(api, project.zernioProfileId);
  for (const original of [account, moderationAccount]) { const current = requireAccount(fresh, original._id); supported(current, 'commentPrivateReply'); if (current.platform !== original.platform) fail(409, 'PRIVATE_REPLY_ACCOUNT_CHANGED', 'This comment’s connected account changed. Refresh before replying.'); }
  if (!privateCommentEligible(target.row)) fail(422, 'PRIVATE_REPLY_INELIGIBLE', 'This comment is outside the seven-day private reply window.');
  privateReplyTable(db);
  const binding = [project.id, project.zernioProfileId, moderationAccount._id, moderationPostId, target.row.id], previous = db.prepare('SELECT status,operation_id FROM inbox_private_replies WHERE project_id=? AND profile_id=? AND account_id=? AND post_id=? AND comment_id=?').get(...binding);
  if (previous && (!['pending', 'uncertain'].includes(previous.status) || db.prepare('SELECT status FROM integration_operations WHERE id=? AND project_id=?').get(previous.operation_id, project.id)?.status !== 'reviewed-not-applied')) fail(409, 'PRIVATE_REPLY_RECORDED', 'This comment’s private reply was already sent, consumed or needs reconciliation. Check the original receipt and conversation before another action.');
  if (previous) db.prepare('DELETE FROM inbox_private_replies WHERE project_id=? AND profile_id=? AND account_id=? AND post_id=? AND comment_id=?').run(...binding);
  const original = db.prepare('SELECT id FROM integration_operations WHERE project_id=? AND request_key=?').get(project.id, context.req.headers['idempotency-key']);
  if (!db.prepare("INSERT OR IGNORE INTO inbox_private_replies(project_id,profile_id,account_id,post_id,comment_id,status,operation_id) VALUES(?,?,?,?,?,'pending',?)").run(...binding, original.id).changes) fail(409, 'PRIVATE_REPLY_RECORDED', 'Another private reply to this comment is already in progress.');
  const update = status => db.prepare('UPDATE inbox_private_replies SET status=? WHERE project_id=? AND profile_id=? AND account_id=? AND post_id=? AND comment_id=?').run(status, ...binding);
  try {
    const result = await api(`/inbox/comments/${encodeURIComponent(moderationPostId)}/${encodeURIComponent(target.row.id)}/private-reply`, {}, payload, key);
    if (result.status !== 'success' || !valid(result.messageId) || result.commentId !== target.row.id || result.platform !== moderationAccount.platform) invalid(true);
    update('sent'); return { sent: true, accountId: account._id, moderationAccountId: moderationAccount._id, postId: post.id, commentId: target.row.id, messageId: result.messageId, platform: result.platform };
  } catch (error) {
    if (error.privateReplyConsumed === true) { update('consumed'); fail(409, 'PRIVATE_REPLY_CONSUMED', 'The provider reports this comment’s single private reply is consumed. Do not retry it; check the conversation.'); }
    if (!(error instanceof IntegrationError) || error.uncertain || error.privateReplyOutcome === 'unknown') { update('uncertain'); if (error instanceof IntegrationError) error.uncertain = true; }
    else db.prepare('DELETE FROM inbox_private_replies WHERE project_id=? AND profile_id=? AND account_id=? AND post_id=? AND comment_id=?').run(...binding);
    throw error;
  }
}
export const inboxReplyVersion = row => createHash('sha256').update(JSON.stringify([row.id, row.accountId, row.hasReply, row.reply?.id || null, row.reply?.text || null, row.reply?.created || null])).digest('hex');
const review = row => ({ ...pick(row, reviewFields), replyVersion: inboxReplyVersion(row) });

export async function handleInbox(context) {
  const { req, url, project, role, send, body = {} } = context, prefix = `/api/projects/${encodeURIComponent(project.id)}/integrations/inbox`;
  if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return false;
  const path = url.pathname.slice(prefix.length).replace(/^\//, '');
  const route = !['conversations/search', 'conversations/start', 'conversations/recipients'].includes(path) && path.match(/^conversations\/([^/]+)(?:\/(messages|reply|read|status|thread-control|accept|typing|delete))?$/), messageAction = path.match(/^conversations\/([^/]+)\/messages\/([^/]+)\/(edit|delete|react|unreact)$/), media = path.match(/^conversations\/([^/]+)\/messages\/([^/]+)\/attachments\/(0|[1-9]\d?)$/), action = path.match(/^(comments|reviews)\/(reply|private-reply|edit|hide|unhide|delete|like|unlike|moderate|delete-reply)$/);
  if (!['status', 'accounts', 'updates', 'conversations', 'conversations/search', 'conversations/start', 'conversations/recipients', 'comments', 'comments/thread', 'reviews', 'mentions'].includes(path) && !route && !messageAction && !media && !action || action && (action[1] === 'reviews' && !['reply', 'delete-reply'].includes(action[2]) || action[1] === 'comments' && action[2] === 'delete-reply')) { send(404, { error: { code: 'INBOX_ROUTE_NOT_FOUND', message: 'This inbox action was not found.' } }); return true; }
  try {
    if (!['GET', 'POST'].includes(req.method)) fail(405, 'METHOD_NOT_ALLOWED', 'Use the available inbox controls.');
    const mutation = Boolean(path === 'conversations/start' || route && ['reply', 'read', 'status', 'thread-control', 'accept', 'typing', 'delete'].includes(route[2]) || messageAction || action);
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
    if (['status', 'accounts'].includes(path)) { send(200, { configured: true, mapped: true, webhookConfigured: Boolean(env.ZERNIO_WEBHOOK_SECRET), accounts: accounts.filter(account => { const c = inboxCapabilities(account.platform); return c.messages || c.comments || c.reviews; }).map(account => ({ id: account._id, platform: account.platform, name: account.displayName || account.username || account.name || account.platform, capabilities: inboxCapabilities(account.platform, account.isActive !== false) })) }); return true; }
    const accountId = id(req.method === 'GET' ? url.searchParams.get('accountId') : body.accountId), account = requireAccount(accounts, accountId);
    if (media) {
      supported(account, 'messages');
      if (url.searchParams.has('download') && url.searchParams.get('download') !== '1') fail(400, 'INVALID_ATTACHMENT', 'Choose the supported attachment download.');
      const result = await attachment(context, api, accounts, account, decodedId(media[1]), decodedId(media[2]), Number(media[3]), url.searchParams.get('download') === '1', env.ZERNIO_API_KEY);
      if (result) send(200, result);
      return true;
    }
    const run = async key => {
      if (path === 'conversations/search') { supported(account, 'messages'); return searchConversations(api, accounts, account, url); }
      if (path === 'conversations/start') return startConversation(context, api, account, env, assertMapping, key);
      if (path === 'conversations/recipients') {
        supported(account, 'start');
        if (account.platform === 'slack') return { recipients: await slackMembers(api, account, url.searchParams.get('query') || '') };
        if (['sms', 'whatsapp'].includes(account.platform)) return { recipients: (context.contacts?.list(project.id) || []).filter(contact => contact.consents?.[account.platform] === true && !contact.suppression?.[account.platform] && /^\+[1-9]\d{6,14}$/.test(contact.phone || '')).map(contact => ({ id: contact.id, name: contact.name || contact.phone, phone: contact.phone })) };
        return { recipients: [] };
      }
      if (path === 'conversations') {
        supported(account, 'messages'); const result = await aggregate(api, accounts, account, 'conversations', query(url, 'conversations'));
        return { conversations: result.rows.map(row => ({ ...pick(row, conversationFields), ...(conversationContact(context, row) ? { contact: conversationContact(context, row) } : {}) })), pagination: result.pagination, meta: result.meta };
      }
      if (messageAction) {
        supported(account, 'messages'); const conversationId = decodedId(messageAction[1]), row = await conversation(api, accounts, account, conversationId);
        return changeMessage(context, api, account, conversationId, row.id, decodedId(messageAction[2]), messageAction[3], key);
      }
      if (route) {
        supported(account, 'messages'); const conversationId = decodedId(route[1]), row = await conversation(api, accounts, account, conversationId);
        if (!route[2]) return { conversation: conversationView(account, row), contact: conversationContact(context, row) };
        if (route[2] === 'messages') {
          const result = await history(api, account, conversationId, query(url, 'messages'), row.id), incoming = result.messages.some(message => message.direction === 'incoming' && message.senderId === row.participantId);
          let windowAge = Infinity;
          if (['facebook', 'instagram'].includes(account.platform)) try { windowAge = incomingAge(await recentHistory(api, account, conversationId, row.id)); } catch (error) { assertMapping(); if (!(error instanceof IntegrationError) || error.code === 'INVALID_PROVIDER_SCOPE') throw error; /* History remains readable when reaction eligibility cannot be verified. */ }
          const latest = !url.searchParams.get('cursor') && result.sortOrderApplied === 'desc' ? result : await history(api, account, conversationId, {}, row.id);
          return { ...result, messages: result.messages.map(message => ({ ...message, version: inboxMessageVersion(message, accountId), actions: messageActions(account, message, windowAge) })), conversation: { ...conversationView(account, row), deleteVersion: latest.sortOrderApplied === 'desc' ? deletionVersion(row, latest.messages) : null }, contact: conversationContact(context, row, incoming) };
        }
        if (route[2] === 'delete') return deleteConversation(context, api, account, conversationId, row, key);
        if (route[2] === 'typing') {
          supported(account, 'typing'); fields(body, ['accountId', 'confirmTyping']);
          if (body.confirmTyping !== true) fail(400, 'TYPING_CONFIRMATION_REQUIRED', 'Choose Send typing indicator explicitly; WhatsApp may also mark the latest inbound message read.');
          const result = await api(`/inbox/conversations/${encodeURIComponent(conversationId)}/typing`, {}, { accountId }, key);
          if (typeof result.success !== 'boolean') invalid(true);
          return { accepted: true, delivered: result.success, conversationId, ...(account.platform === 'whatsapp' ? { mayMarkRead: true } : {}) };
        }
        if (route[2] === 'thread-control') return changeControl(context, api, accounts, account, conversationId, row, key);
        if (route[2] === 'accept') return acceptRequest(context, api, accounts, account, conversationId, row, key);
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
        fields(body, ['accountId', 'message', 'buttons', 'attachmentUrl', 'attachmentType', 'attachmentName', 'replyTo', 'messageTag', 'templateName', 'templateLanguage', 'templateComponents']);
        const payload = { accountId };
        if (body.message !== undefined && body.message !== '') payload.message = str(body.message, 'message', inboxCapabilities(account.platform).messageLimit);
        if (body.buttons !== undefined) {
          fields(body, ['accountId', 'message', 'buttons']); supported(account, 'replyButtons');
          payload.message = str(body.message, 'WhatsApp button reply', 1024);
          if (Buffer.byteLength(payload.message, 'utf8') > 1024 || !Array.isArray(body.buttons) || body.buttons.length < 1 || body.buttons.length > 3) fail(400, 'INVALID_REPLY_BUTTONS', 'Use a shorter text message and one to three reply buttons.');
          payload.buttons = body.buttons.map((button, index) => {
            fields(button, ['type', 'title', 'payload']); const title = str(button.title, 'reply button label', 20);
            if (button.type !== 'postback' || button.payload !== `reply_${index + 1}` || title !== title.trim() || /[\u0000-\u001f\u007f]/.test(title)) fail(400, 'INVALID_REPLY_BUTTONS', 'Use the generated reply IDs and short, single-line button labels without surrounding spaces.');
            return { type: 'postback', title, payload: button.payload };
          });
          if (new Set(payload.buttons.map(button => button.title)).size !== payload.buttons.length) fail(400, 'INVALID_REPLY_BUTTONS', 'Use a different label for each reply button.');
        }
        if (body.attachmentUrl) {
          supported(account, 'attachments'); if (!['image', 'video', 'audio', 'file'].includes(body.attachmentType)) fail(400, 'INVALID_ATTACHMENT', 'Choose an image, video, audio file or document.');
          try { payload.attachmentUrl = publicMediaUrl(body.attachmentUrl); } catch { fail(400, 'INVALID_ATTACHMENT', 'Use a public HTTPS media file URL.'); }
          payload.attachmentType = body.attachmentType; if (body.attachmentName) payload.attachmentName = str(body.attachmentName, 'attachment filename', 255);
          if (!inboxCapabilities(account.platform).attachmentTypes.includes(payload.attachmentType) || account.platform === 'tiktok' && payload.message) fail(422, 'ATTACHMENT_UNSUPPORTED', 'This platform does not support that attachment or a combined text and media message.');
          if (payload.message && ['telegram', 'whatsapp'].includes(account.platform) && payload.message.length > 1024) fail(400, 'ATTACHMENT_CAPTION_TOO_LONG', 'Keep the attachment caption to 1024 characters.');
          if (['whatsapp', 'tiktok', 'sms', 'instagram', 'twitter'].includes(account.platform)) {
            let checked;
            try { checked = await api('/tools/validate/media', {}, { url: payload.attachmentUrl }); } catch (error) { if (error instanceof IntegrationError) error.uncertain = false; throw error; }
            if (checked.valid !== true || !Number.isSafeInteger(checked.size) || checked.size < 1 || typeof checked.contentType !== 'string') fail(409, 'ATTACHMENT_NOT_VERIFIED', 'The provider could not verify this attachment’s file type and size.');
            if (checked.url !== undefined) { let echoed; try { echoed = publicMediaUrl(checked.url); } catch { /* An unreadable echo cannot prove the requested file. */ } if (echoed !== payload.attachmentUrl) fail(409, 'ATTACHMENT_NOT_VERIFIED', 'The provider inspected a different attachment. Review its URL before sending.'); }
            const rule = REPLY_MEDIA[account.platform]?.[payload.attachmentType], mime = checked.contentType.split(';')[0].trim().toLowerCase(), limit = rule?.maxMB || (account.platform === 'tiktok' ? 3 : account.platform === 'sms' ? 1 : payload.attachmentType === 'image' ? 5 : payload.attachmentType === 'file' ? 100 : 16);
            const acceptedType = rule ? rule.mimes ? rule.mimes.includes(mime) : mime.startsWith(rule.mimePrefix) && mime.length > rule.mimePrefix.length : payload.attachmentType === 'image' ? ['image/jpeg', 'image/png', ...(account.platform === 'sms' ? ['image/gif', 'image/webp'] : [])].includes(mime) : payload.attachmentType === 'video' ? ['video/mp4', 'video/3gpp'].includes(mime) : payload.attachmentType === 'audio' ? ['audio/mpeg', 'audio/ogg', 'audio/amr', 'audio/aac', 'audio/mp4'].includes(mime) : DOCUMENT_MIMES.has(mime);
            if (checked.size > limit * 1024 * 1024 || !acceptedType) fail(400, 'ATTACHMENT_RESTRICTION', `Choose ${rule?.formats || 'a supported attachment'} within the ${limit} MB limit.`);
          }
        } else if (body.attachmentType || body.attachmentName) fail(400, 'INVALID_ATTACHMENT', 'Choose an attachment URL before setting its type or filename.');
        if (body.replyTo) { if (!['whatsapp', 'telegram', 'slack'].includes(account.platform)) fail(422, 'QUOTE_REPLY_UNSUPPORTED', 'This platform does not support quoted replies.'); payload.replyTo = id(body.replyTo); }
        if (body.templateName) {
          if (account.platform !== 'whatsapp' || payload.message || payload.attachmentUrl) fail(400, 'INVALID_TEMPLATE', 'Send a WhatsApp template by itself.');
          const templates = await listWhatsAppTemplates({ env, project, accountId, assertMapping }), draft = { ...body, accountId }, approved = templates.templates.find(item => item.name === body.templateName && item.language === body.templateLanguage);
          payload.template = { elements: [validateWhatsAppTemplate(draft, approved)] };
        }
        if (!payload.message && !payload.attachmentUrl && !payload.template) fail(400, 'EMPTY_MESSAGE', 'Enter a message or choose an attachment or approved template.');
        const messages = ['facebook', 'instagram', 'whatsapp', 'tiktok'].includes(account.platform) && !payload.template ? await recentHistory(api, account, conversationId, row.id) : null;
        const fresh = await conversation(api, accounts, account, conversationId), freshAccounts = await scopedAccounts(api, profileId), freshAccount = requireAccount(freshAccounts, accountId);
        supported(freshAccount, 'messages');
        if (freshAccount.needsReconnection === true || ['_id', 'platform', 'platformUserId', 'username'].some(field => freshAccount[field] !== account[field])) fail(409, 'INBOX_ACCOUNT_CHANGED', 'This account changed while checking the reply. Refresh before sending.');
        if (fresh.id !== row.id || fresh.participantId !== row.participantId || fresh.threadControl !== row.threadControl) fail(409, 'INBOX_CONVERSATION_CHANGED', 'The conversation recipient or reply control changed. Refresh before sending.');
        if (['facebook', 'instagram', 'whatsapp', 'tiktok'].includes(account.platform) && !payload.template) {
          const lastIncoming = incomingTime(messages), age = Date.now() - lastIncoming;
          if (account.platform === 'tiktok' && (!(age >= 0 && age <= 2 * 86400000) || messages.filter(message => message.direction === 'outgoing' && Date.parse(message.createdAt) >= lastIncoming).length >= 10)) fail(409, 'MESSAGING_WINDOW_CLOSED', 'TikTok permits up to ten replies within 48 hours of the customer’s last message.');
          if (body.messageTag) {
            const tags = account.platform === 'instagram' ? ['HUMAN_AGENT'] : account.platform === 'facebook' ? ['CONFIRMED_EVENT_UPDATE', 'POST_PURCHASE_UPDATE', 'ACCOUNT_UPDATE', 'HUMAN_AGENT'] : [];
            if (!tags.includes(body.messageTag) || body.messageTag === 'HUMAN_AGENT' && !(age >= 0 && age <= 7 * 86400000)) fail(400, 'INVALID_MESSAGE_TAG', 'Choose a supported message tag within its permitted reply window.');
            payload.messagingType = 'MESSAGE_TAG'; payload.messageTag = body.messageTag;
          } else if (account.platform !== 'tiktok' && !(age >= 0 && age <= 86400000)) fail(409, 'MESSAGING_WINDOW_CLOSED', account.platform === 'whatsapp' ? 'Choose an approved WhatsApp template outside the 24-hour reply window.' : 'Choose a permitted non-promotional message tag outside the 24-hour reply window.');
        } else if (body.messageTag) fail(422, 'MESSAGE_TAG_UNSUPPORTED', 'Message tags are only available for Facebook and Instagram.');
        if (payload.attachmentUrl && context.store?.list(project.id, 'assets').some(asset => asset.deliveryUrl === payload.attachmentUrl && assetDeliveryIssue(asset))) fail(409, 'ATTACHMENT_EXPIRED', 'This hosted delivery file has expired or has no verified expiry. Upload it again before sending.');
        const result = await api(`/inbox/conversations/${encodeURIComponent(conversationId)}/messages`, {}, payload, key);
        if (result.success !== true || !plain(result.data) || account.platform !== 'reddit' && !valid(result.data.messageId) || result.data.accountId !== undefined && result.data.accountId !== accountId || result.data.platform !== undefined && result.data.platform !== account.platform || result.data.conversationId !== undefined && !valid(result.data.conversationId) || !['facebook', 'instagram', 'bluesky', 'reddit'].includes(account.platform) && result.data.conversationId !== undefined && ![conversationId, row.id].includes(result.data.conversationId)) invalid(true);
        if (result.warnings != null && (!Array.isArray(result.warnings) || result.warnings.length > 100 || result.warnings.some(warning => typeof warning !== 'string' && (!plain(warning) || ['code', 'param', 'message'].some(field => warning[field] != null && typeof warning[field] !== 'string'))))) invalid(true);
        const combined = ['facebook', 'instagram'].includes(account.platform) && payload.attachmentUrl && payload.message, receipt = result.data, partial = receipt.partialFailure;
        if (combined && partial === undefined && receipt.messageIds === undefined) invalid(true);
        if (receipt.messageIds !== undefined && (!combined || !Array.isArray(receipt.messageIds) || receipt.messageIds.length !== (partial ? 1 : 2) || receipt.messageIds.some(value => !valid(value)) || new Set(receipt.messageIds).size !== receipt.messageIds.length || receipt.messageIds[0] !== receipt.messageId)) invalid(true);
        if (partial !== undefined && (!combined || !plain(partial) || partial.part !== 'text' || typeof partial.error !== 'string' || !partial.error.trim() || partial.error.length > 4000 || partial.platformError !== undefined && (!plain(partial.platformError) || ['code', 'subcode'].some(name => partial.platformError[name] !== undefined && !Number.isSafeInteger(partial.platformError[name])) || ['fbtraceId', 'type'].some(name => partial.platformError[name] !== undefined && (typeof partial.platformError[name] !== 'string' || partial.platformError[name].length > 500))))) invalid(true);
        if (receipt.attachments !== undefined && (!payload.attachmentUrl || !Array.isArray(receipt.attachments) || receipt.attachments.length > 1 || receipt.attachments.some(item => !plain(item) || item.type !== payload.attachmentType || typeof item.url !== 'string' || !(() => { try { return Boolean(publicMediaUrl(item.url)); } catch { return false; } })()))) invalid(true);
        return { sent: true, accountId, platform: account.platform, ...pick(receipt, ['messageId', 'conversationId', 'messageIds']), ...(receipt.attachments ? { attachments: receipt.attachments.map(item => pick(item, ['type', 'url'])) } : {}), ...(partial ? { partialFailure: { ...pick(partial, ['part', 'error']), ...(partial.platformError ? { platformError: pick(partial.platformError, ['code', 'subcode', 'fbtraceId', 'type']) } : {}) } } : {}), warnings: (result.warnings || []).map(warning => typeof warning === 'string' ? warning : pick(warning, ['code', 'param', 'message'])) };
      }
      if (path === 'mentions') { supported(account, 'mentions'); const result = await aggregate(api, accounts, account, 'mentions', query(url, 'mentions')); return { mentions: result.rows.map(row => pick(row, mentionFields)), pagination: result.pagination, meta: result.meta }; }
      if (path === 'comments') { supported(account, 'comments'); const result = await aggregate(api, accounts, account, 'comments', query(url, 'comments')); return { posts: result.rows.map(row => pick(row, postFields)), pagination: result.pagination, meta: result.meta }; }
      if (path === 'comments/thread' || action?.[1] === 'comments') {
        supported(account, 'comments'); const postId = id(req.method === 'GET' ? url.searchParams.get('postId') : body.postId), post = await findRow(api, accounts, account, 'comments', postId);
        const verb = action?.[2]; let target = null;
        if (req.method === 'GET') return privateReplyThread(context, accounts, account, post, await thread(api, accounts, account, post, { ...query(url, 'comments'), ...(url.searchParams.get('commentId') ? { commentId: id(url.searchParams.get('commentId')) } : {}) }));
        fields(body, verb === 'edit' ? ['accountId', 'postId', 'commentId', 'content', 'expectedCommentVersion', 'confirmEdit'] : verb === 'private-reply' ? ['accountId', 'postId', 'commentId', 'message', 'expectedCommentVersion', 'confirmSend', 'buttons', 'quickReplies'] : ['accountId', 'postId', 'commentId', 'message', 'moderationStatus', 'banAuthor', ...(verb === 'like' ? ['reactionType'] : [])]);
        if (body.reactionType !== undefined && (account.platform !== 'linkedin' || !LINKEDIN_REACTIONS.has(body.reactionType))) fail(400, 'INVALID_COMMENT_REACTION', 'Choose one of the six supported LinkedIn reactions. Reaction types are only available for LinkedIn likes.');
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
        if (verb === 'private-reply') return privateCommentReply(context, api, account, post, target, moderationAccount, moderationPostId, key);
        if (verb === 'edit') {
          supported(account, 'commentEdit');
          if (post.isAd || target.row.platform !== 'reddit' || target.row.from?.isOwner !== true) fail(422, 'COMMENT_EDIT_UNSUPPORTED', 'Only this connected account’s own Reddit comments can be edited.');
          const content = str(body.content, 'comment text');
          if (body.confirmEdit !== true || body.expectedCommentVersion !== editableCommentVersion(account, post.id, target.row)) fail(409, 'COMMENT_EDIT_REVIEW_REQUIRED', 'Refresh this comment and review its account and current text before editing.');
          const freshAccounts = await scopedAccounts(api, profileId), freshAccount = requireAccount(freshAccounts, accountId);
          supported(freshAccount, 'commentEdit');
          if (freshAccount.platform !== account.platform || (freshAccount.platformUserId ?? null) !== (account.platformUserId ?? null)) fail(409, 'INBOX_ACCOUNT_CHANGED', 'This connected account changed. Refresh before editing its comment.');
          assertMapping();
          claimCommentReaction(context, freshAccount, post.id, target.row.id, 'edit');
          const receipt = await api(commentEndpoint, {}, { accountId, platform: 'reddit', content }, key, 'PATCH');
          if (receipt.status !== 'success' || receipt.commentId !== target.row.id || receipt.platform !== 'reddit') invalid(true);
          let fresh;
          try { fresh = await findComment(api, freshAccounts, freshAccount, post, target.row.id); }
          catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
          if (fresh.row.message !== content || fresh.row.from?.isOwner !== true || fresh.row.from?.id !== target.row.from?.id) fail(502, 'COMMENT_EDIT_NOT_CONFIRMED', 'The latest thread has not confirmed this exact edit. Check the comment before another change.', true);
          return { edited: true, accountId, postId: post.id, commentId: target.row.id, platform: 'reddit', content, comment: { ...fresh.row, editVersion: editableCommentVersion(freshAccount, post.id, fresh.row) } };
        }
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
          const freshAccounts = await scopedAccounts(api, profileId), freshAccount = requireAccount(freshAccounts, accountId), freshModeration = requireAccount(freshAccounts, moderationAccount._id);
          if (freshAccount.platform !== account.platform || freshAccount.isActive === false || freshModeration.platform !== platform || freshModeration.isActive === false || moderationAccount.platformUserId != null && freshModeration.platformUserId !== moderationAccount.platformUserId) fail(409, 'INBOX_ACCOUNT_CHANGED', 'This account changed. Refresh before changing a comment reaction.');
          if (platform === 'linkedin' && verb === 'like') payload.reactionType = body.reactionType || 'LIKE';
          if (platform === 'bluesky') { if (!valid(verb === 'like' ? target.row.cid : target.row.likeUri)) fail(409, 'COMMENT_REFERENCE_REQUIRED', 'Refresh this Bluesky comment before changing its like.'); if (verb === 'like') payload.cid = target.row.cid; else payload.likeUri = target.row.likeUri; }
          let result;
          claimCommentReaction(context, freshModeration, moderationPostId, target.row.id, verb, payload.reactionType);
          try { result = await api(`${commentEndpoint}/like`, verb === 'unlike' ? payload : {}, verb === 'like' ? payload : undefined, key, verb === 'like' ? 'POST' : 'DELETE'); }
          catch (error) {
            if (platform === 'linkedin' && error.providerStatus === 403) fail(403, 'LINKEDIN_REACTION_PERMISSION_REQUIRED', 'LinkedIn could not authorize this reaction. Check inbox access and reconnect the account with social-feed permissions.');
            if (platform === 'linkedin' && verb === 'like' && error.providerStatus === 409) fail(409, 'LINKEDIN_REACTION_CONFLICT', 'LinkedIn already has a different or unreadable reaction. Refresh and explicitly remove it before adding a different reaction.');
            throw error;
          }
          if (result.status !== 'success' || result.commentId !== target.row.id || result.platform !== platform || result.liked !== (verb === 'like') || result.accountId !== undefined && result.accountId !== moderationAccount._id || result.postId !== undefined && result.postId !== moderationPostId || result.alreadyReacted !== undefined && (platform !== 'linkedin' || verb !== 'like' || typeof result.alreadyReacted !== 'boolean') || platform === 'linkedin' && verb === 'like' && result.reactionType !== payload.reactionType || result.reactionType !== undefined && (platform !== 'linkedin' || verb !== 'like' || !LINKEDIN_REACTIONS.has(result.reactionType)) || result.likeUri !== undefined && !valid(result.likeUri)) invalid(true);
          return { accountId, postId: post.id, platform, commentId: target.row.id, liked: result.liked, ...pick(result, ['likeUri', 'alreadyReacted', 'reactionType']) };
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
    if (url.searchParams.has('check')) {
      if (route?.[2] !== 'reply' || body.buttons === undefined || url.searchParams.getAll('check').length !== 1 || url.searchParams.get('check') !== '1' || [...url.searchParams.keys()].some(name => name !== 'check')) fail(400, 'INVALID_INBOX_FILTER', 'Use the exact retained reply outcome check.');
    }
    if (mutation) { const result = await operation(context, run, messageAction || route ? ['inbox', accountId, decodedId((messageAction || route)[1])] : action?.[1] === 'comments' && ['edit', 'like', 'unlike'].includes(action[2]) ? ['inbox-comment', accountId, id(body.postId), id(body.commentId)] : undefined); send(result.status, result.data); } else send(200, await run());
  } catch (error) { if (!(error instanceof IntegrationError)) throw error; if (path === 'mentions' && error.providerStatus === 403) { send(403, { error: { code: 'MENTIONS_ACCESS_REQUIRED', message: 'LinkedIn organization mentions require the Zernio Inbox add-on and access to this connected account. Check its subscription and permissions.' } }); } else send(error.status, { error: { code: error.code, message: error.message } }); }
  return true;
}
