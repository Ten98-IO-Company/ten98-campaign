import React, { useEffect, useRef, useState } from 'react';

type Account = { _id: string; platform: string; displayName?: string; username?: string; isActive?: boolean };
type Group = { _id: string; name: string; accountIds: string[] };
type Profile = { _id: string; name: string; description: string | null; color: string; timezone: string | null };
type Props = { projectId: string; canManage: boolean; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any> };
const accountName = (row: Account) => row.displayName || row.username || row.platform;

export default function ZernioAdmin({ projectId, canManage, request }: Props) {
  const [profile, setProfile] = useState<Profile | null>(null), [accounts, setAccounts] = useState<Account[]>([]), [groups, setGroups] = useState<Group[]>([]);
  const [profileDraft, setProfileDraft] = useState({ name: '', description: '', color: '#64748b', timezone: '' }), [groupDraft, setGroupDraft] = useState({ name: '', accountIds: [] as string[] }), [selectedId, setSelectedId] = useState('');
  const [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const active = useRef(true), scope = useRef({ path: '', canManage }), requester = useRef(request), reads = useRef(0), busyRef = useRef(false), keys = useRef(new Map<string, string>());
  const path = `/projects/${encodeURIComponent(projectId)}/integrations/admin`;
  if (scope.current.path !== path || scope.current.canManage !== canManage) scope.current = { path, canManage };
  const view = scope.current; requester.current = request;
  const current = () => active.current && scope.current === view, selected = groups.find(row => row._id === selectedId);
  useEffect(() => {
    active.current = true; busyRef.current = false; reads.current++; keys.current.clear(); setBusy(false); setLoaded(false); setProfile(null); setAccounts([]); setGroups([]); setSelectedId(''); setGroupDraft({ name: '', accountIds: [] }); setError(''); setNotice('');
    action(load);
    return () => { active.current = false; reads.current++; };
  }, [path, canManage]);
  async function action(run: () => Promise<void>) {
    if (!current() || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try { await run(); } catch (failure) { if (current()) setError((failure as Error).message || 'The Zernio settings could not be updated.'); }
    finally { if (current()) { busyRef.current = false; setBusy(false); } }
  }
  async function load() {
    const read = ++reads.current, response = await requester.current(`${path}/overview`);
    if (!current() || read !== reads.current) return;
    if (!response.profile || !Array.isArray(response.accounts) || !Array.isArray(response.groups)) throw new Error('The project profile and account groups could not be read.');
    setProfile(response.profile); setAccounts(response.accounts); setGroups(response.groups); setLoaded(true); setSelectedId(''); setGroupDraft({ name: '', accountIds: [] });
    setProfileDraft({ name: response.profile.name, description: response.profile.description || '', color: response.profile.color, timezone: response.profile.timezone || '' });
  }
  function choose(row?: Group) { setSelectedId(row?._id || ''); setGroupDraft({ name: row?.name || '', accountIds: row ? [...row.accountIds] : [] }); setError(''); setNotice(''); }
  async function write(task: string, body: unknown) {
    if (!current()) throw new DOMException('The project changed.', 'AbortError');
    const target = `${path}/${task}`, fingerprint = `${target}:${JSON.stringify(body)}`;
    let key = keys.current.get(fingerprint); if (!key) { key = crypto.randomUUID(); keys.current.set(fingerprint, key); }
    try {
      const response = await requester.current(target, 'POST', body, key), input = body as { expectedProfile?: Profile; confirmGroupId?: string };
      const valid = task === 'profile/update' ? response.profile?._id === input.expectedProfile?._id && typeof response.profile?.name === 'string' : task.endsWith('/delete') ? response.deleted === true && response.groupId === input.confirmGroupId : typeof response.group?._id === 'string' && typeof response.group.name === 'string' && Array.isArray(response.group.accountIds);
      if (response.operation?.status !== 'complete' || !valid) throw new Error('The settings change receipt could not be read. Your action key has been retained.');
      keys.current.delete(fingerprint); if (!current()) throw new DOMException('The project changed.', 'AbortError'); return response;
    }
    catch (failure) { const receipt = failure as Error & { status?: number; code?: string; operation?: { status?: string } }; if (receipt.status && receipt.status < 500 && !['OPERATION_UNCERTAIN', 'OPERATION_IN_PROGRESS', 'OPERATION_PENDING'].includes(receipt.code || '') && !['uncertain', 'pending'].includes(receipt.operation?.status || '')) keys.current.delete(fingerprint); throw failure; }
  }
  async function saveProfile(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!profile || !canManage) return;
    const expectedProfile = profile, draft = { ...profileDraft };
    await action(async () => {
      const response = await write('profile/update', { ...draft, name: draft.name.trim(), description: draft.description || null, timezone: draft.timezone.trim() || null, expectedProfile });
      if (!current()) return;
      setProfile(response.profile); setNotice('Profile settings confirmed with Zernio.'); await load();
    });
  }
  async function saveGroup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!canManage) return;
    const target = selected, draft = { name: groupDraft.name.trim(), accountIds: [...groupDraft.accountIds] };
    await action(async () => {
      await write(target ? `groups/${encodeURIComponent(target._id)}/update` : 'groups/create', { ...draft, ...(target ? { expectedGroup: { name: target.name, accountIds: target.accountIds } } : {}) });
      if (!current()) return; setNotice(target ? 'Account group updated in Zernio.' : 'Account group created in Zernio.'); await load();
    });
  }
  async function removeGroup() {
    const target = selected;
    if (!canManage || !target || !window.confirm(`Delete the account group “${target.name}”? Connected accounts remain connected.`)) return;
    await action(async () => {
      await write(`groups/${encodeURIComponent(target._id)}/delete`, { confirmGroupId: target._id, expectedGroup: { name: target.name, accountIds: target.accountIds } });
      if (!current()) return; setSelectedId(''); setNotice('Account group deleted. Connected accounts were kept.'); await load();
    });
  }
  return <section className="panel settings-panel">
    <div className="panel-heading"><div><h2>Project profile and account groups</h2><p>Organize the connected accounts belonging to this project.</p></div><button className="button" type="button" disabled={busy} onClick={() => action(load)}>{busy ? 'Working…' : 'Refresh profile and groups'}</button></div>
    {error && <p className="alert" role="alert">{error}</p>}{notice && <p className="helper-note" role="status">{notice}</p>}
    {loaded && profile && <>
      <details><summary>Profile settings · {profile.name}</summary>
        <p className="helper-note">This is the Zernio profile mapped to the current project. Its timezone applies to provider posts without an explicit timezone.</p>
        {canManage ? <form onSubmit={saveProfile}><fieldset disabled={busy}>
          <div className="form-grid"><label className="field"><span>Profile name</span><input required maxLength={200} value={profileDraft.name} onChange={event => setProfileDraft({ ...profileDraft, name: event.target.value })}/></label><label className="field"><span>Color</span><input required maxLength={100} placeholder="#64748b" value={profileDraft.color} onChange={event => setProfileDraft({ ...profileDraft, color: event.target.value })}/></label></div>
          <label className="field"><span>Description</span><textarea maxLength={4000} value={profileDraft.description} onChange={event => setProfileDraft({ ...profileDraft, description: event.target.value })}/></label>
          <label className="field"><span>Default timezone</span><input maxLength={100} placeholder="UTC, Europe/London, Asia/Dubai" value={profileDraft.timezone} onChange={event => setProfileDraft({ ...profileDraft, timezone: event.target.value })}/><small>Leave empty to use UTC.</small></label>
          <button className="button">Save profile settings</button>
        </fieldset></form> : <><p>{profile.description || 'No description.'}</p><p>Default timezone: {profile.timezone || 'UTC'}</p></>}
      </details>
      <h3>Account groups</h3><p className="helper-note">Groups shown here contain only this project’s accounts. Groups shared with other profiles and empty global groups are managed in Zernio.</p>
      {!groups.length ? <p>No account groups in this project.</p> : <div className="table-scroll"><table><thead><tr><th>Group</th><th>Accounts</th>{canManage && <th>Action</th>}</tr></thead><tbody>{groups.map(row => <tr key={row._id}><td>{row.name}</td><td>{row.accountIds.map(id => { const account = accounts.find(item => item._id === id); return account ? `${accountName(account)} (${account.platform})` : 'Unavailable account'; }).join(', ')}</td>{canManage && <td><button type="button" className="button" disabled={busy} aria-pressed={selectedId === row._id} onClick={() => choose(row)}>Edit {row.name}</button></td>}</tr>)}</tbody></table></div>}
      {canManage && <details key={selectedId || 'new'} open={Boolean(selectedId)}><summary>{selected ? `Edit group · ${selected.name}` : 'Create account group'}</summary><form onSubmit={saveGroup}><fieldset disabled={busy}>
        <label className="field"><span>Group name</span><input required maxLength={200} value={groupDraft.name} onChange={event => setGroupDraft({ ...groupDraft, name: event.target.value })}/></label>
        <fieldset><legend>Connected accounts</legend>{accounts.map(account => <label className="checkbox-row" key={account._id}><input type="checkbox" checked={groupDraft.accountIds.includes(account._id)} onChange={event => setGroupDraft({ ...groupDraft, accountIds: event.target.checked ? [...groupDraft.accountIds, account._id] : groupDraft.accountIds.filter(id => id !== account._id) })}/><span>{accountName(account)} · {account.platform}{account.isActive === false ? ' · Inactive' : ''}</span></label>)}{!accounts.length && <p>Connect an account before creating a group.</p>}</fieldset>
        <p className="helper-note">Select at least one account. Group membership does not move accounts between projects.</p>
        <div className="button-row"><button className="button" disabled={!groupDraft.accountIds.length}>{selected ? 'Save account group' : 'Create account group'}</button>{selected && <><button type="button" className="button" onClick={() => choose()}>New group</button><button type="button" className="button danger" onClick={removeGroup}>Delete account group</button></>}</div>
      </fieldset></form></details>}
    </>}
  </section>;
}
