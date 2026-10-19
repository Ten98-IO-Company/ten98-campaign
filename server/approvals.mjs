import { createHash, randomUUID } from 'node:crypto';
import { IntegrationError, targetConfiguration, zernioClient } from './integrations.mjs';
import { buildPlatformEntry, normalizeAccountVariants, resolveVariant } from '../shared/social-posts.mjs';
import { queueList, reviewedQueue } from './zernio-queues.mjs';

const initialized = new WeakSet(), administrators = new Set(['owner', 'admin']);
const fail = (status, code, message) => { throw new IntegrationError(status, code, message); };
function tables(db) {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS project_approval_policy(project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,require_approval INTEGER NOT NULL CHECK(require_approval IN (0,1)),updated_by TEXT NOT NULL REFERENCES users(id),updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS post_approval_reviews(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,post_id TEXT NOT NULL,fingerprint TEXT NOT NULL,snapshot TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),requested_by TEXT NOT NULL REFERENCES users(id),requested_at TEXT NOT NULL,reviewed_by TEXT REFERENCES users(id),reviewed_at TEXT,note TEXT NOT NULL DEFAULT '');
    CREATE INDEX IF NOT EXISTS post_approval_reviews_post ON post_approval_reviews(project_id,post_id);`);
  initialized.add(db);
}
function policy(db, projectId) {
  tables(db); const row = db.prepare('SELECT require_approval AS requireApproval,updated_by AS updatedBy,updated_at AS updatedAt FROM project_approval_policy WHERE project_id=?').get(projectId);
  return row ? { ...row, requireApproval: Boolean(row.requireApproval) } : { requireApproval: false, updatedBy: null, updatedAt: null };
}
function postSnapshot(context, post) {
  const accountOverrides = normalizeAccountVariants(post);
  const ids = [...new Set([post.assetId, ...Object.values(post.platformOverrides || {}).map(item => item?.assetId), ...Object.values(accountOverrides).map(item => item?.assetId)].filter(Boolean))];
  const records = ids.map(id => context.store.get(context.project.id, 'assets', id));
  const assets = ids.map((id, index) => {
    const asset = records[index];
    return asset ? { id: asset.id, url: asset.url || '', deliveryUrl: asset.deliveryUrl || '', approval: asset.approval || 'pending', kind: asset.kind || '', size: asset.size ?? null, mimeType: asset.mimeType || '', width: asset.width ?? null, height: asset.height ?? null, duration: asset.duration ?? null, modifiedTime: asset.modifiedTime || '', md5Checksum: asset.md5Checksum || '', ...(asset.deliverySource === 'zernio' ? Object.fromEntries(['deliverySource', 'deliveryUploadedAt', 'deliveryExpiresAt', 'deliveryKey', 'deliveryAttemptId', 'deliveryKind', 'deliveryMimeType', 'deliverySize', 'deliveryFilename'].map(key => [key, asset[key] ?? null])) : {}) } : { id, missing: true };
  });
  const variants = Object.fromEntries((post.platforms || []).map(platform => {
    const variant = resolveVariant(post, platform, records.filter(Boolean));
    return [platform, { content: variant.content, mediaItems: variant.mediaItems, options: variant.options }];
  }));
  const mediaItems = resolveVariant({ ...post, platformOverrides: {} }, 'facebook', records.filter(Boolean)).mediaItems;
  const accountVariants = Object.fromEntries(Object.entries(accountOverrides).map(([id, copy]) => { const variant = resolveVariant(post, copy.platform, records.filter(Boolean), id); return [id, { platform: copy.platform, content: variant.content, mediaItems: variant.mediaItems, options: variant.options, ...(copy.scheduledAt ? { scheduledAt: copy.scheduledAt } : {}) }]; }));
  const wireItems = items => items.map(({ width, height, duration, ...item }) => item);
  const configuration = target => {
    const current = targetConfiguration(target);
    const options = Array.isArray(current.options?.threadItems) ? { ...current.options, threadItems: current.options.threadItems.map(item => ({ ...item, ...(Array.isArray(item.mediaItems) ? { mediaItems: wireItems(item.mediaItems) } : {}) })) } : current.options;
    return { ...(typeof current.content === 'string' ? { customContent: current.content } : {}), ...(current.mediaItems ? { customMedia: wireItems(current.mediaItems) } : {}), ...(options && Object.keys(options).length ? { platformSpecificData: options } : {}) };
  };
  const providerVariants = (post.providerResults || []).filter(target => target.platform && target.accountId).flatMap(target => {
    const id = String(target.accountId?._id || target.accountId), actual = configuration(target), expected = configuration(buildPlatformEntry(post, target.platform, id, records.filter(Boolean)));
    const scheduledFor = typeof target.scheduledFor === 'string' && Date.parse(target.scheduledFor) !== Date.parse(accountOverrides[id]?.scheduledAt || post.scheduledAt || post.scheduledFor) ? target.scheduledFor : '';
    return JSON.stringify(actual) === JSON.stringify(expected) && !scheduledFor ? [] : [{ platform: target.platform, accountId: String(target.accountId?._id || target.accountId), ...actual, ...(scheduledFor ? { scheduledFor } : {}) }];
  });
  return { ...(post.queueId ? { queueId: post.queueId, queueVersion: post.queueVersion } : {}), ...(Object.keys(accountVariants).length ? { accountOverrides: accountVariants } : {}), content: post.content || '', platforms: post.platforms || [], accounts: post.accounts || [], mediaItems, platformOverrides: variants, providerVariants, assetId: post.assetId || '', campaignId: post.campaignId || '', scheduledAt: post.scheduledAt || post.scheduledFor || '', assets, asset: assets.find(asset => asset.id === post.assetId) || null };
}
const fingerprint = snapshot => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
const latest = (db, projectId, postId) => db.prepare('SELECT * FROM post_approval_reviews WHERE project_id=? AND post_id=? ORDER BY rowid DESC LIMIT 1').get(projectId, postId);
const submitted = post => Boolean(post.externalId || post.zernioPostId || ['published', 'submitted', 'partial'].includes(post.status));
const retryableFailure = post => Boolean((post.externalId || post.zernioPostId) && ['failed', 'partial'].includes(post.status) && Array.isArray(post.providerResults) && post.providerResults.some(copy => copy.status === 'failed') && (post.status === 'partial') === post.providerResults.some(copy => copy.status === 'published') && post.providerResults.every(copy => ['failed', 'published', 'cancelled'].includes(copy.status)));
function localPost(context, id) {
  const post = context.store.get(context.project.id, 'posts', id);
  if (!post) fail(404, 'APPROVAL_POST_NOT_FOUND', 'This post was not found in the current project.');
  if (post.sample || (submitted(post) && !retryableFailure(post))) fail(409, 'APPROVAL_LOCAL_POST_REQUIRED', 'Request approval for a local draft or failed provider copies after refreshing every account’s status.');
  return post;
}
function assetApproved(snapshot) {
  if (snapshot.assets.some(asset => asset.missing || asset.approval !== 'approved')) fail(409, 'APPROVAL_ASSET_REQUIRED', 'Approve every referenced creative asset before approving or publishing this post.');
}
function publicReview(db, row) {
  if (!row) return null;
  const actor = id => id ? db.prepare('SELECT id,name FROM users WHERE id=?').get(id) || { id, name: 'Former team member' } : null;
  return { id: row.id, status: row.status, requestedBy: actor(row.requested_by), requestedAt: row.requested_at, reviewedBy: actor(row.reviewed_by), reviewedAt: row.reviewed_at, note: row.note, snapshot: JSON.parse(row.snapshot) };
}
function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_APPROVAL_FIELDS', 'Use only the fields shown in the approval form.');
}
function queueItem(context, post, queue = null) {
  const snapshot = postSnapshot(context, post), review = latest(context.db, context.project.id, post.id);
  const status = submitted(post) && !retryableFailure(post) ? 'submitted' : !review ? 'not_requested' : review.fingerprint === fingerprint(snapshot) ? review.status : 'stale';
  return { post: { id: post.id, status: post.status, providerFailed: retryableFailure(post), sample: Boolean(post.sample), queueId: snapshot.queueId || '', queueVersion: snapshot.queueVersion || '', content: snapshot.content, platforms: snapshot.platforms, accounts: snapshot.accounts, mediaItems: snapshot.mediaItems, platformOverrides: snapshot.platformOverrides, ...(snapshot.accountOverrides ? { accountOverrides: snapshot.accountOverrides } : {}), providerVariants: snapshot.providerVariants, assetId: snapshot.assetId, campaignId: snapshot.campaignId, scheduledAt: snapshot.scheduledAt }, queue, assets: snapshot.assets, asset: snapshot.asset, status, review: publicReview(context.db, review) };
}
async function publishingQueues(context) {
  const env = { ...(context.config?.env === undefined ? process.env : context.config.env), ...(context.config || {}) }, profileId = String(context.project.zernioProfileId || '');
  if (!env.ZERNIO_API_KEY || !profileId) fail(409, 'QUEUE_UNAVAILABLE', 'Configure Zernio and this project’s profile before reviewing a queued post.');
  return (await queueList(zernioClient(env.ZERNIO_API_KEY, () => context.assertProjectMapping?.(profileId)), profileId)).queues;
}
function queueSummary(post, queues, unavailable = false) {
  if (!post.queueId || submitted(post)) return null;
  const queue = queues?.find(row => row._id === post.queueId);
  try { if (unavailable) fail(503, 'QUEUE_UNAVAILABLE', 'The publishing queue could not be verified. Refresh before reviewing this post.'); reviewedQueue(post, queues || []); return { ...queue, ready: true }; }
  catch (error) { return { ...(queue || { _id: post.queueId }), ready: false, message: error instanceof IntegrationError ? error.message : 'The publishing queue could not be verified.' }; }
}

export function assertPublishingApproval(context, post) {
  const current = context.store.get(context.project.id, 'posts', post?.id);
  if (!current || post.sample || current.sample) fail(409, 'APPROVAL_POST_NOT_FOUND', 'Use a real post from this project before publishing.');
  const snapshot = postSnapshot(context, current), currentFingerprint = fingerprint(snapshot);
  if (fingerprint(postSnapshot(context, post)) !== currentFingerprint) fail(409, 'APPROVAL_POST_CHANGED', 'The post or creative changed while publishing was being prepared. Refresh it before publishing.');
  if (!policy(context.db, context.project.id).requireApproval) return;
  assetApproved(snapshot);
  const review = latest(context.db, context.project.id, current.id);
  if (!review || review.status !== 'approved') fail(403, 'PUBLISHING_APPROVAL_REQUIRED', 'An owner or administrator must approve this post before it can be sent to a provider.');
  if (review.fingerprint !== currentFingerprint) fail(409, 'PUBLISHING_APPROVAL_STALE', 'This post or its creative changed after approval. Request a new review before publishing.');
}

export function assertProviderPostEdit(context) {
  if (policy(context.db, context.project.id).requireApproval && !administrators.has(context.role)) fail(403, 'APPROVED_PROVIDER_EDIT_RESTRICTED', 'An owner or administrator must make changes to submitted posts while publishing approval is required.');
}

export async function handleApprovals(context) {
  const { req, url, project, role, user, db, store, body = {}, send } = context;
  const prefix = `/api/projects/${project.id}/approvals/`; if (!url.pathname.startsWith(prefix)) return false;
  const path = url.pathname.slice(prefix.length); tables(db);
  try {
    if (req.method === 'GET' && path === 'policy') { send(200, policy(db, project.id)); return true; }
    if (req.method === 'POST' && path === 'policy') {
      if (!administrators.has(role)) fail(403, 'APPROVAL_ADMIN_REQUIRED', 'Only an owner or administrator can change the publishing approval policy.');
      fields(body, ['requireApproval']); if (typeof body.requireApproval !== 'boolean') fail(400, 'INVALID_APPROVAL_POLICY', 'Publishing approval must be enabled or disabled.');
      db.prepare('INSERT INTO project_approval_policy VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET require_approval=excluded.require_approval,updated_by=excluded.updated_by,updated_at=excluded.updated_at').run(project.id, Number(body.requireApproval), user.id, new Date().toISOString());
      store.activity(project.id, `Publishing approval ${body.requireApproval ? 'required' : 'made optional'} by ${user.name || user.id}.`); send(200, policy(db, project.id)); return true;
    }
    if (req.method === 'GET' && path === 'posts') {
      const posts = store.list(project.id, 'posts'); let queues, unavailable = false;
      if (posts.some(post => post.queueId && !submitted(post))) {
        try { queues = await publishingQueues(context); } catch { unavailable = true; }
        context.assertIntegrationSettings?.(); if (project.zernioProfileId) context.assertProjectMapping?.(String(project.zernioProfileId));
      }
      send(200, { ...policy(db, project.id), posts: posts.map(post => queueItem(context, post, queueSummary(post, queues, unavailable))) }); return true;
    }
    const match = path.match(/^posts\/([^/]+)\/(request|review)$/);
    if (!match || req.method !== 'POST') fail(404, 'APPROVAL_ACTION_NOT_FOUND', 'This approval action was not found.');
    if (!['owner', 'admin', 'editor'].includes(role)) fail(403, 'APPROVAL_WRITE_REQUIRED', 'Editing permission is required to request content review.');
    const post = localPost(context, match[1]), snapshot = postSnapshot(context, post), hash = fingerprint(snapshot), review = latest(db, project.id, post.id);
    if (match[2] === 'request') {
      fields(body, []);
      const queue = post.queueId ? reviewedQueue(post, await publishingQueues(context)) : null;
      const currentReview = latest(db, project.id, post.id);
      if (fingerprint(postSnapshot(context, localPost(context, post.id))) !== hash || currentReview?.id !== review?.id || currentReview?.status !== review?.status) fail(409, 'APPROVAL_REVIEW_CHANGED', 'The post or review changed while its queue was being verified. Refresh before requesting review.');
      if (!review || review.fingerprint !== hash || review.status === 'rejected') {
        db.prepare("INSERT INTO post_approval_reviews(id,project_id,post_id,fingerprint,snapshot,status,requested_by,requested_at) VALUES(?,?,?,?,?,'pending',?,?)").run(randomUUID(), project.id, post.id, hash, JSON.stringify(snapshot), user.id, new Date().toISOString());
        store.activity(project.id, `Content review requested by ${user.name || user.id}.`);
      }
      send(200, { item: queueItem(context, post, queue ? { ...queue, ready: true } : null) }); return true;
    }
    if (!administrators.has(role)) fail(403, 'APPROVAL_ADMIN_REQUIRED', 'Only an owner or administrator can approve or reject a post.');
    fields(body, ['decision', 'note', 'reviewId']);
    const note = body.note === undefined ? '' : body.note;
    if (!['approved', 'rejected'].includes(body.decision) || typeof note !== 'string' || note.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note) || typeof body.reviewId !== 'string') fail(400, 'INVALID_APPROVAL_REVIEW', 'Choose approve or reject and use a review note of at most 2,000 characters.');
    if (!review || review.id !== body.reviewId || review.status !== 'pending' || review.fingerprint !== hash) fail(409, 'APPROVAL_REVIEW_CHANGED', 'This review request changed or its post was edited. Refresh the queue before reviewing it.');
    let queue = null;
    if (body.decision === 'approved') {
      if (post.queueId) queue = reviewedQueue(post, await publishingQueues(context));
      const currentReview = latest(db, project.id, post.id);
      if (fingerprint(postSnapshot(context, localPost(context, post.id))) !== hash || currentReview?.id !== review.id || currentReview?.status !== 'pending') fail(409, 'APPROVAL_REVIEW_CHANGED', 'The post or review changed while its queue was being verified. Refresh before approving it.');
      assetApproved(snapshot);
    }
    db.prepare('UPDATE post_approval_reviews SET status=?,reviewed_by=?,reviewed_at=?,note=? WHERE id=?').run(body.decision, user.id, new Date().toISOString(), note.trim(), review.id);
    store.activity(project.id, `Content ${body.decision} by ${user.name || user.id}.`); send(200, { item: queueItem(context, post, queue ? { ...queue, ready: true } : queueSummary(post, [], true)) }); return true;
  } catch (error) {
    send(error instanceof IntegrationError ? error.status : 500, { error: { code: error instanceof IntegrationError ? error.code : 'APPROVAL_ERROR', message: error instanceof IntegrationError ? error.message : 'The content approval action could not be completed.' } }); return true;
  }
}
