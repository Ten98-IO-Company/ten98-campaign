// Display helpers for the Ads manager campaign list and ad detail. Pure: no React, no requests.
import { createDisplayFormatter, type DisplayFormatter } from '@ten98/ui';
type Row = Record<string, any>;
// Not a component, so by default it formats with the browser's locale and time zone, as the app's DisplayFormatProvider
// does; a caller (a test) may pass its own formatter.
const browserFormat = createDisplayFormatter();
const present = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// Ported from zernio-dev/ads-dashboard@4386edd lib/date-range.ts (MIT); 'default' keeps the provider's own window.
export const adsRangeOptions = [{ value: 'default', label: 'Provider default' }, { value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }];
export function adsRangeQuery(range: string, now = new Date()): Record<string, string> {
  const days = ({ '7': 7, '30': 30, '90': 90 } as Record<string, number>)[range];
  if (!days) return {};
  const day = (back: number) => { const date = new Date(now); date.setUTCDate(date.getUTCDate() - back); return date.toISOString().slice(0, 10); };
  return { fromDate: day(days - 1), toDate: day(0) };
}
export function adsPath(range: string, now = new Date()) {
  const dates = adsRangeQuery(range, now);
  return dates.fromDate ? `ads?${new URLSearchParams(dates)}` : 'ads';
}

// Issue #126: tabs name objects or tasks, never providers. Direct connections are networks in the filter instead of tabs;
// their section ids stay valid so existing links and campaign rows still open them.
export const adsTabs = [['campaigns', 'Campaigns'], ['adsets', 'Ad sets'], ['ads', 'Ads'], ['leads', 'Leads'], ['measurement', 'Conversions'], ['events', 'Activity']];
export const adsLevelViews = ['campaigns', 'adsets', 'ads'];
export const adsDirectViews = [{ value: 'shopping', label: 'Google Shopping' }, { value: 'microsoft', label: 'Microsoft Advertising' }, { value: 'search', label: 'Google search tools' }];
export const adsManagerViews = [...adsLevelViews, ...adsDirectViews.map(view => view.value)];
export const anyNetwork = 'all', anyStatus = 'any';
export const campaignKey = (c: Row) => String(c.id || c._id || [c.platform, c.platformCampaignId || c.campaignId, c.campaignName || c.name].join(':'));
export function networkOptions(rows: Row[], network: (platform: string) => string): { value: string; label: string; group?: string }[] {
  const platforms = [...new Set(rows.map(row => String(row.platform || '')).filter(Boolean))];
  return [{ value: anyNetwork, label: 'All networks' }, ...platforms.map(value => ({ value, label: network(value) })), ...adsDirectViews.map(view => ({ ...view, group: 'Direct connections' }))];
}
export const statusOptions = [{ value: anyStatus, label: 'Any status' }, { value: 'active', label: 'Active' }, { value: 'paused', label: 'Paused' }, { value: 'review', label: 'In review' }, { value: 'ended', label: 'Ended' }];
const endedStatuses = ['rejected', 'completed', 'cancelled', 'archived', 'deleted'];
export function deliveryGroup(row: Row) {
  const status = String(row.status || '').toLowerCase();
  return endedStatuses.includes(status) ? 'ended' : row.reviewStatus === 'in_review' ? 'review' : status === 'active' || status === 'paused' ? status : 'other';
}
export const matchesFilters = (row: Row, { network, status }: { network: string; status: string }) => (network === anyNetwork || row.platform === network) && (status === anyStatus || deliveryGroup(row) === status);

// Ad sets arrive inside the loaded campaign tree; each row carries its campaign so details open on the parent.
export function adSetRows(campaigns: Row[]) {
  return campaigns.flatMap(campaign => (Array.isArray(campaign.adSets) ? campaign.adSets : []).filter((set: Row) => set && set.platformAdSetId).map((set: Row): Row => ({ ...set, key: campaignKey(campaign) + '/' + set.platformAdSetId, name: set.adSetName || set.name || set.platformAdSetId, platform: campaign.platform, currency: campaign.currency || campaign.metrics?.currency, campaign })));
}
// Same path as the details drawer, narrowed to the page period like the campaign list.
export function adItemsPath(campaign: Row, range: string, now = new Date()) {
  return `ads/items?campaignId=${encodeURIComponent(campaign.platformCampaignId || campaign.campaignId || campaign.id)}&platform=${encodeURIComponent(campaign.platform)}${range === 'default' ? '' : '&' + new URLSearchParams(adsRangeQuery(range, now))}`;
}
export function adRows(campaign: Row, result: any): Row[] {
  if (!result || !Array.isArray(result.ads) || result.ads.some((ad: Row) => !ad || typeof ad._id !== 'string' || !ad._id)) throw new Error(`Ads for ${campaign.name || campaign.campaignName || 'this campaign'} could not be read.`);
  return result.ads.map((ad: Row) => ({ ...ad, key: ad._id, name: ad.name || 'Untitled ad', platform: campaign.platform, currency: result.campaign?.currency || campaign.currency || campaign.metrics?.currency, campaign }));
}
// A totals row shaped like a campaign, so each column formats it as it formats its cells. Money is never added across currencies.
export function levelTotals(rows: Row[]) {
  const sum = (key: string) => { const values = rows.map(row => campaignFigure(row, key)).filter(present); return values.length ? values.reduce((total, value) => total + value, 0) : undefined; };
  const currencies = new Set(rows.filter(row => campaignFigure(row, 'spend') !== undefined).map(row => row.currency || row.metrics?.currency || 'USD'));
  const impressions = sum('impressions'), clicks = sum('clicks'), mixedCurrency = currencies.size > 1;
  return { id: 'totals', currency: [...currencies][0], adCount: sum('adCount'), mixedCurrency, metrics: { spend: mixedCurrency ? undefined : sum('spend'), impressions, clicks, ctr: impressions && clicks !== undefined ? clicks / impressions * 100 : undefined, conversions: sum('conversions') } };
}

