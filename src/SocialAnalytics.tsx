import React, { useId, useState } from 'react';

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
  return <section className="panel">
    <div className="panel-heading"><div><h2>Social performance</h2><p>{report ? `Reported activity · ${report.from} to ${report.to}` : 'Load a report from your connected social channels.'}</p></div></div>
    <form onSubmit={load} style={{ padding: '0 22px 20px' }}>
      <fieldset disabled={busy || !connected}>
        <div className="form-grid">
          <label className="field"><span>From date</span><input type="date" required value={from} max={to || today} onChange={event => setFrom(event.target.value)}/></label>
          <label className="field"><span>To date</span><input type="date" required value={to} min={from} max={today} onChange={event => setTo(event.target.value)}/></label>
        </div>
        <button className="button primary">{busy ? 'Loading report…' : report ? 'Refresh report' : 'Load social report'}</button>
      </fieldset>
      {!connected && <p className="helper-note">Connect Zernio and map this project to a profile in settings to load social performance.</p>}
      {error && <p className="alert" role="alert">{error}{report ? ' The last successful report is still shown below.' : ''}</p>}
    </form>
    {data && <>
      <div className="stat-grid" style={{ padding: '0 22px' }}>
        <section className="stat-card"><div><span>Impressions</span></div><strong>{number(data.totals.impressions)}</strong><p>Times your content was displayed</p></section>
        <section className="stat-card"><div><span>Reach</span></div><strong>{number(data.totals.reach)}</strong><p>Accounts reached, as reported</p></section>
        <section className="stat-card"><div><span>Engagement rate</span></div><strong>{numeric(data.totals.engagementRate) ? `${number(data.totals.engagementRate, 2)}%` : '—'}</strong><p>Rate reported by your channels</p></section>
        <section className="stat-card"><div><span>Followers</span></div><strong>{number(data.followers?.current)}</strong><p>Gained in this period: {number(data.followers?.gained)}</p></section>
      </div>
      <div className="panel-heading"><div><h3>Daily impressions</h3><p>Dates follow the provider’s reporting day.</p></div></div>
      {hasDaily ? <div style={{ padding: '0 22px 20px' }}>
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
      </div> : <div className="empty"><p>No daily impressions were returned for this date range.</p></div>}
      <div className="panel-heading"><div><h3>Top posts</h3><p>Showing all {topPosts.length} posts returned in this reporting summary.</p></div></div>
      {topPosts.length ? <div className="table-scroll"><table><thead><tr><th>Post / channel</th><th>Published</th><th>Impressions</th><th>Reach</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Engagement</th></tr></thead><tbody>{topPosts.map((post, index) => <tr key={`${post.postId}-${index}`}><td><strong>{post.postId || '—'}</strong><br/>{post.platform || '—'}</td><td>{post.publishedAt?.slice(0, 10) || '—'}</td><td>{number(post.metrics?.impressions)}</td><td>{number(post.metrics?.reach)}</td><td>{number(post.metrics?.likes)}</td><td>{number(post.metrics?.comments)}</td><td>{number(post.metrics?.shares)}</td><td>{numeric(post.metrics?.engagementRate) ? `${number(post.metrics.engagementRate, 2)}%` : '—'}</td></tr>)}</tbody></table></div> : <div className="empty"><p>No top posts were returned for this date range.</p></div>}
      <p className="helper-note" style={{ padding: '16px 22px' }}>{data.dataAsOf ? `Provider data as of ${data.dataAsOf}.` : 'The provider did not report when this data was updated.'} Missing values appear as —.</p>
    </>}
  </section>;
}
