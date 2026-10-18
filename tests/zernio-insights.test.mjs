import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { handleZernioInsights } from '../server/zernio-insights.mjs';
import { IntegrationError } from '../server/integrations.mjs';

const profileId = 'profile-a', range = { fromDate: '2026-09-01', toDate: '2026-09-03' }, dateQuery = '?fromDate=2026-09-01&toDate=2026-09-03';
function setup() {
  const accounts = ['instagram', 'facebook', 'youtube', 'twitter', 'googleads'].map(platform => ({ _id: `${platform}-a`, platform, profileId, isActive: true, displayName: `${platform} account` })); accounts.push({ _id: 'foreign', platform: 'instagram', profileId: 'other-profile', isActive: true });
  const calls = [], state = { override: new Map(), fail: null, video: 'dQw4w9WgXcQ', story: 'story-a' };
  const api = async (path, query = {}) => {
    calls.push({ path, query });
    if (path === '/accounts') { assert.equal(query.profileId, profileId); return { accounts: structuredClone(accounts) }; }
    if (state.fail) throw state.fail;
    if (state.override.has(path)) return structuredClone(state.override.get(path));
    const accountId = query.accountId, platform = accountId?.split('-')[0], base = { success: true, accountId, platform };
    if (path === '/accounts/follower-stats') { assert.equal(query.profileId, profileId); assert.equal(query.accountIds, 'instagram-a'); assert.equal(query.granularity, 'daily'); return { accounts: [{ _id: 'instagram-a', platform: 'instagram', currentFollowers: 0, growth: -2, growthPercentage: -100 }], stats: { 'instagram-a': [{ date: '2026-09-01', followers: 2 }, { date: '2026-09-03', followers: 0 }] }, dateRange: { from: '2026-09-01T00:00:00Z', to: '2026-09-03T23:59:59Z' }, granularity: 'daily' }; }
    if (path === '/analytics/best-time') { assert.equal(query.profileId, profileId); assert.ok(query.accountId); return { slots: [{ day_of_week: 0, hour: 0, avg_engagement: 0, post_count: 1 }] }; }
    if (path === '/analytics/instagram/follower-history') return { ...base, dateRange: { since: range.fromDate, until: range.toDate }, metricType: 'time_series', metrics: { follower_count: { total: 0, values: [{ date: range.toDate, value: 0 }] } } };
    if (path.endsWith('/demographics')) return { ...base, metric: query.metric || 'follower_demographics', ...(platform === 'instagram' ? { timeframe: 'last_30_days' } : { snapshotDate: null }), demographics: { country: [{ dimension: 'AE', value: 0 }], city: [] }, note: 'Provider privacy thresholds apply.' };
    if (path === '/analytics/instagram/online-followers') return { ...base, metric: 'online_followers', days: [{ endTime: '2026-09-03T07:00:00+0000', hours: { '0': 0, '23': 20 } }] };
    if (path === '/accounts/youtube-a/posts') return { status: 'success', posts: [{ id: state.video, platform: 'youtube', message: 'Campaign video', createdTime: '2026-08-01T10:00:00Z' }], lastUpdated: '2026-09-03T10:00:00Z' };
    if (path === '/analytics/youtube/video-retention') return { ...base, videoId: query.videoId, title: 'Campaign video', durationSeconds: 60, dateRange: { startDate: range.fromDate, endDate: range.toDate }, provisionalSince: range.toDate, scopeStatus: { hasAnalyticsScope: true }, retentionCurve: [{ elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1.5, relativeRetentionPerformance: 0.5, startedWatching: 0, stoppedWatching: 0, totalSegmentImpressions: 0 }, { elapsedVideoTimeRatio: 1, audienceWatchRatio: 0.2, relativeRetentionPerformance: 0.3 }] };
    if (path === '/accounts/instagram-a/instagram/stories') return { data: [{ id: state.story, mediaProductType: 'STORY', mediaType: 'VIDEO', timestamp: '2026-09-03T12:00:00Z' }] };
    if (path === '/accounts/instagram-a/instagram/stories/story-a/insights') return { data: { source: 'live', metrics: { views: 0, reach: 0, tapsForward: 0 } } };
    throw new Error(`Unexpected provider request: ${path}`);
  };
  async function request(action, method = 'GET') {
    let response; const url = new URL(`http://localhost/api/projects/project-a/integrations/insights/${action}`), context = { req: { method }, url, project: { id: 'project-a' }, role: 'viewer', send(status, data) { response = { status, data }; } };
    try { const handled = await handleZernioInsights(context, api, profileId, url.pathname.split('/insights/')[1]); return response || { handled }; }
    catch (error) { if (!(error instanceof IntegrationError)) throw error; return { status: error.status, data: { error: { code: error.code, message: error.message } } }; }
  }
  return { accounts, calls, state, request };
}