// Ported from zernio-dev/ads-dashboard@4386edd components/dashboard/account-picker.tsx (MIT), applied to already-loaded rows.
export const allAdAccounts = 'all';
const accountKey = (row: Row) => String(row.accountId || row.platformAdAccountId || '');
export function adAccountOptions(rows: Row[], network: (platform: string) => string) {
  const seen = new Map<string, string>();
  for (const row of rows) { const key = accountKey(row); if (key && !seen.has(key)) seen.set(key, [network(row.platform || ''), row.platformAdAccountName || key].filter(Boolean).join(' · ')); }
  return [{ value: allAdAccounts, label: 'All accounts' }, ...[...seen].map(([value, label]) => ({ value, label }))];
}
export function filterAdAccount<T extends Row>(rows: T[], account: string): T[] {
  return account === allAdAccounts || !rows.some(row => accountKey(row) === account) ? rows : rows.filter(row => accountKey(row) === account);
}

// Ported from zernio-dev/ads-dashboard@4386edd components/dashboard/hide-amounts.tsx (MIT); masks instead of blurring.
export const hideAmountsKey = 'ten98-campaign-hide-amounts', hiddenAmount = '••••';
export function readHideAmounts() { try { return globalThis.localStorage?.getItem(hideAmountsKey) === '1'; } catch { return false; } }
export function saveHideAmounts(hidden: boolean) { try { globalThis.localStorage?.setItem(hideAmountsKey, hidden ? '1' : '0'); } catch { /* Blocked storage keeps the choice for this page only. */ } }

// Ported from zernio-dev/ads-dashboard@4386edd components/dashboard/campaigns-table.tsx (MIT); absent figures stay absent.
export function campaignFigure(row: Row, key: string): number | undefined {
  const value = key === 'adCount' ? row.adCount : key === 'spend' ? row.metrics?.spend ?? row.spend : row.metrics?.[key];
  return present(value) ? value : undefined;
}
export const campaignSortValue = (row: Row, key: string) => campaignFigure(row, key) ?? Number.NEGATIVE_INFINITY;

// Rounding rule ported from zernio-dev/ads-dashboard@4386edd lib/format.ts (MIT): whole units from 100, cents below.
const amount = (format: DisplayFormatter, value: number, currency?: string) => currency ? format.currency(value, currency, { wholeUnits: Math.abs(value) >= 100 }) : format.number(value, { maximumFractionDigits: Math.abs(value) >= 100 ? 0 : 2 });

// Ported from zernio-dev/ads-dashboard@4386edd components/dashboard/ad-detail-sheet.tsx AdMetricsGrid (MIT); only reported metrics.
export function adMetricCells(metrics: Row | undefined, currency: string | undefined, hidden = false, format = browserFormat) {
  const m = metrics || {}, money = (value: number) => hidden ? hiddenAmount : amount(format, value, currency), compactCount = (value: number) => format.compact(value);
  const cells: [string, unknown, (value: number) => string][] = [['Spend', m.spend, money], ['Impressions', m.impressions, compactCount], ['Clicks', m.clicks, compactCount], ['CTR', m.ctr, value => `${format.number(value, { maximumFractionDigits: 2 })}%`], ['CPC', m.cpc, money], ['CPM', m.cpm, money], ['Conversions', m.conversions, compactCount], ['ROAS', m.roas, value => `${format.number(value, { maximumFractionDigits: 2 })}×`]];
  if (present(m.videoPlayActions)) cells.push(['Video plays', m.videoPlayActions, compactCount], ['25% watched', m.videoP25WatchedActions, compactCount], ['50% watched', m.videoP50WatchedActions, compactCount], ['100% watched', m.videoP100WatchedActions, compactCount]);
  return cells.filter(([, value]) => present(value)).map(([label, value, show]) => ({ label, value: show(value as number) }));
}

// Ported from zernio-dev/ads-dashboard@4386edd components/dashboard/ad-detail-sheet.tsx CreativePane (MIT); only https URLs without credentials.
const httpsUrl = (value: unknown) => { try { const url = new URL(String(value || '')); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; } };
export function adCreativeView(creative: Row | undefined) {
  const c = creative || {}, text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : '';
  const view = { image: httpsUrl(c.imageUrl) || httpsUrl(c.thumbnailUrl) || httpsUrl(c.pinterestImageUrl), headline: text(c.headline) || text(c.googleHeadline) || text(c.pinterestTitle), body: text(c.body) || text(c.googleDescription), link: httpsUrl(c.linkUrl) };
  return view.image || view.headline || view.body || view.link ? view : null;
}
