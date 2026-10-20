import { IntegrationError, scopedAccounts, requireAccount } from './provider-core.ts';
import { PLATFORM_RULES, validPostInstant } from '../shared/social-posts.ts';

const fail = (status, code, message) => { throw new IntegrationError(status, code, message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max = 4000) => typeof value === 'string' && value.length <= max;
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const count = value => numeric(value) && value >= 0;
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const instant = value => typeof value === 'string' && value.length <= 100 && Number.isFinite(Date.parse(value));
const id = value => { if (!text(value, 500) || !value || /[\s\u0000-\u001f]/.test(value)) fail(400, 'INVALID_REPORT_ACCOUNT', 'Choose a valid connected account.'); return value; };
const bad = () => fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned an unreadable or inconsistent report.');
const amount = (value, signed = false) => { if (value == null) return null; if (!(signed ? numeric(value) : count(value))) bad(); return value; };
const reports = platform => platform === 'whatsapp' ? ['whatsapp-pricing'] : ['followers', 'best-time', ...(platform === 'instagram' ? ['follower-history', 'demographics', 'online-followers', 'story'] : platform === 'facebook' ? ['demographics'] : platform === 'youtube' ? ['retention'] : platform === 'tiktok' ? ['tiktok-account'] : platform === 'linkedin' ? ['linkedin-personal', 'linkedin-organization'] : [])];
function dates(url, max = 366, exclusive = false) {
  const fromDate = url.searchParams.get('fromDate'), toDate = url.searchParams.get('toDate');
  if (!day(fromDate) || !day(toDate) || fromDate > toDate || exclusive && fromDate === toDate || toDate > new Date().toISOString().slice(0, 10) || (exclusive ? Date.parse(toDate) - Date.parse(fromDate) > max * 86400000 : Date.parse(toDate) - Date.parse(fromDate) >= max * 86400000)) fail(400, 'INVALID_REPORT_DATES', `Choose a valid past date range of at most ${max} ${exclusive ? 'days (end date excluded)' : 'inclusive days'}.`);
  return { fromDate, toDate };
}
function scope(response, account, profileId, required = true) {
  if (!object(response) || required && (response.success !== true || response.accountId !== account._id) || response.success !== undefined && response.success !== true || response.accountId !== undefined && response.accountId !== account._id || response.platform !== undefined && response.platform !== account.platform || response.profileId != null && String(response.profileId?._id || response.profileId) !== profileId) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned a report outside the selected account or project.');
}
function note(response) { if (response.note != null && !text(response.note)) bad(); return response.note || null; }
function rows(value, limit = 1000) { if (!Array.isArray(value) || value.length > limit) bad(); return value; }
function datedRows(value, range, key = 'followers', exclusive = false) {
  const result = rows(value).map(row => { if (!object(row) || !day(row.date) || row.date < range.fromDate || (exclusive ? row.date >= range.toDate : row.date > range.toDate)) bad(); return { date: row.date, value: amount(row[key]) }; });
  if (new Set(result.map(row => row.date)).size !== result.length) bad(); return result.sort((a, b) => a.date.localeCompare(b.date));
}
async function choices(api, account, stories, profileId) {
  const response = await api(stories ? `/accounts/${encodeURIComponent(account._id)}/instagram/stories` : `/accounts/${encodeURIComponent(account._id)}/posts`);
  scope(response, account, profileId, false);
  if (!stories && response.status !== 'success') bad();
  const items = rows(stories ? response.data : response.posts, stories ? 1000 : 25).map(row => {
    if (!object(row) || !text(row.id, 500) || !row.id || /\s/.test(row.id) || !stories && (row.platform !== 'youtube' || !/^[A-Za-z0-9_-]{11}$/.test(row.id)) || stories && row.mediaProductType != null && row.mediaProductType !== 'STORY' || row.message != null && !text(row.message) || (row.timestamp ?? row.createdTime) != null && !instant(row.timestamp ?? row.createdTime)) bad();
    scope(row, account, profileId, false); return { id: row.id, label: row.message || `${stories ? row.mediaType || 'Story' : 'Video'} · ${row.id}`, publishedAt: row.timestamp ?? row.createdTime ?? null };
  });
  if (new Set(items.map(row => row.id)).size !== items.length) bad();
  return items;
}

export async function handleZernioInsights(context, api, profileId, action) {
  const { req, url, send } = context;
  if (req.method !== 'GET') return false;
  if (action === 'accounts') {
    const accounts = (await scopedAccounts(api, profileId)).filter(row => Object.hasOwn(PLATFORM_RULES, row.platform)).map(row => ({ _id: row._id, platform: row.platform, displayName: row.displayName, username: row.username, isActive: row.isActive, reports: reports(row.platform) }));
    send(200, { accounts }); return true;
  }
  const match = /^([^/]+)\/(followers|best-time|follower-history|demographics|online-followers|videos|stories|retention|story|tiktok-account|linkedin-personal|linkedin-organization|whatsapp-pricing)$/.exec(action);
  if (!match) return false;
  let accountId; try { accountId = id(decodeURIComponent(match[1])); } catch (error) { if (error instanceof IntegrationError) throw error; fail(400, 'INVALID_REPORT_ACCOUNT', 'Choose a valid connected account.'); }
  const connected = await scopedAccounts(api, profileId), account = requireAccount(connected, accountId), kind = match[2];
  if (!Object.hasOwn(PLATFORM_RULES, account.platform) || !(reports(account.platform).includes(kind) || kind === 'videos' && account.platform === 'youtube' || kind === 'stories' && account.platform === 'instagram')) fail(422, 'REPORT_UNAVAILABLE', 'This report is not available for the selected platform.');
  const read = async (...args) => { try { return await api(...args); } catch (error) { if (error instanceof IntegrationError && error.providerStatus === 402) fail(402, 'ANALYTICS_ADDON_REQUIRED', 'This report requires the Zernio Analytics add-on.'); if (error instanceof IntegrationError && error.providerStatus === 412) fail(412, 'ANALYTICS_PERMISSION_REQUIRED', 'Reconnect the account with the platform’s analytics permission, then load this report again.'); throw error; } };
  if (kind === 'videos' || kind === 'stories') { send(200, { items: await choices(read, account, kind === 'stories', profileId), limit: kind === 'videos' ? 25 : null }); return true; }
  const base = { kind, accountId, platform: account.platform, loadedAt: new Date().toISOString() }; let report;
  if (kind === 'whatsapp-pricing') {
    if ([...url.searchParams.keys()].some(key => !['fromDate', 'toDate'].includes(key) || url.searchParams.getAll(key).length !== 1)) fail(400, 'INVALID_REPORT_OPTIONS', 'Choose only the daily pricing report dates.');
    const range = dates(url, 366, true);
    if (connected.filter(row => row._id === accountId).length !== 1 || account.isActive !== true || account.needsReconnection === true) fail(409, 'REPORT_ACCOUNT_UNAVAILABLE', 'Reconnect the active WhatsApp account before loading its pricing report.');
    context.assertProjectMapping?.(profileId); context.assertIntegrationSettings?.();
    const dimensions = ['COUNTRY', 'PHONE', 'PRICING_CATEGORY', 'PRICING_TYPE', 'TIER'], response = await read('/whatsapp/pricing-analytics', { accountId, start: range.fromDate, end: range.toDate, granularity: 'DAILY', dimensions: dimensions.join(','), metricTypes: 'COST,VOLUME' });
    scope(response, account, profileId, false);
    if (response.accountId !== accountId || !text(response.phoneNumber, 100) || !/^\d+$/.test(response.phoneNumber) || response.granularity !== 'DAILY' || !validPostInstant(response.start) || !validPostInstant(response.end) || Date.parse(response.start) !== Date.parse(range.fromDate) || Date.parse(response.end) !== Date.parse(range.toDate)) bad();
    // ponytail: render at most 1,000 provider buckets; add scoped breakdown filters before supporting larger reports.
    if (Array.isArray(response.dataPoints) && response.dataPoints.length > 1000) fail(503, 'REPORT_TOO_LARGE', 'This daily report has more than 1,000 pricing buckets. Choose a shorter date range.');
    const points = rows(response.dataPoints).map(row => {
      scope(row, account, profileId, false);
      if (['start', 'end', 'phoneNumber', 'country', 'tier', 'pricingType', 'pricingCategory', 'volume', 'cost'].some(key => !Object.hasOwn(row, key)) || !validPostInstant(row.start) || !validPostInstant(row.end) || Date.parse(row.start) < Date.parse(response.start) || Date.parse(row.end) > Date.parse(response.end) || Date.parse(row.start) >= Date.parse(row.end) || row.phoneNumber !== null && row.phoneNumber !== response.phoneNumber || ['country', 'tier', 'pricingType', 'pricingCategory'].some(key => row[key] !== null && (!text(row[key], 500) || /[\u0000-\u001f\u007f]/.test(row[key]))) || row.volume !== null && (!Number.isSafeInteger(row.volume) || row.volume < 0) || row.cost !== null && !count(row.cost)) bad();
      return { start: row.start, end: row.end, phoneNumber: row.phoneNumber, country: row.country, tier: row.tier, pricingType: row.pricingType, pricingCategory: row.pricingCategory, volume: row.volume, cost: row.cost };
    });
    if (new Set(points.map(row => JSON.stringify([Date.parse(row.start), Date.parse(row.end), row.phoneNumber, row.country, row.tier, row.pricingType, row.pricingCategory]))).size !== points.length) bad();
    const freshAccounts = await scopedAccounts(api, profileId), fresh = requireAccount(freshAccounts, accountId);
    if (freshAccounts.filter(row => row._id === accountId).length !== 1 || fresh.isActive !== true || fresh.needsReconnection === true || ['_id', 'platform', 'platformUserId', 'platformId', 'username', 'isActive', 'needsReconnection'].some(key => (fresh[key] ?? null) !== (account[key] ?? null))) fail(409, 'REPORT_ACCOUNT_CHANGED', 'The WhatsApp connection changed while this report loaded. Refresh and load it again.');
    context.assertProjectMapping?.(profileId); context.assertIntegrationSettings?.();
    report = { ...base, loadedAt: new Date().toISOString(), range, granularity: 'DAILY', dimensions, phoneNumber: response.phoneNumber, points, note: 'Meta reports delivered-message volume and approximate costs, which can be delayed. Costs use the WABA payment-method currency; its currency code is not reported. These figures are not an invoice or campaign attribution. Each row retains its provider interval and breakdown; rows are not summed. The end date is excluded. Meta may refuse date ranges outside its available history.' };
  } else if (kind === 'tiktok-account' || kind === 'linkedin-organization') {
    const range = dates(url, 89), metricType = url.searchParams.get('metricType') || 'total_value', tiktok = kind === 'tiktok-account';
    if (!['total_value', 'time_series'].includes(metricType)) fail(400, 'INVALID_REPORT_OPTIONS', 'Choose totals or daily history.');
    if (!tiktok) {
      const earliest = new Date(); earliest.setUTCFullYear(earliest.getUTCFullYear() - 1);
      if (range.fromDate < earliest.toISOString().slice(0, 10)) fail(400, 'INVALID_REPORT_DATES', 'LinkedIn organization share and follower data are limited to the past 12 months.');
      if (range.toDate > new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10)) fail(400, 'INVALID_REPORT_DATES', 'LinkedIn organization follower data must end at least two days ago.');
    }
    const names = tiktok ? ['follower_count', 'following_count', 'likes_count', 'video_count', 'followers_gained', 'followers_lost'] : ['impressions', 'unique_impressions', 'clicks', 'likes', 'comments', 'shares', 'engagement_rate', 'organic_followers_gained', 'paid_followers_gained', 'followers_gained', 'followers_lost', ...(metricType === 'total_value' ? ['page_views_total', 'page_views_overview', 'page_views_careers', 'page_views_jobs', 'page_views_life'] : [])];
    const response = await read(`/analytics/${tiktok ? 'tiktok/account-insights' : 'linkedin/org-aggregate-analytics'}`, { accountId, ...range, metrics: names.join(','), metricType }); scope(response, account, profileId);
    if (response.platform !== account.platform || response.metricType !== metricType || response.dateRange?.since !== range.fromDate || response.dateRange?.until !== range.toDate || !object(response.metrics) || Object.keys(response.metrics).some(key => !names.includes(key)) || response.dataDelay != null && !text(response.dataDelay)) bad();
    const unavailable = rows(response.unavailableMetrics ?? [], names.length).map(row => { if (!object(row) || !names.includes(row.metric) || !text(row.reason, 200) || !row.reason || row.message != null && !text(row.message)) bad(); return { metric: row.metric, reason: row.reason, message: row.message || null }; });
    if (new Set(unavailable.map(row => row.metric)).size !== unavailable.length || unavailable.some(row => Object.hasOwn(response.metrics, row.metric))) bad();
    const metrics = Object.fromEntries(names.map(key => { const row = response.metrics[key]; if (Object.hasOwn(response.metrics, key) && !object(row)) bad(); const total = amount(row?.total), points = datedRows(row?.values === undefined ? [] : row.values, range, 'value'); if (key === 'engagement_rate' && (total != null && total > 1 || points.some(point => point.value != null && point.value > 1))) bad(); return [key, { total, points }]; }));
    report = { ...base, range, metricType, metrics, unavailable, dataDelay: response.dataDelay || null, note: tiktok ? 'Counter totals are current cumulative values, not activity within the selected period. Daily history comes from Zernio snapshots; gains and losses cover the selected period and are positive/negative snapshot changes, not follower inflow/outflow. Account impressions, reach, watch time and demographics are unavailable.' : 'Share and follower metrics cover the selected period. Snapshot gains/losses differ from organic/paid follower gains. Engagement rate is LinkedIn’s ratio, shown as a percentage. Page views support totals only; saves and sends are unavailable for organizations. Share and follower data are limited to the past 12 months; follower data can lag by two days.' };
  } else if (kind === 'linkedin-personal') {
    const aggregation = url.searchParams.get('aggregation') || 'TOTAL', dated = url.searchParams.has('fromDate') || url.searchParams.has('toDate');
    if (!['TOTAL', 'DAILY'].includes(aggregation) || url.searchParams.has('metricType') || aggregation === 'DAILY' && !dated) fail(400, 'INVALID_REPORT_OPTIONS', 'Choose lifetime totals, period totals or daily history with a date range.');
    const range = dated ? dates(url, 366, true) : null, names = ['impressions', ...(aggregation === 'TOTAL' ? ['reach'] : []), 'reactions', 'comments', 'shares', 'saves', 'sends'];
    const response = await read(`/accounts/${encodeURIComponent(accountId)}/linkedin-aggregate-analytics`, { aggregation, ...(range || {}), metrics: ['IMPRESSION', ...(aggregation === 'TOTAL' ? ['MEMBERS_REACHED'] : []), 'REACTION', 'COMMENT', 'RESHARE', 'POST_SAVE', 'POST_SEND'].join(',') }); scope(response, account, profileId, false);
    if (response.accountId !== accountId || response.platform !== 'linkedin' || response.accountType !== 'personal' || response.aggregation !== aggregation || (range ? response.dateRange?.startDate !== range.fromDate || response.dateRange?.endDate !== range.toDate : response.dateRange !== null) || !object(response.analytics) || Object.keys(response.analytics).some(key => !names.includes(key) && !(aggregation === 'TOTAL' && key === 'engagementRate')) || response.lastUpdated != null && !instant(response.lastUpdated)) bad();
    if (response.analytics.engagementRate !== undefined) amount(response.analytics.engagementRate);
    if (response.skippedMetrics !== undefined && rows(response.skippedMetrics, 7).some(value => !text(value, 200))) bad();
    report = { ...base, aggregation, ...(range ? { range } : {}), ...(aggregation === 'TOTAL' ? { metrics: Object.fromEntries(names.map(key => [key, amount(response.analytics[key])])) } : { series: Object.fromEntries(names.map(key => [key, datedRows(response.analytics[key] === undefined ? [] : response.analytics[key], range, 'count', true)])) }), lastUpdated: response.lastUpdated || null, note: note(response) || `${range ? 'Selected-period analytics; the end date is excluded.' : 'Lifetime totals'} Across every post authored by this member, including posts published outside Zernio. ${aggregation === 'DAILY' ? 'Members reached is unavailable in daily history. ' : ''}Requires r_member_postAnalytics permission. Use this report only for a personal account; it does not switch the connected account type.` };
  } else if (kind === 'followers') {
    const range = dates(url), response = await read('/accounts/follower-stats', { profileId, accountIds: accountId, ...range, granularity: 'daily' }); scope(response, account, profileId, false);
    if (!Array.isArray(response.accounts) || response.accounts.length > 1 || response.accounts.some(row => !object(row) || row._id !== accountId || row.platform !== account.platform) || !object(response.stats) || Object.keys(response.stats).some(key => key !== accountId) || response.granularity !== 'daily' || !instant(response.dateRange?.from) || !instant(response.dateRange?.to) || response.dateRange.from.slice(0, 10) !== range.fromDate || response.dateRange.to.slice(0, 10) !== range.toDate) bad();
    const summary = response.accounts[0]; report = { ...base, range, current: amount(summary?.currentFollowers), growth: amount(summary?.growth, true), growthPercentage: amount(summary?.growthPercentage, true), points: datedRows(Object.hasOwn(response.stats, accountId) ? response.stats[accountId] : [], range), note: 'Daily snapshots are refreshed once per day. Missing days have no snapshot; they are not zero followers.' };
  } else if (kind === 'best-time') {
    const source = url.searchParams.get('source') || 'all'; if (!['all', 'late', 'external'].includes(source)) fail(400, 'INVALID_REPORT_SOURCE', 'Choose all posts, app posts or external posts.');
    const response = await read('/analytics/best-time', { profileId, accountId, platform: account.platform, source }); scope(response, account, profileId, false);
    const slots = rows(response.slots, 168).map(row => { if (!object(row) || !Number.isInteger(row.day_of_week) || row.day_of_week < 0 || row.day_of_week > 6 || !Number.isInteger(row.hour) || row.hour < 0 || row.hour > 23 || !count(row.avg_engagement) || !Number.isInteger(row.post_count) || row.post_count < 0) bad(); return { day: row.day_of_week, hour: row.hour, engagement: row.avg_engagement, posts: row.post_count }; });
    if (new Set(slots.map(row => `${row.day}:${row.hour}`)).size !== slots.length) bad(); report = { ...base, source, slots, note: 'Hours are UTC. Historical average engagement is an association, not a guarantee of future performance. This report uses all available history, not the date filter.' };
  } else if (kind === 'follower-history') {
    const range = dates(url, 89), response = await read('/analytics/instagram/follower-history', { accountId, ...range, metrics: 'follower_count,followers_gained,followers_lost', metricType: 'time_series' }); scope(response, account, profileId);
    if (!object(response.metrics) || response.metricType !== 'time_series' || response.dateRange?.since !== range.fromDate || response.dateRange?.until !== range.toDate || Object.keys(response.metrics).some(key => !['follower_count', 'followers_gained', 'followers_lost'].includes(key))) bad();
    const metrics = Object.fromEntries(Object.entries(response.metrics).map(([key, row]) => { if (!object(row)) bad(); return [key, { total: amount(row.total), points: datedRows(row.values === undefined ? [] : row.values, range, 'value') }]; }));
    report = { ...base, range, metrics, note: 'Instagram follower history uses Zernio snapshots. Missing days and omitted metrics are not zero.' };
  } else if (kind === 'demographics') {
    const instagram = account.platform === 'instagram', metric = instagram ? url.searchParams.get('metric') || 'follower_demographics' : 'follower_demographics', timeframe = url.searchParams.get('timeframe') || 'this_month', dimensions = instagram ? ['age', 'gender', 'city', 'country'] : ['country', 'city'];
    if (!['follower_demographics', 'engaged_audience_demographics'].includes(metric) || !['this_week', 'this_month'].includes(timeframe)) fail(400, 'INVALID_REPORT_OPTIONS', 'Choose a supported audience and reporting period.');
    const response = await read(`/analytics/${account.platform}/demographics`, { accountId, breakdown: dimensions.join(','), ...(instagram ? { metric, timeframe } : {}) }); scope(response, account, profileId);
    if (!object(response.demographics) || response.metric !== metric || Object.keys(response.demographics).some(key => !dimensions.includes(key)) || response.snapshotDate != null && !day(response.snapshotDate) || response.timeframe != null && !text(response.timeframe, 100)) bad();
    const breakdowns = Object.fromEntries(Object.entries(response.demographics).map(([key, value]) => [key, rows(value, 1000).map(row => { if (!object(row) || !text(row.dimension, 500) || !row.dimension || !count(row.value)) bad(); return { dimension: row.dimension, value: row.value }; })]));
    report = { ...base, metric, requestedTimeframe: instagram ? timeframe : null, providerTimeframe: response.timeframe || null, snapshotDate: response.snapshotDate || null, breakdowns, note: note(response) || (instagram ? 'Requires at least 100 followers; top entries only. Reporting can be delayed by 48 hours.' : 'Facebook reports country and city only, from its latest snapshot. Small audiences can be affected by privacy thresholds.') };
  } else if (kind === 'online-followers') {
    const response = await read('/analytics/instagram/online-followers', { accountId }); scope(response, account, profileId);
    const days = rows(response.days, 31).map(row => { if (!object(row) || !instant(row.endTime) || !object(row.hours) || Object.keys(row.hours).some(hour => !/^(\d|1\d|2[0-3])$/.test(hour) || !count(row.hours[hour]))) bad(); return { endTime: row.endTime, hours: row.hours }; });
    if (new Set(days.map(row => row.endTime)).size !== days.length) bad(); report = { ...base, days, note: 'Meta’s hour-key timezone is undocumented. The last 30 days may omit recent days due to a delay of up to 48 hours. Accounts below 100 followers can return no data.' };
  } else if (kind === 'retention') {
    const range = dates(url), videoId = id(url.searchParams.get('videoId'));
    if (!(await choices(read, account, false, profileId)).some(row => row.id === videoId)) fail(403, 'POST_OUTSIDE_ACCOUNT', 'Choose one of this account’s latest 25 videos, then reload the video list if needed.');
    const response = await read('/analytics/youtube/video-retention', { accountId, videoId, ...range }); scope(response, account, profileId);
    if (response.videoId !== videoId || response.title != null && !text(response.title) || response.dateRange?.startDate !== range.fromDate || response.dateRange?.endDate !== range.toDate || response.durationSeconds != null && !count(response.durationSeconds) || response.provisionalSince != null && (!day(response.provisionalSince) || response.provisionalSince < range.fromDate || response.provisionalSince > range.toDate) || !object(response.scopeStatus) || typeof response.scopeStatus.hasAnalyticsScope !== 'boolean') bad();
    const points = rows(response.retentionCurve, 100).map(row => { if (!object(row) || !numeric(row.elapsedVideoTimeRatio) || row.elapsedVideoTimeRatio <= 0 || row.elapsedVideoTimeRatio > 1 || !count(row.audienceWatchRatio) || !numeric(row.relativeRetentionPerformance) || row.relativeRetentionPerformance < 0 || row.relativeRetentionPerformance > 1) bad(); return { position: row.elapsedVideoTimeRatio, watch: row.audienceWatchRatio, relative: row.relativeRetentionPerformance, started: amount(row.startedWatching), stopped: amount(row.stoppedWatching), impressions: amount(row.totalSegmentImpressions) }; });
    if (new Set(points.map(row => row.position)).size !== points.length) bad();
    report = { ...base, range, videoId, title: response.title || null, duration: response.durationSeconds ?? null, provisionalSince: response.provisionalSince || null, hasAnalyticsScope: response.scopeStatus.hasAnalyticsScope, points: points.sort((a, b) => a.position - b.position), note: note(response) || 'Retention can exceed 100% because viewers rewatch or loop. Empty curves can mean insufficient views or a 2–3 day processing delay.' };
  } else if (kind === 'story') {
    const storyId = id(url.searchParams.get('storyId')); if (!(await choices(read, account, true, profileId)).some(row => row.id === storyId)) fail(403, 'POST_OUTSIDE_ACCOUNT', 'Choose an active Story from this Instagram account. Expired Stories are not listed here.');
    const response = await read(`/accounts/${encodeURIComponent(accountId)}/instagram/stories/${encodeURIComponent(storyId)}/insights`); scope(response, account, profileId, false);
    if (!object(response.data) || !['live', 'cached', 'unavailable'].includes(response.data.source) || !object(response.data.metrics)) bad();
    const names = ['views', 'reach', 'replies', 'shares', 'navigation', 'tapsForward', 'tapsBack', 'exits', 'swipesForward', 'profileVisits', 'follows', 'reposts', 'totalInteractions'];
    const metrics = Object.fromEntries(names.map(key => [key, response.data.source === 'unavailable' ? null : amount(response.data.metrics[key])]));
    report = { ...base, storyId, source: response.data.source, metrics, note: 'Live metrics come from Meta; cached metrics are the last persisted webhook receipt. Unavailable means the Story expired without a captured receipt. Counts below five can be privacy-rounded to zero.' };
  }
  send(200, { report }); return true;
}
