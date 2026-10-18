import React, { useEffect, useRef, useState } from 'react';

type Health = { status: string; canPost?: boolean; canFetchAnalytics?: boolean; tokenValid?: boolean; tokenExpiresAt?: string; needsReconnect?: boolean; issues: string[]; recommendations: string[]; tokenStatus?: { valid?: boolean; needsRefresh?: boolean; expiresAt?: string; expiresIn?: string }; permissions?: { canPost?: boolean; canFetchAnalytics?: boolean; missingRequired: string[]; posting: Permission[]; analytics: Permission[]; optional: Permission[] }; analyticsSync?: { status: string; lastSyncedAt?: string }; platformConnection?: { status: string; checkedAt?: string; phoneStatus?: string; inboundWebhookSubscribed?: boolean }; messagingRestriction?: { code?: number; subcode?: number; message?: string; firstSeenAt?: string; lastSeenAt?: string; pausedUntil?: string } };
type Permission = { scope: string; granted: boolean; required: boolean };
type Account = { _id: string; platform: string; displayName?: string; username?: string; isActive?: boolean; needsReconnection?: boolean; canReconnect?: boolean; health: Health | null };
type Props = { projectId: string; canManage: boolean; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>; onAccountsChanged?: (accounts: Account[]) => void };
const name = (account: Account) => account.displayName || account.username || account.platform;
const yes = (value?: boolean) => value === undefined || value === null ? 'Not reported' : value ? 'Yes' : 'No';
const when = (value?: string) => value ? new Date(value).toLocaleString() : 'Not reported';

