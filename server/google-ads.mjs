import { IntegrationError, operation, redact, scopedAccounts, requireAccount, campaignTree, adAccounts } from './integrations.mjs';
import { publicMediaUrl } from '../shared/social-posts.mjs';

const fail = (status, code, message) => { throw new IntegrationError(status, code, message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const label = value => value == null || typeof value === 'string' && value.length <= 2000;
const count = value => value == null || typeof value === 'number' && Number.isFinite(value) && value >= 0 || typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) && value.length <= 30 && Number.isFinite(Number(value));
function text(value, name, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) fail(400, 'INVALID_INPUT', `Enter a valid ${name}.`);
  return value.trim();
}
function id(value, name) { const result = text(value, name, 500); if (/\s/.test(result)) fail(400, 'INVALID_INPUT', `Choose a valid ${name}.`); return result; }
function fields(value, allowed) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'UNSUPPORTED_GOOGLE_FIELD', 'Use only the supported Google Ads fields.'); }
function keywords(value, minimum = 1, maximum = 1000) {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(400, 'INVALID_KEYWORDS', `Enter ${minimum} to ${maximum} keywords.`);
  const rows = value.map(item => {
    if (typeof item === 'string') return { text: text(item, 'keyword', 80), matchType: 'broad' };
    fields(item, ['text', 'matchType']);
    if (!['exact', 'phrase', 'broad'].includes(item.matchType)) fail(400, 'INVALID_KEYWORDS', 'Choose exact, phrase or broad matching.');
    return { text: text(item.text, 'keyword', 80), matchType: item.matchType };
  });
  if (new Set(rows.map(item => item.text.toLowerCase() + ':' + item.matchType)).size !== rows.length) fail(400, 'DUPLICATE_KEYWORDS', 'Each keyword and match type must be distinct.');
  return rows;
}
const keywordKey = row => `${String(row.text ?? row.keyword).trim().toLowerCase()}:${row.matchType}`;
function sameKeywords(actual, expected) { return actual.length === expected.length && new Set(actual.map(keywordKey)).size === expected.length && expected.every(row => actual.some(item => keywordKey(item) === keywordKey(row))); }
function confirmed(check, message) { if (!check) throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', message, true); }
const scopeId = value => String(value?._id || value?.id || value);
function scope(row, profileId, accountId, adAccountId) {
  return object(row) && (row.profileId === undefined || scopeId(row.profileId) === profileId) && (row.accountId === undefined || scopeId(row.accountId) === accountId) && (row.adAccountId === undefined || String(row.adAccountId) === adAccountId) && (row.platformAdAccountId === undefined || String(row.platformAdAccountId) === adAccountId) && (row.platform === undefined || row.platform === 'google');
}
function cursor(value) { return value ? text(value, 'page cursor', 4000) : undefined; }
function pageNumber(value) { const page = Number(value || 1); if (!Number.isSafeInteger(page) || page < 1 || page > 1000) fail(400, 'INVALID_PAGE', 'Choose a page from 1 to 1000.'); return page; }
function countries(value) { if (!Array.isArray(value) || !value.length || value.length > 50 || value.some(item => typeof item !== 'string' || !/^[A-Z]{2}$/.test(item))) fail(400, 'INVALID_COUNTRIES', 'Use two-letter uppercase country codes.'); return [...new Set(value)]; }
function dates(url) {
  const toDate = url.searchParams.get('toDate') || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(toDate) || !Number.isFinite(Date.parse(toDate))) fail(400, 'INVALID_DATE', 'Choose a valid report end date.');
  const fromDate = url.searchParams.get('fromDate') || new Date(Date.parse(toDate) - 29 * 86400000).toISOString().slice(0, 10);
  if ([fromDate, toDate].some(value => !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) || fromDate > toDate || Date.parse(toDate) - Date.parse(fromDate) >= 366 * 86400000) fail(400, 'INVALID_DATE', 'Choose a valid reporting window of at most 366 days.');
  return { fromDate, toDate };
}
function targeting(value) {
  fields(value, ['locations', 'excludedLocations', 'languages', 'devices', 'locationTargetingType']);
  if (!Object.keys(value).length) fail(400, 'EMPTY_GOOGLE_UPDATE', 'Choose targeting settings to replace.');
  const result = {};
  for (const key of ['locations', 'excludedLocations']) if (value[key] !== undefined) {
    if (Array.isArray(value[key])) result[key] = value[key].length ? countries(value[key]) : [];
    else {
      fields(value[key], ['countries', 'regions', 'cities', 'zips', 'metros']); result[key] = {};
      for (const [kind, items] of Object.entries(value[key])) {
        if (kind === 'countries') { if (!Array.isArray(items)) fail(400, 'INVALID_COUNTRIES', 'Use a list of country codes.'); result[key][kind] = items.length ? countries(items) : []; }
        else { if (!Array.isArray(items) || items.length > 100 || items.some(item => typeof item !== 'string' || !/^\d{1,15}$/.test(item))) fail(400, 'INVALID_LOCATION', 'Use location IDs returned by Google audience search.'); result[key][kind] = [...new Set(items)]; }
      }
    }
    if (key === 'locations' && !Object.values(result[key]).flat().length) fail(400, 'INVALID_LOCATION', 'Target at least one location. Omit locations to preserve them.');
  }
  if (value.languages !== undefined) { if (!Array.isArray(value.languages) || value.languages.length > 50 || value.languages.some(item => typeof item !== 'string' || !/^[a-z]{2,3}(?:_[A-Z]{2})?$/.test(item))) fail(400, 'INVALID_LANGUAGE', 'Use Google language codes such as en or zh_CN.'); result.languages = [...new Set(value.languages)]; }
  if (value.devices !== undefined) { if (!Array.isArray(value.devices) || !value.devices.length || value.devices.length > 4 || value.devices.some(item => !['MOBILE', 'DESKTOP', 'TABLET', 'CONNECTED_TV'].includes(item)) || new Set(value.devices).size !== value.devices.length) fail(400, 'INVALID_DEVICES', 'Choose at least one distinct device type.'); result.devices = value.devices; }
  if (value.locationTargetingType !== undefined) { if (!['presence', 'presence_or_interest'].includes(value.locationTargetingType)) fail(400, 'INVALID_LOCATION', 'Choose presence or presence and interest.'); result.locationTargetingType = value.locationTargetingType; }
  return result;
}
function validTargeting(result) { const geo = row => object(row) && typeof row.geoTargetId === 'string' && label(row.name) && label(row.countryCode) && (row.negative === undefined || typeof row.negative === 'boolean'); return object(result) && ['locations', 'languages', 'devices'].every(key => Array.isArray(result[key]) && result[key].length <= 1000) && result.locations.every(geo) && (result.excludedLocations === undefined || Array.isArray(result.excludedLocations) && result.excludedLocations.length <= 1000 && result.excludedLocations.every(geo)) && result.languages.every(row => object(row) && typeof row.code === 'string' && label(row.name)) && result.devices.every(row => object(row) && ['MOBILE', 'DESKTOP', 'TABLET', 'CONNECTED_TV', 'OTHER', 'UNKNOWN'].includes(row.device) && typeof row.included === 'boolean' && count(row.bidModifier)) && (result.locationTargetingType === undefined || ['presence', 'presence_or_interest'].includes(result.locationTargetingType)); }

