import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Card, DataTable, Field, FormGrid, Inline, Option, Select, Stack, StatusLine, Text, type DataColumn } from '@ten98/ui';
import { accountLabel } from './PostComposer';

type Row = Record<string, any>;
type Request = (path: string) => Promise<any>;
export default function AdCampaignDiscovery({ request }: { request: Request }) {
  const [accounts, setAccounts] = useState<Row[] | null>(null), [accountId, setAccountId] = useState(''), [advertisers, setAdvertisers] = useState<Row[] | null>(null), [adAccountId, setAdAccountId] = useState('');
  const [result, setResult] = useState<Row | null>(null), [busy, setBusy] = useState(''), [error, setError] = useState('');
  const generation = useRef(0), mounted = useRef(true), requester = useRef(request), frame = useMemo(() => ({}), [accountId, adAccountId]), committed = useRef(frame);
  useLayoutEffect(() => { committed.current = frame; requester.current = request; }, [frame, request]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);
  const current = () => mounted.current && committed.current === frame;
  function withdraw() { generation.current++; setResult(null); setError(''); setBusy(''); }
  async function loadAccounts() {
    if (!current()) return;
    withdraw(); setAccounts(null); setAccountId(''); setAdvertisers(null); setAdAccountId('');
    const read = ++generation.current; setBusy('accounts');
    try {
      const value = await requester.current('accounts');
      if (!mounted.current || read !== generation.current) return;
      if (!Array.isArray(value?.accounts) || value.accounts.some((row: Row) => !row || typeof row._id !== 'string' || !row._id || typeof row.platform !== 'string') || new Set(value.accounts.map((row: Row) => row._id)).size !== value.accounts.length) throw new Error('Project connections could not be verified.');
      setAccounts(value.accounts.filter((row: Row) => ['metaads', 'facebook', 'instagram'].includes(row.platform)));
    } catch (failure) { if (mounted.current && read === generation.current) setError((failure as Error).message || 'Project connections are unavailable.'); }
    finally { if (mounted.current && read === generation.current) setBusy(''); }
  }
  async function loadAdvertisers() {
    if (!current() || !accountId) return;
    withdraw(); setAdvertisers(null); setAdAccountId('');
    const read = ++generation.current; setBusy('advertisers');
    try {
      const value = await requester.current('ads/accounts?' + new URLSearchParams({ accountId }));
      if (!mounted.current || read !== generation.current) return;
      if (value?.stale || !Array.isArray(value?.accounts) || value.accounts.some((row: Row) => !row || typeof row.id !== 'string' || !row.id || row.selectable !== undefined && typeof row.selectable !== 'boolean' || row.name != null && typeof row.name !== 'string') || new Set(value.accounts.map((row: Row) => row.id)).size !== value.accounts.length) throw new Error('Current advertiser access could not be verified.');
      setAdvertisers(value.accounts);
    } catch (failure) { if (mounted.current && read === generation.current) setError((failure as Error).message || 'Advertiser access is unavailable.'); }
    finally { if (mounted.current && read === generation.current) setBusy(''); }
  }
  useEffect(() => { if (accountId) void loadAdvertisers(); }, [accountId]);
  async function discover() {
    if (!current() || !accountId || !adAccountId || !advertisers?.some(row => row.id === adAccountId && row.selectable !== false)) return;
    withdraw(); const read = ++generation.current; setBusy('campaigns');
    try {
      const value = await requester.current('ads/campaign-discovery?' + new URLSearchParams({ accountId, adAccountId }));
      if (!mounted.current || read !== generation.current) return;
      if (value?.accountId !== accountId || value.adAccountId !== adAccountId || value.complete !== true || !Array.isArray(value.campaigns) || value.campaigns.length > 1000 || value.campaigns.some((row: Row) => !row || typeof row.platformCampaignId !== 'string' || !row.platformCampaignId || !['facebook', 'instagram'].includes(row.platform) || ['campaignName', 'status', 'platformCampaignStatus'].some(field => row[field] !== null && typeof row[field] !== 'string') || row.adCount !== null && (!Number.isSafeInteger(row.adCount) || row.adCount < 0)) || new Set(value.campaigns.map((row: Row) => row.platformCampaignId)).size !== value.campaigns.length) throw new Error('The complete campaign list and selected advertiser could not be verified.');
      setResult(value);
    } catch (failure) { if (mounted.current && read === generation.current) setError((failure as Error).message || 'Campaign discovery is unavailable.'); }
    finally { if (mounted.current && read === generation.current) setBusy(''); }
  }
  const columns: DataColumn<Row>[] = [
    { key: 'campaign', header: 'Campaign', render: row => <><Text as="strong">{row.campaignName || 'Name not reported'}</Text><Text as="small" tone="muted"> · Native ID {row.platformCampaignId}</Text></> },
    { key: 'network', header: 'Network', render: row => row.platform === 'instagram' ? 'Instagram' : 'Facebook' },
    { key: 'delivery', header: 'Stored delivery', render: row => <>{row.status ?? 'Not reported'}{row.platformCampaignStatus && <Text as="small" tone="muted"> · {row.platformCampaignStatus}</Text>}</> },
    { key: 'ads', header: 'Ads', render: row => row.adCount === null ? 'Not reported' : row.adCount }
  ];
  return <Card as="section" headingLevel={2} title="Discover Meta campaigns" actions={<Button variant="secondary" disabled={busy === 'accounts'} onClick={loadAccounts}>{busy === 'accounts' ? 'Loading connections…' : 'Load Meta connections'}</Button>}><Stack gap={3}>
    <Text tone="muted">Includes campaigns with no ads. These results are read-only. Delivery status is last stored by the provider, not a live switch check.</Text>
    {error && <Alert tone="danger" title={error}/>}
    {accounts && !accounts.length && <StatusLine>No Meta connections were returned for this project.</StatusLine>}
    {accounts && accounts.length > 0 && <FormGrid><Field label="Meta connection"><Select name="accountId" autoComplete="off" value={accountId} onChange={event => { if (!current()) return; const id = event.target.value; if (id && !accounts.some(row => row._id === id && row.isActive !== false)) return; withdraw(); setAccountId(id); setAdvertisers(null); setAdAccountId(''); }}><Option value="">Choose a connection</Option>{accounts.map(row => <Option key={row._id} value={row._id} disabled={row.isActive === false}>{accountLabel({ ...row, id: row._id })}{row.isActive === false ? ' · Unavailable' : ''}</Option>)}</Select></Field>
    <Field label="Meta advertiser"><Select name="adAccountId" autoComplete="off" value={adAccountId} disabled={!advertisers?.length} onChange={event => { if (!current()) return; const id = event.target.value; if (id && !advertisers?.some(row => row.id === id && row.selectable !== false)) return; withdraw(); setAdAccountId(id); }}><Option value="">{busy === 'advertisers' ? 'Loading advertisers…' : 'Choose an advertiser'}</Option>{advertisers?.map(row => <Option key={row.id} value={row.id} disabled={row.selectable === false}>{row.name || row.id} · {row.id}{row.selectable === false ? ' · Unavailable' : ''}</Option>)}</Select></Field></FormGrid>}
    {accountId && <Inline gap={2}><Button variant="secondary" disabled={busy === 'advertisers'} onClick={loadAdvertisers}>Refresh advertisers</Button><Button disabled={!adAccountId || !!busy} onClick={discover}>{busy === 'campaigns' ? 'Discovering campaigns…' : 'Discover campaigns'}</Button></Inline>}
    {advertisers && !advertisers.length && <StatusLine>No advertisers were returned for this connection.</StatusLine>}
    {result && <><StatusLine>Connection {result.accountId} · Advertiser {result.adAccountId} · {result.campaigns.length} {result.campaigns.length === 1 ? 'campaign' : 'campaigns'} returned</StatusLine>{result.campaigns.length ? <DataTable ariaLabel="Discovered Meta campaigns" searchable={false} sortable={false} pagination={false} columns={columns} rows={result.campaigns} rowKey={row => row.platformCampaignId}/> : <StatusLine>No campaigns returned for this advertiser, including campaigns with no ads.</StatusLine>}</>}
  </Stack></Card>;
}
