import { IntegrationError, scopedAccounts, requireAccount, adAccounts } from './provider-core.ts';
import { validPostInstant } from '../shared/social-posts.ts';

export const paidAdEvents = new Set(['account.ads.initial_sync_completed', 'account.ads.sync_failed', 'account.ads.sync_recovered', 'lead.received', 'ad.status_changed', 'ad.video.processed']);
const platforms = new Set(['metaads', 'googleads', 'tiktokads', 'linkedinads', 'pinterestads', 'xads', 'redditads', 'openaiads', 'facebook', 'instagram']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value);
const numeric = value => typeof value === 'string' && /^\d{1,40}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const code = value => typeof value === 'string' && /^(?:\d{1,40}|[A-Z][A-Z0-9_]{0,79})$/.test(value);
const invalid = () => { throw new IntegrationError(400, 'INVALID_AD_EVENT', 'The advertising notification is incomplete or has invalid scope.'); };
const nativeId = (platform, value) => typeof value === 'string' && (['metaads', 'facebook', 'instagram'].includes(platform) ? /^act_\d{1,40}$/.test(value) : ['googleads', 'tiktokads', 'linkedinads', 'pinterestads'].includes(platform) ? numeric(value) : token(value));
const initialCategories = new Set(['token_invalid', 'permission_denied', 'no_ad_accounts', 'rate_limited', 'discovery_failed', 'unknown']);
const syncCategories = new Set(['ad_account_not_listed', 'sync_error', 'stale']);

// Keep stable identifiers and categorical evidence, never names, answers, diagnostics or media URLs.
export function minimizeAdEvent(payload, stored = false) {
  const account = payload.account, accountId = account?.accountId || account?.id;
  if (!paidAdEvents.has(payload.event) || !token(accountId) || !platforms.has(account?.platform) || account.accountId && account.id && account.accountId !== account.id || !(token(account.profileId) || payload.event === 'lead.received' && account.profileId === null)) invalid();
  if (payload.profiles !== undefined && (!Array.isArray(payload.profiles) || payload.profiles.length > 1 || payload.profiles.some(row => !token(row?.id) || row.id !== account.profileId))) invalid();
  if (!validPostInstant(payload.timestamp)) invalid();
  const result = { id: payload.id, event: payload.event, timestamp: new Date(payload.timestamp).toISOString(), account: { accountId, platform: account.platform, profileId: account.profileId } };
  if (payload.event === 'account.ads.initial_sync_completed') {
    const sync = payload.sync;
    if (!object(sync) || !['success', 'failure'].includes(sync.status) || !['totalAds', 'synced', 'failed'].every(key => integer(sync[key])) || sync.synced + sync.failed > sync.totalAds) invalid();
    result.sync = { status: sync.status, totalAds: sync.totalAds, synced: sync.synced, failed: sync.failed };
    if (sync.errorCategory !== undefined) result.sync.errorCategory = initialCategories.has(sync.errorCategory) ? sync.errorCategory : 'unknown';
    for (const key of ['errorCode', 'errorSubcode']) if (sync[key] !== undefined) { if (!code(sync[key])) invalid(); result.sync[key] = sync[key]; }
  } else if (payload.event.startsWith('account.ads.sync_')) {
    const sync = payload.sync, adAccountId = payload.adAccount?.platformAdAccountId;
    if (!nativeId(account.platform, adAccountId) || !object(sync) || !validPostInstant(sync.lastSuccessfulSyncAt)) invalid();
    result.adAccount = { platformAdAccountId: adAccountId }; result.sync = { lastSuccessfulSyncAt: new Date(sync.lastSuccessfulSyncAt).toISOString() };
    if (payload.event.endsWith('failed')) {
      if (!integer(sync.failureCount) || typeof sync.errorCategory !== 'string') invalid();
      Object.assign(result.sync, { failureCount: sync.failureCount, errorCategory: syncCategories.has(sync.errorCategory) ? sync.errorCategory : 'unknown' });
    } else { if (!validPostInstant(sync.failingSince)) invalid(); result.sync.failingSince = new Date(sync.failingSince).toISOString(); }
  } else if (payload.event === 'lead.received') {
    const lead = payload.lead;
    if (account.platform !== 'facebook' || !object(lead) || !token(lead.id) || !numeric(lead.leadgenId) || !numeric(lead.formId) || typeof lead.isOrganic !== 'boolean' || !validPostInstant(lead.createdAt)) invalid();
    if (stored ? !integer(lead.answerCount) : !object(lead.fields) || Object.keys(lead.fields).length > 1000 || Object.values(lead.fields).some(value => typeof value !== 'string')) invalid();
    result.lead = { id: lead.id, leadgenId: lead.leadgenId, formId: lead.formId, isOrganic: lead.isOrganic, createdAt: new Date(lead.createdAt).toISOString(), answerCount: stored ? lead.answerCount : Object.keys(lead.fields).length };
    for (const key of ['adId', 'adsetId', 'campaignId']) if (lead[key] != null) { if (!numeric(lead[key])) invalid(); result.lead[key] = lead[key]; }
  } else if (payload.event === 'ad.status_changed') {
    const item = payload.adObject;
    if (account.platform !== 'metaads' || !object(item) || !['CAMPAIGN', 'AD_SET', 'AD'].includes(item.level) || !numeric(item.platformId) || !nativeId(account.platform, item.platformAdAccountId) || typeof payload.status?.raw !== 'string' || !/^[A-Z][A-Z0-9_]{0,99}$/.test(payload.status.raw)) invalid();
    result.adObject = { level: item.level, platformId: item.platformId, platformAdAccountId: item.platformAdAccountId }; result.status = { raw: payload.status.raw };
    if (payload.error != null) { if (!object(payload.error) || !code(payload.error.code)) invalid(); result.error = { code: payload.error.code }; }
  } else {
    const video = payload.video;
    if (account.platform !== 'metaads' || !object(video) || !numeric(video.id) || !nativeId(account.platform, video.platformAdAccountId) || !['ready', 'error'].includes(video.status)) invalid();
    result.video = { id: video.id, platformAdAccountId: video.platformAdAccountId, status: video.status };
  }
  return result;
}

