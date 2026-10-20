import { createHash, createSign, randomUUID } from 'node:crypto';
import { readResponseText } from '@ten98/runtime';
import { PLATFORM_RULES, buildPlatformEntry, normalizeMediaItems, normalizePlatformOptions, normalizePostVariants, normalizePostTags, normalizeAccountVariants, assertAccountSchedules, validPostInstant, resolveVariant, validatePostForPlatforms, wireMediaItems, assetDeliveryIssue, providerPostMediaUrls } from '../shared/social-posts.ts';
import { transaction } from './database.mjs';
import { handleGoogleAds } from './google-ads.mjs';
import { handleGoogleConversions } from './zernio-google-conversions.mjs';
import { handleZernioContacts } from './zernio-contacts.mjs';
import { handleZernioAdEvents } from './zernio-ad-events.mjs';
import { handleZernioAccounts } from './zernio-accounts.mjs';
import { handleZernioMeasurement } from './zernio-measurement.mjs';
import { handleZernioAdmin } from './zernio-admin.mjs';
import { handleWebhookSettings } from './zernio-webhook-settings.mjs';
import { handleZernioPublishing } from './zernio-publishing.mjs';
import { handleZernioConnections } from './zernio-connections.mjs';
import { handleZernioInsights } from './zernio-insights.mjs';
import { handleZernioLeads, validateAdLeadForm } from './zernio-leads.mjs';
import { handleZernioWhatsAppTemplates } from './zernio-whatsapp-templates.mjs';
import { handleZernioRecycling, assertRecyclingSeedEditable } from './zernio-recycling.mjs';
import { handleZernioQueues, applyQueueIntent, assertQueueReceipt } from './zernio-queues.mjs';
import { handleZernioMedia } from './zernio-media.mjs';
import { handleZernioBlogs } from './zernio-blogs.mjs';
import { handleZernioProducts } from './zernio-products.mjs';

const ZERNIO = 'https://zernio.com/api/v1';
const GOOGLE = 'https://www.googleapis.com';
const WRITE_ROLES = new Set(['owner', 'admin', 'editor']);
const AD_PLATFORMS = new Set(['facebook', 'instagram', 'google', 'tiktok', 'linkedin', 'pinterest', 'twitter', 'openai', 'reddit']);
const CREATE_CONNECTIONS = { facebook: ['metaads', 'facebook', 'instagram'], instagram: ['metaads', 'facebook', 'instagram'], google: ['googleads'], pinterest: ['pinterestads', 'pinterest'], tiktok: ['tiktokads', 'tiktok'], linkedin: ['linkedinads', 'linkedin'], twitter: ['xads', 'twitter'], openai: ['openaiads'], reddit: ['redditads'] };
const SOCIAL_CONNECT = new Set(['twitter', 'instagram', 'facebook', 'linkedin', 'tiktok', 'youtube', 'pinterest', 'reddit', 'threads', 'googlebusiness', 'whatsapp', 'discord', 'slack']);
const ADS_CONNECT = new Set(['facebook', 'instagram', 'google', 'linkedin', 'tiktok', 'pinterest', 'twitter', 'reddit']);
const MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'application/pdf', 'text/plain']);

