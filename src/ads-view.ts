// Display helpers for the Ads manager campaign list and ad detail. Pure: no React, no requests.
type Row = Record<string, any>;
const present = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

// Ported from zernio-dev/ads-dashboard@4386edd lib/date-range.ts (MIT); 'default' keeps the provider's own window.
export const adsRangeOptions = [{ value: 'default', label: 'Provider default' }, { value: '7', label: 'Last 7 days' }, { value: '30', label: 'Last 30 days' }, { value: '90', label: 'Last 90 days' }];
export function adsPath(range: string, now = new Date()) {
  const days = ({ '7': 7, '30': 30, '90': 90 } as Record<string, number>)[range];
  if (!days) return 'ads';
  const day = (back: number) => { const date = new Date(now); date.setUTCDate(date.getUTCDate() - back); return date.toISOString().slice(0, 10); };
  return `ads?${new URLSearchParams({ fromDate: day(days - 1), toDate: day(0) })}`;
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

// Ported from zernio-dev/ads-dashboard@4386edd lib/format.ts (MIT).
const amount = (value: number, currency?: string) => { const digits = Math.abs(value) >= 100 ? 0 : 2; try { return new Intl.NumberFormat('en-US', currency ? { style: 'currency', currency, minimumFractionDigits: digits, maximumFractionDigits: digits } : { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value); } catch { return new Intl.NumberFormat('en-US', { maximumFractionDigits: digits }).format(value) + ' ' + currency; } };
const compactCount = (value: number) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value);

// Ported from zernio-dev/ads-dashboard@4386edd components/dashboard/ad-detail-sheet.tsx AdMetricsGrid (MIT); only reported metrics.
export function adMetricCells(metrics: Row | undefined, currency: string | undefined, hidden = false) {
  const m = metrics || {}, money = (value: number) => hidden ? hiddenAmount : amount(value, currency);
  const cells: [string, unknown, (value: number) => string][] = [['Spend', m.spend, money], ['Impressions', m.impressions, compactCount], ['Clicks', m.clicks, compactCount], ['CTR', m.ctr, value => `${value.toFixed(2)}%`], ['CPC', m.cpc, money], ['CPM', m.cpm, money], ['Conversions', m.conversions, compactCount], ['ROAS', m.roas, value => `${value.toFixed(2)}×`]];
  if (present(m.videoPlayActions)) cells.push(['Video plays', m.videoPlayActions, compactCount], ['25% watched', m.videoP25WatchedActions, compactCount], ['50% watched', m.videoP50WatchedActions, compactCount], ['100% watched', m.videoP100WatchedActions, compactCount]);
  return cells.filter(([, value]) => present(value)).map(([label, value, format]) => ({ label, value: format(value as number) }));
}

// Ported from zernio-dev/ads-dashboard@4386edd components/dashboard/ad-detail-sheet.tsx CreativePane (MIT); only https URLs without credentials.
const httpsUrl = (value: unknown) => { try { const url = new URL(String(value || '')); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; } };
export function adCreativeView(creative: Row | undefined) {
  const c = creative || {}, text = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : '';
  const view = { image: httpsUrl(c.imageUrl) || httpsUrl(c.thumbnailUrl) || httpsUrl(c.pinterestImageUrl), headline: text(c.headline) || text(c.googleHeadline) || text(c.pinterestTitle), body: text(c.body) || text(c.googleDescription), link: httpsUrl(c.linkUrl) };
  return view.image || view.headline || view.body || view.link ? view : null;
}
