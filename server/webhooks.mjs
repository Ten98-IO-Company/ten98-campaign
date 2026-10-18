import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { transaction } from './database.mjs';

export const WEBHOOK_MAX_BYTES = 1024 * 1024;
const messageEvents = new Set(['message.received', 'message.sent', 'message.edited', 'message.deleted', 'message.delivered', 'message.read', 'message.played', 'message.failed']);
const conversationEvents = new Set(['conversation.started', 'conversation.control_changed']);
const engagementEvents = new Set(['comment.received', 'review.new', 'review.updated']);
const postEvents = new Set(['post.scheduled', 'post.published', 'post.failed', 'post.partial', 'post.cancelled', 'post.recycled', 'post.platform.published', 'post.platform.failed', 'post.platform.deleted', 'post.tiktok.url_resolved']);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\s\u0000-\u001f]/.test(value);
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const display = (value, maximum = 500) => typeof value === 'string' ? value.slice(0, maximum) : '';
const header = (headers, name) => typeof headers?.get === 'function' ? headers.get(name) : Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
const response = (status, code) => ({ status, body: status < 300 ? { accepted: true } : { error: { code, message: 'The webhook could not be accepted.' } } });
const blocked = code => { throw Object.assign(new Error(code), { webhookCode: code }); };
const newer = (incoming, previous) => !previous || Date.parse(incoming) >= Date.parse(previous);
function attachments(value) {
  return (Array.isArray(value) ? value : []).slice(0, 30).flatMap(item => {
    try {
      const url = new URL(item.url);
      if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 4096) return [];
      return [{ type: display(item.type, 50), url: url.href }];
    } catch { return []; }
  });
}

