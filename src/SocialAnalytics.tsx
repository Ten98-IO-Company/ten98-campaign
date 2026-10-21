import React, { useId, useState } from 'react';
import { Alert, Button, Card, DataTable, Field, FormActions, FormGrid, Heading, Input, MetricCard, MetricGrid, Stack, Text } from '@ten98/ui';

type Metrics = { impressions?: number | null; reach?: number | null; likes?: number | null; comments?: number | null; shares?: number | null; saves?: number | null; clicks?: number | null; views?: number | null; engagementRate?: number | null };
type Dashboard = { totals: Metrics; followers?: { current?: number | null; gained?: number | null }; daily: { date: string; impressions?: number | null }[]; topPosts?: { postId: string; platform?: string; publishedAt?: string; metrics?: Metrics }[]; dataAsOf?: string | null };
type Props = { request: (path: string, body?: any) => Promise<any>; connected: boolean };
const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const number = (value: unknown, digits = 0) => numeric(value) ? new Intl.NumberFormat('en', { maximumFractionDigits: digits }).format(value) : '—';
const inputDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export default function SocialAnalytics({ request, connected }: Props) {
  const [today] = useState(() => inputDate(new Date()));
  const [from, setFrom] = useState(() => { const date = new Date(); date.setDate(date.getDate() - 29); return inputDate(date); });
  const [to, setTo] = useState(today), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [report, setReport] = useState<{ data: Dashboard; from: string; to: string } | null>(null);
  const chartId = useId(), data = report?.data;
  const daily = data?.daily || [], topPosts = data?.topPosts || [];
  const maximum = Math.max(1, ...daily.map(day => numeric(day.impressions) ? day.impressions : 0));
  const hasDaily = daily.some(day => numeric(day.impressions)), barWidth = daily.length ? 960 / daily.length : 0;
  async function load(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !connected) return;
    setError('');
    if (!from || !to || from > to || Date.parse(to) - Date.parse(from) >= 366 * 86400000) { setError('Choose a start date before the end date, with a range of at most 366 days.'); return; }
    setBusy(true);
    try {
      const response = await request(`analytics/dashboard?fromDate=${encodeURIComponent(from)}&toDate=${encodeURIComponent(to)}`);
      const dashboard = response?.data?.totals ? response.data : response;
      if (!dashboard?.totals || !Array.isArray(dashboard.daily)) throw new Error('The provider did not return a readable social performance report.');
      setReport({ data: dashboard, from, to });
    } catch (err) { setError((err as Error).message || 'Social performance could not be loaded.'); }
    finally { setBusy(false); }
  }
  return <Card as="section" title="Social performance" description={report ? `Reported activity · ${report.from} to ${report.to}` : 'Load a report from your connected social channels.'} headingLevel={2}><Stack gap={4}>
    <Stack as="form" gap={3} onSubmit={load}>
      <Stack as="fieldset" gap={3} disabled={busy || !connected}>
        <FormGrid>
          <Field label="From date"><Input type="date" required value={from} max={to || today} onChange={event => setFrom(event.target.value)}/></Field>
          <Field label="To date"><Input type="date" required value={to} min={from} max={today} onChange={event => setTo(event.target.value)}/></Field>
        </FormGrid>
        <FormActions><Button type="submit">{busy ? 'Loading report…' : report ? 'Refresh report' : 'Load social report'}</Button></FormActions>
      </Stack>
      {!connected && <Text tone="muted" size="sm">Connect Zernio and map this project to a profile in settings to load social performance.</Text>}
      {error && <Alert tone="danger" role="alert">{error}{report ? ' The last successful report is still shown below.' : ''}</Alert>}
    </Stack>
    {data && <>
      <MetricGrid>
        <MetricCard label="Impressions" value={number(data.totals.impressions)} hint="Times your content was displayed"/>
        <MetricCard label="Reach" value={number(data.totals.reach)} hint="Accounts reached, as reported"/>
        <MetricCard label="Engagement rate" value={numeric(data.totals.engagementRate) ? `${number(data.totals.engagementRate, 2)}%` : '—'} hint="Rate reported by your channels"/>
        <MetricCard label="Followers" value={number(data.followers?.current)} hint={`Gained in this period: ${number(data.followers?.gained)}`}/>
      </MetricGrid>
      <Stack gap={1}><Heading level={3}>Daily impressions</Heading><Text tone="muted" size="sm">Dates follow the provider’s reporting day.</Text></Stack>
      {hasDaily ? <>
        {/* Native chart until @ten98/ui ships charts (U1) */}
        <svg viewBox="0 0 1000 185" role="img" aria-labelledby={`${chartId}-title ${chartId}-description`} style={{ display: 'block', width: '100%', minHeight: 150 }}>
          <title id={`${chartId}-title`}>Daily social impressions, {report?.from} to {report?.to}</title>
          <desc id={`${chartId}-description`}>Each bar represents a date reported by the provider. Focus a bar for its exact date and impressions. Missing values have no bar.</desc>
          <line x1="20" y1="150" x2="980" y2="150" stroke="currentColor" opacity="0.2"/>
          {daily.map((day, index) => {
            const height = numeric(day.impressions) ? Math.max(0, day.impressions) / maximum * 125 : 0;
            const label = `${day.date}: ${number(day.impressions)} impressions`;
            return <g key={`${day.date}-${index}`} tabIndex={0} role="img" aria-label={label}><title>{label}</title><rect x={20 + index * barWidth} y={150 - height} width={Math.max(0.5, barWidth * 0.75)} height={Math.max(0, height)} fill="currentColor"/><rect x={20 + index * barWidth} y="20" width={Math.max(0.5, barWidth)} height="132" fill="transparent"/></g>;
          })}
          <text x="20" y="175" fill="currentColor" fontSize="12">{daily[0]?.date}</text>
          <text x="980" y="175" textAnchor="end" fill="currentColor" fontSize="12">{daily.at(-1)?.date}</text>
          <text x="980" y="16" textAnchor="end" fill="currentColor" fontSize="12">Peak: {number(Math.max(...daily.filter(day => numeric(day.impressions)).map(day => day.impressions!)))}</text>
        </svg>
      </> : <Text>No daily impressions were returned for this date range.</Text>}
      <Stack gap={1}><Heading level={3}>Top posts</Heading><Text tone="muted" size="sm">Showing all {topPosts.length} posts returned in this reporting summary.</Text></Stack>
      {topPosts.length ? <DataTable ariaLabel="Top posts" searchable={false} sortable={false} pagination={false} rows={topPosts.map((post, index) => ({ ...post, index }))} rowKey={post => `${post.postId}-${post.index}`} columns={[
        { key: 'post', header: 'Post / channel', render: post => <Stack gap={0}><Text as="strong">{post.postId || '—'}</Text><Text as="span">{post.platform || '—'}</Text></Stack> },
        { key: 'published', header: 'Published', render: post => post.publishedAt?.slice(0, 10) || '—' },
        { key: 'impressions', header: 'Impressions', render: post => number(post.metrics?.impressions) },
        { key: 'reach', header: 'Reach', render: post => number(post.metrics?.reach) },
        { key: 'likes', header: 'Likes', render: post => number(post.metrics?.likes) },
        { key: 'comments', header: 'Comments', render: post => number(post.metrics?.comments) },
        { key: 'shares', header: 'Shares', render: post => number(post.metrics?.shares) },
        { key: 'engagement', header: 'Engagement', render: post => numeric(post.metrics?.engagementRate) ? `${number(post.metrics.engagementRate, 2)}%` : '—' }]}/> : <Text>No top posts were returned for this date range.</Text>}
      <Text tone="muted" size="sm">{data.dataAsOf ? `Provider data as of ${data.dataAsOf}.` : 'The provider did not report when this data was updated.'} Missing values appear as —.</Text>
    </>}
  </Stack></Card>;
}
