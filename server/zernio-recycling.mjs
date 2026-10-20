import { createHash, randomUUID } from 'node:crypto';
import { IntegrationError, operation, scopedAccounts, scopedPost, remotePostModel, remoteRestrictionPayload, validateRemotePayload, providerPostValidation, savePostSnapshot, validProviderInstant, targetConfiguration } from './provider-core.ts';

const fail = (status, code, message, uncertain = false) => { throw new IntegrationError(status, code, message, uncertain); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\s\u0000-\u001f\u007f]/.test(value);
const reference = value => String(value?._id || value);
const canonical = value => JSON.stringify(value, (_key, row) => object(row) ? Object.fromEntries(Object.entries(row).sort(([a], [b]) => a.localeCompare(b))) : row);
const fingerprint = value => createHash('sha256').update(canonical(value)).digest('hex');
const malformed = () => fail(502, 'INVALID_RECYCLING_RESPONSE', 'Zernio did not return complete recycling details.');
const fields = (body, allowed) => { if (!object(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_RECYCLING_FIELDS', 'Use only the recycling controls shown in this form.'); };
const count = value => Number.isSafeInteger(value) && value >= 0;
function configuration(value, provider = false) {
  const invalid = message => { if (provider) malformed(); fail(400, 'INVALID_RECYCLING_CONFIG', message); };
  if (!object(value) || typeof value.enabled !== 'boolean' || !provider && Object.keys(value).some(key => !['enabled', 'gap', 'gapFreq', 'startDate', 'expireCount', 'expireDate', 'contentVariations'].includes(key))) invalid('Choose the supported recycling settings.');
  const result = { enabled: value.enabled };
  if (!value.enabled && !provider) return result;
  if (value.gap != null) { if (!Number.isSafeInteger(value.gap) || value.gap < 1) invalid('Use a positive whole number for the interval.'); result.gap = value.gap; }
  if (value.gapFreq != null) { if (!['week', 'month'].includes(value.gapFreq)) invalid('Choose weeks or months.'); result.gapFreq = value.gapFreq; }
  if (value.startDate != null) { if (!validProviderInstant(value.startDate)) invalid('Choose a valid start time with a timezone.'); result.startDate = new Date(value.startDate).toISOString(); }
  if (value.enabled && (result.gap === undefined || result.gapFreq === undefined || result.startDate === undefined)) invalid('Choose the interval and a start time before enabling recycling.');
  if (value.expireCount != null && (!Number.isSafeInteger(value.expireCount) || value.expireCount < 1)) invalid('Use a positive copy limit, or leave it unlimited.');
  if (value.expireDate != null && !validProviderInstant(value.expireDate)) invalid('Choose a valid end time with a timezone.');
  result.expireCount = value.expireCount ?? null; result.expireDate = value.expireDate == null ? null : new Date(value.expireDate).toISOString();
  if (value.contentVariations != null && (!Array.isArray(value.contentVariations) || value.contentVariations.length > 20 || value.contentVariations.length === 1 || value.contentVariations.some(item => typeof item !== 'string' || item.length > 100000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item)))) invalid('Use either no variations or between 2 and 20 captions.');
  result.contentVariations = value.contentVariations || [];
  if (result.expireDate && result.startDate && Date.parse(result.expireDate) <= Date.parse(result.startDate)) invalid('The recycling end must be later than its start.');
  return result;
}
function recyclingState(value) {
  if (value == null) return { enabled: false, recycleCount: null, contentVariationIndex: null, nextRecycleAt: null, lastRecycledAt: null };
  const result = configuration(value, true);
  for (const key of ['recycleCount', 'contentVariationIndex']) { if (value[key] != null && !count(value[key])) malformed(); result[key] = value[key] ?? null; }
  for (const key of ['nextRecycleAt', 'lastRecycledAt']) { if (value[key] != null && !validProviderInstant(value[key])) malformed(); result[key] = value[key] == null ? null : new Date(value[key]).toISOString(); }
  return result;
}
export function assertRecyclingSeedEditable(remote, context) {
  if (context) unresolved(context);
  if (recyclingState(remote.recycling).enabled) fail(409, 'RECYCLING_SOURCE_EDIT_REQUIRES_STOP', 'Stop recycling in Publishing → Recurring posts before editing this post. Review the changed content and repeat plan before enabling future copies again.');
}
function tables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS post_recycling_reviews(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,post_id TEXT NOT NULL,fingerprint TEXT NOT NULL,snapshot TEXT NOT NULL,configuration TEXT NOT NULL,reviewed_by TEXT NOT NULL REFERENCES users(id),reviewed_at TEXT NOT NULL,UNIQUE(project_id,post_id,fingerprint));`);
}
function assetSnapshots(context, post) {
  const ids = [...new Set([post.assetId, ...Object.values(post.platformOverrides || {}).map(row => row?.assetId), ...Object.values(post.accountOverrides || {}).map(row => row?.assetId)].filter(Boolean))];
  return ids.map(id => { const asset = context.store.get(context.project.id, 'assets', id); return asset ? Object.fromEntries(['id', 'approval', 'url', 'deliveryUrl', 'kind', 'mimeType', 'size', 'width', 'height', 'duration', 'modifiedTime', 'md5Checksum', 'deliverySource', 'deliveryUploadedAt', 'deliveryExpiresAt', 'deliveryKey', 'deliveryAttemptId', 'deliveryKind', 'deliveryMimeType', 'deliverySize', 'deliveryFilename'].filter(key => asset[key] !== undefined).map(key => [key, asset[key]])) : { id, missing: true }; });
}
async function readPost(context, api, profileId, postId, activeOnly = false) {
  const local = context.store.get(context.project.id, 'posts', postId);
  if (!local?.externalId || local.sample || local.zernioProfileId !== profileId) fail(404, 'RECYCLING_POST_NOT_FOUND', 'Choose a real submitted post from this project.');
  const remote = await scopedPost(api, profileId, local, activeOnly), model = await remotePostModel(context.store, context.project.id, local, remote), payload = remoteRestrictionPayload(model, remote), state = recyclingState(remote.recycling);
  if (remote.recycledFromPostId != null && !validId(remote.recycledFromPostId)) malformed();
  const snapshot = { postId, providerId: local.externalId, profileId, status: remote.status, content: payload.content, mediaItems: payload.mediaItems || [], platforms: payload.platforms, scheduledFor: remote.scheduledFor || null, recycledFromPostId: remote.recycledFromPostId || null, recycling: state, assets: assetSnapshots(context, local) };
  const unavailable = Object.values(model.accountOverrides || {}).some(row => row.scheduledAt) || remote.platforms.some(row => row.scheduledFor && Date.parse(row.scheduledFor) !== Date.parse(remote.scheduledFor)) ? 'Separate account times cannot be recycled. Clear the individual account times and review a shared repeat plan first.' : snapshot.recycledFromPostId ? 'This is an automatically created copy. Manage recycling on its original post to avoid starting another cycle.' : remote.platforms.some(row => ['youtube', 'tiktok'].includes(row.platform)) ? 'YouTube and TikTok posts cannot be recycled.' : !['draft', 'scheduled', 'published'].includes(remote.status) ? 'Refresh or resolve this post’s publishing outcome before enabling recycling.' : remote.status === 'published' && remote.platforms.some(row => row.status !== 'published') ? 'Every published account copy must have a confirmed published outcome before enabling recycling.' : '';
  return { local, remote, model, payload, snapshot, version: fingerprint(snapshot), unavailable };
}
function publicPost(read) {
  return { postId: read.local.id, providerId: read.local.externalId, status: read.remote.status, content: read.payload.content, mediaItems: read.payload.mediaItems || [], copies: read.remote.platforms.map(row => ({ accountId: reference(row.accountId), accountName: row.accountId?.displayName || row.accountId?.username || reference(row.accountId), platform: row.platform, status: row.status || 'unknown', ...targetConfiguration(row) })), recycling: read.snapshot.recycling, assets: read.snapshot.assets, fingerprint: read.version, recycledFromPostId: read.snapshot.recycledFromPostId, canEnable: !read.unavailable, unavailable: read.unavailable };
}
function expected(value, actual) { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value) || value !== actual) fail(409, 'RECYCLING_REVIEW_CHANGED', 'The post, creative or recycling cycle changed. Reload and review the full plan again.'); }
async function history(api, profileId, accountId, accounts) {
  const all = [], seen = new Set(); let total;
  // ponytail: verify up to 10,000 posts in the selected account/profile; add provider-side recycling filters when documented.
  for (let page = 1; page <= 20; page++) {
    const response = await api('/posts', { profileId, accountId, source: 'zernio', includeHidden: true, page, limit: 500, sortBy: 'created-asc' }), paging = response.pagination;
    if (!Array.isArray(response.posts) || response.posts.length > 500 || !object(paging) || paging.page !== page || paging.limit !== 500 || !count(paging.total) || !count(paging.pages) || paging.pages !== Math.ceil(paging.total / 500) || total != null && paging.total !== total) malformed(); total = paging.total;
    for (const post of response.posts) {
      if (!object(post) || !validId(post._id) || seen.has(post._id) || !['draft', 'scheduled', 'publishing', 'published', 'partial', 'failed', 'cancelled'].includes(post.status) || post.profileId != null && reference(post.profileId) !== profileId || !Array.isArray(post.platforms) || !post.platforms.length || accountId && !post.platforms.some(row => reference(row.accountId) === accountId) || post.platforms.some(row => !accounts.some(account => account._id === reference(row.accountId) && account.platform === row.platform))) malformed();
      recyclingState(post.recycling); seen.add(post._id); all.push(post);
    }
    if (page >= paging.pages) { if (all.length !== total) malformed(); return all; }
  }
  fail(503, 'RECYCLING_HISTORY_INCOMPLETE', 'The complete provider history could not be verified. Inspect recycling in Zernio before changing this cycle.');
}
async function checkPlan(context, api, profileId, read, config) {
  if (read.unavailable) fail(422, 'RECYCLING_UNAVAILABLE', read.unavailable);
  if (!read.snapshot.recycling.enabled && Date.parse(config.startDate) <= Date.now()) fail(400, 'RECYCLING_START_PASSED', 'Choose a future start before enabling a new cycle.');
  if (config.expireDate && Date.parse(config.expireDate) <= Date.now() || config.expireCount != null && config.expireCount <= (read.snapshot.recycling.recycleCount || 0)) fail(400, 'RECYCLING_ALREADY_EXPIRED', 'Choose an end and copy limit that leave at least one future copy.');
  const requiresApproval = context.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_approval_policy'").get() && context.db.prepare('SELECT require_approval FROM project_approval_policy WHERE project_id=?').get(context.project.id)?.require_approval;
  if (read.snapshot.assets.some(row => row.missing || requiresApproval && row.approval !== 'approved')) fail(409, 'RECYCLING_ASSET_APPROVAL_REQUIRED', 'Every referenced creative must exist and have current approval before enabling automatic copies.');
  const assets = read.snapshot.assets;
  for (const content of config.contentVariations.length ? config.contentVariations : [read.payload.content]) {
    const payload = { ...read.payload, content }; validateRemotePayload(payload, assets, read.model);
    const result = await providerPostValidation(api, payload); if (!result.valid) fail(422, 'RECYCLING_RESTRICTIONS', result.errors.map(row => `${row.platform}: ${row.message}`).join(' ').slice(0, 4000));
  }
  const accounts = await scopedAccounts(api, profileId);
  for (const accountId of new Set(read.remote.platforms.map(row => reference(row.accountId)))) {
    const posts = await history(api, profileId, accountId, accounts);
    if (posts.filter(row => row._id !== read.local.externalId && row.recycling?.enabled === true).length >= 10) fail(409, 'RECYCLING_CAPACITY', 'An account already has ten active recycling posts. Stop another cycle before enabling this one.');
  }
}
function unresolved(context) {
  if (context.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='integration_operations'").get() && context.db.prepare("SELECT id FROM integration_operations WHERE project_id=? AND request_key<>? AND status IN ('pending','uncertain') AND (action_path LIKE 'POST /integrations/recycling/%' OR action_path IN ('POST /integrations/social/update','POST /integrations/social/edit-published','POST /integrations/social/update-metadata'))").get(context.project.id, context.req.headers['idempotency-key'])) fail(409, 'RECYCLING_PREVIOUS_OUTCOME_UNRESOLVED', 'Review the previous recycling or post-content change before applying another plan. This new change has not been sent.');
}
function reviewedConfiguration(config) {
  if (!config.enabled) fail(400, 'RECYCLING_STOP_REQUIRED', 'Use Stop recycling to disable a cycle.');
  return { ...config, expireCount: config.expireCount ?? null, expireDate: config.expireDate ?? null, contentVariations: config.contentVariations || [] };
}
export async function handleZernioRecycling(context, api, profileId, action) {
  const { req, body = {}, project, role, store, db, send } = context;
  if (!action && req.method === 'GET') { send(200, { posts: store.list(project.id, 'posts').filter(row => row.externalId && !row.sample && !row.providerDeletedAt && row.zernioProfileId === profileId).map(row => ({ id: row.id, content: row.content || '', platforms: row.platforms || [], status: row.status })) }); return true; }
  const match = /^posts\/([^/]+)(?:\/(review|apply|stop|copies))?$/.exec(action); if (!match) return false;
  let postId; try { postId = decodeURIComponent(match[1]); } catch { fail(400, 'INVALID_RECYCLING_POST', 'Choose a valid post.'); } if (!validId(postId)) fail(400, 'INVALID_RECYCLING_POST', 'Choose a valid post.');
  const command = match[2]; if (req.method !== (!command || command === 'copies' ? 'GET' : 'POST')) fail(405, 'METHOD_NOT_ALLOWED', 'Use the available recycling controls.');
  if (!command || command === 'copies') {
    const read = await readPost(context, api, profileId, postId);
    if (!command) { send(200, publicPost(read)); return true; }
    const accounts = await scopedAccounts(api, profileId), posts = await history(api, profileId, undefined, accounts);
    const copies = posts.filter(row => row.recycledFromPostId === read.local.externalId).map(row => { for (const key of ['scheduledFor', 'publishedAt']) if (row[key] != null && !validProviderInstant(row[key])) malformed(); return { id: row._id, content: typeof row.content === 'string' ? row.content : '', status: row.status, scheduledAt: row.scheduledFor || null, publishedAt: row.publishedAt || null }; });
    send(200, { copies, complete: true }); return true;
  }
  if (!['owner', 'admin'].includes(role)) fail(403, 'RECYCLING_ADMIN_REQUIRED', 'A workspace owner or administrator must review and change automatic publishing.');
  context.assertProviderPostEdit?.(); tables(db);
  if (command === 'review') {
    fields(body, ['expectedFingerprint', 'configuration', 'confirmReview']); if (body.confirmReview !== true) fail(400, 'RECYCLING_CONFIRMATION_REQUIRED', 'Review all captions, creative, account settings and repeat limits before approving automatic copies.');
    const read = await readPost(context, api, profileId, postId, true); expected(body.expectedFingerprint, read.version); const config = reviewedConfiguration(configuration(body.configuration));
    await checkPlan(context, api, profileId, read, config);
    const fresh = await readPost(context, api, profileId, postId, true); expected(read.version, fresh.version); context.assertProviderPostEdit?.();
    const reviewFingerprint = fingerprint([fresh.snapshot, config]), reviewedAt = new Date().toISOString();
    db.prepare('INSERT OR IGNORE INTO post_recycling_reviews VALUES(?,?,?,?,?,?,?,?)').run(randomUUID(), project.id, postId, reviewFingerprint, canonical(fresh.snapshot), canonical(config), context.user.id, reviewedAt);
    const review = db.prepare('SELECT id,reviewed_by AS reviewedBy,reviewed_at AS reviewedAt FROM post_recycling_reviews WHERE project_id=? AND post_id=? AND fingerprint=?').get(project.id, postId, reviewFingerprint);
    store.activity(project.id, 'Reviewed an automatic post recycling plan.'); send(200, { review: { ...review, configuration: config, fingerprint: fresh.version }, post: publicPost(fresh) }); return true;
  }
  fields(body, command === 'apply' ? ['reviewId'] : ['expectedFingerprint', 'confirmStop']);
  if (command === 'apply' && !validId(body.reviewId) || command === 'stop' && body.confirmStop !== true) fail(400, 'RECYCLING_CONFIRMATION_REQUIRED', 'Review the plan before applying it, or explicitly confirm stopping recycling.');
  const outcome = await operation(context, async key => {
    unresolved(context);
    const read = await readPost(context, api, profileId, postId, command === 'apply'); let config;
    if (command === 'apply') {
      const review = db.prepare('SELECT * FROM post_recycling_reviews WHERE project_id=? AND post_id=? AND id=?').get(project.id, postId, body.reviewId); if (!review) fail(404, 'RECYCLING_REVIEW_NOT_FOUND', 'Review this post’s complete recycling plan first.');
      expected(fingerprint(JSON.parse(review.snapshot)), read.version); config = reviewedConfiguration(configuration(JSON.parse(review.configuration)));
      await checkPlan(context, api, profileId, read, config);
      const fresh = await readPost(context, api, profileId, postId, true); expected(read.version, fresh.version);
    } else { expected(body.expectedFingerprint, read.version); if (!read.snapshot.recycling.enabled) fail(409, 'RECYCLING_NOT_ACTIVE', 'Recycling is already stopped. Refresh its latest state.'); config = { enabled: false }; }
    context.assertProviderPostEdit?.();
    let response;
    try { response = await api(`/posts/${encodeURIComponent(read.local.externalId)}`, {}, { recycling: config }, key, 'PUT'); }
    catch (error) { if (error instanceof IntegrationError && error.status >= 500) error.uncertain = true; throw error; }
    try {
      if (!object(response.post) || response.post._id !== read.local.externalId || response.post.status !== read.remote.status) malformed();
      const confirmed = await readPost(context, api, profileId, postId), actual = configuration(confirmed.remote.recycling, true);
      if (config.enabled ? canonical(actual) !== canonical(config) : actual.enabled !== false) malformed();
      if (canonical({ ...confirmed.snapshot, recycling: null }) !== canonical({ ...read.snapshot, recycling: null })) malformed();
      await savePostSnapshot(store, project.id, read.local, confirmed.remote, {}, read.remote.platforms, read.local);
      store.activity(project.id, config.enabled ? 'Enabled the reviewed automatic publishing cycle.' : 'Stopped automatic post recycling. Previously created copies are unchanged.');
      return { post: publicPost(confirmed) };
    } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
  }, 'publishing-recycling');
  send(outcome.status, outcome.data); return true;
}
