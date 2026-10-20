import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { transaction } from './database.ts';
import type { Store } from './database.ts';
import type { DatabaseSync } from 'node:sqlite';
import { createContacts } from './contacts.ts';
import { HttpError } from './auth.ts';
import { validPostInstant as iso } from '../shared/social-posts.ts';
import { paidAdEvents, minimizeAdEvent, initializeAdEvents, recordAdEvent } from './zernio-ad-events.ts';

type Rows = { get(...params: any[]): any; all(...params: any[]): any[] };
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
export function createWebhookService({ db, store, contacts = createContacts({ db }), env = process.env }: { db: DatabaseSync; store: Store; contacts?: ReturnType<typeof createContacts>; env?: Record<string, string | undefined> }) {
  db.exec(`CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,event TEXT NOT NULL,payload TEXT NOT NULL,body_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,next_attempt INTEGER NOT NULL DEFAULT 0,received_at TEXT NOT NULL,processed_at TEXT);
    CREATE INDEX IF NOT EXISTS webhook_pending ON webhook_events(status,next_attempt);
    CREATE TABLE IF NOT EXISTS webhook_inbox_updates(sequence INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,profile_id TEXT NOT NULL,account_id TEXT NOT NULL,event_id TEXT UNIQUE NOT NULL,event TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS webhook_inbox_scope ON webhook_inbox_updates(project_id,profile_id,account_id,sequence);
    CREATE TABLE IF NOT EXISTS webhook_project_bindings(event_id TEXT NOT NULL,profile_id TEXT NOT NULL,project_id TEXT NOT NULL,PRIMARY KEY(event_id,profile_id));`);
  initializeAdEvents(db);
  const eventById = db.prepare('SELECT * FROM webhook_events WHERE id=?') as unknown as Rows;
  const projectByProfile = db.prepare('SELECT id,zernio_profile_id FROM projects WHERE zernio_profile_id=?') as unknown as Rows;
  const binding = db.prepare('SELECT project_id FROM webhook_project_bindings WHERE event_id=? AND profile_id=?') as unknown as Rows;
  const bind = db.prepare('INSERT INTO webhook_project_bindings VALUES(?,?,?) ON CONFLICT(event_id,profile_id) DO NOTHING');
  const profileIds = (payload: any) => postEvents.has(payload.event) ? [...new Set((Array.isArray(payload.profiles) ? payload.profiles : []).map((profile: any) => profile?.id))] : [payload.account?.profileId || payload.profiles?.[0]?.id];
  function bindKnown(payload: any) { for (const profileId of profileIds(payload)) { if (!validId(profileId)) continue; const projects = projectByProfile.all(profileId); if (projects.length === 1) bind.run(payload.id, profileId, projects[0].id); } }
  function assertBindings(payload: any) {
    for (const profileId of profileIds(payload)) { const project = projectFor(profileId), saved = binding.get(payload.id, profileId); if (saved && saved.project_id !== project.id) blocked('PROFILE_MAPPING_CHANGED'); bind.run(payload.id, profileId, project.id); }
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

  function receive(rawBody: any, headers: any) {
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
      return transaction(db, () => {
        const existing = eventById.get(payload.id);
        if (existing) return existing.body_hash === hash ? response(200) : response(409, 'EVENT_ID_CONFLICT');
        const ignored = payload.test === true || !postEvents.has(payload.event) && !inboxEvents.has(payload.event) && !paidAdEvents.has(payload.event);
        const now = new Date().toISOString();
        db.prepare('INSERT INTO webhook_events(id,event,payload,body_hash,status,received_at,processed_at) VALUES(?,?,?,?,?,?,?)').run(payload.id, payload.event, JSON.stringify(ignored ? { id: payload.id, event: payload.event, timestamp: payload.timestamp } : minimized || payload), hash, ignored ? 'ignored' : 'pending', now, ignored ? now : null);
        if (!ignored) bindKnown(minimized || payload);
        return response(202);
      });
    } catch { return response(503, 'WEBHOOK_STORAGE_UNAVAILABLE'); }
  }

  function projectFor(profileId: any) {
    if (!validId(profileId)) blocked('PROFILE_MISSING');
    const projects = projectByProfile.all(profileId);
    if (projects.length !== 1) blocked(projects.length ? 'PROFILE_MAPPING_AMBIGUOUS' : 'PROFILE_NOT_MAPPED');
    return projects[0];
  }
  function updatePost(payload: any) {
    if (!Array.isArray(payload.profiles) || !payload.profiles.length) blocked('PROFILE_MISSING');
    const profiles = [...new Set(payload.profiles.map((profile: any) => profile?.id))];
    const projects = profiles.map(projectFor), eventAt = new Date(payload.timestamp).toISOString();
    let found = false;
    for (const project of projects) {
      const post = store.list(project.id, 'posts').find((item: any) => item.externalId === payload.post.id && item.zernioProfileId === project.zernio_profile_id && !item.sample);
      if (!post) continue;
      found = true;
      if (post.providerDeletedAt || !newer(eventAt, post.providerEventAt)) continue;
      const statuses = ['scheduled', 'published', 'failed', 'partial', 'cancelled', 'publishing', 'draft'];
      const providerStatus = statuses.includes(payload.post.status) ? payload.post.status : payload.event.slice('post.'.length);
      const status = providerStatus === 'publishing' ? 'submitted' : statuses.includes(providerStatus) ? providerStatus : post.status;
      // Keep only status evidence. A cross-profile post can contain another tenant's targets and copy.
      store.update(project.id, 'posts', post.id, { status, providerStatus, providerEventAt: eventAt });
    }
    if (!found) blocked('POST_NOT_LINKED');
  }
  function updateInbox(payload: any) {
    const account = payload.account, profiles = payload.profiles, declared = profiles === undefined ? [] : profiles;
    if (!Array.isArray(declared) || declared.length > 1 || declared.some((profile: any) => !validId(profile?.id))) blocked('PROFILE_CONTEXT_MISMATCH');
    const profileId = account.profileId || declared[0]?.id;
    if (declared.some((profile: any) => profile.id !== profileId)) blocked('PROFILE_CONTEXT_MISMATCH');
    const project = projectFor(profileId), accountId = account.accountId;
    const conversationId = payload.conversation?.platformConversationId || payload.conversation?.id;
    let contact;
    if (payload.event === 'message.received' && account.platform === 'facebook' && payload.message?.direction === 'incoming') {
      const participantId = payload.message.sender?.id;
      if (validId(participantId) && (!payload.conversation.participantId || payload.conversation.participantId === participantId)) contact = contacts.fromMessenger(project.id, { accountId, participantId, conversationId, name: payload.conversation.participantName || payload.message.sender.name });
    }
    const data = { id: payload.id, event: payload.event, accountId, platform: account.platform, resourceId: conversationId || payload.comment?.id || payload.review?.id, ...(conversationId ? { conversationId } : {}), ...(payload.comment ? { postId: payload.comment.platformPostId } : {}), ...(contact ? { contactId: contact.id } : {}), receivedAt: payload.timestamp };
    db.prepare('INSERT INTO webhook_inbox_updates(project_id,profile_id,account_id,event_id,event,data) VALUES(?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING').run(project.id, profileId, accountId, payload.id, payload.event, JSON.stringify(data));
  }
  function processPending({ limit = 25, now = Date.now() }: { limit?: number; now?: number } = {}) {
    const rows = db.prepare("SELECT id FROM webhook_events WHERE status='pending' AND next_attempt<=? ORDER BY rowid LIMIT ?").all(now, Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 25)));
    let processed = 0, pending = 0;
    for (const { id } of rows) {
      try {
        const queued = eventById.get(id);
        // Legacy/unmapped deliveries cannot prove their original receipt scope; bind the
        // first known mapping before effect work so a failed effect cannot erase that proof.
        if (queued?.status === 'pending') bindKnown(JSON.parse(queued.payload));
        transaction(db, () => {
          const event = eventById.get(id);
          if (!event || event.status !== 'pending' || event.next_attempt > now) return;
          const payload = JSON.parse(event.payload);
          if (!postEvents.has(payload.event) && !inboxEvents.has(payload.event) && !paidAdEvents.has(payload.event)) {
            db.prepare("UPDATE webhook_events SET status='ignored',last_error=NULL,processed_at=? WHERE id=?").run(new Date().toISOString(), id);
            return;
          }
          let savedPayload = event.payload;
          // New deliveries with a known mapping retain that receipt-time project across retries.
          assertBindings(payload);
          if (inboxEvents.has(payload.event)) {
            let minimized: any;
            try { minimized = inboxPayload(payload); } catch { db.prepare("UPDATE webhook_events SET status='ignored',payload=?,last_error='INVALID_INBOX_EVENT',processed_at=? WHERE id=?").run(JSON.stringify({ id: payload.id, event: payload.event, timestamp: payload.timestamp }), new Date().toISOString(), id); return; }
            updateInbox(minimized);
            savedPayload = JSON.stringify(minimized);
          } else if (paidAdEvents.has(payload.event)) { const minimized = minimizeAdEvent(payload, true); recordAdEvent(db, minimized, projectFor(minimized.account.profileId).id); savedPayload = JSON.stringify(minimized); }
          else updatePost(payload);
          db.prepare("UPDATE webhook_events SET status='processed',payload=?,attempts=attempts+1,last_error=NULL,processed_at=? WHERE id=?").run(savedPayload, new Date().toISOString(), id);
          processed++;
        });
      } catch (error: any) {
        // Retry only local work; never log payloads, secrets or exception messages.
        db.prepare("UPDATE webhook_events SET attempts=attempts+1,last_error=?,next_attempt=? WHERE id=? AND status='pending'").run(error.webhookCode || 'PROCESSING_FAILED', now + 60000, id);
        pending++;
      }
    }
    return { processed, pending };
  }
  function updates(projectId: string, { accountId, after, limit = 100 }: { accountId?: any; after?: any; limit?: number } = {}) {
    if (!validId(accountId)) throw new HttpError(400, 'A valid account is required.');
    const project = db.prepare('SELECT zernio_profile_id FROM projects WHERE id=?').get(projectId), profileId = project?.zernio_profile_id || '';
    if (after !== undefined && (!/^\d{1,16}$/.test(String(after)) || !Number.isSafeInteger(Number(after)))) throw new HttpError(400, 'The update cursor is invalid.');
    const latest = (db.prepare('SELECT max(sequence) AS cursor FROM webhook_inbox_updates WHERE project_id=? AND profile_id=? AND account_id=?').get(projectId, profileId, accountId) as any).cursor || 0;
    if (after === undefined) return { updates: [], cursor: latest, hasMore: false, checkedAt: new Date().toISOString() };
    const size = Math.max(1, Math.min(100, Number.isInteger(limit) ? limit : 100)), rows = db.prepare('SELECT sequence,data FROM webhook_inbox_updates WHERE project_id=? AND profile_id=? AND account_id=? AND sequence>? ORDER BY sequence LIMIT ?').all(projectId, profileId, accountId, Number(after), size + 1);
    return { updates: rows.slice(0, size).map((row: any) => ({ ...JSON.parse(row.data), sequence: row.sequence })), cursor: rows.length ? rows[Math.min(size, rows.length) - 1].sequence : Math.max(Number(after), latest), hasMore: rows.length > size, checkedAt: new Date().toISOString() };
  }
  return { receive, processPending, updates };
}