export class IntegrationError extends Error {
  constructor(status, code, message, uncertain = false) {
    super(message); Object.assign(this, { status, code, uncertain });
  }
}
const fail = (status, code, message) => { throw new IntegrationError(status, code, message); };
const text = (value, name, max = 200) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) fail(400, 'INVALID_INPUT', `A valid ${name} is required.`);
  return value.trim();
};
const identifier = (value, name) => { const result = text(value, name, 500); if (/\s/.test(result)) fail(400, 'INVALID_INPUT', `A valid ${name} is required.`); return result; };
const sample = record => record?.sample === true || record?.isSample === true || record?.demo === true || ['sample', 'demo'].includes(record?.source);
const secretField = /token|secret|password|authorization|api.?key|credentials|private.?key/i;
export function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !secretField.test(key)).map(([key, item]) => [key, redact(item)]));
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function checkMapping(check, uncertain = false) {
  try { check?.(); } catch (error) { if (!uncertain && [403, 404].includes(error.status)) throw new IntegrationError(error.status, 'PROJECT_ACCESS_CHANGED', 'Your project access changed. Refresh before continuing.'); throw new IntegrationError(409, 'PROJECT_CONNECTION_CHANGED', uncertain ? 'The project connection changed after the provider received this action. Reconcile the previous connection.' : 'The project connection changed. Reload this project before continuing.', uncertain); }
}
async function providerJson(response, signal, allowEmpty = false) {
  const body = await readResponseText(response, { maxBytes: 8 * 1024 * 1024, signal, preserveBOM: true });
  return allowEmpty && body.length === 0 ? {} : JSON.parse(body);
}
async function request(url, options = {}, provider = 'Zernio', assertMapping, observeReceipt) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !['zernio.com', 'www.googleapis.com', 'oauth2.googleapis.com', 'googleads.googleapis.com', 'login.microsoftonline.com', 'clientcenter.api.bingads.microsoft.com', 'campaign.api.bingads.microsoft.com', 'reporting.api.bingads.microsoft.com', 'api.twilio.com', 'api.cloudflare.com'].includes(target.hostname)) fail(500, 'INVALID_PROVIDER', 'The provider endpoint is invalid.');
  checkMapping(assertMapping);
  const signal = AbortSignal.timeout(['/api/v1/ads/create', '/api/v1/ads/boost'].includes(target.pathname) ? 180000 : 20000);
  let response;
  try { response = await fetch(target, { ...options, redirect: 'error', signal }); }
  catch { throw new IntegrationError(502, 'PROVIDER_UNAVAILABLE', `${provider} did not confirm the request.`, options.method && options.method !== 'GET'); }
  if (!response.ok) {
    const status = response.status === 429 ? 429 : response.status >= 500 ? 502 : 400;
    let providerCode; const privateReply = {};
    if (target.hostname === 'zernio.com' && response.status === 404 && (options.method || 'GET') === 'GET' && /^\/api\/v1\/commerce\/products\/[^/]+$/.test(target.pathname)) {
      try { const result = await providerJson(response, signal); if (result && typeof result === 'object' && !Array.isArray(result) && ['product_not_found', 'account_not_found'].includes(result.code)) providerCode = result.code; } catch { /* An unreadable or unrecognized absence never proves deletion. */ }
      checkMapping(assertMapping);
    }
    if (target.hostname === 'zernio.com' && /^\/api\/v1\/inbox\/comments\/[^/]+\/[^/]+\/private-reply$/.test(target.pathname)) {
      try {
        const result = await providerJson(response, signal), details = result?.details;
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
        if (typeof details?.privateReplyConsumed === 'boolean') privateReply.privateReplyConsumed = details.privateReplyConsumed;
        if (details?.privateReplyOutcome === 'unknown') privateReply.privateReplyOutcome = 'unknown';
      } catch { privateReply.privateReplyOutcome = 'unknown'; }
    }
    if (target.hostname === 'api.twilio.com') { try { const result = await providerJson(response, signal); if (Number.isSafeInteger(result?.code) && result.code >= 10000 && result.code <= 99999) providerCode = result.code; } catch { /* Preserve the sanitized rejection when the error body is unreadable. */ } }
    throw Object.assign(new IntegrationError(status, response.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_REJECTED', `${provider} ${response.status === 429 ? 'rate limit reached. Try again later.' : 'could not complete this request. Check the connection and request details.'}`, (response.status >= 500 || [408, 409].includes(response.status)) && options.method && options.method !== 'GET'), { providerStatus: response.status, ...privateReply, ...(providerCode === undefined ? {} : { providerCode }) });
  }
  if (response.status === 204) { checkMapping(assertMapping, options.method && options.method !== 'GET'); return {}; }
  let result;
  try {
    result = await providerJson(response, signal, response.status === 200 && target.hostname === 'zernio.com' && ((/^\/api\/v1\/accounts\/[^/]+\/telegram-commands$/.test(target.pathname) && ['PUT', 'DELETE'].includes(options.method)) || (/^\/api\/v1\/accounts\/[^/]+\/slack-settings$/.test(target.pathname) && options.method === 'PATCH')));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
  } catch { throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', `${provider} returned an unreadable response.`, options.method && options.method !== 'GET'); }
  try { observeReceipt?.(result); }
  catch { throw new IntegrationError(502, 'PROVIDER_REFERENCE_NOT_RECORDED', 'The provider response could not be recorded.', options.method && options.method !== 'GET'); }
  checkMapping(assertMapping, options.method && options.method !== 'GET');
  return result;
}
function zernioClient(key, assertMapping) {
  return async (path, query = {}, body, idempotencyKey, method, observeReceipt) => {
    const url = new URL(`${ZERNIO}${path}`);
    for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
    return request(url, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey, ...(path === '/posts' ? { 'x-request-id': idempotencyKey } : {}) } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, 'Zernio', assertMapping, observeReceipt);
  };
}
function dateQuery(url) {
  const query = {};
  for (const name of ['fromDate', 'toDate']) {
    const value = url.searchParams.get(name);
    if (value) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail(400, 'INVALID_DATE', 'Dates must use YYYY-MM-DD.');
      query[name] = value;
    }
  }
  if (query.fromDate && query.toDate && query.fromDate > query.toDate) fail(400, 'INVALID_DATE', 'The start date must precede the end date.');
  return query;
}
function analyticsDates(url, days) {
  const dates = dateQuery(url), toDate = dates.toDate || new Date().toISOString().slice(0, 10), fromDate = dates.fromDate || new Date(Date.parse(toDate) - (days - 1) * 86400000).toISOString().slice(0, 10);
  if (fromDate > toDate || Date.parse(toDate) - Date.parse(fromDate) >= 366 * 86400000) fail(400, 'INVALID_DATE', 'Choose an analytics window of at most 366 inclusive days.');
  return { fromDate, toDate };
}
const reportObject = value => value && typeof value === 'object' && !Array.isArray(value);
function analyticsMetrics(value) {
  return reportObject(value) && ['impressions', 'reach', 'likes', 'comments', 'shares', 'saves', 'clicks', 'views', 'engagement', 'engagementRate'].every(key => value[key] === undefined || value[key] === null || typeof value[key] === 'number' && Number.isFinite(value[key]));
}
function reportDay(value, dates) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value && value >= dates.fromDate && value <= dates.toDate;
}
function analyticsScope(row, profileId, accounts) {
  if (!reportObject(row)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return a readable analytics row.');
  if (row.profileId !== undefined && row.profileId !== null && String(row.profileId?._id || row.profileId) !== profileId) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned analytics outside this project.');
  if (row.accountId !== undefined) {
    const account = accounts.find(item => item._id === String(row.accountId?._id || row.accountId));
    if (!account || row.platform && account.platform !== row.platform) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned analytics outside this project’s connected accounts.');
  }
}
async function analyticsDashboard(api, profileId, dates) {
  const response = await api('/analytics/dashboard', { profileId, ...dates, compare: 'previous_period' }), result = response.data || response;
  if (!analyticsMetrics(result.totals) || result.previousTotals !== undefined && !analyticsMetrics(result.previousTotals) || !Array.isArray(result.daily) || result.daily.length > 366 || result.daily.some(row => !reportObject(row) || !reportDay(row.date, dates) || !analyticsMetrics(row)) || new Set(result.daily.map(row => row.date)).size !== result.daily.length) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return a readable analytics dashboard.');
  if (result.dateRange && (result.dateRange.fromDate !== dates.fromDate || result.dateRange.toDate !== dates.toDate)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned a different reporting window.');
  for (const key of ['topPosts', 'recentPosts']) if (result[key] !== undefined && (!Array.isArray(result[key]) || result[key].length > 25 || result[key].some(row => !reportObject(row) || typeof row.postId !== 'string' || row.postId.length > 500 || row.platform != null && typeof row.platform !== 'string' || row.publishedAt != null && (typeof row.publishedAt !== 'string' || !Number.isFinite(Date.parse(row.publishedAt))) || row.metrics !== undefined && !analyticsMetrics(row.metrics)))) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return readable post performance rows.');
  const followerSets = [result.followers, result.previousFollowers].filter(value => value !== undefined);
  for (const value of followerSets) {
    if (!reportObject(value) || ['current', 'gained'].some(key => value[key] != null && (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || key === 'current' && value[key] < 0))) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return readable follower performance totals.');
    if (value.byAccount !== undefined && (!Array.isArray(value.byAccount) || value.byAccount.length > 1000 || value.byAccount.some(row => !reportObject(row) || typeof row.accountId !== 'string'))) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return readable follower performance rows.');
  }
  const scopedRows = [...followerSets.flatMap(value => value.byAccount || []), ...(result.topPosts || []), ...(result.recentPosts || [])];
  const accounts = scopedRows.some(row => row.accountId !== undefined) ? await scopedAccounts(api, profileId) : [];
  scopedRows.forEach(row => analyticsScope(row, profileId, accounts));
  return result;
}
async function scopedAccounts(api, profileId) {
  const result = await api('/accounts', { profileId });
  if (!Array.isArray(result.accounts) || result.accounts.some(account => !reportObject(account) || typeof account._id !== 'string' || !account._id || typeof account.platform !== 'string' || !account.platform)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return an account list.');
  // Fail closed if Zernio ever returns an account outside the requested profile.
  const accounts = result.accounts.filter(account => String(account.profileId?._id || account.profileId) === profileId);
  if (accounts.some(account => ['displayName', 'username', 'name'].some(key => account[key] != null && typeof account[key] !== 'string') || account.isActive != null && typeof account.isActive !== 'boolean')) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return readable connected account details.');
  return accounts;
}
function requireAccount(accounts, accountId) {
  const account = accounts.find(item => item._id === accountId);
  if (!account) fail(403, 'ACCOUNT_OUTSIDE_PROJECT', 'This account is not connected to this project.');
  return account;
}
export async function campaignTree(api, profileId, dates = {}) {
  const all = []; let last; let backfillPending = false;
  for (let page = 1; page <= 10; page++) {
    const result = await api('/ads/tree', { profileId, ...dates, page, limit: 100, source: 'all' });
    if (!Array.isArray(result.campaigns)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return a campaign tree.');
    if (result.campaigns.some(campaign => String(campaign.profileId?._id || campaign.profileId) !== profileId)) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned campaign data without the expected project profile.');
    all.push(...result.campaigns); last = result; backfillPending ||= Boolean(result.backfillPending);
    const pagination = result.pagination || {};
    const pages = pagination.pages ?? pagination.totalPages ?? (pagination.total === undefined ? undefined : Math.ceil(pagination.total / 100));
    if (pagination.hasMore === false || (pages !== undefined && page >= pages) || (pages === undefined && pagination.hasMore !== true && result.campaigns.length < 100)) return { ...redact(last), campaigns: redact(all), backfillPending, complete: !backfillPending, pagination: { ...pagination, page: 1, pages: 1, total: all.length, hasMore: false } };
  }
  fail(503, 'INCOMPLETE_PROVIDER_DATA', 'The campaign tree exceeds the current reporting limit.');
}
export async function adAccounts(api, accountId) {
  const result = await api('/ads/accounts', { accountId, inScopeOnly: true });
  if (!reportObject(result) || !Array.isArray(result.accounts) || result.stale !== undefined && typeof result.stale !== 'boolean' || result.cachedAt != null && !validPostInstant(result.cachedAt)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return valid advertising account access information.');
  if (result.stale === true) fail(503, 'AD_ACCOUNT_MEMBERSHIP_STALE', 'The provider returned an older advertising account list after its quota was exhausted. Wait for a current access check before continuing.');
  return result;
}
async function discoverMetaCampaigns(context, api, profileId, accountId, adAccountId) {
  const invalid = () => fail(502, 'INVALID_PROVIDER_RESPONSE', 'The provider did not return a complete, readable Meta campaign list.');
  async function selected() {
    const accounts = await scopedAccounts(api, profileId);
    if (accounts.filter(row => row._id === accountId).length !== 1) fail(403, 'ACCOUNT_OUTSIDE_PROJECT', 'Choose one Meta connection in this project.');
    const account = requireAccount(accounts, accountId);
    if (!CREATE_CONNECTIONS.facebook.includes(account.platform) || account.isActive !== true || account.needsReconnection === true) fail(409, 'ACCOUNT_UNAVAILABLE', 'This Meta connection is unavailable. Refresh or reconnect it before discovering campaigns.');
    return account;
  }
  async function advertiser() {
    const access = await adAccounts(api, accountId), seen = new Set();
    for (const row of access.accounts) {
      if (!reportObject(row) || !copyId(row.id) || row.selectable !== undefined && typeof row.selectable !== 'boolean' || seen.has(copyAdvertiser('facebook', row.id))) invalid();
      seen.add(copyAdvertiser('facebook', row.id));
    }
    const row = access.accounts.find(row => copyAdvertiser('facebook', row.id) === copyAdvertiser('facebook', adAccountId));
    if (!row || row.selectable === false) fail(403, 'AD_ACCOUNT_OUTSIDE_PROJECT', 'Choose an advertiser available through this Meta connection.');
    for (const value of [access, row]) for (const [field, expected] of [['profileId', profileId], ['accountId', accountId], ['adAccountId', adAccountId], ['platformAdAccountId', adAccountId]]) if (Object.hasOwn(value, field) && (['adAccountId', 'platformAdAccountId'].includes(field) ? !copyId(adSetReference(value[field])) || copyAdvertiser('facebook', adSetReference(value[field])) !== copyAdvertiser('facebook', expected) : adSetReference(value[field]) !== expected)) fail(502, 'INVALID_PROVIDER_SCOPE', 'The provider returned a different advertiser scope.');
  }
  const account = await selected(); await advertiser();
  const campaigns = [], seen = new Set(), readable = value => typeof value === 'string' && value.length <= 2000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
  let total, pages;
  // ponytail: complete discovery is capped at 1,000 campaigns; use advertiser filters before increasing this bound.
  for (let page = 1; page <= 10; page++) {
    const result = await api('/ads/campaigns', { profileId, accountId, adAccountId, includeEmpty: true, source: 'all', page, limit: 100 }), pagination = result?.pagination;
    if (!reportObject(result) || !Array.isArray(result.campaigns) || !reportObject(pagination) || result.error !== undefined || result.backfillPending === true || result.stale === true || !Number.isSafeInteger(pagination.total) || pagination.total < 0 || !Number.isSafeInteger(pagination.pages) || pagination.pages < 0 || pagination.pages !== Math.ceil(pagination.total / 100) && !(pagination.total === 0 && pagination.pages === 1) || pagination.page !== page || pagination.limit !== 100 || pagination.hasMore !== undefined && pagination.hasMore !== (page < pagination.pages) || pagination.totalPages !== undefined && pagination.totalPages !== pagination.pages || total !== undefined && (pagination.total !== total || pagination.pages !== pages) || result.campaigns.length !== Math.min(100, Math.max(0, pagination.total - (page - 1) * 100))) invalid();
    for (const [field, expected] of [['profileId', profileId], ['accountId', accountId], ['adAccountId', adAccountId], ['platformAdAccountId', adAccountId]]) if (Object.hasOwn(result, field) && (['adAccountId', 'platformAdAccountId'].includes(field) ? !copyId(adSetReference(result[field])) || copyAdvertiser('facebook', adSetReference(result[field])) !== copyAdvertiser('facebook', expected) : adSetReference(result[field]) !== expected)) fail(502, 'INVALID_PROVIDER_SCOPE', 'The provider returned a different campaign discovery scope.');
    total = pagination.total; pages = pagination.pages;
    for (const row of result.campaigns) {
      if (!reportObject(row) || !copyId(row.platformCampaignId) || !['facebook', 'instagram'].includes(row.platform) || adSetReference(row.profileId) !== profileId || adSetReference(row.accountId) !== accountId || !copyId(row.platformAdAccountId) || copyAdvertiser('facebook', row.platformAdAccountId) !== copyAdvertiser('facebook', adAccountId)) fail(502, 'INVALID_PROVIDER_SCOPE', 'The provider returned a campaign outside the selected project, connection or advertiser.');
      if (seen.has(row.platformCampaignId) || ['campaignName', 'status', 'platformCampaignStatus'].some(field => row[field] != null && !readable(row[field])) || row.adCount != null && (!Number.isSafeInteger(row.adCount) || row.adCount < 0)) invalid();
      seen.add(row.platformCampaignId);
      campaigns.push({ platformCampaignId: row.platformCampaignId, platform: row.platform, campaignName: row.campaignName ?? null, status: row.status ?? null, platformCampaignStatus: row.platformCampaignStatus ?? null, adCount: row.adCount ?? null });
    }
    if (page >= pages) {
      await advertiser(); const current = await selected();
      if (['_id', 'platform', 'platformUserId', 'platformId', 'isActive', 'needsReconnection'].some(field => (current[field] ?? null) !== (account[field] ?? null))) fail(409, 'ACCOUNT_UNAVAILABLE', 'The Meta connection changed. Refresh before discovering campaigns again.');
      checkMapping(() => context.assertProjectMapping?.(profileId));
      return { accountId, adAccountId, campaigns, complete: true };
    }
  }
  fail(503, 'INCOMPLETE_PROVIDER_DATA', 'This advertiser exceeds the 1,000-campaign discovery limit. No partial list is shown.');
}
function fields(value, allowed, name = 'ad') {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'UNSUPPORTED_AD_FIELD', `Use only supported ${name} fields.`);
}
function textList(value, name, min, max, length) {
  if (!Array.isArray(value) || value.length < min || value.length > max) fail(400, 'INVALID_AD_LIST', `${name} needs ${min} to ${max} entries.`);
  const result = value.map(item => text(item, name, length));
  if (new Set(result).size !== result.length) fail(400, 'DUPLICATE_SEARCH_COPY', `Each entry in ${name} must be distinct.`);
  return result;
}
function countries(value) {
  if (!Array.isArray(value) || !value.length || value.length > 50 || value.some(item => typeof item !== 'string' || !/^[A-Z]{2}$/.test(item))) fail(400, 'INVALID_COUNTRIES', 'Choose 1 to 50 countries using two-letter uppercase country codes.');
  return [...new Set(value)];
}
function adAmount(value, currency, minimum = 0) {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) fail(502, 'AD_ACCOUNT_CURRENCY_MISSING', 'The advertising account must report its currency before changing budgets.');
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value < minimum || value > 10000000) fail(400, 'INVALID_BUDGET', `Enter a budget above zero${minimum ? ` and at least ${minimum} ${currency}` : ''}.`);
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  if (Math.abs(value * 10 ** digits - Math.round(value * 10 ** digits)) > 0.000001) fail(400, 'INVALID_BUDGET', `The ${currency} budget supports ${digits} decimal places.`);
  return value;
}
function adTargeting(value, platform, campaignType, editing = false) {
  const allowed = ['countries'];
  if (['facebook', 'instagram', 'tiktok', 'pinterest'].includes(platform)) allowed.push('ageMin', 'ageMax', 'gender');
  if (['facebook', 'instagram', 'tiktok', 'google', 'reddit'].includes(platform)) allowed.push('languages');
  if (['facebook', 'instagram', 'tiktok', 'google', 'linkedin', 'reddit'].includes(platform)) allowed.push('regions', 'cities', 'interests');
  if (platform === 'google') { allowed.splice(allowed.indexOf('interests'), 1); if (editing && campaignType === 'search') allowed.push('keywords', 'negativeKeywords'); }
  if (platform === 'linkedin') allowed.splice(allowed.indexOf('cities'), 1);
  if (platform === 'reddit') allowed.push('communities', 'excludedCommunities', 'conversationKeywords', 'excludedConversationKeywords');
  fields(value, allowed, 'audience'); const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === 'countries') result.countries = countries(item);
    else if (['ageMin', 'ageMax'].includes(key)) {
      if (!Number.isInteger(item) || item < 13 || item > 65) fail(400, 'INVALID_AUDIENCE', 'Ages must be whole numbers from 13 to 65.');
      result[key] = item;
    } else if (key === 'gender') { if (!['all', 'male', 'female'].includes(item)) fail(400, 'INVALID_AUDIENCE', 'Choose an available audience gender.'); result.gender = item; }
    else if (['regions', 'cities', 'interests'].includes(key)) {
      if (!Array.isArray(item) || !item.length || item.length > 100) fail(400, 'INVALID_AUDIENCE', 'Choose 1 to 100 audience options.');
      result[key] = item.map(entry => {
        fields(entry, key === 'interests' ? ['id', 'name'] : ['key', 'name'], 'audience option');
        return { [key === 'interests' ? 'id' : 'key']: identifier(entry[key === 'interests' ? 'id' : 'key'], 'audience option ID'), ...(entry.name ? { name: text(entry.name, 'audience option name') } : {}) };
      });
      if (key === 'interests' && result[key].some(entry => !entry.name)) fail(400, 'INVALID_AUDIENCE', 'Each interest needs its provider name and ID.');
    } else result[key] = textList(item, key, editing && ['keywords', 'negativeKeywords'].includes(key) ? 0 : 1, key.includes('Keywords') || key === 'keywords' ? 1000 : 100, key === 'keywords' || key === 'negativeKeywords' ? 80 : 200);
  }
  if (result.ageMin && result.ageMax && result.ageMin > result.ageMax) fail(400, 'INVALID_AUDIENCE', 'Minimum age must not exceed maximum age.');
  return result;
}
function googleAssets(value, type) {
  const pmax = type === 'pmax';
  fields(value, ['finalUrl', 'businessName', 'headlines', 'descriptions', 'images', ...(pmax ? ['name', 'longHeadline', 'youtubeVideoId'] : ['longHeadlines', 'youtubeVideoIds', 'channels', 'carouselCards'])], 'Google asset');
  const result = { finalUrl: mediaUrl(value.finalUrl), businessName: text(value.businessName, 'business name', 25), headlines: textList(value.headlines, 'headlines', pmax ? 3 : 1, pmax ? 15 : 5, pmax ? 30 : 40), descriptions: textList(value.descriptions, 'descriptions', pmax ? 2 : 1, 5, 90) };
  if (pmax) { result.longHeadline = text(value.longHeadline, 'long headline', 90); if (!result.descriptions.some(item => item.length <= 60)) fail(400, 'INVALID_AD_COPY', 'Performance Max needs a description of at most 60 characters.'); if (value.name !== undefined) result.name = text(value.name, 'asset group name', 128); }
  fields(value.images, pmax ? ['landscape', 'square', 'logo'] : ['landscape', 'square', 'portrait', 'logo'], 'Google image'); result.images = {};
  for (const [role, urls] of Object.entries(value.images)) result.images[role] = textList(urls, `${role} images`, 1, role === 'logo' ? 5 : 20, 4000).map(mediaUrl);
  if (!result.images.logo || (pmax && (!result.images.landscape || !result.images.square))) fail(400, 'INVALID_AD_IMAGES', 'Supply a logo, landscape image, and square image for Performance Max; Demand Gen always needs a logo.');
  if (value.youtubeVideoId !== undefined) { if (!/^[A-Za-z0-9_-]{11}$/.test(value.youtubeVideoId)) fail(400, 'INVALID_VIDEO', 'Use the 11-character YouTube video ID.'); result.youtubeVideoId = value.youtubeVideoId; }
  if (!pmax && value.youtubeVideoIds !== undefined) {
    result.youtubeVideoIds = textList(value.youtubeVideoIds, 'YouTube videos', 1, 5, 11);
    if (result.youtubeVideoIds.some(item => !/^[A-Za-z0-9_-]{11}$/.test(item))) fail(400, 'INVALID_VIDEO', 'Use 11-character YouTube video IDs.');
    result.longHeadlines = textList(value.longHeadlines, 'long headlines', 1, 5, 90);
    if (Object.keys(result.images).some(role => role !== 'logo') || result.images.logo.length !== 1 || value.carouselCards) fail(400, 'INVALID_AD_IMAGES', 'Demand Gen video ads need exactly one logo and no carousel or marketing images.');
  } else if (!pmax && value.longHeadlines !== undefined) fail(400, 'UNSUPPORTED_AD_FIELD', 'Long headlines are for Demand Gen video ads.');
  if (!pmax && value.carouselCards !== undefined) {
    if (!Array.isArray(value.carouselCards) || value.carouselCards.length < 2 || value.carouselCards.length > 10) fail(400, 'INVALID_CAROUSEL', 'Use 2 to 10 carousel cards.');
    if (result.headlines.length !== 1 || result.descriptions.length !== 1 || Object.keys(result.images).some(role => role !== 'logo') || result.images.logo.length !== 1) fail(400, 'INVALID_CAROUSEL', 'Demand Gen carousels use one headline, one description and one logo.');
    let shape; const seen = new Set();
    result.carouselCards = value.carouselCards.map(card => { fields(card, ['headline', 'finalUrl', 'images'], 'carousel card'); fields(card.images, ['landscape', 'square', 'portrait'], 'carousel image'); const keys = Object.keys(card.images); if (keys.length !== 1 || (shape && shape !== keys[0])) fail(400, 'INVALID_CAROUSEL', 'Use the same single image shape on every card.'); shape = keys[0]; const image = mediaUrl(card.images[shape]); if (seen.has(image)) fail(400, 'INVALID_CAROUSEL', 'Every card must use a different image.'); seen.add(image); return { headline: text(card.headline, 'card headline', 40), images: { [shape]: image }, ...(card.finalUrl ? { finalUrl: mediaUrl(card.finalUrl) } : {}) }; });
  }
  if (!pmax && !result.youtubeVideoIds && !result.carouselCards && !result.images.landscape && !result.images.square) fail(400, 'INVALID_AD_IMAGES', 'Demand Gen image ads need a landscape or square marketing image.');
  if (!pmax && value.channels !== undefined) { result.channels = textList(value.channels, 'channels', 1, 6, 30); if (result.channels.some(item => !['youtube_in_stream', 'youtube_in_feed', 'youtube_shorts', 'discover', 'gmail', 'display'].includes(item))) fail(400, 'INVALID_AD_CHANNEL', 'Choose an available Demand Gen channel.'); }
  return result;
}
function googleAssetUpdate(value, type) {
  const pmax = type === 'pmax', result = {};
  fields(value, ['finalUrl', 'businessName', 'headlines', 'descriptions', 'images', 'youtubeVideoIds', ...(pmax ? ['longHeadline'] : ['longHeadlines', 'channels', 'callToAction'])], 'replacement Google asset');
  for (const [key, item] of Object.entries(value)) {
    if (key === 'finalUrl') result.finalUrl = mediaUrl(item);
    else if (['businessName', 'longHeadline', 'callToAction'].includes(key)) result[key] = text(item, key, key === 'longHeadline' ? 90 : 25);
    else if (key === 'headlines' || key === 'descriptions' || key === 'longHeadlines') { result[key] = textList(item, key, pmax ? key === 'headlines' ? 3 : 2 : 1, pmax && key === 'headlines' ? 15 : 5, key === 'headlines' ? pmax ? 30 : 40 : 90); if (pmax && key === 'descriptions' && !result[key].some(entry => entry.length <= 60)) fail(400, 'INVALID_AD_COPY', 'Performance Max needs a description of at most 60 characters.'); }
    else if (key === 'images') { fields(item, pmax ? ['landscape', 'square', 'logo'] : ['landscape', 'square', 'portrait', 'logo'], 'replacement Google image'); if (!Object.keys(item).length) fail(400, 'INVALID_AD_IMAGES', 'Choose an image role to replace.'); result.images = Object.fromEntries(Object.entries(item).map(([role, urls]) => [role, textList(urls, `${role} images`, 1, role === 'logo' ? 5 : 20, 4000).map(mediaUrl)])); }
    else if (key === 'youtubeVideoIds') { result.youtubeVideoIds = textList(item, 'YouTube videos', 1, 5, 11); if (result.youtubeVideoIds.some(entry => !/^[A-Za-z0-9_-]{11}$/.test(entry))) fail(400, 'INVALID_VIDEO', 'Use 11-character YouTube video IDs.'); }
    else if (key === 'channels') { result.channels = textList(item, 'channels', 1, 6, 30); if (result.channels.some(entry => !['youtube_in_stream', 'youtube_in_feed', 'youtube_shorts', 'discover', 'gmail', 'display'].includes(entry))) fail(400, 'INVALID_AD_CHANNEL', 'Choose an available Demand Gen channel.'); }
  }
  if (!Object.keys(result).length) fail(400, 'EMPTY_AD_UPDATE', 'Choose an asset field to replace.');
  return result;
}
function adBody(body, account, nativeAccount, boost = false) {
  const common = ['platform', 'accountId', 'adAccountId', 'name', 'goal', 'budgetAmount', 'budgetType', 'countries', 'status', 'currency', 'targeting', 'startDate', 'endDate', 'leadFormReview'];
  fields(body, [...common, ...(boost ? ['postId', ...(body.platform === 'reddit' ? ['promotedObject', 'linkUrl'] : [])] : ['headline', 'body', 'linkUrl', 'imageUrl', 'video', 'carouselCards', 'callToAction', 'campaignType', 'businessName', 'images', 'additionalHeadlines', 'additionalDescriptions', 'keywords', 'advantageAudience', 'boardId', 'organizationId', 'assetGroup', 'demandGen', 'promotedObject', 'leadGenFormId', 'bidStrategy', 'bidAmount', 'creativeFormat', 'tracking'])]);
  const platform = body.platform, meta = ['facebook', 'instagram'].includes(platform), google = platform === 'google', advancedGoogle = google && ['pmax', 'demand_gen'].includes(body.campaignType);
  if (!CREATE_CONNECTIONS[platform]?.includes(account.platform)) fail(400, 'AD_CONNECTION_MISMATCH', 'Select a connected account for this advertising network.');
  const goals = ['traffic', 'awareness', ...(['facebook', 'instagram', 'google', 'pinterest', 'linkedin', 'tiktok', 'twitter'].includes(platform) ? ['engagement'] : []), ...(['facebook', 'instagram', 'linkedin', 'tiktok', 'reddit'].includes(platform) ? ['video_views'] : []), ...(['facebook', 'instagram', 'tiktok', 'openai', 'reddit'].includes(platform) ? ['conversions'] : []), ...(meta || ['linkedin', 'reddit'].includes(platform) ? ['lead_generation'] : [])];
  if (!advancedGoogle && !goals.includes(body.goal)) fail(400, 'UNSUPPORTED_AD_GOAL', 'Choose a supported goal for this network.');
  const budgetType = body.budgetType || 'daily';
  if (budgetType !== 'daily' && !(['openai', 'reddit'].includes(platform) && budgetType === 'lifetime')) fail(400, 'UNSUPPORTED_BUDGET', 'Choose a supported budget type.');
  if (body.status !== undefined && body.status !== 'PAUSED') fail(400, 'INVALID_AD_STATUS', 'New ads must start paused. Review them before activation.');
  if (body.currency && body.currency !== nativeAccount.currency) fail(400, 'CURRENCY_MISMATCH', 'The budget currency must match the advertising account.');
  const minimum = Math.max(platform === 'pinterest' ? 5 : platform === 'tiktok' ? 20 : platform === 'openai' ? 1 : 0, budgetType === 'daily' ? Number(nativeAccount.minimumDailyBudget) || 0 : 0);
  const result = { accountId: account._id, adAccountId: nativeAccount.id, name: text(body.name, 'ad name', 255), ...(!advancedGoogle ? { goal: body.goal } : {}), budgetAmount: adAmount(body.budgetAmount, nativeAccount.currency, minimum), budgetType, countries: countries(body.countries), status: 'PAUSED' };
  if (body.targeting !== undefined) { result.targeting = adTargeting(body.targeting, platform, body.campaignType); if (result.targeting.countries) fail(400, 'INVALID_AUDIENCE', 'Set countries once using the target countries field.'); }
  for (const key of ['startDate', 'endDate']) if (body[key] !== undefined) { if (typeof body[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(body[key]) || Number.isNaN(Date.parse(body[key])) || new Date(body[key].slice(0, 10)).toISOString().slice(0, 10) !== body[key].slice(0, 10)) fail(400, 'INVALID_DATE', 'Use a valid date and time including its timezone.'); result[key] = google ? body[key] : new Date(body[key]).toISOString(); }
  if (google ? result.startDate && result.endDate && result.startDate.slice(0, 10) > result.endDate.slice(0, 10) : (result.endDate && Date.parse(result.endDate) <= Date.now()) || (result.startDate && result.endDate && Date.parse(result.startDate) >= Date.parse(result.endDate))) fail(400, 'INVALID_DATE', google ? 'The end day must be the same as or later than the start day, in the advertising account’s timezone.' : 'The end must be in the future and later than the start.');
  if (budgetType === 'lifetime' && !result.endDate) fail(400, 'INVALID_DATE', 'Lifetime campaigns require a future end time.');
  if (platform === 'reddit') {
    if (!body.promotedObject?.pixelId) fail(400, 'REDDIT_PIXEL_REQUIRED', 'Every Reddit ad group needs a pixel. Enter a pixel from this advertising account.');
    fields(body.promotedObject, ['pixelId', 'customEventType'], 'Reddit pixel');
    result.promotedObject = { pixelId: identifier(body.promotedObject.pixelId, 'Reddit pixel ID') };
    if (body.promotedObject.customEventType !== undefined) {
      const event = text(body.promotedObject.customEventType, 'Reddit conversion event').toUpperCase();
      if (!['PURCHASE', 'LEAD', 'COMPLETE_REGISTRATION', 'SIGN_UP', 'ADD_TO_CART', 'PAGE_VISIT', 'VIEW_CONTENT', 'CONTENT_VIEW'].includes(event) || body.goal !== 'conversions' && !(body.goal === 'lead_generation' && event === 'LEAD')) fail(400, 'INVALID_CONVERSION_EVENT', 'Choose a supported Reddit event for this campaign goal.');
      result.promotedObject.customEventType = event;
    }
    if (body.goal === 'conversions' && !result.promotedObject.customEventType) fail(400, 'CONVERSION_CONFIGURATION_REQUIRED', 'Reddit conversion campaigns need a conversion event that this pixel has already received.');
    if (body.goal === 'lead_generation') result.promotedObject.customEventType = 'LEAD';
  }
  if (boost) { if (platform === 'reddit' && (body.linkUrl !== undefined || body.goal === 'lead_generation')) result.linkUrl = mediaUrl(body.linkUrl); result.targeting = { countries: result.countries, ...result.targeting }; delete result.countries; return result; }
  const perNetwork = google ? ['campaignType', ...(advancedGoogle ? [body.campaignType === 'pmax' ? 'assetGroup' : 'demandGen'] : ['headline', 'body', 'linkUrl', ...(body.campaignType === 'search' ? ['additionalHeadlines', 'additionalDescriptions', 'keywords'] : ['businessName', 'images'])])] : ['headline', 'body', 'linkUrl', 'imageUrl', ...(meta ? ['video', 'carouselCards', 'callToAction', 'advantageAudience', 'promotedObject', 'leadGenFormId'] : platform === 'linkedin' ? ['video', 'callToAction', 'organizationId', 'leadGenFormId'] : platform === 'reddit' ? ['video', 'carouselCards', 'callToAction', 'promotedObject', 'creativeFormat'] : platform === 'pinterest' ? ['boardId'] : platform === 'openai' ? ['promotedObject', 'bidStrategy', 'bidAmount', 'tracking'] : platform === 'tiktok' ? ['promotedObject'] : [])];
  if (Object.keys(body).some(key => !common.includes(key) && !perNetwork.includes(key))) fail(400, 'UNSUPPORTED_AD_FIELD', 'Use the fields for this network and ad format.');
  if (google) {
    if (!['search', 'display', 'pmax', 'demand_gen'].includes(body.campaignType)) fail(400, 'UNSUPPORTED_AD_TYPE', 'Choose Search, Display, Performance Max, or Demand Gen.');
    result.campaignType = body.campaignType;
    if (advancedGoogle) { const key = body.campaignType === 'pmax' ? 'assetGroup' : 'demandGen'; result[key] = googleAssets(body[key], body.campaignType); return result; }
  }
  const headlineLimit = google ? 30 : ({ pinterest: 100, linkedin: 400, twitter: 70, openai: 50, reddit: 300 }[platform] || 255);
  if (platform !== 'tiktok') result.headline = text(body.headline, 'headline', headlineLimit);
  if (platform !== 'reddit' || body.creativeFormat === 'text' || body.body !== undefined && body.body !== '') result.body = text(body.body, 'ad text', google ? 90 : ({ pinterest: 500, twitter: 280, openai: 100, linkedin: 3000, tiktok: 100 }[platform] || 10000));
  if (platform === 'openai' && result.headline.length < 3) fail(400, 'INVALID_AD_COPY', 'ChatGPT ad titles need at least 3 characters.');
  const redditText = platform === 'reddit' && body.creativeFormat === 'text';
  if (body.creativeFormat !== undefined && !redditText) fail(400, 'UNSUPPORTED_AD_TYPE', 'Choose an available creative format.');
  if (redditText) { if (body.linkUrl !== undefined || body.callToAction !== undefined || body.goal === 'lead_generation') fail(400, 'UNSUPPORTED_AD_FIELD', 'Reddit text ads cannot link to a website or carry a button. Choose an image, video or carousel for website leads.'); }
  else if (body.goal !== 'lead_generation' || platform === 'reddit') result.linkUrl = mediaUrl(body.linkUrl);
  else { result.leadGenFormId = identifier(body.leadGenFormId, 'lead form ID'); if (body.linkUrl !== undefined) result.linkUrl = mediaUrl(body.linkUrl); }
  if (google) {
    if (body.campaignType === 'search') {
      result.additionalHeadlines = textList(body.additionalHeadlines, 'additional headlines', 2, 14, 30); result.additionalDescriptions = textList(body.additionalDescriptions, 'additional descriptions', 1, 3, 90); result.keywords = textList(body.keywords, 'keywords', 1, 1000, 80);
      if (new Set([result.headline, ...result.additionalHeadlines]).size !== result.additionalHeadlines.length + 1 || new Set([result.body, ...result.additionalDescriptions]).size !== result.additionalDescriptions.length + 1) fail(400, 'DUPLICATE_SEARCH_COPY', 'Each Search headline and description must be distinct.');
    } else { result.businessName = text(body.businessName, 'business name', 25); fields(body.images, ['landscape', 'square'], 'Display image'); result.images = { landscape: mediaUrl(body.images.landscape), square: mediaUrl(body.images.square) }; }
    return result;
  }
  const media = [body.imageUrl, body.video, body.carouselCards].filter(value => value !== undefined).length;
  if (media !== (redditText ? 0 : 1)) fail(400, 'INVALID_AD_MEDIA', 'Choose exactly one image, video, or carousel; text ads have no media.');
  if (body.imageUrl !== undefined) result.imageUrl = mediaUrl(body.imageUrl);
  if (body.video !== undefined) {
    fields(body.video, ['url', 'thumbnailUrl'], 'video'); result.video = { url: mediaUrl(body.video.url), ...(body.video.thumbnailUrl ? { thumbnailUrl: mediaUrl(body.video.thumbnailUrl) } : {}) };
    if (platform === 'reddit' && !result.video.thumbnailUrl) fail(400, 'INVALID_VIDEO', 'Reddit video ads need a thumbnail image.');
  }
  if (body.carouselCards !== undefined) {
    if (!Array.isArray(body.carouselCards) || body.carouselCards.length < 2 || body.carouselCards.length > 10) fail(400, 'INVALID_CAROUSEL', 'Use 2 to 10 carousel cards.');
    result.carouselCards = body.carouselCards.map(card => { fields(card, ['imageUrl', 'headline', 'description', 'linkUrl'], 'carousel card'); return { imageUrl: mediaUrl(card.imageUrl), headline: text(card.headline, 'card headline', 255), ...(card.description ? { description: text(card.description, 'card description', 255) } : {}), ...(card.linkUrl ? { linkUrl: mediaUrl(card.linkUrl) } : {}) }; });
  }
  if (body.goal === 'video_views' && !result.video && platform !== 'tiktok') fail(400, 'INVALID_VIDEO', 'The video views goal needs a video creative.');
  if (meta) {
    if (!['LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'CONTACT_US', 'DOWNLOAD', 'BOOK_NOW'].includes(body.callToAction)) fail(400, 'INVALID_CALL_TO_ACTION', 'Choose an available call-to-action button.');
    result.callToAction = body.callToAction; result.currency = nativeAccount.currency;
    if (body.advantageAudience !== undefined && ![0, 1].includes(body.advantageAudience)) fail(400, 'INVALID_AUDIENCE', 'The Advantage audience setting must be 0 or 1.');
    result.advantageAudience = body.advantageAudience ?? 0;
  } else if (['linkedin', 'reddit'].includes(platform) && body.callToAction !== undefined) { const ctas = platform === 'linkedin' ? ['LEARN_MORE', 'SIGN_UP', 'DOWNLOAD', 'SUBSCRIBE', 'REGISTER', 'JOIN', 'ATTEND', 'REQUEST_DEMO', 'VIEW_QUOTE', 'APPLY', 'SEE_MORE', 'SHOP_NOW', 'BUY_NOW'] : ['LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'CONTACT_US', 'DOWNLOAD', 'GET_QUOTE', 'SUBSCRIBE', 'APPLY_NOW', 'BOOK_NOW', 'BUY_TICKETS', 'DONATE_NOW', 'GET_DIRECTIONS', 'GET_SHOWTIMES', 'LISTEN_NOW', 'ORDER_NOW', 'SEE_MENU', 'INSTALL_MOBILE_APP']; if (!ctas.includes(body.callToAction)) fail(400, 'INVALID_CALL_TO_ACTION', 'Choose an available call-to-action button.'); result.callToAction = body.callToAction; }
  if (platform === 'linkedin' && body.organizationId !== undefined) { if (!/^(urn:li:organization:)?\d+$/.test(body.organizationId)) fail(400, 'INVALID_ORGANIZATION', 'Enter a numeric LinkedIn Company Page ID.'); result.organizationId = body.organizationId; }
  if (platform === 'pinterest' && body.boardId !== undefined) result.boardId = identifier(body.boardId, 'Pinterest board ID');
  if (body.promotedObject !== undefined && platform !== 'reddit') { fields(body.promotedObject, platform === 'openai' ? ['customEventType'] : ['pixelId', 'customEventType'], 'conversion'); result.promotedObject = Object.fromEntries(Object.entries(body.promotedObject).map(([key, item]) => [key, text(item, 'conversion event or pixel ID')])); }
  if (body.goal === 'conversions' && platform !== 'openai' && (!result.promotedObject?.pixelId || ((meta || platform === 'reddit') && !result.promotedObject.customEventType))) fail(400, 'CONVERSION_CONFIGURATION_REQUIRED', 'Conversion campaigns need a pixel ID and conversion event.');
  if (platform === 'openai') {
    if (result.promotedObject && body.goal !== 'conversions') fail(400, 'INVALID_AD_GOAL', 'Select the conversions goal to choose a conversion event.');
    if (body.bidStrategy !== undefined && !['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP'].includes(body.bidStrategy)) fail(400, 'INVALID_BIDDING', 'Choose automatic or capped bidding.');
    if (body.bidStrategy) result.bidStrategy = body.bidStrategy;
    const capped = ['LOWEST_COST_WITH_BID_CAP', 'COST_CAP'].includes(body.bidStrategy);
    if ((body.goal === 'awareness' || budgetType === 'lifetime') && !capped) fail(400, 'INVALID_BIDDING', 'ChatGPT awareness and lifetime campaigns require a fixed bid.');
    if (capped) result.bidAmount = adAmount(body.bidAmount, nativeAccount.currency); else if (body.bidAmount !== undefined) fail(400, 'INVALID_BIDDING', 'A bid amount requires capped bidding.');
    if (body.tracking !== undefined) {
      fields(body.tracking, ['urlTags'], 'tracking');
      if (!Array.isArray(body.tracking.urlTags) || !body.tracking.urlTags.length || body.tracking.urlTags.length > 50) fail(400, 'INVALID_TRACKING', 'Use 1 to 50 tracking parameters.');
      const keys = new Set();
      result.tracking = { urlTags: body.tracking.urlTags.map(tag => { fields(tag, ['key', 'value'], 'tracking parameter'); const key = text(tag.key, 'tracking key', 100); if (!/^[A-Za-z0-9_.-]+$/.test(key) || keys.has(key)) fail(400, 'INVALID_TRACKING', 'Tracking keys must be distinct URL parameter names.'); keys.add(key); return { key, value: text(tag.value, 'tracking value', 2000) }; }) };
    }
  }
  return result;
}

function assertCreatedAd(ad, platform, account, nativeAccount, profileId) {
  const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/\s/.test(value);
  const id = value => String(value?._id || value?.id || value);
  const networks = ['facebook', 'instagram'].includes(platform) ? ['facebook', 'instagram'] : [platform];
  if (!ad || !validId(ad._id) || !validId(ad.platformCampaignId) || !networks.includes(ad.platform) || ad.accountId !== undefined && id(ad.accountId) !== account._id || ad.profileId !== undefined && id(ad.profileId) !== profileId || ad.platformAdAccountId !== undefined && id(ad.platformAdAccountId) !== nativeAccount.id || ad.adAccountId !== undefined && id(ad.adAccountId) !== nativeAccount.id) throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not confirm the created ad’s network and account scope. Check the provider before repeating this request.', true);
}

async function scopedAds(api, profileId, query = {}) {
  const ads = []; let backfillPending = false;
  // ponytail: cap at 1,000 ads per view; use campaign filters or background sync for larger accounts.
  for (let page = 1; page <= 10; page++) {
    const result = await api('/ads', { profileId, source: 'all', page, limit: 100, ...query });
    if (!Array.isArray(result.ads)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return an ad list.');
    ads.push(...result.ads.filter(ad => String(ad.profileId?._id || ad.profileId) === profileId && (!query.campaignId || String(ad.platformCampaignId) === query.campaignId) && (!query.platform || ad.platform === query.platform))); backfillPending ||= Boolean(result.backfillPending);
    const pagination = result.pagination || {}, pages = pagination.pages ?? (pagination.total === undefined ? undefined : Math.ceil(pagination.total / 100));
    if ((pages !== undefined && page >= pages) || pagination.hasMore === false || (pages === undefined && pagination.hasMore !== true && result.ads.length < 100)) return { ads, complete: !backfillPending, backfillPending };
  }
  fail(503, 'INCOMPLETE_PROVIDER_DATA', 'There are too many ads for this view. Select a campaign first.');
}
async function scopedAd(api, profileId, id) {
  const result = await scopedAds(api, profileId);
  const ad = result.ads.find(item => item._id === id);
  if (!ad) fail(403, 'AD_OUTSIDE_PROJECT', 'This ad was not found in this project.');
  return ad;
}
const campaignKey = campaign => String(campaign.platformCampaignId || campaign.campaignId || campaign.id || campaign._id);
function saveCampaignSnapshot(context, profileId, platform, campaignId, data) {
  for (const campaign of context.store.list(context.project.id, 'campaigns')) {
    if (campaign.externalId && !campaign.nativeProvider && campaign.zernioProfileId === profileId && campaign.platform === platform && campaign.platformCampaignId === campaignId) context.store.update(context.project.id, 'campaigns', campaign.id, data);
  }
}
async function scopedCampaign(api, profileId, id, platform, dates = {}) {
  if (!AD_PLATFORMS.has(platform)) fail(400, 'INVALID_AD_PLATFORM', 'Choose a supported advertising platform.');
  const tree = await campaignTree(api, profileId, dates), matches = tree.campaigns.filter(item => campaignKey(item) === id && item.platform === platform), campaign = matches[0];
  if (matches.length > 1) fail(409, 'AMBIGUOUS_CAMPAIGN', 'More than one advertising account returned this campaign ID. Manage this campaign in its provider dashboard.');
  if (!campaign) fail(403, 'CAMPAIGN_OUTSIDE_PROJECT', 'This campaign is not in this project.');
  if (campaign.profileId !== undefined && String(campaign.profileId?._id || campaign.profileId) !== profileId) fail(403, 'CAMPAIGN_OUTSIDE_PROJECT', 'This campaign is not in this project.');
  return campaign;
}
const adSetTerminal = value => ['rejected', 'completed', 'cancelled', 'archived', 'deleted'].includes(String(value ?? '').toLowerCase());
const adSetReference = value => typeof value === 'string' ? value : reportObject(value) && typeof value._id === 'string' ? value._id : undefined;
async function campaignPreflight(context, api, profileId, campaignId, platform, expected) {
  const campaign = await scopedCampaign(api, profileId, campaignId, platform);
  if ([campaign.status, campaign.platformCampaignStatus].some(adSetTerminal)) fail(409, 'TERMINAL_AD_STATUS', 'This campaign cannot be edited.');
  const accountId = adSetReference(campaign.accountId), adAccountId = adSetReference(campaign.platformAdAccountId);
  if (!copyId(accountId) || !copyId(adAccountId)) fail(409, 'CAMPAIGN_SCOPE_UNAVAILABLE', 'The connected account and advertiser must be identified before changing this campaign.');
  const account = requireAccount(await scopedAccounts(api, profileId), accountId);
  if (!CREATE_CONNECTIONS[platform]?.includes(account.platform) || account.isActive !== true || account.needsReconnection === true) fail(409, 'ACCOUNT_UNAVAILABLE', 'Choose an active advertising connection before continuing.');
  const access = await adAccounts(api, accountId), advertisers = access.accounts.filter(row => copyId(row?.id) && copyAdvertiser(platform, row.id) === copyAdvertiser(platform, adAccountId));
  if (advertisers.length !== 1 || advertisers[0].selectable === false) fail(403, 'AD_ACCOUNT_OUTSIDE_PROJECT', 'This advertiser is not available through the project connection.');
  for (const row of [access, advertisers[0]]) for (const [field, value] of [['profileId', profileId], ['accountId', accountId], ['adAccountId', adAccountId], ['platformAdAccountId', adAccountId]]) if (Object.hasOwn(row, field) && (['adAccountId', 'platformAdAccountId'].includes(field) ? !copyId(adSetReference(row[field])) || copyAdvertiser(platform, adSetReference(row[field])) !== copyAdvertiser(platform, value) : adSetReference(row[field]) !== value)) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned access for another advertising account.');
  // The final tree read follows account/access awaits, so a reassigned campaign cannot use an earlier scope.
  const current = await scopedCampaign(api, profileId, campaignId, platform);
  if ([current.status, current.platformCampaignStatus].some(adSetTerminal)) fail(409, 'TERMINAL_AD_STATUS', 'This campaign cannot be edited.');
  const scope = { campaignId, platform, accountId, adAccountId }, same = value => value.accountId === accountId && value.adAccountId === adAccountId;
  if (adSetReference(current.accountId) !== accountId || adSetReference(current.platformAdAccountId) !== adAccountId || expected && !same(expected)) fail(409, 'CAMPAIGN_SCOPE_CHANGED', 'The advertising account changed. Refresh before continuing.');
  const freshAccount = requireAccount(await scopedAccounts(api, profileId), accountId);
  if (!CREATE_CONNECTIONS[platform]?.includes(freshAccount.platform) || freshAccount.isActive !== true || freshAccount.needsReconnection === true || ['_id', 'platform', 'platformUserId', 'platformId', 'isActive', 'needsReconnection'].some(field => (freshAccount[field] ?? null) !== (account[field] ?? null))) fail(409, 'ACCOUNT_UNAVAILABLE', 'The advertising connection changed. Refresh before continuing.');
  checkMapping(() => context.assertProjectMapping?.(profileId));
  return { ...scope, campaign: current, account: freshAccount, advertiser: advertisers[0] };
}
async function adSetPreflight(context, api, profileId, campaignId, platform, adSetId, expected) {
  const current = await campaignPreflight(context, api, profileId, campaignId, platform, expected), matches = Array.isArray(current.campaign.adSets) ? current.campaign.adSets.filter(row => row?.platformAdSetId === adSetId) : [];
  if (matches.length !== 1) fail(403, 'AD_SET_OUTSIDE_PROJECT', 'This ad set cannot be uniquely identified in the selected project campaign.');
  if ([matches[0].status, matches[0].platformAdSetStatus].some(adSetTerminal)) fail(409, 'TERMINAL_AD_STATUS', 'This ad set cannot be edited.');
  return { ...current, adSetId, adSet: matches[0] };
}
const budgetReviewSecret = randomUUID(), budgetReviewAge = 5 * 60 * 1000;
function budgetReviewVersion(snapshot, amount, expiresAt) {
  return createHash('sha256').update(canonical([budgetReviewSecret, snapshot.version, amount, expiresAt])).digest('hex');
}
function claimAdSetBudget(context, snapshot, key) {
  const { db, project } = context, resource = canonical(['meta-adset-budget', copyAdvertiser(snapshot.platform, snapshot.adAccountId), snapshot.adSetId]);
  db.exec('CREATE TABLE IF NOT EXISTS zernio_adset_budget_claims(resource TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL)');
  // The native advertiser/set is shared across Meta aliases, profile mappings and process restarts.
  transaction(db, () => {
    const previous = db.prepare('SELECT o.status FROM zernio_adset_budget_claims c LEFT JOIN integration_operations o ON o.project_id=c.project_id AND o.request_key=c.request_key WHERE c.resource=?').get(resource);
    if (previous && (!previous.status || ['pending', 'uncertain'].includes(previous.status))) fail(409, 'AD_SET_BUDGET_PREVIOUS_OUTCOME_UNRESOLVED', 'This budget change was not sent. Review the earlier provider budget outcome before changing this ad set again.');
    db.prepare('INSERT INTO zernio_adset_budget_claims(resource,project_id,request_key) VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET project_id=excluded.project_id,request_key=excluded.request_key').run(resource, project.id, key);
  });
}
async function liveMetaBudgets(api, before) {
  const campaigns = [], adSets = [], seen = new Set();
  let currency, readAt;
  const cursorText = value => typeof value === 'string' && value.length > 0 && value.length <= 4000 && !/[\u0000-\u001f\u007f]/u.test(value);
  async function page(query = {}) {
    const result = await api('/ads/accounts/live', { accountId: before.accountId, adAccountId: before.adAccountId, limit: 500, ...query });
    const time = validPostInstant(result?.readAt) ? Date.parse(result.readAt) : NaN;
    if (!reportObject(result) || result.accountId !== before.accountId || !copyId(result.adAccountId) || copyAdvertiser(before.platform, result.adAccountId) !== copyAdvertiser(before.platform, before.adAccountId) || result.platform !== 'facebook' || !['AED', 'USD'].includes(result.currency) || currency && result.currency !== currency || !Number.isFinite(time) || time > Date.now() + 30000 || Date.now() - time > 60000 || result.paging != null && !reportObject(result.paging)) fail(502, 'INVALID_LIVE_BUDGET_SCOPE', 'A current live budget and currency could not be verified for this advertiser.');
    currency = result.currency;
    if (!readAt || time < Date.parse(readAt)) readAt = result.readAt;
    for (const [level, rows] of [['campaigns', campaigns], ['adSets', adSets]]) {
      if (query.level && query.level !== (level === 'campaigns' ? 'campaign' : 'adSet')) continue;
      const values = result[level];
      if (!Array.isArray(values) || values.length > 500 || values.some(row => !reportObject(row) || !copyId(row[level === 'campaigns' ? 'platformCampaignId' : 'platformAdSetId']))) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable live advertising objects.');
      rows.push(...values);
    }
    for (const level of ['campaigns', 'adSets']) if (result.paging?.[level] != null && (!reportObject(result.paging[level]) || result.paging[level].after != null && !cursorText(result.paging[level].after))) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable live pagination.');
    return result.paging;
  }
  const paging = await page();
  for (const level of ['campaigns', 'adSets']) {
    let cursor = paging?.[level]?.after;
    // ponytail: cap live reads at 10,000 objects per level; larger advertisers must use the provider dashboard.
    for (let count = 1; cursor != null; count++) {
      if (!cursorText(cursor) || seen.has(level + ':' + cursor) || count >= 20) fail(503, 'INCOMPLETE_LIVE_BUDGET', 'The live budget list could not be read completely. Use the provider dashboard.');
      seen.add(level + ':' + cursor);
      const next = await page({ level: level === 'campaigns' ? 'campaign' : 'adSet', after: cursor }); cursor = next?.[level]?.after;
    }
  }
  if (new Set(campaigns.map(row => row.platformCampaignId)).size !== campaigns.length || new Set(adSets.map(row => row.platformAdSetId)).size !== adSets.length) fail(502, 'AMBIGUOUS_LIVE_BUDGET', 'Zernio returned duplicate live advertising identities.');
  return { campaigns, adSets, currency, readAt };
}
async function adSetBudgetSnapshot(context, api, profileId, campaignId, platform, adSetId, expected) {
  if (!['facebook', 'instagram'].includes(platform)) fail(422, 'AD_SET_BUDGET_UNSUPPORTED', 'Reviewed daily ad set budgets are available for Meta in AED or USD.');
  const before = await adSetPreflight(context, api, profileId, campaignId, platform, adSetId, expected), { campaigns, adSets, currency, readAt } = await liveMetaBudgets(api, before);
  const parents = campaigns.filter(row => row.platformCampaignId === campaignId), sets = adSets.filter(row => row.platformAdSetId === adSetId), parent = parents[0], set = sets[0];
  if (parents.length !== 1 || sets.length !== 1 || set.platformCampaignId !== campaignId) fail(403, 'AD_SET_OUTSIDE_PROJECT', 'The live ad set could not be identified under this campaign.');
  if ([parent.status, parent.configuredStatus, parent.platformCampaignStatus, set.status, set.configuredStatus, set.platformAdSetStatus].some(adSetTerminal)) fail(409, 'TERMINAL_AD_STATUS', 'This campaign or ad set cannot be edited.');
  const absent = value => value === null || value === 0;
  if (parent.budget !== null || !absent(parent.dailyBudget) || !absent(parent.lifetimeBudget) || !reportObject(set.budget) || set.budget.type !== 'daily' || set.budget.amount !== set.dailyBudget || !absent(set.lifetimeBudget) || typeof set.dailyBudget !== 'number' || !Number.isFinite(set.dailyBudget) || set.dailyBudget <= 0) fail(409, 'AD_SET_BUDGET_UNAVAILABLE', 'Only an existing ad set daily budget without a campaign or lifetime budget can be changed here.');
  const current = await adSetPreflight(context, api, profileId, campaignId, platform, adSetId, before);
  if (current.campaign.budgetLevel !== 'adset' || current.campaign.campaignBudget != null || current.campaign.currency !== currency || current.advertiser.currency !== currency || current.adSet.adSetBudget?.type === 'lifetime' || current.adSet.budget?.type === 'lifetime') fail(409, 'AD_SET_BUDGET_CHANGED', 'Budget ownership or currency changed. Review it again.');
  if (Date.now() - Date.parse(readAt) > 60000 || Date.parse(readAt) > Date.now() + 30000) fail(409, 'LIVE_BUDGET_EXPIRED', 'The live budget read expired during its scope checks. Load a fresh review.');
  const source = { campaignId, platform, adSetId, accountId: current.accountId, adAccountId: current.adAccountId, currency, currentAmount: set.dailyBudget, type: 'daily', budgetLevel: 'adset' };
  const connection = ['_id', 'platform', 'platformUserId', 'platformId', 'isActive', 'needsReconnection'].map(field => current.account[field] ?? null);
  const switches = [parent.configuredStatus, set.configuredStatus, parent.platformCampaignStatus, set.platformAdSetStatus].map(value => value ?? null);
  const version = createHash('sha256').update(canonical([context.project.id, profileId, source, connection, switches])).digest('hex');
  return { ...source, readAt, version };
}
async function campaignBudgetSnapshot(context, api, profileId, campaignId, platform, expected) {
  if (!['facebook', 'instagram'].includes(platform)) fail(422, 'CAMPAIGN_BUDGET_UNSUPPORTED', 'Reviewed daily campaign budgets are available for Meta in AED or USD.');
  const before = await campaignPreflight(context, api, profileId, campaignId, platform, expected), { campaigns, currency, readAt } = await liveMetaBudgets(api, before), matches = campaigns.filter(row => row.platformCampaignId === campaignId), parent = matches[0];
  if (matches.length !== 1) fail(403, 'CAMPAIGN_OUTSIDE_PROJECT', 'The live campaign could not be uniquely identified for this advertiser.');
  if ([parent.status, parent.configuredStatus, parent.platformCampaignStatus].some(adSetTerminal)) fail(409, 'TERMINAL_AD_STATUS', 'This campaign cannot be edited.');
  if (!reportObject(parent.budget) || parent.budget.type !== 'daily' || parent.budget.amount !== parent.dailyBudget || typeof parent.dailyBudget !== 'number' || !Number.isFinite(parent.dailyBudget) || parent.dailyBudget <= 0 || parent.lifetimeBudget !== null && parent.lifetimeBudget !== 0) fail(409, 'CAMPAIGN_BUDGET_UNAVAILABLE', 'Only an existing campaign-owned daily budget without a lifetime budget can be changed here.');
  const current = await campaignPreflight(context, api, profileId, campaignId, platform, before);
  if (current.campaign.currency !== currency || current.advertiser.currency !== currency) fail(409, 'CAMPAIGN_BUDGET_CHANGED', 'The advertising currency changed. Review it again.');
  if (Date.now() - Date.parse(readAt) > 60000 || Date.parse(readAt) > Date.now() + 30000) fail(409, 'LIVE_BUDGET_EXPIRED', 'The live budget read expired during its scope checks. Load a fresh review.');
  const source = { campaignId, platform, adSetId: null, accountId: current.accountId, adAccountId: current.adAccountId, currency, currentAmount: parent.dailyBudget, type: 'daily', budgetLevel: 'campaign' };
  const connection = ['_id', 'platform', 'platformUserId', 'platformId', 'isActive', 'needsReconnection'].map(field => current.account[field] ?? null);
  const version = createHash('sha256').update(canonical([context.project.id, profileId, source, connection, parent.configuredStatus ?? null, parent.platformCampaignStatus ?? null])).digest('hex');
  return { ...source, readAt, version };
}
function claimCampaignBudget(context, snapshot, key) {
  const { db, project } = context, resource = canonical(['meta-campaign-budget', copyAdvertiser(snapshot.platform, snapshot.adAccountId), snapshot.campaignId]);
  db.exec('CREATE TABLE IF NOT EXISTS zernio_campaign_budget_claims(resource TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL)');
  transaction(db, () => {
    const previous = db.prepare('SELECT o.status FROM zernio_campaign_budget_claims c LEFT JOIN integration_operations o ON o.project_id=c.project_id AND o.request_key=c.request_key WHERE c.resource=?').get(resource);
    if (previous && (!previous.status || ['pending', 'uncertain'].includes(previous.status))) fail(409, 'CAMPAIGN_BUDGET_PREVIOUS_OUTCOME_UNRESOLVED', 'This budget change was not sent. Review the earlier provider campaign budget outcome before changing this campaign again.');
    db.prepare('INSERT INTO zernio_campaign_budget_claims(resource,project_id,request_key) VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET project_id=excluded.project_id,request_key=excluded.request_key').run(resource, project.id, key);
  });
}
const copyPlatform = platform => ['facebook', 'instagram'].includes(platform) ? 'meta' : platform;
const copyId = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !['.', '..'].includes(value) && !/[\s\u0000-\u001f\u007f-\u009f/?#]/u.test(value);
const copyAdvertiser = (platform, value) => copyPlatform(platform) === 'meta' ? value.replace(/^act_(?=\d+$)/, '') : value;
function copyTables(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS zernio_campaign_copy_claims(resource TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS zernio_campaign_copy_receipts(project_id TEXT NOT NULL,request_key TEXT NOT NULL,profile_id TEXT NOT NULL,source_campaign_id TEXT NOT NULL,platform TEXT NOT NULL,account_id TEXT NOT NULL,native_advertiser_id TEXT NOT NULL,resource TEXT NOT NULL,copied_campaign_id TEXT,discovery TEXT,verification TEXT NOT NULL DEFAULT 'pending',status_read_at TEXT,PRIMARY KEY(project_id,request_key))`);
}
function copyReference(row) {
  const paused = row.operation_status === 'complete' && row.verification === 'paused' && copyId(row.copied_campaign_id) && row.copied_campaign_id !== row.source_campaign_id && validPostInstant(row.status_read_at);
  return { sourceCampaignId: row.source_campaign_id, platform: row.platform, copiedCampaignId: copyId(row.copied_campaign_id) && row.copied_campaign_id !== row.source_campaign_id ? row.copied_campaign_id : null, discovery: ['triggered', 'skipped', 'failed'].includes(row.discovery) ? row.discovery : null, requestedStatus: 'PAUSED', verification: paused ? 'paused' : 'pending', statusReadAt: paused ? row.status_read_at : null };
}
async function copySnapshot(context, api, profileId, campaignId, platform) {
  if (!['facebook', 'instagram', 'tiktok', 'linkedin'].includes(platform)) fail(422, 'CAMPAIGN_COPY_UNSUPPORTED', 'Paused campaign copying is available for Meta, TikTok and LinkedIn.');
  const campaign = await scopedCampaign(api, profileId, campaignId, platform), ref = value => value?._id || value;
  if (campaign.platformCampaignId !== campaignId) fail(409, 'CAMPAIGN_COPY_SCOPE_UNAVAILABLE', 'The native campaign ID must be identified before copying.');
  const accountId = ref(campaign.accountId), advertiserId = campaign.platformAdAccountId;
  if (!copyId(accountId) || !copyId(advertiserId)) fail(409, 'CAMPAIGN_COPY_SCOPE_UNAVAILABLE', 'The campaign’s connected account and native advertiser must be identified before copying.');
  const account = requireAccount(await scopedAccounts(api, profileId), accountId);
  if (!CREATE_CONNECTIONS[platform].includes(account.platform) || account.isActive !== true || account.needsReconnection === true) fail(409, 'ACCOUNT_UNAVAILABLE', 'Choose an active advertising connection before copying this campaign.');
  const access = await adAccounts(api, accountId), advertiser = access.accounts.filter(row => copyId(row?.id) && copyAdvertiser(platform, row.id) === copyAdvertiser(platform, advertiserId));
  if (advertiser.length !== 1 || advertiser[0].selectable === false) fail(403, 'AD_ACCOUNT_OUTSIDE_PROJECT', 'This campaign’s native advertising account is not available through this project connection.');
  for (const row of [access, advertiser[0]]) for (const [field, expected] of [['profileId', profileId], ['accountId', accountId], ['adAccountId', advertiserId], ['platformAdAccountId', advertiserId]]) if (Object.hasOwn(row, field) && (['adAccountId', 'platformAdAccountId'].includes(field) ? typeof ref(row[field]) !== 'string' || copyAdvertiser(platform, ref(row[field])) !== copyAdvertiser(platform, expected) : ref(row[field]) !== expected)) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned advertising access for a different campaign account.');
  const label = value => { if (value == null) return null; if (typeof value !== 'string' || value.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable campaign review details.'); return value; };
  const count = value => { if (value == null) return null; if (!Number.isSafeInteger(value) || value < 0) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable campaign counts.'); return value; };
  const budget = campaign.campaignBudget;
  if (budget != null && (!reportObject(budget) || typeof budget.amount !== 'number' || !Number.isFinite(budget.amount) || budget.amount < 0 || !['daily', 'lifetime'].includes(budget.type)) || campaign.budgetLevel != null && !['campaign', 'adset'].includes(campaign.budgetLevel) || campaign.currency != null && (typeof campaign.currency !== 'string' || !/^[A-Z]{3}$/.test(campaign.currency))) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable campaign budget details.');
  const source = { sourceCampaignId: campaignId, platform, accountId, adAccountId: advertiserId, name: label(campaign.campaignName ?? campaign.name), currency: campaign.currency ?? null, budgetLevel: campaign.budgetLevel ?? null, campaignBudget: budget == null ? null : { amount: budget.amount, type: budget.type }, adCount: count(campaign.adCount), adSetCount: count(campaign.adSetCount) };
  const connection = ['_id', 'platform', 'platformUserId', 'platformId', 'username', 'isActive', 'needsReconnection'].map(field => account[field] ?? null);
  const version = createHash('sha256').update(canonical([context.project.id, profileId, source, connection])).digest('hex');
  return { source, version, resource: canonical([copyPlatform(platform), copyAdvertiser(platform, advertiserId), campaignId]), account };
}
function copyState(context, snapshot, profileId) {
  const { db, project } = context;
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='integration_operations'").get()) return { previousCopy: null, unresolved: false, canCopy: true };
  const claim = db.prepare('SELECT o.status,r.copied_campaign_id FROM zernio_campaign_copy_claims c LEFT JOIN integration_operations o ON o.project_id=c.project_id AND o.request_key=c.request_key LEFT JOIN zernio_campaign_copy_receipts r ON r.project_id=c.project_id AND r.request_key=c.request_key WHERE c.resource=?').get(snapshot.resource);
  const unresolved = Boolean(claim && (!claim.status || ['pending', 'uncertain', 'reviewed-applied'].includes(claim.status)));
  const previous = db.prepare("SELECT r.*,o.status AS operation_status FROM zernio_campaign_copy_receipts r LEFT JOIN integration_operations o ON o.project_id=r.project_id AND o.request_key=r.request_key WHERE r.project_id=? AND r.profile_id=? AND r.resource=? AND (r.copied_campaign_id IS NOT NULL OR o.status IN ('pending','uncertain','reviewed-applied') OR o.status IS NULL) ORDER BY r.rowid DESC LIMIT 1").get(project.id, profileId, snapshot.resource);
  return { previousCopy: previous ? copyReference(previous) : null, unresolved, canCopy: !previous && !unresolved };
}
async function checkCampaignCopy(context, api, profileId, snapshot, row) {
  const result = await api('/ads/campaigns', { profileId, accountId: snapshot.source.accountId, adAccountId: snapshot.source.adAccountId, campaignId: row.copied_campaign_id, platform: row.platform, source: 'all', live: true, limit: 20, page: 1, ...(copyPlatform(row.platform) === 'meta' ? { includeEmpty: true } : {}) });
  if (!Array.isArray(result.campaigns) || result.campaigns.length > 1 || result.campaigns.some(row => !reportObject(row)) || result.pagination?.hasMore === true || result.pagination?.pages > 1 || result.pagination?.totalPages > 1) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return an unambiguous copied campaign.');
  const copy = result.campaigns[0];
  if (copy) {
    const ref = value => value?._id || value;
    if (copy.platformCampaignId !== row.copied_campaign_id || copyPlatform(copy.platform) !== copyPlatform(row.platform) || ref(copy.profileId) !== profileId || !copyId(copy.platformAdAccountId) || copyAdvertiser(row.platform, copy.platformAdAccountId) !== copyAdvertiser(row.platform, row.native_advertiser_id) || ref(copy.accountId) !== row.account_id) fail(502, 'INVALID_PROVIDER_SCOPE', 'The reported campaign could not be verified in the original advertising account.');
    const account = requireAccount(await scopedAccounts(api, profileId), ref(copy.accountId));
    if (!CREATE_CONNECTIONS[row.platform].includes(account.platform)) fail(502, 'INVALID_PROVIDER_SCOPE', 'The reported copy belongs to a different account platform.');
    const access = await adAccounts(api, account._id);
    if (access.accounts.filter(item => copyId(item?.id) && copyAdvertiser(row.platform, item.id) === copyAdvertiser(row.platform, row.native_advertiser_id) && item.selectable !== false).length !== 1) fail(403, 'AD_ACCOUNT_OUTSIDE_PROJECT', 'The reported copy’s advertiser is no longer available through this project.');
    if (copy.statusReadAt != null && !validPostInstant(copy.statusReadAt) || copy.platformCampaignStatus != null && (typeof copy.platformCampaignStatus !== 'string' || copy.platformCampaignStatus.length > 200 || /[\u0000-\u001f\u007f]/u.test(copy.platformCampaignStatus))) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable copied-campaign status details.');
  }
  const after = await copySnapshot(context, api, profileId, row.source_campaign_id, row.platform);
  if (after.resource !== snapshot.resource || after.version !== snapshot.version) fail(409, 'CAMPAIGN_COPY_SCOPE_CHANGED', 'The source campaign or advertiser changed while checking this copy. Refresh its review.');
  const operation = context.db.prepare('SELECT status FROM integration_operations WHERE project_id=? AND request_key=?').get(context.project.id, row.request_key);
  const paused = copy && operation?.status === 'complete' && row.platform !== 'linkedin' && validPostInstant(copy.statusReadAt) && copy.platformCampaignStatus === (row.platform === 'tiktok' ? 'DISABLE' : 'PAUSED');
  context.db.prepare('UPDATE zernio_campaign_copy_receipts SET verification=?,status_read_at=? WHERE project_id=? AND request_key=?').run(paused ? 'paused' : 'pending', paused ? copy.statusReadAt : null, context.project.id, row.request_key);
  return copyReference({ ...row, operation_status: operation?.status, verification: paused ? 'paused' : 'pending', status_read_at: paused ? copy.statusReadAt : null });
}
const rsaReviewAge = 5 * 60 * 1000;
function rsaCreativeReview(result, ad, profileId, now = Date.now()) {
  const remote = result.ad, scopeId = value => String(value?._id || value?.id || value);
  if (remote?._id !== ad._id || scopeId(remote.profileId) !== profileId || remote.platform !== 'google' || String(remote.advertisingChannelType).toLowerCase() !== 'search' || ['accountId', 'platformAdAccountId', 'platformCampaignId', 'platformAdSetId', 'platformAdId'].some(key => ad[key] != null && scopeId(remote[key]) !== scopeId(ad[key]))) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio did not confirm the selected Google Search ad’s scope.');
  const cached = result.cachedAt === null ? now : validPostInstant(result.cachedAt) ? Date.parse(result.cachedAt) : NaN;
  if (result.stale !== false || !Number.isFinite(cached) || cached > now + 30000 || now - cached > rsaReviewAge) return null;
  const creative = remote.creative, normalized = {};
  for (const [key, minimum, maximum, limit, pins] of [['headlines', 3, 15, 30, ['HEADLINE_1', 'HEADLINE_2', 'HEADLINE_3']], ['descriptions', 2, 4, 90, ['DESCRIPTION_1', 'DESCRIPTION_2']]]) {
    const rows = creative?.[key];
    if (!Array.isArray(rows) || rows.length < minimum || rows.length > maximum || rows.some(row => !reportObject(row) || typeof row.text !== 'string' || !row.text.trim() || row.text.length > limit || row.pinnedField != null && !pins.includes(row.pinnedField)) || new Set(rows.map(row => row.text)).size !== rows.length) return null;
    normalized[key] = rows.map(row => ({ text: row.text, ...(row.pinnedField ? { pinnedField: row.pinnedField } : {}) }));
  }
  if (!Array.isArray(creative.finalUrls) || !creative.finalUrls.length || creative.finalUrls.length > 10 || creative.finalUrls.some(value => typeof value !== 'string' || !value || value.length > 4000)) return null;
  normalized.finalUrls = creative.finalUrls;
  const version = createHash('sha256').update(canonical({ profileId, adId: ad._id, platformAdId: scopeId(remote.platformAdId), accountId: scopeId(remote.accountId), adAccountId: scopeId(remote.platformAdAccountId), campaignId: scopeId(remote.platformCampaignId), adSetId: scopeId(remote.platformAdSetId), creative: normalized })).digest('hex');
  return { version, observedAt: new Date(now).toISOString(), expiresAt: new Date(Math.min(now, cached) + rsaReviewAge).toISOString(), creative: normalized };
}
function reviewedRsaPayload(payload, review, expectedVersion, body) {
  if (!review || Date.parse(review.expiresAt) <= Date.now()) fail(409, 'GOOGLE_CREATIVE_NOT_CURRENT', 'Current Google Search text could not be verified. Refresh ad details before changing its creative.');
  if (expectedVersion !== review.version) fail(409, 'GOOGLE_CREATIVE_REVIEW_CHANGED', 'This Google Search creative changed since your review. Refresh ad details and review the current text and pinned positions.');
  const result = { ...payload };
  for (const key of ['headlines', 'descriptions']) if (payload[key]) {
    if (body[key].every(reportObject)) continue;
    const previous = review.creative[key];
    if (previous.some(row => row.pinnedField && !payload[key].some(item => item.text === row.text))) fail(409, 'GOOGLE_PINNED_TEXT_CHANGED', 'Keep existing pinned text when sending text-only lists. Use the text and position controls to replace or remove pinned entries.');
    result[key] = payload[key].map(row => { const pinnedField = previous.find(item => item.text === row.text)?.pinnedField; return { ...row, ...(pinnedField ? { pinnedField } : {}) }; });
  }
  return result;
}
function editableAd(body, ad) {
  fields(body, ['adId', 'name', 'creative', 'targeting', 'headlines', 'descriptions', 'finalUrls', 'assetGroup', 'demandGen', 'expectedCreativeVersion']);
  const platform = ad.platform, google = platform === 'google', channel = String(ad.advertisingChannelType || '').toLowerCase(), payload = {};
  if (body.expectedCreativeVersion !== undefined && !(google && channel === 'search')) fail(400, 'UNSUPPORTED_AD_FIELD', 'Creative review versions apply to Google Search ads.');
  if (['rejected', 'completed', 'cancelled', 'archived', 'deleted'].includes(ad.status)) fail(409, 'TERMINAL_AD_STATUS', 'This ad cannot be edited. Create a new ad.');
  if (platform === 'tiktok' && ad.isSmartPlus === true) fail(422, 'SMART_PLUS_EDIT_UNSUPPORTED', 'Change this TikTok Smart+ ad’s creative and audience in TikTok Ads Manager. Its delivery switch remains available here.');
  if (body.name !== undefined) { if (!['facebook', 'instagram'].includes(platform)) fail(422, 'UNSUPPORTED_AD_FIELD', 'Rename this ad in its provider dashboard.'); payload.name = text(body.name, 'ad name', 255); }
  if (body.targeting !== undefined) {
    if (['pinterest', 'twitter', 'openai'].includes(platform)) fail(422, 'UNSUPPORTED_AD_FIELD', 'This network requires audience changes in its provider dashboard.');
    if (platform === 'reddit') fail(422, 'UNSUPPORTED_AD_FIELD', 'Reddit replaces the entire audience; manage its audience in the provider dashboard.');
    payload.targeting = adTargeting(body.targeting, platform, channel, true);
    if (!Object.keys(payload.targeting).length) fail(400, 'INVALID_AUDIENCE', 'Choose at least one audience field to update.');
  }
  if (google) {
    if (body.assetGroup !== undefined || body.demandGen !== undefined) {
      const key = channel === 'performance_max' ? 'assetGroup' : channel === 'demand_gen' ? 'demandGen' : '';
      if (!key || body[key] === undefined || body[key === 'assetGroup' ? 'demandGen' : 'assetGroup'] !== undefined) fail(400, 'UNSUPPORTED_AD_FIELD', 'Use the asset fields for this Google campaign type.');
      payload[key] = googleAssetUpdate(body[key], key === 'assetGroup' ? 'pmax' : 'demand_gen');
    }
    if (body.headlines !== undefined || body.descriptions !== undefined || body.finalUrls !== undefined || body.creative !== undefined) {
      if (!['search', 'display'].includes(channel)) fail(400, 'UNSUPPORTED_AD_FIELD', 'Use the asset group fields for Performance Max or Demand Gen.');
      for (const key of ['headlines', 'descriptions']) if (body[key] !== undefined) {
        const structured = channel === 'search' && Array.isArray(body[key]) && body[key].some(row => typeof row === 'object');
        const entries = structured ? body[key].map(row => { fields(row, ['text', 'pinnedField'], key); return row.text; }) : body[key];
        payload[key] = textList(entries, key, channel === 'search' ? key === 'headlines' ? 3 : 2 : 1, channel === 'search' ? key === 'headlines' ? 15 : 4 : 5, key === 'headlines' ? 30 : 90).map((value, index) => {
          const pin = structured ? body[key][index].pinnedField : undefined;
          if (pin !== undefined && !(key === 'headlines' ? ['HEADLINE_1', 'HEADLINE_2', 'HEADLINE_3'] : ['DESCRIPTION_1', 'DESCRIPTION_2']).includes(pin)) fail(400, 'INVALID_AD_PIN', 'Choose an available pinned position for this text.');
          return { text: value, ...(pin ? { pinnedField: pin } : {}) };
        });
      }
      if (body.finalUrls !== undefined) payload.finalUrls = textList(body.finalUrls, 'destination websites', 1, 10, 4000).map(mediaUrl);
      if (body.creative !== undefined) { if (channel !== 'display') fail(400, 'UNSUPPORTED_AD_FIELD', 'Search edits use headlines, descriptions, and destination websites.'); fields(body.creative, ['longHeadline', 'businessName', 'imageUrl', 'squareImageUrl'], 'Display creative'); payload.creative = {}; for (const [key, value] of Object.entries(body.creative)) payload.creative[key] = key.endsWith('Url') ? mediaUrl(value) : text(value, key, key === 'businessName' ? 25 : 90); }
    }
  } else {
    if (['headlines', 'descriptions', 'finalUrls', 'assetGroup', 'demandGen'].some(key => body[key] !== undefined)) fail(400, 'UNSUPPORTED_AD_FIELD', 'Use the creative fields for this network.');
    if (body.creative !== undefined) {
      if (!['facebook', 'instagram', 'linkedin', 'tiktok'].includes(platform)) fail(422, 'UNSUPPORTED_AD_FIELD', 'Create a new ad to change this network’s creative.');
      fields(body.creative, ['body', 'linkUrl', ...(platform !== 'tiktok' ? ['headline', 'imageUrl', 'callToAction'] : []), 'videoUrl'], 'creative'); payload.creative = {};
      for (const [key, value] of Object.entries(body.creative)) payload.creative[key] = key.endsWith('Url') ? mediaUrl(value) : key === 'callToAction' ? text(value, 'call to action', 40) : text(value, key, key === 'headline' ? platform === 'linkedin' ? 400 : 255 : platform === 'tiktok' ? 100 : platform === 'linkedin' ? 3000 : 10000);
      if (payload.creative.imageUrl && payload.creative.videoUrl) fail(400, 'INVALID_AD_MEDIA', 'Choose one image or video.');
      if (platform === 'linkedin' && !payload.creative.imageUrl && !payload.creative.videoUrl) fail(400, 'INVALID_AD_MEDIA', 'LinkedIn creative changes need a new image or video.');
      if (payload.creative.callToAction && !['LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'CONTACT_US', 'DOWNLOAD', 'BOOK_NOW', 'REQUEST_DEMO', 'REGISTER'].includes(payload.creative.callToAction)) fail(400, 'INVALID_CALL_TO_ACTION', 'Choose an available button.');
    }
  }
  if (!Object.keys(payload).length || (payload.creative && !Object.keys(payload.creative).length)) fail(400, 'EMPTY_AD_UPDATE', 'Choose at least one field to update.');
  return payload;
}

export async function operation(context, action, resourceKey) {
  const { db, project, req, url, body } = context;
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send a unique Idempotency-Key header for this action.');
  const receiptOnly = url.searchParams.has('check');
  if (receiptOnly && (url.searchParams.getAll('check').length !== 1 || url.searchParams.get('check') !== '1' || [...url.searchParams.keys()].some(name => name !== 'check'))) fail(400, 'INVALID_OUTCOME_CHECK', 'Use the exact retained action to check its outcome.');
  db.exec(`CREATE TABLE IF NOT EXISTS integration_operations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL, response TEXT, http_status INTEGER, created_at TEXT NOT NULL, action_path TEXT NOT NULL DEFAULT '', run_id TEXT NOT NULL DEFAULT '', UNIQUE(project_id, request_key))`);
  const columns = new Set(db.prepare('PRAGMA table_info(integration_operations)').all().map(column => column.name));
  for (const name of ['action_path', 'run_id', 'resource_key']) if (!columns.has(name)) db.exec(`ALTER TABLE integration_operations ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
  db.exec('CREATE INDEX IF NOT EXISTS integration_operations_resource ON integration_operations(project_id,resource_key,status)');
  operation.active ||= new WeakMap(); operation.runId ||= randomUUID();
  if (!operation.active.has(db)) operation.active.set(db, new Set());
  const active = operation.active.get(db);
  const hash = createHash('sha256').update(canonical({ method: req.method, path: url.pathname, body })).digest('hex');
  const existing = db.prepare('SELECT * FROM integration_operations WHERE project_id = ? AND request_key = ?').get(project.id, key);
  if (existing) {
    if (existing.request_hash !== hash) fail(409, 'IDEMPOTENCY_CONFLICT', 'This action key belongs to a different request.');
    if (existing.status === 'uncertain' || existing.status === 'pending') fail(409, 'OPERATION_UNCERTAIN', 'The provider outcome needs reconciliation. This action cannot be retried automatically.');
    if (existing.status.startsWith('reviewed-')) return { status: 409, data: { operation: { id: existing.id, status: existing.status }, error: { code: 'OPERATION_REVIEWED', message: 'This action key is closed after an operator review. Reuse of this key cannot send another provider request.' } } };
    return { status: existing.http_status, data: JSON.parse(existing.response) };
  }
  if (receiptOnly) fail(409, 'OPERATION_OUTCOME_UNAVAILABLE', 'No matching local receipt was found. The original action is retained. Review the provider before explicitly preparing a new action.');
  const blockedHash = db.prepare("SELECT id FROM integration_operations WHERE project_id = ? AND request_hash = ? AND status IN ('pending', 'uncertain', 'reviewed-applied')").get(project.id, hash);
  // ponytail: one process owns this SQLite connection; use database resource locks before running multiple server processes.
  const resource = resourceKey ? canonical([project.id, resourceKey]) : null;

  const id = randomUUID();
  const known = new Set(['products', 'collections', 'rename', 'price', 'deactivate', 'activate', 'store', 'blogs', 'articles', 'create', 'google-conversions', 'actions', 'goals', 'custom-goals', 'remove', 'contacts', 'fields', 'bulk', 'subscription', 'link', 'unlink', 'set', 'clear', 'recycling', 'posts', 'apply', 'stop', 'review', 'leads', 'forms', 'import', 'archive', 'test-leads', 'whatsapp-templates', 'templates', 'library', 'connections', 'credentials', 'code', 'react', 'unreact', 'thread-control', 'accept','queues', 'preview', 'accounts', 'health', 'reconnect', 'disconnect', 'bluesky-settings', 'telegram-commands', 'slack-settings', 'discord-settings', 'webhook-subscription', 'measurement', 'tags', 'diagnostics', 'ad-accounts', 'admin', 'profile', 'groups','native-google-ads', 'microsoft-ads', 'shopping', 'cpc', 'keywords', 'keyword', 'bidding', 'negatives', 'google', 'planner', 'ideas', 'history', 'targeting', 'search-terms', 'reports', 'report', 'download', 'mapping', 'validate', 'budget', 'integrations', 'social', 'publish', 'schedule', 'cancel-schedule', 'update', 'cancel', 'retry', 'status', 'edit-published', 'update-metadata', 'unpublish', 'ads', 'copy', 'copy-review', 'copy-status', 'create', 'boost', 'ad-status', 'edit', 'adset', 'campaign', 'drive', 'upload', 'calendar', 'events', 'sync', 'connection', 'connect', 'openai-ads', 'ooh', 'bookings', 'submit', 'inbox', 'conversations', 'messages', 'comments', 'private-reply', 'webhook-settings', 'redeliver', 'test', 'thread', 'reviews', 'reply', 'read', 'hide', 'unhide', 'delete', 'like', 'unlike', 'moderate', 'delete-reply']);
  const actionPath = `${req.method} ${url.pathname.replace(/^\/api\/projects\/[^/]+/, '').split('/').map(part => !part || known.has(part) ? part : ':id').join('/')}`;
  const unresolved = resource && db.prepare("SELECT id,status FROM integration_operations WHERE project_id=? AND status IN ('pending','uncertain') AND (resource_key=? OR resource_key='')").get(project.id, resource);
  const blocked = blockedHash || unresolved || resource && active.has(resource);
  // A blocked key is terminal: a later outcome check must never turn into its first provider request.
  const notSent = blocked ? { status: 409, data: { operation: { id, status: 'failed' }, error: { code: 'OPERATION_NOT_SENT', message: 'No provider request was sent. An earlier action needs review or is still running. Resolve its outcome, then refresh and explicitly review a new action.' } } } : null;
  db.prepare('INSERT INTO integration_operations (id, project_id, request_key, request_hash, status, created_at, action_path, run_id, resource_key, response, http_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, project.id, key, hash, notSent ? 'failed' : 'pending', new Date().toISOString(), actionPath, operation.runId, resource || canonical([project.id, null]), notSent ? JSON.stringify(notSent.data) : null, notSent?.status ?? null);
  if (notSent) return notSent;
  active.add(id); if (resource) active.add(resource);
  try {
    let outcome;
    try { outcome = { status: 200, data: { operation: { id, status: 'complete' }, ...await action(key) } }; }
    catch (error) {
      const uncertain = !(error instanceof IntegrationError) || error.uncertain;
      outcome = { status: uncertain ? 409 : error.status, data: { operation: { id, status: uncertain ? 'uncertain' : 'failed' }, error: { code: uncertain ? 'OPERATION_UNCERTAIN' : error.code, message: uncertain ? 'The provider outcome needs reconciliation. Check the provider before making another attempt.' : error.message } } };
    }
    const updated = db.prepare("UPDATE integration_operations SET status = ?, response = ?, http_status = ? WHERE id = ? AND status = 'pending'").run(outcome.data.operation.status, JSON.stringify(outcome.data), outcome.status, id);
    if (!updated.changes) fail(409, 'OPERATION_REVIEWED', 'This action was closed by an operator review. Its review and original receipt were preserved.');
    return outcome;
  } finally { active.delete(id); if (resource) active.delete(resource); }
}
export function mediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail(400, 'INVALID_MEDIA', 'Media must have a public HTTPS delivery URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hostname.includes(':') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/i.test(url.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname) || /\.(local|internal)$/.test(url.hostname) || ['drive.google.com', 'docs.google.com'].includes(url.hostname)) fail(400, 'INVALID_MEDIA', 'Media needs a public HTTPS delivery URL. Private Drive preview links cannot be published.');
  return url.href;
}
async function postAssets(store, projectId, post) {
  normalizedVariants(post);
  const ids = [...new Set([post.assetId, ...Object.values(post.platformOverrides || {}).map(item => item?.assetId), ...Object.values(post.accountOverrides || {}).map(item => item?.assetId)].filter(Boolean))];
  if (ids.some(id => typeof id !== 'string' || id.length > 200)) fail(400, 'INVALID_ASSET', 'Choose a creative asset from this project.');
  const selected = await Promise.all(ids.map(async id => {
    const asset = await store.get(projectId, 'assets', id);
    if (!asset) fail(404, 'ASSET_NOT_FOUND', 'An attached asset was not found in this project.');
    if (sample(asset)) fail(400, 'SAMPLE_RECORD', 'Sample assets cannot be sent to live providers. Add your own asset.');
    return asset;
  }));
  return [...selected, ...store.list(projectId, 'assets').filter(asset => asset.deliverySource === 'zernio' && !ids.includes(asset.id))];
}
function normalizedVariants(post) {
  try {
    normalizePostTags(post.tags);
    if (post.content !== undefined && typeof post.content !== 'string') throw new TypeError('The shared caption must be text.');
    if (post.mediaItems !== undefined && post.mediaItems !== null) normalizeMediaItems(post.mediaItems);
    if (post.assetId !== undefined && (typeof post.assetId !== 'string' || post.assetId.length > 200)) throw new TypeError('Choose a creative asset from this project.');
    if (post.platforms !== undefined && (!Array.isArray(post.platforms) || post.platforms.some(platform => typeof platform !== 'string'))) throw new TypeError('Choose the post’s publishing platforms.');
    normalizeAccountVariants(post);
    return normalizePostVariants(post);
  } catch (error) { fail(400, 'INVALID_PLATFORM_OVERRIDES', error.message); }
}
function commonMedia(post, assets) { return resolveVariant({ ...post, platformOverrides: {} }, 'facebook', assets).mediaItems; }
function checkMediaUrls(items) {
  for (const item of items) {
    mediaUrl(item.url);
    for (const key of ['thumbnail', 'instagramThumbnail']) if (typeof item[key] === 'string') mediaUrl(item[key]);
    if (Array.isArray(item.subtitles)) for (const subtitle of item.subtitles) if (subtitle?.url) mediaUrl(subtitle.url);
  }
}
function postRestrictions(post, platforms, assets, targets, providerOwnedMediaUrls = new Set()) {
  const checks = targets?.length && Object.keys(post.accountOverrides || {}).length ? targets.map(target => {
    const accountId = String(target._id || target.accountId?._id || target.accountId), result = validatePostForPlatforms(post, [target.platform], { assets, accountId, providerOwnedMediaUrls });
    return { ...result, errors: result.errors.map(issue => ({ ...issue, accountId })), warnings: result.warnings.map(issue => ({ ...issue, accountId })), variants: Object.fromEntries(Object.entries(result.variants).map(([platform, variant]) => [accountId + ':' + platform, variant])) };
  }) : [validatePostForPlatforms(post, platforms, { assets, providerOwnedMediaUrls })];
  const result = { valid: checks.every(check => check.valid), errors: checks.flatMap(check => check.errors), warnings: checks.flatMap(check => check.warnings), variants: Object.assign({}, ...checks.map(check => check.variants)) };
  for (const variant of Object.values(result.variants)) checkMediaUrls(variant.mediaItems);
  return result;
}
function assertPostRestrictions(result) {
  if (!result.valid) fail(422, 'POST_RESTRICTIONS', result.errors.map(item => `${item.platform}: ${item.message}`).join(' ').slice(0, 4000));
}
export async function providerPostValidation(api, payload, { assets = [], providerOwnedMediaUrls = new Set() } = {}) {
  const expired = new Set(assets.filter(asset => assetDeliveryIssue(asset) && providerOwnedMediaUrls.has(asset.deliveryUrl)).map(asset => asset.deliveryUrl));
  const retained = payload.platforms.filter(target => [...(target.customMedia ?? payload.mediaItems ?? []), ...(target.platformSpecificData?.threadItems || []).flatMap(item => item.mediaItems || [])].some(item => expired.has(item.url)));
  const warnings = retained.map(target => ({ platform: target.platform, field: 'provider', message: 'Existing provider media was retained. Its temporary library link has expired; new media still needs a valid upload.' }));
  let result;
  // This account-aware check validates structure, not source URL availability; keep every retained destination.
  try { result = await api('/tools/validate/post', {}, payload); }
  catch (error) { if (error instanceof IntegrationError) error.uncertain = false; throw error; }
  const validRows = (rows, field) => rows === undefined || (Array.isArray(rows) && rows.length <= 200 && rows.every(item => item && typeof item.platform === 'string' && item.platform.length <= 100 && typeof item[field] === 'string' && item[field].length <= 10000));
  if (!result || typeof result.valid !== 'boolean' || !validRows(result.errors, 'error') || !validRows(result.warnings, 'warning') || (!result.valid && !result.errors?.length) || (result.valid && result.errors?.length)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return a valid post restriction check.');
  return { valid: result.valid, errors: (result.errors || []).map(item => ({ platform: item.platform, field: 'provider', message: item.error })), warnings: [...warnings, ...(result.warnings || []).map(item => ({ platform: item.platform, field: 'provider', message: item.warning }))] };
}
async function tiktokCreatorInfo(api, accountId, mediaType) {
  const result = await api(`/accounts/${encodeURIComponent(accountId)}/tiktok/creator-info`, { mediaType });
  const descriptors = result?.postingLimits?.interactionSettings;
  if (!result?.creator || typeof result.creator.canPostMore !== 'boolean' || !Array.isArray(result.privacyLevels) || result.privacyLevels.length > 20 || result.privacyLevels.some(item => typeof item?.value !== 'string' || item.value.length > 100 || typeof item.label !== 'string' || item.label.length > 200) || !descriptors || ['allow_comment', ...(mediaType === 'video' ? ['allow_duet', 'allow_stitch'] : [])].some(name => !descriptors[name] || typeof descriptors[name].enabled !== 'boolean' || typeof descriptors[name].required !== 'boolean')) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return valid TikTok creator posting permissions.');
  const max = result.postingLimits.maxVideoDurationSec;
  if (max !== undefined && (!Number.isSafeInteger(max) || max < 1 || max > 86400)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return a valid TikTok video duration limit.');
  return { creator: { nickname: String(result.creator.nickname || '').slice(0, 200), isVerified: result.creator.isVerified === true, canPostMore: result.creator.canPostMore }, privacyLevels: result.privacyLevels.map(item => ({ value: item.value, label: item.label })), postingLimits: { ...(max ? { maxVideoDurationSec: max } : {}), interactionSettings: Object.fromEntries(['allow_comment', 'allow_duet', 'allow_stitch'].map(name => [name, descriptors[name] ? { enabled: descriptors[name].enabled, required: descriptors[name].required, default: descriptors[name].default === true, label: String(descriptors[name].label || name).slice(0, 200) } : null])) } };
}
async function assertTikTokCreatorRestrictions(api, payload, mediaMetadata = []) {
  for (const target of payload.platforms.filter(item => item.platform === 'tiktok')) {
    const media = target.customMedia ?? payload.mediaItems ?? [], mediaType = media.some(item => item.type === 'video') ? 'video' : 'photo';
    const info = await tiktokCreatorInfo(api, target.accountId, mediaType), options = { ...target.platformSpecificData?.tiktokSettings, ...target.platformSpecificData };
    if (!info.creator.canPostMore) fail(422, 'TIKTOK_ACCOUNT_RESTRICTIONS', 'This TikTok account cannot publish more posts right now.');
    if (!options.draft) {
      if (!info.privacyLevels.some(level => level.value === (options.privacyLevel ?? options.privacy_level))) fail(422, 'TIKTOK_ACCOUNT_RESTRICTIONS', 'Choose a privacy level currently permitted by this TikTok account.');
      for (const [snake, camel] of [['allow_comment', 'allowComment'], ['allow_duet', 'allowDuet'], ['allow_stitch', 'allowStitch']]) {
        const descriptor = info.postingLimits.interactionSettings[snake], selected = options[camel] ?? options[snake];
        if (descriptor?.required && typeof selected !== 'boolean') fail(422, 'TIKTOK_ACCOUNT_RESTRICTIONS', 'Explicitly choose the TikTok comment, duet and stitch permissions shown for this account.');
        if (selected === true && (!descriptor || !descriptor.enabled)) fail(422, 'TIKTOK_ACCOUNT_RESTRICTIONS', 'A selected TikTok interaction is disabled by this account.');
      }
    }
    const limit = info.postingLimits.maxVideoDurationSec;
    if (limit && media.some(item => (mediaMetadata.find(meta => meta.url === item.url)?.duration || item.duration || 0) > limit)) fail(422, 'TIKTOK_ACCOUNT_RESTRICTIONS', `This TikTok account permits videos up to ${limit} seconds.`);
  }
}
function publishBody(post, accounts, assets = [], { validate = true } = {}) {
  if (sample(post)) fail(400, 'SAMPLE_RECORD', 'Sample posts cannot be sent to live providers. Create a new post.');
  const content = typeof post.content === 'string' ? post.content : '';
  if (content.length > 100000) fail(400, 'INVALID_CONTENT', 'Post content must be under 100,000 characters.');
  normalizedVariants(post);
  const requested = post.accounts;
  if (requested !== undefined && (!Array.isArray(requested) || requested.length === 0 || requested.length > 50 || requested.some(id => typeof id !== 'string'))) fail(400, 'INVALID_ACCOUNTS', 'Select one or more connected account IDs.');
  const platforms = post.platforms;
  if (!requested && (!Array.isArray(platforms) || !platforms.length)) fail(400, 'INVALID_PLATFORMS', 'Select a platform or connected account for this post.');
  const selected = requested ? [...new Set(requested)].map(id => requireAccount(accounts, id)) : accounts.filter(account => platforms.includes(account.platform));
  for (const [id, variant] of Object.entries(normalizeAccountVariants(post))) {
    const target = selected.find(account => account._id === id);
    if (!target || target.platform !== variant.platform) fail(400, 'ACCOUNT_VARIANT_MISMATCH', 'Every account customization must match a selected connected account and its platform.');
  }
  if (!selected.length || selected.some(account => account.isActive === false)) fail(400, 'ACCOUNT_UNAVAILABLE', 'A selected publishing account needs connection or reconnection.');
  if (Array.isArray(platforms) && platforms.length && selected.some(account => !platforms.includes(account.platform))) fail(400, 'ACCOUNT_PLATFORM_MISMATCH', 'Every selected account must belong to one of the post’s selected platforms.');
  if (selected.some(account => !SOCIAL_CONNECT.has(account.platform) && !['bluesky', 'telegram', 'snapchat'].includes(account.platform))) fail(400, 'INVALID_PUBLISHING_ACCOUNT', 'Choose a social publishing account, rather than an advertising connection.');
  const unavailable = selected.find(account => !PLATFORM_RULES[account.platform]?.supported);
  if (unavailable) fail(422, 'POST_RESTRICTIONS', PLATFORM_RULES[unavailable.platform]?.notice || 'This platform is unavailable for social posting.');
  const result = { content, platforms: selected.map(account => buildPlatformEntry(post, account.platform, account._id, assets)) };
  if (post.tags !== undefined && selected.some(account => account.platform === 'youtube')) result.tags = normalizePostTags(post.tags);
  if (post.mediaItems !== undefined || post.assetId) result.mediaItems = wireMediaItems(commonMedia(post, assets));
  const scheduledAt = post.scheduledAt || post.scheduledFor;
  if (scheduledAt && (typeof scheduledAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(scheduledAt) || Number.isNaN(Date.parse(scheduledAt)) || new Date(scheduledAt.slice(0, 10)).toISOString().slice(0, 10) !== scheduledAt.slice(0, 10))) fail(400, 'INVALID_DATE', 'Choose a valid scheduled time with a timezone.');
  if (post.status === 'scheduled' && !scheduledAt || scheduledAt && Date.parse(scheduledAt) <= Date.now()) fail(409, 'SCHEDULE_PASSED', 'This scheduled time has passed. Choose a new time before scheduling the post.');
  if (scheduledAt && Date.parse(scheduledAt) > Date.now()) { result.scheduledFor = new Date(scheduledAt).toISOString(); result.timezone = 'UTC'; }
  else result.publishNow = true;
  try { assertAccountSchedules(post, { publishNow: result.publishNow === true }); } catch (error) { fail(400, 'ACCOUNT_SCHEDULE_INVALID', error.message); }
  if (validate) assertPostRestrictions(postRestrictions(post, [...new Set(selected.map(account => account.platform))], assets, selected));
  return result;
}
function localStatus(status) {
  return ['published', 'failed', 'scheduled', 'draft', 'partial', 'cancelled'].includes(status) ? status : 'submitted';
}
function providerMediaItems(items) {
  const fields = new Set(['type', 'url', 'title', 'altText', 'filename', 'size', 'bytes', 'mimeType', 'thumbnail', 'instagramThumbnail', 'subtitles', 'width', 'height', 'duration']);
  return normalizeMediaItems(items.map(item => {
    if (!reportObject(item)) throw new TypeError('Invalid provider media item.');
    const value = Object.fromEntries(Object.entries(item).filter(([key]) => fields.has(key)));
    if (Array.isArray(value.subtitles)) value.subtitles = value.subtitles.map(track => reportObject(track) ? { url: track.url, language: track.language } : track);
    return value;
  }));
}
export const validProviderInstant = validPostInstant;
function assertPostResult(remote, profileId, { id, targets, uncertain = true } = {}) {
  const validText = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\s\u0000-\u001f]/.test(value);
  const reference = value => value?._id || value;
  const invalid = () => { throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not confirm the expected post and publishing accounts.', uncertain); };
  const optionalText = (value, max = 100000) => value == null || typeof value === 'string' && value.length <= max;
  const optionalDate = value => value == null || value === '' || validProviderInstant(value);
  const media = items => {
    if (items == null) return;
    // Provider responses may add fields; validate the media fields consumed by our editor without rejecting those additions.
    try { providerMediaItems(items); } catch { invalid(); }
  };
  const options = value => {
    if (value == null) return;
    if (!reportObject(value) || ['title', 'postType', 'mediaType', 'contentType', 'firstComment'].some(key => !optionalText(value[key]))) invalid();
    if (value.threadItems != null) {
      if (!Array.isArray(value.threadItems) || value.threadItems.length > 100) invalid();
      for (const item of value.threadItems) { if (!reportObject(item) || !optionalText(item.content)) invalid(); media(item.mediaItems); }
    }
    if (value.poll != null) {
      const poll = value.poll;
      if (!reportObject(poll) || poll.question != null && !(typeof poll.question === 'string' || reportObject(poll.question) && optionalText(poll.question.text))) invalid();
      if (poll.options != null && (!Array.isArray(poll.options) || poll.options.length > 100 || poll.options.some(item => typeof item !== 'string'))) invalid();
      if (poll.answers != null && (!Array.isArray(poll.answers) || poll.answers.length > 100 || poll.answers.some(item => !reportObject(item) || !reportObject(item.poll_media) || typeof item.poll_media.text !== 'string'))) invalid();
    }
  };
  if (!reportObject(remote) || !validText(remote._id) || id && remote._id !== id || !validText(remote.status) || remote.content !== undefined && typeof remote.content !== 'string' || remote.profileId !== undefined && reference(remote.profileId) !== profileId) invalid();
  if (!optionalDate(remote.scheduledFor) || !optionalDate(remote.publishedAt) || remote.isDraft !== undefined && typeof remote.isDraft !== 'boolean') invalid();
  if (Object.hasOwn(remote, 'tags')) try { normalizePostTags(remote.tags, { preserve: true }); } catch { invalid(); }
  media(remote.mediaItems);
  if (remote.platforms !== undefined) {
    if (!Array.isArray(remote.platforms) || !remote.platforms.length) invalid();
    for (const target of remote.platforms) {
      if (!reportObject(target) || !target.platform && !target.accountId || target.platform !== undefined && !validText(target.platform) || target.accountId !== undefined && !validText(reference(target.accountId)) || target.customContent !== undefined && typeof target.customContent !== 'string') invalid();
      if (!optionalText(target.status, 500) || !optionalText(target.platformPostUrl, 8192) || !optionalDate(target.scheduledFor) || ['errorMessage', 'errorCategory', 'errorSource'].some(key => !optionalText(target[key], 10000)) || target.error != null && !(typeof target.error === 'string' || reportObject(target.error) && optionalText(target.error.message, 10000))) invalid();
      if (reportObject(target.accountId) && ['displayName', 'username', 'name'].some(key => !optionalText(target.accountId[key], 1000))) invalid();
      if (target.platformSpecificData != null && !reportObject(target.platformSpecificData)) invalid();
      media(target.customMedia);
      try {
        const configuration = targetConfiguration(target); options(configuration.options);
        if (configuration.options) normalizePlatformOptions(target.platform, configuration.options);
      } catch { throw new IntegrationError(502, 'UNSUPPORTED_PROVIDER_OPTIONS', 'Zernio returned unsupported provider publishing options. Manage or reconcile this copy in the native dashboard before continuing.', uncertain); }
      // Zernio's minimal create receipt may omit accountId or platform. Check every identity it does return.
      if (targets && !targets.some(expected => (target.platform === undefined || target.platform === expected.platform) && (target.accountId === undefined || reference(target.accountId) === reference(expected.accountId)))) invalid();
    }
  }
}
export async function scopedPost(api, profileId, post, activeOnly = false, activeAccountId) {
  if (!post?.externalId || post.zernioProfileId !== profileId) fail(404, 'POST_NOT_SUBMITTED', 'No submitted post was found for this project.');
  if (post.providerDeletedAt) fail(409, 'POST_CANCELLED', 'This provider record was removed. Create a new draft to publish again.');
  const result = await api(`/posts/${encodeURIComponent(post.externalId)}`), accounts = await scopedAccounts(api, profileId);
  assertPostResult(result.post, profileId, { id: post.externalId, uncertain: false });
  if (!Array.isArray(result.post.platforms)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return the submitted post.');
  for (const item of result.post.platforms) {
    const account = requireAccount(accounts, String(item.accountId?._id || item.accountId));
    if (account.platform !== item.platform) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned a post with an inconsistent account platform.');
    if (activeOnly && (activeAccountId === undefined || account._id === activeAccountId) && account.isActive === false) fail(409, 'ACCOUNT_UNAVAILABLE', 'A selected publishing account needs reconnection before this post can be submitted.');
  }
  return result.post;
}
export function targetConfiguration(target) {
  let options = target.platformSpecificData;
  if (target.platform === 'tiktok' && options && typeof options === 'object') {
    const { isDraft, tiktokSettings, ...settings } = options;
    options = Object.fromEntries(Object.entries({ ...tiktokSettings, ...settings }).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
    if (isDraft === true) options.draft = true;
  }
  if (Array.isArray(options?.threadItems)) options = { ...options, threadItems: options.threadItems.map(item => reportObject(item) ? { ...item, ...(Array.isArray(item.mediaItems) ? { mediaItems: providerMediaItems(item.mediaItems) } : {}) } : item) };
  return { ...(typeof target.customContent === 'string' ? { content: target.customContent } : {}), ...(Array.isArray(target.customMedia) ? { mediaItems: providerMediaItems(target.customMedia) } : {}), ...(options && typeof options === 'object' ? { options } : {}) };
}
export async function remotePostModel(store, projectId, post, remote) {
  const assetIds = [...new Set([post.assetId, ...Object.values(post.platformOverrides || {}).map(item => item?.assetId), ...Object.values(post.accountOverrides || {}).map(item => item?.assetId)].filter(id => typeof id === 'string' && id))];
  const assets = (await Promise.all(assetIds.map(id => store.get(projectId, 'assets', id)))).filter(Boolean), platformOverrides = {}, accountOverrides = {};
  const reference = target => String(target.accountId?._id || target.accountId), ownTime = target => target.scheduledFor && Date.parse(target.scheduledFor) !== Date.parse(remote.scheduledFor) ? target.scheduledFor : '';
  for (const platform of new Set(remote.platforms.map(target => target.platform))) {
    const copies = remote.platforms.filter(target => target.platform === platform), first = targetConfiguration(copies[0]);
    const unchanged = copies.every(target => {
      try {
        const expected = buildPlatformEntry(post, platform, reference(target), assets), expectedTime = expected.scheduledFor || post.scheduledAt || post.scheduledFor || '', actualTime = target.scheduledFor || remote.scheduledFor || '';
        return canonical(targetConfiguration(expected)) === canonical(targetConfiguration(target)) && (expectedTime === actualTime || expectedTime && actualTime && Date.parse(expectedTime) === Date.parse(actualTime));
      } catch { return false; }
    });
    if (unchanged) {
      if (post.platformOverrides?.[platform]) platformOverrides[platform] = post.platformOverrides[platform];
      for (const target of copies) if (post.accountOverrides?.[reference(target)]) accountOverrides[reference(target)] = post.accountOverrides[reference(target)];
      continue;
    }
    const divergent = copies.some(target => canonical(targetConfiguration(target)) !== canonical(first) || ownTime(target) !== ownTime(copies[0]));
    const perAccount = divergent || copies.some(target => ownTime(target) || post.accountOverrides?.[reference(target)]);
    // Repeated destinations on one account cannot be represented by an account-keyed editor. Keep raw copies readable instead.
    if (perAccount && new Set(copies.map(reference)).size === copies.length) {
      for (const target of copies) {
        const id = reference(target), configuration = targetConfiguration(target), previous = post.accountOverrides?.[id] || post.platformOverrides?.[platform];
        let expected;
        try { expected = targetConfiguration(buildPlatformEntry(post, platform, id, assets)); } catch {}
        const copy = { platform, ...configuration };
        if (previous?.assetId && canonical(expected) === canonical(configuration)) { copy.assetId = previous.assetId; delete copy.mediaItems; }
        if (ownTime(target)) copy.scheduledAt = target.scheduledFor;
        else if (post.accountOverrides?.[id] && Object.hasOwn(post.accountOverrides[id], 'scheduledAt')) copy.scheduledAt = target.scheduledFor && Date.parse(target.scheduledFor) === Date.parse(post.accountOverrides[id].scheduledAt) ? target.scheduledFor : '';
        accountOverrides[id] = copy;
      }
      continue;
    }
    if (divergent || !Object.keys(first).length) continue;
    const previous = post.platformOverrides?.[platform];
    let expected;
    try { if (previous) expected = targetConfiguration(buildPlatformEntry({ ...post, accountOverrides: {} }, platform, '', assets)); } catch {}
    platformOverrides[platform] = previous && canonical(expected) === canonical(first) ? previous : first;
  }
  return { ...post, ...(Object.hasOwn(remote, 'tags') ? { tags: normalizePostTags(remote.tags, { preserve: true }) } : {}), ...(typeof remote.content === 'string' ? { content: remote.content } : {}), ...(Array.isArray(remote.mediaItems) ? { mediaItems: providerMediaItems(remote.mediaItems) } : {}), platforms: [...new Set(remote.platforms.map(target => target.platform))], accounts: remote.platforms.map(reference), platformOverrides, ...(Object.keys(accountOverrides).length || Object.hasOwn(post, 'accountOverrides') ? { accountOverrides } : {}), providerResults: redact(remote.platforms), scheduledAt: remote.status === 'draft' || remote.isDraft === true ? '' : remote.scheduledFor || '' };
}
export function remoteRestrictionPayload(post, remote, { content = remote.content ?? post.content, tags = remote.tags ?? post.tags, mediaItems = remote.mediaItems ?? post.mediaItems, overrides, accountOverrides, assets = [] } = {}) {
  const platforms = remote.platforms.map(target => {
    const base = { platform: target.platform, accountId: String(target.accountId?._id || target.accountId) };
    if (overrides !== undefined || accountOverrides !== undefined) {
      const entry = buildPlatformEntry({ ...post, content, mediaItems, platformOverrides: overrides ?? post.platformOverrides, accountOverrides: accountOverrides ?? post.accountOverrides }, target.platform, base.accountId, assets), namespace = target.platform === 'facebook' ? 'facebookSettings' : target.platform === 'tiktok' ? 'tiktokSettings' : null;
      if (namespace && target.platformSpecificData?.[namespace] && !Object.hasOwn(entry.platformSpecificData || {}, namespace)) entry.platformSpecificData = { ...entry.platformSpecificData, [namespace]: {} };
      return { ...entry, ...(accountOverrides === undefined && !entry.scheduledFor && target.scheduledFor ? { scheduledFor: target.scheduledFor } : {}) };
    }
    const configuration = targetConfiguration(target);
    return { ...base, ...(typeof configuration.content === 'string' ? { customContent: configuration.content } : {}), ...(configuration.mediaItems ? { customMedia: wireMediaItems(configuration.mediaItems) } : {}), ...(configuration.options ? { platformSpecificData: configuration.options } : {}), ...(target.scheduledFor ? { scheduledFor: target.scheduledFor } : {}) };
  });
  return { content: content || '', ...(tags !== undefined ? { tags: normalizePostTags(tags, { preserve: true }) } : {}), ...(mediaItems !== undefined ? { mediaItems: wireMediaItems(providerMediaItems(mediaItems)) } : {}), platforms };
}
export function validateRemotePayload(payload, assets = [], post = {}, providerOwnedMediaUrls = new Set()) {
  for (const target of payload.platforms) {
    const variant = resolveVariant(post, target.platform, assets, String(target.accountId?._id || target.accountId)), known = [...variant.mediaItems, ...commonMedia(post, assets), ...(variant.options.threadItems || []).flatMap(item => item.mediaItems || [])];
    const metadata = items => items.map(item => ({ ...known.find(existing => existing.type === item.type && existing.url === item.url), ...item }));
    const configuration = targetConfiguration(target);
    if (configuration.mediaItems) configuration.mediaItems = metadata(configuration.mediaItems);
    if (configuration.options?.threadItems) configuration.options = { ...configuration.options, threadItems: configuration.options.threadItems.map(item => ({ ...item, ...(item.mediaItems ? { mediaItems: metadata(item.mediaItems) } : {}) })) };
    const single = { content: payload.content, tags: payload.tags, mediaItems: metadata(payload.mediaItems || []), platformOverrides: { [target.platform]: configuration } };
    assertPostRestrictions(postRestrictions(single, [target.platform], assets, undefined, providerOwnedMediaUrls));
  }
}
export async function savePostSnapshot(store, projectId, post, remote, extra = {}, targets, source = post) {
  assertPostResult(remote, post.zernioProfileId, { id: post.externalId, targets });
  // Creation receipts can omit the submitted platform configuration; retain the draft until a full status read.
  const model = source.externalId && Array.isArray(remote.platforms) && remote.platforms.every(target => target.platform && target.accountId) ? await remotePostModel(store, projectId, post, remote) : {};
  const current = store.get(projectId, 'posts', post.id);
  if (current && canonical(current) !== canonical(source)) throw new IntegrationError(409, 'POST_CHANGED', 'The post changed during the provider request. Refresh it before continuing and review any unconfirmed provider action.', true);
  const updated = await store.update(projectId, 'posts', post.id, { ...model, ...(Object.hasOwn(remote, 'tags') ? { tags: normalizePostTags(remote.tags, { preserve: true }) } : {}), status: localStatus(remote.status), providerStatus: remote.status, ...(Array.isArray(remote.platforms) ? { providerResults: redact(remote.platforms) } : {}), ...(typeof remote.content === 'string' ? { content: remote.content } : {}), ...(remote.publishedAt ? { publishedAt: remote.publishedAt } : {}), ...extra });
  if (!updated) throw new IntegrationError(409, 'POST_REMOVED', 'The local post was removed while the provider accepted this action. Reconcile the provider outcome.', true);
  return updated;
}
async function driveToken(env, scope = 'https://www.googleapis.com/auth/drive') {
  const now = Math.floor(Date.now() / 1000);
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({ iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  let signature;
  try { signature = createSign('RSA-SHA256').update(unsigned).sign(env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), 'base64url'); }
  catch { fail(503, 'DRIVE_CONFIGURATION', 'The Google service account credentials need attention.'); }
  const result = await request('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString() }, 'Google Drive');
  if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 16384 || /[\s\u0000-\u001f]/.test(result.access_token)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Google Drive did not grant access.');
  return result.access_token;
}
function driveAsset(file) {
  const invalid = () => fail(502, 'INVALID_PROVIDER_RESPONSE', 'Google Drive returned invalid file metadata. No assets were changed.');
  if (!file || typeof file !== 'object' || typeof file.id !== 'string' || !/^[A-Za-z0-9_-]{1,200}$/.test(file.id) || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 1024 || /[\u0000-\u001f]/.test(file.name) || typeof file.mimeType !== 'string' || file.mimeType.length > 200 || !/^[\w.+-]+\/[\w.+-]+$/.test(file.mimeType)) invalid();
  const link = (value, fallback) => { if (value === undefined || value === null || value === '') return fallback; try { const url = new URL(value); if (typeof value !== 'string' || value.length > 4096 || url.protocol !== 'https:' || url.username || url.password) invalid(); return url.href; } catch { invalid(); } };
  const numeric = (value, positive = false) => { if (value === undefined || value === null) return null; if (!(typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < (positive ? 1 : 0)) invalid(); return Number(value); };
  const kind = file.mimeType.startsWith('image/') ? 'image' : file.mimeType.startsWith('video/') ? 'video' : 'document', metadata = kind === 'image' ? file.imageMediaMetadata : kind === 'video' ? file.videoMediaMetadata : undefined;
  if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))) invalid();
  if (file.modifiedTime != null && (typeof file.modifiedTime !== 'string' || file.modifiedTime.length > 100 || !Number.isFinite(Date.parse(file.modifiedTime)))) invalid();
  if (file.md5Checksum != null && (typeof file.md5Checksum !== 'string' || !/^[a-f0-9]{32}$/i.test(file.md5Checksum))) invalid();
  const milliseconds = kind === 'video' ? numeric(metadata?.durationMillis) : null;
  return { name: file.name, url: link(file.webViewLink, `https://drive.google.com/file/d/${file.id}/view`), thumbnailUrl: link(file.thumbnailLink, ''), kind, mimeType: file.mimeType, size: numeric(file.size), width: numeric(metadata?.width, true), height: numeric(metadata?.height, true), duration: milliseconds === null ? null : milliseconds / 1000, modifiedTime: file.modifiedTime || '', md5Checksum: file.md5Checksum || '', driveId: file.id, source: 'google-drive', tags: [], approval: 'pending' };
}

export { driveToken as googleToken, request as providerRequest, zernioClient, scopedAccounts, requireAccount };
function saveDriveFiles(db, store, projectId, files, assertMapping) {
  const normalized = [...new Map(files.map(driveAsset).filter(asset => asset.mimeType !== 'application/vnd.google-apps.folder').map(asset => [asset.driveId, asset])).values()];
  return transaction(db, () => {
    checkMapping(assertMapping);
    const assets = new Map(); for (const asset of store.list(projectId, 'assets')) if (asset.driveId && !assets.has(asset.driveId)) assets.set(asset.driveId, asset);
    return normalized.map(data => {
      const existing = assets.get(data.driveId), changed = existing && ['url', 'kind', 'size', 'mimeType', 'width', 'height', 'duration', 'modifiedTime', 'md5Checksum'].some(field => (existing[field] ?? null) !== (data[field] ?? null));
      const saved = existing ? store.update(projectId, 'assets', existing.id, { ...data, tags: existing.tags || [], approval: changed ? 'pending' : existing.approval || 'pending' }) : store.create(projectId, 'assets', data);
      assets.set(data.driveId, saved); return saved;
    });
  });
}

export async function handleIntegration(context) {
  const { req, url, body = {}, project, role, send, store, db } = context;
  const prefix = `/api/projects/${encodeURIComponent(project.id)}/integrations/`;
  if (!url.pathname.startsWith(prefix)) return false;
  const path = url.pathname.slice(prefix.length);
  const env = { ...(context.config?.env === undefined ? process.env : context.config.env), ...(context.config || {}) };
  try {
    if (path === 'inbox' || path.startsWith('inbox/')) fail(404, 'INTEGRATION_NOT_FOUND', 'This integration action was not found.');
    if (req.method === 'GET' && path === 'status') {
      send(200, { zernio: { configured: Boolean(env.ZERNIO_API_KEY), mapped: Boolean(project.zernioProfileId) }, drive: { configured: Boolean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY), mapped: Boolean(project.driveFolderId) } }); return true;
    }
    if (!['GET', 'POST'].includes(req.method) && !(req.method === 'PUT' && /^media\/uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/content$/i.test(path))) fail(405, 'METHOD_NOT_ALLOWED', 'This integration action does not support that method.');
    if (req.method === 'POST' && !WRITE_ROLES.has(role)) fail(403, 'WRITE_PERMISSION_REQUIRED', 'Editing permission is required for this action.');
    if (path.startsWith('drive/')) {
      if (!env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !env.GOOGLE_PRIVATE_KEY) fail(503, 'DRIVE_NOT_CONFIGURED', 'Configure a Google service account to connect Drive.');
      if (!project.driveFolderId || !/^[A-Za-z0-9_-]{5,200}$/.test(project.driveFolderId)) fail(409, 'DRIVE_NOT_MAPPED', 'Map a Drive folder to this project first.');
      const folderId = project.driveFolderId, assertDrive = () => context.assertDriveMapping?.(folderId);
      const driveRequest = (target, options) => request(target, options, 'Google Drive', assertDrive);
      if ((req.method === 'POST' && path === 'drive/sync') || (req.method === 'GET' && path === 'drive/files')) {
        const token = await driveToken(env); const files = []; let pageToken;
        for (let page = 0; page < 20; page++) {
          const target = new URL(`${GOOGLE}/drive/v3/files`);
          target.search = new URLSearchParams({ q: `'${project.driveFolderId}' in parents and trashed = false`, pageSize: '100', fields: 'kind,nextPageToken,incompleteSearch,files(id,name,mimeType,webViewLink,thumbnailLink,size,modifiedTime,md5Checksum,imageMediaMetadata(width,height),videoMediaMetadata(width,height,durationMillis))', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', ...(pageToken ? { pageToken } : {}) }).toString();
          const result = await driveRequest(target, { headers: { Authorization: `Bearer ${token}` } });
          const pageFiles = result.files === undefined && result.kind === 'drive#fileList' ? [] : result.files;
          if (!Array.isArray(pageFiles) || pageFiles.length > 100) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Google Drive did not return a valid file page.');
          if (result.incompleteSearch) fail(503, 'INCOMPLETE_PROVIDER_DATA', 'Google Drive could not complete the folder search. No assets were changed.');
          files.push(...pageFiles);
          if (!result.nextPageToken) {
            if (req.method === 'GET') send(200, { files: [...new Map(files.map(driveAsset).filter(asset => asset.mimeType !== 'application/vnd.google-apps.folder').map(asset => [asset.driveId, asset])).values()], complete: true });
            else { const assets = saveDriveFiles(context.db, store, project.id, files, assertDrive); store.activity(project.id, `Synced ${assets.length} assets from Google Drive.`); send(200, { assets, synced: assets.length, complete: true }); }
            return true;
          }
          if (result.nextPageToken === pageToken) break;
          pageToken = result.nextPageToken;
        }
        fail(503, 'INCOMPLETE_PROVIDER_DATA', 'This Drive folder exceeds the current sync limit. No assets were changed.');
      }
      if (req.method === 'POST' && path === 'drive/upload') {
        const name = text(body.name, 'filename', 200); const mimeType = text(body.mimeType, 'file type', 100);
        if (!MIME_TYPES.has(mimeType)) fail(400, 'UNSUPPORTED_FILE_TYPE', 'Choose a JPG, PNG, WebP, GIF, MP4, PDF, or text file.');
        if (typeof body.contentBase64 !== 'string' || !body.contentBase64 || body.contentBase64.length > 7 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.contentBase64)) fail(400, 'INVALID_FILE', 'Provide a valid file of at most 5 MB.');
        const bytes = Buffer.from(body.contentBase64, 'base64');
        if (bytes.length > 5 * 1024 * 1024) fail(413, 'FILE_TOO_LARGE', 'Files must be at most 5 MB.');
        const token = await driveToken(env);
        const folder = await driveRequest(`${GOOGLE}/drive/v3/files/${encodeURIComponent(project.driveFolderId)}?supportsAllDrives=true&fields=id,mimeType,driveId`, { headers: { Authorization: `Bearer ${token}` } });
        if (folder.id !== folderId || folder.mimeType !== 'application/vnd.google-apps.folder' || typeof folder.driveId !== 'string' || !folder.driveId) fail(409, 'SHARED_DRIVE_REQUIRED', 'Service account uploads require the mapped folder in a Google shared drive.');
        const outcome = await operation(context, async () => {
          const boundary = `ten98-${randomUUID()}`;
          const multipart = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [project.driveFolderId] })}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
          const file = await driveRequest(`${GOOGLE}/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,webViewLink,thumbnailLink,size,modifiedTime,md5Checksum,imageMediaMetadata(width,height),videoMediaMetadata(width,height,durationMillis)`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
          if (!file.id || file.mimeType === 'application/vnd.google-apps.folder') throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', 'Google Drive did not confirm the uploaded file.', true);
          let asset;
          try { [asset] = saveDriveFiles(context.db, store, project.id, [file], assertDrive); }
          catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
          return { asset };
        }); send(outcome.status, outcome.data); return true;
      }
      fail(404, 'INTEGRATION_NOT_FOUND', 'This Drive action was not found.');
    }
    if (!env.ZERNIO_API_KEY) fail(503, 'ZERNIO_NOT_CONFIGURED', 'Configure a Zernio API key to connect providers.');
    if (!project.zernioProfileId) fail(409, 'ZERNIO_NOT_MAPPED', 'Map a Zernio profile to this project first.');
    const profileId = String(project.zernioProfileId); const api = zernioClient(env.ZERNIO_API_KEY, () => context.assertProjectMapping?.(profileId));
    if ((path === 'media/uploads' || path.startsWith('media/uploads/')) && await handleZernioMedia(context, api, profileId, path.slice('media/uploads'.length).replace(/^\//, ''))) return true;
    if ((path === 'ads/events' || path.startsWith('ads/events/')) && await handleZernioAdEvents(context, api, profileId, path.slice('ads/events'.length).replace(/^\//, ''))) return true;
    if (path.startsWith('google-conversions/') && await handleGoogleConversions(context, api, profileId, path.slice('google-conversions/'.length))) return true;
    if ((path === 'contacts' || path.startsWith('contacts/')) && await handleZernioContacts(context, api, profileId, path.slice('contacts'.length).replace(/^\//, ''))) return true;
    if (path.startsWith('blogs/') && await handleZernioBlogs(context, api, profileId, path.slice('blogs/'.length))) return true;
    if (path.startsWith('products/') && await handleZernioProducts(context, api, profileId, path.slice('products/'.length))) return true;
    if (path.startsWith('connections/') && await handleZernioConnections(context, api, profileId, path.slice('connections/'.length))) return true;
    if (path.startsWith('insights/') && await handleZernioInsights(context, api, profileId, path.slice('insights/'.length))) return true;
    if ((path === 'leads' || path.startsWith('leads/')) && await handleZernioLeads(context, api, profileId, path.slice('leads'.length).replace(/^\//, ''))) return true;
    if ((path === 'whatsapp-templates' || path.startsWith('whatsapp-templates/')) && await handleZernioWhatsAppTemplates(context, api, profileId, path.slice('whatsapp-templates'.length).replace(/^\//, ''))) return true;
    if ((path === 'recycling' || path.startsWith('recycling/')) && await handleZernioRecycling(context, api, profileId, path.slice('recycling'.length).replace(/^\//, ''))) return true;
    if (path.startsWith('measurement/') && await handleZernioMeasurement(context, api, profileId, path.slice('measurement/'.length))) return true;
    if ((path === 'webhook-settings' || path.startsWith('webhook-settings/')) && await handleWebhookSettings(context, api, profileId, path.slice('webhook-settings'.length).replace(/^\//, ''))) return true;
    if (path.startsWith('admin/') && await handleZernioAdmin(context, api, profileId, path.slice('admin/'.length))) return true;
    if (path.startsWith('publishing/') && await handleZernioPublishing(context, api, profileId, path.slice('publishing/'.length))) return true;
    if ((path === 'queues' || path.startsWith('queues/')) && await handleZernioQueues(context, api, profileId, path.slice('queues'.length).replace(/^\//, ''))) return true;
    if (path.startsWith('accounts/')) { if (await handleZernioAccounts(context, api, profileId, path.slice('accounts/'.length))) return true; }
    if (req.method === 'POST' && path === 'connect/openai-ads') {
      if (!['owner', 'admin'].includes(role)) fail(403, 'ADMIN_PERMISSION_REQUIRED', 'Only a workspace administrator can connect provider accounts.');
      fields(body, ['apiKey'], 'connection'); const apiKey = identifier(body.apiKey, 'ChatGPT Ads Manager API key');
      const outcome = await operation(context, async key => {
        const result = await api('/connect/openai-ads/credentials', {}, { apiKey, profileId }, key);
        const account = (await scopedAccounts(api, profileId)).find(item => item._id === result.accountId && item.platform === 'openaiads' && item.isActive !== false);
        if (!account) throw new IntegrationError(502, 'CONNECTION_NOT_CONFIRMED', 'The connection could not be verified in this project. Refresh accounts before retrying.', true);
        return { accountId: account._id, adAccountName: typeof result.adAccountName === 'string' ? result.adAccountName.slice(0, 200) : 'ChatGPT Ads' };
      }); send(outcome.status, outcome.data); return true;
    }
    if (path.startsWith('ads/google/')) return await handleGoogleAds(context, api, profileId, path.slice('ads/google/'.length));
    if (req.method === 'GET' && path === 'connect') {
      if (!['owner', 'admin'].includes(role)) fail(403, 'ADMIN_PERMISSION_REQUIRED', 'Only a workspace administrator can connect provider accounts.');
      const platform = url.searchParams.get('platform'); const kind = url.searchParams.get('kind') || 'social';
      if (!['social', 'ads'].includes(kind)) fail(400, 'INVALID_CONNECTION_KIND', 'Choose a social or advertising connection.');
      if (platform === 'snapchat') fail(422, 'PLATFORM_UNAVAILABLE', PLATFORM_RULES.snapchat.notice);
      if (!(kind === 'ads' ? ADS_CONNECT : SOCIAL_CONNECT).has(platform)) fail(422, 'CONNECTION_REQUIRES_ZERNIO', 'This network uses a credential flow or is unavailable. Connect it in the Zernio dashboard, then refresh accounts.');
      const loginMethod = url.searchParams.get('loginMethod');
      if (url.searchParams.has('loginMethod') && (kind !== 'social' || platform !== 'instagram' || url.searchParams.getAll('loginMethod').length !== 1 || !['instagram_login', 'facebook_login'].includes(loginMethod))) fail(400, 'INVALID_INSTAGRAM_LOGIN_METHOD', 'Choose Instagram Login or Facebook Login for an Instagram social connection.');
      let accountId = url.searchParams.get('accountId');
      if (kind === 'ads' && platform === 'twitter') {
        const accounts = await scopedAccounts(api, profileId);
        if (!accountId) { const posting = accounts.filter(item => item.platform === 'twitter' && item.isActive !== false); if (posting.length === 1) accountId = posting[0]._id; }
        if (!accountId) fail(400, 'POSTING_ACCOUNT_REQUIRED', 'Choose an existing connected X posting account before connecting X Ads.');
        if (requireAccount(accounts, identifier(accountId, 'account ID')).platform !== 'twitter') fail(400, 'POSTING_ACCOUNT_REQUIRED', 'X Ads requires an X social posting account.');
      } else if (accountId) requireAccount(await scopedAccounts(api, profileId), identifier(accountId, 'account ID'));
      const origin = new URL(context.config?.appUrl || env.APP_URL || 'http://127.0.0.1:3000');
      if (origin.username || origin.password || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) fail(503, 'INVALID_CALLBACK', 'Configure a valid app origin before connecting providers.');
      const callback = new URL('/', origin); callback.search = new URLSearchParams({ view: 'integrations', project: project.id }).toString();
      const connectionPlatform = kind === 'ads' ? ({ google: 'googleads', reddit: 'redditads' }[platform] || platform) : platform;
      const result = await api(`/connect/${connectionPlatform}${kind === 'ads' ? '/ads' : ''}`, { profileId, redirect_url: callback.href, ...(accountId ? { accountId } : {}), ...(loginMethod ? { loginMethod } : {}) });
      if (result.alreadyConnected === true) {
        const expectedPlatform = kind === 'ads' ? CREATE_CONNECTIONS[platform]?.[0] : platform;
        const account = (await scopedAccounts(api, profileId)).find(item => item._id === result.accountId && item.platform === expectedPlatform && item.isActive !== false);
        if (!account) fail(502, 'CONNECTION_NOT_CONFIRMED', 'The connected account could not be verified in this project. Refresh accounts before retrying.');
        send(200, { alreadyConnected: true, accountId: account._id }); return true;
      }
      let authUrl;
      try { authUrl = new URL(result.authUrl); } catch { fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return a connection URL.'); }
      if (authUrl.protocol !== 'https:' || authUrl.username || authUrl.password) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned an invalid connection URL.');
      send(200, { authUrl: authUrl.href }); return true;
    }
    if (req.method === 'GET' && path === 'accounts') {
      const accounts = await scopedAccounts(api, profileId);
      send(200, { accounts: accounts.map(account => ({ _id: account._id, platform: account.platform, username: account.username, displayName: account.displayName, profileId, isActive: account.isActive, avatar: account.avatar, ...(account.platform === 'instagram' ? { metadata: { loginMethod: account.metadata?.loginMethod === 'facebook_login' ? 'facebook_login' : 'instagram_login' } } : {}) })) }); return true;
    }
    if (req.method === 'GET' && path === 'ads') { send(200, await campaignTree(api, profileId, dateQuery(url))); return true; }
    if (req.method === 'GET' && path === 'ads/campaign-discovery') {
      if ([...url.searchParams.keys()].some(field => !['accountId', 'adAccountId'].includes(field) || url.searchParams.getAll(field).length !== 1)) fail(400, 'INVALID_CAMPAIGN_DISCOVERY', 'Choose one project connection and advertiser.');
      const accountId = identifier(url.searchParams.get('accountId'), 'account ID'), adAccountId = identifier(url.searchParams.get('adAccountId'), 'advertiser ID');
      send(200, await discoverMetaCampaigns(context, api, profileId, accountId, adAccountId)); return true;
    }
    if (req.method === 'GET' && path === 'ads/accounts') {
      const accountId = identifier(url.searchParams.get('accountId'), 'account ID');
      requireAccount(await scopedAccounts(api, profileId), accountId);
      const result = await adAccounts(api, accountId);
      send(200, { accounts: result.accounts.map(item => ({ id: item.id, name: item.name, currency: item.currency, status: item.status, selectable: item.selectable, minimumDailyBudget: item.minimumDailyBudget })), cachedAt: result.cachedAt, stale: Boolean(result.stale) }); return true;
    }
    if (req.method === 'GET' && ['ads/adset-budget-review', 'ads/campaign-budget-review'].includes(path)) {
      const adSetReview = path === 'ads/adset-budget-review', allowed = ['campaignId', 'platform', 'amount', 'currency', ...(adSetReview ? ['adSetId'] : [])];
      if ([...url.searchParams.keys()].some(field => !allowed.includes(field) || url.searchParams.getAll(field).length !== 1)) fail(400, 'INVALID_BUDGET_REVIEW', 'Review one ad set and proposed daily budget.');
      const campaignId = identifier(url.searchParams.get('campaignId'), 'campaign ID'), adSetId = adSetReview ? identifier(url.searchParams.get('adSetId'), 'ad set ID') : null, platform = url.searchParams.get('platform'), currency = url.searchParams.get('currency');
      const proposedAmount = adAmount(Number(url.searchParams.get('amount')), currency), snapshot = adSetReview ? await adSetBudgetSnapshot(context, api, profileId, campaignId, platform, adSetId) : await campaignBudgetSnapshot(context, api, profileId, campaignId, platform);
      if (currency !== snapshot.currency) fail(409, 'CURRENCY_MISMATCH', 'Use the current advertising account currency.');
      if (proposedAmount === snapshot.currentAmount) fail(400, 'EMPTY_AD_UPDATE', 'Choose a different daily budget.');
      const expiresAt = new Date(Date.now() + budgetReviewAge).toISOString();
      send(200, { budgetReview: { ...snapshot, proposedAmount, expiresAt, version: budgetReviewVersion(snapshot, proposedAmount, expiresAt) } }); return true;
    }
    if (['ads/copy-review', 'ads/copy-status'].includes(path) && req.method === 'GET') {
      const status = path === 'ads/copy-status', allowed = ['campaignId', 'platform', ...(status ? ['copiedCampaignId'] : [])];
      if ([...url.searchParams.keys()].some(field => !allowed.includes(field) || url.searchParams.getAll(field).length !== 1)) fail(400, 'INVALID_CAMPAIGN_COPY_FILTER', 'Choose one campaign and platform for this copy review.');
      const campaignId = identifier(url.searchParams.get('campaignId'), 'campaign ID'), platform = url.searchParams.get('platform');
      if (!copyId(campaignId)) fail(400, 'INVALID_INPUT', 'Choose a valid campaign ID.');
      copyTables(db);
      const snapshot = await copySnapshot(context, api, profileId, campaignId, platform);
      if (status) {
        const copiedId = url.searchParams.get('copiedCampaignId');
        if (!copyId(copiedId) || copiedId === campaignId) fail(400, 'INVALID_INPUT', 'Choose a reported copied campaign ID.');
        const row = db.prepare('SELECT r.* FROM zernio_campaign_copy_receipts r WHERE r.project_id=? AND r.profile_id=? AND r.resource=? AND r.source_campaign_id=? AND r.platform=? AND r.copied_campaign_id=? ORDER BY r.rowid DESC LIMIT 1').get(project.id, profileId, snapshot.resource, campaignId, platform, copiedId);
        if (!row) fail(404, 'CAMPAIGN_COPY_NOT_REPORTED', 'This project has no reported copy with that campaign reference.');
        send(200, { campaignCopy: await checkCampaignCopy(context, api, profileId, snapshot, row) }); return true;
      }
      const current = await copySnapshot(context, api, profileId, campaignId, platform);
      if (current.version !== snapshot.version || current.resource !== snapshot.resource) fail(409, 'CAMPAIGN_COPY_REVIEW_CHANGED', 'The campaign changed while preparing its review. Refresh before copying.');
      send(200, { source: current.source, version: current.version, ...copyState(context, current, profileId) }); return true;
    }
    if (req.method === 'POST' && path === 'ads/copy') {
      fields(body, ['campaignId', 'platform', 'version', 'confirmDuplicate'], 'campaign copy');
      if (url.search || body.confirmDuplicate !== true || typeof body.version !== 'string' || !/^[a-f0-9]{64}$/.test(body.version) || !copyId(body.campaignId)) fail(400, 'CAMPAIGN_COPY_REVIEW_REQUIRED', 'Review the current campaign and confirm its paused copy.');
      copyTables(db);
      const snapshot = await copySnapshot(context, api, profileId, body.campaignId, body.platform), requestKey = req.headers['idempotency-key'];
      const prior = typeof requestKey === 'string' ? db.prepare('SELECT * FROM zernio_campaign_copy_receipts WHERE project_id=? AND request_key=?').get(project.id, requestKey) : null;
      if (prior && (prior.profile_id !== profileId || prior.resource !== snapshot.resource || prior.platform !== body.platform || prior.source_campaign_id !== body.campaignId)) fail(409, 'CAMPAIGN_COPY_SCOPE_CHANGED', 'This action belongs to an earlier campaign connection. Check its provider outcome.');
      const outcome = await operation(context, async key => {
        const current = await copySnapshot(context, api, profileId, body.campaignId, body.platform);
        if (current.version !== body.version || current.version !== snapshot.version || current.resource !== snapshot.resource) fail(409, 'CAMPAIGN_COPY_REVIEW_CHANGED', 'The campaign or advertising connection changed since your review. Refresh before copying.');
        checkMapping(() => context.assertProjectMapping?.(profileId));
        transaction(db, () => {
          if (!copyState(context, current, profileId).canCopy) fail(409, 'CAMPAIGN_COPY_ALREADY_REPORTED', 'Check the previous copy or resolve its provider outcome before copying again.');
          db.prepare('INSERT INTO zernio_campaign_copy_claims(resource,project_id,request_key) VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET project_id=excluded.project_id,request_key=excluded.request_key').run(current.resource, project.id, key);
          db.prepare('INSERT INTO zernio_campaign_copy_receipts(project_id,request_key,profile_id,source_campaign_id,platform,account_id,native_advertiser_id,resource) VALUES(?,?,?,?,?,?,?,?)').run(project.id, key, profileId, body.campaignId, body.platform, current.source.accountId, current.source.adAccountId, current.resource);
        });
        // ponytail: one copy per source/project until an explicit per-copy intent can safely follow verified completion.
        const observeReceipt = result => {
          if (copyId(result?.copiedCampaignId) && result.copiedCampaignId !== body.campaignId) db.prepare('UPDATE zernio_campaign_copy_receipts SET copied_campaign_id=?,discovery=? WHERE project_id=? AND request_key=?').run(result.copiedCampaignId, ['triggered', 'skipped', 'failed'].includes(result.discovery) ? result.discovery : null, project.id, key);
        };
        try {
          const result = await api(`/ads/campaigns/${encodeURIComponent(body.campaignId)}/duplicate`, {}, { platform: body.platform, deepCopy: true, statusOption: 'PAUSED', syncAfter: true }, key, 'POST', observeReceipt);
          observeReceipt(result);
          const ref = value => value?._id || value;
          if (!copyId(result.copiedCampaignId) || result.copiedCampaignId === body.campaignId || !['triggered', 'skipped', 'failed'].includes(result.discovery) || ['sourceCampaignId', 'campaignId', 'profileId', 'accountId', 'platformAdAccountId', 'adAccountId', 'platform'].some(field => Object.hasOwn(result, field) && (field === 'platform' ? copyPlatform(result[field]) !== copyPlatform(body.platform) : ['platformAdAccountId', 'adAccountId'].includes(field) ? typeof ref(result[field]) !== 'string' || copyAdvertiser(body.platform, ref(result[field])) !== copyAdvertiser(body.platform, current.source.adAccountId) : ref(result[field]) !== ({ sourceCampaignId: body.campaignId, campaignId: body.campaignId, profileId, accountId: current.source.accountId })[field]))) throw new IntegrationError(502, 'CAMPAIGN_COPY_NOT_CONFIRMED', 'The provider did not return a safe copy reference.', true);
          const after = await copySnapshot(context, api, profileId, body.campaignId, body.platform);
          if (after.version !== current.version || after.resource !== current.resource) throw new IntegrationError(409, 'CAMPAIGN_COPY_SCOPE_CHANGED', 'The campaign connection changed after the provider received the copy request.', true);
          return { campaignCopy: copyReference(db.prepare('SELECT * FROM zernio_campaign_copy_receipts WHERE project_id=? AND request_key=?').get(project.id, key)) };
        } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
      }, ['ads', body.platform, body.campaignId]);
      send(outcome.status, outcome.data); return true;
    }
    if (req.method === 'GET' && path === 'ads/items') {
      const campaignId = identifier(url.searchParams.get('campaignId'), 'campaign ID'), platform = url.searchParams.get('platform');
      const dates = dateQuery(url), campaign = await scopedCampaign(api, profileId, campaignId, platform, dates);
      const result = await scopedAds(api, profileId, { campaignId, platform, ...dates });
      send(200, { ...redact(result), campaign: redact(campaign) }); return true;
    }
    if (req.method === 'GET' && path === 'ads/details') {
      const ad = await scopedAd(api, profileId, identifier(url.searchParams.get('adId'), 'ad ID'));
      const result = await api(`/ads/${encodeURIComponent(ad._id)}`, { live: true });
      if (result.ad?._id !== ad._id || String(result.ad.profileId?._id || result.ad.profileId) !== profileId) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not confirm this project’s ad details.');
      const review = ad.platform === 'google' && String(ad.advertisingChannelType).toLowerCase() === 'search' ? rsaCreativeReview(result, ad, profileId) : null;
      send(200, { ...redact(result), creativeReview: review ? { version: review.version, observedAt: review.observedAt, expiresAt: review.expiresAt } : null }); return true;
    }
    if (req.method === 'GET' && path === 'ads/review') {
      if ([...url.searchParams.keys()].some(key => key !== 'adId' || url.searchParams.getAll(key).length !== 1)) fail(400, 'INVALID_AD_REVIEW_FILTER', 'Choose one ad for its current platform review.');
      const ad = await scopedAd(api, profileId, identifier(url.searchParams.get('adId'), 'ad ID'));
      if (!['facebook', 'instagram', 'google', 'tiktok'].includes(ad.platform)) fail(422, 'AD_REVIEW_UNSUPPORTED', 'Live review diagnostics are available for Meta, Google and TikTok ads.');
      const reference = value => value?._id || value;
      const identity = row => canonical(['_id', 'platform', 'profileId', 'accountId', 'platformAdAccountId', 'platformCampaignId', 'platformAdSetId', 'platformAdId'].map(field => reference(row[field])));
      const result = await api(`/ads/${encodeURIComponent(ad._id)}/review`), current = await scopedAd(api, profileId, ad._id);
      if (identity(current) !== identity(ad)) fail(409, 'AD_REVIEW_SCOPE_CHANGED', 'The selected ad changed while reading its review. Refresh its details before continuing.');
      const invalid = () => fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return a readable review verdict for the selected ad.');
      if (result.adId !== ad._id || result.platform !== ad.platform || Object.hasOwn(result, 'platformAdId') && (typeof result.platformAdId !== 'string' || !result.platformAdId || ad.platformAdId != null && result.platformAdId !== ad.platformAdId) || ['profileId', 'accountId', 'platformAdAccountId', 'platformCampaignId', 'platformAdSetId'].some(field => Object.hasOwn(result, field) && reference(result[field]) !== reference(ad[field])) || !reportObject(result.review)) invalid();
      let nodes = 0, characters = 0;
      const safeText = value => { if (typeof value !== 'string' || value.length > 20000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || (characters += value.length) > 200000) invalid(); return value; };
      const nullableText = value => value == null ? null : safeText(value);
      const list = (value, normalize) => { if (value === undefined) return []; if (!Array.isArray(value) || value.length > 100) invalid(); return value.map(normalize); };
      const record = (value, normalize) => {
        if (value === undefined) return {};
        if (!reportObject(value) || Object.keys(value).length > 100) invalid();
        return Object.fromEntries(Object.entries(value).map(([key, item]) => { if (['__proto__', 'constructor', 'prototype'].includes(key)) invalid(); return [safeText(key), normalize(item)]; }));
      };
      const json = (value, depth = 0) => {
        if (++nodes > 5000 || depth > 8) invalid();
        if (value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return value;
        if (typeof value === 'string') return safeText(value);
        if (Array.isArray(value)) return list(value, item => json(item, depth + 1));
        if (!reportObject(value)) invalid();
        return record(value, item => json(item, depth + 1));
      };
      const objects = value => list(value, item => { if (!reportObject(item)) invalid(); return json(item); });
      const strings = value => list(value, safeText), review = result.review;
      if (review.approved !== undefined && review.approved !== null && typeof review.approved !== 'boolean' || Object.hasOwn(review, 'readAt') && !validPostInstant(review.readAt)) invalid();
      const normalized = {
        approved: review.approved ?? null, reviewStatus: nullableText(review.reviewStatus), approvalStatus: nullableText(review.approvalStatus), readAt: review.readAt ?? null,
        ...Object.fromEntries(['forbiddenPlacements', 'forbiddenAges', 'forbiddenLocations', 'forbiddenOperatingSystems'].map(field => [field, strings(review[field])])),
        rejections: list(review.rejections, row => {
          if (!reportObject(row) || row.content != null && !reportObject(row.content)) invalid();
          return { reasons: strings(row.reasons), suggestion: nullableText(row.suggestion), ...Object.fromEntries(['forbiddenPlacements', 'forbiddenAges', 'forbiddenLocations'].map(field => [field, strings(row[field])])), content: row.content == null ? null : Object.fromEntries(['type', 'text', 'imageId', 'videoId', 'musicId'].map(field => [field, nullableText(row.content[field])])) };
        }),
        policyTopics: list(review.policyTopics, row => { if (!reportObject(row)) invalid(); return { topic: nullableText(row.topic), type: nullableText(row.type), evidences: objects(row.evidences), constraints: objects(row.constraints) }; }),
        reviewFeedback: {}, issues: objects(review.issues),
      };
      if (review.reviewFeedback !== undefined && !reportObject(review.reviewFeedback)) invalid();
      normalized.reviewFeedback = { global: record(review.reviewFeedback?.global, safeText), placementSpecific: record(review.reviewFeedback?.placementSpecific, value => record(value, safeText)) };
      send(200, { adId: ad._id, platform: ad.platform, platformAdId: result.platformAdId === undefined ? null : safeText(result.platformAdId), review: redact(normalized) }); return true;
    }
    if (req.method === 'GET' && path === 'ads/targeting') {
      const accountId = identifier(url.searchParams.get('accountId'), 'account ID'), accounts = await scopedAccounts(api, profileId), account = requireAccount(accounts, accountId);
      const platform = Object.keys(CREATE_CONNECTIONS).find(key => CREATE_CONNECTIONS[key].includes(account.platform));
      if (!platform || ['twitter', 'openai'].includes(platform)) fail(422, 'UNSUPPORTED_AD_TARGETING', 'Use country codes for this network.');
      const adAccountId = identifier(url.searchParams.get('adAccountId'), 'advertising account ID');
      const dimension = url.searchParams.get('dimension') || 'geo';
      if (platform === 'facebook' && dimension === 'interest') {
        const allowed = ['accountId', 'adAccountId', 'dimension', 'q'];
        if ([...url.searchParams.keys()].some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) fail(400, 'INVALID_AUDIENCE', 'Use one account, advertising account, interest dimension and search query.');
        const query = { accountId, adAccountId, dimension, q: text(url.searchParams.get('q'), 'audience search', 200), limit: 25 };
        const invalid = () => fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return readable interest results.');
        const validText = (value, max) => typeof value === 'string' && Boolean(value.trim()) && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
        const assertScope = value => {
          for (const [key, expected] of [['profileId', profileId], ['accountId', accountId], ['adAccountId', adAccountId], ['platformAdAccountId', adAccountId]]) if (Object.hasOwn(value, key) && (reportObject(value[key]) ? value[key]._id : value[key]) !== expected) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned targeting outside this project’s advertising account.');
          if (value.dimension !== undefined && value.dimension !== dimension || value.platform !== undefined && !['facebook', 'instagram', 'meta', 'metaads'].includes(value.platform)) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned targeting for another platform or dimension.');
        };
        const identity = current => canonical({ platform: current.platform, username: current.username, platformId: current.platformId, platformUserId: current.platformUserId, externalId: current.externalId });
        const assertConnection = currentAccounts => {
          const current = requireAccount(currentAccounts, accountId);
          if (currentAccounts.filter(item => item._id === accountId).length !== 1) invalid();
          if (current.isActive === false) fail(409, 'ACCOUNT_UNAVAILABLE', 'This advertising connection needs reconnection.');
          if (identity(current) !== identity(account)) fail(409, 'PROJECT_CONNECTION_CHANGED', 'The advertising connection changed. Refresh before searching again.');
        };
        const assertAdvertiser = async () => {
          const access = await adAccounts(api, accountId); assertScope(access);
          if (access.accounts.some(item => !reportObject(item) || !validText(item.id, 500) || /\s/.test(item.id))) invalid();
          const selected = access.accounts.filter(item => item.id === adAccountId);
          if (!selected.length || selected[0].selectable === false) fail(403, 'AD_ACCOUNT_OUTSIDE_PROJECT', 'This advertising account is not available in this project.');
          if (selected.length !== 1 || selected[0].selectable !== undefined && typeof selected[0].selectable !== 'boolean') invalid();
          assertScope(selected[0]);
        };
        assertConnection(accounts); await assertAdvertiser();
        const result = await api('/ads/targeting/search', query); assertScope(result);
        if (!Array.isArray(result.results) || result.results.length > 25) invalid();
        const ids = new Set(), results = result.results.map(row => {
          if (!reportObject(row)) invalid();
          assertScope(row);
          if (!validText(row.id, 500) || /\s/.test(row.id) || ids.has(row.id) || !validText(row.name, 200) || row.type !== 'interest' || row.path !== undefined && (!Array.isArray(row.path) || row.path.length > 10 || row.path.some(item => !validText(item, 200))) || row.audienceSize !== undefined && row.audienceSize !== null && (!Number.isSafeInteger(row.audienceSize) || row.audienceSize < 0)) invalid();
          ids.add(row.id);
          return { id: row.id, name: row.name, type: 'interest', ...(row.path === undefined ? {} : { path: row.path }), ...(row.audienceSize === undefined ? {} : { audienceSize: row.audienceSize }) };
        });
        assertConnection(await scopedAccounts(api, profileId)); await assertAdvertiser(); assertConnection(await scopedAccounts(api, profileId));
        send(200, { results }); return true;
      }
      if (!(await adAccounts(api, accountId)).accounts.some(item => item.id === adAccountId)) fail(403, 'AD_ACCOUNT_OUTSIDE_PROJECT', 'This advertising account is not in this project.');
      if (!['geo', 'interest', ...(platform === 'reddit' ? ['community', 'conversationKeyword'] : [])].includes(dimension)) fail(400, 'INVALID_AUDIENCE', 'Choose locations or interests to search.');
      const query = { accountId, adAccountId, dimension, q: text(url.searchParams.get('q'), 'audience search', 200), limit: 25 };
      if (url.searchParams.has('countryCode')) { const code = url.searchParams.get('countryCode'); countries([code]); query.countryCode = code; }
      if (url.searchParams.has('geoType')) { const type = url.searchParams.get('geoType'); if (!['country', 'region', 'city'].includes(type)) fail(400, 'INVALID_AUDIENCE', 'Choose a country, region or city.'); query.geoType = type; }
      send(200, redact(await api('/ads/targeting/search', query))); return true;
    }
    if (req.method === 'GET' && path === 'analytics') {
      const page = Number(url.searchParams.get('page') || 1);
      if (!Number.isInteger(page) || page < 1 || page > 1000) fail(400, 'INVALID_PAGE', 'Choose an analytics page from 1 to 1000.');
      const dates = analyticsDates(url, 90), accounts = await scopedAccounts(api, profileId), result = await api('/analytics', { profileId, ...dates, page, limit: 100 });
      if (!Array.isArray(result.posts) || result.posts.length > 100 || result.posts.some(row => !reportObject(row) || row.analytics != null && !analyticsMetrics(row.analytics)) || result.accounts !== undefined && !Array.isArray(result.accounts)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return readable post analytics.');
      for (const row of result.posts) {
        analyticsScope(row, profileId, accounts);
        if (row.platforms !== undefined && !Array.isArray(row.platforms)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return readable platform analytics.');
        for (const copy of row.platforms || []) { if (!copy?.accountId) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio did not identify an analytics account.'); analyticsScope(copy, profileId, accounts); }
        if (!row.profileId && !(row.platforms?.length && row.platforms.every(copy => copy.accountId))) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio did not identify the project accounts for this analytics row.');
      }
      for (const account of result.accounts || []) { if (!account?._id) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio did not identify an analytics account.'); analyticsScope({ accountId: account._id, platform: account.platform }, profileId, accounts); }
      send(200, { ...redact(result), complete: result.pagination?.pages !== undefined ? page >= result.pagination.pages : false }); return true;
    }
    if (req.method === 'GET' && path === 'analytics/daily') {
      const dates = analyticsDates(url, 180), result = await api('/analytics/daily-metrics', { profileId, ...dates, attribution: 'received' });
      if (!Array.isArray(result.dailyData) || result.dailyData.length > 366 || result.dailyData.some(row => !reportObject(row) || !reportDay(row.date, dates) || !analyticsMetrics(row.metrics)) || !Array.isArray(result.platformBreakdown) || result.platformBreakdown.some(row => !reportObject(row) || !analyticsMetrics(row))) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return readable daily analytics.');
      send(200, redact(result)); return true;
    }
    if (req.method === 'GET' && path === 'analytics/dashboard') {
      send(200, redact(await analyticsDashboard(api, profileId, analyticsDates(url, 30)))); return true;
    }
    if (req.method === 'GET' && path === 'social/tiktok-creator-info') {
      const accountId = identifier(url.searchParams.get('accountId'), 'TikTok account ID'), account = requireAccount(await scopedAccounts(api, profileId), accountId), mediaType = url.searchParams.get('mediaType') || 'video';
      if (account.platform !== 'tiktok' || !['video', 'photo'].includes(mediaType)) fail(400, 'INVALID_TIKTOK_ACCOUNT', 'Choose a connected TikTok account and video or photo media.');
      send(200, await tiktokCreatorInfo(api, accountId, mediaType)); return true;
    }
    if (req.method === 'POST' && path === 'social/validate-media') {
      fields(body, ['url'], 'media inspection');
      const result = await api('/tools/validate/media', {}, { url: mediaUrl(body.url) });
      if (!result || typeof result.valid !== 'boolean' || (result.size !== undefined && result.size !== null && (!Number.isSafeInteger(result.size) || result.size < 0)) || (result.contentType !== undefined && (typeof result.contentType !== 'string' || result.contentType.length > 200))) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return valid media inspection details.');
      send(200, { valid: result.valid, ...(typeof result.error === 'string' ? { error: result.error.slice(0, 2000) } : {}), contentType: result.contentType || null, size: result.size ?? null }); return true;
    }
    if (req.method === 'POST' && path === 'social/validate') {
      fields(body, ['content', 'tags', 'platforms', 'accounts', 'mediaItems', 'assetId', 'platformOverrides', 'accountOverrides', 'status', 'scheduledAt', 'campaignId', 'queueId', 'queueVersion'], 'post validation');
      const assets = await postAssets(store, project.id, body), accounts = await scopedAccounts(api, profileId);
      const payload = publishBody(body, accounts, assets, { validate: false }), local = postRestrictions(body, [...new Set(payload.platforms.map(item => item.platform))], assets, payload.platforms);
      await applyQueueIntent(api, profileId, body, payload);
      if (local.valid) await assertTikTokCreatorRestrictions(api, payload, Object.values(local.variants).flatMap(variant => variant.mediaItems));
      const provider = await providerPostValidation(api, payload);
      send(200, { valid: local.valid && provider.valid, errors: [...local.errors, ...provider.errors], warnings: [...local.warnings, ...provider.warnings], local, provider }); return true;
    }
    if (req.method === 'POST' && path === 'social/publish') {
      fields(body, ['postId', 'queueId'], 'post publication');
      const postId = identifier(body.postId, 'post ID'); const post = await store.get(project.id, 'posts', postId);
      if (!post) fail(404, 'POST_NOT_FOUND', 'The post was not found in this project.');
      const assets = await postAssets(store, project.id, post), accounts = await scopedAccounts(api, profileId), payload = publishBody(post, accounts, assets);
      const publishingPost = { ...post, ...(post.assetId && !Array.isArray(post.mediaItems) ? { mediaItems: commonMedia(post, assets) } : {}), platformOverrides: Object.fromEntries(Object.entries(post.platformOverrides || {}).map(([platform, variant]) => [platform, { ...variant, ...(variant.assetId && !Array.isArray(variant.mediaItems) ? { mediaItems: resolveVariant(post, platform, assets).mediaItems } : {}) }])), ...(post.accountOverrides ? { accountOverrides: Object.fromEntries(Object.entries(post.accountOverrides).map(([id, variant]) => [id, { ...variant, ...(variant.assetId && !Array.isArray(variant.mediaItems) ? { mediaItems: resolveVariant(post, variant.platform, assets, id).mediaItems } : {}) }])) } : {}) };
      const outcome = await operation({ ...context, body: { postId } }, async key => {
        const current = await store.get(project.id, 'posts', post.id);
        if (!current) fail(404, 'POST_NOT_FOUND', 'The post was removed before it could be submitted.');
        if (body.queueId !== undefined && body.queueId !== current.queueId) fail(409, 'POST_QUEUE_CHANGED', 'Save and review this post’s queue selection before submitting it.');
        if (current.externalId) fail(409, 'POST_ALREADY_SUBMITTED', 'This post has already been submitted. Refresh its provider status.');
        if (current.updatedAt && current.updatedAt !== post.updatedAt) fail(409, 'POST_CHANGED', 'The post changed while preparing publication. Review it and submit again.');
        await applyQueueIntent(api, profileId, post, payload);
        if (current.status === 'scheduled' && Date.parse(payload.scheduledFor) <= Date.now()) fail(409, 'SCHEDULE_PASSED', 'This scheduled time has passed. Choose a new time before scheduling the post.');
        await assertTikTokCreatorRestrictions(api, payload, Object.values(postRestrictions(post, payload.platforms.map(item => item.platform), assets, payload.platforms).variants).flatMap(variant => variant.mediaItems));
        assertPostRestrictions(await providerPostValidation(api, payload));
        context.assertPublishingApproval?.(publishingPost);
        if ([payload.scheduledFor, ...(payload.platforms || []).map(target => target.scheduledFor)].filter(Boolean).some(time => Date.parse(time) <= Date.now())) fail(409, 'SCHEDULE_PASSED', 'A scheduled time passed during the provider checks. Choose future times before submitting.');
        if (post.queueId) await applyQueueIntent(api, profileId, post, payload);
        validateRemotePayload(payload, await postAssets(store, project.id, post), post);
        context.assertPublishingApproval?.(publishingPost);
        const result = await api('/posts', {}, payload, key);
        assertPostResult(result.post, profileId, { targets: payload.platforms });
        assertQueueReceipt(result.post, post, profileId);
        if (payload.tags?.length) {
          let confirmed;
          try { confirmed = Object.hasOwn(result.post, 'tags') ? result.post : await scopedPost(api, profileId, { ...post, externalId: result.post._id, zernioProfileId: profileId }); }
          catch { throw new IntegrationError(502, 'POST_RECONCILIATION_REQUIRED', 'The provider accepted this post, but its keyword tags could not be read. Check Zernio before repeating it.', true); }
          if (!Object.hasOwn(confirmed, 'tags') || canonical(confirmed.tags) !== canonical(payload.tags)) throw new IntegrationError(502, 'POST_RECONCILIATION_REQUIRED', 'The provider accepted this post, but did not confirm the keyword tags. Check Zernio before repeating it.', true);
          result.post = confirmed;
        }
        const updated = await savePostSnapshot(store, project.id, { ...post, externalId: result.post._id, zernioProfileId: profileId }, result.post, { externalId: result.post._id, zernioProfileId: profileId, ...(post.queueId ? { scheduledAt: result.post.scheduledFor, queueId: '', queueVersion: '' } : {}) }, payload.platforms, post);
        await store.activity(project.id, 'Submitted a social post to Zernio.');
        return { post: updated, provider: { id: result.post._id, status: result.post.status, ...(post.queueId ? { queueId: post.queueId } : {}) } };
      }); send(outcome.status, outcome.data); return true;
    }
    if (req.method === 'GET' && path === 'social/status') {
      const post = await store.get(project.id, 'posts', identifier(url.searchParams.get('postId'), 'post ID'));
      if (!post?.externalId || post.zernioProfileId !== profileId) fail(404, 'POST_NOT_SUBMITTED', 'No submitted post was found for this project.');
      if (post.providerDeletedAt) { send(200, { post, provider: { id: post.externalId, status: 'cancelled', deleted: true } }); return true; }
      const remote = await scopedPost(api, profileId, post);
      const updated = await savePostSnapshot(store, project.id, post, remote);
      send(200, { post: updated, provider: { id: post.externalId, status: remote.status } }); return true;
    }
    if (req.method === 'POST' && ['social/update', 'social/cancel', 'social/retry', 'social/edit-published', 'social/update-metadata', 'social/unpublish'].includes(path)) {
      const allowed = path === 'social/update' ? ['postId', 'content', 'tags', 'mediaItems', 'assetId', 'platformOverrides', 'accountOverrides', 'confirmReplaceVariants', 'mode', 'scheduledAt'] : path === 'social/retry' ? ['postId', 'confirmPublish'] : path === 'social/edit-published' ? ['postId', 'accountId', 'content', 'confirmEdit'] : path === 'social/update-metadata' ? ['postId', 'accountId', 'videoId', 'title', 'tags', 'confirmEdit'] : path === 'social/unpublish' ? ['postId', 'accountId', 'confirmRemoval'] : ['postId', 'confirmCancellation'];
      fields(body, allowed, 'post action');
      const postId = identifier(body.postId, 'post ID');
      const outcome = await operation(context, async key => {
        const post = await store.get(project.id, 'posts', postId), remote = await scopedPost(api, profileId, post, ['social/edit-published', 'social/update-metadata'].includes(path) || path === 'social/update' && body.mode === 'scheduled', path === 'social/update-metadata' ? identifier(body.accountId, 'account ID') : undefined), endpoint = `/posts/${encodeURIComponent(post.externalId)}`;
        if (['social/update', 'social/edit-published', 'social/update-metadata'].includes(path)) assertRecyclingSeedEditable(remote, context);
        if (sample(post)) fail(400, 'SAMPLE_RECORD', 'Sample posts cannot be sent to live providers.');
        if (path === 'social/cancel') {
          if (body.confirmCancellation !== true) fail(400, 'CANCELLATION_CONFIRMATION_REQUIRED', 'Confirm removal of this unpublished provider record.');
          if (!['draft', 'scheduled', 'failed', 'cancelled'].includes(remote.status) || remote.platforms.some(item => item.status === 'published' || item.status === 'publishing')) fail(409, 'POST_NOT_CANCELLABLE', 'This post is live or publishing on at least one account. Refresh its status and manage each published copy separately.');
          await api(endpoint, {}, undefined, key, 'DELETE');
          const updated = await savePostSnapshot(store, project.id, post, { ...remote, status: 'cancelled' }, { providerDeletedAt: new Date().toISOString() });
          await store.activity(project.id, 'Cancelled an unpublished social post in Zernio.');
          return { post: updated, provider: { id: post.externalId, status: 'cancelled', deleted: true } };
        }
        if (path === 'social/update') {
          context.assertProviderPostEdit?.();
          if (!['draft', 'scheduled', 'failed', 'cancelled'].includes(remote.status) || remote.platforms.some(item => ['published', 'publishing'].includes(item.status))) fail(409, 'POST_NOT_EDITABLE', 'Only unpublished posts can be rescheduled or changed here.');
          const content = body.content === undefined ? remote.content ?? post.content ?? '' : body.content;
          if (typeof content !== 'string' || content.length > 100000) fail(400, 'INVALID_CONTENT', 'Use a caption of at most 100,000 characters.');
          if (!['draft', 'scheduled'].includes(body.mode)) fail(400, 'INVALID_POST_MODE', 'Save as a draft or choose a future schedule.');
          const payload = { content, isDraft: body.mode === 'draft' }; let scheduledAt = '', validationWarnings = [];
          if (body.mode === 'scheduled') {
            const value = body.scheduledAt;
            if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value.slice(0, 10)).toISOString().slice(0, 10) !== value.slice(0, 10)) fail(400, 'INVALID_DATE', 'Choose a valid scheduled time with a timezone.');
            scheduledAt = new Date(value).toISOString();
            if (Date.parse(scheduledAt) <= Date.now()) fail(409, 'SCHEDULE_PASSED', 'Choose a future time before scheduling.');
            Object.assign(payload, { scheduledFor: scheduledAt, timezone: 'UTC' });
          }
          const model = await remotePostModel(store, project.id, post, remote), replacingPlatforms = Object.hasOwn(body, 'platformOverrides'), replacingAccounts = Object.hasOwn(body, 'accountOverrides');
          const changed = { ...model, content, scheduledAt, ...(Object.hasOwn(body, 'tags') ? { tags: body.tags } : {}), ...(Object.hasOwn(body, 'mediaItems') ? { mediaItems: body.mediaItems } : {}), ...(Object.hasOwn(body, 'assetId') ? { assetId: body.assetId } : {}), ...(replacingPlatforms ? { platformOverrides: body.platformOverrides, ...(!replacingAccounts ? { accountOverrides: {} } : {}) } : {}), ...(replacingAccounts ? { accountOverrides: body.accountOverrides } : {}) };
          normalizedVariants(changed);
          if (Object.hasOwn(body, 'tags')) { changed.tags = normalizePostTags(body.tags); payload.tags = changed.tags; }
          for (const [id, variant] of Object.entries(normalizeAccountVariants(changed))) if (!remote.platforms.some(target => String(target.accountId?._id || target.accountId) === id && target.platform === variant.platform)) fail(400, 'ACCOUNT_VARIANT_MISMATCH', 'Every account customization must match an existing destination and platform on this post.');
          if (body.mode === 'scheduled') try { assertAccountSchedules(changed); } catch (error) { fail(400, 'ACCOUNT_SCHEDULE_INVALID', error.message); }
          const assets = await postAssets(store, project.id, changed), replacingVariants = replacingPlatforms || replacingAccounts, replacingMedia = Object.hasOwn(body, 'mediaItems') || Object.hasOwn(body, 'assetId');
          if (Object.hasOwn(body, 'confirmReplaceVariants') && typeof body.confirmReplaceVariants !== 'boolean') fail(400, 'INVALID_VARIANT_CONFIRMATION', 'Explicitly confirm replacement of account-specific provider copies.');
          const divergent = remote.platforms.filter(target => remote.platforms.some(other => other.platform === target.platform && (canonical(targetConfiguration(other)) !== canonical(targetConfiguration(target)) || replacingAccounts && Date.parse(other.scheduledFor || remote.scheduledFor) !== Date.parse(target.scheduledFor || remote.scheduledFor))));
          const covered = replacingAccounts && divergent.every(target => body.accountOverrides?.[String(target.accountId?._id || target.accountId)]?.platform === target.platform);
          if (replacingVariants && divergent.length && !covered && body.confirmReplaceVariants !== true) fail(409, 'PROVIDER_VARIANT_CONFIRMATION_REQUIRED', 'Accounts on the same platform have different provider captions, media, options or schedules. Review every account copy or confirm replacing those copies.');
          if (replacingVariants && new Set(remote.platforms.map(target => String(target.accountId?._id || target.accountId))).size !== remote.platforms.length) fail(409, 'AMBIGUOUS_POST_DESTINATIONS', 'This post has multiple destinations on one account. Manage these copies in Zernio until each destination can be edited separately here.');
          const checkPayload = remoteRestrictionPayload(changed, remote, { content, tags: changed.tags, mediaItems: replacingMedia ? commonMedia(changed, assets) : remote.mediaItems ?? model.mediaItems, ...(replacingVariants ? { overrides: changed.platformOverrides, ...(replacingAccounts ? { accountOverrides: changed.accountOverrides || {} } : {}) } : {}), assets });
          const providerOwnedMediaUrls = providerPostMediaUrls(remote);
          if (replacingMedia && (!providerOwnedMediaUrls.size || canonical(checkPayload.mediaItems) !== canonical(wireMediaItems(providerMediaItems(remote.mediaItems || []))))) payload.mediaItems = checkPayload.mediaItems;
          const rescheduling = scheduledAt && Date.parse(scheduledAt) !== Date.parse(remote.scheduledFor);
          if (rescheduling) for (const target of checkPayload.platforms) if (target.scheduledFor && !changed.accountOverrides?.[target.accountId]?.scheduledAt && !(!replacingAccounts && model.accountOverrides?.[target.accountId]?.scheduledAt)) target.scheduledFor = scheduledAt;
          if (replacingVariants || rescheduling && remote.platforms.some(target => target.scheduledFor)) payload.platforms = checkPayload.platforms;
          if (body.mode === 'scheduled') {
            if (checkPayload.platforms.some(target => target.scheduledFor && Date.parse(target.scheduledFor) <= Date.now())) fail(400, 'ACCOUNT_SCHEDULE_INVALID', 'Every separate account time must be in the future.');
            validateRemotePayload(checkPayload, assets, changed, providerOwnedMediaUrls);
            await assertTikTokCreatorRestrictions(api, checkPayload, Object.values(postRestrictions(changed, changed.platforms, assets, checkPayload.platforms, providerOwnedMediaUrls).variants).flatMap(variant => variant.mediaItems));
            const validation = await providerPostValidation(api, { ...checkPayload, scheduledFor: scheduledAt, timezone: 'UTC' }, { assets, providerOwnedMediaUrls }); assertPostRestrictions(validation); validationWarnings = [...new Set(validation.warnings.map(item => item.message))];
          }
          context.assertProviderPostEdit?.();
          if (body.mode === 'scheduled' && [payload.scheduledFor, ...checkPayload.platforms.map(target => target.scheduledFor)].filter(Boolean).some(time => Date.parse(time) <= Date.now())) fail(409, 'SCHEDULE_PASSED', 'A scheduled time passed during the provider checks. Choose future times before submitting.');
          if (body.mode === 'scheduled') validateRemotePayload(checkPayload, await postAssets(store, project.id, changed), changed, providerPostMediaUrls(await scopedPost(api, profileId, post, true)));
          const result = await api(endpoint, {}, payload, key, 'PUT');
          assertPostResult(result.post, profileId, { id: post.externalId, targets: remote.platforms });
          let confirmed;
          try { confirmed = await scopedPost(api, profileId, post); }
          catch { throw new IntegrationError(502, 'POST_RECONCILIATION_REQUIRED', 'The provider accepted this update, but its latest state could not be read. Check Zernio before repeating it.', true); }
          if (Object.hasOwn(body, 'tags') && (!Object.hasOwn(confirmed, 'tags') || canonical(confirmed.tags) !== canonical(changed.tags))) throw new IntegrationError(502, 'POST_RECONCILIATION_REQUIRED', 'The provider accepted this update, but did not confirm the keyword tags. Check Zernio before repeating it.', true);
          const updated = await savePostSnapshot(store, project.id, changed, confirmed, { content: confirmed.content ?? content, scheduledAt }, remote.platforms, post);
          await store.activity(project.id, 'Updated an unpublished social post in Zernio.');
          return { post: updated, provider: { id: post.externalId, status: confirmed.status }, validationWarnings };
        }
        if (path === 'social/retry') {
          if (body.confirmPublish !== true) fail(400, 'PUBLISH_CONFIRMATION_REQUIRED', 'Confirm that this failed post should publish immediately.');
          const failed = remote.platforms.filter(item => item.status === 'failed');
          if (!['failed', 'partial'].includes(remote.status) || !failed.length || (remote.status === 'partial') !== remote.platforms.some(item => item.status === 'published') || remote.platforms.some(item => !['failed', 'published', 'cancelled'].includes(item.status))) fail(409, 'POST_NOT_FAILED', 'Retry requires failed copies and a confirmed terminal outcome for every other account. Refresh provider status first.');
          const assertTags = current => {
            if (remote.platforms.some(item => item.platform === 'youtube') && (Object.hasOwn(post, 'tags') || Object.hasOwn(current, 'tags')) && (!Object.hasOwn(current, 'tags') || canonical(current.tags) !== canonical(post.tags || []))) fail(409, 'POST_TAGS_CHANGED', 'Zernio did not confirm the reviewed keyword tags. Refresh the provider status and review its keywords before retrying.');
          };
          assertTags(remote);
          const accounts = await scopedAccounts(api, profileId);
          if (failed.some(item => requireAccount(accounts, String(item.accountId?._id || item.accountId)).isActive === false)) fail(409, 'ACCOUNT_UNAVAILABLE', 'A failed publishing account needs reconnection before retrying.');
          const model = await remotePostModel(store, project.id, post, remote), assets = await postAssets(store, project.id, model), payload = remoteRestrictionPayload(model, { ...remote, platforms: failed });
          const providerOwnedMediaUrls = providerPostMediaUrls(remote);
          validateRemotePayload(payload, assets, model, providerOwnedMediaUrls); await assertTikTokCreatorRestrictions(api, payload, Object.values(postRestrictions(model, failed.map(item => item.platform), assets, failed, providerOwnedMediaUrls).variants).flatMap(variant => variant.mediaItems));
          const validation = await providerPostValidation(api, { ...payload, publishNow: true }, { assets, providerOwnedMediaUrls }); assertPostRestrictions(validation);
          const currentAssets = await postAssets(store, project.id, model), latest = await scopedPost(api, profileId, post); assertTags(latest);
          const retryState = snapshot => {
            const publication = remoteRestrictionPayload({}, snapshot);
            return canonical({ ...publication, present: ['content', 'mediaItems', 'tags'].filter(field => Object.hasOwn(snapshot, field)), status: snapshot.status, scheduledFor: snapshot.scheduledFor ? Date.parse(snapshot.scheduledFor) : null, platforms: publication.platforms.map((target, index) => ({ ...target, scheduledFor: target.scheduledFor ? Date.parse(target.scheduledFor) : null, status: snapshot.platforms[index].status })).sort((first, second) => canonical(first).localeCompare(canonical(second))) });
          };
          if (retryState(latest) !== retryState(remote)) fail(409, 'POST_CHANGED', 'The provider post changed during the retry checks. Refresh its status and review every account before retrying.');
          const latestAccounts = await scopedAccounts(api, profileId);
          if (failed.some(item => requireAccount(latestAccounts, String(item.accountId?._id || item.accountId)).isActive === false)) fail(409, 'ACCOUNT_UNAVAILABLE', 'A failed publishing account needs reconnection before retrying.');
          context.assertPublishingApproval?.(model);
          validateRemotePayload(payload, currentAssets, model, providerPostMediaUrls(latest));
          const result = await api(endpoint + '/retry', {}, {}, key);
          assertPostResult(result.post, profileId, { id: post.externalId, targets: remote.platforms });
          // Minimal receipts may omit one identity. Resolve only an unambiguous original target, then keep omitted copies.
          const copies = result.post.platforms && result.post.platforms.map(item => {
            const matches = remote.platforms.filter(copy => (!item.platform || item.platform === copy.platform) && (!item.accountId || String(item.accountId?._id || item.accountId) === String(copy.accountId?._id || copy.accountId)));
            if (matches.length !== 1) throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not identify the retried account unambiguously.', true);
            const copy = { ...matches[0], ...item, platform: matches[0].platform, accountId: matches[0].accountId };
            if (item.status && item.status !== 'failed') for (const field of ['error', 'errorMessage', 'errorCategory', 'errorSource']) if (!Object.hasOwn(item, field)) delete copy[field];
            return copy;
          });
          if (copies && new Set(copies.map(copy => String(copy.accountId?._id || copy.accountId))).size !== copies.length) throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned duplicate retried account copies.', true);
          const ordered = copies && remote.platforms.map(copy => copies.find(item => String(item.accountId?._id || item.accountId) === String(copy.accountId?._id || copy.accountId)) || copy);
          const updated = await savePostSnapshot(store, project.id, model, { ...result.post, ...(ordered ? { platforms: ordered } : {}) }, {}, remote.platforms, post);
          await store.activity(project.id, 'Retried a failed social post through Zernio.');
          return { post: updated, provider: { id: post.externalId, status: result.post.status }, validationWarnings: [...new Set(validation.warnings.map(item => item.message))] };
        }
        const accountId = identifier(body.accountId, 'account ID'), matches = remote.platforms.filter(item => String(item.accountId?._id || item.accountId) === accountId), target = matches[0];
        if (matches.length > 1) fail(409, 'AMBIGUOUS_POST_DESTINATIONS', 'This account has multiple destinations on the post. Manage each copy in Zernio until it can be identified separately here.');
        if (!target || target.status !== 'published') fail(403, 'POST_ACCOUNT_NOT_PUBLISHED', 'Choose a published copy belonging to this project.');
        if (path === 'social/update-metadata') {
          context.assertProviderPostEdit?.();
          if (target.platform !== 'youtube') fail(422, 'POST_ACTION_UNSUPPORTED', 'Published metadata changes are available for YouTube videos.');
          if (body.confirmEdit !== true) fail(400, 'POST_ACTION_CONFIRMATION_REQUIRED', 'Review and confirm the selected YouTube metadata changes.');
          const videoId = identifier(body.videoId, 'YouTube video ID'), metadata = {};
          if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) fail(400, 'INVALID_VIDEO', 'Use the published copy’s 11-character YouTube video ID.');
          if (Object.hasOwn(body, 'title')) {
            metadata.title = text(body.title, 'YouTube title', 100);
            if (/[\u0000-\u001f\u007f]/u.test(metadata.title)) fail(400, 'INVALID_INPUT', 'Use a YouTube title without control characters.');
          }
          if (Object.hasOwn(body, 'tags')) {
            try { metadata.tags = normalizePostTags(body.tags, { preserve: true }); }
            catch (error) { fail(400, 'INVALID_POST_TAGS', error.message); }
          }
          const requestedFields = Object.keys(metadata);
          if (!requestedFields.length) fail(400, 'EMPTY_METADATA_UPDATE', 'Select a title or keyword-tag change.');
          const assertCopy = (snapshot, uncertain = false) => {
            const selected = snapshot.platforms.filter(copy => String(copy.accountId?._id || copy.accountId) === accountId);
            if (!['published', 'partial'].includes(snapshot.status) || selected.length !== 1 || selected[0].platform !== 'youtube' || selected[0].status !== 'published' || selected[0].removedFromPlatformAt || selected[0].platformPostId !== videoId) throw new IntegrationError(409, 'YOUTUBE_COPY_CHANGED', 'The selected published YouTube video could not be confirmed. Refresh and review its identity before continuing.', uncertain);
          };
          assertCopy(remote);
          const fresh = await scopedPost(api, profileId, post, true, accountId); assertCopy(fresh); assertRecyclingSeedEditable(fresh, context); context.assertProviderPostEdit?.();
          if (canonical(store.get(project.id, 'posts', post.id)) !== canonical(post)) fail(409, 'POST_CHANGED', 'The local post changed. Refresh and review it before continuing.');
          const result = await api(endpoint + '/update-metadata', {}, { platform: 'youtube', accountId, ...metadata }, key);
          if (!reportObject(result) || result.success !== true || !Array.isArray(result.updatedFields) || result.updatedFields.length !== requestedFields.length || new Set(result.updatedFields).size !== requestedFields.length || requestedFields.some(field => !result.updatedFields.includes(field)) || [['platform', 'youtube'], ['accountId', accountId], ['postId', post.externalId], ['videoId', videoId]].some(([field, expected]) => Object.hasOwn(result, field) && result[field] !== expected)) throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not confirm the selected YouTube metadata fields and scope. Review the provider outcome before another attempt.', true);
          let confirmed;
          try { confirmed = await scopedPost(api, profileId, post, true, accountId); assertCopy(confirmed, true); }
          catch { throw new IntegrationError(502, 'POST_RECONCILIATION_REQUIRED', 'Zernio accepted the metadata request, but the stored post identity and status could not be refreshed. Review the provider outcome before another attempt.', true); }
          if (canonical(store.get(project.id, 'posts', post.id)) !== canonical(post)) throw new IntegrationError(409, 'POST_CHANGED', 'The local post changed after Zernio accepted the request. Review the provider outcome.', true);
          const updated = await store.update(project.id, 'posts', post.id, { status: localStatus(confirmed.status), providerStatus: confirmed.status });
          if (!updated) throw new IntegrationError(409, 'POST_REMOVED', 'The local post was removed after Zernio accepted the request. Review the provider outcome.', true);
          await store.activity(project.id, 'Zernio accepted selected YouTube metadata changes; live values remain unverified.');
          return { post: updated, metadataAcceptance: { postId, accountId, videoId, requested: metadata, updatedFields: result.updatedFields, message: 'Accepted by Zernio; live values unverified.' }, provider: { id: post.externalId, status: confirmed.status, accountId, action: 'metadata-accepted' } };
        }
        const editing = path === 'social/edit-published', supported = editing ? ['twitter', 'discord', 'facebook', 'reddit', 'linkedin', 'telegram', 'pinterest', 'googlebusiness', 'youtube', 'slack'] : ['threads', 'facebook', 'twitter', 'linkedin', 'youtube', 'pinterest', 'reddit', 'bluesky', 'googlebusiness', 'telegram'];
        if (editing) context.assertProviderPostEdit?.();
        if (!supported.includes(target.platform)) fail(422, 'POST_ACTION_UNSUPPORTED', 'This platform does not support this action through Zernio. Use its native dashboard.');
        if (body[editing ? 'confirmEdit' : 'confirmRemoval'] !== true) fail(400, 'POST_ACTION_CONFIRMATION_REQUIRED', editing ? 'Confirm the text change to this published copy.' : 'Confirm permanent removal of this published copy.');
        const payload = { platform: target.platform, accountId, ...(editing ? { content: text(body.content, 'post content', 100000) } : {}) }; let validationWarnings = [];
        if (editing) {
          const checkPayload = remoteRestrictionPayload(post, { ...remote, platforms: [{ ...target, customContent: payload.content }] }), assets = await postAssets(store, project.id, post), providerOwnedMediaUrls = providerPostMediaUrls(remote);
          validateRemotePayload(checkPayload, assets, post, providerOwnedMediaUrls); const validation = await providerPostValidation(api, checkPayload, { assets, providerOwnedMediaUrls }); assertPostRestrictions(validation); validationWarnings = [...new Set(validation.warnings.map(item => item.message))];
          context.assertProviderPostEdit?.();
          validateRemotePayload(checkPayload, await postAssets(store, project.id, post), post, providerPostMediaUrls(await scopedPost(api, profileId, post, true)));
        }
        const result = await api(endpoint + (editing ? '/edit' : '/unpublish'), {}, payload, key);
        if (result.success !== true) throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not confirm the published-post action.', true);
        let confirmed;
        try { confirmed = await scopedPost(api, profileId, post); }
        catch { throw new IntegrationError(502, 'POST_RECONCILIATION_REQUIRED', 'The provider accepted this action, but its latest state could not be read. Check Zernio before repeating it.', true); }
        const updated = await savePostSnapshot(store, project.id, post, confirmed);
        await store.activity(project.id, editing ? 'Edited the text of a published social copy.' : 'Removed a published social copy through Zernio.');
        return { post: updated, provider: { id: post.externalId, status: confirmed.status, accountId, action: editing ? 'edited' : 'unpublished' }, validationWarnings };
      // ponytail: serialize seed edits with recycling per project; split into post/account locks if concurrent editing needs it.
      }, ['social/update', 'social/edit-published', 'social/update-metadata'].includes(path) ? 'publishing-recycling' : undefined); send(outcome.status, outcome.data); return true;
    }
    if (req.method === 'POST' && path === 'ads/status') {
      fields(body, ['campaignId', 'platform', 'status']);
      const campaignId = identifier(body.campaignId, 'campaign ID');
      if (!AD_PLATFORMS.has(body.platform) || !['active', 'paused'].includes(body.status)) fail(400, 'INVALID_AD_STATUS', 'Choose a valid ad platform and active or paused status.');
      const campaign = await scopedCampaign(api, profileId, campaignId, body.platform);
      if (['rejected', 'completed', 'cancelled', 'archived', 'deleted'].includes(campaign.status)) fail(409, 'TERMINAL_AD_STATUS', 'This campaign cannot resume. Create a new campaign.');
      const outcome = await operation(context, async key => {
        const result = await api(`/ads/campaigns/${encodeURIComponent(campaignId)}/status`, {}, { status: body.status, platform: body.platform }, key, 'PUT');
        if (['pinterest', 'linkedin', 'twitter'].includes(body.platform)) {
          if (result.status !== body.status || ![0, 1].includes(result.updated) || ![0, 1].includes(result.skipped) || result.updated + result.skipped !== 1) throw new IntegrationError(502, 'AD_STATUS_NOT_CONFIRMED', 'The provider did not acknowledge this status request.', true);
          return { result: redact(result), requestedStatus: body.status, verification: 'unavailable' };
        }
        const actual = String(result.platformCampaignStatus || '').toUpperCase(), expected = body.status === 'active' ? ['ACTIVE', 'ENABLE', 'ENABLED'] : ['PAUSED', 'DISABLE', 'DISABLED', 'DRAFT'];
        if (!result.statusReadAt || !expected.includes(actual)) throw new IntegrationError(502, 'AD_STATUS_NOT_CONFIRMED', 'The campaign switch was not confirmed by the provider.', true);
        saveCampaignSnapshot(context, profileId, body.platform, campaignId, { status: body.status, providerStatus: body.status });
        return { result: redact(result), requestedStatus: body.status, verification: 'confirmed' };
      }, ['ads', body.platform, campaignId]);
      send(outcome.status, outcome.data); return true;
    }
    if (req.method === 'POST' && ['ads/edit', 'ads/ad-status'].includes(path)) {
      const ad = await scopedAd(api, profileId, identifier(body.adId, 'ad ID'));
      let payload;
      if (path === 'ads/ad-status') {
        fields(body, ['adId', 'status']);
        if (!['active', 'paused'].includes(body.status)) fail(400, 'INVALID_AD_STATUS', 'Choose active or paused.');
        if (['rejected', 'completed', 'cancelled', 'archived', 'deleted'].includes(ad.status)) fail(409, 'TERMINAL_AD_STATUS', 'This ad cannot resume. Create a new ad.');
        if (ad.platform === 'twitter') fail(422, 'AD_SET_STATUS_REQUIRED', 'X uses one switch for the entire ad set. Change that switch in X Ads Manager.');
        payload = { status: body.status };
      } else payload = editableAd(body, ad);
      const rsaEditing = path === 'ads/edit' && ad.platform === 'google' && String(ad.advertisingChannelType).toLowerCase() === 'search' && ['headlines', 'descriptions', 'finalUrls'].some(key => payload[key] !== undefined);
      if (rsaEditing && (typeof body.expectedCreativeVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedCreativeVersion))) fail(400, 'GOOGLE_CREATIVE_REVIEW_REQUIRED', 'Refresh and review the current Google Search creative before saving text or destination changes.');
      const outcome = await operation(context, async key => {
        let reviewed, outgoing = payload;
        if (rsaEditing) {
          const current = await scopedAd(api, profileId, ad._id);
          editableAd(body, current);
          reviewed = rsaCreativeReview(await api(`/ads/${encodeURIComponent(ad._id)}`, { live: true }), current, profileId);
          outgoing = reviewedRsaPayload(payload, reviewed, body.expectedCreativeVersion, body);
          checkMapping(() => context.assertProjectMapping?.(profileId));
        }
        const result = await api(`/ads/${encodeURIComponent(ad._id)}${path === 'ads/ad-status' ? '/status' : ''}`, {}, outgoing, key, 'PUT');
        if (path === 'ads/ad-status') { if (String(result.configuredStatus || '').toUpperCase() !== body.status.toUpperCase()) throw new IntegrationError(502, 'AD_STATUS_NOT_CONFIRMED', 'The ad switch was not confirmed by the provider.', true); }
        else if (result.ad?._id !== ad._id) throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not confirm the edited ad.', true);
        if (rsaEditing) try {
          const after = rsaCreativeReview(await api(`/ads/${encodeURIComponent(ad._id)}`, { live: true }), ad, profileId);
          const expected = { ...reviewed.creative, ...Object.fromEntries(['headlines', 'descriptions', 'finalUrls'].filter(key => outgoing[key] !== undefined).map(key => [key, outgoing[key]])) };
          if (!after || canonical(after.creative) !== canonical(expected)) throw new Error();
        } catch { throw new IntegrationError(502, 'GOOGLE_CREATIVE_UPDATE_NOT_CONFIRMED', 'Google accepted the change, but the current text and pinned positions could not be confirmed. Review the provider before repeating this edit.', true); }
        return { result: redact(result) };
      }, ['ads', ad.platform, ad.platformCampaignId || `ad:${ad._id}`]); send(outcome.status, outcome.data); return true;
    }
    if (req.method === 'POST' && path === 'ads/adset') {
      const budgetOnly = Object.hasOwn(body, 'budget'), statusOnly = Object.hasOwn(body, 'status');
      fields(body, budgetOnly ? ['campaignId', 'platform', 'adSetId', 'budget', 'currency', 'version', 'reviewExpiresAt', 'confirmBudget'] : statusOnly ? ['campaignId', 'platform', 'adSetId', 'status'] : ['campaignId', 'platform', 'adSetId', 'name'], 'ad set update');
      const campaignId = identifier(body.campaignId, 'campaign ID'), adSetId = identifier(body.adSetId, 'ad set ID'), payload = { platform: body.platform };
      if (statusOnly) { if (!['active', 'paused'].includes(body.status)) fail(400, 'INVALID_AD_STATUS', 'Choose active or paused.'); payload.status = body.status; }
      if (budgetOnly) {
        if (['google', 'openai'].includes(body.platform)) fail(422, 'CAMPAIGN_BUDGET_REQUIRED', 'This platform uses a campaign budget. Change its budget in the campaign editor.');
        fields(body.budget, ['amount', 'type'], 'daily budget');
        if (body.budget.type !== 'daily' || body.confirmBudget !== true || typeof body.version !== 'string' || !/^[a-f0-9]{64}$/.test(body.version) || !validPostInstant(body.reviewExpiresAt)) fail(400, 'BUDGET_REVIEW_REQUIRED', 'Load and explicitly confirm a fresh budget-only review.');
        payload.budget = { amount: adAmount(body.budget.amount, body.currency), type: 'daily' };
      } else if (!statusOnly) payload.name = text(body.name, 'ad set name', 255);
      const initial = await adSetPreflight(context, api, profileId, campaignId, body.platform, adSetId), campaign = initial.campaign;
      const outcome = await operation(context, async key => {
        const current = await adSetPreflight(context, api, profileId, campaignId, body.platform, adSetId, initial);
        const reference = adSetReference;
        if (budgetOnly) {
          if (Date.parse(body.reviewExpiresAt) <= Date.now() || Date.parse(body.reviewExpiresAt) > Date.now() + budgetReviewAge) fail(409, 'BUDGET_REVIEW_EXPIRED', 'Load a fresh budget review before confirming.');
          const snapshot = await adSetBudgetSnapshot(context, api, profileId, campaignId, body.platform, adSetId, current);
          if (snapshot.currency !== body.currency || body.version !== budgetReviewVersion(snapshot, payload.budget.amount, body.reviewExpiresAt)) fail(409, 'BUDGET_REVIEW_CHANGED', 'The proposal, budget or advertising connection changed. Load a fresh review.');
          if (Date.parse(body.reviewExpiresAt) <= Date.now() || Date.now() - Date.parse(snapshot.readAt) > 60000 || Date.parse(snapshot.readAt) > Date.now() + 30000) fail(409, 'BUDGET_REVIEW_EXPIRED', 'The review expired during its final checks. Load a fresh review before confirming.');
          claimAdSetBudget(context, snapshot, key);
          const result = await api(`/ads/ad-sets/${encodeURIComponent(adSetId)}`, {}, payload, key, 'PUT');
          try {
            if (result.budget?.amount !== payload.budget.amount || result.budget?.type !== 'daily' || result.budgetLevel !== 'adset') throw new Error('Unconfirmed budget acknowledgement.');
            const observed = await adSetBudgetSnapshot(context, api, profileId, campaignId, body.platform, adSetId, current);
            if (observed.currency !== body.currency || observed.currentAmount !== payload.budget.amount) throw new Error('The live budget differs.');
            return { budgetAcceptance: { campaignId, platform: body.platform, adSetId, accountId: observed.accountId, adAccountId: observed.adAccountId, currency: observed.currency, requestedAmount: payload.budget.amount, acknowledgedAmount: result.budget.amount, observedAmount: observed.currentAmount, readAt: observed.readAt } };
          } catch { throw new IntegrationError(502, 'AD_SET_BUDGET_NOT_CONFIRMED', 'The budget request may have applied, but its independent live budget could not be verified. Review the provider outcome before repeating it.', true); }
        }
        if (statusOnly) {
          const result = await api(`/ads/ad-sets/${encodeURIComponent(adSetId)}/status`, {}, payload, key, 'PUT');
          const rawStatus = value => value == null || typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/u.test(value);
          const reasons = Object.hasOwn(result, 'skippedReasons') ? result.skippedReasons : [];
          const expectedScope = { platform: body.platform, profileId, campaignId: campaignKey(current.campaign), platformCampaignId: campaignKey(current.campaign), adSetId, platformAdSetId: adSetId, accountId: current.accountId, adAccountId: current.adAccountId, platformAdAccountId: current.adAccountId };
          if (!['active', 'paused'].includes(result.status) || ![0, 1].includes(result.updated) || ![0, 1].includes(result.skipped) || result.updated + result.skipped !== 1 || !rawStatus(result.platformAdSetStatus) || !rawStatus(result.platformCampaignStatus) || result.statusReadAt != null && !validPostInstant(result.statusReadAt) || body.platform === 'twitter' && (result.platformAdSetStatus != null || result.statusReadAt != null) || !Array.isArray(reasons) || reasons.length > 100 || reasons.some(reason => typeof reason !== 'string' || reason.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(reason)) || Object.entries(expectedScope).some(([field, expected]) => Object.hasOwn(result, field) && (expected === undefined || (['profileId', 'accountId'].includes(field) ? reference(result[field]) : result[field]) !== expected))) throw new IntegrationError(502, 'AD_SET_STATUS_NOT_CONFIRMED', 'Zernio did not return a readable acknowledgement for this ad set switch. Check the provider before repeating it.', true);
          return { statusAcceptance: { campaignId: campaignKey(current.campaign), platform: body.platform, adSetId, requestedStatus: body.status, deliveryStatus: result.status, platformAdSetStatus: result.platformAdSetStatus ?? null, platformCampaignStatus: result.platformCampaignStatus ?? null, statusReadAt: result.statusReadAt ?? null, updated: result.updated, skipped: result.skipped, skippedReasons: reasons } };
        }
        const result = await api(`/ads/ad-sets/${encodeURIComponent(adSetId)}`, {}, payload, key, 'PUT');
        if (payload.name) {
          let refreshed;
          try { refreshed = await scopedCampaign(api, profileId, campaignKey(campaign), body.platform); }
          catch { throw new IntegrationError(502, 'AD_SET_UPDATE_NOT_CONFIRMED', 'The provider accepted the rename, but its current name could not be read. Check the provider before repeating it.', true); }
          if (refreshed.adSets?.find(item => item.platformAdSetId === adSetId)?.adSetName !== payload.name) throw new IntegrationError(502, 'AD_SET_UPDATE_NOT_CONFIRMED', 'Zernio did not confirm the ad set name. Check the provider before repeating this change.', true);
        }
        return { result: redact(result) };
      }, ['ads', body.platform, campaignKey(campaign)]);
      send(outcome.status, outcome.data); return true;
    }
    if (req.method === 'POST' && path === 'ads/campaign') {
      const metaBudget = ['facebook', 'instagram'].includes(body.platform) && Object.hasOwn(body, 'budget');
      fields(body, metaBudget ? ['campaignId', 'platform', 'budget', 'currency', 'version', 'reviewExpiresAt', 'confirmBudget'] : ['campaignId', 'platform', 'name', 'budget']);
      if (metaBudget) {
        fields(body.budget, ['amount', 'type'], 'daily campaign budget');
        if (body.budget.type !== 'daily' || body.confirmBudget !== true || typeof body.version !== 'string' || !/^[a-f0-9]{64}$/.test(body.version) || !validPostInstant(body.reviewExpiresAt)) fail(400, 'BUDGET_REVIEW_REQUIRED', 'Load and explicitly confirm a fresh campaign budget-only review.');
        const campaignId = identifier(body.campaignId, 'campaign ID'), amount = adAmount(body.budget.amount, body.currency), initial = await campaignPreflight(context, api, profileId, campaignId, body.platform);
        const outcome = await operation(context, async key => {
          const snapshot = await campaignBudgetSnapshot(context, api, profileId, campaignId, body.platform, initial);
          if (body.currency !== snapshot.currency || body.version !== budgetReviewVersion(snapshot, amount, body.reviewExpiresAt)) fail(409, 'BUDGET_REVIEW_CHANGED', 'The proposal, campaign budget or advertising connection changed. Load a fresh review.');
          if (Date.parse(body.reviewExpiresAt) <= Date.now() || Date.parse(body.reviewExpiresAt) > Date.now() + budgetReviewAge || Date.now() - Date.parse(snapshot.readAt) > 60000 || Date.parse(snapshot.readAt) > Date.now() + 30000) fail(409, 'BUDGET_REVIEW_EXPIRED', 'The campaign review expired during its final checks. Load a fresh review before confirming.');
          claimCampaignBudget(context, snapshot, key);
          const result = await api(`/ads/campaigns/${encodeURIComponent(campaignId)}`, {}, { platform: body.platform, budget: { amount, type: 'daily' } }, key, 'PUT');
          try {
            if (!Number.isSafeInteger(result.updated) || result.updated < 0 || result.budgetLevel !== 'campaign' || result.budget?.amount !== amount || result.budget?.type !== 'daily') throw new Error('Unconfirmed campaign budget acknowledgement.');
            const observed = await campaignBudgetSnapshot(context, api, profileId, campaignId, body.platform, initial);
            if (observed.currency !== body.currency || observed.currentAmount !== amount) throw new Error('The live campaign budget differs.');
            saveCampaignSnapshot(context, profileId, body.platform, campaignId, { budget: observed.currentAmount, budgetType: 'daily' });
            return { budgetAcceptance: { campaignId, platform: body.platform, adSetId: null, accountId: observed.accountId, adAccountId: observed.adAccountId, currency: observed.currency, requestedAmount: amount, acknowledgedAmount: result.budget.amount, observedAmount: observed.currentAmount, readAt: observed.readAt } };
          } catch { throw new IntegrationError(502, 'CAMPAIGN_BUDGET_NOT_CONFIRMED', 'The campaign budget request may have applied, but its independent live budget could not be verified. Review the provider outcome before repeating it.', true); }
        }, ['ads', body.platform, campaignId]);
        send(outcome.status, outcome.data); return true;
      }
      const campaignId = identifier(body.campaignId, 'campaign ID'), campaign = await scopedCampaign(api, profileId, campaignId, body.platform), payload = { platform: body.platform };
      if (['rejected', 'completed', 'cancelled', 'archived', 'deleted'].includes(campaign.status)) fail(409, 'TERMINAL_AD_STATUS', 'This campaign cannot be edited.');
      if (body.name !== undefined) { if (!['facebook', 'instagram', 'reddit'].includes(body.platform)) fail(422, 'UNSUPPORTED_AD_FIELD', 'Rename this campaign in its provider dashboard.'); payload.name = text(body.name, 'campaign name', 255); }
      if (body.budget !== undefined) {
        fields(body.budget, ['amount', 'type'], 'budget');
        if (!['facebook', 'instagram', 'google', 'openai', 'reddit'].includes(body.platform)) fail(422, 'AD_SET_BUDGET_REQUIRED', 'Use the ad set budget editor for this network.');
        if (['facebook', 'instagram'].includes(body.platform) && campaign.budgetLevel !== 'campaign') fail(422, 'AD_SET_BUDGET_REQUIRED', 'This campaign uses ad set budgets. Use its ad set budget editor.');
        const lifetime = campaign.budget?.type === 'lifetime' || campaign.campaignBudget?.type === 'lifetime';
        if (body.platform === 'openai' ? !['daily', 'lifetime'].includes(body.budget.type) || body.budget.type === 'lifetime' && !lifetime : body.budget.type !== 'daily' || lifetime) fail(400, 'UNSUPPORTED_BUDGET', body.platform === 'openai' ? 'A daily ChatGPT campaign cannot switch to lifetime. Create a new campaign for that budget type.' : 'Keep lifetime budgets in the provider dashboard.');
        payload.budget = { amount: adAmount(body.budget.amount, campaign.currency, body.platform === 'openai' ? 1 : 0), type: body.budget.type };
      }
      if (Object.keys(payload).length === 1) fail(400, 'EMPTY_AD_UPDATE', 'Enter a campaign name or daily budget to change.');
      const outcome = await operation(context, async key => {
        const result = await api(`/ads/campaigns/${encodeURIComponent(campaignId)}`, {}, payload, key, 'PUT');
        if (!Number.isInteger(result.updated) || result.updated < 0 || (payload.budget && (result.budget?.amount !== payload.budget.amount || result.budget?.type !== payload.budget.type)) || (payload.name && result.name !== payload.name)) throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not acknowledge the campaign changes.', true);
        saveCampaignSnapshot(context, profileId, body.platform, campaignId, { ...(payload.budget ? { budget: result.budget.amount, budgetType: result.budget.type } : {}), ...(payload.name ? { name: result.name } : {}) });
        return { result: redact(result) };
      }, ['ads', body.platform, campaignId]); send(outcome.status, outcome.data); return true;
    }
    if (req.method === 'POST' && ['ads/create', 'ads/validate'].includes(path)) {
      if (!CREATE_CONNECTIONS[body.platform]) fail(422, 'AD_CREATION_REQUIREMENTS', 'Choose a supported advertising network.');
      const accounts = await scopedAccounts(api, profileId);
      const account = requireAccount(accounts, identifier(body.accountId, 'account ID'));
      if (account.isActive === false) fail(409, 'ACCOUNT_UNAVAILABLE', 'Reconnect the selected advertising account first.');
      const nativeAccounts = await adAccounts(api, account._id);
      const nativeAccount = nativeAccounts.accounts.find(item => item.id === identifier(body.adAccountId, 'advertising account ID'));
      if (!nativeAccount) fail(403, 'AD_ACCOUNT_OUTSIDE_PROJECT', 'This advertising account is not available through this project connection.');
      if (nativeAccount.selectable === false) fail(409, 'AD_ACCOUNT_UNAVAILABLE', 'This advertising account cannot currently create campaigns. Check it in the provider dashboard.');
      const payload = adBody(body, account, nativeAccount);
      if (path === 'ads/validate') {
        if (body.platform !== 'openai' && !(body.platform === 'google' && ['pmax', 'demand_gen'].includes(body.campaignType))) fail(422, 'VALIDATION_UNAVAILABLE', 'Provider validation here supports ChatGPT, Google Performance Max and Demand Gen.');
        let result;
        try { result = await api('/ads/create', {}, { ...payload, validateOnly: true }); }
        catch (error) { if (error instanceof IntegrationError) error.uncertain = false; throw error; }
        if (result.validateOnly !== true || !Array.isArray(result.results) || !result.results.length || result.results.some(item => !item || typeof item.node !== 'string' || item.status !== 'validated') || result.ad) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not confirm a validation-only result.');
        send(200, { validateOnly: true, results: result.results.map(item => ({ node: item.node, status: item.status })), message: typeof result.message === 'string' ? result.message.slice(0, 2000) : 'Validation passed. No campaign was created.' }); return true;
      }
      const outcome = await operation(context, async key => {
        await validateAdLeadForm(api, profileId, body);
        const result = await api('/ads/create', {}, payload, key);
        assertCreatedAd(result.ad, body.platform, account, nativeAccount, profileId);
        const campaign = await store.create(project.id, 'campaigns', { name: payload.name, channel: 'paid', status: payload.status === 'PAUSED' ? 'paused' : result.ad.status === 'active' ? 'active' : 'draft', budget: payload.budgetAmount, budgetType: payload.budgetType, spent: 0, currency: nativeAccount.currency, platform: result.ad.platform, externalId: result.ad._id, platformCampaignId: result.ad.platformCampaignId, providerStatus: result.ad.status, zernioProfileId: profileId });
        await store.activity(project.id, `Created an advertising campaign through Zernio (${payload.status.toLowerCase()}).`);
        return { campaign, ad: redact(result.ad), provider: { id: result.ad._id, status: result.ad.status } };
      }); send(outcome.status, outcome.data); return true;
    }
    if (req.method === 'POST' && path === 'ads/boost') {
      const accounts = await scopedAccounts(api, profileId), account = requireAccount(accounts, identifier(body.accountId, 'account ID')), reddit = account.platform === 'redditads';
      if (!['facebook', 'instagram', 'twitter', 'linkedin', 'tiktok', 'pinterest', 'redditads'].includes(account.platform) || account.isActive === false) fail(400, 'BOOST_POSTING_ACCOUNT_REQUIRED', 'Choose an active publishing connection, or Reddit Ads connection, to boost a published project post.');
      if (!(reddit ? ['traffic', 'awareness', 'video_views', 'conversions', 'lead_generation'] : ['traffic', 'awareness', 'engagement', 'video_views']).includes(body.goal)) fail(400, 'UNSUPPORTED_AD_GOAL', 'Choose a supported goal for this boost.');
      const native = (await adAccounts(api, account._id)).accounts.find(item => item.id === identifier(body.adAccountId, 'advertising account ID'));
      if (!native) fail(403, 'AD_ACCOUNT_OUTSIDE_PROJECT', 'This advertising account is not connected to this project.');
      if (native.selectable === false) fail(409, 'AD_ACCOUNT_UNAVAILABLE', 'This advertising account is unavailable.');
      const payload = adBody(body, account, native, true), post = await store.get(project.id, 'posts', identifier(body.postId, 'post ID'));
      if (!post || sample(post) || !post.externalId || post.zernioProfileId !== profileId || !['published', 'partial'].includes(post.status)) fail(400, 'BOOST_PUBLISHED_POST_REQUIRED', 'Choose a published copy of a post from this project.');
      const remote = await api(`/posts/${encodeURIComponent(post.externalId)}`);
      const copy = Array.isArray(remote.post?.platforms) && remote.post.platforms.find(item => (reddit ? item.platform === 'reddit' && accounts.some(connection => connection.platform === 'reddit' && connection._id === String(item.accountId?._id || item.accountId) && connection.isActive !== false) : String(item.accountId?._id || item.accountId) === account._id && item.platform === account.platform) && item.status === 'published');
      if (remote.post?._id !== post.externalId || !['published', 'partial'].includes(remote.post.status) || !copy || copy.platformSpecificData?.isDraft || copy.platformSpecificData?.draft || copy.platformSpecificData?.tiktokSettings?.draft) fail(403, 'POST_OUTSIDE_ACCOUNT', 'This copy was not publicly published by the selected connection.');
      payload.postId = post.externalId;
      const outcome = await operation(context, async key => {
        await validateAdLeadForm(api, profileId, body);
        const result = await api('/ads/boost', {}, payload, key);
        assertCreatedAd(result.ad, body.platform, account, native, profileId);
        const campaign = await store.create(project.id, 'campaigns', { name: payload.name, channel: 'paid', status: 'paused', budget: payload.budgetAmount, budgetType: payload.budgetType, spent: 0, currency: native.currency, platform: result.ad.platform, externalId: result.ad._id, platformCampaignId: result.ad.platformCampaignId, providerStatus: result.ad.status, zernioProfileId: profileId });
        await store.activity(project.id, 'Created a paused paid boost for a published social post.'); return { campaign, ad: redact(result.ad) };
      }); send(outcome.status, outcome.data); return true;
    }
    fail(404, 'INTEGRATION_NOT_FOUND', 'This integration action was not found.');
  } catch (error) {
    send(error instanceof IntegrationError ? error.status : 500, { error: { code: error instanceof IntegrationError ? error.code : 'INTEGRATION_ERROR', message: error instanceof IntegrationError ? error.message : 'The integration could not complete this request.' } });
    return true;
  }
}
