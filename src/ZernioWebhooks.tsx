import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, CodeBlock, DataTable, Disclosure, Field, FormActions, FormGrid, Heading, Inline, InlineCode, Input, Option, Pager, Select, Stack, StatusLine, Text } from '@ten98/ui';

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
  return <Stack as="section" gap={3}>
    <Inline justify="between" align="center"><Stack gap={1}><Heading level={3} size="sm">Zernio webhooks</Heading><Text tone="muted">Receive supported campaign and inbox updates for this project.</Text></Stack><Button variant="secondary" disabled={busy || dirty} onClick={() => action(load)}>{busy ? 'Working…' : overview ? 'Refresh webhooks' : 'Load webhooks'}</Button></Inline>
    {error && <Alert tone="danger">{error}</Alert>}{notice && <StatusLine>{notice}</StatusLine>}
    {overview && <>
      <CodeBlock label="Webhook endpoint" code={overview.url} wrap copy/><Text tone="muted">Profile: <InlineCode>{overview.profileId}</InlineCode>. Other profiles and external endpoints are managed in Zernio.</Text>
      {!overview.secretConfigured && <Alert tone="warning">Save a webhook signing secret in Zernio connection settings above before creating or testing delivery.</Alert>}
      {overview.webhooks.length > 0 && <Field label="Webhook"><Select value={selectedId} disabled={busy || dirty} onChange={event => choose(overview.webhooks.find(row => row.id === event.target.value))}>{overview.webhooks.map(row => <Option key={row.id} value={row.id}>{row.name}</Option>)}</Select></Field>}
      {selected && <Text tone="muted">{selected.isActive ? 'Delivery enabled' : 'Delivery paused'} · Consecutive failures: {selected.failureCount ?? 'Not reported'} · Last delivery: {selected.lastFiredAt ? new Date(selected.lastFiredAt).toLocaleString() : 'Not reported'}</Text>}
      {selected && selected.excludedGroups.length > 0 && <Alert tone="warning">Zernio excludes these event groups: {selected.excludedGroups.join(', ')}. Review provider permissions if their updates are needed.</Alert>}
      {selected && !selected.editable ? <Alert tone="info">This endpoint uses advanced filters, headers or unsupported events. Manage its settings in Zernio; its delivery history remains available below.</Alert> : <Stack as="form" onSubmit={event => { event.preventDefault(); send(selected ? 'update' : 'create'); }}><Stack as="fieldset" gap={3} disabled={busy}>
        <Field label="Name"><Input value={draft.name} maxLength={50} required onChange={event => { setDraft({ ...draft, name: event.target.value }); setConfirmed(false); }}/></Field>
        <Checkbox label="Enable delivery" checked={draft.isActive} onChange={event => { setDraft({ ...draft, isActive: event.target.checked }); setConfirmed(false); }}/>
        <Disclosure summary={`Subscribed events (${draft.events.length})`}><FormGrid>{overview.events.map(event => <Checkbox key={event} label={event} checked={draft.events.includes(event)} onChange={change => { setDraft({ ...draft, events: (change.target.checked ? [...draft.events, event] : draft.events.filter(value => value !== event)).sort() }); setConfirmed(false); }}/>)}</FormGrid></Disclosure>
        <Text tone="muted">Saving also applies this app’s saved signing secret. Tests send a synthetic event; redelivery replays an existing real event. Deleting stops future delivery and keeps local records.</Text>
        <Checkbox label="I reviewed this profile’s endpoint, events and delivery state." checked={confirmed} onChange={event => setConfirmed(event.target.checked)}/>
        <FormActions><Button variant="primary" type="submit" disabled={!confirmed || !overview.secretConfigured || !draft.events.length}>{selected ? 'Save webhook' : 'Create webhook'}</Button>{dirty && <Button variant="secondary" onClick={() => choose(selected)}>Discard changes</Button>}{selected && <><Button variant="secondary" disabled={!confirmed || dirty || !overview.secretConfigured} onClick={() => send('test')}>Send test event</Button><Button variant="danger" disabled={!confirmed || dirty} onClick={() => send('delete')}>Delete webhook</Button></>}</FormActions>
      </Stack></Stack>}
      {selected && <><FormActions><Button variant="secondary" disabled={busy || dirty} onClick={() => action(() => deliveries(0))}>Load delivery history</Button></FormActions>{logs && <>
        <DataTable searchable={false} sortable={false} pagination={false} ariaLabel="Webhook delivery history" emptyState={<Text>No deliveries recorded for this webhook.</Text>} rows={logs.map((row, index) => ({ ...row, key: `${row.eventId}:${index}` }))} rowKey={row => row.key} columns={[{ key: 'event', header: 'Event', render: row => <Stack gap={0}><Text as="span">{row.event}</Text>{row.test && <Text as="small" tone="muted">Test</Text>}<Text as="small" tone="muted">{row.eventId}</Text></Stack> }, { key: 'status', header: 'Delivery', render: row => <>{row.status}{row.statusCode && ` · HTTP ${row.statusCode}`}</> }, { key: 'attempt', header: 'Attempt', render: row => row.attemptNumber ?? 'Not reported' }, { key: 'time', header: 'Time', render: row => new Date(row.createdAt).toLocaleString() }]} rowActionsLabel="Action" rowActions={row => row.status === 'failed' && !row.test && selected.editable && <Button variant="secondary" size="sm" disabled={busy || dirty || !confirmed} onClick={() => send('redeliver', row.eventId)}>Redeliver event</Button>}/>
        <Pager label="Delivery history pages" onPrevious={busy || skip === 0 ? undefined : () => action(() => deliveries(Math.max(0, skip - 50)))} onNext={busy || !hasMore || skip >= 10000 ? undefined : () => action(() => deliveries(skip + 50))}/>
      </>}</>}
    </>}
  </Stack>;
}
