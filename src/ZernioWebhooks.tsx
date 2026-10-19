import { useEffect, useRef, useState } from 'react';

type Hook = { id: string; name: string; url: string; events: string[]; isActive: boolean; editable: boolean; excludedGroups: string[]; version: string; failureCount: number | null; lastFiredAt: string | null };
type Draft = { name: string; events: string[]; isActive: boolean };
type Delivery = { eventId: string; event: string; status: string; createdAt: string; test: boolean; statusCode: number | null; attemptNumber: number | null };
type Props = { projectId: string; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any> };
const empty = (): Draft => ({ name: 'Campaign updates', events: [], isActive: true });

// IntegrationSettings keys this editor by projectId, discarding drafts and ignoring late responses on project changes.
export default function ZernioWebhooks({ projectId, request }: Props) {
  const [overview, setOverview] = useState<{ url: string; profileId: string; events: string[]; secretConfigured: boolean; webhooks: Hook[] } | null>(null), [selectedId, setSelectedId] = useState(''), [draft, setDraft] = useState<Draft>(empty);
  const [logs, setLogs] = useState<Delivery[] | null>(null), [skip, setSkip] = useState(0), [hasMore, setHasMore] = useState(false), [confirmed, setConfirmed] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mounted = useRef(true), locked = useRef(false), keys = useRef(new Map<string, string>()), baseline = useRef(JSON.stringify(empty())), requester = useRef(request);
  requester.current = request;
  const path = `/projects/${encodeURIComponent(projectId)}/integrations/webhook-settings`, selected = overview?.webhooks.find(row => row.id === selectedId), dirty = JSON.stringify(draft) !== baseline.current;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  function choose(row?: Hook, events = overview?.events || []) {
    const next = row ? { name: row.name, events: [...row.events], isActive: row.isActive } : { ...empty(), events: [...events].sort() };
    setSelectedId(row?.id || ''); setDraft(next); baseline.current = JSON.stringify(next); setConfirmed(false); setLogs(null); setSkip(0); setHasMore(false);
  }
  async function action(work: () => Promise<void>) {
    if (locked.current || !mounted.current) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (failure) { if (mounted.current) setError((failure as Error).message || 'Webhook settings could not be read.'); }
    finally { locked.current = false; if (mounted.current) setBusy(false); }
  }
  async function load() {
    const result = await requester.current(path); if (!mounted.current) return;
    if (!Array.isArray(result.webhooks) || !Array.isArray(result.events)) throw new Error('Zernio did not return webhook settings.');
    keys.current.clear(); setOverview(result); choose(result.webhooks.find((row: Hook) => row.id === selectedId) || result.webhooks[0], result.events);
  }
  async function deliveries(offset = 0) {
    if (!selected) return;
    const result = await requester.current(`${path}/${selected.id}/logs?skip=${offset}`); if (!mounted.current) return;
    setLogs(result.logs); setSkip(result.skip); setHasMore(result.hasMore);
  }
  async function send(task: string, eventId?: string) {
    if (!confirmed || task !== 'create' && !selected) return;
    const body = { confirm: true, ...(task === 'create' || task === 'update' ? draft : {}), ...(selected ? { expectedVersion: selected.version } : {}), ...(eventId ? { eventId } : {}) };
    const intent = JSON.stringify({ task, id: selected?.id, body }), key = keys.current.get(intent) || crypto.randomUUID(); keys.current.set(intent, key);
    await action(async () => {
      await requester.current(`${path}/${task === 'create' ? 'create' : `${selected!.id}/${task}`}`, 'POST', body, key);
      if (!mounted.current) return;
      keys.current.delete(intent); setConfirmed(false);
      if (task === 'test' || task === 'redeliver') { await deliveries(0); if (mounted.current) setNotice(task === 'test' ? 'Test delivery accepted. Check delivery history.' : 'Redelivery accepted. Existing event IDs remain deduplicated.'); }
      else { await load(); if (mounted.current) setNotice(task === 'delete' ? 'Webhook removed. Local campaign data is retained.' : 'Webhook settings confirmed.'); }
    });
  }
  return <section className="panel integration-project-mappings">
    <div className="panel-heading"><div><h2>Zernio webhooks</h2><p>Receive supported campaign and inbox updates for this project.</p></div><button className="button" disabled={busy || dirty} onClick={() => action(load)}>{busy ? 'Working…' : overview ? 'Refresh webhooks' : 'Load webhooks'}</button></div>
    <div className="ad-tools-panel">
      {error && <p className="alert error" role="alert">{error}</p>}{notice && <p className="integration-notice" role="status">{notice}</p>}
      {overview && <>
        <p className="field-help">Endpoint: <code>{overview.url}</code><br/>Profile: <code>{overview.profileId}</code>. Other profiles and external endpoints are managed in Zernio.</p>
        {!overview.secretConfigured && <p className="alert">Save a webhook signing secret in Zernio connection settings above before creating or testing delivery.</p>}
        {overview.webhooks.length > 0 && <label className="field"><span>Webhook</span><select value={selectedId} disabled={busy || dirty} onChange={event => choose(overview.webhooks.find(row => row.id === event.target.value))}>{overview.webhooks.map(row => <option key={row.id} value={row.id}>{row.name}</option>)}</select></label>}
        {selected && <p className="field-help">{selected.isActive ? 'Delivery enabled' : 'Delivery paused'} · Consecutive failures: {selected.failureCount ?? 'Not reported'} · Last delivery: {selected.lastFiredAt ? new Date(selected.lastFiredAt).toLocaleString() : 'Not reported'}</p>}
        {selected && selected.excludedGroups.length > 0 && <p className="alert">Zernio excludes these event groups: {selected.excludedGroups.join(', ')}. Review provider permissions if their updates are needed.</p>}
        {selected && !selected.editable ? <p className="alert">This endpoint uses advanced filters, headers or unsupported events. Manage its settings in Zernio; its delivery history remains available below.</p> : <form onSubmit={event => { event.preventDefault(); send(selected ? 'update' : 'create'); }}><fieldset disabled={busy}>
          <label className="field"><span>Name</span><input value={draft.name} maxLength={50} required onChange={event => { setDraft({ ...draft, name: event.target.value }); setConfirmed(false); }}/></label>
          <label className="checkbox-label"><input type="checkbox" checked={draft.isActive} onChange={event => { setDraft({ ...draft, isActive: event.target.checked }); setConfirmed(false); }}/>Enable delivery</label>
          <details><summary>Subscribed events ({draft.events.length})</summary><div className="form-grid">{overview.events.map(event => <label className="checkbox-label" key={event}><input type="checkbox" checked={draft.events.includes(event)} onChange={change => { setDraft({ ...draft, events: (change.target.checked ? [...draft.events, event] : draft.events.filter(value => value !== event)).sort() }); setConfirmed(false); }}/>{event}</label>)}</div></details>
          <p className="field-help">Saving also applies this app’s saved signing secret. Tests send a synthetic event; redelivery replays an existing real event. Deleting stops future delivery and keeps local records.</p>
          <label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>I reviewed this profile’s endpoint, events and delivery state.</label>
          <div className="button-wrap"><button className="button primary" disabled={!confirmed || !overview.secretConfigured || !draft.events.length}>{selected ? 'Save webhook' : 'Create webhook'}</button>{dirty && <button type="button" className="button" onClick={() => choose(selected)}>Discard changes</button>}{selected && <><button type="button" className="button" disabled={!confirmed || dirty || !overview.secretConfigured} onClick={() => send('test')}>Send test event</button><button type="button" className="button danger" disabled={!confirmed || dirty} onClick={() => send('delete')}>Delete webhook</button></>}</div>
        </fieldset></form>}
        {selected && <><div className="button-wrap"><button className="button" disabled={busy || dirty} onClick={() => action(() => deliveries(0))}>Load delivery history</button></div>{logs && <><div className="table-scroll"><table><thead><tr><th>Event</th><th>Delivery</th><th>Attempt</th><th>Time</th><th>Action</th></tr></thead><tbody>{logs.map((row, index) => <tr key={`${row.eventId}:${index}`}><td>{row.event}{row.test && <small>Test</small>}<small>{row.eventId}</small></td><td>{row.status}{row.statusCode && ` · HTTP ${row.statusCode}`}</td><td>{row.attemptNumber ?? 'Not reported'}</td><td>{new Date(row.createdAt).toLocaleString()}</td><td>{row.status === 'failed' && !row.test && selected.editable && <button className="button" disabled={busy || dirty || !confirmed} onClick={() => send('redeliver', row.eventId)}>Redeliver event</button>}</td></tr>)}</tbody></table></div>{!logs.length && <p>No deliveries recorded for this webhook.</p>}<div className="button-wrap"><button className="button" disabled={busy || skip === 0} onClick={() => action(() => deliveries(Math.max(0, skip - 50)))}>Previous</button><button className="button" disabled={busy || !hasMore || skip >= 10000} onClick={() => action(() => deliveries(skip + 50))}>Next</button></div></>}</>}
      </>}
    </div>
  </section>;
}
