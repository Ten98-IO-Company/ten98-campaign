import React, { useEffect, useRef, useState } from 'react';

type Account = { _id: string; platform: string; displayName?: string; username?: string; isActive?: boolean; canCreate: boolean; canRename: boolean; canDiagnose: boolean };
type NativeAccount = { id: string; name?: string; currency?: string; selectable?: boolean };
type Tag = { id: string; name: string; platform: string; status: string; siteTagId?: string; code?: string; installed?: boolean; isUnavailable?: boolean; lastFiredTime?: number | null; ownerAdAccountId?: string; autoTagging?: boolean };
type Event = { id: string; name: string; type?: string; siteEventId?: string; status?: string };
type Check = { key?: string; title?: string; description?: string; result?: string };
type Props = { projectId: string; canManage: boolean; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any> };
const labels: Record<string, string> = { metaads: 'Meta', googleads: 'Google', linkedinads: 'LinkedIn', tiktokads: 'TikTok', pinterestads: 'Pinterest', xads: 'X', openaiads: 'ChatGPT', redditads: 'Reddit' };
const eventTypes = [['order_created', 'Purchase'], ['lead_created', 'Lead'], ['items_added', 'Add to cart'], ['contents_viewed', 'View content'], ['checkout_started', 'Start checkout'], ['registration_completed', 'Registration'], ['subscription_created', 'Subscription'], ['trial_started', 'Trial'], ['appointment_scheduled', 'Appointment'], ['page_viewed', 'Page view'], ['app_installed', 'App install'], ['app_opened', 'App open']];

