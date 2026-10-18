import React, { useEffect, useRef, useState } from 'react';

type Invitation = { id: string; email: string; role: string; workspaceName: string; expiresAt: string; status: string };
type Props = { workspaceId: string; role: string; request: (path: string, method?: string, body?: unknown) => Promise<any> };
export default function WorkspaceInvitations({ workspaceId, role, request }: Props) {
  const [invitations, setInvitations] = useState<Invitation[]>([]), [link, setLink] = useState<{ id: string; url: string } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const version = useRef(0), readVersion = useRef(0), linkInput = useRef<HTMLInputElement>(null), canManage = ['owner', 'admin'].includes(role);
  const roles = role === 'owner' ? ['editor', 'viewer', 'admin', 'owner'] : ['editor', 'viewer'];
  const path = `/workspaces/${encodeURIComponent(workspaceId)}/invitations`;
  async function load(generation = version.current) {
    const read = ++readVersion.current;
    try {
      const result = await request(path);
      if (!Array.isArray(result.invitations)) throw new Error('The invitation list could not be read.');
      if (generation === version.current && read === readVersion.current) setInvitations(result.invitations);
    } catch (err) { if (generation === version.current && read === readVersion.current) throw err; }
  }
  useEffect(() => {
    const generation = ++version.current; setInvitations([]); setLink(null); setError(''); setNotice(''); setBusy(false);
    if (canManage) { const loading = load(generation), read = readVersion.current; loading.catch(err => { if (generation === version.current && read === readVersion.current) setError((err as Error).message); }); }
    return () => { version.current++; };
  }, [workspaceId, role]);
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !canManage) return;
    const form = event.currentTarget, values = Object.fromEntries(new FormData(form)), generation = version.current;
    readVersion.current++; setBusy(true); setError(''); setNotice(''); setLink(null);
    try {
      const result = await request(path, 'POST', { email: values.email, role: values.role });
      if (generation !== version.current) return;
      setLink({ id: result.invitation.id, url: result.url }); form.reset(); await load(generation);
    } catch (err) { if (generation === version.current) setError((err as Error).message || 'The invitation could not be created.'); }
    finally { if (generation === version.current) setBusy(false); }
  }
  async function revoke(invitation: Invitation) {
    if (busy || !canManage) return;
    const generation = version.current; readVersion.current++; setBusy(true); setError(''); setNotice('');
    try {
      await request(path + '/' + encodeURIComponent(invitation.id), 'DELETE');
      if (generation !== version.current) return;
      if (link?.id === invitation.id) setLink(null);
      setNotice('Invitation revoked.'); await load(generation);
    } catch (err) { if (generation === version.current) setError((err as Error).message || 'The invitation could not be revoked.'); }
    finally { if (generation === version.current) setBusy(false); }
  }
  async function copy() {
    if (!link) return;
    try { await navigator.clipboard.writeText(link.url); setNotice('Invitation link copied. Share it directly with the invited person.'); }
    catch { linkInput.current?.focus(); linkInput.current?.select(); setNotice('Select and copy the invitation link.'); }
  }
  return <section className="panel settings-panel">
    <h2>Invite your team</h2><p>Give a colleague access to every project in this workspace. Invitation links expire after seven days and can be used once.</p>
    {canManage ? <>
      <form onSubmit={create}><fieldset disabled={busy}>
        <label className="field"><span>Colleague’s email *</span><input name="email" type="email" required maxLength={254} autoComplete="email" placeholder="colleague@yourcompany.com"/></label>
        <label className="field"><span>Workspace role</span><select name="role" defaultValue="editor">{roles.map(value => <option key={value} value={value}>{value.charAt(0).toUpperCase() + value.slice(1)}</option>)}</select></label>
        <button className="button primary">{busy ? 'Updating invitations…' : 'Create invitation link'}</button>
      </fieldset></form>
      <p className="helper-note">Share the link yourself. Creating an invitation sends no email. New members choose their own password; existing members sign in with their invited email.</p>
      {link && <div><label className="field"><span>Invitation link — copy this now</span><input ref={linkInput} readOnly value={link.url} onFocus={event => event.currentTarget.select()}/></label><button type="button" className="button" onClick={copy}>Copy invitation link</button><p className="helper-note">The full link is shown only after creation. Create another invitation for this email if you lose it; the previous link will stop working.</p></div>}
      {invitations.length > 0 && <div className="table-scroll"><table><thead><tr><th>Email</th><th>Role</th><th>Expires</th><th>Status</th><th>Action</th></tr></thead><tbody>{invitations.map(invitation => <tr key={invitation.id}><td>{invitation.email}</td><td>{invitation.role}</td><td>{new Date(invitation.expiresAt).toLocaleDateString()}</td><td>{invitation.status}</td><td>{invitation.status === 'pending' && (role === 'owner' || !['owner', 'admin'].includes(invitation.role)) ? <button type="button" className="button danger" disabled={busy} onClick={() => revoke(invitation)}>Revoke</button> : '—'}</td></tr>)}</tbody></table></div>}
    </> : <p className="helper-note">A workspace owner or administrator can create invitations.</p>}
    {error && <p className="alert" role="alert">{error}</p>}{notice && <p className="helper-note" role="status">{notice}</p>}
  </section>;
}
