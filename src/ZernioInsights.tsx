import React, { useEffect, useId, useRef, useState } from 'react';

type Account = { _id: string; platform: string; displayName?: string; username?: string; isActive?: boolean; reports: string[] };
type Choice = { id: string; label: string; publishedAt?: string | null };
type Point = { date: string; value: number | null };
type Base = { accountId: string; platform: string; loadedAt: string; note: string | null; range?: { fromDate: string; toDate: string } };
type Report = Base & (
  { kind: 'followers'; current: number | null; growth: number | null; growthPercentage: number | null; points: Point[] } |
  { kind: 'follower-history'; metrics: Record<string, { total: number | null; points: Point[] }> } |
  { kind: 'best-time'; source: string; slots: { day: number; hour: number; engagement: number; posts: number }[] } |
  { kind: 'demographics'; metric: string; requestedTimeframe: string | null; providerTimeframe: string | null; snapshotDate: string | null; breakdowns: Record<string, { dimension: string; value: number }[]> } |
  { kind: 'online-followers'; days: { endTime: string; hours: Record<string, number> }[] } |
  { kind: 'story'; storyId: string; source: string; metrics: Record<string, number | null> } |
  { kind: 'retention'; videoId: string; title: string | null; duration: number | null; provisionalSince: string | null; hasAnalyticsScope: boolean; points: { position: number; watch: number; relative: number; started: number | null; stopped: number | null; impressions: number | null }[] }
);
type Props = { projectId: string; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any> };
const labels: Record<string, string> = { followers: 'Follower snapshots', 'best-time': 'Posting times', 'follower-history': 'Instagram follower history', demographics: 'Audience demographics', 'online-followers': 'Instagram online hours', story: 'Instagram Story insights', retention: 'YouTube video retention' };
const metricLabels: Record<string, string> = { follower_count: 'Follower count', followers_gained: 'Snapshot gains', followers_lost: 'Snapshot losses', tapsForward: 'Next slide taps', tapsBack: 'Previous slide taps', swipesForward: 'Next account swipes', profileVisits: 'Profile visits', totalInteractions: 'Total interactions' };
const number = (value: number | null | undefined, digits = 0) => typeof value === 'number' && Number.isFinite(value) ? new Intl.NumberFormat('en', { maximumFractionDigits: digits }).format(value) : '—';
const human = (value: string) => metricLabels[value] || value.replaceAll('_', ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
const dayNames = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export default function ZernioInsights({ projectId, request }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]), [accountId, setAccountId] = useState(''), [kind, setKind] = useState('followers');
  const [today] = useState(() => new Date().toISOString().slice(0, 10)), [from, setFrom] = useState(() => new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10)), [to, setTo] = useState(today);
  const [source, setSource] = useState('all'), [metric, setMetric] = useState('follower_demographics'), [timeframe, setTimeframe] = useState('this_month'), [postId, setPostId] = useState(''), [items, setItems] = useState<Choice[]>([]), [choicesLoaded, setChoicesLoaded] = useState(false);
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState(''), [report, setReport] = useState<{ data: Report; accountName: string } | null>(null);
  const requester = useRef(request), active = useRef(true), busyRef = useRef(false), reads = useRef(0), path = `/projects/${encodeURIComponent(projectId)}/integrations/insights`; requester.current = request;
  const identity = JSON.stringify([path, accountId, kind, from, to, source, metric, timeframe, postId]), scope = useRef({ identity }); if (scope.current.identity !== identity) scope.current = { identity };
  const view = scope.current, current = () => active.current && scope.current === view, account = accounts.find(row => row._id === accountId), chartId = useId();
  const dated = ['followers', 'follower-history', 'retention'].includes(kind), postReport = ['retention', 'story'].includes(kind), data = report?.data;
  useEffect(() => { busyRef.current = false; setBusy(false); }, [identity]);
  useEffect(() => {
    let keep = true; active.current = true; setAccounts([]); setAccountId(''); setKind('followers'); setItems([]); setReport(null); setError(''); setLoading(true); reads.current++;
    requester.current(`${path}/accounts`).then(response => { if (keep) setAccounts(response.accounts); }).catch(failure => { if (keep) setError(failure.message || 'Report accounts could not be loaded.'); }).finally(() => { if (keep) setLoading(false); });
    return () => { keep = false; active.current = false; reads.current++; };
  }, [path]);
  async function action(run: () => Promise<void>) {
    if (!current() || busyRef.current) return; busyRef.current = true; setBusy(true); setError('');
    try { await run(); } catch (failure) { if (current()) setError((failure as Error).message || 'The report could not be loaded.'); }
    finally { if (current()) { busyRef.current = false; setBusy(false); } }
  }
  async function loadChoices() {
    await action(async () => {
      const read = ++reads.current, response = await requester.current(`${path}/${encodeURIComponent(accountId)}/${kind === 'retention' ? 'videos' : 'stories'}`);
      if (!current() || reads.current !== read) return;
      if (!Array.isArray(response.items)) throw new Error('The video or Story list could not be read.'); setItems(response.items); setChoicesLoaded(true);
    });
  }
  async function load(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!account) return;
    await action(async () => {
      if (dated && (!from || !to || from > to || to > today || Date.parse(to) - Date.parse(from) >= (kind === 'follower-history' ? 89 : 366) * 86400000)) throw new Error(`Choose a valid date range of at most ${kind === 'follower-history' ? 89 : 366} inclusive days.`);
      if (postReport && !items.some(row => row.id === postId)) throw new Error('Load the account’s videos or Stories, then choose one.');
      const query = new URLSearchParams(dated ? { fromDate: from, toDate: to } : {});
      if (kind === 'best-time') query.set('source', source);
      if (kind === 'demographics' && account.platform === 'instagram') { query.set('metric', metric); query.set('timeframe', timeframe); }
      if (postReport) query.set(kind === 'retention' ? 'videoId' : 'storyId', postId);
      const read = ++reads.current, response = await requester.current(`${path}/${encodeURIComponent(accountId)}/${kind}?${query}`);
      if (!current() || reads.current !== read) return;
      if (!response.report || response.report.kind !== kind || response.report.accountId !== accountId || response.report.platform !== account.platform) throw new Error('The selected account report could not be read.');
      setReport({ data: response.report, accountName: account.displayName || account.username || account.platform });
    });
  }
  function resetReport() { reads.current++; setItems([]); setPostId(''); setChoicesLoaded(false); setReport(null); setError(''); }
  const maximum = data?.kind === 'retention' ? Math.max(1, ...data.points.map(row => row.watch)) : 1;
  return <section className="panel settings-panel">
    <div className="panel-heading"><div><h2>Audience and posting reports</h2><p>Inspect follower history, audience patterns and selected video or Story performance.</p></div></div>
    <p className="helper-note">Reports load only when requested. Some require the Zernio Analytics add-on or renewed platform permissions. Loading a video or Story list reads the platform API. Missing metrics appear as —.</p>
    <form onSubmit={load}><fieldset disabled={busy || loading}><div className="form-grid">
      <label className="field"><span>Social account</span><select required value={accountId} onChange={event => { setAccountId(event.target.value); setKind('followers'); resetReport(); }}><option value="">{loading ? 'Loading accounts…' : 'Choose an account'}</option>{accounts.map(row => <option key={row._id} value={row._id}>{row.displayName || row.username || row.platform} · {row.platform}{row.isActive === false ? ' · Inactive' : ''}</option>)}</select></label>
      {account && <label className="field"><span>Report</span><select value={kind} onChange={event => { setKind(event.target.value); resetReport(); }}>{account.reports.map(value => <option key={value} value={value}>{labels[value]}</option>)}</select></label>}
      {dated && <><label className="field"><span>From date (UTC)</span><input type="date" required value={from} max={to} onChange={event => setFrom(event.target.value)}/></label><label className="field"><span>To date (UTC)</span><input type="date" required value={to} min={from} max={today} onChange={event => setTo(event.target.value)}/></label></>}
      {kind === 'best-time' && <label className="field"><span>Post origin</span><select value={source} onChange={event => setSource(event.target.value)}><option value="all">All posts</option><option value="late">Published through Zernio</option><option value="external">External posts</option></select></label>}
      {kind === 'demographics' && account?.platform === 'instagram' && <><label className="field"><span>Audience</span><select value={metric} onChange={event => setMetric(event.target.value)}><option value="follower_demographics">Followers</option><option value="engaged_audience_demographics">Engaged viewers</option></select></label><label className="field"><span>Requested period</span><select value={timeframe} onChange={event => setTimeframe(event.target.value)}><option value="this_month">This month</option><option value="this_week">This week</option></select></label></>}
    </div>{postReport && account && <><button className="button" type="button" onClick={loadChoices}>{kind === 'retention' ? 'Load latest 25 videos' : 'Load active Stories'}</button>{choicesLoaded && !items.length && <p>No {kind === 'retention' ? 'recent videos' : 'active Stories'} were returned. Expired Stories and older videos are not selectable in this report.</p>}<label className="field"><span>{kind === 'retention' ? 'YouTube video' : 'Instagram Story'}</span><select required value={postId} onChange={event => setPostId(event.target.value)}><option value="">Choose a {kind === 'retention' ? 'video' : 'Story'}</option>{items.map(row => <option key={row.id} value={row.id}>{row.label.slice(0, 160)}{row.publishedAt ? ` · ${row.publishedAt.slice(0, 10)}` : ''}</option>)}</select></label></>}
      <button className="button primary" disabled={!account || postReport && !postId}>{busy ? 'Loading…' : 'Load report'}</button>
    </fieldset></form>
    {!loading && !accounts.length && <p>Connect a social account in project settings to load these reports.</p>}
    {error && <p className="alert" role="alert">{error}{report ? ' The last successful report remains below with its original account and period.' : ''}</p>}
    {data && <div className="settings-panel"><h3>{labels[data.kind]} · {report?.accountName}</h3>{data.range && <p>Reported period: {data.range.fromDate} to {data.range.toDate}</p>}<p className="helper-note">Loaded {new Date(data.loadedAt).toLocaleString()}. Provider data freshness is separate from this load time.</p>{data.note && <p className="helper-note">{data.note}</p>}
      {data.kind === 'followers' && <><div className="stat-grid"><section className="stat-card"><span>Current followers</span><strong>{number(data.current)}</strong></section><section className="stat-card"><span>Snapshot growth</span><strong>{number(data.growth)}</strong><p>{data.growthPercentage == null ? 'Growth percentage not reported' : `${number(data.growthPercentage, 2)}%`}</p></section></div>{!data.points.length ? <p>No follower snapshots were returned for this period.</p> : <div className="table-scroll"><table><thead><tr><th>Date</th><th>Followers</th></tr></thead><tbody>{data.points.map(row => <tr key={row.date}><td>{row.date}</td><td>{number(row.value)}</td></tr>)}</tbody></table></div>}</>}
      {data.kind === 'follower-history' && <>{['follower_count', 'followers_gained', 'followers_lost'].map(key => { const metric = data.metrics[key]; return <details key={key} open={key === 'follower_count'}><summary>{human(key)} · {number(metric?.total)}</summary>{!metric?.points.length ? <p>No daily values were returned for this metric.</p> : <div className="table-scroll"><table><thead><tr><th>Date</th><th>{human(key)}</th></tr></thead><tbody>{metric.points.map(row => <tr key={row.date}><td>{row.date}</td><td>{number(row.value)}</td></tr>)}</tbody></table></div>}</details>; })}</>}
      {data.kind === 'best-time' && <><p>Post origin: {data.source === 'all' ? 'All posts' : data.source === 'late' ? 'Published through Zernio' : 'External posts'}</p>{!data.slots.length ? <p>No matching posting history was returned. No recommended time can be calculated.</p> : <div className="table-scroll"><table><thead><tr><th>Day</th><th>Hour (UTC)</th><th>Average engagement</th><th>Posts in sample</th></tr></thead><tbody>{data.slots.map(row => <tr key={`${row.day}:${row.hour}`}><td>{dayNames[row.day]}</td><td>{String(row.hour).padStart(2, '0')}:00</td><td>{number(row.engagement, 2)}</td><td>{number(row.posts)}</td></tr>)}</tbody></table></div>}</>}
      {data.kind === 'demographics' && <><p>Audience: {data.metric === 'engaged_audience_demographics' ? 'Engaged viewers' : 'Followers'}</p>{data.snapshotDate && <p>Provider snapshot: {data.snapshotDate}</p>}{data.requestedTimeframe && <p>Requested: {human(data.requestedTimeframe)} · Provider period: {data.providerTimeframe ? human(data.providerTimeframe) : 'Not reported'}</p>}{!Object.keys(data.breakdowns).length && <p>No audience breakdowns were returned. Eligibility and privacy thresholds can suppress this data.</p>}{Object.entries(data.breakdowns).map(([key, values]) => <details key={key} open><summary>{human(key)}</summary>{!values.length ? <p>No entries were reported for this dimension.</p> : <div className="table-scroll"><table><thead><tr><th>{human(key)}</th><th>Accounts, as reported</th></tr></thead><tbody>{values.map((row, index) => <tr key={`${row.dimension}:${index}`}><td>{row.dimension}</td><td>{number(row.value)}</td></tr>)}</tbody></table></div>}</details>)}</>}
      {data.kind === 'online-followers' && <>{!data.days.length ? <p>No hourly audience data was reported. The account may be below the eligibility threshold or still processing.</p> : data.days.map(row => <details key={row.endTime}><summary>Provider day ending {row.endTime}</summary><div className="table-scroll"><table><thead><tr><th>Provider hour key (timezone unknown)</th><th>Followers online</th></tr></thead><tbody>{Object.entries(row.hours).sort(([a], [b]) => Number(a) - Number(b)).map(([hour, value]) => <tr key={hour}><td>{hour}</td><td>{number(value)}</td></tr>)}</tbody></table></div></details>)}</>}
      {data.kind === 'story' && <><p>Story {data.storyId} · Source: <strong>{data.source}</strong></p>{data.source === 'unavailable' && <p>No captured Story metrics are available. Displayed values are unknown.</p>}<div className="table-scroll"><table><thead><tr><th>Metric</th><th>Count</th></tr></thead><tbody>{Object.entries(data.metrics).map(([key, value]) => <tr key={key}><td>{human(key)}</td><td>{number(value)}</td></tr>)}</tbody></table></div></>}
      {data.kind === 'retention' && <><p>{data.title || data.videoId}{data.duration != null ? ` · ${number(data.duration)} seconds` : ''}</p>{!data.hasAnalyticsScope && <p className="alert">Reconnect YouTube with analytics permission before relying on this report.</p>}{data.provisionalSince && <p className="alert">Data from {data.provisionalSince} is provisional and may be revised.</p>}{!data.points.length ? <p>No retention curve was returned for this video and period.</p> : <><svg viewBox="0 0 1000 190" role="img" aria-labelledby={`${chartId}-title ${chartId}-desc`} style={{ display: 'block', width: '100%', minHeight: 150 }}><title id={`${chartId}-title`}>Video audience retention</title><desc id={`${chartId}-desc`}>Audience watch percentage across the video. Rewatches can exceed 100 percent. Exact values are in the table below.</desc><line x1="10" x2="990" y1="150" y2="150" stroke="currentColor" opacity="0.3"/><polyline points={data.points.map(row => `${10 + row.position * 980},${150 - row.watch / maximum * 130}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="3"/><text x="10" y="180" fill="currentColor">Start</text><text x="990" y="180" textAnchor="end" fill="currentColor">End · Peak {number(Math.max(...data.points.map(row => row.watch)) * 100, 2)}%</text></svg><details><summary>Retention values</summary><div className="table-scroll"><table><thead><tr><th>Video position</th><th>Time (seconds)</th><th>Audience watch</th><th>Relative performance</th><th>Started</th><th>Stopped</th><th>Segment views</th></tr></thead><tbody>{data.points.map(row => <tr key={row.position}><td>{number(row.position * 100, 2)}%</td><td>{data.duration == null ? '—' : number(row.position * data.duration, 2)}</td><td>{number(row.watch * 100, 2)}%</td><td>{number(row.relative * 100, 2)}%</td><td>{number(row.started)}</td><td>{number(row.stopped)}</td><td>{number(row.impressions)}</td></tr>)}</tbody></table></div></details></>}</>}
    </div>}
  </section>;
}
