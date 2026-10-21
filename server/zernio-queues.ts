import type { OperationContext, ZernioApi } from './provider-core.ts';
import { createHash } from 'node:crypto';
import { fail, reportObject as object, IntegrationError, operation, validProviderInstant } from './provider-core.ts';

const validId = (value: any) => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\s\u0000-\u001f\u007f]/.test(value);
const id = (value: any) => { if (!validId(value)) fail(400, 'INVALID_QUEUE', 'Choose a valid publishing queue.'); return value; };
const timezone = (value: any) => { try { return typeof value === 'string' && value.length <= 100 && Boolean(new Intl.DateTimeFormat('en', { timeZone: value })); } catch { return false; } };
const invalid = () => fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return a complete publishing queue response.');
const fields = (body: any, allowed: any) => { if (!object(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_QUEUE_FIELDS', 'Use only the queue controls shown in this form.'); };
const digest = (value: any) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function slots(value: any, status = 400) {
  if (!Array.isArray(value) || value.length > 1000 || value.some(row => !object(row) || Object.keys(row).some(key => !['dayOfWeek', 'time'].includes(key)) || !Number.isInteger(row.dayOfWeek) || row.dayOfWeek < 0 || row.dayOfWeek > 6 || typeof row.time !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(row.time))) fail(status, 'INVALID_QUEUE_SLOTS', 'Use distinct days and 24-hour times for the weekly queue slots.');
  const result = value.map(row => ({ dayOfWeek: row.dayOfWeek, time: row.time })).sort((a, b) => a.dayOfWeek - b.dayOfWeek || a.time.localeCompare(b.time));
  if (new Set(result.map(row => `${row.dayOfWeek}:${row.time}`)).size !== result.length) fail(status, 'INVALID_QUEUE_SLOTS', 'A queue cannot contain the same day and time twice.');
  return result;
}
function schedule(row: any, profileId: any) {
  if (!object(row) || !validId(row._id) || row.profileId != null && String(row.profileId?._id || row.profileId) !== profileId || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 200 || !timezone(row.timezone) || typeof row.active !== 'boolean' || typeof row.isDefault !== 'boolean') invalid();
  const result = { _id: row._id, profileId, name: row.name, timezone: row.timezone, slots: slots(row.slots, 502), active: row.active, isDefault: row.isDefault };
  return { ...result, version: digest(result) };
}
export async function queueList(api: ZernioApi, profileId: any) {
  const response = await api('/queue/slots', { profileId, all: 'true' });
  if (!Array.isArray(response.queues) || response.queues.length > 1000 || response.count != null && response.count !== response.queues.length) invalid();
  const queues = response.queues.map((row: any) => schedule(row, profileId));
  if (new Set(queues.map((row: any) => row._id)).size !== queues.length || queues.filter((row: any) => row.isDefault).length > 1) invalid();
  return { queues, version: digest(queues.map((row: any) => [row._id, row.version]).sort((a: any, b: any) => a[0].localeCompare(b[0]))) };
}
function expectedVersion(version: any, actual: any) {
  if (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)) fail(400, 'QUEUE_REVIEW_REQUIRED', 'Refresh and review this queue before continuing.');
  if (version !== actual) fail(409, 'QUEUE_CHANGED', 'The publishing queue changed. Reload its schedule and review your post before continuing.');
}
export function validateQueueIntent(post: any) {
  if ((post.queueId === undefined || post.queueId === '') && (post.queueVersion === undefined || post.queueVersion === '')) return;
  id(post.queueId);
  if (typeof post.queueVersion !== 'string' || !/^[a-f0-9]{64}$/.test(post.queueVersion)) fail(400, 'QUEUE_REVIEW_REQUIRED', 'Load and choose the publishing queue again before saving.');
  if (!post.externalId && (post.scheduledAt || post.scheduledFor)) fail(400, 'QUEUE_SCHEDULE_CONFLICT', 'Choose either a publishing queue or a fixed scheduled time.');
}
export function reviewedQueue(post: any, queues: any) {
  validateQueueIntent(post); if (!post.queueId) return;
  const queue = queues.find((row: any) => row._id === post.queueId);
  if (!queue) fail(403, 'QUEUE_OUTSIDE_PROJECT', 'This queue is not available in the current project profile.');
  expectedVersion(post.queueVersion, queue.version);
  if (!queue.active || !queue.slots.length) fail(409, 'QUEUE_INACTIVE', 'Choose an active queue with at least one weekly slot.');
  return queue;
}
export async function applyQueueIntent(api: ZernioApi, profileId: any, post: any, payload: any) {
  validateQueueIntent(post); if (!post.queueId) return;
  const queue = reviewedQueue(post, (await queueList(api, profileId)).queues);
  delete payload.publishNow; delete payload.scheduledFor; payload.queuedFromProfile = profileId; payload.queueId = queue._id; payload.timezone = queue.timezone;
  return queue;
}
export function assertQueueReceipt(remote: any, post: any, profileId: any) {
  if (!post.queueId) return;
  if (remote.status !== 'scheduled' || !validProviderInstant(remote.scheduledFor) || Date.parse(remote.scheduledFor) <= Date.now() || remote.queueId != null && String(remote.queueId?._id || remote.queueId) !== post.queueId || remote.queuedFromProfile != null && String(remote.queuedFromProfile?._id || remote.queuedFromProfile) !== profileId) fail(502, 'QUEUE_ASSIGNMENT_NOT_CONFIRMED', 'Zernio did not confirm a future queue assignment for this post. Review the provider receipt before retrying.', true);
}
function uncertain(error: any): never { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
function unresolved(context: OperationContext & { body: any }) {
  if (!context.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='integration_operations'").get()) return;
  // ponytail: an unknown queue mutation blocks this project until reviewed; persist per-queue locks if simultaneous recovery is needed.
  if (context.db.prepare("SELECT id FROM integration_operations WHERE project_id=? AND request_key<>? AND status IN ('pending','uncertain') AND action_path LIKE 'POST /integrations/queues/%'").get(context.project.id, context.req.headers['idempotency-key'] as string)) fail(409, 'QUEUE_PREVIOUS_OUTCOME_UNRESOLVED', 'Review the previous publishing queue change before changing another schedule. This new change has not been sent.');
}
function editable(body: any) {
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 200 || /[\u0000-\u001f\u007f]/.test(body.name) || !timezone(body.timezone) || typeof body.active !== 'boolean') fail(400, 'INVALID_QUEUE_SETTINGS', 'Enter a queue name, IANA timezone and active state.');
  const result = { name: body.name.trim(), timezone: body.timezone, slots: slots(body.slots), active: body.active };
  if (result.active && !result.slots.length) fail(400, 'QUEUE_SLOTS_REQUIRED', 'Add at least one weekly slot before activating this queue.');
  return result;
}
function sameSettings(queue: any, input: any) { return ['name', 'timezone', 'active'].every(key => queue[key] === input[key]) && JSON.stringify(queue.slots) === JSON.stringify(input.slots); }

export async function handleZernioQueues(context: OperationContext & { body: any }, api: ZernioApi, profileId: any, action: any) {
  const { req, url, body = {}, role, send } = context;
  if (!action && req.method === 'GET') { send(200, await queueList(api, profileId)); return true; }
  const match = /^([^/]+)\/(update|delete|preview)$/.exec(action), create = action === 'create';
  if (!create && !match) return false;
  const preview = match?.[2] === 'preview', deleting = match?.[2] === 'delete';
  if (req.method !== (preview ? 'GET' : 'POST')) fail(405, 'METHOD_NOT_ALLOWED', 'Use the available publishing queue controls.');
  if (!preview && !['owner', 'admin'].includes(role)) fail(403, 'ADMIN_PERMISSION_REQUIRED', 'A workspace owner or administrator must change publishing queues.');
  let queueId: any; if (match) try { queueId = id(decodeURIComponent(match[1])); } catch (error: any) { if (error instanceof IntegrationError) throw error; fail(400, 'INVALID_QUEUE', 'Choose a valid publishing queue.'); }
  if (preview) {
    const queues = (await queueList(api, profileId)).queues, queue = queues.find((row: any) => row._id === queueId), count = Number(url.searchParams.get('count') || 20);
    if (!queue) fail(403, 'QUEUE_OUTSIDE_PROJECT', 'Choose a queue belonging to this project profile.');
    if (!queue.active || !queue.slots.length) fail(409, 'QUEUE_INACTIVE', 'Activate this queue and add a slot before previewing it.');
    if (!Number.isInteger(count) || count < 1 || count > 100 || [...url.searchParams.keys()].some(key => key !== 'count')) fail(400, 'INVALID_QUEUE_PREVIEW', 'Preview between 1 and 100 upcoming slots.');
    const result = await api('/queue/preview', { profileId, queueId, count });
    const now = Date.now();
    if (result.profileId !== profileId || result.queueId != null && result.queueId !== queueId || !Array.isArray(result.slots) || result.slots.length > count || result.slots.some((value: any, index: any) => !validProviderInstant(value) || Date.parse(value) <= (index ? Date.parse(result.slots[index - 1]) : now)) || result.count != null && result.count !== result.slots.length) invalid();
    send(200, { queue, slots: result.slots, previewOnly: true }); return true;
  }
  fields(body, deleting ? ['expectedVersion', 'confirmDelete'] : ['name', 'timezone', 'slots', 'active', ...(create ? ['expectedListVersion'] : ['expectedVersion', 'setAsDefault', 'reshuffleExisting', 'confirmReshuffle'])]);
  const settings = deleting ? null : editable(body);
  if (deleting && body.confirmDelete !== queueId) fail(400, 'QUEUE_DELETE_CONFIRMATION_REQUIRED', 'Confirm the exact publishing queue before deleting it.');
  if (!create && !deleting && (typeof body.setAsDefault !== 'boolean' || typeof body.reshuffleExisting !== 'boolean' || body.reshuffleExisting && body.confirmReshuffle !== true || body.confirmReshuffle !== undefined && typeof body.confirmReshuffle !== 'boolean')) fail(400, 'QUEUE_RESHUFFLE_CONFIRMATION_REQUIRED', 'Choose the default and rescheduling options explicitly. Confirm before moving existing queued posts.');
  const result = await operation(context, async key => {
    unresolved(context);
    const before = await queueList(api, profileId), current = create ? null : before.queues.find((row: any) => row._id === queueId);
    if (!create && !current) fail(403, 'QUEUE_OUTSIDE_PROJECT', 'This publishing queue no longer belongs to the current profile.');
    expectedVersion(create ? body.expectedListVersion : body.expectedVersion, create ? before.version : current.version);
    const response = deleting ? await api('/queue/slots', { profileId, queueId }, undefined, key, 'DELETE') : await api('/queue/slots', {}, { profileId, ...(create ? {} : { queueId, setAsDefault: body.setAsDefault, reshuffleExisting: body.reshuffleExisting }), ...settings }, key, create ? 'POST' : 'PUT');
    try {
      if (response.success !== true) invalid();
      if (deleting) {
        if (response.deleted !== true || response.deletedCount != null && response.deletedCount !== 1) invalid();
        const fresh = await queueList(api, profileId); if (fresh.queues.some((row: any) => row._id === queueId) || fresh.queues.length !== before.queues.length - 1) invalid();
        return { deleted: true, queueId, ...fresh };
      }
      const receipt = schedule(response.schedule, profileId), fresh = await queueList(api, profileId), confirmed = fresh.queues.find((row: any) => row._id === receipt._id);
      if (!confirmed || !sameSettings(receipt, settings) || !sameSettings(confirmed, settings) || !create && receipt._id !== queueId || create && (before.queues.some((row: any) => row._id === receipt._id) || fresh.queues.length !== before.queues.length + 1) || (!before.queues.length || body.setAsDefault) && (!receipt.isDefault || !confirmed.isDefault)) invalid();
      for (const field of ['reshuffledCount', 'skippedDailyLimit']) if (response[field] != null && (!Number.isSafeInteger(response[field]) || response[field] < 0)) invalid();
      return { queue: confirmed, ...fresh, reshuffledCount: response.reshuffledCount || 0, skippedDailyLimit: response.skippedDailyLimit || 0 };
    } catch (error: any) { uncertain(error); }
  }, 'publishing-queues');
  send(result.status, result.data); return true;
}
