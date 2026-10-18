import { createHash } from 'node:crypto';
import { googleToken, providerRequest, operation, IntegrationError } from './integrations.mjs';

const fail = (status, message) => { throw new IntegrationError(status, 'CALENDAR_ERROR', message); };
const scope = 'https://www.googleapis.com/auth/calendar.events';
const DAY = 86400000;
const text = (value, max = 500) => { if (typeof value !== 'string' || !value.trim() || value.length > max) fail(400, 'Enter a valid calendar event title or description.'); return value.trim(); };
function isoDate(value) { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value; }
function range(body) {
  if (body.allDay !== undefined && typeof body.allDay !== 'boolean') fail(400, 'All-day must be true or false.');
  if (body.allDay) {
    if (!isoDate(body.start) || !isoDate(body.end) || body.end <= body.start) fail(400, 'All-day events need an end date after their start date. The end date is exclusive.');
    return { start: { date: body.start }, end: { date: body.end } };
  }
  const valid = value => typeof value === 'string' && isoDate(value.slice(0, 10)) && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  if (!valid(body.start) || !valid(body.end) || Date.parse(body.end) <= Date.parse(body.start)) fail(400, 'Choose valid start and end times with a timezone.');
  return { start: { dateTime: new Date(body.start).toISOString() }, end: { dateTime: new Date(body.end).toISOString() } };
}
export function calendarPlan(store, projectId) {
  const plan = [];
  for (const collection of ['campaigns', 'placements', 'posts']) for (const row of store.list(projectId, collection)) {
    if (row.sample) continue;
    const identity = `${projectId}:${collection}:${row.id}`, id = 'ten98' + createHash('sha256').update(identity).digest('hex');
    const privateFields = { ten98ProjectId: projectId, ten98RecordId: row.id, ten98Collection: collection };
    if (collection === 'posts' && row.scheduledAt) {
      if (!Number.isFinite(Date.parse(row.scheduledAt))) continue;
      plan.push({ id, summary: `Social · ${row.content.slice(0, 100)}`, description: 'Planned publishing time in ten98 Campaign. Calendar events do not publish social posts.', start: { dateTime: new Date(row.scheduledAt).toISOString() }, end: { dateTime: new Date(Date.parse(row.scheduledAt) + 1800000).toISOString() }, extendedProperties: { private: privateFields }, visibility: 'private' });
    } else if (collection !== 'posts' && isoDate(row.startDate)) {
      const end = isoDate(row.endDate) && row.endDate >= row.startDate ? row.endDate : row.startDate;
      plan.push({ id, summary: `${collection === 'placements' ? 'OOH' : 'Campaign'} · ${row.name}`, description: row.location || row.description || '', start: { date: row.startDate }, end: { date: new Date(Date.parse(end) + DAY).toISOString().slice(0, 10) }, extendedProperties: { private: privateFields }, visibility: 'private' });
    }
  }
  // ponytail: synchronous sync caps at 100 records; use a queued worker for larger project plans.
  if (plan.length > 100) fail(400, 'This project has more than 100 dated records. Publish individual events or split the campaign plan into projects.');
  return plan;
}
const eventView = event => ({ id: event.id, summary: event.summary || '(Untitled event)', description: event.description || '', start: event.start, end: event.end, htmlLink: event.htmlLink, status: event.status, managed: Boolean(event.extendedProperties?.private?.ten98ProjectId), projectId: event.extendedProperties?.private?.ten98ProjectId });

