import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createStore } from './database.ts';
import type { Database, Executor, Store } from './database.ts';
import { createContacts } from './contacts.ts';
import { HttpError } from './auth.ts';
import { validPostInstant as iso } from '../shared/social-posts.ts';
import { paidAdEvents, minimizeAdEvent, recordAdEvent } from './zernio-ad-events.ts';

const rows = async (query: Promise<{ rows: unknown[] }>) => (await query).rows as any[];
const first = async (query: Promise<{ rows: unknown[] }>) => (await rows(query))[0] as any;
export const WEBHOOK_MAX_BYTES = 1024 * 1024;
const postEvents = new Set(['post.scheduled', 'post.published', 'post.failed', 'post.partial', 'post.cancelled', 'post.recycled', 'post.platform.published', 'post.platform.failed', 'post.platform.deleted', 'post.tiktok.url_resolved']);
const messageEvents = new Set(['message.received', 'message.sent', 'message.edited', 'message.deleted', 'message.delivered', 'message.read', 'message.failed']);
const inboxEvents = new Set([...messageEvents, 'conversation.started', 'conversation.control_changed', 'reaction.received', 'referral.received', 'comment.received', 'review.new', 'review.updated']);
export const supportedWebhookEvents = [...new Set([...postEvents, ...inboxEvents, ...paidAdEvents])];
const validId = (value: any) => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\s\u0000-\u001f]/.test(value);
const display = (value: any, maximum = 500) => typeof value === 'string' ? value.slice(0, maximum) : '';
const header = (headers: any, name: string) => typeof headers?.get === 'function' ? headers.get(name) : Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
const response = (status: number, code?: string) => ({ status, body: status < 300 ? { accepted: true } : { error: { code, message: 'The webhook could not be accepted.' } } });
const blocked = (code: string): never => { throw Object.assign(new Error(code), { webhookCode: code }); };
const newer = (incoming: any, previous?: any) => !previous || Date.parse(incoming) >= Date.parse(previous);
// Contract: https://docs.zernio.com/webhooks. The stable
// event ID, not a freshness window, stops replays: legitimate retries last ~51h.
// storeFor builds the project store on the processing transaction so post effects commit or roll back with the event.
export function createWebhookService({ db, storeFor = createStore, contacts = createContacts({ db }), env = process.env }: { db: Database; storeFor?: (executor: Executor) => Store; contacts?: ReturnType<typeof createContacts>; env?: Record<string, string | undefined> }) {
  const eventById = (executor: Executor, id: string) => first(executor.execute(sql`SELECT * FROM webhook_events WHERE id=${id}`));
  const projectByProfile = (executor: Executor, profileId: any) => rows(executor.execute(sql`SELECT id,zernio_profile_id FROM projects WHERE zernio_profile_id=${profileId}`));
  const binding = (executor: Executor, eventId: string, profileId: any) => first(executor.execute(sql`SELECT project_id FROM webhook_project_bindings WHERE event_id=${eventId} AND profile_id=${profileId}`));
  const bind = (executor: Executor, eventId: string, profileId: any, projectId: string) => executor.execute(sql`INSERT INTO webhook_project_bindings VALUES(${eventId},${profileId},${projectId}) ON CONFLICT(event_id,profile_id) DO NOTHING`);
  const profileIds = (payload: any) => postEvents.has(payload.event) ? [...new Set((Array.isArray(payload.profiles) ? payload.profiles : []).map((profile: any) => profile?.id))] : [payload.account?.profileId || payload.profiles?.[0]?.id];
  async function bindKnown(executor: Executor, payload: any) { for (const profileId of profileIds(payload)) { if (!validId(profileId)) continue; const projects = await projectByProfile(executor, profileId); if (projects.length === 1) await bind(executor, payload.id, profileId, projects[0].id); } }
  async function assertBindings(executor: Executor, payload: any) {
    for (const profileId of profileIds(payload)) { const project = await projectFor(executor, profileId), saved = await binding(executor, payload.id, profileId); if (saved && saved.project_id !== project.id) blocked('PROFILE_MAPPING_CHANGED'); await bind(executor, payload.id, profileId, project.id); }
  }

  function inboxPayload(payload: any) {
    const account = payload.account, conversation = payload.conversation, message = payload.message;
    if (!validId(account?.accountId || account?.id) || !validId(account?.platform) || account.accountId && account.id && account.accountId !== account.id) blocked('INVALID_INBOX_EVENT');
    if (conversation?.platform && conversation.platform !== account.platform) blocked('INVALID_INBOX_EVENT');
    if (conversation && Object.hasOwn(conversation, 'participantId') && !validId(conversation.participantId)) blocked('INVALID_INBOX_EVENT');
    if (messageEvents.has(payload.event) && (!validId(conversation?.id) || !validId(message?.id) || message.conversationId && message.conversationId !== conversation.id || message.platform && message.platform !== account.platform || message.direction && !['incoming', 'outgoing'].includes(message.direction))) blocked('INVALID_INBOX_EVENT');
    if (payload.event.startsWith('conversation.') || ['reaction.received', 'referral.received'].includes(payload.event)) if (!validId(conversation?.id) || conversation.platform && conversation.platform !== account.platform) blocked('INVALID_INBOX_EVENT');
    if (payload.event === 'comment.received' && (!validId(payload.comment?.id) || !validId(payload.comment?.platformPostId) || payload.comment.platform && payload.comment.platform !== account.platform || payload.post?.platformPostId && payload.post.platformPostId !== payload.comment.platformPostId)) blocked('INVALID_INBOX_EVENT');
    if (payload.event.startsWith('review.') && (!validId(payload.review?.id) || payload.review.platform && payload.review.platform !== account.platform)) blocked('INVALID_INBOX_EVENT');
    const cleanName = (value: any) => display(value, 200).replace(/[\u0000-\u001f\u007f]/g, '').trim();
    // Notifications and contact identity are sufficient locally. Message, comment and
    // review bodies and attachment URLs stay at the provider and are fetched on demand.
    return { id: payload.id, event: payload.event, timestamp: payload.timestamp, ...(payload.profiles !== undefined ? { profiles: Array.isArray(payload.profiles) ? payload.profiles.slice(0, 100).map((profile: any) => ({ id: profile?.id })) : null } : {}), account: { accountId: account.accountId || account.id, platform: account.platform, ...(account.profileId !== undefined ? { profileId: account.profileId } : {}) }, ...(conversation ? { conversation: { id: conversation.id, ...(validId(conversation.platformConversationId) ? { platformConversationId: conversation.platformConversationId } : {}), ...(validId(conversation.participantId) ? { participantId: conversation.participantId } : {}), participantName: cleanName(conversation.participantName || conversation.participantUsername), ...(conversation.platform ? { platform: conversation.platform } : {}) } } : {}), ...(message ? { message: { id: message.id, direction: message.direction, sender: { id: validId(message.sender?.id) ? message.sender.id : '', name: cleanName(message.sender?.name || message.sender?.username) } } } : {}), ...(payload.comment ? { comment: { id: payload.comment.id, platformPostId: payload.comment.platformPostId } } : {}), ...(payload.review ? { review: { id: payload.review.id } } : {}) };
  }

  async function receive(rawBody: any, headers: any) {
    if (!env.ZERNIO_WEBHOOK_SECRET) return response(503, 'WEBHOOK_NOT_CONFIGURED');
    if (!(typeof rawBody === 'string' || rawBody instanceof Uint8Array)) return response(400, 'INVALID_BODY');
    const bytes = Buffer.from(rawBody);
    if (bytes.length > WEBHOOK_MAX_BYTES) return response(413, 'WEBHOOK_TOO_LARGE');
    const signature = header(headers, 'x-zernio-signature');
    if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return response(401, 'INVALID_SIGNATURE');
    const expected = createHmac('sha256', env.ZERNIO_WEBHOOK_SECRET).update(bytes).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return response(401, 'INVALID_SIGNATURE');
    let payload;
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { return response(400, 'INVALID_JSON'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(payload.id) || typeof payload.event !== 'string' || !/^[a-z][a-z0-9_.]{0,100}$/.test(payload.event) || !iso(payload.timestamp)) return response(400, 'INVALID_EVENT');
    for (const name of ['x-zernio-event-id', 'x-late-event-id']) {
      const value = header(headers, name);
      if (value !== undefined && value !== null && value !== payload.id) return response(400, 'EVENT_ID_MISMATCH');
    }
    if (payload.test !== undefined && typeof payload.test !== 'boolean') return response(400, 'INVALID_EVENT');
    if (postEvents.has(payload.event) && payload.test !== true && !validId(payload.post?.id)) return response(400, 'INVALID_POST_EVENT');
    let minimized: any;
    if (inboxEvents.has(payload.event) && payload.test !== true) { try { minimized = inboxPayload(payload); } catch { return response(400, 'INVALID_INBOX_EVENT'); } }
    if (paidAdEvents.has(payload.event) && payload.test !== true) { try { minimized = minimizeAdEvent(payload); } catch { return response(400, 'INVALID_AD_EVENT'); } }
    const hash = createHash('sha256').update(bytes).digest('hex');
    try {
      return await db.transaction(async tx => {
        const ignored = payload.test === true || !postEvents.has(payload.event) && !inboxEvents.has(payload.event) && !paidAdEvents.has(payload.event);
        const now = new Date().toISOString();
        // ON CONFLICT makes a concurrent duplicate delivery wait for the first insert and then compare hashes, instead of failing on the primary key.
        const inserted = await tx.execute(sql`INSERT INTO webhook_events(id,event,payload,body_hash,status,received_at,processed_at) VALUES(${payload.id},${payload.event},${JSON.stringify(ignored ? { id: payload.id, event: payload.event, timestamp: payload.timestamp } : minimized || payload)},${hash},${ignored ? 'ignored' : 'pending'},${now},${ignored ? now : null}) ON CONFLICT(id) DO NOTHING`);
        if (!inserted.rowCount) { const existing = await eventById(tx, payload.id); return existing.body_hash === hash ? response(200) : response(409, 'EVENT_ID_CONFLICT'); }
        if (!ignored) await bindKnown(tx, minimized || payload);
        return response(202);
      });
    } catch { return response(503, 'WEBHOOK_STORAGE_UNAVAILABLE'); }
  }

  async function projectFor(executor: Executor, profileId: any) {
    if (!validId(profileId)) blocked('PROFILE_MISSING');
    const projects = await projectByProfile(executor, profileId);
    if (projects.length !== 1) blocked(projects.length ? 'PROFILE_MAPPING_AMBIGUOUS' : 'PROFILE_NOT_MAPPED');
    return projects[0];
  }
  async function updatePost(tx: Executor, payload: any) {
    const store = storeFor(tx);
    if (!Array.isArray(payload.profiles) || !payload.profiles.length) blocked('PROFILE_MISSING');
    const profiles = [...new Set(payload.profiles.map((profile: any) => profile?.id))];
    const projects = []; for (const profileId of profiles) projects.push(await projectFor(tx, profileId));
    const eventAt = new Date(payload.timestamp).toISOString();
    let found = false;
    for (const project of projects) {
      const post = (await store.list(project.id, 'posts')).find((item: any) => item.externalId === payload.post.id && item.zernioProfileId === project.zernio_profile_id && !item.sample);
      if (!post) continue;
      found = true;
      if (post.providerDeletedAt || !newer(eventAt, post.providerEventAt)) continue;
      const statuses = ['scheduled', 'published', 'failed', 'partial', 'cancelled', 'publishing', 'draft'];
      const providerStatus = statuses.includes(payload.post.status) ? payload.post.status : payload.event.slice('post.'.length);
      const status = providerStatus === 'publishing' ? 'submitted' : statuses.includes(providerStatus) ? providerStatus : post.status;
      // Keep only status evidence. A cross-profile post can contain another tenant's targets and copy.
      await store.update(project.id, 'posts', post.id, { status, providerStatus, providerEventAt: eventAt });
    }
    if (!found) blocked('POST_NOT_LINKED');
  }
  async function updateInbox(tx: Executor, payload: any) {
    const account = payload.account, profiles = payload.profiles, declared = profiles === undefined ? [] : profiles;
    if (!Array.isArray(declared) || declared.length > 1 || declared.some((profile: any) => !validId(profile?.id))) blocked('PROFILE_CONTEXT_MISMATCH');
    const profileId = account.profileId || declared[0]?.id;
    if (declared.some((profile: any) => profile.id !== profileId)) blocked('PROFILE_CONTEXT_MISMATCH');
    const project = await projectFor(tx, profileId), accountId = account.accountId;
    const conversationId = payload.conversation?.platformConversationId || payload.conversation?.id;
    let contact;
    if (payload.event === 'message.received' && account.platform === 'facebook' && payload.message?.direction === 'incoming') {
      const participantId = payload.message.sender?.id;
      if (validId(participantId) && (!payload.conversation.participantId || payload.conversation.participantId === participantId)) contact = await contacts.fromMessenger(project.id, { accountId, participantId, conversationId, name: payload.conversation.participantName || payload.message.sender.name }, tx);
    }
    const data = { id: payload.id, event: payload.event, accountId, platform: account.platform, resourceId: conversationId || payload.comment?.id || payload.review?.id, ...(conversationId ? { conversationId } : {}), ...(payload.comment ? { postId: payload.comment.platformPostId } : {}), ...(contact ? { contactId: contact.id } : {}), receivedAt: payload.timestamp };
    await tx.execute(sql`INSERT INTO webhook_inbox_updates(project_id,profile_id,account_id,event_id,event,data) VALUES(${project.id},${profileId},${accountId},${payload.id},${payload.event},${JSON.stringify(data)}) ON CONFLICT(event_id) DO NOTHING`);
  }
  async function drain({ limit = 25, now = Date.now() }: { limit?: number; now?: number }) {
    const queue = await rows(db.execute(sql`SELECT id FROM webhook_events WHERE status='pending' AND next_attempt<=${now} ORDER BY seq LIMIT ${Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 25))}`));
    let processed = 0, pending = 0;
    for (const { id } of queue) {
      try {
        const queued = await eventById(db, id);
        // Legacy/unmapped deliveries cannot prove their original receipt scope; bind the
        // first known mapping before effect work so a failed effect cannot erase that proof.
        if (queued?.status === 'pending') await bindKnown(db, JSON.parse(queued.payload));
        const done = await db.transaction(async tx => {
          // The row lock claims the event for this transaction so two workers cannot process it at once; SKIP LOCKED passes
          // over an event another worker holds, and the re-checked status skips one that worker already completed.
          const event = await first(tx.execute(sql`SELECT * FROM webhook_events WHERE id=${id} AND status='pending' AND next_attempt<=${now} FOR UPDATE SKIP LOCKED`));
          if (!event) return false;
          const payload = JSON.parse(event.payload);
          if (!postEvents.has(payload.event) && !inboxEvents.has(payload.event) && !paidAdEvents.has(payload.event)) {
            await tx.execute(sql`UPDATE webhook_events SET status='ignored',last_error=NULL,processed_at=${new Date().toISOString()} WHERE id=${id}`);
            return false;
          }
          let savedPayload = event.payload;
          // New deliveries with a known mapping retain that receipt-time project across retries.
          await assertBindings(tx, payload);
          if (inboxEvents.has(payload.event)) {
            let minimized: any;
            try { minimized = inboxPayload(payload); } catch { await tx.execute(sql`UPDATE webhook_events SET status='ignored',payload=${JSON.stringify({ id: payload.id, event: payload.event, timestamp: payload.timestamp })},last_error='INVALID_INBOX_EVENT',processed_at=${new Date().toISOString()} WHERE id=${id}`); return false; }
            await updateInbox(tx, minimized);
            savedPayload = JSON.stringify(minimized);
          } else if (paidAdEvents.has(payload.event)) { const minimized = minimizeAdEvent(payload, true); await recordAdEvent(tx, minimized, (await projectFor(tx, minimized.account.profileId)).id); savedPayload = JSON.stringify(minimized); }
          else await updatePost(tx, payload);
          await tx.execute(sql`UPDATE webhook_events SET status='processed',payload=${savedPayload},attempts=attempts+1,last_error=NULL,processed_at=${new Date().toISOString()} WHERE id=${id}`);
          return true;
        });
        if (done) processed++;
      } catch (error: any) {
        // Retry only local work; never log payloads, secrets or exception messages.
        await db.execute(sql`UPDATE webhook_events SET attempts=attempts+1,last_error=${error.webhookCode || 'PROCESSING_FAILED'},next_attempt=${now + 60000} WHERE id=${id} AND status='pending'`);
        pending++;
      }
    }
    return { processed, pending };
  }
  // One drain at a time per service: a call made while a drain runs shares that drain's result.
  let draining: Promise<{ processed: number; pending: number }> | undefined;
  function processPending(options: { limit?: number; now?: number } = {}) {
    if (!draining) draining = drain(options).finally(() => { draining = undefined; });
    return draining;
  }
  async function updates(projectId: string, { accountId, after, limit = 100 }: { accountId?: any; after?: any; limit?: number } = {}) {
    if (!validId(accountId)) throw new HttpError(400, 'A valid account is required.');
    const project = await first(db.execute(sql`SELECT zernio_profile_id FROM projects WHERE id=${projectId}`)), profileId = project?.zernio_profile_id || '';
    if (after !== undefined && (!/^\d{1,16}$/.test(String(after)) || !Number.isSafeInteger(Number(after)))) throw new HttpError(400, 'The update cursor is invalid.');
    const latest = (await first(db.execute(sql`SELECT max(sequence) AS "cursor" FROM webhook_inbox_updates WHERE project_id=${projectId} AND profile_id=${profileId} AND account_id=${accountId}`))).cursor || 0;
    if (after === undefined) return { updates: [], cursor: latest, hasMore: false, checkedAt: new Date().toISOString() };
    const size = Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 100)), page = await rows(db.execute(sql`SELECT sequence,data FROM webhook_inbox_updates WHERE project_id=${projectId} AND profile_id=${profileId} AND account_id=${accountId} AND sequence>${Number(after)} ORDER BY sequence LIMIT ${size + 1}`));
    return { updates: page.slice(0, size).map((row: any) => ({ ...row.data, sequence: row.sequence })), cursor: page.length ? page[Math.min(size, page.length) - 1].sequence : Math.max(Number(after), latest), hasMore: page.length > size, checkedAt: new Date().toISOString() };
  }
  return { receive, processPending, updates };
}