export async function handleGoogleAds(context, api, profileId, action) {
  const { req, url, body, send } = context, write = req.method === 'POST', values = write ? body : Object.fromEntries(url.searchParams);
  const accountId = id(values.accountId, 'Google connection'), adAccountId = id(values.adAccountId, 'Google advertising account');
  const account = requireAccount(await scopedAccounts(api, profileId), accountId);
  if (account.platform !== 'googleads' || account.isActive === false) fail(409, 'GOOGLE_ACCOUNT_REQUIRED', 'Choose an active Google Ads connection.');
  const native = (await adAccounts(api, accountId)).accounts.find(row => String(row.id) === adAccountId);
  if (!native) fail(403, 'AD_ACCOUNT_OUTSIDE_PROJECT', 'This Google advertising account is not available in this project.');
  if (write && native.selectable === false) fail(409, 'ACCOUNT_UNAVAILABLE', 'This advertising account cannot accept changes.');
  const query = { accountId, adAccountId, profileId };
  let campaign, campaignId;
  if (action === 'campaigns' || values.campaignId) {
    const tree = await campaignTree(api, profileId, { ...query, platform: 'google' });
    const campaigns = tree.campaigns.filter(row => row.platform === 'google' && row.accountId !== undefined && scopeId(row.accountId) === accountId && String(row.platformAdAccountId) === adAccountId);
    if (action === 'campaigns' && !write) { send(200, { campaigns, complete: tree.complete, backfillPending: tree.backfillPending }); return true; }
    campaignId = id(values.campaignId, 'Google campaign');
    const matches = campaigns.filter(row => String(row.platformCampaignId) === campaignId);
    if (matches.length !== 1) fail(403, 'CAMPAIGN_OUTSIDE_PROJECT', 'This campaign is not uniquely available in the selected Google advertising account.');
    campaign = matches[0];
  }
  const requireCampaign = () => { if (!campaign) fail(400, 'GOOGLE_CAMPAIGN_REQUIRED', 'Choose a Google campaign first.'); };
  const groupId = values.adSetId ? id(values.adSetId, 'Google ad group') : undefined;
  if (groupId && (!campaign || !campaign.adSets?.some(row => String(row.platformAdSetId) === groupId))) fail(403, 'AD_GROUP_OUTSIDE_CAMPAIGN', 'Choose an ad group belonging to this Google campaign.');
  async function readKeywords(page = 1) {
    const result = await api('/ads/keywords', { ...query, ...(campaignId ? { campaignId } : {}), ...(groupId ? { adSetId: groupId } : {}), page, limit: 100 });
    if (!Array.isArray(result.keywords) || result.keywords.length > 100 || result.keywords.some(row => !scope(row, profileId, accountId, adAccountId) || row.accountId === undefined || row.adAccountId !== adAccountId || typeof row.id !== 'string' || !row.id || typeof row.keyword !== 'string' || !row.keyword || typeof row.adSetId !== 'string' || typeof row.campaignId !== 'string' || !label(row.adSetName) || !label(row.campaignName) || !label(row.status) || row.qualityScore != null && (!Number.isInteger(row.qualityScore) || row.qualityScore < 1 || row.qualityScore > 10) || typeof row.negative !== 'boolean' || !['exact', 'phrase', 'broad', 'unknown'].includes(row.matchType) || campaignId && row.campaignId !== campaignId || groupId && row.adSetId !== groupId)) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned invalid or unscoped Google keywords.');
    const total = result.pagination?.total, pages = result.pagination?.pages;
    if (!Number.isSafeInteger(total) || total < 0 || !Number.isSafeInteger(pages) || pages < 0 || result.pagination?.page !== page || total < result.keywords.length) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not confirm keyword pagination.');
    return redact(result);
  }
  if (!write && action === 'keywords') { send(200, await readKeywords(pageNumber(values.page))); return true; }
  if (!write && action === 'search-terms') {
    const result = await api('/ads/search-terms', { accountId, adAccountId, ...dates(url), ...(campaignId ? { campaignId } : {}), ...(groupId ? { adSetId: groupId } : {}), pageToken: cursor(values.pageToken) });
    if (result.customerId !== adAccountId || !Array.isArray(result.data) || result.data.length > 10000 || result.data.some(row => !object(row) || typeof row.searchTerm !== 'string' || !label(row.campaignName) || !label(row.adGroupName) || !label(row.status) || !label(row.campaignId) || !label(row.adGroupId) || ['clicks', 'impressions', 'costMicros', 'conversions'].some(field => !count(row[field])) || campaignId && row.campaignId !== campaignId || groupId && row.adGroupId !== groupId) || result.paging?.nextPageToken !== undefined && (typeof result.paging.nextPageToken !== 'string' || result.paging.nextPageToken.length > 4000)) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio did not return readable search terms for this advertising account.');
    if (result.paging?.nextPageToken && result.paging.nextPageToken === values.pageToken) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Google repeated the same search report page cursor.');
    send(200, redact(result)); return true;
  }
  if (action === 'planner' && write) {
    fields(body, ['accountId', 'adAccountId', 'mode', 'keywords', 'seedUrl', 'countries', 'languageConstantId', 'network', 'pageToken']);
    if (!['ideas', 'history'].includes(body.mode)) fail(400, 'INVALID_PLANNER', 'Choose keyword ideas or historical metrics.');
    const payload = { accountId, adAccountId, network: body.network || 'GOOGLE_SEARCH' };
    if (!['GOOGLE_SEARCH', 'GOOGLE_SEARCH_AND_PARTNERS'].includes(payload.network)) fail(400, 'INVALID_PLANNER', 'Choose Google Search or Search and partners.');
    if (body.keywords !== undefined) { const rows = keywords(body.keywords, 1, body.mode === 'ideas' ? 20 : 1000); payload[body.mode === 'ideas' ? 'seedKeywords' : 'keywords'] = rows.map(row => row.text); }
    if (body.seedUrl !== undefined) { if (body.mode !== 'ideas') fail(400, 'INVALID_PLANNER', 'Seed pages apply only to keyword ideas.'); try { payload.seedUrl = publicMediaUrl(body.seedUrl); } catch { fail(400, 'INVALID_URL', 'Enter a public HTTPS page for keyword ideas.'); } }
    if (!payload.keywords && !payload.seedKeywords && !payload.seedUrl) fail(400, 'INVALID_PLANNER', 'Enter keywords or a seed page to research.');
    if (body.countries !== undefined) { payload.countries = countries(body.countries); if (payload.countries.length > 10) fail(400, 'INVALID_COUNTRIES', 'Choose up to ten countries for Keyword Planner.'); }
    if (body.languageConstantId) { payload.languageConstantId = id(body.languageConstantId, 'Google language ID'); if (!/^\d{1,10}$/.test(payload.languageConstantId)) fail(400, 'INVALID_LANGUAGE', 'Use a numeric Google language ID.'); }
    if (body.mode === 'ideas') { payload.pageSize = 100; if (body.pageToken) payload.pageToken = cursor(body.pageToken); } else payload.includeAverageCpc = true;
    const result = await api(`/ads/keywords/${body.mode === 'ideas' ? 'ideas' : 'historical-metrics'}`, {}, payload);
    if (result.customerId !== adAccountId || !Array.isArray(result.data) || result.data.length > 1000 || result.data.some(row => { const metrics = row?.keywordIdeaMetrics ?? row?.keywordMetrics; return !object(row) || typeof row.text !== 'string' || metrics !== undefined && (!object(metrics) || !label(metrics.competition) || ['avgMonthlySearches', 'lowTopOfPageBidMicros', 'highTopOfPageBidMicros', 'averageCpcMicros'].some(key => !count(metrics[key]))); }) || result.paging?.nextPageToken !== undefined && (typeof result.paging.nextPageToken !== 'string' || result.paging.nextPageToken.length > 4000)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return readable Keyword Planner results for this account.');
    if (result.paging?.nextPageToken && result.paging.nextPageToken === body.pageToken) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Google repeated the same Keyword Planner page cursor.');
    send(200, { ...redact(result), currency: native.currency }); return true;
  }
  if (['negatives', 'targeting', 'bidding'].includes(action)) {
    requireCampaign();
    const endpoint = `/ads/campaigns/${encodeURIComponent(campaignId)}/${action === 'negatives' ? 'negative-keywords' : action}`;
    if (!write) {
      const result = await api(endpoint, { accountId, adAccountId, platform: 'google' });
      if (action === 'negatives' && (!Array.isArray(result.keywords) || result.keywords.length > 1000 || result.keywords.some(row => !object(row) || typeof row.text !== 'string' || !['exact', 'phrase', 'broad'].includes(row.matchType))) || action === 'targeting' && !validTargeting(result) || action === 'bidding' && (String(result.campaignId) !== campaignId || typeof result.biddingStrategyType !== 'string')) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return readable campaign settings.');
      send(200, redact(result)); return true;
    }
    if (body.confirmChange !== true) fail(400, 'GOOGLE_CONFIRMATION_REQUIRED', 'Confirm this campaign-wide change.');
    let payload;
    if (action === 'negatives') { fields(body, ['accountId', 'adAccountId', 'campaignId', 'keywords', 'confirmChange']); payload = { platform: 'google', keywords: keywords(body.keywords, 0) }; }
    if (action === 'targeting') { fields(body, ['accountId', 'adAccountId', 'campaignId', 'targeting', 'confirmChange']); payload = { platform: 'google', targeting: targeting(body.targeting) }; }
    if (action === 'bidding') {
      fields(body, ['accountId', 'adAccountId', 'campaignId', 'bidStrategy', 'bidAmount', 'roasAverageFloor', 'confirmChange']);
      if (!['LOWEST_COST_WITHOUT_CAP', 'COST_CAP', 'LOWEST_COST_WITH_MIN_ROAS', 'LOWEST_COST_WITH_BID_CAP'].includes(body.bidStrategy)) fail(400, 'INVALID_BIDDING', 'Choose a supported Google bid strategy.');
      payload = { platform: 'google', bidStrategy: body.bidStrategy };
      const parameter = body.bidStrategy === 'LOWEST_COST_WITH_MIN_ROAS' ? 'roasAverageFloor' : ['COST_CAP', 'LOWEST_COST_WITH_BID_CAP'].includes(body.bidStrategy) ? 'bidAmount' : null;
      for (const key of ['bidAmount', 'roasAverageFloor']) if (key !== parameter && body[key] !== undefined) fail(400, 'INVALID_BIDDING', 'Only send the target required by this bidding strategy.');
      if (parameter) { if (typeof body[parameter] !== 'number' || !Number.isFinite(body[parameter]) || body[parameter] <= 0 || body[parameter] > 10000000) fail(400, 'INVALID_BIDDING', 'Enter a positive bidding target.'); payload[parameter] = body[parameter]; }
    }
    const outcome = await operation(context, async key => {
      if (action === 'bidding') { const current = await api(endpoint, { accountId, adAccountId, platform: 'google' }); if (String(current.campaignId) !== campaignId || typeof current.biddingStrategyType !== 'string') fail(502, 'INVALID_PROVIDER_RESPONSE', 'Current campaign bidding could not be verified.'); if (current.stale === true) fail(409, 'STALE_GOOGLE_BIDDING', 'Google could not refresh the current bidding. Load it again before making a change.'); if (current.portfolio || current.bidSpec?.portfolioBidStrategyId) fail(409, 'SHARED_BIDDING', 'Detach the shared portfolio strategy in Google Ads before changing this campaign’s bidding.'); }
      const result = await api(action === 'bidding' ? `/ads/campaigns/${encodeURIComponent(campaignId)}` : endpoint, {}, payload, key, 'PUT');
      if (action === 'negatives') confirmed(result.stale !== true && Array.isArray(result.keywords) && sameKeywords(result.keywords, payload.keywords), 'Google did not confirm the complete campaign negative keyword set.');
      if (action === 'targeting') confirmed(validTargeting(result) && result.stale !== true && String(result.campaignId) === campaignId && Array.isArray(result.updated) && Object.keys(payload.targeting).every(field => result.updated.includes(field)), 'Google did not confirm the updated campaign targeting.');
      if (action === 'bidding') {
        confirmed(result.bidStrategy === payload.bidStrategy && ['bidAmount', 'roasAverageFloor'].every(field => payload[field] === undefined || result[field] === payload[field]), 'Google did not acknowledge the requested bidding strategy.');
        let current; try { current = await api(endpoint, { accountId, adAccountId, platform: 'google' }); } catch (error) { error.uncertain = true; throw error; }
        confirmed(String(current.campaignId) === campaignId && current.stale !== true && current.bidSpec?.bidStrategy === payload.bidStrategy && ['bidAmount', 'roasAverageFloor'].every(field => payload[field] === undefined || current.bidSpec?.[field] === payload[field]), 'The updated campaign bidding could not be read back.');
        return { result: redact(current) };
      }
      return { result: redact(result) };
    }, ['ads', 'google', campaignId]); send(outcome.status, outcome.data); return true;
  }
  if (write && ['keywords/add', 'keyword/status', 'keyword/remove'].includes(action)) {
    requireCampaign();
    fields(body, action === 'keywords/add' ? ['accountId', 'adAccountId', 'campaignId', 'adSetId', 'keywords', 'negative', 'confirmChange'] : ['accountId', 'adAccountId', 'campaignId', 'adSetId', 'keywordId', 'status', 'confirmChange']);
    if (body.confirmChange !== true) fail(400, 'GOOGLE_CONFIRMATION_REQUIRED', 'Confirm this keyword change.');
    if (action === 'keywords/add' && !groupId) fail(400, 'AD_GROUP_REQUIRED', 'Choose an ad group before adding keywords.');
    const rows = action === 'keywords/add' ? keywords(body.keywords) : undefined;
    if (body.negative !== undefined && typeof body.negative !== 'boolean') fail(400, 'INVALID_KEYWORDS', 'Choose whether these are negative keywords.');
    if (action === 'keyword/status' && !['active', 'paused'].includes(body.status)) fail(400, 'INVALID_KEYWORDS', 'Choose an active or paused keyword status.');
    const keywordId = rows ? undefined : id(body.keywordId, 'keyword');
    const outcome = await operation(context, async key => {
      if (rows) {
        const result = await api('/ads/keywords', {}, { accountId, adSetId: groupId, keywords: rows, negative: body.negative === true }, key);
        confirmed(Array.isArray(result.keywords) && sameKeywords(result.keywords, rows) && result.keywords.every(row => scope(row, profileId, accountId, adAccountId) && row.adSetId === groupId && row.negative === (body.negative === true) && typeof row.id === 'string'), 'Google did not confirm the added keywords in the selected ad group.');
        return { result: redact(result) };
      }
      let selected;
      // ponytail: bounded scan of 1,000 scoped criteria; use an ad-group filter for larger keyword collections.
      for (let page = 1; page <= 10; page++) { const result = await readKeywords(page); selected = result.keywords.find(row => row.id === keywordId); if (selected || page >= result.pagination.pages) break; if (page === 10) fail(503, 'KEYWORD_SCOPE_LIMIT', 'Select an ad group to narrow this keyword collection.'); }
      if (!selected) fail(403, 'KEYWORD_OUTSIDE_PROJECT', 'This keyword is not in the selected Google campaign.');
      if (action === 'keyword/status' && selected.negative) fail(422, 'NEGATIVE_KEYWORD_STATUS', 'Google negative keywords can only be removed, not paused.');
      const result = await api(`/ads/keywords/${encodeURIComponent(keywordId)}`, {}, action === 'keyword/status' ? { status: body.status } : undefined, key, action === 'keyword/status' ? 'PATCH' : 'DELETE');
      if (action === 'keyword/status') confirmed(result.keyword?.id === keywordId && result.keyword.status === body.status && result.keyword.adSetId === selected.adSetId && scope(result.keyword, profileId, accountId, adAccountId), 'Google did not confirm this keyword’s new status.');
      else confirmed(result.removed === true && result.keywordId === keywordId && result.adSetId === selected.adSetId && result.campaignId === campaignId, 'Google did not confirm removal of the selected keyword.');
      return { result: redact(result) };
    }, ['ads', 'google', campaignId]); send(outcome.status, outcome.data); return true;
  }
  fail(404, 'GOOGLE_TOOL_NOT_FOUND', 'This Google Ads tool was not found.');
}
