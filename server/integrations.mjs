import { createHash, createSign, randomUUID } from 'node:crypto';

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
  try { check?.(); } catch { throw new IntegrationError(409, 'PROJECT_CONNECTION_CHANGED', uncertain ? 'The project connection changed after the provider received this action. Reconcile the previous connection.' : 'The project connection changed. Reload this project before continuing.', uncertain); }
}
async function request(url, options = {}, provider = 'Zernio', assertMapping) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !['zernio.com', 'www.googleapis.com', 'oauth2.googleapis.com'].includes(target.hostname)) fail(500, 'INVALID_PROVIDER', 'The provider endpoint is invalid.');
  checkMapping(assertMapping);
  let response;
  try { response = await fetch(target, { ...options, redirect: 'error', signal: AbortSignal.timeout(['/api/v1/ads/create', '/api/v1/ads/boost'].includes(target.pathname) ? 180000 : 20000) }); }
  catch { throw new IntegrationError(502, 'PROVIDER_UNAVAILABLE', `${provider} did not confirm the request.`, options.method && options.method !== 'GET'); }
  if (!response.ok) {
    const status = response.status === 429 ? 429 : response.status >= 500 ? 502 : 400;
    throw new IntegrationError(status, response.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_REJECTED', `${provider} ${response.status === 429 ? 'rate limit reached. Try again later.' : 'could not complete this request. Check the connection and request details.'}`, (response.status >= 500 || [408, 409].includes(response.status)) && options.method && options.method !== 'GET');
  }
  if (response.status === 204) { checkMapping(assertMapping, options.method && options.method !== 'GET'); return {}; }
  let result;
  try {
    const reader = response.body?.getReader(); const chunks = []; let length = 0;
    if (!reader) throw new Error();
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength;
      if (length > 8 * 1024 * 1024) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
    result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', `${provider} returned an unreadable response.`, options.method && options.method !== 'GET'); }
  checkMapping(assertMapping, options.method && options.method !== 'GET');
  return result;
}
function zernioClient(key, assertMapping) {
  return async (path, query = {}, body, idempotencyKey, method) => {
    const url = new URL(`${ZERNIO}${path}`);
    for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
    return request(url, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey, ...(path === '/posts' ? { 'x-request-id': idempotencyKey } : {}) } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, 'Zernio', assertMapping);
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
async function scopedAccounts(api, profileId) {
  const result = await api('/accounts', { profileId });
  if (!Array.isArray(result.accounts)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return an account list.');
  // Fail closed if Zernio ever returns an account outside the requested profile.
  return result.accounts.filter(account => String(account.profileId?._id || account.profileId) === profileId);
}
function requireAccount(accounts, accountId) {
  const account = accounts.find(item => item._id === accountId);
  if (!account) fail(403, 'ACCOUNT_OUTSIDE_PROJECT', 'This account is not connected to this project.');
  return account;
}
async function conversations(api, profileId) {
  const all = []; let cursor; let meta;
  // ponytail: cap at 1,000 conversations; add background indexed sync for larger inboxes.
  for (let page = 0; page < 10; page++) {
    const result = await api('/inbox/conversations', { profileId, limit: 100, cursor });
    if (!Array.isArray(result.data)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return conversations.');
    if (result.meta?.accountsFailed) fail(503, 'INCOMPLETE_PROVIDER_DATA', 'Some messaging accounts could not be read. Reconnect them before continuing.');
    all.push(...result.data); meta = result.meta;
    if (!result.pagination?.hasMore) return { conversations: all, pagination: { hasMore: false, nextCursor: null }, meta };
    const next = result.pagination.nextCursor;
    if (!next || next === cursor) break;
    cursor = next;
  }
  fail(503, 'INCOMPLETE_PROVIDER_DATA', 'The inbox exceeds the current sync limit. Narrow the connection before continuing.');
}
async function campaignTree(api, profileId, dates = {}) {
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
async function adAccounts(api, accountId) {
  const result = await api('/ads/accounts', { accountId, inScopeOnly: true });
  if (!Array.isArray(result.accounts)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return advertising accounts.');
  return result;
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
  const common = ['platform', 'accountId', 'adAccountId', 'name', 'goal', 'budgetAmount', 'budgetType', 'countries', 'status', 'currency', 'targeting', 'startDate', 'endDate'];
  fields(body, [...common, ...(boost ? ['postId'] : ['headline', 'body', 'linkUrl', 'imageUrl', 'video', 'carouselCards', 'callToAction', 'campaignType', 'businessName', 'images', 'additionalHeadlines', 'additionalDescriptions', 'keywords', 'advantageAudience', 'boardId', 'organizationId', 'assetGroup', 'demandGen', 'promotedObject', 'leadGenFormId', 'bidStrategy', 'bidAmount', 'creativeFormat'])]);
  const platform = body.platform, meta = ['facebook', 'instagram'].includes(platform), google = platform === 'google', advancedGoogle = google && ['pmax', 'demand_gen'].includes(body.campaignType);
  if (!CREATE_CONNECTIONS[platform]?.includes(account.platform)) fail(400, 'AD_CONNECTION_MISMATCH', 'Select a connected account for this advertising network.');
  const goals = ['traffic', 'awareness', ...(['facebook', 'instagram', 'google', 'pinterest', 'linkedin', 'tiktok', 'twitter'].includes(platform) ? ['engagement'] : []), ...(['facebook', 'instagram', 'linkedin', 'tiktok', 'reddit'].includes(platform) ? ['video_views'] : []), ...(['facebook', 'instagram', 'tiktok', 'openai', 'reddit'].includes(platform) ? ['conversions'] : []), ...(meta || platform === 'linkedin' ? ['lead_generation'] : [])];
  if (!advancedGoogle && !goals.includes(body.goal)) fail(400, 'UNSUPPORTED_AD_GOAL', 'Choose a supported goal for this network.');
  if (body.budgetType && body.budgetType !== 'daily') fail(400, 'UNSUPPORTED_BUDGET', 'This editor supports daily budgets.');
  if (body.status !== undefined && body.status !== 'PAUSED') fail(400, 'INVALID_AD_STATUS', 'New ads must start paused. Review them before activation.');
  if (body.currency && body.currency !== nativeAccount.currency) fail(400, 'CURRENCY_MISMATCH', 'The budget currency must match the advertising account.');
  const minimum = Math.max(platform === 'pinterest' ? 5 : platform === 'tiktok' ? 20 : platform === 'openai' ? 1 : 0, Number(nativeAccount.minimumDailyBudget) || 0);
  const result = { accountId: account._id, adAccountId: nativeAccount.id, name: text(body.name, 'ad name', 255), ...(!advancedGoogle ? { goal: body.goal } : {}), budgetAmount: adAmount(body.budgetAmount, nativeAccount.currency, minimum), budgetType: 'daily', countries: countries(body.countries), status: 'PAUSED' };
  if (body.targeting !== undefined) { result.targeting = adTargeting(body.targeting, platform, body.campaignType); if (result.targeting.countries) fail(400, 'INVALID_AUDIENCE', 'Set countries once using the target countries field.'); }
  for (const key of ['startDate', 'endDate']) if (body[key] !== undefined) { if (typeof body[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(body[key]) || Number.isNaN(Date.parse(body[key])) || new Date(body[key].slice(0, 10)).toISOString().slice(0, 10) !== body[key].slice(0, 10)) fail(400, 'INVALID_DATE', 'Use a valid date and time including its timezone.'); result[key] = new Date(body[key]).toISOString(); }
  if ((result.endDate && Date.parse(result.endDate) <= Date.now()) || (result.startDate && result.endDate && result.startDate >= result.endDate)) fail(400, 'INVALID_DATE', 'The end must be in the future and later than the start.');
  if (boost) return result;
  const perNetwork = google ? ['campaignType', ...(advancedGoogle ? [body.campaignType === 'pmax' ? 'assetGroup' : 'demandGen'] : ['headline', 'body', 'linkUrl', ...(body.campaignType === 'search' ? ['additionalHeadlines', 'additionalDescriptions', 'keywords'] : ['businessName', 'images'])])] : ['headline', 'body', 'linkUrl', 'imageUrl', ...(meta ? ['video', 'carouselCards', 'callToAction', 'advantageAudience', 'promotedObject', 'leadGenFormId'] : platform === 'linkedin' ? ['video', 'callToAction', 'organizationId', 'leadGenFormId'] : platform === 'reddit' ? ['video', 'carouselCards', 'callToAction', 'promotedObject', 'creativeFormat'] : platform === 'pinterest' ? ['boardId'] : platform === 'openai' ? ['promotedObject', 'bidStrategy', 'bidAmount'] : platform === 'tiktok' ? ['promotedObject'] : [])];
  if (Object.keys(body).some(key => !common.includes(key) && !perNetwork.includes(key))) fail(400, 'UNSUPPORTED_AD_FIELD', 'Use the fields for this network and ad format.');
  if (google) {
    if (!['search', 'display', 'pmax', 'demand_gen'].includes(body.campaignType)) fail(400, 'UNSUPPORTED_AD_TYPE', 'Choose Search, Display, Performance Max, or Demand Gen.');
    result.campaignType = body.campaignType;
    if (advancedGoogle) { const key = body.campaignType === 'pmax' ? 'assetGroup' : 'demandGen'; result[key] = googleAssets(body[key], body.campaignType); return result; }
  }
  const headlineLimit = google ? 30 : ({ pinterest: 100, linkedin: 400, twitter: 70, openai: 50, reddit: 300 }[platform] || 255);
  if (platform !== 'tiktok') result.headline = text(body.headline, 'headline', headlineLimit);
  result.body = text(body.body, 'ad text', google ? 90 : ({ pinterest: 500, twitter: 280, openai: 100, linkedin: 3000, tiktok: 100 }[platform] || 10000));
  if (platform === 'openai' && result.headline.length < 3) fail(400, 'INVALID_AD_COPY', 'ChatGPT ad titles need at least 3 characters.');
  const redditText = platform === 'reddit' && body.creativeFormat === 'text';
  if (body.creativeFormat !== undefined && !redditText) fail(400, 'UNSUPPORTED_AD_TYPE', 'Choose an available creative format.');
  if (redditText) { if (body.linkUrl !== undefined || body.callToAction !== undefined) fail(400, 'UNSUPPORTED_AD_FIELD', 'Reddit text ads cannot link to a website or carry a button.'); }
  else if (body.goal !== 'lead_generation') result.linkUrl = mediaUrl(body.linkUrl);
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
  } else if (['linkedin', 'reddit'].includes(platform) && body.callToAction !== undefined) { const ctas = platform === 'linkedin' ? ['LEARN_MORE', 'SIGN_UP', 'DOWNLOAD', 'SUBSCRIBE', 'REGISTER', 'JOIN', 'ATTEND', 'REQUEST_DEMO', 'VIEW_QUOTE', 'APPLY', 'SEE_MORE', 'SHOP_NOW', 'BUY_NOW'] : ['LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'CONTACT_US', 'DOWNLOAD', 'GET_QUOTE', 'SUBSCRIBE', 'APPLY_NOW', 'BOOK_NOW']; if (!ctas.includes(body.callToAction)) fail(400, 'INVALID_CALL_TO_ACTION', 'Choose an available call-to-action button.'); result.callToAction = body.callToAction; }
  if (platform === 'linkedin' && body.organizationId !== undefined) { if (!/^(urn:li:organization:)?\d+$/.test(body.organizationId)) fail(400, 'INVALID_ORGANIZATION', 'Enter a numeric LinkedIn Company Page ID.'); result.organizationId = body.organizationId; }
  if (platform === 'pinterest' && body.boardId !== undefined) result.boardId = identifier(body.boardId, 'Pinterest board ID');
  if (body.promotedObject !== undefined) { fields(body.promotedObject, platform === 'openai' ? ['customEventType'] : ['pixelId', 'customEventType'], 'conversion'); result.promotedObject = Object.fromEntries(Object.entries(body.promotedObject).map(([key, item]) => [key, text(item, 'conversion event or pixel ID')])); }
  if (body.goal === 'conversions' && platform !== 'openai' && (!result.promotedObject?.pixelId || ((meta || platform === 'reddit') && !result.promotedObject.customEventType))) fail(400, 'CONVERSION_CONFIGURATION_REQUIRED', 'Conversion campaigns need a pixel ID and conversion event.');
  if (platform === 'openai') {
    if (body.bidStrategy !== undefined && !['LOWEST_COST_WITHOUT_CAP', 'LOWEST_COST_WITH_BID_CAP', 'COST_CAP'].includes(body.bidStrategy)) fail(400, 'INVALID_BIDDING', 'Choose automatic or capped bidding.');
    if (body.bidStrategy) result.bidStrategy = body.bidStrategy;
    const capped = ['LOWEST_COST_WITH_BID_CAP', 'COST_CAP'].includes(body.bidStrategy);
    if (body.goal === 'awareness' && !capped) fail(400, 'INVALID_BIDDING', 'ChatGPT awareness ads require a fixed bid.');
    if (capped) result.bidAmount = adAmount(body.bidAmount, nativeAccount.currency); else if (body.bidAmount !== undefined) fail(400, 'INVALID_BIDDING', 'A bid amount requires capped bidding.');
  }
  return result;
}

async function scopedAds(api, profileId, query = {}) {
  const ads = []; let backfillPending = false;
  // ponytail: cap at 1,000 ads per view; use campaign filters or background sync for larger accounts.
  for (let page = 1; page <= 10; page++) {
    const result = await api('/ads', { profileId, source: 'all', page, limit: 100, ...query });
    if (!Array.isArray(result.ads)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return an ad list.');
    ads.push(...result.ads.filter(ad => String(ad.profileId?._id || ad.profileId) === profileId)); backfillPending ||= Boolean(result.backfillPending);
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
async function scopedCampaign(api, profileId, id, platform, dates = {}) {
  if (!AD_PLATFORMS.has(platform)) fail(400, 'INVALID_AD_PLATFORM', 'Choose a supported advertising platform.');
  const tree = await campaignTree(api, profileId, dates), matches = tree.campaigns.filter(item => campaignKey(item) === id && item.platform === platform), campaign = matches[0];
  if (matches.length > 1) fail(409, 'AMBIGUOUS_CAMPAIGN', 'More than one advertising account returned this campaign ID. Manage this campaign in its provider dashboard.');
  if (!campaign) fail(403, 'CAMPAIGN_OUTSIDE_PROJECT', 'This campaign is not in this project.');
  if (campaign.profileId !== undefined && String(campaign.profileId?._id || campaign.profileId) !== profileId) fail(403, 'CAMPAIGN_OUTSIDE_PROJECT', 'This campaign is not in this project.');
  return campaign;
}
function editableAd(body, ad) {
  fields(body, ['adId', 'name', 'creative', 'targeting', 'headlines', 'descriptions', 'finalUrls', 'assetGroup', 'demandGen']);
  const platform = ad.platform, google = platform === 'google', channel = String(ad.advertisingChannelType || '').toLowerCase(), payload = {};
  if (['rejected', 'completed', 'cancelled'].includes(ad.status)) fail(409, 'TERMINAL_AD_STATUS', 'A finished or rejected ad cannot be edited. Create a new ad.');
  if (body.name !== undefined) { if (!['facebook', 'instagram', 'tiktok', 'reddit'].includes(platform)) fail(422, 'UNSUPPORTED_AD_FIELD', 'Rename this ad in its provider dashboard.'); payload.name = text(body.name, 'ad name', 255); }
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
      for (const key of ['headlines', 'descriptions']) if (body[key] !== undefined) payload[key] = textList(body[key], key, channel === 'search' ? key === 'headlines' ? 3 : 2 : 1, channel === 'search' ? key === 'headlines' ? 15 : 4 : 5, key === 'headlines' ? 30 : 90).map(value => ({ text: value }));
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

export async function operation(context, action) {
  const { db, project, req, url, body } = context;
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send a unique Idempotency-Key header for this action.');
  db.exec(`CREATE TABLE IF NOT EXISTS integration_operations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL, response TEXT, http_status INTEGER, created_at TEXT NOT NULL, UNIQUE(project_id, request_key))`);
  const hash = createHash('sha256').update(canonical({ method: req.method, path: url.pathname, body })).digest('hex');
  const existing = db.prepare('SELECT * FROM integration_operations WHERE project_id = ? AND request_key = ?').get(project.id, key);
  if (existing) {
    if (existing.request_hash !== hash) fail(409, 'IDEMPOTENCY_CONFLICT', 'This action key belongs to a different request.');
    if (existing.status === 'uncertain' || existing.status === 'pending') fail(409, 'OPERATION_UNCERTAIN', 'The provider outcome needs reconciliation. This action cannot be retried automatically.');
    return { status: existing.http_status, data: JSON.parse(existing.response) };
  }
  if (db.prepare("SELECT id FROM integration_operations WHERE project_id = ? AND request_hash = ? AND status IN ('pending', 'uncertain')").get(project.id, hash)) fail(409, 'OPERATION_UNCERTAIN', 'This action has an unresolved provider outcome. Reconcile it before trying again.');
  const id = randomUUID();
  db.prepare('INSERT INTO integration_operations (id, project_id, request_key, request_hash, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, project.id, key, hash, 'pending', new Date().toISOString());
  let outcome;
  try { outcome = { status: 200, data: { operation: { id, status: 'complete' }, ...await action(key) } }; }
  catch (error) {
    const uncertain = !(error instanceof IntegrationError) || error.uncertain;
    outcome = { status: uncertain ? 409 : error.status, data: { operation: { id, status: uncertain ? 'uncertain' : 'failed' }, error: { code: uncertain ? 'OPERATION_UNCERTAIN' : error.code, message: uncertain ? 'The provider outcome needs reconciliation. Check the provider before making another attempt.' : error.message } } };
  }
  db.prepare('UPDATE integration_operations SET status = ?, response = ?, http_status = ? WHERE id = ?').run(outcome.data.operation.status, JSON.stringify(outcome.data), outcome.status, id);
  return outcome;
}
function mediaUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail(400, 'INVALID_MEDIA', 'Media must have a public HTTPS delivery URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hostname.includes(':') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/i.test(url.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname) || /\.(local|internal)$/.test(url.hostname) || ['drive.google.com', 'docs.google.com'].includes(url.hostname)) fail(400, 'INVALID_MEDIA', 'Media needs a public HTTPS delivery URL. Private Drive preview links cannot be published.');
  return url.href;
}
function publishBody(post, accounts) {
  if (sample(post)) fail(400, 'SAMPLE_RECORD', 'Sample posts cannot be sent to live providers. Create a new post.');
  const content = typeof post.content === 'string' ? post.content.trim() : '';
  if (!content || content.length > 50000) fail(400, 'INVALID_CONTENT', 'Post content is required and must be under 50,000 characters.');
  const requested = post.accounts;
  if (requested !== undefined && (!Array.isArray(requested) || requested.length === 0 || requested.length > 50 || requested.some(id => typeof id !== 'string'))) fail(400, 'INVALID_ACCOUNTS', 'Select one or more connected account IDs.');
  const platforms = post.platforms;
  if (!requested && (!Array.isArray(platforms) || !platforms.length)) fail(400, 'INVALID_PLATFORMS', 'Select a platform or connected account for this post.');
  const selected = requested ? [...new Set(requested)].map(id => requireAccount(accounts, id)) : accounts.filter(account => platforms.includes(account.platform));
  if (!selected.length || selected.some(account => account.isActive === false)) fail(400, 'ACCOUNT_UNAVAILABLE', 'A selected publishing account needs connection or reconnection.');
  if (selected.some(account => !SOCIAL_CONNECT.has(account.platform) && !['bluesky', 'telegram'].includes(account.platform))) fail(400, 'INVALID_PUBLISHING_ACCOUNT', 'Choose a social publishing account, rather than an advertising connection.');
  const result = { content, platforms: selected.map(account => ({ platform: account.platform, accountId: account._id })) };
  if (post.mediaItems !== undefined) {
    if (!Array.isArray(post.mediaItems) || post.mediaItems.length > 20) fail(400, 'INVALID_MEDIA', 'A post supports up to 20 media items.');
    result.mediaItems = post.mediaItems.map(item => {
      if (!item || !['image', 'video'].includes(item.type)) fail(400, 'INVALID_MEDIA', 'Choose image or video media.');
      return { type: item.type, url: mediaUrl(item.url) };
    });
  }
  const scheduledAt = post.scheduledAt || post.scheduledFor;
  if (scheduledAt && Number.isNaN(Date.parse(scheduledAt))) fail(400, 'INVALID_DATE', 'The post schedule is invalid.');
  if (post.status === 'scheduled' && (!scheduledAt || Date.parse(scheduledAt) <= Date.now())) fail(409, 'SCHEDULE_PASSED', 'This scheduled time has passed. Choose a new time before scheduling the post.');
  if (scheduledAt && Date.parse(scheduledAt) > Date.now()) { result.scheduledFor = new Date(scheduledAt).toISOString(); result.timezone = 'UTC'; }
  else result.publishNow = true;
  return result;
}
function localStatus(status) {
  return ['published', 'failed', 'scheduled', 'draft', 'partial'].includes(status) ? status : 'submitted';
}
async function driveToken(env, scope = 'https://www.googleapis.com/auth/drive') {
  const now = Math.floor(Date.now() / 1000);
  const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({ iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  let signature;
  try { signature = createSign('RSA-SHA256').update(unsigned).sign(env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), 'base64url'); }
  catch { fail(503, 'DRIVE_CONFIGURATION', 'The Google service account credentials need attention.'); }
  const result = await request('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString() }, 'Google Drive');
  if (typeof result.access_token !== 'string') fail(502, 'INVALID_PROVIDER_RESPONSE', 'Google Drive did not grant access.');
  return result.access_token;
}
function driveAsset(file) {
  return { name: file.name, url: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`, thumbnailUrl: file.thumbnailLink || '', kind: file.mimeType?.startsWith('image/') ? 'image' : file.mimeType?.startsWith('video/') ? 'video' : 'document', mimeType: file.mimeType, size: Number(file.size || 0), driveId: file.id, source: 'google-drive', tags: [], approval: 'pending' };
}

export { driveToken as googleToken, request as providerRequest };
async function saveDriveFiles(store, projectId, files, assertMapping) {
  const assets = await store.list(projectId, 'assets'); const saved = [];
  for (const file of files) {
    if (!file.id || file.mimeType === 'application/vnd.google-apps.folder') continue;
    const data = driveAsset(file); const existing = assets.find(asset => asset.driveId === file.id);
    checkMapping(assertMapping);
    saved.push(existing ? await store.update(projectId, 'assets', existing.id, { ...data, tags: existing.tags || [], approval: existing.approval || 'pending' }) : await store.create(projectId, 'assets', data));
  }
  return saved;
}

export async function handleIntegration(context) {
  const { req, url, body = {}, project, role, send, store } = context;
  const prefix = `/api/projects/${encodeURIComponent(project.id)}/integrations/`;
  if (!url.pathname.startsWith(prefix)) return false;
  const path = url.pathname.slice(prefix.length);
  const env = { ...(context.config?.env === undefined ? process.env : context.config.env), ...(context.config || {}) };
  try {
    if (req.method === 'GET' && path === 'status') {
      send(200, { zernio: { configured: Boolean(env.ZERNIO_API_KEY), mapped: Boolean(project.zernioProfileId) }, drive: { configured: Boolean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY), mapped: Boolean(project.driveFolderId) } }); return true;
    }
    if (!['GET', 'POST'].includes(req.method)) fail(405, 'METHOD_NOT_ALLOWED', 'This integration action does not support that method.');
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
          target.search = new URLSearchParams({ q: `'${project.driveFolderId}' in parents and trashed = false`, pageSize: '100', fields: 'nextPageToken,incompleteSearch,files(id,name,mimeType,webViewLink,thumbnailLink,size)', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true', ...(pageToken ? { pageToken } : {}) }).toString();
          const result = await driveRequest(target, { headers: { Authorization: `Bearer ${token}` } });
          if (!Array.isArray(result.files)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Google Drive did not return a file list.');
          if (result.incompleteSearch) fail(503, 'INCOMPLETE_PROVIDER_DATA', 'Google Drive could not complete the folder search. No assets were changed.');
          files.push(...result.files);
          if (!result.nextPageToken) {
            if (req.method === 'GET') send(200, { files: files.map(driveAsset), complete: true });
            else { const assets = await saveDriveFiles(store, project.id, files, assertDrive); await store.activity(project.id, `Synced ${assets.length} assets from Google Drive.`); send(200, { assets, synced: assets.length, complete: true }); }
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
        if (folder.mimeType !== 'application/vnd.google-apps.folder' || !folder.driveId) fail(409, 'SHARED_DRIVE_REQUIRED', 'Service account uploads require a folder in a Google shared drive.');
        const outcome = await operation(context, async () => {
          const boundary = `ten98-${randomUUID()}`;
          const multipart = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name, parents: [project.driveFolderId] })}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
          const file = await driveRequest(`${GOOGLE}/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id,name,mimeType,webViewLink,thumbnailLink,size`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart });
          if (!file.id) throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', 'Google Drive did not confirm the uploaded file.', true);
          const [asset] = await saveDriveFiles(store, project.id, [file], assertDrive);
          return { asset };
        }); send(outcome.status, outcome.data); return true;
      }
      fail(404, 'INTEGRATION_NOT_FOUND', 'This Drive action was not found.');
    }
    if (!env.ZERNIO_API_KEY) fail(503, 'ZERNIO_NOT_CONFIGURED', 'Configure a Zernio API key to connect providers.');
    if (!project.zernioProfileId) fail(409, 'ZERNIO_NOT_MAPPED', 'Map a Zernio profile to this project first.');
    const profileId = String(project.zernioProfileId); const api = zernioClient(env.ZERNIO_API_KEY, () => context.assertProjectMapping?.(profileId));
    if (req.method === 'GET' && path === 'connect') {
      if (!['owner', 'admin'].includes(role)) fail(403, 'ADMIN_PERMISSION_REQUIRED', 'Only a workspace administrator can connect provider accounts.');
      const platform = url.searchParams.get('platform'); const kind = url.searchParams.get('kind') || 'social';
      if (!['social', 'ads'].includes(kind)) fail(400, 'INVALID_CONNECTION_KIND', 'Choose a social or advertising connection.');
      if (!(kind === 'ads' ? ADS_CONNECT : SOCIAL_CONNECT).has(platform)) fail(422, 'CONNECTION_REQUIRES_ZERNIO', 'This network uses a credential flow or is unavailable. Connect it in the Zernio dashboard, then refresh accounts.');
      let accountId = url.searchParams.get('accountId');
      if (kind === 'ads' && platform === 'twitter') {
        const accounts = await scopedAccounts(api, profileId);
        if (!accountId) { const posting = accounts.filter(item => item.platform === 'twitter' && item.isActive !== false); if (posting.length === 1) accountId = posting[0]._id; }
        if (!accountId) fail(400, 'POSTING_ACCOUNT_REQUIRED', 'Choose an existing connected X posting account before connecting X Ads.');
        if (requireAccount(accounts, identifier(accountId, 'account ID')).platform !== 'twitter') fail(400, 'POSTING_ACCOUNT_REQUIRED', 'X Ads requires an X social posting account.');
      } else if (accountId) requireAccount(await scopedAccounts(api, profileId), identifier(accountId, 'account ID'));
      const origin = new URL(context.config?.appUrl || env.APP_URL || 'http://127.0.0.1:3000');
      if (origin.username || origin.password || (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) fail(503, 'INVALID_CALLBACK', 'Configure a valid app origin before connecting providers.');
      const callback = new URL('/', origin); callback.search = new URLSearchParams({ view: 'settings', project: project.id }).toString();
      const result = await api(`/connect/${platform}${kind === 'ads' ? '/ads' : ''}`, { profileId, redirect_url: callback.href, ...(accountId ? { accountId } : {}) });
      if (result.alreadyConnected) { send(200, { alreadyConnected: true, accountId: result.accountId }); return true; }
      let authUrl;
      try { authUrl = new URL(result.authUrl); } catch { fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return a connection URL.'); }
      if (authUrl.protocol !== 'https:' || authUrl.username || authUrl.password) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned an invalid connection URL.');
      send(200, { authUrl: authUrl.href }); return true;
    }
    if (req.method === 'GET' && path === 'accounts') {
      const accounts = await scopedAccounts(api, profileId);
      send(200, { accounts: accounts.map(account => ({ _id: account._id, platform: account.platform, username: account.username, displayName: account.displayName, profileId, isActive: account.isActive, avatar: account.avatar })) }); return true;
    }
    if (req.method === 'GET' && path === 'ads') { send(200, await campaignTree(api, profileId, dateQuery(url))); return true; }
    if (req.method === 'GET' && path === 'ads/accounts') {
      const accountId = identifier(url.searchParams.get('accountId'), 'account ID');
      requireAccount(await scopedAccounts(api, profileId), accountId);
      const result = await adAccounts(api, accountId);
      send(200, { accounts: result.accounts.map(item => ({ id: item.id, name: item.name, currency: item.currency, status: item.status, selectable: item.selectable, minimumDailyBudget: item.minimumDailyBudget })), cachedAt: result.cachedAt, stale: Boolean(result.stale) }); return true;
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
      send(200, redact(result)); return true;
    }
    if (req.method === 'GET' && path === 'ads/targeting') {
      const accountId = identifier(url.searchParams.get('accountId'), 'account ID'), account = requireAccount(await scopedAccounts(api, profileId), accountId);
      const platform = Object.keys(CREATE_CONNECTIONS).find(key => CREATE_CONNECTIONS[key].includes(account.platform));
      if (!platform || ['twitter', 'openai'].includes(platform)) fail(422, 'UNSUPPORTED_AD_TARGETING', 'Use country codes for this network.');
      const adAccountId = identifier(url.searchParams.get('adAccountId'), 'advertising account ID');
      if (!(await adAccounts(api, accountId)).accounts.some(item => item.id === adAccountId)) fail(403, 'AD_ACCOUNT_OUTSIDE_PROJECT', 'This advertising account is not in this project.');
      const dimension = url.searchParams.get('dimension') || 'geo';
      if (!['geo', 'interest', ...(platform === 'reddit' ? ['community', 'conversationKeyword'] : [])].includes(dimension)) fail(400, 'INVALID_AUDIENCE', 'Choose locations or interests to search.');
      const query = { accountId, adAccountId, dimension, q: text(url.searchParams.get('q'), 'audience search', 200), limit: 25 };
      if (url.searchParams.has('countryCode')) { const code = url.searchParams.get('countryCode'); countries([code]); query.countryCode = code; }
      if (url.searchParams.has('geoType')) { const type = url.searchParams.get('geoType'); if (!['country', 'region', 'city'].includes(type)) fail(400, 'INVALID_AUDIENCE', 'Choose a country, region or city.'); query.geoType = type; }
      send(200, redact(await api('/ads/targeting/search', query))); return true;
    }
    if (req.method === 'GET' && path === 'analytics') {
      const page = Number(url.searchParams.get('page') || 1);
      if (!Number.isInteger(page) || page < 1 || page > 1000) fail(400, 'INVALID_PAGE', 'Choose an analytics page from 1 to 1000.');
      const result = await api('/analytics', { profileId, ...dateQuery(url), page, limit: 100 });
      send(200, { ...redact(result), complete: result.pagination?.pages !== undefined ? page >= result.pagination.pages : false }); return true;
    }
    if (req.method === 'GET' && path === 'analytics/daily') { send(200, redact(await api('/analytics/daily-metrics', { profileId, ...dateQuery(url), attribution: 'received' }))); return true; }
    if (req.method === 'GET' && path === 'analytics/dashboard') {
      const dates = dateQuery(url); const toDate = dates.toDate || new Date().toISOString().slice(0, 10); const fromDate = dates.fromDate || new Date(Date.parse(toDate) - 29 * 86400000).toISOString().slice(0, 10);
      if (fromDate > toDate || Date.parse(toDate) - Date.parse(fromDate) > 366 * 86400000) fail(400, 'INVALID_DATE', 'Choose an analytics window of at most 366 days.');
      const result = await api('/analytics/dashboard', { profileId, fromDate, toDate, compare: 'previous_period' });
      const dashboard = result.data || result;
      if (!dashboard.totals || !Array.isArray(dashboard.daily)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return an analytics dashboard.');
      send(200, redact(dashboard)); return true;
    }
    if (req.method === 'GET' && path === 'inbox') { send(200, redact(await conversations(api, profileId))); return true; }
    if (req.method === 'POST' && path === 'social/publish') {
      const postId = identifier(body.postId, 'post ID'); const post = await store.get(project.id, 'posts', postId);
      if (!post) fail(404, 'POST_NOT_FOUND', 'The post was not found in this project.');
      let publishingPost = post;
      if (post.assetId && !post.mediaItems?.length) {
        const asset = await store.get(project.id, 'assets', post.assetId);
        if (!asset) fail(404, 'ASSET_NOT_FOUND', 'The attached asset was not found in this project.');
        if (sample(asset)) fail(400, 'SAMPLE_RECORD', 'Sample assets cannot be sent to live providers. Add your own asset.');
        publishingPost = { ...post, mediaItems: [{ type: asset.kind, url: asset.deliveryUrl || asset.url }] };
      }
      const accounts = await scopedAccounts(api, profileId); const payload = publishBody(publishingPost, accounts);
      const outcome = await operation(context, async key => {
        const current = await store.get(project.id, 'posts', post.id);
        if (!current) fail(404, 'POST_NOT_FOUND', 'The post was removed before it could be submitted.');
        if (current.externalId) fail(409, 'POST_ALREADY_SUBMITTED', 'This post has already been submitted. Refresh its provider status.');
        if (current.updatedAt && current.updatedAt !== post.updatedAt) fail(409, 'POST_CHANGED', 'The post changed while preparing publication. Review it and submit again.');
        if (current.status === 'scheduled' && Date.parse(payload.scheduledFor) <= Date.now()) fail(409, 'SCHEDULE_PASSED', 'This scheduled time has passed. Choose a new time before scheduling the post.');
        const result = await api('/posts', {}, payload, key);
        if (!result.post?._id) throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not confirm the submitted post.', true);
        const updated = await store.update(project.id, 'posts', post.id, { externalId: result.post._id, zernioProfileId: profileId, status: localStatus(result.post.status), providerStatus: result.post.status, providerResults: redact(result.post.platforms || []) });
        if (!updated) throw new IntegrationError(409, 'POST_REMOVED', 'The post was removed while Zernio accepted it. Reconcile the provider outcome.', true);
        await store.activity(project.id, 'Submitted a social post to Zernio.');
        return { post: updated, provider: { id: result.post._id, status: result.post.status } };
      }); send(outcome.status, outcome.data); return true;
    }
    if (req.method === 'GET' && path === 'social/status') {
      const post = await store.get(project.id, 'posts', identifier(url.searchParams.get('postId'), 'post ID'));
      if (!post?.externalId || post.zernioProfileId !== profileId) fail(404, 'POST_NOT_SUBMITTED', 'No submitted post was found for this project.');
      const result = await api(`/posts/${encodeURIComponent(post.externalId)}`);
      const accounts = await scopedAccounts(api, profileId);
      if (result.post?._id !== post.externalId || !Array.isArray(result.post.platforms) || !result.post.platforms.length) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return the submitted post.');
      for (const item of result.post.platforms) requireAccount(accounts, typeof item.accountId === 'object' ? item.accountId._id : item.accountId);
      const updated = await store.update(project.id, 'posts', post.id, { status: localStatus(result.post.status), providerStatus: result.post.status, providerResults: redact(result.post.platforms) });
      send(200, { post: updated, provider: { id: post.externalId, status: result.post.status } }); return true;
    }
    const inboxMatch = /^inbox\/([^/]+)\/(messages|reply|resolve)$/.exec(path);
    if (inboxMatch) {
      const conversationId = identifier(decodeURIComponent(inboxMatch[1]), 'conversation ID');
      const accountId = identifier(req.method === 'GET' ? url.searchParams.get('accountId') : body.accountId, 'account ID');
      const accounts = await scopedAccounts(api, profileId); requireAccount(accounts, accountId);
      const listed = await conversations(api, profileId);
      if (!listed.conversations.some(item => item.id === conversationId && item.accountId === accountId)) fail(403, 'CONVERSATION_OUTSIDE_PROJECT', 'This conversation is not in this project.');
      const endpoint = `/inbox/conversations/${encodeURIComponent(conversationId)}`;
      if (req.method === 'GET' && inboxMatch[2] === 'messages') {
        const cursor = url.searchParams.get('cursor'); if (cursor && cursor.length > 4000) fail(400, 'INVALID_CURSOR', 'The message cursor is invalid.');
        const result = await api(`${endpoint}/messages`, { accountId, limit: 100, sortOrder: 'desc', cursor });
        const messages = result.messages || result.data?.messages || result.data;
        if (!Array.isArray(messages)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return conversation messages.');
        send(200, { messages: redact([...messages].reverse()), pagination: redact(result.pagination || result.data?.pagination || {}), sortOrder: 'asc' }); return true;
      }
      if (req.method === 'POST' && ['reply', 'resolve'].includes(inboxMatch[2])) {
        const message = inboxMatch[2] === 'reply' ? text(body.message, 'message', 10000) : undefined;
        const outcome = await operation(context, async key => ({ result: redact(await api(inboxMatch[2] === 'reply' ? `${endpoint}/messages` : endpoint, {}, inboxMatch[2] === 'reply' ? { accountId, message } : { accountId, status: 'archived' }, key, inboxMatch[2] === 'reply' ? 'POST' : 'PUT')) }));
        send(outcome.status, outcome.data); return true;
      }
      fail(405, 'METHOD_NOT_ALLOWED', 'This inbox action does not support that method.');
    }
    if (req.method === 'POST' && path === 'ads/status') {
      fields(body, ['campaignId', 'platform', 'status']);
      const campaignId = identifier(body.campaignId, 'campaign ID');
      if (!AD_PLATFORMS.has(body.platform) || !['active', 'paused'].includes(body.status)) fail(400, 'INVALID_AD_STATUS', 'Choose a valid ad platform and active or paused status.');
      const campaign = await scopedCampaign(api, profileId, campaignId, body.platform);
      if (['rejected', 'completed', 'cancelled'].includes(campaign.status)) fail(409, 'TERMINAL_AD_STATUS', 'This campaign cannot resume. Create a new campaign.');
      const outcome = await operation(context, async key => {
        const result = await api(`/ads/campaigns/${encodeURIComponent(campaignId)}/status`, {}, { status: body.status, platform: body.platform }, key, 'PUT');
        if (['pinterest', 'linkedin', 'twitter'].includes(body.platform)) {
          if (result.status !== body.status || ![0, 1].includes(result.updated) || ![0, 1].includes(result.skipped) || result.updated + result.skipped !== 1) throw new IntegrationError(502, 'AD_STATUS_NOT_CONFIRMED', 'The provider did not acknowledge this status request.', true);
          return { result: redact(result), requestedStatus: body.status, verification: 'unavailable' };
        }
        const actual = String(result.platformCampaignStatus || '').toUpperCase(), expected = body.status === 'active' ? ['ACTIVE', 'ENABLE', 'ENABLED'] : ['PAUSED', 'DISABLE', 'DISABLED', 'DRAFT'];
        if (!result.statusReadAt || !expected.includes(actual)) throw new IntegrationError(502, 'AD_STATUS_NOT_CONFIRMED', 'The campaign switch was not confirmed by the provider.', true);
        return { result: redact(result), requestedStatus: body.status, verification: 'confirmed' };
      });
      send(outcome.status, outcome.data); return true;
    }
    if (req.method === 'POST' && ['ads/edit', 'ads/ad-status'].includes(path)) {
      const ad = await scopedAd(api, profileId, identifier(body.adId, 'ad ID'));
      let payload;
      if (path === 'ads/ad-status') {
        fields(body, ['adId', 'status']);
        if (!['active', 'paused'].includes(body.status)) fail(400, 'INVALID_AD_STATUS', 'Choose active or paused.');
        if (['rejected', 'completed', 'cancelled'].includes(ad.status)) fail(409, 'TERMINAL_AD_STATUS', 'This ad cannot resume. Create a new ad.');
        if (ad.platform === 'twitter') fail(422, 'AD_SET_STATUS_REQUIRED', 'X uses one switch for the entire ad set. Change that switch in X Ads Manager.');
        payload = { status: body.status };
      } else payload = editableAd(body, ad);
      const outcome = await operation(context, async key => {
        const result = await api(`/ads/${encodeURIComponent(ad._id)}${path === 'ads/ad-status' ? '/status' : ''}`, {}, payload, key, 'PUT');
        if (path === 'ads/ad-status') { if (String(result.configuredStatus || '').toUpperCase() !== body.status.toUpperCase()) throw new IntegrationError(502, 'AD_STATUS_NOT_CONFIRMED', 'The ad switch was not confirmed by the provider.', true); }
        else if (result.ad?._id !== ad._id) throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not confirm the edited ad.', true);
        return { result: redact(result) };
      }); send(outcome.status, outcome.data); return true;
    }
    if (req.method === 'POST' && path === 'ads/adset') {
      fields(body, ['campaignId', 'platform', 'adSetId', 'name', 'budget']);
      const campaign = await scopedCampaign(api, profileId, identifier(body.campaignId, 'campaign ID'), body.platform);
      const adSetId = identifier(body.adSetId, 'ad set ID'), adSet = campaign.adSets?.find(item => item.platformAdSetId === adSetId);
      if (!adSet) fail(403, 'AD_SET_OUTSIDE_PROJECT', 'This ad set was not found in the selected project campaign.');
      const payload = { platform: body.platform };
      if (body.name !== undefined) payload.name = text(body.name, 'ad set name', 255);
      if (body.budget !== undefined) { fields(body.budget, ['amount', 'type'], 'budget'); if (body.budget.type !== 'daily') fail(400, 'UNSUPPORTED_BUDGET', 'This editor changes daily budgets.'); if (body.platform === 'google' || campaign.budgetLevel === 'campaign') fail(422, 'CAMPAIGN_BUDGET_REQUIRED', 'This budget belongs to the campaign. Use the campaign budget editor.'); if (adSet.budget?.type === 'lifetime') fail(400, 'UNSUPPORTED_BUDGET', 'Keep lifetime budgets in the provider dashboard.'); payload.budget = { amount: adAmount(body.budget.amount, campaign.currency, body.platform === 'tiktok' ? 20 : body.platform === 'pinterest' ? 5 : 0), type: 'daily' }; }
      if (Object.keys(payload).length === 1) fail(400, 'EMPTY_AD_UPDATE', 'Enter a name or daily budget to update.');
      const outcome = await operation(context, async key => ({ result: redact(await api(`/ads/ad-sets/${encodeURIComponent(adSetId)}`, {}, payload, key, 'PUT')) }));
      send(outcome.status, outcome.data); return true;
    }
    if (req.method === 'POST' && path === 'ads/campaign') {
      fields(body, ['campaignId', 'platform', 'name', 'budget']);
      const campaignId = identifier(body.campaignId, 'campaign ID'), campaign = await scopedCampaign(api, profileId, campaignId, body.platform), payload = { platform: body.platform };
      if (body.name !== undefined) { if (!['facebook', 'instagram', 'reddit'].includes(body.platform)) fail(422, 'UNSUPPORTED_AD_FIELD', 'Rename this campaign in its provider dashboard.'); payload.name = text(body.name, 'campaign name', 255); }
      if (body.budget !== undefined) {
        fields(body.budget, ['amount', 'type'], 'budget');
        if (!['facebook', 'instagram', 'google', 'openai', 'reddit'].includes(body.platform)) fail(422, 'AD_SET_BUDGET_REQUIRED', 'Use the ad set budget editor for this network.');
        if (['facebook', 'instagram'].includes(body.platform) && campaign.budgetLevel !== 'campaign') fail(422, 'AD_SET_BUDGET_REQUIRED', 'This campaign uses ad set budgets. Use its ad set budget editor.');
        if (body.budget.type !== 'daily' || campaign.budget?.type === 'lifetime') fail(400, 'UNSUPPORTED_BUDGET', 'Keep lifetime budgets in the provider dashboard.');
        payload.budget = { amount: adAmount(body.budget.amount, campaign.currency), type: 'daily' };
      }
      if (Object.keys(payload).length === 1) fail(400, 'EMPTY_AD_UPDATE', 'Enter a campaign name or daily budget to change.');
      const outcome = await operation(context, async key => {
        const result = await api(`/ads/campaigns/${encodeURIComponent(campaignId)}`, {}, payload, key, 'PUT');
        if (!Number.isInteger(result.updated) || result.updated < 0 || (payload.budget && (result.budget?.amount !== payload.budget.amount || result.budget?.type !== 'daily'))) throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not acknowledge the campaign changes.', true);
        return { result: redact(result) };
      }); send(outcome.status, outcome.data); return true;
    }
    if (req.method === 'POST' && path === 'ads/create') {
      if (!CREATE_CONNECTIONS[body.platform]) fail(422, 'AD_CREATION_REQUIREMENTS', 'Choose a supported advertising network.');
      const accounts = await scopedAccounts(api, profileId);
      const account = requireAccount(accounts, identifier(body.accountId, 'account ID'));
      if (account.isActive === false) fail(409, 'ACCOUNT_UNAVAILABLE', 'Reconnect the selected advertising account first.');
      const nativeAccounts = await adAccounts(api, account._id);
      const nativeAccount = nativeAccounts.accounts.find(item => item.id === identifier(body.adAccountId, 'advertising account ID'));
      if (!nativeAccount) fail(403, 'AD_ACCOUNT_OUTSIDE_PROJECT', 'This advertising account is not available through this project connection.');
      if (nativeAccount.selectable === false) fail(409, 'AD_ACCOUNT_UNAVAILABLE', 'This advertising account cannot currently create campaigns. Check it in the provider dashboard.');
      const payload = adBody(body, account, nativeAccount);
      const outcome = await operation(context, async key => {
        const result = await api('/ads/create', {}, payload, key);
        if (!result.ad?._id || !result.ad.platformCampaignId) throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not confirm the created ad.', true);
        const campaign = await store.create(project.id, 'campaigns', { name: payload.name, channel: 'paid', status: payload.status === 'PAUSED' ? 'paused' : result.ad.status === 'active' ? 'active' : 'draft', budget: payload.budgetAmount, budgetType: 'daily', spent: 0, currency: nativeAccount.currency, platform: result.ad.platform, externalId: result.ad._id, platformCampaignId: result.ad.platformCampaignId, providerStatus: result.ad.status, zernioProfileId: profileId });
        await store.activity(project.id, `Created an advertising campaign through Zernio (${payload.status.toLowerCase()}).`);
        return { campaign, ad: redact(result.ad), provider: { id: result.ad._id, status: result.ad.status } };
      }); send(outcome.status, outcome.data); return true;
    }
    if (req.method === 'POST' && path === 'ads/boost') {
      const account = requireAccount(await scopedAccounts(api, profileId), identifier(body.accountId, 'account ID'));
      if (!['facebook', 'instagram', 'twitter', 'linkedin', 'tiktok', 'pinterest'].includes(account.platform) || account.isActive === false) fail(400, 'BOOST_POSTING_ACCOUNT_REQUIRED', 'Choose an active social publishing connection to boost its published post.');
      if (!['traffic', 'awareness', 'engagement', 'video_views'].includes(body.goal)) fail(400, 'UNSUPPORTED_AD_GOAL', 'Choose traffic, awareness, engagement, or video views for this boost.');
      const native = (await adAccounts(api, account._id)).accounts.find(item => item.id === identifier(body.adAccountId, 'advertising account ID'));
      if (!native) fail(403, 'AD_ACCOUNT_OUTSIDE_PROJECT', 'This advertising account is not connected to this project.');
      if (native.selectable === false) fail(409, 'AD_ACCOUNT_UNAVAILABLE', 'This advertising account is unavailable.');
      const payload = adBody(body, account, native, true), post = await store.get(project.id, 'posts', identifier(body.postId, 'post ID'));
      if (!post || sample(post) || !post.externalId || post.zernioProfileId !== profileId || post.status !== 'published') fail(400, 'BOOST_PUBLISHED_POST_REQUIRED', 'Choose a published post from this project.');
      const remote = await api(`/posts/${encodeURIComponent(post.externalId)}`);
      if (remote.post?._id !== post.externalId || remote.post.status !== 'published' || !Array.isArray(remote.post.platforms) || !remote.post.platforms.some(item => String(item.accountId?._id || item.accountId) === account._id && item.status === 'published')) fail(403, 'POST_OUTSIDE_ACCOUNT', 'This post was not published by the selected connection.');
      payload.postId = post.externalId;
      const outcome = await operation(context, async key => {
        const result = await api('/ads/boost', {}, payload, key);
        if (!result.ad?._id || !result.ad.platformCampaignId) throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not confirm the boosted ad.', true);
        const campaign = await store.create(project.id, 'campaigns', { name: payload.name, channel: 'paid', status: 'paused', budget: payload.budgetAmount, budgetType: 'daily', spent: 0, currency: native.currency, platform: body.platform, externalId: result.ad._id, platformCampaignId: result.ad.platformCampaignId, providerStatus: result.ad.status, zernioProfileId: profileId });
        await store.activity(project.id, 'Created a paused paid boost for a published social post.'); return { campaign, ad: redact(result.ad) };
      }); send(outcome.status, outcome.data); return true;
    }
    fail(404, 'INTEGRATION_NOT_FOUND', 'This integration action was not found.');
  } catch (error) {
    send(error instanceof IntegrationError ? error.status : 500, { error: { code: error instanceof IntegrationError ? error.code : 'INTEGRATION_ERROR', message: error instanceof IntegrationError ? error.message : 'The integration could not complete this request.' } });
    return true;
  }
}
