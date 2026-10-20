import { createHash } from 'node:crypto';
import { googleToken, providerRequest, operation, IntegrationError } from './provider-core.ts';
import { postScheduleEntries } from '../shared/post-schedule.ts';

const fail = (status, message) => { throw new IntegrationError(status, 'CALENDAR_ERROR', message); };
const scope = 'https://www.googleapis.com/auth/calendar.events';
const DAY = 86400000;
const eventId = (projectId, collection, recordId, accountId = '', generation = 0) => 'ten98' + createHash('sha256').update(`${projectId}:${collection}:${recordId}${accountId ? ':account:' + accountId : ''}${generation ? ':generation:' + generation : ''}`).digest('hex');
const generationKey = (collection, recordId, accountId = '') => JSON.stringify([collection, recordId, accountId]);
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const snapshotOf = value => JSON.stringify(canonical(value));
function planIdentity(event, projectId) {
  const fields = event.extendedProperties?.private;
  const generation = fields?.ten98Generation === undefined ? 0 : Number(fields.ten98Generation);
  if (!projectId || fields?.ten98ProjectId !== projectId || !['campaigns', 'placements', 'posts'].includes(fields.ten98Collection) || typeof fields.ten98RecordId !== 'string' || !fields.ten98RecordId || fields.ten98AccountId !== undefined && (fields.ten98Collection !== 'posts' || typeof fields.ten98AccountId !== 'string' || !fields.ten98AccountId) || fields.ten98Generation !== undefined && (typeof fields.ten98Generation !== 'string' || !/^[1-9]\d{0,8}$/.test(fields.ten98Generation)) || event.id !== eventId(projectId, fields.ten98Collection, fields.ten98RecordId, fields.ten98AccountId, generation)) return undefined;
  return { collection: fields.ten98Collection, recordId: fields.ten98RecordId, ...(fields.ten98AccountId ? { accountId: fields.ten98AccountId } : {}), generation };
}
const text = (value, max = 500) => { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'Enter a valid calendar event title or description.'); return value.trim(); };
function isoDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
const isoTime = value => typeof value === 'string' && isoDate(value.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value) && Number.isFinite(Date.parse(value));
function validEvent(event) {
  const boundary = value => value && typeof value === 'object' && (value.date === undefined || isoDate(value.date)) && (value.dateTime === undefined || typeof value.dateTime === 'string' && isoDate(value.dateTime.slice(0, 10)) && Number.isFinite(Date.parse(value.dateTime))) && Boolean(value.date || value.dateTime);
  return event && typeof event === 'object' && typeof event.id === 'string' && event.id.length > 0 && event.id.length <= 1024 && ['summary', 'description', 'htmlLink', 'status', 'etag'].every(key => event[key] === undefined || typeof event[key] === 'string') && boundary(event.start) && boundary(event.end) && (event.extendedProperties?.private?.ten98ProjectId === undefined || typeof event.extendedProperties.private.ten98ProjectId === 'string');
}
function range(body) {
  if (body.allDay !== undefined && typeof body.allDay !== 'boolean') fail(400, 'All-day must be true or false.');
  if (body.allDay) {
    if (!isoDate(body.start) || !isoDate(body.end) || body.end <= body.start) fail(400, 'All-day events need an end date after their start date. The end date is exclusive.');
    return { start: { date: body.start }, end: { date: body.end } };
  }
  if (!isoTime(body.start) || !isoTime(body.end) || Date.parse(body.end) <= Date.parse(body.start)) fail(400, 'Choose valid start and end times with a timezone.');
  return { start: { dateTime: new Date(body.start).toISOString() }, end: { dateTime: new Date(body.end).toISOString() } };
}
export function calendarPlan(store, projectId, generations = new Map()) {
  const plan = [];
  for (const collection of ['campaigns', 'placements', 'posts']) for (const row of store.list(projectId, collection)) {
    if (row.sample) continue;
    const generation = generations.get(generationKey(collection, row.id)) || 0, id = eventId(projectId, collection, row.id, '', generation);
    const privateFields = { ten98ProjectId: projectId, ten98RecordId: row.id, ten98Collection: collection };
    if (collection === 'posts') {
      for (const copy of postScheduleEntries(row)) {
        const generation = generations.get(generationKey(collection, row.id, copy.accountId)) || 0;
        plan.push({ id: eventId(projectId, collection, row.id, copy.accountId, generation), summary: `Social · ${copy.accountId && !copy.platform ? 'Selected account post' : copy.content.slice(0, 100)}`, description: `Planned publishing time in ten98 Campaign. Calendar events do not publish social posts.${copy.accountId ? `\nAccount: ${copy.accountId}\nPlatform: ${copy.platform || 'Not available in the saved draft'}${copy.platform ? '\nCaption: ' + copy.content : '\nThe account-specific caption is not available in the saved draft.'}` : ''}`, start: { dateTime: new Date(copy.scheduledAt).toISOString() }, end: { dateTime: new Date(Date.parse(copy.scheduledAt) + 1800000).toISOString() }, extendedProperties: { private: { ...privateFields, ...(copy.accountId ? { ten98AccountId: copy.accountId } : {}), ...(generation ? { ten98Generation: String(generation) } : {}) } }, visibility: 'private' });
      }
    } else if (collection !== 'posts' && isoDate(row.startDate)) {
      const end = isoDate(row.endDate) && row.endDate >= row.startDate ? row.endDate : row.startDate;
      plan.push({ id, summary: `${collection === 'placements' ? 'OOH' : 'Campaign'} · ${row.name}`, description: row.location || row.description || '', start: { date: row.startDate }, end: { date: new Date(Date.parse(end) + DAY).toISOString().slice(0, 10) }, extendedProperties: { private: { ...privateFields, ...(generation ? { ten98Generation: String(generation) } : {}) } }, visibility: 'private' });
    }
  }
  // ponytail: synchronous sync caps at 100 records; use a queued worker for larger project plans.
  if (plan.length > 100) fail(400, 'This project has more than 100 dated records. Publish individual events or split the campaign plan into projects.');
  return plan;
}
function planIntent(store, projectId, calendarId, native = [], db) {
  const generations = new Map((db?.prepare('SELECT collection,record_id,account_id,generation FROM calendar_plan_generations WHERE project_id=? AND calendar_id=?').all(projectId, calendarId) || []).map(row => [generationKey(row.collection, row.record_id, row.account_id), row.generation]));
  const plan = calendarPlan(store, projectId, generations), ids = new Set(plan.map(event => event.id));
  const copies = store.list(projectId, 'posts').filter(row => !row.sample).map(row => ({ id: row.id, accounts: row.accounts, accountOverrides: row.accountOverrides, platformOverrides: row.platformOverrides })).sort((a, b) => a.id.localeCompare(b.id));
  const snapshot = snapshotOf([[...plan].sort((a, b) => a.id.localeCompare(b.id)), copies]);
  const deletions = native.filter(event => !ids.has(event.id) && planIdentity(event, projectId)).sort((a, b) => a.id.localeCompare(b.id));
  const deletionSnapshot = snapshotOf(deletions);
  const existing = new Map(native.map(event => [event.id, event]));
  const upsertSnapshot = snapshotOf([...ids].sort().map(id => [id, existing.get(id) || null]));
  return { plan, snapshot, deletions, deletionSnapshot, fingerprint: createHash('sha256').update(JSON.stringify([calendarId, snapshot, upsertSnapshot, deletionSnapshot])).digest('hex') };
}
const eventView = (event, projectId) => {
  const identity = planIdentity(event, projectId);
  return { id: event.id, etag: event.etag, summary: event.summary || '(Untitled event)', description: event.description || '', start: event.start, end: event.end, htmlLink: event.htmlLink, status: event.status, managed: Boolean(event.extendedProperties?.private?.ten98ProjectId), projectId: event.extendedProperties?.private?.ten98ProjectId, plan: identity ? { collection: identity.collection, recordId: identity.recordId, ...(identity.accountId ? { accountId: identity.accountId } : {}) } : undefined };
};

