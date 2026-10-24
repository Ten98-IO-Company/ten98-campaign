import { useEffect, useRef, useState } from 'react';
import { TeamFlow, type AuthNotice, type TeamInvitation, type TeamMember, useFocusReturn } from '@ten98/ui';
import { workspaceRoles } from './workspace-roles';

type Props = { workspaceId: string; role: string; currentUserId: string; request: (path: string, method?: string, body?: unknown) => Promise<any> };

// Members, roles and invitations in one shared flow. People join only by invitation; the server enforces every role rule.
export default function TeamSettings({ workspaceId, role, currentUserId, request }: Props) {
  const [members, setMembers] = useState<TeamMember[]>([]), [invitations, setInvitations] = useState<TeamInvitation[]>([]), [link, setLink] = useState<{ id: string; url: string }>(), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState<AuthNotice>();
  const version = useRef(0), readVersion = useRef(0), base = `/workspaces/${encodeURIComponent(workspaceId)}`;
  const allRoles = workspaceRoles, delegated = ['editor', 'viewer'];
  const roles = role === 'owner' ? allRoles : allRoles.filter(option => delegated.includes(option.value));
  async function load(generation = version.current) {
    const read = ++readVersion.current;
    try {
      const [team, invited] = await Promise.all([request(base + '/members'), request(base + '/invitations')]);
      if (!Array.isArray(team?.members) || !Array.isArray(invited?.invitations)) throw new Error('The team list could not be read.');
      if (generation !== version.current || read !== readVersion.current) return;
      setMembers(team.members.map((member: any) => ({ id: member.userId || member.id, name: member.name || member.email, email: member.email, role: member.role })));
      setInvitations(invited.invitations);
    } catch (err) { if (generation === version.current && read === readVersion.current) throw err; }
  }
  useEffect(() => {
    const generation = ++version.current; setMembers([]); setInvitations([]); setLink(undefined); setError(''); setNotice(undefined); setBusy(false);
    const loading = load(generation), read = readVersion.current;
    loading.catch(err => { if (generation === version.current && read === readVersion.current) setError((err as Error).message || 'The team could not be loaded.'); });
    return () => { version.current++; };
  }, [workspaceId, role]);
  const rememberFocus = useFocusReturn(busy);
  // Every write invalidates older reads first, then reloads; a change to your own membership reloads the app instead.
  async function act(work: () => Promise<any>, message: string, self = false, after?: (result: any) => void) {
    if (busy) return;
    rememberFocus();
    const generation = version.current; readVersion.current++; setBusy(true); setError(''); setNotice(undefined);
    try {
      const result = await work();
      if (generation !== version.current) return;
      if (self) { window.location.reload(); return; }
      after?.(result); setNotice({ tone: 'success', text: message }); await load(generation);
    } catch (err) { if (generation === version.current) setError((err as Error).message || 'This team change could not be saved.'); }
    finally { if (generation === version.current) setBusy(false); }
  }
  const invite = ({ email, role: requested }: { email: string; role: string }) => act(() => { setLink(undefined); return request(base + '/invitations', 'POST', { email, role: requested }); }, 'Invitation link created. Share it directly with the invited person.', false, result => setLink({ id: result.invitation.id, url: result.url }));
  const revoke = ({ id }: { id: string }) => act(() => request(base + '/invitations/' + encodeURIComponent(id), 'DELETE'), 'Invitation revoked.', false, () => setLink(current => current?.id === id ? undefined : current));
  const changeRole = ({ id, role: requested }: { id: string; role: string }) => act(() => request(base + '/members/' + encodeURIComponent(id), 'PATCH', { role: requested }), 'Role updated.', id === currentUserId);
  const remove = ({ id }: { id: string }) => act(() => request(base + '/members/' + encodeURIComponent(id), 'DELETE'), 'Member removed.', id === currentUserId);
  // The server refuses to demote the last owner, so the sole owner's own role is shown read-only instead of offering a change that fails.
  const soleOwner = role === 'owner' && members.some(member => member.id === currentUserId && member.role === 'owner') && members.filter(member => member.role === 'owner').length === 1;
  const assignableRoles = (member: TeamMember) => role === 'owner' ? (soleOwner && member.id === currentUserId ? [] : allRoles.map(option => option.value)) : role === 'admin' && delegated.includes(member.role) ? delegated : [];
  return <TeamFlow title="Team access" description={`Workspace membership gives people access to every project in this workspace. Invitation links expire after seven days, work once and are never emailed: share each link yourself. A workspace must keep at least one owner.${soleOwner ? ' You are the only owner, so your own role can change only after you make another member an owner.' : ''}`} busy={busy} error={error || undefined} notice={notice} currentUserId={currentUserId} members={members} roles={roles} roleLabels={Object.fromEntries(allRoles.map(option => [option.value, option.label]))} assignableRoles={assignableRoles} onRoleChange={changeRole} onRemove={remove} invitations={invitations} onInvite={invite} onRevokeInvitation={revoke} inviteLink={link} onDismissInviteLink={() => setLink(undefined)} defaultInviteRole="editor" messages={{ invite: 'Create invitation link', removeDescription: 'Their access to every project in this workspace ends immediately.' }}/>;
}