test('follower snapshots, best times and Instagram reports preserve zero, missing, period and project/account scope', async () => {
  const { calls, state, request } = setup();
  let result = await request('accounts'); assert.equal(result.status, 200); assert.equal(result.data.accounts.length, 4); assert.equal(JSON.stringify(result).includes('foreign'), false); assert.equal(JSON.stringify(result).includes('googleads'), false);
  result = await request('instagram-a/followers' + dateQuery); assert.equal(result.status, 200); assert.equal(result.data.report.current, 0); assert.equal(result.data.report.growth, -2); assert.deepEqual(result.data.report.points.map(row => row.date), ['2026-09-01', '2026-09-03']);
  result = await request('instagram-a/best-time?source=external'); assert.equal(result.status, 200); assert.equal(result.data.report.slots[0].engagement, 0); assert.equal(calls.at(-1).query.source, 'external'); assert.match(result.data.report.note, /UTC/);
  result = await request('instagram-a/follower-history' + dateQuery); assert.equal(result.status, 200); assert.equal(result.data.report.metrics.follower_count.total, 0); assert.equal(result.data.report.metrics.followers_lost, undefined);
  result = await request('instagram-a/demographics?metric=engaged_audience_demographics&timeframe=this_month'); assert.equal(result.status, 200); assert.equal(result.data.report.providerTimeframe, 'last_30_days'); assert.equal(result.data.report.requestedTimeframe, 'this_month'); assert.equal(result.data.report.metric, 'engaged_audience_demographics');
  result = await request('facebook-a/demographics'); assert.equal(result.status, 200); assert.equal(calls.at(-1).query.breakdown, 'country,city'); assert.equal(result.data.report.snapshotDate, null);
  result = await request('instagram-a/online-followers'); assert.equal(result.status, 200); assert.equal(result.data.report.days[0].hours['0'], 0); assert.equal(result.data.report.days[0].hours['1'], undefined); assert.match(result.data.report.note, /timezone is undocumented/);
  const before = calls.length; result = await request('foreign/demographics'); assert.equal(result.status, 403); assert.equal(calls.length, before + 1);
  result = await request('twitter-a/retention' + dateQuery + '&videoId=dQw4w9WgXcQ'); assert.equal(result.status, 422);
  for (const action of ['instagram-a/followers?fromDate=2026-02-30&toDate=2026-03-01', 'instagram-a/followers?fromDate=2025-01-01&toDate=2026-09-03', 'instagram-a/follower-history?fromDate=2026-01-01&toDate=2026-09-03', 'instagram-a/best-time?source=other', 'instagram-a/demographics?timeframe=last_year']) { const before = calls.length; assert.equal((await request(action)).status, 400, action); assert.equal(calls.length, before + 1, 'Invalid report input must not call a platform report.'); }
  assert.deepEqual(await request('instagram-a/followers' + dateQuery, 'POST'), { handled: false });
  state.override.set('/analytics/instagram/online-followers', { success: true, accountId: 'instagram-a', platform: 'instagram', days: [] }); result = await request('instagram-a/online-followers'); assert.equal(result.status, 200); assert.deepEqual(result.data.report.days, []);
});