export function initializeAdEvents(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS webhook_ad_updates(sequence INTEGER PRIMARY KEY AUTOINCREMENT,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,profile_id TEXT NOT NULL,account_id TEXT NOT NULL,platform TEXT NOT NULL,ad_account_id TEXT NOT NULL,event_id TEXT UNIQUE NOT NULL,event_at TEXT NOT NULL,event TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS webhook_ad_scope ON webhook_ad_updates(project_id,profile_id,account_id,ad_account_id,sequence);`);
}
export function recordAdEvent(db, payload, projectId) {
  const adAccountId = payload.adAccount?.platformAdAccountId || payload.adObject?.platformAdAccountId || payload.video?.platformAdAccountId || '';
  db.prepare('INSERT INTO webhook_ad_updates(project_id,profile_id,account_id,platform,ad_account_id,event_id,event_at,event,data) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(event_id) DO NOTHING').run(projectId, payload.account.profileId, payload.account.accountId, payload.account.platform, adAccountId, payload.id, payload.timestamp, payload.event, JSON.stringify(payload));
}
const fail = (status, code, message) => { throw new IntegrationError(status, code, message); };
function nativeRows(response, platform) {
  const rows = response.accounts;
  if (!Array.isArray(rows) || rows.length > 10000 || response.hasMore === true || response.pagination?.hasMore === true || rows.some(row => !object(row) || !nativeId(platform, row.id) || row.name != null && (typeof row.name !== 'string' || row.name.length > 1000) || row.selectable != null && typeof row.selectable !== 'boolean') || new Set(rows.map(row => row.id)).size !== rows.length) fail(502, 'INVALID_AD_EVENT_ACCOUNTS', 'Zernio did not return a complete advertising account list.');
  return rows.map(row => ({ id: row.id, name: row.name || row.id, selectable: row.selectable ?? null }));
}
function latest(db, where, values, events) {
  const filter = `${where} AND event IN (${events.map(() => '?').join(',')})`, eventAt = db.prepare(`SELECT max(event_at) AS eventAt FROM webhook_ad_updates WHERE ${filter}`).get(...values, ...events).eventAt;
  if (!eventAt) return null;
  const rows = db.prepare(`SELECT DISTINCT event,json_extract(data,'$.sync') AS sync FROM webhook_ad_updates WHERE ${filter} AND event_at=? LIMIT 2`).all(...values, ...events, eventAt);
  return rows.length > 1 ? { event: 'conflicting', eventAt } : { event: rows[0].event, eventAt, ...JSON.parse(rows[0].sync) };
}
export async function handleZernioAdEvents(context, api, profileId, action = '') {
  const { req, url, db, project, send } = context;
  if (!['', 'accounts', 'ad-accounts'].includes(action)) return false;
  if (req.method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', 'Advertising updates are read only.');
  if ([...url.searchParams.keys()].some(key => !['accountId', 'adAccountId', 'before', 'limit'].includes(key))) fail(400, 'INVALID_AD_EVENT_FILTER', 'Use the connection, advertising account and history controls.');
  initializeAdEvents(db); context.assertProjectMapping?.(profileId);
  const accounts = (await scopedAccounts(api, profileId)).filter(account => platforms.has(account.platform));
  if (action === 'accounts') { context.assertProjectMapping?.(profileId); send(200, { accounts: accounts.map(row => ({ id: row._id, platform: row.platform, name: row.displayName || row.username || row._id, isActive: row.isActive !== false, hasAdvertisers: row.platform.endsWith('ads') })) }); return true; }
  const accountId = url.searchParams.get('accountId'), account = requireAccount(accounts, accountId);
  const advertisers = account.platform.endsWith('ads') ? nativeRows(await adAccounts(api, accountId), account.platform) : [];
  if (action === 'ad-accounts') { const fresh = requireAccount(await scopedAccounts(api, profileId), accountId); if (fresh.platform !== account.platform) fail(409, 'AD_EVENT_CONNECTION_CHANGED', 'The connection changed. Refresh provider updates.'); context.assertProjectMapping?.(profileId); send(200, { accounts: advertisers }); return true; }
  const adAccountId = url.searchParams.get('adAccountId') || '', before = url.searchParams.get('before'), limit = Number(url.searchParams.get('limit') || 25);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || before !== null && (!/^\d{1,16}$/.test(before) || !Number.isSafeInteger(Number(before)) || Number(before) < 1)) fail(400, 'INVALID_AD_EVENT_FILTER', 'Choose a valid history cursor and at most 100 updates.');
  if (adAccountId && !advertisers.some(row => row.id === adAccountId)) fail(403, 'AD_ACCOUNT_OUTSIDE_PROJECT', 'Choose an advertising account available through this project connection.');
  const where = 'project_id=? AND profile_id=? AND account_id=? AND platform=?', values = [project.id, profileId, accountId, account.platform], scope = adAccountId ? "(ad_account_id=? OR ad_account_id='')" : "ad_account_id=''", scopeValues = adAccountId ? [...values, adAccountId] : values;
  const rows = db.prepare(`SELECT e.rowid AS sequence,u.data FROM webhook_ad_updates u JOIN webhook_events e ON e.id=u.event_id WHERE ${where} AND ${scope}${before ? ' AND e.rowid<?' : ''} ORDER BY e.rowid DESC LIMIT ?`).all(...scopeValues, ...(before ? [Number(before)] : []), limit + 1);
  const updates = rows.slice(0, limit).map(row => { const payload = minimizeAdEvent(JSON.parse(row.data), true); return { ...payload, sequence: row.sequence, scope: payload.adAccount || payload.adObject || payload.video ? 'advertiser' : 'connection' }; });
  const health = { initialSync: latest(db, where + " AND ad_account_id=''", values, ['account.ads.initial_sync_completed']), advertiserSync: adAccountId ? latest(db, where + ' AND ad_account_id=?', [...values, adAccountId], ['account.ads.sync_failed', 'account.ads.sync_recovered']) : null };
  const freshAccount = requireAccount(await scopedAccounts(api, profileId), accountId); if (freshAccount.platform !== account.platform) fail(409, 'AD_EVENT_CONNECTION_CHANGED', 'The connection changed. Refresh provider updates.');
  if (adAccountId && !nativeRows(await adAccounts(api, accountId), account.platform).some(row => row.id === adAccountId)) fail(403, 'AD_ACCOUNT_OUTSIDE_PROJECT', 'The selected advertising account is no longer available.');
  context.assertProjectMapping?.(profileId); send(200, { updates, health, pagination: { hasMore: rows.length > limit, before: rows.length > limit ? updates.at(-1).sequence : null }, checkedAt: new Date().toISOString(), webhookConfigured: Boolean(context.config?.env?.ZERNIO_WEBHOOK_SECRET) }); return true;
}
