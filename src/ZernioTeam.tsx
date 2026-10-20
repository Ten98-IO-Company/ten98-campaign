import { useEffect, useRef, useState } from 'react';

type Member = { _id: string; name: string; email: string; role: string; isRoot: boolean | null; profileAccess: string[] | null; createdAt: string | null; lastLoginAt: string | null };
type Team = { currentUserId: string; users: Member[] };
type Props = { projectId: string; request: (path: string) => Promise<Team> };

export default function ZernioTeam({ projectId, request }: Props) {
  const [result, setResult] = useState<{ view: object; team: Team } | null>(null), [failure, setFailure] = useState<{ view: object; message: string } | null>(null), [busy, setBusy] = useState(false), [page, setPage] = useState(0);
  const active = useRef(true), scope = useRef({ path: '' }), requester = useRef(request), reads = useRef(0), busyRef = useRef(false);
  const path = `/projects/${encodeURIComponent(projectId)}/integrations/admin/team`;
  if (scope.current.path !== path) scope.current = { path };
  const view = scope.current; requester.current = request;
  const current = () => active.current && scope.current === view, team = result?.view === view ? result.team : null, error = failure?.view === view ? failure.message : '';
  useEffect(() => {
    active.current = true; reads.current++; busyRef.current = false; setBusy(false); setResult(null); setFailure(null); setPage(0);
    return () => { active.current = false; reads.current++; };
  }, [path]);
  async function load() {
    if (!current() || busyRef.current) return;
    const read = ++reads.current; busyRef.current = true; setBusy(true); setResult(null); setFailure(null); setPage(0);
    try {
      const response = await requester.current(path);
      if (!current() || read !== reads.current) return;
      if (!response || !Array.isArray(response.users) || !response.users.length || response.users.length > 10000 || typeof response.currentUserId !== 'string' || response.users.filter(row => row._id === response.currentUserId).length !== 1) throw new Error('The provider team could not be read.');
      setResult({ view, team: response });
    } catch (error) { if (current() && read === reads.current) setFailure({ view, message: (error as Error).message || 'The provider team could not be read.' }); }
    finally { if (current() && read === reads.current) { busyRef.current = false; setBusy(false); } }
  }
  return <section className="panel settings-panel">
    <div className="panel-heading"><div><h2>Zernio team members</h2><p>Read the provider team connected through the configured credential. Workspace membership is managed separately.</p></div><button type="button" className="button" disabled={busy} onClick={load}>{busy ? 'Reading provider team…' : team ? 'Refresh provider team' : 'Read provider team'}</button></div>
    <p className="field-help">Zernio documents this read for a full-access key. Other credentials may be rejected. This view does not verify credential scope or change access.</p>
    {error && <p className="alert" role="alert">{error}</p>}
    {busy && <p role="status">Reading provider team members…</p>}
    {team && <>
      <p role="status">Showing {page * 25 + 1}–{Math.min((page + 1) * 25, team.users.length)} of {team.users.length} returned members.</p>
      <p className="field-help">Provider roles and profile access are shown as returned. An omitted last sign-in is unavailable, and recorded times may be approximate.</p>
      <div className="table-scroll"><table><thead><tr><th scope="col">Member</th><th scope="col">Provider role</th><th scope="col">Profile access</th></tr></thead><tbody>{team.users.slice(page * 25, (page + 1) * 25).map(row => <tr key={row._id}>
        <td><strong>{row.name}</strong>{row._id === team.currentUserId && <p className="field-help">Configured credential’s provider caller</p>}<p>{row.email}</p><details><summary>Provider details for {row.name}</summary><p>Member ID: {row._id}</p><p>Provider root flag: {row.isRoot === null ? 'Not provided' : row.isRoot ? 'Yes' : 'No'}</p><p>Joined: {row.createdAt ?? 'Not provided'}</p><p>Last sign-in: {row.lastLoginAt ?? 'Not provided'}</p></details></td>
        <td>{row.role}</td><td>{row.profileAccess === null ? 'Not provided' : row.profileAccess.length ? row.profileAccess.join(', ') : 'No profile IDs returned'}</td>
      </tr>)}</tbody></table></div>
      {team.users.length > 25 && <div className="button-wrap"><button type="button" className="button" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous members</button><button type="button" className="button" disabled={(page + 1) * 25 >= team.users.length} onClick={() => setPage(value => value + 1)}>Next members</button></div>}
    </>}
  </section>;
}
