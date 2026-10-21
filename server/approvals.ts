import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { advisoryLock } from './auth.ts';
import type { Executor } from './database.ts';
import { fail, IntegrationError, targetConfiguration, zernioClient, type OperationContext, type ProviderRecord } from './provider-core.ts';
import { buildPlatformEntry, normalizeAccountVariants, normalizePostTags, resolveVariant } from '../shared/social-posts.ts';
import { queueList, reviewedQueue } from './zernio-queues.ts';
import { SOCIAL_UPDATE_FIELDS, socialUpdateProposal } from './integrations.ts';

type ApprovalContext = Omit<OperationContext, 'project' | 'body'> & { project: ProviderRecord; body?: any };
const administrators = new Set(['owner', 'admin']);
const first = async (query: Promise<{ rows: unknown[] }>) => (await query).rows[0] as ProviderRecord | undefined;
async function policy(db: Executor, projectId: string) {
  const row = await first(db.execute(sql`SELECT require_approval AS "requireApproval",updated_by AS "updatedBy",updated_at AS "updatedAt" FROM project_approval_policy WHERE project_id=${projectId}`));
  return row ? { ...row, requireApproval: Boolean(row.requireApproval) } : { requireApproval: false, updatedBy: null, updatedAt: null };
}
async function postSnapshot(context: ApprovalContext, post: ProviderRecord) {
  const accountOverrides = normalizeAccountVariants(post);
  const ids = [...new Set([post.assetId, ...Object.values(post.platformOverrides || {}).map((item: any) => item?.assetId), ...Object.values(accountOverrides).map(item => item?.assetId)].filter(Boolean))];
  const records = await Promise.all(ids.map(id => context.store.get(context.project.id, 'assets', id)));
  const assets = ids.map((id, index) => {
    const asset = records[index];
    return asset ? { id: asset.id, url: asset.url || '', deliveryUrl: asset.deliveryUrl || '', approval: asset.approval || 'pending', kind: asset.kind || '', size: asset.size ?? null, mimeType: asset.mimeType || '', width: asset.width ?? null, height: asset.height ?? null, duration: asset.duration ?? null, modifiedTime: asset.modifiedTime || '', md5Checksum: asset.md5Checksum || '', ...(asset.deliverySource === 'zernio' ? Object.fromEntries(['deliverySource', 'deliveryUploadedAt', 'deliveryExpiresAt', 'deliveryKey', 'deliveryAttemptId', 'deliveryKind', 'deliveryMimeType', 'deliverySize', 'deliveryFilename'].map(key => [key, asset[key] ?? null])) : {}) } : { id, missing: true };
  });
  const variants = Object.fromEntries((post.platforms || []).map((platform: string) => {
    const variant = resolveVariant(post, platform, records.filter(Boolean));
    return [platform, { content: variant.content, mediaItems: variant.mediaItems, options: variant.options }];
  }));
  const mediaItems = resolveVariant({ ...post, platformOverrides: {} }, 'facebook', records.filter(Boolean)).mediaItems;
  const accountVariants = Object.fromEntries(Object.entries(accountOverrides).map(([id, copy]) => { const variant = resolveVariant(post, copy.platform, records.filter(Boolean), id); return [id, { platform: copy.platform, content: variant.content, mediaItems: variant.mediaItems, options: variant.options, ...(copy.scheduledAt ? { scheduledAt: copy.scheduledAt } : {}) }]; }));
  const wireItems = (items: ProviderRecord[]) => items.map(({ width, height, duration, ...item }) => item);
  const configuration = (target: ProviderRecord) => {
    const current = targetConfiguration(target);
    const options = Array.isArray(current.options?.threadItems) ? { ...current.options, threadItems: current.options.threadItems.map((item: ProviderRecord) => ({ ...item, ...(Array.isArray(item.mediaItems) ? { mediaItems: wireItems(item.mediaItems) } : {}) })) } : current.options;
    return { ...(typeof current.content === 'string' ? { customContent: current.content } : {}), ...(current.mediaItems ? { customMedia: wireItems(current.mediaItems) } : {}), ...(options && Object.keys(options).length ? { platformSpecificData: options } : {}) };
  };
  const providerVariants = (post.providerResults || []).filter((target: ProviderRecord) => target.platform && target.accountId).flatMap((target: ProviderRecord) => {
    const id = String(target.accountId?._id || target.accountId), actual = configuration(target), expected = configuration(buildPlatformEntry(post, target.platform, id, records.filter(Boolean)));
    const scheduledFor = typeof target.scheduledFor === 'string' && Date.parse(target.scheduledFor) !== Date.parse(accountOverrides[id]?.scheduledAt || post.scheduledAt || post.scheduledFor) ? target.scheduledFor : '';
    return JSON.stringify(actual) === JSON.stringify(expected) && !scheduledFor ? [] : [{ platform: target.platform, accountId: String(target.accountId?._id || target.accountId), ...actual, ...(scheduledFor ? { scheduledFor } : {}) }];
  });
  return { tags: normalizePostTags(post.tags, { preserve: true }), ...(post.queueId ? { queueId: post.queueId, queueVersion: post.queueVersion } : {}), ...(Object.keys(accountVariants).length ? { accountOverrides: accountVariants } : {}), content: post.content || '', platforms: post.platforms || [], accounts: post.accounts || [], mediaItems, platformOverrides: variants, providerVariants, assetId: post.assetId || '', campaignId: post.campaignId || '', scheduledAt: post.scheduledAt || post.scheduledFor || '', assets, asset: assets.find(asset => asset.id === post.assetId) || null };
}
const fingerprint = (snapshot: ProviderRecord) => createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
const latest = (db: Executor, projectId: string, postId: string) => first(db.execute(sql`SELECT * FROM post_approval_reviews WHERE project_id=${projectId} AND post_id=${postId} ORDER BY seq DESC LIMIT 1`));
// A review of a proposed provider update stores the proposal beside the snapshot it fingerprints (#30 Q2).
const proposalOf = (review: ProviderRecord | undefined) => Boolean(review && JSON.parse(review.snapshot).proposal);
const submitted = (post: ProviderRecord) => Boolean(post.externalId || post.zernioPostId || ['published', 'submitted', 'partial'].includes(post.status));
const retryableFailure = (post: ProviderRecord) => Boolean((post.externalId || post.zernioPostId) && ['failed', 'partial'].includes(post.status) && Array.isArray(post.providerResults) && post.providerResults.some((copy: ProviderRecord) => copy.status === 'failed') && (post.status === 'partial') === post.providerResults.some((copy: ProviderRecord) => copy.status === 'published') && post.providerResults.every((copy: ProviderRecord) => ['failed', 'published', 'cancelled'].includes(copy.status)));
async function localPost(context: ApprovalContext, id: string) {
  const post = await context.store.get(context.project.id, 'posts', id);
  if (!post) fail(404, 'APPROVAL_POST_NOT_FOUND', 'This post was not found in the current project.');
  if (post.sample || (submitted(post) && !retryableFailure(post))) fail(409, 'APPROVAL_LOCAL_POST_REQUIRED', 'Request approval for a local draft or failed provider copies after refreshing every account’s status.');
  return post;
}
function assetApproved(snapshot: ProviderRecord) {
  if (snapshot.assets.some((asset: ProviderRecord) => asset.missing || asset.approval !== 'approved')) fail(409, 'APPROVAL_ASSET_REQUIRED', 'Approve every referenced creative asset before approving or publishing this post.');
}
function approvalAccounts(post: ProviderRecord) {
  if (!Array.isArray(post.accounts) || !post.accounts.length) fail(409, 'APPROVAL_ACCOUNTS_REQUIRED', 'Edit this post, select its connected publishing accounts, and save it before requesting approval or publishing.');
}
async function publicReview(db: Executor, row: ProviderRecord | undefined) {
  if (!row) return null;
  const actor = async (id: string) => id ? await first(db.execute(sql`SELECT id,name FROM users WHERE id=${id}`)) || { id, name: 'Former team member' } : null;
  return { id: row.id, status: row.status, requestedBy: await actor(row.requested_by), requestedAt: row.requested_at, reviewedBy: await actor(row.reviewed_by), reviewedAt: row.reviewed_at, note: row.note, selfApproved: Boolean(row.self_approved), snapshot: JSON.parse(row.snapshot) };
}
function fields(body: any, allowed: string[]) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_APPROVAL_FIELDS', 'Use only the fields shown in the approval form.');
}
async function queueItem(context: ApprovalContext, post: ProviderRecord, queue: ProviderRecord | null = null) {
  const snapshot = await postSnapshot(context, post), review = await latest(context.db, context.project.id, post.id);
  const status = submitted(post) && !retryableFailure(post) ? 'submitted' : !review ? 'not_requested' : review.fingerprint === fingerprint(snapshot) ? review.status : 'stale';
  return { post: { id: post.id, status: post.status, providerFailed: retryableFailure(post), sample: Boolean(post.sample), queueId: snapshot.queueId || '', queueVersion: snapshot.queueVersion || '', content: snapshot.content, tags: snapshot.tags, platforms: snapshot.platforms, accounts: snapshot.accounts, mediaItems: snapshot.mediaItems, platformOverrides: snapshot.platformOverrides, ...(snapshot.accountOverrides ? { accountOverrides: snapshot.accountOverrides } : {}), providerVariants: snapshot.providerVariants, assetId: snapshot.assetId, campaignId: snapshot.campaignId, scheduledAt: snapshot.scheduledAt }, queue, assets: snapshot.assets, asset: snapshot.asset, status, review: await publicReview(context.db, review) };
}
async function publishingQueues(context: ApprovalContext) {
  const env = { ...(context.config?.env === undefined ? process.env : context.config.env), ...(context.config || {}) }, profileId = String(context.project.zernioProfileId || '');
  if (!env.ZERNIO_API_KEY || !profileId) fail(409, 'QUEUE_UNAVAILABLE', 'Configure Zernio and this project’s profile before reviewing a queued post.');
  return (await queueList(zernioClient(env.ZERNIO_API_KEY, () => context.assertProjectMapping?.(profileId)), profileId)).queues;
}
function queueSummary(post: ProviderRecord, queues: ProviderRecord[] | undefined, unavailable = false) {
  if (!post.queueId || submitted(post)) return null;
  const queue = queues?.find((row: ProviderRecord) => row._id === post.queueId);
  try { if (unavailable) fail(503, 'QUEUE_UNAVAILABLE', 'The publishing queue could not be verified. Refresh before reviewing this post.'); reviewedQueue(post, queues || []); return { ...queue, ready: true }; }
  catch (error) { return { ...(queue || { _id: post.queueId }), ready: false, message: error instanceof IntegrationError ? error.message : 'The publishing queue could not be verified.' }; }
}

