import { IntegrationError, providerRequest, operation } from './integrations.mjs';

const BASE = 'https://googleads.googleapis.com/v25';
const fail = (status, code, message) => { throw new IntegrationError(status, code, message); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const configured = env => ['GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_DEVELOPER_TOKEN'].every(key => typeof env[key] === 'string' && Boolean(env[key].trim()));
function customerId(value) { if (typeof value !== 'string' || !/^\d{10}$/.test(value)) fail(400, 'INVALID_GOOGLE_CUSTOMER', 'Enter the ten-digit Google Ads customer ID without hyphens.'); return value; }
function fields(value, allowed) { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'UNSUPPORTED_GOOGLE_FIELD', 'Use only the supported Google Shopping fields.'); }
function name(value, label = 'campaign name') { if (typeof value !== 'string' || !value.trim() || value.length > 120 || /[\u0000-\u001f]/.test(value)) fail(400, 'INVALID_GOOGLE_INPUT', `Enter a valid ${label} of at most 120 characters.`); return value.trim(); }
function current(check, uncertain = false) { try { check?.(); } catch { throw new IntegrationError(409, 'NATIVE_GOOGLE_CONNECTION_CHANGED', 'The Google Ads authorization or project account changed. Refresh before continuing and review any unconfirmed provider outcome.', uncertain); } }
async function googleToken(env, assertCurrent, persistRefresh) {
  if (!configured(env)) fail(503, 'NATIVE_GOOGLE_NOT_CONFIGURED', 'Configure the native Google Ads OAuth credentials and developer token first.');
  if (env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) customerId(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID);
  current(assertCurrent);
  const result = await providerRequest('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.GOOGLE_ADS_CLIENT_ID, client_secret: env.GOOGLE_ADS_CLIENT_SECRET, refresh_token: env.GOOGLE_ADS_REFRESH_TOKEN, grant_type: 'refresh_token' }).toString() }, 'Google Ads authorization');
  current(assertCurrent);
  if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 8192 || /[\s\u0000-\u001f]/.test(result.access_token)) fail(502, 'INVALID_GOOGLE_AUTH_RESPONSE', 'Google did not return a usable access token.');
  if (result.refresh_token !== undefined && result.refresh_token !== env.GOOGLE_ADS_REFRESH_TOKEN) {
    if (typeof result.refresh_token !== 'string' || result.refresh_token.length < 8 || result.refresh_token.length > 4096 || /\s/.test(result.refresh_token) || !persistRefresh) fail(409, 'GOOGLE_AUTHORIZATION_CHANGED', 'The Google authorization changed and its refresh token could not be safely saved.');
    persistRefresh(env.GOOGLE_ADS_REFRESH_TOKEN, result.refresh_token); env.GOOGLE_ADS_REFRESH_TOKEN = result.refresh_token;
  }
  return result.access_token;
}
const headers = (env, token) => ({ Authorization: `Bearer ${token}`, 'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN, ...(env.GOOGLE_ADS_LOGIN_CUSTOMER_ID ? { 'login-customer-id': env.GOOGLE_ADS_LOGIN_CUSTOMER_ID } : {}) });

export async function testNativeGoogleAds(env, assertCurrent, persistRefresh) {
  const token = await googleToken(env, assertCurrent, persistRefresh);
  current(assertCurrent);
  const result = await providerRequest(BASE + '/customers:listAccessibleCustomers', { headers: headers(env, token) }, 'Google Ads');
  current(assertCurrent);
  const resources = result.resourceNames === undefined ? [] : result.resourceNames;
  if (result.error || !Array.isArray(resources) || resources.length > 10000 || resources.some(value => typeof value !== 'string' || !/^customers\/\d{10}$/.test(value))) fail(502, 'INVALID_GOOGLE_RESPONSE', 'Google did not return a readable customer list.');
  return { message: `Google Ads authorization works. ${resources.length} directly accessible account${resources.length === 1 ? '' : 's'} found. Map an advertising customer to each project; manager child accounts are verified when mapped.` };
}

export async function handleNativeGoogleAds(context) {
  const { req, url, project, user, role, db, body, store, send } = context;
  const prefix = `/api/projects/${encodeURIComponent(project.id)}/native-google-ads/`;
  if (!url.pathname.startsWith(prefix)) return false;
  const action = url.pathname.slice(prefix.length), env = { ...(context.config?.env || process.env) };
  db.exec('CREATE TABLE IF NOT EXISTS native_google_connections(project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,customer_id TEXT UNIQUE NOT NULL)');
  let connection = db.prepare('SELECT customer_id AS customerId FROM native_google_connections WHERE project_id=?').get(project.id);
  const originalCustomer = connection?.customerId || '';
  const assertCurrent = () => { context.assertIntegrationSettings?.(); if ((db.prepare('SELECT customer_id FROM native_google_connections WHERE project_id=?').get(project.id)?.customer_id || '') !== originalCustomer) throw new Error('Google customer mapping changed.'); };
  const persistRefresh = context.persistNativeRefreshToken ? (expected, next) => context.persistNativeRefreshToken('googleAdsNative', expected, next) : undefined;
  try {
    if (action === 'status' && req.method === 'GET') { send(200, { configured: configured(env), mapped: Boolean(connection), customerId: originalCustomer, videoCreationSupported: false }); return true; }
    if (!['GET', 'POST'].includes(req.method)) fail(405, 'GOOGLE_METHOD_NOT_ALLOWED', 'This Google Ads action is not available.');
    if (req.method === 'POST' && !['owner', 'admin', 'editor'].includes(role)) fail(403, 'GOOGLE_WRITE_PERMISSION_REQUIRED', 'Editing permission is required.');
    if (action === 'connection' && req.method === 'POST') {
      if (!user.isOperator || !['owner', 'admin'].includes(role)) fail(403, 'GOOGLE_MAPPING_PERMISSION_REQUIRED', 'An instance operator with workspace administration must map the native Google Ads customer.');
      fields(body, ['customerId']);
      if (body.customerId === '') { current(assertCurrent); db.prepare('DELETE FROM native_google_connections WHERE project_id=?').run(project.id); store.activity(project.id, 'Native Google Ads customer disconnected.'); send(200, { mapped: false, customerId: '' }); return true; }
      customerId(body.customerId);
      const token = await googleToken(env, assertCurrent, persistRefresh);
      const account = await readCustomer(env, token, body.customerId, assertCurrent);
      current(assertCurrent);
      if (db.prepare('SELECT project_id FROM native_google_connections WHERE customer_id=? AND project_id<>?').get(body.customerId, project.id)) fail(409, 'GOOGLE_CUSTOMER_ALREADY_MAPPED', 'This Google advertising account is already assigned to another project.');
      db.prepare('INSERT INTO native_google_connections VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET customer_id=excluded.customer_id').run(project.id, body.customerId);
      store.activity(project.id, 'Native Google Ads customer mapped after verifying account access.'); send(200, { mapped: true, customerId: body.customerId, account }); return true;
    }
    if (!connection) fail(409, 'NATIVE_GOOGLE_NOT_MAPPED', 'Map a Google advertising customer to this project first.');
    const token = await googleToken(env, assertCurrent, persistRefresh);
    const call = async (endpoint, payload, mutation = false) => {
      current(assertCurrent);
      let result;
      try { result = await providerRequest(`${BASE}/customers/${originalCustomer}/${endpoint}`, { method: 'POST', headers: { ...headers(env, token), 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 'Google Ads'); }
      catch (error) { if (!mutation && error instanceof IntegrationError) error.uncertain = false; throw error; }
      current(assertCurrent, mutation); return result;
    };
    if (action === 'account' && req.method === 'GET') { const account = await readCustomer(env, token, originalCustomer, assertCurrent); send(200, { account }); return true; }
    if (action === 'campaigns' && req.method === 'GET') {
      const range = dateRange(url), query = `SELECT customer.id, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.period, campaign_budget.amount_micros, campaign_budget.total_amount_micros, metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions FROM campaign WHERE campaign.advertising_channel_type IN ('SHOPPING', 'VIDEO') AND campaign.status != 'REMOVED' AND segments.date BETWEEN '${range.fromDate}' AND '${range.toDate}' ORDER BY campaign.id`;
      const result = await call('googleAds:search', { query, ...(url.searchParams.get('pageToken') ? { pageToken: pageToken(url.searchParams.get('pageToken')) } : {}) });
      const rows = searchRows(result);
      const counter = (value, integer = true) => value == null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && (!integer || Number.isSafeInteger(value))) || (typeof value === 'string' && (integer ? /^\d{1,20}$/.test(value) : /^\d+(?:\.\d+)?$/.test(value)) && Number.isFinite(Number(value)));
      if (rows.some(row => String(row.customer?.id) !== originalCustomer || !/^\d{1,20}$/.test(String(row.campaign?.id)) || !['SHOPPING', 'VIDEO'].includes(row.campaign?.advertisingChannelType))) fail(502, 'INVALID_GOOGLE_SCOPE', 'Google returned campaign data outside this customer.');
      if (new Set(rows.map(row => String(row.campaign.id))).size !== rows.length || rows.some(row => typeof row.campaign.name !== 'string' || !row.campaign.name || row.campaign.name.length > 1024 || !['ENABLED', 'PAUSED', 'UNKNOWN', 'UNSPECIFIED'].includes(row.campaign.status) || row.campaignBudget != null && !object(row.campaignBudget) || row.campaignBudget?.period !== undefined && !['DAILY', 'CUSTOM_PERIOD', 'UNKNOWN', 'UNSPECIFIED'].includes(row.campaignBudget.period) || !counter(row.campaignBudget?.amountMicros) || !counter(row.campaignBudget?.totalAmountMicros) || row.metrics != null && !object(row.metrics) || ['impressions', 'clicks', 'costMicros'].some(key => !counter(row.metrics?.[key])) || !counter(row.metrics?.conversions, false)) || result.nextPageToken && result.nextPageToken === url.searchParams.get('pageToken')) fail(502, 'INVALID_GOOGLE_RESPONSE', 'Google did not return readable campaign states, budgets and performance counters.');
      const managed = store.list(project.id, 'campaigns').filter(row => row.nativeProvider === 'googleAdsNative' && row.nativeCustomerId === originalCustomer);
      send(200, { campaigns: rows.map(row => ({ id: String(row.campaign.id), name: row.campaign.name, status: row.campaign.status, channel: row.campaign.advertisingChannelType, budgetPeriod: row.campaignBudget?.period || 'UNKNOWN', ...(row.campaignBudget?.period === 'DAILY' ? { dailyBudgetMicros: row.campaignBudget.amountMicros } : row.campaignBudget?.period === 'CUSTOM_PERIOD' ? { totalBudgetMicros: row.campaignBudget.totalAmountMicros } : {}), metrics: row.metrics || {}, appManaged: managed.some(item => item.nativeCampaignResource === `customers/${originalCustomer}/campaigns/${row.campaign.id}`) })), nextPageToken: result.nextPageToken || '', ...range }); return true;
    }
    if (action === 'campaign/cpc') {
      const values = req.method === 'POST' ? body : Object.fromEntries(url.searchParams);
      fields(values, req.method === 'POST' ? ['campaignId', 'maxCpc', 'confirmChange'] : ['campaignId']);
      if (typeof values.campaignId !== 'string' || !/^\d{1,20}$/.test(values.campaignId)) fail(400, 'INVALID_GOOGLE_CAMPAIGN', 'Choose a Shopping campaign created by this app.');
      const resource = `customers/${originalCustomer}/campaigns/${values.campaignId}`;
      const managed = store.list(project.id, 'campaigns').find(row => row.nativeProvider === 'googleAdsNative' && row.nativeCustomerId === originalCustomer && row.nativeCampaignResource === resource), children = managed?.nativeResources;
      if (!children || children.campaign !== resource || !new RegExp(`^customers/${originalCustomer}/adGroups/\\d+$`).test(children.adGroup) || !new RegExp(`^customers/${originalCustomer}/adGroupCriteria/${children.adGroup.split('/').at(-1)}~\\d+$`).test(children.listingGroup)) fail(409, 'GOOGLE_CREATED_RESOURCES_REQUIRED', 'This CPC editor only changes the all-products group created by this app.');
      const readBid = async () => {
        const campaignsResult = await call('googleAds:search', { query: `SELECT customer.id, campaign.id, campaign.status, campaign.advertising_channel_type, campaign.bidding_strategy_type, campaign.bidding_strategy FROM campaign WHERE campaign.resource_name = '${resource}'` }), campaigns = searchRows(campaignsResult);
        if (campaignsResult.nextPageToken || campaigns.length !== 1 || String(campaigns[0].customer?.id) !== originalCustomer || String(campaigns[0].campaign?.id) !== values.campaignId || !['PAUSED', 'ENABLED'].includes(campaigns[0].campaign?.status) || campaigns[0].campaign.advertisingChannelType !== 'SHOPPING') fail(403, 'GOOGLE_CAMPAIGN_OUTSIDE_PROJECT', 'Google did not confirm this Shopping campaign in the project’s mapped customer.');
        if (campaigns[0].campaign.biddingStrategyType !== 'MANUAL_CPC' || campaigns[0].campaign.biddingStrategy) fail(409, 'GOOGLE_MANUAL_CPC_REQUIRED', 'Manage automated or portfolio bidding in Google Ads. This editor requires campaign-level Manual CPC.');
        const groupResult = await call('googleAds:search', { query: `SELECT customer.id, campaign.id, ad_group.resource_name, ad_group.status, ad_group.cpc_bid_micros FROM ad_group WHERE ad_group.resource_name = '${children.adGroup}' AND campaign.id = ${values.campaignId}` }), groups = searchRows(groupResult);
        const listingResult = await call('googleAds:search', { query: `SELECT customer.id, campaign.id, ad_group.resource_name, ad_group_criterion.resource_name, ad_group_criterion.status, ad_group_criterion.negative, ad_group_criterion.listing_group.type, ad_group_criterion.listing_group.parent_ad_group_criterion, ad_group_criterion.cpc_bid_micros FROM ad_group_criterion WHERE ad_group.resource_name = '${children.adGroup}' AND campaign.id = ${values.campaignId} AND ad_group_criterion.type = 'LISTING_GROUP' AND ad_group_criterion.status != 'REMOVED'` }), listings = searchRows(listingResult);
        const group = groups[0]?.adGroup, listing = listings[0]?.adGroupCriterion, positiveMicros = value => /^\d{1,16}$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
        if (groupResult.nextPageToken || listingResult.nextPageToken || groups.length !== 1 || listings.length !== 1 || [groups[0], listings[0]].some(row => String(row.customer?.id) !== originalCustomer || String(row.campaign?.id) !== values.campaignId || row.adGroup?.resourceName !== children.adGroup) || !['PAUSED', 'ENABLED'].includes(group?.status) || listing?.resourceName !== children.listingGroup || !['PAUSED', 'ENABLED'].includes(listing?.status) || listing.negative !== undefined && listing.negative !== false || listing.listingGroup?.type !== 'UNIT' || listing.listingGroup.parentAdGroupCriterion || !positiveMicros(group?.cpcBidMicros) || !positiveMicros(listing?.cpcBidMicros)) fail(409, 'GOOGLE_PRODUCT_GROUP_CHANGED', 'The app-created all-products group or its bids changed. Review product partitions and bidding in Google Ads.');
        return { campaignId: values.campaignId, adGroupId: children.adGroup.split('/').at(-1), maxCpcMicros: String(listing.cpcBidMicros), groupMaxCpcMicros: String(group.cpcBidMicros) };
      };
      const account = await readCustomer(env, token, originalCustomer, assertCurrent);
      if (req.method === 'GET') { send(200, { ...await readBid(), currencyCode: account.currencyCode }); return true; }
      if (values.confirmChange !== true) fail(400, 'GOOGLE_CHANGE_CONFIRMATION_REQUIRED', 'Confirm replacement of the maximum CPC for all products in this group.');
      const amount = micros(values.maxCpc, account.currencyCode, 'maximum CPC');
      const outcome = await operation(context, async () => {
        await readBid();
        const result = await call('googleAds:mutate', { partialFailure: false, responseContentType: 'RESOURCE_NAME_ONLY', mutateOperations: [{ adGroupOperation: { update: { resourceName: children.adGroup, cpcBidMicros: amount }, updateMask: 'cpc_bid_micros' } }, { adGroupCriterionOperation: { update: { resourceName: children.listingGroup, cpcBidMicros: amount }, updateMask: 'cpc_bid_micros' } }] }, true);
        if (result.partialFailureError || !Array.isArray(result.mutateOperationResponses) || result.mutateOperationResponses.length !== 2 || result.mutateOperationResponses[0]?.adGroupResult?.resourceName !== children.adGroup || result.mutateOperationResponses[1]?.adGroupCriterionResult?.resourceName !== children.listingGroup) throw new IntegrationError(502, 'GOOGLE_CPC_UNCONFIRMED', 'Google did not confirm the group and product CPC update.', true);
        let after; try { after = await readBid(); if (after.maxCpcMicros !== amount || after.groupMaxCpcMicros !== amount) throw new Error('CPC mismatch.'); } catch { throw new IntegrationError(502, 'GOOGLE_CPC_UNCONFIRMED', 'The updated CPC could not be read back. Review Google Ads before retrying.', true); }
        current(assertCurrent, true); store.update(project.id, 'campaigns', managed.id, { maxCpc: values.maxCpc }); store.activity(project.id, 'Updated the native Shopping all-products maximum CPC after provider readback.');
        return { ...after, currencyCode: account.currencyCode };
      }, ['ads', 'google', values.campaignId]); send(outcome.status, outcome.data); return true;
    }
    if (action === 'campaign/update' && req.method === 'POST') {
      fields(body, ['campaignId', 'status', 'dailyBudget', 'enableCreatedChildren', 'confirmChange']);
      if (typeof body.campaignId !== 'string' || !/^\d{1,20}$/.test(body.campaignId)) fail(400, 'INVALID_GOOGLE_CAMPAIGN', 'Choose a Google campaign from this customer.');
      if (body.confirmChange !== true) fail(400, 'GOOGLE_CHANGE_CONFIRMATION_REQUIRED', 'Confirm this campaign-wide change.');
      if ((body.status === undefined) === (body.dailyBudget === undefined)) fail(400, 'INVALID_GOOGLE_UPDATE', 'Change either the campaign switch or its daily budget.');
      if (body.status !== undefined && !['PAUSED', 'ENABLED'].includes(body.status)) fail(400, 'INVALID_GOOGLE_STATUS', 'Choose a paused or enabled campaign switch.');
      if (body.enableCreatedChildren !== undefined && (body.enableCreatedChildren !== true || body.status !== 'ENABLED')) fail(400, 'INVALID_GOOGLE_STATUS', 'Created ad groups and ads can be enabled only with their campaign.');
      const resource = `customers/${originalCustomer}/campaigns/${body.campaignId}`;
      const result = await operation(context, async () => {
        const account = await readCustomer(env, token, originalCustomer, assertCurrent);
        const stateQuery = `SELECT customer.id, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.resource_name, campaign_budget.period, campaign_budget.amount_micros, campaign_budget.explicitly_shared FROM campaign WHERE campaign.resource_name = '${resource}'`;
        const rows = searchRows(await call('googleAds:search', { query: stateQuery })), selected = rows[0];
        if (rows.length !== 1 || String(selected?.customer?.id) !== originalCustomer || String(selected?.campaign?.id) !== body.campaignId) fail(403, 'GOOGLE_CAMPAIGN_OUTSIDE_PROJECT', 'This campaign was not found in the project’s mapped Google customer.');
        if (selected.campaign.advertisingChannelType !== 'SHOPPING') fail(422, 'GOOGLE_VIDEO_WRITE_UNSUPPORTED', 'Standard Video campaigns are read only through Google’s API.');
        if (selected.campaign.status === 'REMOVED') fail(409, 'GOOGLE_CAMPAIGN_REMOVED', 'A removed campaign cannot be changed.');
        if (!['PAUSED', 'ENABLED'].includes(selected.campaign.status)) fail(502, 'INVALID_GOOGLE_RESPONSE', 'Google did not confirm the campaign’s current switch.');
        const operations = [], expected = [];
        const managed = store.list(project.id, 'campaigns').find(row => row.nativeProvider === 'googleAdsNative' && row.nativeCustomerId === originalCustomer && row.nativeCampaignResource === resource);
        let createdChildren;
        if (body.status) {
          operations.push({ campaignOperation: { update: { resourceName: resource, status: body.status }, updateMask: 'status' } }); expected.push(['campaignResult', resource]);
          if (body.enableCreatedChildren) {
            const children = managed?.nativeResources;
            if (!children || children.campaign !== resource || !new RegExp(`^customers/${originalCustomer}/adGroups/\\d+$`).test(children.adGroup) || !new RegExp(`^customers/${originalCustomer}/adGroupAds/${children.adGroup.split('/').at(-1)}~\\d+$`).test(children.ad)) fail(409, 'GOOGLE_CREATED_RESOURCES_REQUIRED', 'Only the ad group and ad created by this app can be enabled together. Other campaigns retain their individual ad switches.');
            const groups = searchRows(await call('googleAds:search', { query: `SELECT customer.id, campaign.id, ad_group.resource_name, ad_group.status FROM ad_group WHERE ad_group.resource_name = '${children.adGroup}' AND campaign.id = ${body.campaignId}` }));
            const ads = searchRows(await call('googleAds:search', { query: `SELECT customer.id, campaign.id, ad_group_ad.resource_name, ad_group_ad.status FROM ad_group_ad WHERE ad_group_ad.resource_name = '${children.ad}' AND campaign.id = ${body.campaignId}` }));
            if (groups.length !== 1 || ads.length !== 1 || String(groups[0].customer?.id) !== originalCustomer || String(ads[0].customer?.id) !== originalCustomer || String(groups[0].campaign?.id) !== body.campaignId || String(ads[0].campaign?.id) !== body.campaignId || groups[0].adGroup?.resourceName !== children.adGroup || ads[0].adGroupAd?.resourceName !== children.ad || !['PAUSED', 'ENABLED'].includes(groups[0].adGroup.status) || !['PAUSED', 'ENABLED'].includes(ads[0].adGroupAd.status)) fail(403, 'GOOGLE_CHILD_SCOPE_UNCONFIRMED', 'Google did not confirm this campaign’s app-created ad group and ad.');
            operations.push({ adGroupOperation: { update: { resourceName: children.adGroup, status: 'ENABLED' }, updateMask: 'status' } }, { adGroupAdOperation: { update: { resourceName: children.ad, status: 'ENABLED' }, updateMask: 'status' } }); expected.push(['adGroupResult', children.adGroup], ['adGroupAdResult', children.ad]); createdChildren = children;
          }
        } else {
          if (selected.campaignBudget?.period !== 'DAILY') fail(409, 'GOOGLE_DAILY_BUDGET_REQUIRED', 'This campaign does not have a confirmed daily budget. Manage campaign-total budgets in Google Ads.');
          const budget = selected.campaignBudget?.resourceName;
          if (typeof budget !== 'string' || !new RegExp(`^customers/${originalCustomer}/campaignBudgets/\\d+$`).test(budget) || selected.campaignBudget.explicitlyShared === true) fail(409, 'GOOGLE_SHARED_BUDGET', 'This campaign’s shared or unconfirmed budget cannot be edited here.');
          const users = await call('googleAds:search', { query: `SELECT campaign.id FROM campaign WHERE campaign.campaign_budget = '${budget}' AND campaign.status != 'REMOVED' LIMIT 2` });
          if (users.nextPageToken || searchRows(users).length !== 1 || String(users.results[0].campaign?.id) !== body.campaignId) fail(409, 'GOOGLE_SHARED_BUDGET', 'This budget serves more than one campaign or its sharing state is unknown.');
          operations.push({ campaignBudgetOperation: { update: { resourceName: budget, amountMicros: micros(body.dailyBudget, account.currencyCode, 'daily budget') }, updateMask: 'amount_micros' } }); expected.push(['campaignBudgetResult', budget]);
        }
        const response = await call('googleAds:mutate', { mutateOperations: operations, partialFailure: false, responseContentType: 'RESOURCE_NAME_ONLY' }, true);
        if (response.partialFailureError || !Array.isArray(response.mutateOperationResponses) || response.mutateOperationResponses.length !== expected.length || expected.some(([kind, name], index) => response.mutateOperationResponses[index]?.[kind]?.resourceName !== name)) throw new IntegrationError(502, 'GOOGLE_UPDATE_UNCONFIRMED', 'Google did not confirm every campaign update.', true);
        let after;
        try {
          after = searchRows(await call('googleAds:search', { query: stateQuery }));
          if (after.length !== 1 || String(after[0].customer?.id) !== originalCustomer || String(after[0].campaign?.id) !== body.campaignId || body.status && after[0].campaign?.status !== body.status || body.dailyBudget !== undefined && (after[0].campaignBudget?.period !== 'DAILY' || String(after[0].campaignBudget?.amountMicros) !== operations[0].campaignBudgetOperation.update.amountMicros)) throw new Error('Campaign update mismatch.');
          if (createdChildren) {
            const groups = searchRows(await call('googleAds:search', { query: `SELECT customer.id, campaign.id, ad_group.resource_name, ad_group.status FROM ad_group WHERE ad_group.resource_name = '${createdChildren.adGroup}' AND campaign.id = ${body.campaignId}` })), ads = searchRows(await call('googleAds:search', { query: `SELECT customer.id, campaign.id, ad_group_ad.resource_name, ad_group_ad.status FROM ad_group_ad WHERE ad_group_ad.resource_name = '${createdChildren.ad}' AND campaign.id = ${body.campaignId}` }));
            if (groups.length !== 1 || ads.length !== 1 || groups[0].adGroup?.resourceName !== createdChildren.adGroup || groups[0].adGroup?.status !== 'ENABLED' || ads[0].adGroupAd?.resourceName !== createdChildren.ad || ads[0].adGroupAd?.status !== 'ENABLED' || [groups[0], ads[0]].some(row => String(row.customer?.id) !== originalCustomer || String(row.campaign?.id) !== body.campaignId)) throw new Error('Child update mismatch.');
          }
        } catch { throw new IntegrationError(502, 'GOOGLE_UPDATE_UNCONFIRMED', 'The campaign update could not be read back. Review Google Ads before retrying.', true); }
        current(assertCurrent, true);
        if (managed) store.update(project.id, 'campaigns', managed.id, { ...(body.status ? { status: body.status === 'PAUSED' ? 'paused' : 'active' } : {}), ...(body.dailyBudget !== undefined ? { budget: body.dailyBudget } : {}) });
        store.activity(project.id, 'Updated a native Google Shopping campaign after provider readback.');
        return { campaignId: body.campaignId, status: after[0].campaign.status, dailyBudgetMicros: after[0].campaignBudget?.amountMicros, enabledCreatedChildren: Boolean(createdChildren) };
      }, ['ads', 'google', body.campaignId]); send(result.status, result.data); return true;
    }
    if (action === 'shopping/create' && req.method === 'POST') {
      fields(body, ['name', 'merchantId', 'feedLabel', 'priority', 'dailyBudget', 'maxCpc', 'countries', 'euPoliticalAdvertising', 'validateOnly', 'confirmCreate']);
      if (body.confirmCreate !== true) fail(400, 'GOOGLE_CREATION_CONFIRMATION_REQUIRED', 'Confirm creation of a paused Shopping campaign for all products in this feed.');
      if (body.validateOnly !== undefined && typeof body.validateOnly !== 'boolean') fail(400, 'INVALID_GOOGLE_INPUT', 'Validation-only must be true or false.');
      const account = await readCustomer(env, token, originalCustomer, assertCurrent), payload = shoppingPayload(body, originalCustomer, account.currencyCode);
      const countryCodes = [...new Set(body.countries)];
      const geoResult = await call('googleAds:search', { query: `SELECT geo_target_constant.id, geo_target_constant.country_code, geo_target_constant.target_type, geo_target_constant.status FROM geo_target_constant WHERE geo_target_constant.country_code IN (${countryCodes.map(code => `'${code}'`).join(',')}) AND geo_target_constant.target_type = 'Country' AND geo_target_constant.status = 'ENABLED'` });
      const geos = searchRows(geoResult).map(row => row.geoTargetConstant);
      if (geoResult.nextPageToken || geos.length !== countryCodes.length || geos.some(row => !object(row) || !/^\d+$/.test(String(row.id)) || !countryCodes.includes(row.countryCode) || row.targetType !== 'Country' || row.status !== 'ENABLED') || new Set(geos.map(row => row.countryCode)).size !== countryCodes.length || new Set(geos.map(row => String(row.id))).size !== countryCodes.length) fail(502, 'GOOGLE_COUNTRIES_UNCONFIRMED', 'Google did not resolve every targeted country. No campaign was created.');
      payload.mutateOperations.push(...geos.map(row => ({ campaignCriterionOperation: { create: { campaign: `customers/${originalCustomer}/campaigns/-2`, location: { geoTargetConstant: `geoTargetConstants/${row.id}` } } } })));
      if (body.validateOnly) { const result = await call('googleAds:mutate', { ...payload, validateOnly: true }); if (result.partialFailureError || result.mutateOperationResponses?.length) fail(502, 'INVALID_GOOGLE_VALIDATION', 'Google did not return an empty validation-only receipt.'); send(200, { validated: true, customerId: originalCustomer, status: 'PAUSED' }); return true; }
      const outcome = await operation(context, async () => {
        const result = await call('googleAds:mutate', payload, true);
        const created = createdResources(result, originalCustomer, payload.mutateOperations.length);
        let rows;
        try { rows = searchRows(await call('googleAds:search', { query: `SELECT customer.id, campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros FROM campaign WHERE campaign.resource_name = '${created.campaign}'` })); }
        catch (error) { error.uncertain = true; throw error; }
        if (rows.length !== 1 || String(rows[0].customer?.id) !== originalCustomer || rows[0].campaign?.status !== 'PAUSED' || rows[0].campaign?.advertisingChannelType !== 'SHOPPING' || rows[0].campaign?.name !== body.name.trim() || `customers/${originalCustomer}/campaigns/${rows[0].campaign?.id}` !== created.campaign || String(rows[0].campaignBudget?.amountMicros) !== payload.mutateOperations[0].campaignBudgetOperation.create.amountMicros) throw new IntegrationError(502, 'GOOGLE_CREATION_UNCONFIRMED', 'The created Shopping campaign could not be verified as paused with the requested budget.', true);
        current(assertCurrent, true);
        const campaign = store.create(project.id, 'campaigns', { name: body.name.trim(), channel: 'paid', status: 'paused', budget: body.dailyBudget, budgetType: 'daily', spent: 0, currency: account.currencyCode, platform: 'google', nativeProvider: 'googleAdsNative', nativeCustomerId: originalCustomer, nativeCampaignResource: created.campaign, platformCampaignId: String(rows[0].campaign.id), nativeResources: created });
        store.activity(project.id, 'Created a paused native Google Shopping campaign and all-products ad group.'); return { campaign, resources: created, customerId: originalCustomer, status: 'PAUSED' };
      }); send(outcome.status, outcome.data); return true;
    }
    fail(404, 'NATIVE_GOOGLE_ACTION_NOT_FOUND', 'This native Google Ads action was not found.');
  } catch (error) { send(error instanceof IntegrationError ? error.status : 500, { error: { code: error instanceof IntegrationError ? error.code : 'NATIVE_GOOGLE_ERROR', message: error instanceof IntegrationError ? error.message : 'The native Google Ads request could not be completed.' } }); return true; }
}

function searchRows(result) { const rows = result.results === undefined ? [] : result.results; if (result.error || result.partialFailureError || !Array.isArray(rows) || rows.length > 10000 || rows.some(row => !object(row)) || result.nextPageToken !== undefined && (typeof result.nextPageToken !== 'string' || result.nextPageToken.length > 4096)) fail(502, 'INVALID_GOOGLE_RESPONSE', 'Google did not return a readable search page.'); return rows; }
function pageToken(value) { if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f]/.test(value)) fail(400, 'INVALID_PAGE', 'Use a valid Google page cursor.'); return value; }
function dateRange(url) {
  const valid = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  const toDate = url.searchParams.get('toDate') || new Date().toISOString().slice(0, 10); if (!valid(toDate)) fail(400, 'INVALID_DATE', 'Choose a valid report end date.');
  const fromDate = url.searchParams.get('fromDate') || new Date(Date.parse(toDate) - 29 * 86400000).toISOString().slice(0, 10);
  if (!valid(fromDate) || fromDate > toDate || Date.parse(toDate) - Date.parse(fromDate) >= 366 * 86400000) fail(400, 'INVALID_DATE', 'Choose a report window of at most 366 days.'); return { fromDate, toDate };
}
async function readCustomer(env, token, target, assertCurrent) {
  current(assertCurrent);
  const result = await providerRequest(`${BASE}/customers/${customerId(target)}/googleAds:search`, { method: 'POST', headers: { ...headers(env, token), 'Content-Type': 'application/json' }, body: JSON.stringify({ query: 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.test_account FROM customer LIMIT 1' }) }, 'Google Ads');
  current(assertCurrent);
  const rows = searchRows(result), account = rows[0]?.customer;
  if (rows.length !== 1 || String(account?.id) !== target || !/^[A-Z]{3}$/.test(account?.currencyCode) || account.manager === true || account.descriptiveName !== undefined && (typeof account.descriptiveName !== 'string' || account.descriptiveName.length > 1024) || account.timeZone !== undefined && (typeof account.timeZone !== 'string' || account.timeZone.length > 150)) fail(502, 'INVALID_GOOGLE_CUSTOMER', 'Google did not verify this advertising customer and its currency. Manager accounts cannot run Shopping campaigns.');
  return { id: target, name: account.descriptiveName || target, currencyCode: account.currencyCode, timeZone: account.timeZone, testAccount: account.testAccount === true };
}
function micros(value, currency, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 10000000 || Math.abs(value * 1000000 - Math.round(value * 1000000)) > 0.00001) fail(400, 'INVALID_GOOGLE_AMOUNT', `Enter a positive ${label} with at most six decimal places.`);
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  if (label === 'daily budget' && Math.abs(value * 10 ** digits - Math.round(value * 10 ** digits)) > 0.00001) fail(400, 'INVALID_GOOGLE_AMOUNT', `The ${currency} daily budget supports ${digits} decimal places.`);
  return String(Math.round(value * 1000000));
}
function shoppingPayload(body, customer, currency) {
  const campaignName = name(body.name), merchantId = typeof body.merchantId === 'string' && /^\d{1,20}$/.test(body.merchantId) ? body.merchantId : fail(400, 'INVALID_MERCHANT', 'Enter the linked Merchant Center account ID.');
  if (typeof body.feedLabel !== 'string' || !/^[A-Z0-9_-]{1,20}$/.test(body.feedLabel)) fail(400, 'INVALID_FEED_LABEL', 'Enter the Merchant Center feed label using uppercase letters, numbers, underscores or hyphens.');
  if (!Number.isInteger(body.priority) || body.priority < 0 || body.priority > 2) fail(400, 'INVALID_SHOPPING_PRIORITY', 'Choose a Shopping campaign priority from zero to two.');
  if (!['DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING', 'CONTAINS_EU_POLITICAL_ADVERTISING'].includes(body.euPoliticalAdvertising)) fail(400, 'EU_POLITICAL_DECLARATION_REQUIRED', 'Declare whether this campaign contains EU political advertising.');
  if (!Array.isArray(body.countries) || !body.countries.length || body.countries.length > 50 || body.countries.some(code => typeof code !== 'string' || !/^[A-Z]{2}$/.test(code))) fail(400, 'INVALID_COUNTRIES', 'Choose the countries the Shopping campaign should target.');
  const budget = `customers/${customer}/campaignBudgets/-1`, campaign = `customers/${customer}/campaigns/-2`, group = `customers/${customer}/adGroups/-3`, maxCpc = micros(body.maxCpc, currency, 'maximum CPC');
  // Country geo IDs are resolved by Google rather than a local, stale ISO-to-ID table.
  return { partialFailure: false, responseContentType: 'RESOURCE_NAME_ONLY', mutateOperations: [
    { campaignBudgetOperation: { create: { resourceName: budget, name: campaignName + ' budget', amountMicros: micros(body.dailyBudget, currency, 'daily budget'), deliveryMethod: 'STANDARD', explicitlyShared: false } } },
    { campaignOperation: { create: { resourceName: campaign, name: campaignName, status: 'PAUSED', advertisingChannelType: 'SHOPPING', campaignBudget: budget, manualCpc: {}, shoppingSetting: { merchantId, campaignPriority: body.priority, feedLabel: body.feedLabel }, geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE', negativeGeoTargetType: 'PRESENCE' }, containsEuPoliticalAdvertising: body.euPoliticalAdvertising } } },
    { adGroupOperation: { create: { resourceName: group, name: campaignName + ' products', campaign, status: 'PAUSED', type: 'SHOPPING_PRODUCT_ADS', cpcBidMicros: maxCpc } } },
    { adGroupAdOperation: { create: { adGroup: group, status: 'PAUSED', ad: { shoppingProductAd: {} } } } },
    { adGroupCriterionOperation: { create: { adGroup: group, status: 'ENABLED', cpcBidMicros: maxCpc, listingGroup: { type: 'UNIT' } } } },
  ] };
}
function createdResources(result, customer, count) {
  const rows = result.mutateOperationResponses;
  if (result.partialFailureError || !Array.isArray(rows) || rows.length !== count) throw new IntegrationError(502, 'GOOGLE_CREATION_UNCONFIRMED', 'Google did not confirm every Shopping campaign resource.', true);
  const names = { budget: rows[0]?.campaignBudgetResult?.resourceName, campaign: rows[1]?.campaignResult?.resourceName, adGroup: rows[2]?.adGroupResult?.resourceName, ad: rows[3]?.adGroupAdResult?.resourceName, listingGroup: rows[4]?.adGroupCriterionResult?.resourceName };
  const tails = { budget: 'campaignBudgets/\\d+', campaign: 'campaigns/\\d+', adGroup: 'adGroups/\\d+', ad: 'adGroupAds/\\d+~\\d+', listingGroup: 'adGroupCriteria/\\d+~\\d+' };
  if (Object.entries(names).some(([kind, resource]) => typeof resource !== 'string' || !new RegExp(`^customers/${customer}/${tails[kind]}$`).test(resource))) throw new IntegrationError(502, 'INVALID_GOOGLE_SCOPE', 'Google returned unconfirmed resource identities for the Shopping campaign.', true);
  const groupId = names.adGroup.split('/').at(-1); if (!names.ad.includes('/' + groupId + '~') || !names.listingGroup.includes('/' + groupId + '~')) throw new IntegrationError(502, 'INVALID_GOOGLE_SCOPE', 'Google did not confirm the Shopping ad group relationships.', true);
  const campaignId = names.campaign.split('/').at(-1);
  if (rows.slice(5).some(row => typeof row?.campaignCriterionResult?.resourceName !== 'string' || !new RegExp(`^customers/${customer}/campaignCriteria/${campaignId}~\\d+$`).test(row.campaignCriterionResult.resourceName))) throw new IntegrationError(502, 'INVALID_GOOGLE_SCOPE', 'Google did not confirm the Shopping campaign location criteria.', true);
  return names;
}
