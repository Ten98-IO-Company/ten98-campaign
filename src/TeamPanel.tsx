import React, { useState } from 'react';

type Member = { id: string; userId: string; name: string; email: string; role: string };
type Props = { workspaceId: string; role: string; currentUserId: string; request: (path: string, method?: string, body?: unknown) => Promise<any> };
export default function TeamPanel({ workspaceId, role, currentUserId, request }: Props) {
  const [members, setMembers] = useState<Member[]>([]), [opened, setOpened] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const canManage = ['owner', 'admin'].includes(role), roles = role === 'owner' ? ['owner', 'admin', 'editor', 'viewer'] : ['editor', 'viewer'];
  const path = `/workspaces/${encodeURIComponent(workspaceId)}/members`;
  const manageable = (member: Member) => role === 'owner' || (role === 'admin' && !['owner', 'admin'].includes(member.role));
  async function load() {
    const result = await request(path);
    if (!Array.isArray(result.members)) throw new Error('The team list could not be read.');
    setMembers(result.members); setOpened(true);
  }
  async function refresh() {
    if (busy || !canManage) return;
    setBusy(true); setError('');
    try { await load(); }
    catch (err) { setError((err as Error).message || 'The team could not be loaded.'); }
    finally { setBusy(false); }
  }
  async function change(method: string, member?: Member, body?: unknown) {
    if (busy || !canManage) return false;
    setBusy(true); setError('');
    try {
      await request(path + (member && method !== 'POST' ? '/' + encodeURIComponent(member.userId || member.id) : ''), method, body);
      if ((member?.userId || member?.id) === currentUserId) { window.location.reload(); return true; }
      await load(); return true;
    } catch (err) { setError((err as Error).message || 'This team change could not be saved.'); return false; }
    finally { setBusy(false); }
  }
  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, values = Object.fromEntries(new FormData(form));
    const email = String(values.email).trim().toLowerCase();
    if (await change('POST', members.find(member => member.email.toLowerCase() === email), { email, role: values.role })) form.reset();
  }
  return <section className="panel settings-panel">
    <h2>Team access</h2>
    <p>Workspace membership gives people access to every project in this workspace.</p>
    {canManage ? <button type="button" className="button" disabled={busy} onClick={refresh}>{busy ? 'Updating team…' : opened ? 'Refresh team' : 'Manage team'}</button> : <p className="helper-note">An owner or administrator can manage this workspace’s team.</p>}
    {error && <p className="alert" role="alert">{error}</p>}
    {opened && canManage && <>
      <div className="table-scroll"><table><thead><tr><th>Member</th><th>Role</th><th>Access</th></tr></thead><tbody>{members.map(member => {
        const id = member.userId || member.id, editable = manageable(member);
        return <tr key={id}><td><strong>{member.name || member.email}{id === currentUserId ? ' (you)' : ''}</strong><br/>{member.email}</td><td>{editable ? <select aria-label={`Role for ${member.name || member.email}`} value={member.role} disabled={busy} onChange={event => { if (event.target.value !== member.role) change('PATCH', member, { role: event.target.value }); }}>{roles.map(value => <option key={value} value={value}>{value.charAt(0).toUpperCase() + value.slice(1)}</option>)}</select> : member.role.charAt(0).toUpperCase() + member.role.slice(1)}</td><td>{editable ? <button type="button" className="button danger" disabled={busy} onClick={() => { if (window.confirm(`Remove ${member.name || member.email} from this workspace? Their access to every project in this workspace will end.`)) change('DELETE', member); }}>Remove</button> : 'Owner-managed'}</td></tr>;
      })}</tbody></table></div>
      <p className="helper-note">Changes to your own membership refresh the page. A workspace must keep at least one owner.</p>
      <form onSubmit={add}>
        <fieldset disabled={busy}>
          <label className="field"><span>Existing account email *</span><input name="email" type="email" required autoComplete="email" placeholder="colleague@yourcompany.com"/></label>
          <label className="field"><span>Workspace role</span><select name="role" defaultValue="editor">{roles.map(value => <option key={value} value={value}>{value.charAt(0).toUpperCase() + value.slice(1)}</option>)}</select></label>
          <button className="button primary">{busy ? 'Saving…' : 'Add existing account'}</button>
        </fieldset>
      </form>
      <p className="helper-note">Invite new members using a secure invitation link below. Organization accounts can also sign in through the configured single sign-on service before being added here.</p>
    </>}
  </section>;
}