// Council decision ten98-code-system#30: with approval required, a requester may approve their own review only while
// they are the project's single active owner or administrator (by count, not role). Every membership change locks
// the workspace row FOR UPDATE (lockWorkspace), so this FOR SHARE lock holds the count until the decision commits.
async function assertSelfApprovalAllowed(tx: Executor, projectId: string, userId: string) {
  await tx.execute(sql`SELECT w.id FROM workspaces w JOIN projects p ON p.workspace_id=w.id WHERE p.id=${projectId} FOR SHARE OF w`);
  const reviewers = (await tx.execute(sql`SELECT u.id,u.name FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id JOIN users u ON u.id=m.user_id WHERE p.id=${projectId} AND m.role IN ('owner','admin')`)).rows as ProviderRecord[];
  if (reviewers.length === 1 && reviewers[0].id === userId) return;
  const others = reviewers.filter(row => row.id !== userId).map(row => String(row.name)).sort((a, b) => a.localeCompare(b));
  fail(403, 'APPROVAL_SELF_REVIEW', `You requested this review, so another owner or administrator must approve it${others.length ? `: ${others.join(', ')}` : ''}.`);
}
// Council decision ten98-code-system#30 (Q2): with a proposal, a submitted post's review covers the post that
// social/update would send (the provider copy merged with the proposal). The newest proposal supersedes pending reviews.
async function requestProposal(context: ApprovalContext, post: ProviderRecord) {
  const { project, user, db, store, body } = context;
  fields(body, ['proposal']); fields(body.proposal, SOCIAL_UPDATE_FIELDS);
  const proposed = await socialUpdateProposal(context, post, body.proposal), snapshot = await postSnapshot(context, proposed), hash = fingerprint(snapshot);
  if ((await policy(db, project.id)).requireApproval) approvalAccounts(proposed);
  await db.transaction(async (tx: Executor) => {
    await advisoryLock(tx, 'approval:' + JSON.stringify([project.id, post.id]));
    const current = await latest(tx, project.id, post.id), now = new Date().toISOString();
    if (current?.fingerprint === hash && (current.status === 'approved' || current.status === 'pending' && proposalOf(current))) return;
    await tx.execute(sql`UPDATE post_approval_reviews SET status='rejected',reviewed_at=${now},note=${'Superseded by a newer proposed update.'} WHERE project_id=${project.id} AND post_id=${post.id} AND status='pending'`);
    await tx.execute(sql`INSERT INTO post_approval_reviews (id,project_id,post_id,fingerprint,snapshot,status,requested_by,requested_at) VALUES (${randomUUID()}, ${project.id}, ${post.id}, ${hash}, ${JSON.stringify({ ...snapshot, proposal: body.proposal })}, 'pending', ${user.id}, ${now})`);
    await store.activity(project.id, `Review of a proposed provider update requested by ${user.name || user.id}.`);
  });
  return queueItem(context, post);
}
async function assertApprovedReview(context: ApprovalContext, post: ProviderRecord, snapshot: ProviderRecord) {
  approvalAccounts(post);
  assetApproved(snapshot);
  const review = await latest(context.db, context.project.id, post.id);
  if (!review || review.status !== 'approved') fail(403, 'PUBLISHING_APPROVAL_REQUIRED', 'An owner or administrator must approve this post before it can be sent to a provider.');
  if (review.fingerprint !== fingerprint(snapshot)) fail(409, 'PUBLISHING_APPROVAL_STALE', 'This post or its creative changed after approval. Request a new review before publishing.');
}