test('recent owned videos and active Stories are rechecked before reports, with provisional, cached and unavailable states preserved', async () => {
  const { calls, state, request } = setup();
  let result = await request('youtube-a/videos'); assert.equal(result.status, 200); assert.equal(result.data.limit, 25); assert.equal(result.data.items[0].id, state.video);
  result = await request('youtube-a/retention' + dateQuery + '&videoId=' + state.video); assert.equal(result.status, 200); assert.equal(result.data.report.points[0].watch, 1.5); assert.equal(result.data.report.points[1].started, null); assert.equal(result.data.report.provisionalSince, '2026-09-03');
  const before = calls.filter(row => row.path === '/analytics/youtube/video-retention').length; result = await request('youtube-a/retention' + dateQuery + '&videoId=private-video'); assert.equal(result.status, 403); assert.equal(calls.filter(row => row.path === '/analytics/youtube/video-retention').length, before);
  result = await request('instagram-a/stories'); assert.equal(result.status, 200); assert.equal(result.data.items[0].id, 'story-a');
  for (const source of ['live', 'cached', 'unavailable']) { state.override.set('/accounts/instagram-a/instagram/stories/story-a/insights', { data: { source, metrics: { views: 0, reach: 0 } } }); result = await request('instagram-a/story?storyId=story-a'); assert.equal(result.status, 200); assert.equal(result.data.report.source, source); assert.equal(result.data.report.metrics.views, source === 'unavailable' ? null : 0); assert.equal(result.data.report.metrics.follows, null); }
  state.story = 'new-story'; const detailCalls = calls.filter(row => row.path.endsWith('/story-a/insights')).length; result = await request('instagram-a/story?storyId=story-a'); assert.equal(result.status, 403); assert.equal(calls.filter(row => row.path.endsWith('/story-a/insights')).length, detailCalls);
  state.override.set('/accounts/youtube-a/posts', { status: 'success', posts: [{ id: 'dQw4w9WgXcQ', platform: 'youtube', accountId: 'foreign' }] }); assert.equal((await request('youtube-a/videos')).status, 502);
});

test('malformed, wrong-account and wrong-date provider reports fail without treating omitted metrics as zero', async () => {
  const { state, request } = setup();
  for (const response of [{ slots: [{ day_of_week: 7, hour: 1, avg_engagement: 1, post_count: 1 }] }, { slots: [{ day_of_week: 1, hour: 0, avg_engagement: '1', post_count: 1 }] }, { accountId: 'foreign', slots: [] }, { slots: [{ day_of_week: 0, hour: 0, avg_engagement: 0, post_count: 1 }, { day_of_week: 0, hour: 0, avg_engagement: 1, post_count: 1 }] }]) { state.override.set('/analytics/best-time', response); assert.equal((await request('instagram-a/best-time')).status, 502); }
  const followers = { accounts: [{ _id: 'instagram-a', platform: 'instagram', currentFollowers: 0 }], stats: { 'instagram-a': [] }, dateRange: { from: range.fromDate, to: range.toDate }, granularity: 'daily' };
  for (const patch of [{ accounts: [{ _id: 'foreign', platform: 'instagram' }] }, { stats: { foreign: [] } }, { stats: { 'instagram-a': false } }, { dateRange: { from: '2026-08-01', to: range.toDate } }, { stats: { 'instagram-a': [{ date: '2026-08-01', followers: 0 }] } }, { stats: { 'instagram-a': [{ date: range.fromDate, followers: {} }] } }]) { state.override.set('/accounts/follower-stats', { ...followers, ...patch }); assert.equal((await request('instagram-a/followers' + dateQuery)).status, 502); }
  state.override.set('/accounts/follower-stats', { ...followers, accounts: [] }); const missing = await request('instagram-a/followers' + dateQuery); assert.equal(missing.status, 200); assert.equal(missing.data.report.current, null);
  for (const [path, action, response] of [
    ['/analytics/instagram/follower-history', 'instagram-a/follower-history' + dateQuery, { success: true, accountId: 'instagram-a', platform: 'instagram', metricType: 'time_series', dateRange: { since: range.fromDate, until: range.toDate }, metrics: { follower_count: { values: [{ date: range.fromDate, value: 1 }, { date: range.fromDate, value: 1 }] } } }],
    ['/analytics/instagram/demographics', 'instagram-a/demographics', { success: true, accountId: 'instagram-a', platform: 'instagram', metric: 'follower_demographics', demographics: { country: [{ dimension: 'AE', value: {} }] } }],
    ['/analytics/instagram/online-followers', 'instagram-a/online-followers', { success: true, accountId: 'instagram-a', platform: 'instagram', days: [{ endTime: '2026-09-03T07:00:00Z', hours: { '24': 10 } }] }],
    ['/accounts/instagram-a/instagram/stories/story-a/insights', 'instagram-a/story?storyId=story-a', { data: { source: 'live', metrics: { views: '0' } } }]
  ]) { state.override.set(path, response); assert.equal((await request(action)).status, 502, path); }
});

