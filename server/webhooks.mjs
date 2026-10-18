import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { transaction } from './database.mjs';

export const WEBHOOK_MAX_BYTES = 1024 * 1024;
const postEvents = new Set(['post.scheduled', 'post.published', 'post.failed', 'post.partial', 'post.cancelled', 'post.recycled', 'post.platform.published', 'post.platform.failed', 'post.platform.deleted', 'post.tiktok.url_resolved']);
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\s\u0000-\u001f]/.test(value);
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const display = (value, maximum = 500) => typeof value === 'string' ? value.slice(0, maximum) : '';
const header = (headers, name) => typeof headers?.get === 'function' ? headers.get(name) : Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name)?.[1];
const response = (status, code) => ({ status, body: status < 300 ? { accepted: true } : { error: { code, message: 'The webhook could not be accepted.' } } });
const blocked = code => { throw Object.assign(new Error(code), { webhookCode: code }); };
const newer = (incoming, previous) => !previous || Date.parse(incoming) >= Date.parse(previous);
// Contract: https://docs.zernio.com/webhooks. Publishing status only. The stable
// event ID, not a freshness window, stops replays: legitimate retries last ~51h.
export function createWebhookService({ db, store, env = process.env }) {
  db.exec(`CREATE TABLE IF NOT EXISTS webhook_events (
    id TEXT PRIMARY KEY,event TEXT NOT NULL,payload TEXT NOT NULL,body_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,next_attempt INTEGER NOT NULL DEFAULT 0,received_at TEXT NOT NULL,processed_at TEXT);
    CREATE INDEX IF NOT EXISTS webhook_pending ON webhook_events(status,next_attempt);`);
  const eventById = db.prepare('SELECT * FROM webhook_events WHERE id=?');
  const projectByProfile = db.prepare('SELECT id,zernio_profile_id FROM projects WHERE zernio_profile_id=?');

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
    if (payload.test !== undefined && typeof payload.test !== 'boolean') return response(400, 'INVALID_EVENT');
    if (postEvents.has(payload.event) && payload.test !== true && !validId(payload.post?.id)) return response(400, 'INVALID_POST_EVENT');
    const hash = createHash('sha256').update(bytes).digest('hex');
    try {
      return transaction(db, () => {
        const existing = eventById.get(payload.id);
        if (existing) return existing.body_hash === hash ? response(200) : response(409, 'EVENT_ID_CONFLICT');
        const ignored = payload.test === true || !postEvents.has(payload.event);
        const now = new Date().toISOString();
        db.prepare('INSERT INTO webhook_events(id,event,payload,body_hash,status,received_at,processed_at) VALUES(?,?,?,?,?,?,?)').run(payload.id, payload.event, JSON.stringify(ignored ? { id: payload.id, event: payload.event, timestamp: payload.timestamp } : payload), hash, ignored ? 'ignored' : 'pending', now, ignored ? now : null);
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
  function processPending({ limit = 25, now = Date.now() } = {}) {
    const rows = db.prepare("SELECT id FROM webhook_events WHERE status='pending' AND next_attempt<=? ORDER BY rowid LIMIT ?").all(now, Math.min(100, Math.max(1, Number.isInteger(limit) ? limit : 25)));
    let processed = 0, pending = 0;
    for (const { id } of rows) {
      try {
        transaction(db, () => {
          const event = eventById.get(id);
          if (!event || event.status !== 'pending' || event.next_attempt > now) return;
          const payload = JSON.parse(event.payload);
          if (!postEvents.has(payload.event)) {
            db.prepare("UPDATE webhook_events SET status='ignored',last_error=NULL,processed_at=? WHERE id=?").run(new Date().toISOString(), id);
            return;
          }
          updatePost(payload);
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