// Contract: https://docs.zernio.com/webhooks and /webhooks/inbox. The stable
// event ID, not a freshness window, stops replays: legitimate retries last ~51h.
export function createWebhookService({ db, store, env = process.env }) {
  db.exec(`CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,event TEXT NOT NULL,payload TEXT NOT NULL,body_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,next_attempt INTEGER NOT NULL DEFAULT 0,received_at TEXT NOT NULL,processed_at TEXT);
    CREATE INDEX IF NOT EXISTS webhook_pending ON webhook_events(status,next_attempt);
    CREATE TABLE IF NOT EXISTS webhook_messages (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,account_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,message_id TEXT NOT NULL,sent_at TEXT NOT NULL,data TEXT NOT NULL,
    PRIMARY KEY(project_id,account_id,conversation_id,message_id));
    CREATE TABLE IF NOT EXISTS webhook_engagement_updates (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,profile_id TEXT NOT NULL,
    account_id TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL,last_event_at TEXT NOT NULL,
    PRIMARY KEY(project_id,profile_id,account_id,kind));`);
  const eventById = db.prepare('SELECT * FROM webhook_events WHERE id=?');
  const projectByProfile = db.prepare('SELECT id,zernio_profile_id FROM projects WHERE zernio_profile_id=?');
  const messageById = db.prepare('SELECT data FROM webhook_messages WHERE project_id=? AND account_id=? AND conversation_id=? AND message_id=?');
  const saveMessage = db.prepare('INSERT INTO webhook_messages VALUES(?,?,?,?,?,?) ON CONFLICT(project_id,account_id,conversation_id,message_id) DO UPDATE SET sent_at=excluded.sent_at,data=excluded.data');
  const recentMessages = db.prepare('SELECT data FROM webhook_messages WHERE project_id=? AND account_id=? AND conversation_id=? ORDER BY sent_at DESC,message_id DESC LIMIT 500');

  function receive(rawBody, headers) {
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
    const inbox = messageEvents.has(payload.event) || conversationEvents.has(payload.event);
    if (payload.test !== undefined && typeof payload.test !== 'boolean') return response(400, 'INVALID_EVENT');
    if (inbox && payload.test !== true) {
      const account = payload.account, conversation = payload.conversation, message = payload.message;
      if (!validId(account?.accountId || account?.id) || !validId(conversation?.id) || !validId(account?.platform) || (account?.accountId && account?.id && account.accountId !== account.id) || (messageEvents.has(payload.event) && (!validId(message?.id) || (message.conversationId && message.conversationId !== conversation.id)))) return response(400, 'INVALID_INBOX_EVENT');
    }
    if (postEvents.has(payload.event) && payload.test !== true && !validId(payload.post?.id)) return response(400, 'INVALID_POST_EVENT');
    if (engagementEvents.has(payload.event) && payload.test !== true) {
      const account = payload.account;
      if (!validId(account?.accountId || account?.id) || !validId(account?.platform) || (account?.accountId && account?.id && account.accountId !== account.id)) return response(400, 'INVALID_ENGAGEMENT_EVENT');
      if (payload.event === 'comment.received' ? !validId(payload.comment?.id) || !validId(payload.comment?.platformPostId) || payload.comment?.platform !== account.platform || (payload.post?.platformPostId && payload.post.platformPostId !== payload.comment.platformPostId) : !validId(payload.review?.id)) return response(400, 'INVALID_ENGAGEMENT_EVENT');
    }
    const hash = createHash('sha256').update(bytes).digest('hex');
    try {
      return transaction(db, () => {
        const existing = eventById.get(payload.id);
        if (existing) return existing.body_hash === hash ? response(200) : response(409, 'EVENT_ID_CONFLICT');
        const ignored = payload.test === true || (!inbox && !postEvents.has(payload.event) && !engagementEvents.has(payload.event));
        const now = new Date().toISOString();
        db.prepare('INSERT INTO webhook_events(id,event,payload,body_hash,status,received_at,processed_at) VALUES(?,?,?,?,?,?,?)').run(payload.id, payload.event, JSON.stringify(payload), hash, ignored ? 'ignored' : 'pending', now, ignored ? now : null);
        return response(202);
      });
    } catch { return response(503, 'WEBHOOK_STORAGE_UNAVAILABLE'); }
  }

  function projectFor(profileId) {
    if (!validId(profileId)) blocked('PROFILE_MISSING');
    const projects = projectByProfile.all(profileId);
    if (projects.length !== 1) blocked(projects.length ? 'PROFILE_MAPPING_AMBIGUOUS' : 'PROFILE_NOT_MAPPED');
    return projects[0];
  }
  function updateInbox(payload) {
    const account = payload.account, incoming = payload.conversation, eventAt = new Date(payload.timestamp).toISOString();
    const profileId = account.profileId, accountId = account.accountId || account.id;
    // Message events use an internal ID; lifecycle events and REST lists use the platform ID.
    const conversationId = validId(incoming.platformConversationId) ? incoming.platformConversationId : incoming.id;
    if (Array.isArray(payload.profiles) && (!payload.profiles.length || payload.profiles.some(profile => profile?.id !== profileId))) blocked('PROFILE_CONTEXT_MISMATCH');
    const project = projectFor(profileId);
    // ponytail: scan project conversations; replace with an external-ID index if large inboxes make this measurable.
    const previous = store.list(project.id, 'conversations').find(item => item.source === 'zernio' && item.profileId === profileId && item.accountId === accountId && item.externalConversationId === conversationId);
    if (messageEvents.has(payload.event)) {
      const input = payload.message, row = messageById.get(project.id, accountId, conversationId, input.id);
      const message = row ? JSON.parse(row.data) : { id: input.id, externalId: input.id, createdAt: iso(input.sentAt) ? new Date(input.sentAt).toISOString() : eventAt, content: '', direction: input.direction === 'outgoing' ? 'outgoing' : 'incoming' };
      if (validId(input.platformMessageId)) {
        if (message.platformMessageId && message.platformMessageId !== input.platformMessageId) blocked('MESSAGE_IDENTITY_MISMATCH');
        message.platformMessageId = input.platformMessageId;
      }
      if (iso(input.sentAt) && Date.parse(input.sentAt) < Date.parse(message.createdAt)) message.createdAt = new Date(input.sentAt).toISOString();
      const contentAt = payload.event === 'message.edited' && iso(payload.editedAt) ? new Date(payload.editedAt).toISOString() : payload.event === 'message.received' || payload.event === 'message.sent' ? message.createdAt : eventAt;
      if (['message.received', 'message.sent', 'message.edited'].includes(payload.event) && !message.deletedAt && newer(contentAt, message.contentAt)) {
        message.content = display(input.text, 50000); message.attachments = attachments(input.attachments); message.contentAt = contentAt;
        message.direction = input.direction === 'outgoing' || payload.event === 'message.sent' ? 'outgoing' : 'incoming';
        message.sender = { id: display(input.sender?.id), name: display(input.sender?.name), username: display(input.sender?.username) };
        if (payload.event === 'message.edited') message.editedAt = contentAt;
      }
      if (payload.event === 'message.deleted') { message.deletedAt = eventAt; message.content = ''; message.attachments = []; }
      const delivery = payload.event.slice('message.'.length), rank = { sent: 1, delivered: 2, read: 3, played: 4 };
      if ((rank[delivery] || delivery === 'failed') && newer(eventAt, message.deliveryAt) && (delivery === 'failed' ? !['delivered', 'read', 'played'].includes(message.deliveryStatus) : rank[delivery] >= (rank[message.deliveryStatus] || 0))) {
        message.deliveryStatus = delivery; message.deliveryAt = eventAt;
        if (delivery === 'failed') message.deliveryError = { code: display(String(payload.error?.code || ''), 100), message: 'The platform reported a delivery failure.' };
        else delete message.deliveryError;
      }
      saveMessage.run(project.id, accountId, conversationId, input.id, message.createdAt, JSON.stringify(message));
    }
    const messages = recentMessages.all(project.id, accountId, conversationId).map(row => JSON.parse(row.data)).reverse();
    const data = { externalId: conversationId, externalConversationId: conversationId, accountId, profileId, platform: account.platform, source: 'zernio', isLive: true, messages };
    if (messageEvents.has(payload.event)) data.zernioConversationId = incoming.id;
    if (newer(eventAt, previous?.providerEventAt)) {
      data.providerEventAt = eventAt;
      data.contact = display(incoming.participantName || incoming.participantUsername || incoming.participantId || (payload.message?.direction !== 'outgoing' ? payload.message?.sender?.name : '') || previous?.contact || 'Contact');
      data.status = incoming.status === 'archived' ? 'resolved' : 'open';
    }
    const controlAt = iso(payload.changedAt) ? new Date(payload.changedAt).toISOString() : eventAt;
    if (payload.event === 'conversation.control_changed' && ['app', 'ai_agent', 'other'].includes(payload.control?.owner) && newer(controlAt, previous?.controlChangedAt)) Object.assign(data, { controlChangedAt: controlAt, controlOwner: payload.control.owner });
    if (previous) store.update(project.id, 'conversations', previous.id, data);
    else store.create(project.id, 'conversations', { contact: 'Contact', status: 'open', ...data });
  }
  function updatePost(payload) {
    if (!Array.isArray(payload.profiles) || !payload.profiles.length) blocked('PROFILE_MISSING');
    const profiles = [...new Set(payload.profiles.map(profile => profile?.id))];
    const projects = profiles.map(projectFor), eventAt = new Date(payload.timestamp).toISOString();
    let found = false;
    for (const project of projects) {
      const post = store.list(project.id, 'posts').find(item => item.externalId === payload.post.id && item.zernioProfileId === project.zernio_profile_id && !item.sample);
      if (!post) continue;
      found = true;
      if (!newer(eventAt, post.providerEventAt)) continue;
      const statuses = ['scheduled', 'published', 'failed', 'partial', 'cancelled', 'publishing', 'draft'];
      const providerStatus = statuses.includes(payload.post.status) ? payload.post.status : payload.event.slice('post.'.length);
      const status = providerStatus === 'publishing' ? 'submitted' : statuses.includes(providerStatus) ? providerStatus : post.status;
      // Keep only status evidence. A cross-profile post can contain another tenant's targets and copy.
      store.update(project.id, 'posts', post.id, { status, providerStatus, providerEventAt: eventAt });
    }
    if (!found) blocked('POST_NOT_LINKED');
  }
  function updateEngagement(payload) {
    // Comments/reviews omit account.profileId: their signed profiles array is the routing evidence.
    if (!Array.isArray(payload.profiles) || payload.profiles.length !== 1) blocked('PROFILE_CONTEXT_MISMATCH');
    const profileId = payload.profiles[0]?.id, project = projectFor(profileId), account = payload.account;
    if (account.profileId && account.profileId !== profileId) blocked('PROFILE_CONTEXT_MISMATCH');
    if (payload.event === 'comment.received' && payload.comment.ad) return; // Advertising threads use the provider dashboard, not the organic comment feed.
    const kind = payload.event === 'comment.received' ? 'comments' : 'reviews';
    db.prepare(`INSERT INTO webhook_engagement_updates VALUES(?,?,?,?,1,?)
      ON CONFLICT(project_id,profile_id,account_id,kind) DO UPDATE SET revision=revision+1,last_event_at=MAX(last_event_at,excluded.last_event_at)`)
      .run(project.id, profileId, account.accountId || account.id, kind, new Date(payload.timestamp).toISOString());
  }
  function processPending({ limit = 25, now = Date.now() } = {}) {
    const rows = db.prepare("SELECT id FROM webhook_events WHERE status='pending' AND next_attempt<=? ORDER BY rowid LIMIT ?").all(now, Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 25)));
    let processed = 0, pending = 0;
    for (const { id } of rows) {
      try {
        transaction(db, () => {
          const event = eventById.get(id);
          if (!event || event.status !== 'pending' || event.next_attempt > now) return;
          const payload = JSON.parse(event.payload);
          if (postEvents.has(payload.event)) updatePost(payload); else if (engagementEvents.has(payload.event)) updateEngagement(payload); else updateInbox(payload);
          db.prepare("UPDATE webhook_events SET status='processed',attempts=attempts+1,last_error=NULL,processed_at=? WHERE id=?").run(new Date().toISOString(), id);
          processed++;
        });
      } catch (error) {
        // Retry only local work; never log payloads, secrets or exception messages.
        db.prepare("UPDATE webhook_events SET attempts=attempts+1,last_error=?,next_attempt=? WHERE id=? AND status='pending'").run(error.webhookCode || 'PROCESSING_FAILED', now + 60000, id);
        pending++;
      }
    }
    return { processed, pending };
  }
  return { receive, processPending };
}