test('analytics add-on and platform permission failures provide specific recovery without exposing upstream secrets', async () => {
  const { state, request } = setup();
  for (const [status, code] of [[402, 'ANALYTICS_ADDON_REQUIRED'], [412, 'ANALYTICS_PERMISSION_REQUIRED']]) { state.fail = Object.assign(new IntegrationError(400, 'PROVIDER_REJECTED', 'sanitized rejection'), { providerStatus: status }); const result = await request('instagram-a/best-time'); assert.equal(result.status, status); assert.equal(result.data.error.code, code); }
});

test('actual report UI preserves a previous successful report after failure and ignores responses from a departed or returned view', async () => {
  const source = await readFile(new URL('../src/ZernioInsights.tsx', import.meta.url), 'utf8'), compile = (start, end, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))))});`)(...Object.values(context));
  const accepted = [], errors = [], busyRef = { current: false }, reads = { current: 0 }; let active = true, finish, reject;
  const current = () => active, action = compile('async function action(', '  async function loadChoices(', { current, busyRef, setBusy() {}, setError: value => errors.push(value) });
  const context = { current, account: { _id: 'instagram-a', platform: 'instagram', displayName: 'Original account' }, accountId: 'instagram-a', action, dated: true, from: range.fromDate, to: range.toDate, today: '2026-10-18', kind: 'followers', postReport: false, items: [], postId: '', source: 'all', metric: 'follower_demographics', timeframe: 'this_month', reads, requester: { current: () => new Promise((resolve, fail) => { finish = resolve; reject = fail; }) }, path: '/projects/project-a/integrations/insights', setReport: value => accepted.push(value) };
  const load = compile('async function load(', '  function resetReport(', context), event = { preventDefault() {} }, report = { kind: 'followers', accountId: 'instagram-a', platform: 'instagram' };
  let pending = load(event); finish({ report }); await pending; assert.equal(accepted.length, 1);
  pending = load(event); reject(new Error('Synthetic report timeout')); await pending; assert.equal(accepted.length, 1); assert.match(errors.at(-1), /timeout/);
  pending = load(event); active = false; finish({ report }); await pending; assert.equal(accepted.length, 1);
  const scope = { current: { identity: 'A' } }, view = scope.current, mounted = { current: true }, expression = source.match(/current = (\(\) => active.current && scope.current === view)/)[1], staleCurrent = new Function('active', 'scope', 'view', `return (${expression});`)(mounted, scope, view), update = new Function('scope', 'identity', source.match(/if \(scope.current.identity !== identity\) scope.current = \{ identity \};/)[0]);
  update(scope, 'B'); update(scope, 'A'); assert.equal(staleCurrent(), false, 'Returning to the same account/filter text must not revive an old request.');
});

test('rendered specialist reports identify old filters, unknown Story data, undocumented hourly timezone and retention above 100%', async () => {
  const source = await readFile(new URL('../src/ZernioInsights.tsx', import.meta.url), 'utf8'), start = source.indexOf('  return <section'), end = source.lastIndexOf('\n}'), { code } = await transformWithOxc(`const render = () => (${source.slice(start + '  return '.length, end).trim().replace(/;$/, '')});`, 'InsightsView.tsx', { jsx: { runtime: 'classic' } });
  const helpers = new Function(stripTypeScriptTypes(source.slice(source.indexOf('const labels:'), source.indexOf('export default'))) + '; return {labels,metricLabels,number,human,dayNames};')();
  function render(data, maximum = 1) {
    const account = { _id: data.accountId, platform: data.platform, reports: [data.kind] }, context = { React, ...helpers, account, accountId: account._id, accounts: [account], busy: false, loading: false, kind: data.kind, dated: false, postReport: false, source: 'all', metric: 'follower_demographics', timeframe: 'this_month', from: range.fromDate, to: range.toDate, today: '2026-10-18', postId: '', items: [], choicesLoaded: false, report: { data, accountName: 'Captured report account' }, data, maximum, chartId: 'retention-test', error: 'Refresh failed.', load() {}, loadChoices() {}, setAccountId() {}, setKind() {}, resetReport() {}, setFrom() {}, setTo() {}, setSource() {}, setMetric() {}, setTimeframe() {}, setPostId() {} };
    return renderToStaticMarkup(new Function(...Object.keys(context), code + '; return render;')(...Object.values(context))());
  }
  const base = { accountId: 'instagram-a', platform: 'instagram', loadedAt: '2026-09-03T10:00:00Z', note: null };
  let html = render({ ...base, kind: 'story', storyId: 'story-a', source: 'unavailable', metrics: { views: null } }); assert.match(html, /Displayed values are unknown/); assert.match(html, /—/); assert.match(html, /original account and period/);
  html = render({ ...base, kind: 'online-followers', days: [{ endTime: '2026-09-03T07:00:00Z', hours: { '0': 0 } }] }); assert.match(html, /timezone unknown/);
  html = render({ ...base, kind: 'best-time', source: 'external', slots: [] }); assert.match(html, /Post origin: External posts/); assert.match(html, /No recommended time can be calculated/);
  html = render({ ...base, kind: 'retention', platform: 'youtube', videoId: 'dQw4w9WgXcQ', title: 'Video', duration: 60, provisionalSince: range.toDate, hasAnalyticsScope: true, points: [{ position: 1, watch: 1.5, relative: 0.5, started: 0, stopped: null, impressions: null }] }, 1.5); assert.match(html, /150%/); assert.match(html, /provisional/);
  html = render({ ...base, kind: 'retention', platform: 'youtube', videoId: 'dQw4w9WgXcQ', title: 'Video', duration: 60, provisionalSince: null, hasAnalyticsScope: true, points: [{ position: 1, watch: 0.5, relative: 0.5, started: 0, stopped: null, impressions: null }] }); assert.match(html, /Peak 50%/);
});

test('actual insights form reloads the same report and switches accounts after successful component renders', async () => {
  const source = await readFile(new URL('../src/ZernioInsights.tsx', import.meta.url), 'utf8'), component = source.slice(source.indexOf('const labels:')).replace('export default function ', 'function '), { code } = await transformWithOxc(component, 'InsightsInteraction.tsx', { jsx: { runtime: 'classic' } });
  const hooks = [], queued = [], calls = [], accounts = [{ _id: 'youtube-a', platform: 'youtube', reports: ['followers', 'retention'] }, { _id: 'facebook-a', platform: 'facebook', reports: ['followers', 'demographics'] }]; let cursor = 0, dirty = true, tree, finish, fail = false;
  const state = initial => { const index = cursor++; if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }; return [hooks[index].value, value => { const next = typeof value === 'function' ? value(hooks[index].value) : value; if (!Object.is(next, hooks[index].value)) { hooks[index].value = next; dirty = true; } }]; };
  const ref = initial => { const index = cursor++; return hooks[index] ||= { current: initial }; };
  const effect = (run, dependencies) => { const index = cursor++, old = hooks[index]; if (!old || dependencies.some((value, key) => !Object.is(value, old.dependencies[key]))) { hooks[index] = { dependencies, close: old?.close }; queued.push(() => { hooks[index].close?.(); hooks[index].close = run(); }); } };
  const request = async path => {
    calls.push(path); if (path.endsWith('/accounts')) return { accounts };
    if (path.endsWith('/videos')) return { items: [{ id: 'video-one', label: 'Campaign video' }] };
    await new Promise(resolve => { finish = resolve; }); if (fail) throw new Error('Analytics add-on required.');
    const platform = path.includes('/youtube-a/') ? 'youtube' : 'facebook', kind = path.includes('/retention?') ? 'retention' : 'followers';
    return { report: { kind, accountId: `${platform}-a`, platform, loadedAt: '2026-10-18T10:00:00Z', note: null, ...(kind === 'retention' ? { videoId: 'video-one', title: 'Campaign video', duration: 60, provisionalSince: null, hasAnalyticsScope: true, points: [] } : { current: 1, growth: 0, growthPercentage: 0, points: [] }) } };
  };
  const Component = new Function('React', 'useState', 'useRef', 'useEffect', 'useId', code + ';return ZernioInsights;')(React, state, ref, effect, () => 'report-id');
  function paint() { for (let pass = 0; dirty; pass++) { assert.ok(pass < 20, 'Rendering must settle.'); dirty = false; cursor = 0; tree = Component({ projectId: 'project-a', request }); while (queued.length) queued.shift()(); } }
  const tick = async () => { await new Promise(resolve => setImmediate(resolve)); paint(); };
  const nodes = node => !node || typeof node !== 'object' ? [] : [node, ...React.Children.toArray(node.props?.children).flatMap(nodes)];
  const change = async (label, value) => { const field = nodes(tree).find(node => node.type === 'label' && nodes(node).some(child => child.type === 'span' && child.props.children === label)), select = nodes(field).find(node => node.type === 'select'); assert.ok(select, label); select.props.onChange({ target: { value } }); await tick(); };
  const submit = () => { const form = nodes(tree).find(node => node.type === 'form'); return form.props.onSubmit({ preventDefault() {} }); };
  paint(); await tick(); await change('Social account', 'youtube-a'); await change('Report', 'retention');
  await nodes(tree).find(node => node.type === 'button' && node.props.children === 'Load latest 25 videos').props.onClick(); await tick(); await change('YouTube video', 'video-one');
  for (let attempt = 0; attempt < 2; attempt++) { const before = calls.length, loading = submit(); paint(); assert.equal(calls.length, before + 1, 'Every same-report submission must reach the requester.'); finish(); await loading; await tick(); assert.equal(nodes(tree).find(node => node.type === 'fieldset').props.disabled, false); }
  await change('Social account', 'facebook-a'); fail = true; const before = calls.length, loading = submit(); paint(); assert.equal(calls.length, before + 1, 'Account switching must leave report submission usable.'); assert.match(calls.at(-1), /facebook-a\/followers\?/); finish(); await loading; await tick(); assert.match(renderToStaticMarkup(tree), /Analytics add-on required/); assert.equal(nodes(tree).find(node => node.type === 'fieldset').props.disabled, false);
});
