import React, { useEffect, useRef, useState } from 'react';
import { ReviewSummary } from '@ten98/ui';

type CalendarEvent = { id: string; etag?: string; summary: string; description?: string; start: { date?: string; dateTime?: string }; end: { date?: string; dateTime?: string }; htmlLink?: string; managed?: boolean; projectId?: string; plan?: { collection: string; recordId: string; accountId?: string } };
type PlanReview = { fingerprint: string; calendarId: string; projectId: string; upserts: (CalendarEvent & { action: string })[]; deletions: CalendarEvent[]; view: string };
type Props = { projectId: string; canWrite: boolean; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>; fromDate?: string; toDate?: string; onEvents?: (events: CalendarEvent[]) => void; onOpenIntegrations?: () => void };
const dateInput = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
const localTime = (value: string) => { const date = new Date(value); if (!Number.isFinite(date.getTime())) return ''; date.setMinutes(date.getMinutes() - date.getTimezoneOffset()); return date.toISOString().slice(0, 16); };
const providerLink = (value?: string) => { try { const url = new URL(value || ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; } };

export default function GoogleCalendar({ projectId, canWrite, request, fromDate, toDate, onEvents, onOpenIntegrations }: Props) {
  const today = new Date();
  const [status, setStatus] = useState<any>(null), [events, setEvents] = useState<CalendarEvent[]>([]), [loaded, setLoaded] = useState(false);
  const [from, setFrom] = useState(fromDate || dateInput(new Date(today.getFullYear(), today.getMonth(), 1))), [to, setTo] = useState(toDate || dateInput(new Date(today.getFullYear(), today.getMonth() + 1, 0)));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [editing, setEditing] = useState<string | null>(null);
  const [review, setReview] = useState<PlanReview | null>(null), [deleting, setDeleting] = useState<(CalendarEvent & { calendarId: string }) | null>(null);
  const blank = { summary: '', description: '', start: from + 'T12:00', end: from + 'T13:00', allDay: false, etag: '', calendarId: '' };
  const [draft, setDraft] = useState(blank), keys = useRef(new Map<string, string>()), callback = useRef(onEvents), active = useRef(true), scope = useRef('');
  callback.current = onEvents;
  const path = `/projects/${encodeURIComponent(projectId)}/calendar`, connected = Boolean(status?.configured && status?.mapped);
  const view = `${path}:${from}:${to}`; scope.current = view;
  useEffect(() => {
    active.current = true; let current = true; setStatus(null); setEvents([]); setLoaded(false); setError(''); setNotice(''); setEditing(null); setReview(null); setDeleting(null); keys.current.clear();
    request(`${path}/status`).then(result => { if (current) setStatus(result); }).catch(err => { if (current) setError(err.message || 'The calendar connection could not be read.'); });
    return () => { current = false; active.current = false; };
  }, [path, request]);
  useEffect(() => { if (fromDate) setFrom(fromDate); if (toDate) setTo(toDate); }, [fromDate, toDate]);
  useEffect(() => { setEvents([]); setLoaded(false); setReview(null); setDeleting(null); callback.current?.([]); }, [from, to]);
  function updateEvents(items: CalendarEvent[]) { if (active.current && scope.current === view) { setEvents(items); callback.current?.(items); } }
  async function action(run: () => Promise<void>) {
    if (busy) return; setBusy(true); setError(''); setNotice('');
    try { await run(); } catch (err) { if (active.current && scope.current === view) setError((err as Error).message || 'The calendar action could not be completed.'); }
    finally { if (active.current) setBusy(false); }
  }
  async function write(suffix: string, method: string, body?: unknown) {
    if (!active.current || scope.current !== view) throw new DOMException('The calendar view changed.', 'AbortError');
    const fingerprint = `${method}:${path}/${suffix}:${JSON.stringify(body)}`;
    let key = keys.current.get(fingerprint); if (!key) { key = crypto.randomUUID(); keys.current.set(fingerprint, key); }
    try { const result = await request(`${path}/${suffix}`, method, body, key); keys.current.delete(fingerprint); if (!active.current || scope.current !== view) throw new DOMException('The calendar view changed.', 'AbortError'); return result; }
    catch (err) { const failure = err as Error & { status?: number; code?: string }; if (failure.status && failure.code !== 'OPERATION_UNCERTAIN') keys.current.delete(fingerprint); throw err; }
  }
  async function load() {
    if (!active.current || scope.current !== view) return;
    const first = new Date(from + 'T00:00'), last = new Date(to + 'T00:00'); last.setDate(last.getDate() + 1);
    const result = await request(`${path}/events?${new URLSearchParams({ fromDate: from, toDate: to, timeMin: first.toISOString(), timeMax: last.toISOString() })}`);
    if (!active.current || scope.current !== view) return;
    if (!Array.isArray(result.events)) throw new Error('The Google Calendar event list could not be read.');
    updateEvents(result.events); setLoaded(true);
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await action(async () => {
      const { etag, calendarId, ...fields } = draft;
      const body = { ...fields, ...(editing ? { etag, calendarId } : {}), start: draft.allDay ? draft.start : new Date(draft.start).toISOString(), end: draft.allDay ? draft.end : new Date(draft.end).toISOString() };
      await write('events' + (editing ? '/' + encodeURIComponent(editing) : ''), editing ? 'PATCH' : 'POST', body);
      setEditing(null); setDraft(blank); setNotice('Event saved to Google Calendar.');
      await load();
    });
  }
  async function reviewPlan() {
    await action(async () => {
      const plan = await request(path + '/plan');
      if (!active.current || scope.current !== view) return;
      if (typeof plan.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(plan.fingerprint) || plan.projectId !== projectId || plan.calendarId !== status.calendarId || !Array.isArray(plan.upserts) || !Array.isArray(plan.deletions)) throw new Error('The campaign plan preview could not be read.');
      setReview({ ...plan, view });
    });
  }
  async function syncPlan() {
    if (!canWrite || !review || review.view !== view || review.calendarId !== status.calendarId) return;
    await action(async () => {
      const result = await write('sync', 'POST', { planFingerprint: review.fingerprint });
      setReview(null); setNotice(`Published campaign plan: ${result.created} events created, ${result.updated} updated, ${result.deleted || 0} obsolete app events removed.`); await load();
    });
  }
  async function removeEvent() {
    if (!canWrite || !deleting) return;
    await action(async () => {
      await write('events/' + encodeURIComponent(deleting.id), 'DELETE', { etag: deleting.etag, calendarId: deleting.calendarId });
      updateEvents(events.filter(item => item.id !== deleting.id));
      if (editing === deleting.id) { setEditing(null); setDraft(blank); }
      setDeleting(null); setNotice('Google Calendar event deleted.');
    });
  }
  function edit(event: CalendarEvent) {
    setEditing(event.id); setDraft({ summary: event.summary, description: event.description || '', allDay: Boolean(event.start.date), start: event.start.date || localTime(event.start.dateTime || ''), end: event.end.date || localTime(event.end.dateTime || ''), etag: event.etag || '', calendarId: status.calendarId });
  }
  function when(value: { date?: string; dateTime?: string }) { return value.date || (value.dateTime ? new Date(value.dateTime).toLocaleString() : 'Time unavailable'); }
  return <section className="panel settings-panel">
    <div className="panel-heading"><div><h2>Google Calendar</h2><p>Share campaign dates with your team and manage project events.</p></div>{onOpenIntegrations && <button type="button" className="button" onClick={onOpenIntegrations}>Open Integrations</button>}</div>
    {error && <p className="alert" role="alert">{error}</p>}{notice && <p className="helper-note" role="status">{notice}</p>}
    {status && <p className="helper-note">{connected ? `Shared calendar: ${status.calendarId}` : 'Connect this project’s Google Calendar in Integrations.'}</p>}
    {connected && <>
      <div className="form-grid"><label className="field"><span>From date</span><input type="date" value={from} required disabled={busy} onChange={event => setFrom(event.target.value)}/></label><label className="field"><span>Through date</span><input type="date" value={to} min={from} required disabled={busy} onChange={event => setTo(event.target.value)}/></label></div>
      <div className="button-wrap"><button type="button" className="button" disabled={busy || !from || !to || to < from} onClick={() => action(load)}>{busy ? 'Working…' : 'Load Google events'}</button>{canWrite && <button type="button" className="button" disabled={busy} onClick={reviewPlan}>Review campaign plan for Google</button>}</div>
      <p className="helper-note">The plan covers this whole project, across all dates. Account customizations create separate events at each account’s publishing time. Publishing also removes obsolete plan events shown in the review; manually created and unrelated events are excluded. Calendar events do not publish social posts.</p>
      {review && review.view === view && canWrite && <ReviewSummary title="Review the exact Google changes" scope={`Project: ${review.projectId}`} resource={`Shared calendar: ${review.calendarId}`}
        description={`${review.upserts.length} planned events to create or update; ${review.deletions.length} obsolete app-managed plan events to delete.`}
        changes={[
          ...review.upserts.map(event => ({ id: event.id, label: `${event.action === 'create' ? 'Create' : 'Update'} · ${event.summary}`, before: event.action === 'create' ? 'No matching app-managed event in this plan.' : 'Existing Google event. Previous fields were not included in this preview.', after: <>{when(event.start)} – {when(event.end)}{event.description && <p style={{ whiteSpace: 'pre-wrap' }}>{event.description}</p>}</> })),
          ...review.deletions.map(event => ({ id: event.id, label: 'Delete obsolete plan event', before: <><strong>{event.summary}</strong><br/>{when(event.start)} – {when(event.end)}<br/><small>Event ID: {event.id}</small></>, after: 'Deleted from Google Calendar.' }))
        ]}
        consequences={<p>Only the listed obsolete events created from this project’s campaign plan will be deleted. Manually created and unrelated events are excluded. Calendar events do not publish social posts.</p>}
        actions={<div className="button-wrap"><button type="button" className="button primary" disabled={busy} onClick={syncPlan}>{review.deletions.length ? 'Publish reviewed plan and delete listed obsolete events' : 'Publish reviewed plan to Google'}</button><button type="button" className="button" disabled={busy} onClick={() => setReview(null)}>Cancel review</button></div>}/>
      }
      {deleting && canWrite && <section className="helper-note" aria-label="Confirm Google event deletion"><h3>Delete this Google event?</h3><p>{deleting.summary}<br/>{when(deleting.start)} – {when(deleting.end)}<br/>Shared calendar: {deleting.calendarId}<br/>Event ID: {deleting.id}</p><div className="button-wrap"><button type="button" className="button danger" disabled={busy} onClick={removeEvent}>Delete this event from Google</button><button type="button" className="button" disabled={busy} onClick={() => setDeleting(null)}>Cancel</button></div></section>}
      {loaded && !events.length && <p>No Google events in this date range.</p>}
      {events.length > 0 && <div className="table-scroll"><table><thead><tr><th>Google event</th><th>Start</th><th>End</th><th>Actions</th></tr></thead><tbody>{events.map(event => { const managed = event.managed && event.projectId === projectId, link = providerLink(event.htmlLink); return <tr key={event.id}>
        <td><strong>{event.summary}</strong><br/><small>{managed ? 'Managed by this project' : 'External calendar event'}{event.start.date ? ' · All day (exclusive end)' : ''}</small></td><td>{when(event.start)}</td><td>{when(event.end)}</td><td><div className="button-wrap">{link && <a href={link} target="_blank" rel="noopener noreferrer">Open in Google</a>}{managed && canWrite && <><button type="button" className="button" disabled={busy} onClick={() => edit(event)}>Edit</button><button type="button" className="button danger" disabled={busy} onClick={() => setDeleting({ ...event, calendarId: status.calendarId })}>Delete</button></>}</div></td>
      </tr>; })}</tbody></table></div>}
      {canWrite && <details open={editing ? true : undefined}><summary>{editing ? 'Edit project event' : 'Create a Google event'}</summary><form onSubmit={save}><fieldset disabled={busy}>
        <label className="field"><span>Event title *</span><input required maxLength={500} value={draft.summary} onChange={event => setDraft({ ...draft, summary: event.target.value })}/></label>
        <label className="field"><span>Description</span><textarea rows={3} maxLength={8000} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })}/></label>
        <label><input type="checkbox" checked={draft.allDay} onChange={event => { const allDay = event.target.checked; setDraft({ ...draft, allDay, start: allDay ? draft.start.slice(0, 10) : draft.start + 'T12:00', end: allDay ? draft.end.slice(0, 10) : draft.end + 'T13:00' }); }}/> All-day event</label>
        <div className="form-grid"><label className="field"><span>Start *</span><input type={draft.allDay ? 'date' : 'datetime-local'} required value={draft.start} onChange={event => setDraft({ ...draft, start: event.target.value })}/></label><label className="field"><span>{draft.allDay ? 'End date (exclusive) *' : 'End *'}</span><input type={draft.allDay ? 'date' : 'datetime-local'} required min={draft.start} value={draft.end} onChange={event => setDraft({ ...draft, end: event.target.value })}/></label></div>
        <p className="helper-note">Times use your browser’s timezone. An all-day event ending on Friday covers dates through Thursday.</p><div className="button-wrap"><button className="button primary">{editing ? 'Save Google event' : 'Create Google event'}</button>{editing && <button type="button" className="button" onClick={() => { setEditing(null); setDraft(blank); }}>Cancel edit</button>}</div>
      </fieldset></form></details>}
    </>}
  </section>;
}
