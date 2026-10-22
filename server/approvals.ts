import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { advisoryLock } from './auth.ts';
import { createStore, type Executor } from './database.ts';
import { fail, IntegrationError, postRestrictions, targetConfiguration, zernioClient, type OperationContext, type ProviderRecord } from './provider-core.ts';
import { buildPlatformEntry, normalizeAccountVariants, normalizePostTags, resolveVariant } from '../shared/social-posts.ts';
import { queueList, reviewedQueue } from './zernio-queues.ts';
import { PROPOSAL_FIELDS, providerUpdateProposal } from './integrations.ts';

type ApprovalContext = Omit<OperationContext, 'project' | 'body'> & { project: ProviderRecord; body?: any };
const administrators = new Set(['owner', 'admin']);
const first = async (query: Promise<{ rows: unknown[] }>) => (await query).rows[0] as ProviderRecord | undefined;
// Inside a transaction every read and write goes through it, never a second pool connection.
const within = (context: ApprovalContext, tx: Executor): ApprovalContext => ({ ...context, db: tx, store: createStore(tx) });
async function policy(db: Executor, projectId: string) {
  const row = await first(db.execute(sql`SELECT require_approval AS "requireApproval",require_ad_approval AS "requireAdApproval",updated_by AS "updatedBy",updated_at AS "updatedAt" FROM project_approval_policy WHERE project_id=${projectId}`));
  return row ? { ...row, requireApproval: Boolean(row.requireApproval), requireAdApproval: Boolean(row.requireAdApproval) } : { requireApproval: false, requireAdApproval: false, updatedBy: null, updatedAt: null };
}
// `loaded` serves a caller that already read the project's assets, so many snapshots cost no further queries.
async function assetRecords(context: ApprovalContext, post: ProviderRecord, loaded?: Map<string, ProviderRecord>) {
  const ids = [...new Set([post.assetId, ...Object.values(post.platformOverrides || {}).map((item: any) => item?.assetId), ...Object.values(normalizeAccountVariants(post)).map(item => item?.assetId)].filter(Boolean))];
  return { ids, records: await Promise.all(ids.map(id => loaded ? loaded.get(id) ?? null : context.store.get(context.project.id, 'assets', id))) };
}
async function postSnapshot(context: ApprovalContext, post: ProviderRecord, loaded?: Map<string, ProviderRecord>) {
  const accountOverrides = normalizeAccountVariants(post), { ids, records } = await assetRecords(context, post, loaded);
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
  // `publishedEdit` (a proposed edit of a published copy) is added only when present, so other posts keep their fingerprints.
  return { tags: normalizePostTags(post.tags, { preserve: true }), ...(post.queueId ? { queueId: post.queueId, queueVersion: post.queueVersion } : {}), ...(Object.keys(accountVariants).length ? { accountOverrides: accountVariants } : {}), content: post.content || '', platforms: post.platforms || [], accounts: post.accounts || [], mediaItems, platformOverrides: variants, providerVariants, assetId: post.assetId || '', campaignId: post.campaignId || '', scheduledAt: post.scheduledAt || post.scheduledFor || '', assets, asset: assets.find(asset => asset.id === post.assetId) || null, ...(post.publishedEdit ? { publishedEdit: post.publishedEdit } : {}) };
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
// The local per-platform restriction check publishing runs, so a post that would fail to publish cannot be approved.
// Only customised accounts carry their platform locally, so they are checked per account and the base variant on platforms
// without one; publishing's own check covers an uncustomised account on a customised platform. A retry checks only its failed copies.
function assertPlatformRules(post: ProviderRecord, assets: ProviderRecord[], failed?: ProviderRecord[]) {
  let overrides: ProviderRecord = {}; try { overrides = normalizeAccountVariants(post); } catch { /* reported by the restriction check below */ }
  const targets = Object.entries(overrides).map(([_id, copy]) => ({ _id, platform: copy.platform })), base = (post.platforms || []).filter((platform: string) => !targets.some(target => target.platform === platform));
  // Media in a failed copy was already delivered, so its hosted-file expiry is checked by the retry against the provider copy.
  const owned = new Set<string>(failed ? assets.map(asset => asset.deliveryUrl) : []);
  let errors: ProviderRecord[];
  try { errors = failed ? postRestrictions(post, [...new Set<string>(failed.map(copy => copy.platform))], assets, failed, owned).errors : [...(base.length || !targets.length ? postRestrictions(post, base, assets).errors : []), ...(targets.length ? postRestrictions(post, [], assets, targets).errors : [])]; }
  catch (error) { if (error instanceof IntegrationError) errors = [{ platform: '', field: 'mediaItems', message: error.message }]; else throw error; }
  // `details` lists each failed rule (platform, field, message and, for a customised account, accountId) for the form.
  if (errors.length) throw Object.assign(new IntegrationError(422, 'APPROVAL_POST_RESTRICTIONS', errors.map(item => item.platform ? `${item.platform}: ${item.message}` : item.message).join(' ').slice(0, 4000)), { details: errors.slice(0, 100).map(({ platform, field, message, accountId }) => ({ platform, field, message, ...(accountId ? { accountId } : {}) })) });
}
const errorBody = (error: unknown) => error instanceof IntegrationError ? { code: error.code, message: error.message, ...((error as ProviderRecord).details ? { details: (error as ProviderRecord).details } : {}) } : { code: 'APPROVAL_ERROR', message: 'The content approval action could not be completed.' };
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
// A post's review state as the queue shows it; only 'approved' passes assertPublishingApproval's review check.
const approvalStatus = (post: ProviderRecord, review: ProviderRecord | undefined, snapshot: ProviderRecord) => submitted(post) && !retryableFailure(post) ? 'submitted' : !review ? 'not_requested' : review.fingerprint === fingerprint(snapshot) ? review.status : 'stale';
async function queueItem(context: ApprovalContext, post: ProviderRecord, queue: ProviderRecord | null = null) {
  const snapshot = await postSnapshot(context, post), review = await latest(context.db, context.project.id, post.id);
  const status = approvalStatus(post, review, snapshot);
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

// Every membership change locks the workspace row FOR UPDATE (lockWorkspace), so this FOR SHARE lock holds the
// reviewer's role and the administrator count until the decision commits. It is taken before the advisory
// approval lock, keeping the order workspaces → advisory.
const shareWorkspace = (tx: Executor, projectId: string) => tx.execute(sql`SELECT w.id FROM workspaces w JOIN projects p ON p.workspace_id=w.id WHERE p.id=${projectId} FOR SHARE OF w`);
const memberRole = async (tx: Executor, projectId: string, userId: string) => String((await first(tx.execute(sql`SELECT m.role FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id WHERE p.id=${projectId} AND m.user_id=${userId}`)))?.role);
async function lockReviewer(tx: Executor, projectId: string, userId: string) {
  await shareWorkspace(tx, projectId);
  if (!administrators.has(await memberRole(tx, projectId, userId))) fail(403, 'APPROVAL_ADMIN_REQUIRED', 'Only an owner or administrator can approve or reject a post.');
}
// Council decision ten98-code-system#30: with approval required, a requester may approve their own review only while
// they are the project's single active owner or administrator (by count, not role). Runs under lockReviewer.
async function assertSelfApprovalAllowed(tx: Executor, projectId: string, userId: string) {
  const reviewers = (await tx.execute(sql`SELECT u.id,u.name FROM projects p JOIN memberships m ON m.workspace_id=p.workspace_id JOIN users u ON u.id=m.user_id WHERE p.id=${projectId} AND m.role IN ('owner','admin')`)).rows as ProviderRecord[];
  if (reviewers.length === 1 && reviewers[0].id === userId) return;
  const others = reviewers.filter(row => row.id !== userId).map(row => String(row.name)).sort((a, b) => a.localeCompare(b));
  fail(403, 'APPROVAL_SELF_REVIEW', `You requested this review, so another owner or administrator must approve it${others.length ? `: ${others.join(', ')}` : ''}.`);
}
// Council decision ten98-code-system#30 (Q2): with a proposal, a submitted post's review covers the post that the
// provider update would leave (the provider copy merged with the proposal). `action` names the update: social/update
// (the default), or social/edit-published or social/update-metadata for a published copy. The newest proposal
// supersedes pending reviews.
async function requestProposal(context: ApprovalContext, post: ProviderRecord) {
  const { project, user, db, body } = context;
  fields(body, ['proposal', 'action']);
  const action = body.action ?? 'social/update';
  if (typeof action !== 'string' || !Object.hasOwn(PROPOSAL_FIELDS, action)) fail(400, 'INVALID_APPROVAL_FIELDS', 'Use only the fields shown in the approval form.');
  fields(body.proposal, PROPOSAL_FIELDS[action]);
  const proposed = await providerUpdateProposal(context, post, action, body.proposal), snapshot = await postSnapshot(context, proposed), hash = fingerprint(snapshot);
  if ((await policy(db, project.id)).requireApproval) approvalAccounts(proposed);
  await db.transaction(async (tx: Executor) => {
    await advisoryLock(tx, 'approval:' + JSON.stringify([project.id, post.id]));
    const current = await latest(tx, project.id, post.id), now = new Date().toISOString();
    if (current?.fingerprint === hash && (current.status === 'approved' || current.status === 'pending' && proposalOf(current))) return;
    await tx.execute(sql`UPDATE post_approval_reviews SET status='rejected',reviewed_at=${now},note=${'Superseded by a newer proposed update.'} WHERE project_id=${project.id} AND post_id=${post.id} AND status='pending'`);
    await tx.execute(sql`INSERT INTO post_approval_reviews (id,project_id,post_id,fingerprint,snapshot,status,requested_by,requested_at) VALUES (${randomUUID()}, ${project.id}, ${post.id}, ${hash}, ${JSON.stringify({ ...snapshot, proposal: body.proposal })}, 'pending', ${user.id}, ${now})`);
    await createStore(tx).activity(project.id, `Review of a proposed provider update requested by ${user.name || user.id}.`);
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

// A provider copy takes a proposal request, and a review of its pending proposal; every other case stays local.
async function reviewTarget(context: ApprovalContext, id: string, requesting: boolean) {
  const { project, db, store, body } = context;
  const stored = await store.get(project.id, 'posts', id), storedReview = stored ? await latest(db, project.id, stored.id) : undefined;
  const proposing = Boolean(stored?.externalId && !stored.sample) && (requesting ? Boolean(body && typeof body === 'object' && Object.hasOwn(body, 'proposal')) : proposalOf(storedReview));
  if (proposing && requesting) return { stored, proposing } as ProviderRecord;
  const post = proposing ? stored : await localPost(context, id), review = proposing ? storedReview : await latest(db, project.id, post.id);
  const snapshot = proposing ? JSON.parse(review!.snapshot) : await postSnapshot(context, post), hash = proposing ? review!.fingerprint : fingerprint(snapshot);
  return { stored, proposing, post, review, snapshot, hash } as ProviderRecord;
}
function reviewInput(body: any) {
  fields(body, ['decision', 'note', 'reviewId']);
  const note = body.note === undefined ? '' : body.note;
  if (!['approved', 'rejected'].includes(body.decision) || typeof note !== 'string' || note.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(note) || typeof body.reviewId !== 'string') fail(400, 'INVALID_APPROVAL_REVIEW', 'Choose approve or reject and use a review note of at most 2,000 characters.');
  return note;
}
// Records one decision on a pending review of `subject` (a post id, or an ad spend subject key). The reviewer's role
// is re-checked under the workspace lock. The per-subject lock serialises decisions with requests (and ad spend
// approvals with their use); only a still-pending review takes a decision, so a parallel approve and reject cannot both
// apply. `setting` names the policy flag under which the self-review rule applies. Returns whether the decision was a
// self-approval, or null when a repeatable item finds a parallel decision the same way already recorded.
async function recordDecision(context: ApprovalContext, subject: string, review: ProviderRecord, decision: string, note: string, setting: 'requireApproval' | 'requireAdApproval', repeatable = false) {
  const { project, user, db } = context;
  return db.transaction(async (tx: Executor) => {
    await lockReviewer(tx, project.id, user.id);
    await advisoryLock(tx, 'approval:' + JSON.stringify([project.id, subject]));
    const self = decision === 'approved' && review.requested_by === user.id && (await policy(tx, project.id))[setting];
    if (self) await assertSelfApprovalAllowed(tx, project.id, user.id);
    const decided = await tx.execute(sql`UPDATE post_approval_reviews SET status=${decision},reviewed_by=${user.id},reviewed_at=${new Date().toISOString()},note=${note.trim()},self_approved=${self} WHERE id=${review.id} AND status='pending'`);
    if (!decided.rowCount) {
      // A parallel decision the same way already holds; a repeatable item reports it instead of failing.
      if (repeatable && (await first(tx.execute(sql`SELECT status FROM post_approval_reviews WHERE id=${review.id}`)))?.status === decision) return null;
      fail(409, 'APPROVAL_REVIEW_CHANGED', 'This review request changed or its post was edited. Refresh the queue before reviewing it.');
    }
    return self;
  });
}
// One review decision; the single and bulk routes both run it. A repeatable (bulk) item already decided the same way
// returns its current state without a second decision or activity entry.
async function decide(context: ApprovalContext, { post, review, snapshot, hash, proposing }: ProviderRecord, body: any, repeatable = false) {
  const { project, role, user, db, store } = context;
  if (!administrators.has(role)) fail(403, 'APPROVAL_ADMIN_REQUIRED', 'Only an owner or administrator can approve or reject a post.');
  const note = reviewInput(body);
  if (repeatable && (await first(db.execute(sql`SELECT status FROM post_approval_reviews WHERE id=${body.reviewId} AND project_id=${project.id} AND post_id=${post.id}`)))?.status === body.decision) return { status: 'unchanged', item: await queueItem(context, post, queueSummary(post, [], true)) };
  if (!review || review.id !== body.reviewId || review.status !== 'pending' || review.fingerprint !== hash) fail(409, 'APPROVAL_REVIEW_CHANGED', 'This review request changed or its post was edited. Refresh the queue before reviewing it.');
  let queue = null;
  if (body.decision === 'approved' && proposing) {
    if ((await policy(db, project.id)).requireApproval) approvalAccounts(snapshot);
    assetApproved(snapshot);
    // The proposal snapshot is the post the provider update would send, with every variant already resolved.
    assertPlatformRules(snapshot, []);
  } else if (body.decision === 'approved') {
    if ((await policy(db, project.id)).requireApproval) approvalAccounts(post);
    if (post.queueId) queue = reviewedQueue(post, await publishingQueues(context));
    const currentReview = await latest(db, project.id, post.id);
    if (fingerprint(await postSnapshot(context, await localPost(context, post.id))) !== hash || currentReview?.id !== review.id || currentReview?.status !== 'pending') fail(409, 'APPROVAL_REVIEW_CHANGED', 'The post or review changed while its queue was being verified. Refresh before approving it.');
    if ((await policy(db, project.id)).requireApproval) approvalAccounts(post);
    assetApproved(snapshot);
    const failed = retryableFailure(post) ? post.providerResults.filter((copy: ProviderRecord) => copy.status === 'failed' && copy.platform) : [];
    assertPlatformRules(post, (await assetRecords(context, post)).records.filter(Boolean), failed.length ? failed : undefined);
  }
  const selfApproved = await recordDecision(context, post.id, review, body.decision, note, 'requireApproval', repeatable);
  if (selfApproved === null) return { status: 'unchanged', item: await queueItem(context, post, queueSummary(post, [], true)) };
  await store.activity(project.id, selfApproved ? `Content self-approved by ${user.name || user.id} (only administrator).` : `Content ${body.decision} by ${user.name || user.id}.`); return { status: 'decided', item: await queueItem(context, post, queue ? { ...queue, ready: true } : queueSummary(post, [], true)) };
}

// Ad spend approval (council decision ten98-code-system#35, Q1). With require_ad_approval on, a provider write that
// starts spend (an activation) or raises a budget needs an approved review of exactly that change: subject id,
// platform, action, amount in minor units and currency. Pauses, ends and budget decreases never need one. The
// `-status` actions activate; the `-budget` actions raise a budget.
const AD_SPEND_ACTIONS = ['ads/status', 'ads/ad-status', 'ads/adset-status', 'ads/adset-budget', 'ads/campaign-budget', 'google-native/campaign-status', 'google-native/campaign-budget', 'microsoft/campaign-status', 'microsoft/campaign-budget', 'ooh/booking'];
type AdSpendChange = { subjectId: string; platform: string; action: string; amount: number; currency: string };
// What a gated route read: `amount` is the budget (major units) that spends once the write applies, and
// `currentAmount` the budget configured now (null when the route could not read it).
type AdSpendAttempt = { subjectId: string; platform: string; action: string; amount: unknown; currency: unknown; currentAmount: unknown; activates: boolean };
// Exact minor units for the currency's decimal places, or null when the amount is not exactly representable.
function minorUnits(amount: unknown, currency: unknown) {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency) || typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null;
  const value = amount * 10 ** new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits!, rounded = Math.round(value);
  return Number.isSafeInteger(rounded) && Math.abs(value - rounded) <= 0.000001 ? rounded : null;
}
const adSubject = (change: AdSpendChange) => 'ad-spend:' + JSON.stringify([change.platform, change.subjectId, change.action]);
const adFingerprint = (change: AdSpendChange) => createHash('sha256').update(JSON.stringify([change.subjectId, change.platform, change.action, change.amount, change.currency])).digest('hex');
// An approval is usable until a provider write consumes it; a consuming receipt that failed releases it.
// An approval is unconsumed while unused or released by a failed write; it is usable for AD_APPROVAL_DAYS from its decision
// (a released approval keeps its original clock). Council decision on ten98-code-system#35 Q1 (approval expiry, option d).
const AD_APPROVAL_DAYS = 7;
const unconsumedApproval = sql`r.status='approved' AND (r.consumed_by IS NULL OR EXISTS (SELECT 1 FROM integration_operations o WHERE o.project_id=r.project_id AND o.request_key=r.consumed_by AND o.status='failed'))`;
const usableApproval = sql`${unconsumedApproval} AND r.reviewed_at::timestamptz > now() - ${AD_APPROVAL_DAYS} * interval '1 day'`;
async function adSpendReview(db: Executor, row: ProviderRecord | undefined) {
  if (!row) return null;
  const used = row.consumed_by ? await first(db.execute(sql`SELECT status FROM integration_operations WHERE project_id=${row.project_id} AND request_key=${row.consumed_by}`)) : undefined;
  return { ...await publicReview(db, row), kind: 'ad_spend', consumed: Boolean(row.consumed_by) && used?.status !== 'failed' };
}
// Opens a pending review of `change` (run under its subject's approval lock). An identical pending review is the
// answer; a different pending change of the same subject and action is superseded. `currentAmount` (minor units) is
// what a gated route read, so the reviewer sees the current budget beside the requested one.
async function openAdSpendReview(tx: Executor, project: ProviderRecord, user: ProviderRecord, change: AdSpendChange, currentAmount: number | null) {
  const subject = adSubject(change), hash = adFingerprint(change), now = new Date().toISOString();
  const pending = await first(tx.execute(sql`SELECT * FROM post_approval_reviews WHERE project_id=${project.id} AND kind='ad_spend' AND post_id=${subject} AND status='pending' AND fingerprint=${hash} ORDER BY seq DESC LIMIT 1`));
  if (pending) {
    const snapshot = JSON.parse(pending.snapshot);
    if (snapshot.currentAmount === null && currentAmount !== null) await tx.execute(sql`UPDATE post_approval_reviews SET snapshot=${JSON.stringify({ ...snapshot, currentAmount })} WHERE id=${pending.id}`);
    return pending.id as string;
  }
  await tx.execute(sql`UPDATE post_approval_reviews SET status='rejected',reviewed_at=${now},note=${'Superseded by a newer ad spend request.'} WHERE project_id=${project.id} AND kind='ad_spend' AND post_id=${subject} AND status='pending'`);
  const id = randomUUID(), snapshot = { ...change, currentAmount, activates: change.action.endsWith('status') || change.action === 'ooh/booking' };
  await tx.execute(sql`INSERT INTO post_approval_reviews (id,project_id,post_id,kind,fingerprint,snapshot,status,requested_by,requested_at) VALUES (${id}, ${project.id}, ${subject}, 'ad_spend', ${hash}, ${JSON.stringify(snapshot)}, 'pending', ${user.id}, ${now})`);
  await createStore(tx).activity(project.id, `Ad spend review requested by ${user.name || user.id}.`);
  return id;
}

// The gate each spend-starting or budget-raising route awaits inside its operation(), immediately before the provider
// write. A matching approval is consumed by this receipt (`key`), so one approval allows one provider write. Without
// one, a review of this exact change is opened: 403 when the project holds no usable ad spend approval, 409 when it
// holds approvals for a different change (amount, currency, platform, subject or action).
/** Whether this project requires ad spend approval, for routes that must read extra provider data only when it does. */
export async function adSpendApprovalRequired(context: ApprovalContext) { return (await policy(context.db, context.project.id)).requireAdApproval; }
export async function assertAdSpendApproval(context: ApprovalContext, attempt: AdSpendAttempt, key: string) {
  const { project, user, db } = context;
  if (!attempt.activates && typeof attempt.amount === 'number' && typeof attempt.currentAmount === 'number' && attempt.amount <= attempt.currentAmount) return;
  if (!(await policy(db, project.id)).requireAdApproval) return;
  const amount = minorUnits(attempt.amount, attempt.currency), currentAmount = minorUnits(attempt.currentAmount, attempt.currency);
  if (amount === null) fail(409, 'AD_SPEND_AMOUNT_UNAVAILABLE', 'The budget and currency of this change could not be read exactly, so it cannot be matched to an approval. Make this change in the provider dashboard.');
  const change: AdSpendChange = { subjectId: attempt.subjectId, platform: attempt.platform, action: attempt.action, amount, currency: attempt.currency as string }, hash = adFingerprint(change);
  // Lock order as for decisions: workspace FOR SHARE, then the subject's approval lock, then the role re-check.
  const outcome = await db.transaction(async (tx: Executor) => {
    await shareWorkspace(tx, project.id);
    await advisoryLock(tx, 'approval:' + JSON.stringify([project.id, adSubject(change)]));
    if (!['owner', 'admin', 'editor'].includes(await memberRole(tx, project.id, user.id))) fail(403, 'AD_SPEND_WRITE_REQUIRED', 'Editing permission is required to change ad spend.');
    if (!(await policy(tx, project.id)).requireAdApproval) return 'off';
    const approved = await first(tx.execute(sql`SELECT r.id FROM post_approval_reviews r WHERE r.project_id=${project.id} AND r.kind='ad_spend' AND r.fingerprint=${hash} AND ${usableApproval} ORDER BY r.seq LIMIT 1 FOR UPDATE OF r`));
    if (approved) { await tx.execute(sql`UPDATE post_approval_reviews SET consumed_by=${key},consumed_at=${new Date().toISOString()} WHERE id=${approved.id}`); return 'approved'; }
    const expired = await first(tx.execute(sql`SELECT r.id FROM post_approval_reviews r WHERE r.project_id=${project.id} AND r.kind='ad_spend' AND r.fingerprint=${hash} AND ${unconsumedApproval} LIMIT 1`));
    const other = expired ? undefined : await first(tx.execute(sql`SELECT r.id FROM post_approval_reviews r WHERE r.project_id=${project.id} AND r.kind='ad_spend' AND ${usableApproval} LIMIT 1`));
    await openAdSpendReview(tx, project, user, change, currentAmount);
    return expired ? 'expired' : other ? 'mismatch' : 'missing';
  });
  if (outcome === 'expired') fail(403, 'AD_SPEND_APPROVAL_EXPIRED', `The approval of this spend change is more than ${AD_APPROVAL_DAYS} days old. It needs re-approval; a new review was requested.`);
  if (outcome === 'missing') fail(403, 'AD_SPEND_APPROVAL_REQUIRED', 'An owner or administrator must approve this spend change before it is sent. A review of it was requested.');
  if (outcome === 'mismatch') fail(409, 'AD_SPEND_APPROVAL_MISMATCH', 'This change differs from the approved spend change (amount, currency, platform, campaign or action). A review of this exact change was requested.');
}

function adSpendInput(body: any) {
  fields(body, ['subjectId', 'platform', 'action', 'amount', 'currency']);
  const readable = (value: any, maximum: number) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
  if (!readable(body.subjectId, 200) || typeof body.platform !== 'string' || !/^[a-z]{2,30}$/.test(body.platform) || !AD_SPEND_ACTIONS.includes(body.action) || !Number.isSafeInteger(body.amount) || body.amount <= 0 || typeof body.currency !== 'string' || !/^[A-Z]{3}$/.test(body.currency)) fail(400, 'INVALID_AD_SPEND_REQUEST', 'Choose the campaign, platform and spend action, and enter the amount in minor units with its three-letter currency.');
  return { subjectId: body.subjectId, platform: body.platform, action: body.action, amount: body.amount, currency: body.currency } as AdSpendChange;
}

export async function handleApprovals(context: ApprovalContext) {
  const { req, url, project, role, user, db, store, body = {}, send } = context;
  const prefix = `/api/projects/${project.id}/approvals/`; if (!url.pathname.startsWith(prefix)) return false;
  const path = url.pathname.slice(prefix.length);
  try {
    if (req.method === 'GET' && path === 'policy') { send(200, await policy(db, project.id)); return true; }
    if (req.method === 'POST' && path === 'policy') {
      if (!administrators.has(role)) fail(403, 'APPROVAL_ADMIN_REQUIRED', 'Only an owner or administrator can change the publishing approval policy.');
      // Either setting may be sent alone; the other keeps its stored value (off for a project without a policy row).
      fields(body, ['requireApproval', 'requireAdApproval']);
      const post = Object.hasOwn(body, 'requireApproval'), ads = Object.hasOwn(body, 'requireAdApproval');
      if (!post && !ads || post && typeof body.requireApproval !== 'boolean' || ads && typeof body.requireAdApproval !== 'boolean') fail(400, 'INVALID_APPROVAL_POLICY', 'Publishing approval must be enabled or disabled.');
      // Changing the ad spend setting (either way) voids every unconsumed ad spend approval and pending request in the project,
      // so an approval given under one setting is never used under another (council decision on #35 Q1, approval expiry).
      await db.transaction(async (tx: Executor) => {
        const before = (await policy(tx, project.id)).requireAdApproval;
        await tx.execute(sql`INSERT INTO project_approval_policy (project_id,require_approval,require_ad_approval,updated_by,updated_at) VALUES (${project.id}, ${post ? body.requireApproval : false}, ${ads ? body.requireAdApproval : false}, ${user.id}, ${new Date().toISOString()}) ON CONFLICT (project_id) DO UPDATE SET require_approval=${post ? sql`excluded.require_approval` : sql`project_approval_policy.require_approval`},require_ad_approval=${ads ? sql`excluded.require_ad_approval` : sql`project_approval_policy.require_ad_approval`},updated_by=excluded.updated_by,updated_at=excluded.updated_at`);
        if (ads && before !== body.requireAdApproval) await tx.execute(sql`UPDATE post_approval_reviews r SET status='rejected',reviewed_at=${new Date().toISOString()},note=${'Voided because the ad spend approval setting changed.'} WHERE r.project_id=${project.id} AND r.kind='ad_spend' AND (r.status='pending' OR ${unconsumedApproval})`);
      });
      if (post) await store.activity(project.id, `Publishing approval ${body.requireApproval ? 'required' : 'made optional'} by ${user.name || user.id}.`);
      if (ads) await store.activity(project.id, `Ad spend approval ${body.requireAdApproval ? 'required' : 'made optional'} by ${user.name || user.id}.`);
      send(200, await policy(db, project.id)); return true;
    }
    if (req.method === 'GET' && path === 'ad-spend') {
      const rows = (await db.execute(sql`SELECT * FROM post_approval_reviews WHERE project_id=${project.id} AND kind='ad_spend' ORDER BY seq DESC LIMIT 100`)).rows as ProviderRecord[];
      send(200, { requireAdApproval: (await policy(db, project.id)).requireAdApproval, reviews: await Promise.all(rows.map(row => adSpendReview(db, row))) }); return true;
    }
    if (req.method === 'POST' && path === 'ad-spend/request') {
      if (!['owner', 'admin', 'editor'].includes(role)) fail(403, 'APPROVAL_WRITE_REQUIRED', 'Editing permission is required to request an ad spend review.');
      const change = adSpendInput(body);
      const id = await db.transaction(async (tx: Executor) => {
        await advisoryLock(tx, 'approval:' + JSON.stringify([project.id, adSubject(change)]));
        return openAdSpendReview(tx, project, user, change, null);
      });
      send(200, { review: await adSpendReview(db, await first(db.execute(sql`SELECT * FROM post_approval_reviews WHERE id=${id}`))) }); return true;
    }
    if (req.method === 'POST' && path === 'ad-spend/review') {
      if (!administrators.has(role)) fail(403, 'APPROVAL_ADMIN_REQUIRED', 'Only an owner or administrator can approve or reject ad spend.');
      const note = reviewInput(body);
      const review = await first(db.execute(sql`SELECT * FROM post_approval_reviews WHERE id=${body.reviewId} AND project_id=${project.id} AND kind='ad_spend'`));
      if (!review) fail(404, 'APPROVAL_REVIEW_NOT_FOUND', 'This ad spend review was not found in the current project.');
      if (review!.status !== 'pending') fail(409, 'APPROVAL_REVIEW_CHANGED', 'This review was already decided or superseded. Refresh before reviewing it.');
      const self = await recordDecision(context, review!.post_id, review!, body.decision, note, 'requireAdApproval');
      await store.activity(project.id, self ? `Ad spend self-approved by ${user.name || user.id} (only administrator).` : `Ad spend ${body.decision} by ${user.name || user.id}.`);
      send(200, { review: await adSpendReview(db, await first(db.execute(sql`SELECT * FROM post_approval_reviews WHERE id=${review!.id}`))) }); return true;
    }
    if (req.method === 'GET' && path === 'posts') {
      const posts = await store.list(project.id, 'posts'); let queues: ProviderRecord[] | undefined, unavailable = false;
      if (posts.some((post: ProviderRecord) => post.queueId && !submitted(post))) {
        try { queues = await publishingQueues(context); } catch { unavailable = true; }
        await context.assertIntegrationSettings?.(); if (project.zernioProfileId) await context.assertProjectMapping?.(String(project.zernioProfileId));
      }
      send(200, { ...await policy(db, project.id), posts: await Promise.all(posts.map((post: ProviderRecord) => queueItem(context, post, queueSummary(post, queues, unavailable)))) }); return true;
    }
    // Badge and Publish gating: each post's queue status, read in a fixed number of queries and without provider calls.
    if (req.method === 'GET' && path === 'summary') {
      const [posts, assets, reviews, current] = await Promise.all([store.list(project.id, 'posts'), store.list(project.id, 'assets'), db.execute(sql`SELECT DISTINCT ON (post_id) * FROM post_approval_reviews WHERE project_id=${project.id} ORDER BY post_id, seq DESC`), policy(db, project.id)]);
      const loaded = new Map<string, ProviderRecord>(assets.map((asset: ProviderRecord) => [asset.id, asset])), latestReview = new Map((reviews.rows as ProviderRecord[]).map(row => [row.post_id, row]));
      const statuses = Object.fromEntries(await Promise.all(posts.map(async (post: ProviderRecord) => [post.id, approvalStatus(post, latestReview.get(post.id), await postSnapshot(context, post, loaded))])));
      // The latest-review read also holds each ad spend subject's latest review; only that one can be pending.
      const pendingAdSpend = (reviews.rows as ProviderRecord[]).filter(row => row.kind === 'ad_spend' && row.status === 'pending').length;
      send(200, { requireApproval: current.requireApproval, pending: Object.values(statuses).filter(status => status === 'pending').length, statuses, pendingAdSpend }); return true;
    }
    // Each item is its own decision through the single-review path, so one failure leaves the others decided.
    if (req.method === 'POST' && path === 'bulk') {
      if (!administrators.has(role)) fail(403, 'APPROVAL_ADMIN_REQUIRED', 'Only an owner or administrator can approve or reject a post.');
      fields(body, ['decision', 'note', 'items']);
      if (!Array.isArray(body.items) || !body.items.length || body.items.length > 50 || body.items.some((item: any) => !item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['postId', 'reviewId'].includes(key)) || typeof item.postId !== 'string' || !item.postId || item.postId.length > 200 || typeof item.reviewId !== 'string' || !item.reviewId || item.reviewId.length > 200)) fail(400, 'INVALID_APPROVAL_BULK', 'Choose between 1 and 50 reviews, each with its post and review.');
      const input = (reviewId: string) => ({ decision: body.decision, ...(body.note === undefined ? {} : { note: body.note }), reviewId });
      reviewInput(input(''));
      const results: ProviderRecord[] = [];
      for (const { postId, reviewId } of body.items) {
        try { const { status, item } = await decide(context, await reviewTarget(context, postId, false), input(reviewId), true); results.push({ postId, reviewId, status, item }); }
        catch (error) { results.push({ postId, reviewId, status: 'failed', error: errorBody(error) }); }
      }
      send(200, { results }); return true;
    }
    const match = path.match(/^posts\/([^/]+)\/(request|review)$/);
    if (!match || req.method !== 'POST') fail(404, 'APPROVAL_ACTION_NOT_FOUND', 'This approval action was not found.');
    if (!['owner', 'admin', 'editor'].includes(role)) fail(403, 'APPROVAL_WRITE_REQUIRED', 'Editing permission is required to request content review.');
    const target = await reviewTarget(context, match[1], match[2] === 'request');
    if (target.proposing && match[2] === 'request') { send(200, { item: await requestProposal(context, target.stored) }); return true; }
    if (match[2] === 'review') { send(200, { item: (await decide(context, target, body)).item }); return true; }
    const { post, review, snapshot, hash } = target;
    if (match[2] === 'request') {
      fields(body, []);
      if ((await policy(db, project.id)).requireApproval) approvalAccounts(post);
      const queue = post.queueId ? reviewedQueue(post, await publishingQueues(context)) : null;
      // The per-post lock serialises review requests, so parallel requests cannot open duplicate pending reviews.
      await db.transaction(async (tx: Executor) => {
        await advisoryLock(tx, 'approval:' + JSON.stringify([project.id, post.id]));
        const local = within(context, tx), currentReview = await latest(tx, project.id, post.id);
        // A review that changed for this same content (for example a parallel request just opened it) is the answer;
        // a review of other content, or a changed post, means the request is stale.
        const sameContent = currentReview?.fingerprint === hash && currentReview?.status !== 'rejected';
        if (fingerprint(await postSnapshot(local, await localPost(local, post.id))) !== hash || ((currentReview?.id !== review?.id || currentReview?.status !== review?.status) && !sameContent)) fail(409, 'APPROVAL_REVIEW_CHANGED', 'The post or review changed while its queue was being verified. Refresh before requesting review.');
        if ((await policy(tx, project.id)).requireApproval) approvalAccounts(post);
        if (!currentReview || currentReview.fingerprint !== hash || currentReview.status === 'rejected') {
          await tx.execute(sql`INSERT INTO post_approval_reviews (id,project_id,post_id,fingerprint,snapshot,status,requested_by,requested_at) VALUES (${randomUUID()}, ${project.id}, ${post.id}, ${hash}, ${JSON.stringify(snapshot)}, 'pending', ${user.id}, ${new Date().toISOString()})`);
          await local.store.activity(project.id, `Content review requested by ${user.name || user.id}.`);
        }
      });
      send(200, { item: await queueItem(context, post, queue ? { ...queue, ready: true } : null) }); return true;
    }
  } catch (error) {
    send(error instanceof IntegrationError ? error.status : 500, { error: errorBody(error) }); return true;
  }
}