export default function ZernioAccounts({ projectId, canManage, request, onAccountsChanged }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]), [loaded, setLoaded] = useState(false), [selectedId, setSelectedId] = useState(''), [detail, setDetail] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [authUrl, setAuthUrl] = useState('');
  const [draft, setDraft] = useState({ displayName: '', username: '', analytics: '', inbox: '' });
  const active = useRef(true), scope = useRef(''), busyRef = useRef(false), reads = useRef(0), keys = useRef(new Map<string, string>()), callback = useRef(onAccountsChanged), requester = useRef(request);
  callback.current = onAccountsChanged; requester.current = request;
  const path = `/projects/${encodeURIComponent(projectId)}/integrations/accounts`, view = path; scope.current = view;
  const selected = accounts.find(account => account._id === selectedId), current = () => active.current && scope.current === view;
  useEffect(() => {
    active.current = true; busyRef.current = false; setBusy(false); setAccounts([]); setLoaded(false); setSelectedId(''); setDetail(null); setError(''); setNotice(''); setAuthUrl(''); keys.current.clear();
    action(loadAccounts);
    return () => { active.current = false; reads.current++; };
  }, [path]);
  async function action(run: () => Promise<void>) {
    if (!current() || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try { await run(); } catch (failure) { if (current()) setError((failure as Error).message || 'The account action could not be completed.'); }
    finally { if (current()) { busyRef.current = false; setBusy(false); } }
  }
  async function loadAccounts() {
    const read = ++reads.current, response = await requester.current(`${path}/health`);
    if (!current() || reads.current !== read) return;
    if (!Array.isArray(response.accounts)) throw new Error('The connection health list could not be read.');
    setAccounts(response.accounts); setLoaded(true); setDetail(null); setAuthUrl('');
    if (!response.accounts.some((account: Account) => account._id === selectedId)) setSelectedId('');
    callback.current?.(response.accounts);
  }
  function choose(account: Account) {
    setSelectedId(account._id); setDetail(null); setAuthUrl(''); setError(''); setNotice('');
    setDraft({ displayName: account.displayName || '', username: account.username || '', analytics: '', inbox: '' });
  }
  async function checkSelected() {
    if (!selected) return;
    const accountId = selected._id, read = ++reads.current, response = await requester.current(`${path}/${encodeURIComponent(accountId)}/health`);
    if (!current() || reads.current !== read) return;
    if (response.account?._id !== accountId || response.health?.accountId !== accountId) throw new Error('The selected account health could not be read.');
    setDetail(response.health); setAuthUrl(''); setNotice('Connection health checked.');
  }
  async function write(task: string, body: unknown) {
    if (!selected || !current()) throw new DOMException('The account view changed.', 'AbortError');
    const target = `${path}/${encodeURIComponent(selected._id)}/${task}`, fingerprint = `${target}:${JSON.stringify(body)}`;
    let key = keys.current.get(fingerprint); if (!key) { key = crypto.randomUUID(); keys.current.set(fingerprint, key); }
    try { const response = await requester.current(target, 'POST', body, key); keys.current.delete(fingerprint); if (!current()) throw new DOMException('The account view changed.', 'AbortError'); return response; }
    catch (failure) { const receipt = failure as Error & { status?: number; code?: string; operation?: { status?: string } }; if (receipt.status && receipt.status < 500 && !['OPERATION_UNCERTAIN', 'OPERATION_IN_PROGRESS', 'OPERATION_PENDING'].includes(receipt.code || '') && !['uncertain', 'pending'].includes(receipt.operation?.status || '')) keys.current.delete(fingerprint); throw failure; }
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await action(async () => {
      const body: { displayName: string; username: string; xCapabilities?: Record<string, boolean> } = { displayName: draft.displayName, username: draft.username };
      const toggles = Object.fromEntries(['analytics', 'inbox'].filter(key => draft[key as 'analytics' | 'inbox']).map(key => [key, draft[key as 'analytics' | 'inbox'] === 'true']));
      if (selected?.platform === 'twitter' && Object.keys(toggles).length) body.xCapabilities = toggles;
      await write('update', body); if (current()) setNotice('Account settings confirmed with Zernio.'); await loadAccounts();
    });
  }
  async function reconnect() {
    if (!selected) return;
    await action(async () => {
      const response = await requester.current(`${path}/${encodeURIComponent(selected._id)}/reconnect`);
      if (!current()) return;
      let url; try { url = new URL(response.authUrl); } catch { throw new Error('The reconnection link could not be read.'); }
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('The reconnection link is invalid.');
      setAuthUrl(url.href); setNotice('Continue with the same platform account and accept all requested permissions. Refresh health after returning.');
    });
  }
  async function disconnect() {
    if (!selected || !window.confirm(`Disconnect “${name(selected)}” from Zernio? Scheduled posts, messages and advertising that use this connection may stop working. Existing provider campaigns are not paused by this action.`)) return;
    await action(async () => { await write('disconnect', { confirmAccountId: selected._id }); if (current()) { setSelectedId(''); setNotice('Account disconnected from Zernio.'); } await loadAccounts(); });
  }
  const shown = detail || selected?.health;
  return <section className="panel settings-panel">
    <div className="panel-heading"><div><h2>Connection health</h2><p>Check the accounts available to this project and repair access.</p></div><button type="button" className="button" disabled={busy} onClick={() => action(loadAccounts)}>{busy ? 'Working…' : 'Refresh connections'}</button></div>
    {error && <p className="alert" role="alert">{error}</p>}{notice && <p className="helper-note" role="status">{notice}</p>}
    {loaded && !accounts.length && <p>No Zernio accounts are connected to this project.</p>}
    {accounts.length > 0 && <div className="table-scroll"><table><thead><tr><th>Account</th><th>Platform</th><th>Health</th><th>Action</th></tr></thead><tbody>{accounts.map(account => <tr key={account._id}>
      <td><strong>{name(account)}</strong>{account.username && <><br/><small>{account.username}</small></>}</td><td>{account.platform}</td><td>{account.isActive === false ? 'Inactive' : account.health?.status || 'Not checked'}{(account.needsReconnection || account.health?.needsReconnect) && <><br/><small>Reconnection needed</small></>}</td><td><button type="button" className="button" disabled={busy} aria-pressed={selectedId === account._id} onClick={() => choose(account)}>Manage {name(account)}</button></td>
    </tr>)}</tbody></table></div>}
    {selected && <div className="settings-panel">
      <h3>{name(selected)}</h3><button type="button" className="button" disabled={busy} onClick={() => action(checkSelected)}>Check detailed health</button>
      {shown && <>
        <p>Health: <strong>{shown.status}</strong> · Token valid: {yes(detail ? shown.tokenStatus?.valid : shown.tokenValid)} · Can publish: {yes(detail ? shown.permissions?.canPost : shown.canPost)} · Can read analytics: {yes(detail ? shown.permissions?.canFetchAnalytics : shown.canFetchAnalytics)}</p>
        {(shown.tokenStatus?.expiresAt || shown.tokenExpiresAt) && <p className="helper-note">Token expires: {when(shown.tokenStatus?.expiresAt || shown.tokenExpiresAt)}{shown.tokenStatus?.needsRefresh ? ' · Refresh required soon' : ''}</p>}
        {shown.analyticsSync && <p>Analytics synchronization: <strong>{shown.analyticsSync.status.replaceAll('_', ' ')}</strong> · Last success: {when(shown.analyticsSync.lastSyncedAt)}</p>}
        {shown.platformConnection && <><p>WhatsApp platform link: <strong>{shown.platformConnection.status}</strong> · Inbound webhook subscribed: {yes(shown.platformConnection.inboundWebhookSubscribed)}</p><p className="helper-note">Checked {when(shown.platformConnection.checkedAt)}. A valid token alone does not confirm that the WhatsApp number can send or receive. Reconnect if the link is disconnected or the inbound webhook is missing.</p></>}
        {shown.messagingRestriction && <p className="alert">Messaging restriction observed on a previous send: {shown.messagingRestriction.message || shown.messagingRestriction.code || shown.messagingRestriction.subcode || 'Provider restriction'}.{shown.messagingRestriction.pausedUntil && ` Retry paused until ${when(shown.messagingRestriction.pausedUntil)}.`} This is an observed restriction, not a new live send test.</p>}
        {shown.issues.length > 0 && <><h4>Issues</h4><ul>{shown.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></>}
        {shown.recommendations.length > 0 && <><h4>Recommended action</h4><ul>{shown.recommendations.map((item, index) => <li key={index}>{item}</li>)}</ul></>}
        {shown.permissions && <details><summary>Permission details</summary>{shown.permissions.missingRequired.length > 0 && <p className="alert">Missing required permissions: {shown.permissions.missingRequired.join(', ')}</p>}<div className="table-scroll"><table><thead><tr><th>Use</th><th>Permission</th><th>Granted</th><th>Required</th></tr></thead><tbody>{(['posting', 'analytics', 'optional'] as const).flatMap(kind => shown.permissions![kind].map(permission => <tr key={kind + ':' + permission.scope}><td>{kind}</td><td>{permission.scope}</td><td>{yes(permission.granted)}</td><td>{yes(permission.required)}</td></tr>))}</tbody></table></div></details>}
      </>}
      {canManage && <>
        <div className="button-row">{selected.canReconnect && <button type="button" className="button" disabled={busy} onClick={reconnect}>Reconnect account</button>}{authUrl && <a className="button primary" href={authUrl} target="_blank" rel="noopener noreferrer">Continue reconnection</a>}<button type="button" className="button danger" disabled={busy} onClick={disconnect}>Disconnect account</button></div>
        {!selected.canReconnect && <p className="helper-note">This account uses a credential or platform-specific connection flow. Update it in its connection settings.</p>}
        <details><summary>Account settings</summary><form onSubmit={save}><fieldset disabled={busy}>
          <div className="form-grid"><label className="field"><span>Display name override</span><input maxLength={200} value={draft.displayName} onChange={event => setDraft({ ...draft, displayName: event.target.value })}/></label><label className="field"><span>Username override</span><input maxLength={200} value={draft.username} onChange={event => setDraft({ ...draft, username: event.target.value })}/></label></div>
          {selected.platform === 'twitter' && <><p className="helper-note">X background analytics reads and inbox polling incur provider usage charges. Each setting is unchanged unless you choose Enable or Disable. Publishing remains available independently.</p>{(['analytics', 'inbox'] as const).map(key => <label key={key} className="field"><span>{key === 'analytics' ? 'X analytics reads' : 'X inbox polling'}</span><select value={draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.value })}><option value="">Leave unchanged</option><option value="true">Enable paid background reads</option><option value="false">Disable background reads</option></select></label>)}</>}
          <button className="button">Save account settings</button>
        </fieldset></form></details>
      </>}
    </div>}
  </section>;
}