export async function handleCalendar(context) {
  const { req, url, project, user, role, db, body, store, send } = context;
  if (!url.pathname.startsWith(`/api/projects/${project.id}/calendar/`)) return false;
  const path = url.pathname.split('/calendar/')[1], env = context.config?.env || process.env;
  db.exec('CREATE TABLE IF NOT EXISTS calendar_connections(project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,calendar_id TEXT UNIQUE NOT NULL)');
  db.exec("CREATE TABLE IF NOT EXISTS calendar_plan_generations(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,calendar_id TEXT NOT NULL,collection TEXT NOT NULL,record_id TEXT NOT NULL,account_id TEXT NOT NULL DEFAULT '',generation INTEGER NOT NULL DEFAULT 0,known_generation INTEGER NOT NULL DEFAULT -1,PRIMARY KEY(project_id,calendar_id,collection,record_id,account_id))");
  const configured = Boolean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY);
  let connection = db.prepare('SELECT calendar_id AS calendarId FROM calendar_connections WHERE project_id=?').get(project.id);
  try {
    if (path === 'status' && req.method === 'GET') { send(200, { configured, mapped: Boolean(connection), calendarId: connection?.calendarId || '' }); return true; }
    if (path === 'connection' && req.method === 'POST') {
      if (!user.isOperator || !['owner', 'admin'].includes(role)) fail(403, 'Only an instance operator with workspace administration can map a calendar.');
      const calendarId = typeof body.calendarId === 'string' ? body.calendarId.trim() : '';
      if (calendarId && (calendarId.length > 500 || !/^[\w.@+%-]+$/.test(calendarId) || calendarId === 'primary')) fail(400, 'Use the ID of the calendar shared with your Google service account.');
      if (!calendarId) db.prepare('DELETE FROM calendar_connections WHERE project_id=?').run(project.id);
      else {
        const other = db.prepare('SELECT project_id FROM calendar_connections WHERE calendar_id=? AND project_id<>?').get(calendarId, project.id);
        if (other) fail(409, 'This calendar is already mapped to another project.');
        db.prepare('INSERT INTO calendar_connections VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET calendar_id=excluded.calendar_id').run(project.id, calendarId);
      }
      store.activity(project.id, 'Google Calendar connection updated.'); send(200, { mapped: Boolean(calendarId), calendarId }); return true;
    }
    if (!configured || !connection) fail(409, 'Configure Google credentials and map a shared calendar for this project.');
    if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method)) fail(405, 'This calendar action is not available.');
    if (req.method !== 'GET' && !['owner', 'admin', 'editor'].includes(role)) fail(403, 'Editing permission is required.');
    const token = await googleToken(env, scope), base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(connection.calendarId)}/events`;
    const currentMapping = () => { try { context.assertIntegrationSettings?.(); return db.prepare('SELECT calendar_id FROM calendar_connections WHERE project_id=?').get(project.id)?.calendar_id === connection.calendarId; } catch { return false; } };
    const rememberGeneration = (identity, retired = false) => {
      // Google keeps deleted IDs. Reserve the next one before DELETE, including an unconfirmed deletion.
      if (identity && !currentMapping()) fail(409, 'The calendar mapping or project access changed. Refresh this project.');
      if (identity) db.prepare('INSERT INTO calendar_plan_generations VALUES(?,?,?,?,?,?,?) ON CONFLICT(project_id,calendar_id,collection,record_id,account_id) DO UPDATE SET generation=MAX(generation,excluded.generation),known_generation=MAX(known_generation,excluded.known_generation)').run(project.id, connection.calendarId, identity.collection, identity.recordId, identity.accountId || '', identity.generation + (retired ? 1 : 0), identity.generation);
    };
    const call = async (suffix = '', method = 'GET', payload, etag) => {
      if (!currentMapping()) fail(409, 'The calendar mapping changed. Refresh this project.');
      let result;
      try { result = await providerRequest(base + suffix, { method, headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}), ...(etag ? { 'If-Match': etag } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) }, 'Google Calendar'); }
      finally { if (!currentMapping()) throw new IntegrationError(409, 'CALENDAR_MAPPING_CHANGED', 'The calendar mapping or project access changed while the request was in progress. Review the provider outcome.', method !== 'GET'); }
      if (payload && (result?.id !== payload.id || !validEvent(result) || Object.entries(payload.extendedProperties.private).some(([key, value]) => result.extendedProperties?.private?.[key] !== value))) throw new IntegrationError(502, 'CALENDAR_UNCERTAIN', 'Google did not confirm the expected calendar event. Review the provider outcome before retrying.', true);
      if (payload) rememberGeneration(planIdentity(result, project.id));
      return result;
    };
    async function list(managedOnly = false) {
      let pageToken; const events = [];
      const from = url.searchParams.get('fromDate'), to = url.searchParams.get('toDate'), timeMin = url.searchParams.get('timeMin'), timeMax = url.searchParams.get('timeMax');
      if ((from && !isoDate(from)) || (to && !isoDate(to)) || (from && to && (from > to || Date.parse(to) - Date.parse(from) > 366 * DAY))) fail(400, 'Choose a valid calendar window of at most 366 days.');
      if ((timeMin !== null || timeMax !== null) && (!isoTime(timeMin) || !isoTime(timeMax) || Date.parse(timeMax) <= Date.parse(timeMin) || Date.parse(timeMax) - Date.parse(timeMin) > 368 * DAY)) fail(400, 'Choose valid calendar window boundaries with a timezone.');
      const lower = timeMin || (from ? from + 'T00:00:00Z' : new Date(Date.now() - 30 * DAY).toISOString()), upper = timeMax || (to ? new Date(Date.parse(to) + DAY).toISOString() : new Date(Date.now() + 90 * DAY).toISOString());
      if (!managedOnly && (Date.parse(upper) <= Date.parse(lower) || Date.parse(upper) - Date.parse(lower) > 368 * DAY)) fail(400, 'Choose a valid bounded calendar window.');
      for (let page = 0; page < 10; page++) {
        const query = new URLSearchParams({ maxResults: '250', singleEvents: 'true', ...(managedOnly ? { privateExtendedProperty: `ten98ProjectId=${project.id}` } : { orderBy: 'startTime', timeMin: lower, timeMax: upper }), ...(pageToken ? { pageToken } : {}) });
        const data = await call('?' + query);
        const items = data.items === undefined && data.kind === 'calendar#events' ? [] : data.items;
        if (!Array.isArray(items) || items.length > 250 || items.some(event => !validEvent(event)) || data.nextPageToken !== undefined && (typeof data.nextPageToken !== 'string' || !data.nextPageToken)) fail(502, 'Google Calendar returned an unreadable event list.');
        events.push(...items);
        items.forEach(event => rememberGeneration(planIdentity(event, project.id)));
        if (!data.nextPageToken) return events;
        if (data.nextPageToken === pageToken) break;
        pageToken = data.nextPageToken;
      }
      fail(503, 'The calendar exceeds this view’s event limit. No complete result is available.');
    }
    if (path === 'events' && req.method === 'GET') { send(200, { events: (await list()).map(event => eventView(event, project.id)), complete: true }); return true; }
    if (path === 'plan' && req.method === 'GET') {
      const native = await list(true), listed = new Set(native.map(event => event.id));
      const initial = planIntent(store, project.id, connection.calendarId, native, db);
      for (const event of initial.plan.filter(event => !listed.has(event.id))) {
        const identity = planIdentity(event, project.id), known = db.prepare('SELECT known_generation FROM calendar_plan_generations WHERE project_id=? AND calendar_id=? AND collection=? AND record_id=? AND account_id=?').get(project.id, connection.calendarId, identity.collection, identity.recordId, identity.accountId || '');
        if (!known || known.known_generation < identity.generation) continue;
        let found;
        try { found = await call('/' + event.id); } catch (error) { if (![404, 410].includes(error.providerStatus)) throw error; found = { id: event.id, status: 'cancelled' }; }
        if (found.id !== event.id) fail(502, 'Google did not identify the missing planned event.');
        if (found.status === 'cancelled') rememberGeneration(identity, true);
        else { if (!validEvent(found) || !planIdentity(found, project.id)) fail(409, 'A planned event ID belongs to another calendar event. No changes were sent.'); rememberGeneration(planIdentity(found, project.id)); native.push(found); }
      }
      if (!currentMapping()) fail(409, 'The calendar mapping or project access changed. Refresh this project.');
      const intent = planIntent(store, project.id, connection.calendarId, native, db), existing = new Set(native.map(event => event.id));
      send(200, { fingerprint: intent.fingerprint, calendarId: connection.calendarId, projectId: project.id, upserts: intent.plan.map(event => ({ ...eventView(event, project.id), action: existing.has(event.id) ? 'update' : 'create' })), deletions: intent.deletions.map(event => eventView(event, project.id)) }); return true;
    }
    if (path === 'sync' && req.method === 'POST') {
      if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'planFingerprint') || body.planFingerprint !== undefined && (typeof body.planFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(body.planFingerprint))) fail(400, 'Use a valid campaign plan fingerprint.');
      const initial = planIntent(store, project.id, connection.calendarId, [], db);
      const result = await operation({ ...context, body: { planFingerprint: body.planFingerprint || initial.fingerprint } }, async () => {
        const legacyHash = createHash('sha256').update(JSON.stringify({ body: {}, method: req.method, path: url.pathname })).digest('hex');
        if (db.prepare("SELECT id FROM integration_operations WHERE project_id=? AND request_key<>? AND status IN ('pending','uncertain') AND (action_path='POST /calendar/sync' OR (action_path='' AND request_hash=?))").get(project.id, req.headers['idempotency-key'], legacyHash)) fail(409, 'Review the earlier unconfirmed Calendar plan sync before publishing another plan.');
        const native = await list(true), intent = planIntent(store, project.id, connection.calendarId, native, db), { plan, snapshot, deletions, deletionSnapshot, fingerprint } = intent;
        if (initial.snapshot !== snapshot || body.planFingerprint !== undefined && body.planFingerprint !== fingerprint) fail(409, 'The campaign plan changed. Review it again before publishing.');
        if (deletions.length && body.planFingerprint === undefined) fail(409, 'Review the exact obsolete app-managed events before removing them from Google Calendar.');
        if (deletions.some(event => !event.etag)) fail(502, 'Google did not provide a revision for an obsolete event. Refresh the reviewed plan before publishing.');
        const existing = new Map(native.map(event => [event.id, event]));
        for (const event of plan) if (existing.has(event.id)) {
          const fields = existing.get(event.id).extendedProperties?.private, expected = event.extendedProperties.private;
          if (!planIdentity(existing.get(event.id), project.id) || fields?.ten98ProjectId !== project.id || fields.ten98Collection !== expected.ten98Collection || fields.ten98RecordId !== expected.ten98RecordId || fields.ten98AccountId !== expected.ten98AccountId || fields.ten98Generation !== expected.ten98Generation) fail(409, 'A planned event ID belongs to another calendar event. No changes were sent.');
          if (!existing.get(event.id).etag) fail(502, 'Google did not provide a revision for a planned event. Refresh the reviewed plan before publishing.');
        }
        let created = 0, updated = 0, deleted = 0;
        // ponytail: compare at most 100 plan items; use per-record revisions if plans grow.
        const assertPlan = () => { if (planIntent(store, project.id, connection.calendarId, [], db).snapshot !== snapshot) fail(409, 'The campaign plan changed during sync. Refresh it before publishing again.'); };
        try {
          assertPlan();
          for (const event of plan) {
            if (existing.has(event.id)) { await call('/' + event.id + '?sendUpdates=none', 'PATCH', event, existing.get(event.id).etag); updated++; }
            else { await call('?sendUpdates=none', 'POST', event); created++; }
            assertPlan();
          }
          if (deletions.length) {
            const current = planIntent(store, project.id, connection.calendarId, await list(true), db);
            if (current.snapshot !== snapshot || current.deletionSnapshot !== deletionSnapshot) fail(409, 'The obsolete Google events changed. Review the plan again before removing them.');
            for (const event of deletions) {
              assertPlan();
              rememberGeneration(planIdentity(event, project.id), true);
              await call('/' + event.id + '?sendUpdates=none', 'DELETE', undefined, event.etag); deleted++;
              assertPlan();
            }
          }
        } catch (error) {
          if ((created || updated || deleted) && error instanceof IntegrationError) error.uncertain = true;
          throw error;
        }
        store.activity(project.id, `Published ${plan.length} planned items to Google Calendar.`);
        return { created, updated, deleted, total: plan.length };
      }, ['calendar-plan', connection.calendarId]); send(result.status, result.data); return true;
    }
    const match = path.match(/^events(?:\/([a-v0-9]{5,1024}))?$/);
    if (!match) fail(404, 'Calendar action not found.');
    const eventId = match[1];
    if ((req.method === 'POST' && eventId) || (['PATCH', 'DELETE'].includes(req.method) && !eventId)) fail(405, 'This calendar action is not available.');
    const result = await operation(context, async key => {
      const managed = eventId ? (await list(true)).find(event => event.id === eventId && event.extendedProperties?.private?.ten98ProjectId === project.id) : undefined;
      if (eventId && !managed) fail(404, 'An app-managed event was not found in this project.');
      if (managed && !managed.etag) fail(502, 'Google did not provide the event revision. Refresh the event before changing it.');
      if (managed && (typeof body?.etag !== 'string' || !body.etag || body.etag.length > 1024 || typeof body.calendarId !== 'string')) fail(400, 'Review the event revision and shared calendar before changing it.');
      if (managed && (body.etag !== managed.etag || body.calendarId !== connection.calendarId)) fail(409, 'The reviewed event or calendar changed. Load and review the event again.');
      if (req.method === 'DELETE') { rememberGeneration(planIdentity(managed, project.id), true); await call('/' + eventId + '?sendUpdates=none', 'DELETE', undefined, managed.etag); return { deleted: true }; }
      const id = eventId || 'ten98' + createHash('sha256').update(project.id + ':' + key).digest('hex');
      const event = { id, summary: text(body.summary), description: body.description ? text(body.description, 8000) : '', ...range(body), visibility: 'private', extendedProperties: { private: managed?.extendedProperties.private || { ten98ProjectId: project.id, ten98Collection: 'events' } } };
      const saved = await call(eventId ? '/' + eventId + '?sendUpdates=none' : '?sendUpdates=none', eventId ? 'PATCH' : 'POST', event, managed?.etag);
      store.activity(project.id, 'Google Calendar event saved.'); return { event: eventView(saved, project.id) };
    }, ['calendar-plan', connection.calendarId]); send(result.status, result.data); return true;
  } catch (error) { send(error instanceof IntegrationError ? error.status : 500, { error: { code: error.code || 'CALENDAR_ERROR', message: error instanceof IntegrationError ? error.message : 'The calendar action could not be completed.' } }); return true; }
}