export async function assertPublishingApproval(context: ApprovalContext, post: ProviderRecord) {
  const current = await context.store.get(context.project.id, 'posts', post?.id);
  if (!current || post.sample || current.sample) fail(409, 'APPROVAL_POST_NOT_FOUND', 'Use a real post from this project before publishing.');
  const snapshot = await postSnapshot(context, current), currentFingerprint = fingerprint(snapshot);
  if (fingerprint(await postSnapshot(context, post)) !== currentFingerprint) fail(409, 'APPROVAL_POST_CHANGED', 'The post or creative changed while publishing was being prepared. Refresh it before publishing.');
  if (!(await policy(context.db, context.project.id)).requireApproval) return;
  await assertApprovedReview(context, current, snapshot);
}

// A provider update replaces a submitted post's content, so the approval must match the proposed post (the current
// post merged with the update), not the stored one (#30).
export async function assertProposedPostApproval(context: ApprovalContext, proposed: ProviderRecord) {
  if (!(await policy(context.db, context.project.id)).requireApproval) return;
  await assertApprovedReview(context, proposed, await postSnapshot(context, proposed));
}

export async function assertProviderPostEdit(context: ApprovalContext) {
  if ((await policy(context.db, context.project.id)).requireApproval && !administrators.has(context.role)) fail(403, 'APPROVED_PROVIDER_EDIT_RESTRICTED', 'An owner or administrator must make changes to submitted posts while publishing approval is required.');
}