export async function handleCalendar(context) {
  const { req, url, project, user, role, db, body, store, send } = context;
  if (!url.pathname.startsWith(`/api/projects/${project.id}/calendar/`)) return false;
  const path = url.pathname.split('/calendar/')[1], env = context.config?.env || process.env;
  db.exec('CREATE TABLE IF NOT EXISTS calendar_connections(project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,calendar_id TEXT UNIQUE NOT NULL)');
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
    const currentMapping = () => db.prepare('SELECT calendar_id FROM calendar_connections WHERE project_id=?').get(project.id)?.calendar_id === connection.calendarId;
    const call = async (suffix = '', method = 'GET', payload) => {
      if (!currentMapping()) fail(409, 'The calendar mapping changed. Refresh this project.');
      const result = await providerRequest(base + suffix, { method, headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json' } : {}) }, ...(payload ? { body: JSON.stringify(payload) } : {}) }, 'Google Calendar');
      if (!currentMapping()) throw new IntegrationError(409, 'CALENDAR_MAPPING_CHANGED', 'The calendar mapping changed while the request was in progress. Review the provider outcome.', method !== 'GET');
      return result;
    };
    async function list(managedOnly = false) {
      let pageToken; const events = [];
      const from = url.searchParams.get('fromDate'), to = url.searchParams.get('toDate');
      if ((from && !isoDate(from)) || (to && !isoDate(to)) || (from && to && (from > to || Date.parse(to) - Date.parse(from) > 366 * DAY))) fail(400, 'Choose a valid calendar window of at most 366 days.');
      for (let page = 0; page < 10; page++) {
        const query = new URLSearchParams({ maxResults: '250', singleEvents: 'true', ...(managedOnly ? { privateExtendedProperty: `ten98ProjectId=${project.id}` } : { orderBy: 'startTime', timeMin: from ? from + 'T00:00:00Z' : new Date(Date.now() - 30 * DAY).toISOString(), timeMax: to ? new Date(Date.parse(to) + DAY).toISOString() : new Date(Date.now() + 90 * DAY).toISOString() }), ...(pageToken ? { pageToken } : {}) });
        const data = await call('?' + query);
        if (!Array.isArray(data.items)) fail(502, 'Google Calendar returned an unreadable event list.');
        events.push(...data.items);
        if (!data.nextPageToken) return events;
        if (data.nextPageToken === pageToken) break;
        pageToken = data.nextPageToken;
      }
      fail(503, 'The calendar exceeds this view’s event limit. No complete result is available.');
    }
    if (path === 'events' && req.method === 'GET') { send(200, { events: (await list()).map(eventView), complete: true }); return true; }
    if (path === 'sync' && req.method === 'POST') {
      const plan = calendarPlan(store, project.id), existing = new Map((await list(true)).map(event => [event.id, event]));
      const result = await operation(context, async () => {
        let created = 0, updated = 0;
        for (const event of plan) {
          if (existing.has(event.id)) { await call('/' + event.id + '?sendUpdates=none', 'PATCH', event); updated++; }
          else { await call('?sendUpdates=none', 'POST', event); created++; }
        }
        store.activity(project.id, `Published ${plan.length} planned items to Google Calendar.`);
        return { created, updated, total: plan.length };
      }); send(result.status, result.data); return true;
    }
    const match = path.match(/^events(?:\/([a-v0-9]{5,1024}))?$/);
    if (!match) fail(404, 'Calendar action not found.');
    const eventId = match[1];
    if ((req.method === 'POST' && eventId) || (['PATCH', 'DELETE'].includes(req.method) && !eventId)) fail(405, 'This calendar action is not available.');
    const result = await operation(context, async key => {
      if (eventId && !(await list(true)).some(event => event.id === eventId && event.extendedProperties?.private?.ten98ProjectId === project.id)) fail(404, 'An app-managed event was not found in this project.');
      if (req.method === 'DELETE') { await call('/' + eventId + '?sendUpdates=none', 'DELETE'); return { deleted: true }; }
      const id = eventId || 'ten98' + createHash('sha256').update(project.id + ':' + key).digest('hex');
      const event = { id, summary: text(body.summary), description: body.description ? text(body.description, 8000) : '', ...range(body), visibility: 'private', extendedProperties: { private: { ten98ProjectId: project.id, ten98Collection: 'events' } } };
      const saved = await call(eventId ? '/' + eventId + '?sendUpdates=none' : '?sendUpdates=none', eventId ? 'PATCH' : 'POST', event);
      if (!saved.id) throw new IntegrationError(502, 'CALENDAR_UNCERTAIN', 'Google did not confirm the calendar event.', true);
      store.activity(project.id, 'Google Calendar event saved.'); return { event: eventView(saved) };
    }); send(result.status, result.data); return true;
  } catch (error) { send(error instanceof IntegrationError ? error.status : 500, { error: { code: error.code || 'CALENDAR_ERROR', message: error instanceof IntegrationError ? error.message : 'The calendar action could not be completed.' } }); return true; }
}
