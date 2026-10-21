import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, DataTable, Disclosure, Inline, Stack, StatusLine, Text, type DataColumn } from '@ten98/ui';

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
  const columns: DataColumn<Member>[] = [
    { key: 'member', header: 'Member', render: row => <Stack gap={1}><Text as="strong">{row.name}</Text>{row._id === team?.currentUserId && <Text tone="muted">Configured credential’s provider caller</Text>}<Text>{row.email}</Text><Disclosure variant="plain" summary={<>Provider details for {row.name}</>}><Text>Member ID: {row._id}</Text><Text>Provider root flag: {row.isRoot === null ? 'Not provided' : row.isRoot ? 'Yes' : 'No'}</Text><Text>Joined: {row.createdAt ?? 'Not provided'}</Text><Text>Last sign-in: {row.lastLoginAt ?? 'Not provided'}</Text></Disclosure></Stack> },
    { key: 'role', header: 'Provider role', render: row => row.role },
    { key: 'access', header: 'Profile access', render: row => row.profileAccess === null ? 'Not provided' : row.profileAccess.length ? row.profileAccess.join(', ') : 'No profile IDs returned' }
  ];
  return <Card as="section" headingLevel={2} title="Zernio team members" description="Read the provider team connected through the configured credential. Workspace membership is managed separately." actions={<Button variant="secondary" disabled={busy} onClick={load}>{busy ? 'Reading provider team…' : team ? 'Refresh provider team' : 'Read provider team'}</Button>}><Stack gap={3}>
    <Text tone="muted">Zernio documents this read for a full-access key. Other credentials may be rejected. This view does not verify credential scope or change access.</Text>
    {error && <Alert tone="danger" title={error}/>}
    {busy && <StatusLine busy>Reading provider team members…</StatusLine>}
    {team && <>
      <StatusLine>Showing {page * 25 + 1}–{Math.min((page + 1) * 25, team.users.length)} of {team.users.length} returned members.</StatusLine>
      <Text tone="muted">Provider roles and profile access are shown as returned. An omitted last sign-in is unavailable, and recorded times may be approximate.</Text>
      <DataTable ariaLabel="Zernio team members" searchable={false} sortable={false} pagination={false} columns={columns} rows={team.users.slice(page * 25, (page + 1) * 25)} rowKey={row => row._id}/>
      {team.users.length > 25 && <Inline gap={2}><Button variant="secondary" disabled={page === 0} onClick={() => setPage(value => value - 1)}>Previous members</Button><Button variant="secondary" disabled={(page + 1) * 25 >= team.users.length} onClick={() => setPage(value => value + 1)}>Next members</Button></Inline>}
    </>}
  </Stack></Card>;
}