export async function handleApprovals(context: ApprovalContext) {
  const { req, url, project, role, user, db, store, body = {}, send } = context;
  const prefix = `/api/projects/${project.id}/approvals/`; if (!url.pathname.startsWith(prefix)) return false;
  const path = url.pathname.slice(prefix.length);
  try {
    if (req.method === 'GET' && path === 'policy') { send(200, await policy(db, project.id)); return true; }
    if (req.method === 'POST' && path === 'policy') {
      if (!administrators.has(role)) fail(403, 'APPROVAL_ADMIN_REQUIRED', 'Only an owner or administrator can change the publishing approval policy.');
      fields(body, ['requireApproval']); if (typeof body.requireApproval !== 'boolean') fail(400, 'INVALID_APPROVAL_POLICY', 'Publishing approval must be enabled or disabled.');
      await db.execute(sql`INSERT INTO project_approval_policy VALUES (${project.id}, ${body.requireApproval}, ${user.id}, ${new Date().toISOString()}) ON CONFLICT (project_id) DO UPDATE SET require_approval=excluded.require_approval,updated_by=excluded.updated_by,updated_at=excluded.updated_at`);
      await store.activity(project.id, `Publishing approval ${body.requireApproval ? 'required' : 'made optional'} by ${user.name || user.id}.`); send(200, await policy(db, project.id)); return true;
    }
    if (req.method === 'GET' && path === 'posts') {
      const posts = await store.list(project.id, 'posts'); let queues: ProviderRecord[] | undefined, unavailable = false;
      if (posts.some((post: ProviderRecord) => post.queueId && !submitted(post))) {
        try { queues = await publishingQueues(context); } catch { unavailable = true; }
        await context.assertIntegrationSettings?.(); if (project.zernioProfileId) await context.assertProjectMapping?.(String(project.zernioProfileId));
      }
      send(200, { ...await policy(db, project.id), posts: await Promise.all(posts.map((post: ProviderRecord) => queueItem(context, post, queueSummary(post, queues, unavailable)))) }); return true;
    }
    const match = path.match(/^posts\/([^/]+)\/(request|review)$/);
    if (!match || req.method !== 'POST') fail(404, 'APPROVAL_ACTION_NOT_FOUND', 'This approval action was not found.');
    if (!['owner', 'admin', 'editor'].includes(role)) fail(403, 'APPROVAL_WRITE_REQUIRED', 'Editing permission is required to request content review.');
    // A provider copy takes a proposal request, and a review of its pending proposal; every other case stays local.
    const stored = await store.get(project.id, 'posts', match[1]), storedReview = stored ? await latest(db, project.id, stored.id) : undefined;
    const proposing = Boolean(stored?.externalId && !stored.sample) && (match[2] === 'request' ? Boolean(body && typeof body === 'object' && Object.hasOwn(body, 'proposal')) : proposalOf(storedReview));
    if (proposing && match[2] === 'request') { send(200, { item: await requestProposal(context, stored) }); return true; }
    const post = proposing ? stored : await localPost(context, match[1]), review = proposing ? storedReview : await latest(db, project.id, post.id);
    const snapshot = proposing ? JSON.parse(review!.snapshot) : await postSnapshot(context, post), hash = proposing ? review!.fingerprint : fingerprint(snapshot);
    if (match[2] === 'request') {
      fields(body, []);
      if ((await policy(db, project.id)).requireApproval) approvalAccounts(post);
      const queue = post.queueId ? reviewedQueue(post, await publishingQueues(context)) : null;
      // The per-post lock serialises review requests, so parallel requests cannot open duplicate pending reviews.
      await db.transaction(async (tx: Executor) => {
        await advisoryLock(tx, 'approval:' + JSON.stringify([project.id, post.id]));
        const currentReview = await latest(tx, project.id, post.id);
        // A review that changed for this same content (for example a parallel request just opened it) is the answer;
        // a review of other content, or a changed post, means the request is stale.
        const sameContent = currentReview?.fingerprint === hash && currentReview?.status !== 'rejected';
        if (fingerprint(await postSnapshot(context, await localPost(context, post.id))) !== hash || ((currentReview?.id !== review?.id || currentReview?.status !== review?.status) && !sameContent)) fail(409, 'APPROVAL_REVIEW_CHANGED', 'The post or review changed while its queue was being verified. Refresh before requesting review.');
        if ((await policy(tx, project.id)).requireApproval) approvalAccounts(post);
        if (!currentReview || currentReview.fingerprint !== hash || currentReview.status === 'rejected') {
          await tx.execute(sql`INSERT INTO post_approval_reviews (id,project_id,post_id,fingerprint,snapshot,status,requested_by,requested_at) VALUES (${randomUUID()}, ${project.id}, ${post.id}, ${hash}, ${JSON.stringify(snapshot)}, 'pending', ${user.id}, ${new Date().toISOString()})`);
          await store.activity(project.id, `Content review requested by ${user.name || user.id}.`);
        }
      });
      send(200, { item: await queueItem(context, post, queue ? { ...queue, ready: true } : null) }); return true;
    }
    if (!administrators.has(role)) fail(403, 'APPROVAL_ADMIN_REQUIRED', 'Only an owner or administrator can approve or reject a post.');
    fields(body, ['decision', 'note', 'reviewId']);
    const note = body.note === undefined ? '' : body.note;
    if (!['approved', 'rejected'].includes(body.decision) || typeof note !== 'string' || note.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note) || typeof body.reviewId !== 'string') fail(400, 'INVALID_APPROVAL_REVIEW', 'Choose approve or reject and use a review note of at most 2,000 characters.');
    if (!review || review.id !== body.reviewId || review.status !== 'pending' || review.fingerprint !== hash) fail(409, 'APPROVAL_REVIEW_CHANGED', 'This review request changed or its post was edited. Refresh the queue before reviewing it.');
    let queue = null;
    if (body.decision === 'approved' && proposing) {
      if ((await policy(db, project.id)).requireApproval) approvalAccounts(snapshot);
      assetApproved(snapshot);
    } else if (body.decision === 'approved') {
      if ((await policy(db, project.id)).requireApproval) approvalAccounts(post);
      if (post.queueId) queue = reviewedQueue(post, await publishingQueues(context));
      const currentReview = await latest(db, project.id, post.id);
      if (fingerprint(await postSnapshot(context, await localPost(context, post.id))) !== hash || currentReview?.id !== review.id || currentReview?.status !== 'pending') fail(409, 'APPROVAL_REVIEW_CHANGED', 'The post or review changed while its queue was being verified. Refresh before approving it.');
      if ((await policy(db, project.id)).requireApproval) approvalAccounts(post);
      assetApproved(snapshot);
    }
    // The per-post lock serialises decisions with requests; only a still-pending review takes a decision, so a
    // parallel approve and reject cannot both apply.
    const selfApproved = await db.transaction(async (tx: Executor) => {
      await advisoryLock(tx, 'approval:' + JSON.stringify([project.id, post.id]));
      const self = body.decision === 'approved' && review.requested_by === user.id && (await policy(tx, project.id)).requireApproval;
      if (self) await assertSelfApprovalAllowed(tx, project.id, user.id);
      const decided = await tx.execute(sql`UPDATE post_approval_reviews SET status=${body.decision},reviewed_by=${user.id},reviewed_at=${new Date().toISOString()},note=${note.trim()},self_approved=${self} WHERE id=${review.id} AND status='pending'`);
      if (!decided.rowCount) fail(409, 'APPROVAL_REVIEW_CHANGED', 'This review request changed or its post was edited. Refresh the queue before reviewing it.');
      return self;
    });
    await store.activity(project.id, selfApproved ? `Content self-approved by ${user.name || user.id} (only administrator).` : `Content ${body.decision} by ${user.name || user.id}.`); send(200, { item: await queueItem(context, post, queue ? { ...queue, ready: true } : queueSummary(post, [], true)) }); return true;
  } catch (error) {
    send(error instanceof IntegrationError ? error.status : 500, { error: { code: error instanceof IntegrationError ? error.code : 'APPROVAL_ERROR', message: error instanceof IntegrationError ? error.message : 'The content approval action could not be completed.' } }); return true;
  }
}