export default function ZernioMeasurement({ projectId, canManage, request }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]), [nativeAccounts, setNativeAccounts] = useState<NativeAccount[]>([]), [tags, setTags] = useState<Tag[]>([]);
  const [accountId, setAccountId] = useState(''), [adAccountId, setAdAccountId] = useState(''), [selected, setSelected] = useState<Tag | null>(null), [events, setEvents] = useState<Event[] | null>(null), [checks, setChecks] = useState<Check[] | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const requester = useRef(request), keys = useRef(new Map<string, string>()), mounted = useRef(true), busyRef = useRef(false), reads = useRef(0); requester.current = request;
  const path = `/projects/${encodeURIComponent(projectId)}/integrations/measurement`, identity = JSON.stringify([path, accountId, adAccountId, canManage]), scope = useRef({ identity });
  if (scope.current.identity !== identity) scope.current = { identity };
  const view = scope.current, current = () => mounted.current && scope.current === view, account = accounts.find(row => row._id === accountId);
  useEffect(() => { busyRef.current = false; setBusy(false); }, [identity]);
  useEffect(() => {
    let active = true; mounted.current = true; keys.current.clear(); busyRef.current = false; setBusy(false); setAccounts([]); setAccountId(''); setLoading(true); setError('');
    requester.current(`${path}/accounts`).then(response => { if (active) setAccounts(response.accounts); }).catch(failure => { if (active) setError(failure.message || 'Measurement connections could not be loaded.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; mounted.current = false; reads.current++; };
  }, [path, canManage]);
  useEffect(() => {
    let active = true; reads.current++; setNativeAccounts([]); setAdAccountId(''); setTags([]); setSelected(null); setEvents(null); setChecks(null); setLoaded(false); setError(''); setNotice('');
    if (!accountId) return;
    setLoading(true);
    requester.current(`${path}/${encodeURIComponent(accountId)}/ad-accounts`).then(response => { if (active) setNativeAccounts(response.accounts); }).catch(failure => { if (active) setError(failure.message || 'Advertising accounts could not be loaded.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, accountId]);
  useEffect(() => {
    let active = true; reads.current++; setTags([]); setSelected(null); setEvents(null); setChecks(null); setLoaded(false); setError(''); setNotice('');
    if (!accountId || !adAccountId) return;
    setLoading(true);
    requester.current(`${path}/${encodeURIComponent(accountId)}/tags?adAccountId=${encodeURIComponent(adAccountId)}`).then(response => { if (active) { setTags(response.tags); setLoaded(true); } }).catch(failure => { if (active) setError(failure.message || 'Tracking tags could not be loaded.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [path, accountId, adAccountId]);
  const target = `${path}/${encodeURIComponent(accountId)}/tags`, query = `?adAccountId=${encodeURIComponent(adAccountId)}`;
  async function action(run: () => Promise<void>) {
    if (!current() || busyRef.current) return; busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try { await run(); } catch (failure) { if (current()) setError((failure as Error).message || 'The measurement action could not be completed.'); }
    finally { if (current()) { busyRef.current = false; setBusy(false); } }
  }
  async function refresh() {
    if (!current()) return;
    const response = await requester.current(target + query); if (current()) { setTags(response.tags); setLoaded(true); }
  }
  async function inspect(row: Tag) {
    await action(async () => {
      const read = ++reads.current, response = await requester.current(`${target}/${encodeURIComponent(row.id)}${query}`);
      if (!current() || reads.current !== read) return;
      if (response.tag?.id !== row.id) throw new Error('The tracking tag details could not be read.');
      setSelected(response.tag); setEvents(null); setChecks(null);
    });
  }
  async function loadMore(kind: 'events' | 'diagnostics') {
    if (!selected) return;
    await action(async () => {
      const read = ++reads.current, response = await requester.current(`${target}/${encodeURIComponent(selected.id)}/${kind}${query}`);
      if (!current() || reads.current !== read) return;
      if (kind === 'events') setEvents(response.events); else setChecks(response.checks);
    });
  }
  async function write(route: string, body: Record<string, unknown>) {
    if (!current()) throw new DOMException('The measurement view changed.', 'AbortError');
    const fingerprint = `${route}:${JSON.stringify(body)}`; let key = keys.current.get(fingerprint); if (!key) { key = crypto.randomUUID(); keys.current.set(fingerprint, key); }
    try {
      const response = await requester.current(route, 'POST', body, key);
      if (!response.tag || typeof response.tag.id !== 'string' || response.platform !== account?.platform) throw new Error('The tag change receipt could not be read. Your action key has been retained.');
      keys.current.delete(fingerprint); if (!current()) throw new DOMException('The measurement view changed.', 'AbortError'); return response.tag as Tag;
    } catch (failure) { const receipt = failure as Error & { status?: number; code?: string; operation?: { status?: string } }; if (receipt.status && receipt.status < 500 && !['OPERATION_UNCERTAIN', 'OPERATION_IN_PROGRESS', 'OPERATION_PENDING'].includes(receipt.code || '') && !['uncertain', 'pending'].includes(receipt.operation?.status || '')) keys.current.delete(fingerprint); throw failure; }
  }
  async function save(event: React.FormEvent<HTMLFormElement>, creating: boolean) {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget));
    await action(async () => {
      const body = { adAccountId, name: String(values.name || ''), ...(creating && values.defaultEventType ? { defaultEventType: String(values.defaultEventType) } : {}) };
      const receipt = await write(creating ? `${target}/create` : `${target}/${encodeURIComponent(selected!.id)}/update`, body);
      setSelected(receipt); setEvents(null); setChecks(null); setNotice(creating ? 'Tracking tag confirmed. Creating it does not install it on your website.' : 'Tracking tag name confirmed.'); await refresh();
    });
  }
  return <section className="panel settings-panel">
    <div className="panel-heading"><div><h2>Pixels and tracking tags</h2><p>Find the pixel used by an advertising campaign and inspect its website installation.</p></div>{adAccountId && <button className="button" type="button" disabled={busy || loading} onClick={() => action(refresh)}>Refresh tags</button>}</div>
    {error && <p className="alert" role="alert">{error}</p>}{notice && <p className="helper-note" role="status">{notice}</p>}
    <fieldset disabled={busy || loading}><div className="form-grid">
      <label className="field"><span>Advertising connection</span><select value={accountId} onChange={event => setAccountId(event.target.value)}><option value="">{loading && !accounts.length ? 'Loading connections…' : 'Choose a connection'}</option>{accounts.map(row => <option key={row._id} value={row._id}>{labels[row.platform]} · {row.displayName || row.username || row._id}{row.isActive === false ? ' · Inactive' : ''}</option>)}</select></label>
      {accountId && <label className="field"><span>Advertising account</span><select value={adAccountId} onChange={event => setAdAccountId(event.target.value)}><option value="">Choose an advertising account</option>{nativeAccounts.map(row => <option key={row.id} value={row.id}>{row.name || row.id}{row.currency ? ` · ${row.currency}` : ''}</option>)}</select></label>}
    </div></fieldset>
    {!loading && !accounts.length && <p>Connect an advertising account in Integrations to manage measurement.</p>}
    {loaded && !tags.length && <p>No tracking tags were reported for this advertising account.</p>}
    {account?.platform === 'redditads' && <p className="helper-note">Reddit requires a pixel for every campaign goal. Create pixels and inspect installation in Reddit Ads Manager, then refresh here. Website conversions require the chosen event to have fired; website leads require Lead. Pixels shown belong to the selected advertising account.</p>}
    {tags.length > 0 && <div className="table-scroll"><table><thead><tr><th>Tag</th><th>Campaign pixel ID</th><th>Status</th><th>Action</th></tr></thead><tbody>{tags.map(row => <tr key={row.id}><td>{row.name}</td><td><code>{row.id}</code></td><td>{row.status}{row.isUnavailable ? ' · Unavailable' : ''}</td><td><button className="button" type="button" disabled={busy || loading} onClick={() => inspect(row)}>Inspect {row.name}</button></td></tr>)}</tbody></table></div>}
    {canManage && account?.canCreate && adAccountId && <details><summary>Create a tracking tag</summary><p className="helper-note">Create only after checking the existing tags. An uncertain creation must be reviewed before another pixel is created. This does not change your website.</p>{account.platform === 'openaiads' && <p className="helper-note">ChatGPT also provisions a Conversions API key. Partner access is required, and a failed setup can leave a pixel behind. Inspect the provider before retrying.</p>}{account.platform === 'googleads' && <p className="helper-note">Google reuses its existing tag. If conversion tracking has never been configured, this creates its first website conversion action.</p>}{['linkedinads', 'xads'].includes(account.platform) && <p className="helper-note">This platform allows one tag per advertising account and does not store the requested name.</p>}<form onSubmit={event => save(event, true)}><fieldset disabled={busy || loading || account.isActive === false}><label className="field"><span>Tag name</span><input name="name" required maxLength={account.platform === 'tiktokads' ? 40 : 200}/></label>{account.platform === 'openaiads' && <label className="field"><span>Initial conversion event (optional)</span><select name="defaultEventType"><option value="">No initial event</option>{eventTypes.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}<button className="button" disabled={!loaded}>Create tracking tag</button></fieldset></form></details>}
    {selected && <div className="settings-panel"><h3>{selected.name}</h3><p>Campaign pixel ID: <code>{selected.id}</code>{selected.siteTagId && <> · Website tag ID: <code>{selected.siteTagId}</code></>}</p>
      {selected.lastFiredTime != null && <p>Last reported event: {new Date(selected.lastFiredTime * 1000).toLocaleString()}</p>}{selected.installed === true && <p>This tag has received an event. That does not confirm every page or conversion is configured.</p>}{selected.installed === false && <p>No event has been reported for this tag.</p>}{selected.autoTagging !== undefined && <p>Google click auto-tagging: {selected.autoTagging ? 'Enabled' : 'Disabled'}</p>}
      {selected.code && <label className="field"><span>Website installation code</span><textarea readOnly rows={10} value={selected.code}/><small>Copy into the website’s tag installation after reviewing its consent settings. This app displays the code and does not execute it.</small></label>}
      {account?.platform !== 'redditads' && <div className="button-row"><button className="button" type="button" disabled={busy || loading} onClick={() => loadMore('events')}>Load conversion events</button>{account?.canDiagnose && <button className="button" type="button" disabled={busy || loading} onClick={() => loadMore('diagnostics')}>Check pixel diagnostics</button>}</div>}
      {events && <><h4>Conversion events</h4>{!events.length ? <p>No event definitions were reported. Standard pixel events can be received without a separate definition on some platforms.</p> : <div className="table-scroll"><table><thead><tr><th>Event</th><th>Type</th><th>Website event ID</th><th>Status</th></tr></thead><tbody>{events.map(row => <tr key={row.id}><td>{row.name}</td><td>{row.type || 'Not reported'}</td><td><code>{row.siteEventId || row.id}</code></td><td>{row.status || 'Not reported'}</td></tr>)}</tbody></table></div>}</>}
      {checks && <><h4>Provider diagnostics</h4>{!checks.length ? <p>No diagnostic checks were returned.</p> : <ul>{checks.map((row, index) => <li key={row.key || index}><strong>{row.title || row.key || 'Check'}: {row.result || 'No result reported'}</strong>{row.description && <p>{row.description}</p>}</li>)}</ul>}</>}
      {canManage && account?.canRename && <form key={selected.id + selected.name} onSubmit={event => save(event, false)}><fieldset disabled={busy || loading}><label className="field"><span>Tag name</span><input name="name" defaultValue={selected.name} required maxLength={200}/></label><button className="button">Rename tag</button></fieldset></form>}
    </div>}
  </section>;
}
