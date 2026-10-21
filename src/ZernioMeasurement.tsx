import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, CodeBlock, DataTable, Disclosure, Field, FormGrid, Heading, Inline, InlineCode, Input, List, ListItem, Option, Select, Stack, StatusLine, Text } from '@ten98/ui';

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
  return <Card as="section" headingLevel={2} title="Pixels and tracking tags" description="Find the pixel used by an advertising campaign and inspect its website installation." actions={adAccountId && <Button variant="secondary" disabled={busy || loading} onClick={() => action(refresh)}>Refresh tags</Button>}><Stack gap={4}>
    {error && <Alert tone="danger" title={error}/>}{notice && <StatusLine tone="success">{notice}</StatusLine>}
    <Stack as="fieldset" gap={3} disabled={busy || loading}><FormGrid>
      <Field label="Advertising connection"><Select value={accountId} onChange={event => setAccountId(event.target.value)}><Option value="">{loading && !accounts.length ? 'Loading connections…' : 'Choose a connection'}</Option>{accounts.map(row => <Option key={row._id} value={row._id}>{labels[row.platform]} · {row.displayName || row.username || row._id}{row.isActive === false ? ' · Inactive' : ''}</Option>)}</Select></Field>
      {accountId && <Field label="Advertising account"><Select value={adAccountId} onChange={event => setAdAccountId(event.target.value)}><Option value="">Choose an advertising account</Option>{nativeAccounts.map(row => <Option key={row.id} value={row.id}>{row.name || row.id}{row.currency ? ` · ${row.currency}` : ''}</Option>)}</Select></Field>}
    </FormGrid></Stack>
    {!loading && !accounts.length && <Text>Connect an advertising account in Integrations to manage measurement.</Text>}
    {loaded && !tags.length && <Text>No tracking tags were reported for this advertising account.</Text>}
    {account?.platform === 'redditads' && <Alert tone="info" title="Reddit requires a pixel for every campaign goal. Create pixels and inspect installation in Reddit Ads Manager, then refresh here. Website conversions require the chosen event to have fired; website leads require Lead. Pixels shown belong to the selected advertising account."/>}
    {tags.length > 0 && <DataTable searchable={false} sortable={false} pagination={false} ariaLabel="Tracking tags" rows={tags} rowKey={row => row.id} columns={[{ key: 'name', header: 'Tag' }, { key: 'id', header: 'Campaign pixel ID', render: row => <InlineCode>{row.id}</InlineCode> }, { key: 'status', header: 'Status', render: row => `${row.status}${row.isUnavailable ? ' · Unavailable' : ''}` }]} rowActionsLabel="Action" rowActions={row => <Button variant="secondary" size="sm" disabled={busy || loading} onClick={() => inspect(row)}>Inspect {row.name}</Button>}/>}
    {canManage && account?.canCreate && adAccountId && <Disclosure summary="Create a tracking tag"><Stack gap={3}><Text tone="muted">Create only after checking the existing tags. An uncertain creation must be reviewed before another pixel is created. This does not change your website.</Text>{account.platform === 'openaiads' && <Text tone="muted">ChatGPT also provisions a Conversions API key. Partner access is required, and a failed setup can leave a pixel behind. Inspect the provider before retrying.</Text>}{account.platform === 'googleads' && <Text tone="muted">Google reuses its existing tag. If conversion tracking has never been configured, this creates its first website conversion action.</Text>}{['linkedinads', 'xads'].includes(account.platform) && <Text tone="muted">This platform allows one tag per advertising account and does not store the requested name.</Text>}<Stack as="form" gap={3} onSubmit={event => save(event as React.FormEvent<HTMLFormElement>, true)}><Stack as="fieldset" gap={3} disabled={busy || loading || account.isActive === false}><Field label="Tag name"><Input name="name" required maxLength={account.platform === 'tiktokads' ? 40 : 200}/></Field>{account.platform === 'openaiads' && <Field label="Initial conversion event (optional)"><Select name="defaultEventType"><Option value="">No initial event</Option>{eventTypes.map(([value, label]) => <Option key={value} value={value}>{label}</Option>)}</Select></Field>}<Inline><Button variant="secondary" type="submit" disabled={!loaded}>Create tracking tag</Button></Inline></Stack></Stack></Stack></Disclosure>}
    {selected && <Card as="section" headingLevel={3} title={selected.name}><Stack gap={3}><Text>Campaign pixel ID: <InlineCode>{selected.id}</InlineCode>{selected.siteTagId && <> · Website tag ID: <InlineCode>{selected.siteTagId}</InlineCode></>}</Text>
      {selected.lastFiredTime != null && <Text>Last reported event: {new Date(selected.lastFiredTime * 1000).toLocaleString()}</Text>}{selected.installed === true && <Text>This tag has received an event. That does not confirm every page or conversion is configured.</Text>}{selected.installed === false && <Text>No event has been reported for this tag.</Text>}{selected.autoTagging !== undefined && <Text>Google click auto-tagging: {selected.autoTagging ? 'Enabled' : 'Disabled'}</Text>}
      {selected.code && <Stack gap={1}><Text as="span" weight="semibold">Website installation code</Text><CodeBlock code={selected.code} label="Website installation code" wrap maxHeight="md" copy/><Text as="small" tone="muted">Copy into the website’s tag installation after reviewing its consent settings. This app displays the code and does not execute it.</Text></Stack>}
      {account?.platform !== 'redditads' && <Inline gap={2}><Button variant="secondary" disabled={busy || loading} onClick={() => loadMore('events')}>Load conversion events</Button>{account?.canDiagnose && <Button variant="secondary" disabled={busy || loading} onClick={() => loadMore('diagnostics')}>Check pixel diagnostics</Button>}</Inline>}
      {events && <><Heading level={4} size="sm">Conversion events</Heading>{!events.length ? <Text>No event definitions were reported. Standard pixel events can be received without a separate definition on some platforms.</Text> : <DataTable searchable={false} sortable={false} pagination={false} ariaLabel="Conversion events" rows={events} rowKey={row => row.id} columns={[{ key: 'name', header: 'Event' }, { key: 'type', header: 'Type', render: row => row.type || 'Not reported' }, { key: 'siteEventId', header: 'Website event ID', render: row => <InlineCode>{row.siteEventId || row.id}</InlineCode> }, { key: 'status', header: 'Status', render: row => row.status || 'Not reported' }]}/>}</>}
      {checks && <><Heading level={4} size="sm">Provider diagnostics</Heading>{!checks.length ? <Text>No diagnostic checks were returned.</Text> : <List>{checks.map((row, index) => <ListItem key={row.key || index}><Stack gap={1}><Text as="strong">{row.title || row.key || 'Check'}: {row.result || 'No result reported'}</Text>{row.description && <Text>{row.description}</Text>}</Stack></ListItem>)}</List>}</>}
      {canManage && account?.canRename && <Stack as="form" key={selected.id + selected.name} gap={3} onSubmit={event => save(event as React.FormEvent<HTMLFormElement>, false)}><Stack as="fieldset" gap={3} disabled={busy || loading}><Field label="Tag name"><Input name="name" defaultValue={selected.name} required maxLength={200}/></Field><Inline><Button variant="secondary" type="submit">Rename tag</Button></Inline></Stack></Stack>}
    </Stack></Card>}
  </Stack></Card>;
}
