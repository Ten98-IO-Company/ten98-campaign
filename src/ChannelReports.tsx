import { useEffect, useState } from 'react';
import { BarList, Card, DataTable, EmptyState, Inline, MetricCard, MetricGrid, Select, Stack, Text } from '@ten98/ui';

type Row = { id: string; [key: string]: any };
type Request = (path: string) => Promise<any>;
// Each report reads once when its Reports tab opens (reads only; nothing is sent to a network).
type Read<T> = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; value: T };
const failedText = 'Couldn’t load these results. Refresh to try again.';
const count = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
const metric = (label: string, value: number | string, hint?: string) => <MetricCard key={label} label={label} value={typeof value === 'number' ? value.toLocaleString() : value} hint={hint}/>;

function useRead<T>(load: () => Promise<T>, deps: unknown[]): Read<T> {
  const [read, setRead] = useState<Read<T>>({ state: 'loading' });
  useEffect(() => {
    let active = true; setRead({ state: 'loading' });
    load().then(value => { if (active) setRead({ state: 'ready', value }); }, () => { if (active) setRead({ state: 'failed' }); });
    return () => { active = false; };
  }, deps);
  return read;
}

// Reports › Links: clicks and scans of every short link, and visits to the websites that send them, over a chosen period.
export function LinkReport({ projectId, request }: { projectId: string; request: Request }) {
  const [days, setDays] = useState('30');
  const read = useRead(() => request(`/projects/${encodeURIComponent(projectId)}/links/analytics?days=${days}`), [projectId, request, days]);
  const totals = read.state === 'ready' ? read.value?.totals || {} : {}, pages: Row[] = read.state === 'ready' ? read.value?.pages || [] : [];
  return <Stack gap={4}>
    <Inline><Select width="auto" aria-label="Reporting period" value={days} onChange={event => setDays(event.target.value)} options={[{ value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }]}/></Inline>
    {read.state === 'failed' ? <Text tone="muted">{failedText}</Text> : read.state === 'loading' ? <Text tone="muted">Loading link results…</Text> : <>
      <MetricGrid list label="Link results">{[metric('Link clicks', count(totals.clicks)), metric('QR scans', count(totals.qrScans)), metric('Website visits', count(totals.pageviews), 'Pages viewed on your website'), metric('Actions', count(totals.events), 'Custom events from your website')]}</MetricGrid>
      <Card as="section" headingLevel={2} title="Most visited pages">{pages.length ? <BarList label="Most visited pages" items={pages.slice(0, 8).map(page => ({ id: String(page.path), label: String(page.path), value: count(page.count), valueText: count(page.count).toLocaleString() }))}/> : <Text tone="muted">No website visits in this period. Add the tracking code from Library › Links & QR codes to your website to see them.</Text>}</Card>
    </>}
  </Stack>;
}

// Reports › Messages: what happened to every email, SMS and WhatsApp send.
export function MessageReport({ projectId, request }: { projectId: string; request: Request }) {
  const read = useRead(() => request(`/projects/${encodeURIComponent(projectId)}/direct/campaigns`).then(value => (value?.campaigns || []) as Row[]), [projectId, request]);
  if (read.state === 'failed') return <Text tone="muted">{failedText}</Text>;
  if (read.state === 'loading') return <Text tone="muted">Loading message results…</Text>;
  const sends = read.value.filter(send => send.status !== 'draft'), sum = (key: string) => sends.reduce((total, send) => total + count(send.counts?.[key]), 0);
  if (!sends.length) return <EmptyState icon="mail" title="No messages sent yet" description="Results appear here after your first email, SMS or WhatsApp send."/>;
  const channel: Record<string, string> = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };
  return <Stack gap={4}>
    <MetricGrid list label="Message results">{[metric('Sends', sends.length), metric('Delivered', sum('delivered')), metric('Not delivered', sum('failed'), 'Bounced or refused'), metric('Skipped', sum('suppressed'), 'Opted out or without permission')]}</MetricGrid>
    <DataTable ariaLabel="Message sends" searchable={false} sortable={false} pagination={false} rows={sends} rowKey={send => send.id} columns={[
      { key: 'name', header: 'Message', rowHeader: true, wrap: true, render: send => <Stack gap={0}><Text weight="semibold">{send.name || 'Untitled message'}</Text><Text as="small" size="sm" tone="muted">{channel[send.channel] || send.channel}</Text></Stack> },
      { key: 'delivered', header: 'Delivered', numeric: true, render: send => count(send.counts?.delivered).toLocaleString() },
      { key: 'failed', header: 'Not delivered', numeric: true, render: send => count(send.counts?.failed).toLocaleString() },
      { key: 'pending', header: 'Still sending', numeric: true, render: send => (count(send.counts?.pending) + count(send.counts?.accepted)).toLocaleString() },
    ]}/>
  </Stack>;
}

// Reports › Field activity: leads, reach and spend from roadshows, door-to-door, events, street teams and sampling.
export function FieldReport({ projectId, request, activations, campaigns, money }: { projectId: string; request: Request; activations: Row[]; campaigns: Row[]; money: (value: unknown, currency?: string) => string }) {
  const read = useRead(() => request(`/projects/${encodeURIComponent(projectId)}/activations/results`).then(value => (value?.results || {}) as Record<string, Row>), [projectId, request]);
  if (!activations.length) return <EmptyState icon="billboard" title="No field activity yet" description="Plan a roadshow, door-to-door area, event, street team or sampling shift to see its leads and reach here."/>;
  const leads = read.state === 'ready' ? activations.reduce((total, activation) => total + count(read.value[activation.id]?.leads), 0) : null;
  const currency = campaigns.find(campaign => campaign.id === activations[0]?.campaignId)?.currency || 'AED', campaignName = (id: string) => campaigns.find(campaign => campaign.id === id)?.name || 'No campaign';
  return <Stack gap={4}>
    <MetricGrid list label="Field activity results">{[metric('Activities', activations.length), metric('Leads captured', leads ?? (read.state === 'failed' ? 'Couldn’t load' : '…')), metric('People reached', activations.reduce((total, activation) => total + count(activation.reached), 0)), metric('Spent', money(activations.reduce((total, activation) => total + count(activation.spent), 0), currency))]}</MetricGrid>
    <DataTable ariaLabel="Field activity results" searchable={false} sortable={false} pagination={false} rows={activations} rowKey={activation => activation.id} columns={[
      { key: 'name', header: 'Activity', rowHeader: true, wrap: true, render: activation => <Stack gap={0}><Text weight="semibold">{activation.name || 'Field activity'}</Text><Text as="small" size="sm" tone="muted">{campaignName(activation.campaignId)}</Text></Stack> },
      { key: 'leads', header: 'Leads', numeric: true, render: activation => read.state === 'ready' ? count(read.value[activation.id]?.leads).toLocaleString() : '—' },
      { key: 'reached', header: 'Reached', numeric: true, render: activation => count(activation.reached).toLocaleString() },
    ]}/>
  </Stack>;
}
