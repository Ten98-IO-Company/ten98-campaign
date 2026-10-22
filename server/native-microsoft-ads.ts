import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { advisoryLock } from './auth.ts';
import { fail, IntegrationError, operation, providerRequest, mediaUrl, reportObject as plain, type OperationContext, type ProviderRecord } from './provider-core.ts';
import type { Executor } from './database.ts';
import { assertAdSpendApproval } from './approvals.ts';

type MicrosoftContext = OperationContext & { project: ProviderRecord; user: ProviderRecord; role: string; store: ProviderRecord; send: (status: number, body: unknown) => void; body?: any };
type CurrentCheck = (() => void | Promise<void>) | undefined;
type RefreshSaver = (provider: string, expected: string, next: string) => void | Promise<void>;
type MicrosoftApi = (base: string, path: string, body: unknown, method?: string) => Promise<ProviderRecord>;

const campaignApi = 'https://campaign.api.bingads.microsoft.com/CampaignManagement/v13', customerApi = 'https://clientcenter.api.bingads.microsoft.com/CustomerManagement/v13', reportingApi = 'https://reporting.api.bingads.microsoft.com/Reporting/v13';
const fields = (body: any, allowed: string[]) => { if (!plain(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_MICROSOFT_FIELDS', 'Use only the fields shown in the Microsoft Advertising editor.'); };
function id(value: any) { if (!(typeof value === 'string' || Number.isSafeInteger(value)) || !/^[1-9]\d{0,18}$/.test(String(value)) || BigInt(value) > 9223372036854775807n) fail(400, 'INVALID_MICROSOFT_ID', 'Use the numeric ID shown in Microsoft Advertising.'); return String(value); }
function text(value: any, label: string, maximum = 200) { if (typeof value !== 'string' || !value.trim() || value.length > maximum || /[\u0000-\u001f\u007f]/.test(value)) fail(400, 'INVALID_MICROSOFT_TEXT', `Enter ${label} of at most ${maximum} characters on one line.`); return value.trim(); }
function amount(value: any) { if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1000000 || Math.abs(value * 100 - Math.round(value * 100)) > 0.000001) fail(400, 'INVALID_MICROSOFT_BUDGET', 'Use a positive amount with at most two decimal places, up to 1,000,000 in the account currency.'); return value; }
function list(value: any, minimum: number, maximum: number, label: string, length: number) { if (!Array.isArray(value) || value.length < minimum || value.length > maximum) fail(400, 'INVALID_MICROSOFT_TEXT', `Use ${minimum} to ${maximum} ${label}.`); const rows = value.map((row: any) => text(row, label, length)); if (new Set(rows).size !== rows.length) fail(400, 'INVALID_MICROSOFT_TEXT', `Use distinct ${label}.`); return rows; }
const configured = (env: ProviderRecord) => Boolean(env.MICROSOFT_ADS_CLIENT_ID && env.MICROSOFT_ADS_REFRESH_TOKEN && env.MICROSOFT_ADS_DEVELOPER_TOKEN);
async function client(env: ProviderRecord, assertCurrent: CurrentCheck, persistRefresh?: RefreshSaver, mapping?: ProviderRecord | null): Promise<MicrosoftApi> {
  if (!configured(env)) fail(503, 'MICROSOFT_NOT_CONFIGURED', 'Configure Microsoft Advertising credentials in Integrations first.');
  const response = await providerRequest('https://login.microsoftonline.com/common/oauth2/v2.0/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.MICROSOFT_ADS_CLIENT_ID, ...(env.MICROSOFT_ADS_CLIENT_SECRET ? { client_secret: env.MICROSOFT_ADS_CLIENT_SECRET } : {}), grant_type: 'refresh_token', refresh_token: env.MICROSOFT_ADS_REFRESH_TOKEN, scope: 'https://ads.microsoft.com/msads.manage offline_access' }).toString() }, 'Microsoft Advertising', assertCurrent);
  if (typeof response.access_token !== 'string' || !response.access_token || /\s/.test(response.access_token) || response.access_token.length > 16384 || typeof response.token_type !== 'string' || response.token_type.toLowerCase() !== 'bearer' || typeof response.scope !== 'string' || !response.scope.split(' ').includes('https://ads.microsoft.com/msads.manage')) fail(502, 'INVALID_MICROSOFT_TOKEN', 'Microsoft did not grant the required Advertising access. Reconnect with msads.manage consent.');
  if (response.refresh_token !== undefined) {
    if (typeof response.refresh_token !== 'string' || !response.refresh_token || response.refresh_token.length > 16384 || /\s/.test(response.refresh_token)) fail(502, 'INVALID_MICROSOFT_TOKEN', 'Microsoft returned an unreadable refresh token. Reconnect the account.');
    if (response.refresh_token !== env.MICROSOFT_ADS_REFRESH_TOKEN) await persistRefresh?.('microsoftAds', env.MICROSOFT_ADS_REFRESH_TOKEN, response.refresh_token);
  }
  return async (base: string, path: string, body: unknown, method = 'POST') => {
    const result = await providerRequest(base + path, { method, headers: { Authorization: `Bearer ${response.access_token}`, DeveloperToken: env.MICROSOFT_ADS_DEVELOPER_TOKEN, ...(mapping ? { CustomerAccountId: mapping.accountId, CustomerId: mapping.customerId } : {}), 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 'Microsoft Advertising', assertCurrent);
    if (result.OperationErrors?.length || result.Errors?.length || result.Fault) fail(502, 'MICROSOFT_REQUEST_REJECTED', 'Microsoft Advertising could not complete this request. Check account permissions and the provider dashboard.');
    return result;
  };
}
export async function testMicrosoftAds(env: ProviderRecord, assertCurrent: CurrentCheck, persistRefresh?: (expected: string, next: string) => void | Promise<void>) {
  const api = await client({ ...env }, assertCurrent, persistRefresh ? (_provider: string, expected: string, next: string) => persistRefresh(expected, next) : undefined), result = await api(customerApi, '/User/Query', {});
  try { id(result.User?.Id); } catch { fail(502, 'INVALID_MICROSOFT_RESPONSE', 'Microsoft did not confirm an Advertising user.'); }
  return { ok: true, status: 'connected', message: 'Microsoft Advertising credentials accepted. Approve an account mapping in the project before managing campaigns.' };
}
function noErrors(result: ProviderRecord, uncertain = true) { if (result.PartialErrors != null && (!Array.isArray(result.PartialErrors) || result.PartialErrors.some(Boolean)) || result.NestedPartialErrors != null && (!Array.isArray(result.NestedPartialErrors) || result.NestedPartialErrors.some(Boolean))) fail(502, 'MICROSOFT_PARTIAL_RESULT', 'Microsoft did not confirm every requested item. Review the provider before repeating this action.', uncertain); }
function receiptIds(result: ProviderRecord, field: string, count: number): string[] { noErrors(result); const values = result[field]; if (!Array.isArray(values) || values.length !== count) fail(502, 'INVALID_MICROSOFT_RESPONSE', 'Microsoft did not confirm the created advertising items.', true); try { return values.map(id); } catch { fail(502, 'INVALID_MICROSOFT_RESPONSE', 'Microsoft did not confirm the created advertising items.', true); } }
function rows(result: ProviderRecord, key: string): ProviderRecord[] { if (!Array.isArray(result[key]) || result[key].length > 20000 || result[key].some((row: any) => !plain(row))) fail(502, 'INVALID_MICROSOFT_RESPONSE', 'Microsoft returned an unreadable advertising list.'); return result[key]; }
function campaignView(row: ProviderRecord) {
  let sharedBudget: boolean | null = false;
  if (row.BudgetId != null && row.BudgetId !== 0 && row.BudgetId !== '0') { try { id(row.BudgetId); sharedBudget = true; } catch { sharedBudget = null; } }
  try { const value = { id: id(row.Id), name: text(row.Name, 'a campaign name', 256), status: text(row.Status, 'a campaign status', 50), type: text(row.CampaignType || 'Search', 'a campaign type', 50), budgetType: typeof row.BudgetType === 'string' ? row.BudgetType : '', dailyBudget: row.DailyBudget ?? null, sharedBudget, bidding: row.BiddingScheme?.Type === 'MaxClicks' ? 'MaxClicksBiddingScheme' : row.BiddingScheme?.Type || '', maxCpc: row.BiddingScheme?.MaxCpc?.Amount ?? null }; for (const number of [value.dailyBudget, value.maxCpc]) if (number !== null && (typeof number !== 'number' || !Number.isFinite(number) || number < 0)) throw new Error(); return value; }
  catch { fail(502, 'INVALID_MICROSOFT_RESPONSE', 'Microsoft returned unreadable campaign details.'); }
}
async function campaigns(api: MicrosoftApi, mapping: ProviderRecord) { const result = await api(campaignApi, '/Campaigns/QueryByAccountId', { AccountId: mapping.accountId, CampaignType: 'Search' }), values = rows(result, 'Campaigns').map(campaignView); if (new Set(values.map(row => row.id)).size !== values.length) fail(502, 'INVALID_MICROSOFT_RESPONSE', 'Microsoft returned duplicate campaigns.'); return values; }
function createBody(body: ProviderRecord) {
  fields(body, ['name', 'dailyBudget', 'maxCpc', 'finalUrl', 'headlines', 'descriptions', 'keywords', 'matchType', 'locationIds', 'confirmed']);
  if (body.confirmed !== true) fail(400, 'MICROSOFT_CONFIRMATION_REQUIRED', 'Review the paused campaign, targeting, copy and budget before creating it.');
  const headlines = list(body.headlines, 3, 15, 'headlines', 30), descriptions = list(body.descriptions, 2, 4, 'descriptions', 90);
  // Dynamic substitutions and double-width text need provider-specific effective-length checks; this editor accepts literal Latin-script creative.
  if ([...headlines, ...descriptions].some(value => /[{}]|[^\u0000-\u024f\u2000-\u206f\u20a0-\u20cf]/u.test(value))) fail(400, 'UNSUPPORTED_MICROSOFT_TEXT', 'Use literal Latin-script copy in this editor. Manage dynamic or double-width creative in Microsoft Advertising.');
  if (!['Exact', 'Phrase', 'Broad'].includes(body.matchType)) fail(400, 'INVALID_MICROSOFT_KEYWORD', 'Choose Exact, Phrase or Broad keyword matching.');
  if (!Array.isArray(body.locationIds) || !body.locationIds.length || body.locationIds.length > 20) fail(400, 'INVALID_MICROSOFT_TARGETING', 'Choose 1 to 20 Microsoft location target IDs.');
  return { name: text(body.name, 'a campaign name', 128), dailyBudget: amount(body.dailyBudget), maxCpc: amount(body.maxCpc), finalUrl: mediaUrl(text(body.finalUrl, 'a public HTTPS destination', 2048)), headlines, descriptions, keywords: list(body.keywords, 1, 100, 'keywords', 80), matchType: body.matchType, locationIds: [...new Set(body.locationIds.map(id))] };
}

export async function handleMicrosoftAds(context: MicrosoftContext) {
  const { req, url, body = {}, project, role, user, db, send, store } = context, prefix = `/api/projects/${encodeURIComponent(project.id)}/microsoft-ads`;
  if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return false;
  const connection = async (executor: Executor = db) => (await executor.execute(sql`SELECT * FROM microsoft_ad_connections WHERE project_id=${project.id}`)).rows[0] as ProviderRecord | undefined;
  const path = url.pathname.slice(prefix.length), env = { ...context.config.env }, saved = await connection(), mapping = saved ? { customerId: saved.customer_id, accountId: saved.account_id, ...saved.data } : null;
  if (path === '/status' && req.method === 'GET') { const latest = mapping && (await db.execute(sql`SELECT data FROM microsoft_ad_reports WHERE project_id=${project.id} AND account_id=${mapping.accountId} ORDER BY seq DESC LIMIT 1`)).rows[0]; send(200, { configured: configured(env), mapping, latestReport: latest ? latest.data : null }); return true; }
  if (!['GET', 'POST'].includes(req.method!)) fail(405, 'MICROSOFT_METHOD_UNAVAILABLE', 'This Microsoft Advertising action is unavailable.');
  if (req.method === 'POST' && !['owner', 'admin', 'editor'].includes(role)) fail(403, 'MICROSOFT_WRITE_REQUIRED', 'Editing permission is required for Microsoft Advertising.');
  const assertCurrent = async (executor: Executor = db) => { await context.assertIntegrationSettings(executor); if (saved) { const current = await connection(executor); if (current?.account_id !== saved.account_id || current?.customer_id !== saved.customer_id) fail(409, 'MICROSOFT_MAPPING_CHANGED', 'The Microsoft account mapping changed. Refresh the project.'); } };
  if (path === '/connection' && req.method === 'POST') {
    if (!user.isOperator || !['owner', 'admin'].includes(role)) fail(403, 'MICROSOFT_MAPPING_FORBIDDEN', 'An instance operator with workspace administration access must approve this account.');
    fields(body, ['customerId', 'accountId', 'confirmed']); if (body.confirmed !== true) fail(400, 'MICROSOFT_CONFIRMATION_REQUIRED', 'Confirm this account belongs to the project before mapping it.');
    const customerId = id(body.customerId), accountId = id(body.accountId);
    if (saved && (saved.account_id !== accountId || saved.customer_id !== customerId)) fail(409, 'MICROSOFT_MAPPING_LOCKED', 'This project mapping is fixed. Use a separate project for another Microsoft account.');
    const api = await client(env, assertCurrent, context.persistNativeRefreshToken), result = await api(customerApi, '/Account/Query', { AccountId: accountId }), account = result.Account;
    if (!plain(account) || String(account.Id) !== accountId || String(account.ParentCustomerId) !== customerId || typeof account.Name !== 'string' || typeof account.CurrencyCode !== 'string' || !/^[A-Z]{3}$/.test(account.CurrencyCode) || typeof account.TimeZone !== 'string' || !account.TimeZone) fail(502, 'INVALID_MICROSOFT_ACCOUNT', 'Microsoft did not confirm the selected account, owning customer, currency and timezone.');
    const data = { name: text(account.Name, 'an account name', 256), currency: account.CurrencyCode, timeZone: account.TimeZone };
    // The project and account locks serialise parallel mappings, so each re-reads the mapping the other committed.
    await db.transaction(async tx => {
      await advisoryLock(tx, 'microsoft-ads-connection:' + project.id); await advisoryLock(tx, 'microsoft-ads-account:' + accountId);
      await assertCurrent(tx); if ((await tx.execute(sql`SELECT project_id FROM microsoft_ad_connections WHERE account_id=${accountId} AND project_id<>${project.id}`)).rowCount) fail(409, 'MICROSOFT_ACCOUNT_ALREADY_MAPPED', 'This Microsoft account is already assigned to another project.');
      const current = await connection(tx); if (current && (current.account_id !== accountId || current.customer_id !== customerId)) fail(409, 'MICROSOFT_MAPPING_CHANGED', 'Another administrator mapped this project during verification.');
      await tx.execute(sql`INSERT INTO microsoft_ad_connections VALUES (${project.id}, ${customerId}, ${accountId}, ${JSON.stringify(data)}) ON CONFLICT (project_id) DO UPDATE SET data=excluded.data`);
    });
    send(200, { mapping: { customerId, accountId, ...data } }); return true;
  }
  if (!mapping) fail(409, 'MICROSOFT_NOT_MAPPED', 'Approve a Microsoft Advertising account for this project first.');
  const api = await client(env, assertCurrent, context.persistNativeRefreshToken, mapping);
  if (path === '/campaigns' && req.method === 'GET') { send(200, { campaigns: await campaigns(api, mapping) }); return true; }
  if (path === '/campaigns' && req.method === 'POST') {
    const input = createBody(body), result = await operation(context, async () => {
      let campaignId: string | undefined;
      try {
        campaignId = receiptIds(await api(campaignApi, '/Campaigns', { AccountId: mapping.accountId, Campaigns: [{ Name: input.name, Status: 'Paused', CampaignType: 'Search', BudgetType: 'DailyBudgetStandard', DailyBudget: input.dailyBudget, TimeZone: mapping.timeZone, Languages: ['English'], BiddingScheme: { Type: 'MaxClicks', MaxCpc: { Amount: input.maxCpc } } }] }), 'CampaignIds', 1)[0];
        const criteria = input.locationIds.map(LocationId => ({ Type: 'BiddableCampaignCriterion', CampaignId: campaignId, Criterion: { Type: 'LocationCriterion', LocationId } }));
        receiptIds(await api(campaignApi, '/CampaignCriterions', { CampaignCriterions: criteria, CriterionType: 'Location' }), 'CampaignCriterionIds', criteria.length);
        const adGroupId = receiptIds(await api(campaignApi, '/AdGroups', { CampaignId: campaignId, AdGroups: [{ Name: input.name + ' search', Status: 'Active', AdGroupType: 'SearchStandard', Network: 'OwnedAndOperatedAndSyndicatedSearch', CpcBid: { Amount: input.maxCpc }, Language: 'English' }] }), 'AdGroupIds', 1)[0];
        const assets = (values: string[]) => values.map(Text => ({ Asset: { Type: 'TextAsset', Text } }));
        const adId = receiptIds(await api(campaignApi, '/Ads', { AdGroupId: adGroupId, Ads: [{ Type: 'ResponsiveSearch', Status: 'Active', FinalUrls: [input.finalUrl], Headlines: assets(input.headlines), Descriptions: assets(input.descriptions) }] }), 'AdIds', 1)[0];
        const keywordIds = receiptIds(await api(campaignApi, '/Keywords', { AdGroupId: adGroupId, Keywords: input.keywords.map(Text => ({ Text, MatchType: input.matchType, Bid: { Amount: input.maxCpc }, Status: 'Active' })) }), 'KeywordIds', input.keywords.length);
        const confirmed = (await campaigns(api, mapping)).find(row => row.id === campaignId), groups = rows(await api(campaignApi, '/AdGroups/QueryByCampaignId', { CampaignId: campaignId, ReturnAdditionalFields: 'AdGroupType' }), 'AdGroups'), ads = rows(await api(campaignApi, '/Ads/QueryByAdGroupId', { AdGroupId: adGroupId, AdTypes: ['ResponsiveSearch'] }), 'Ads'), keywords = rows(await api(campaignApi, '/Keywords/QueryByAdGroupId', { AdGroupId: adGroupId }), 'Keywords'), locations = rows(await api(campaignApi, '/CampaignCriterions/QueryByIds', { CampaignId: campaignId, CampaignCriterionIds: null, CriterionType: 'Location' }), 'CampaignCriterions');
        const ad = ads.find(row => String(row.Id) === adId), assetTexts = (values: any) => Array.isArray(values) ? values.map(row => row?.Asset?.Text).sort() : [], same = (before: any[], after: any[]) => JSON.stringify([...before].sort()) === JSON.stringify(after);
        if (!confirmed || confirmed.status !== 'Paused' || confirmed.name !== input.name || confirmed.dailyBudget !== input.dailyBudget || confirmed.sharedBudget !== false || confirmed.bidding !== 'MaxClicksBiddingScheme' || confirmed.maxCpc !== input.maxCpc || !groups.some(row => String(row.Id) === adGroupId && row.Status === 'Active' && row.AdGroupType === 'SearchStandard') || ad?.Type !== 'ResponsiveSearch' || ad.Status !== 'Active' || !same([input.finalUrl], [...(ad.FinalUrls || [])].sort()) || !same(input.headlines, assetTexts(ad.Headlines)) || !same(input.descriptions, assetTexts(ad.Descriptions)) || keywordIds.some((value, index) => !keywords.some(row => String(row.Id) === value && row.Text === input.keywords[index] && row.MatchType === input.matchType && row.Status === 'Active')) || input.locationIds.some(value => !locations.some(row => String(row.CampaignId) === campaignId && row.Type === 'BiddableCampaignCriterion' && String(row.Criterion?.LocationId) === value))) fail(502, 'MICROSOFT_READBACK_REQUIRED', 'Microsoft accepted part of this campaign but its saved structure could not be confirmed.', true);
        const campaign = await store.create(project.id, 'campaigns', { name: input.name, channel: 'paid', status: 'paused', budget: input.dailyBudget, budgetType: 'daily', currency: mapping.currency, nativeProvider: 'microsoft', nativeAccountId: mapping.accountId, nativeCampaignId: campaignId, nativeAdGroupId: adGroupId, nativeAdId: adId, providerStatus: 'Paused' });
        await store.activity(project.id, 'Created and verified a paused Microsoft Advertising search campaign.'); return { campaign, providerCampaign: confirmed, ids: { campaignId, adGroupId, adId, keywordIds } };
      } catch (error) { if (campaignId) throw new IntegrationError(502, 'MICROSOFT_PARTIAL_CAMPAIGN', `Microsoft campaign ${campaignId} may be partially created and remains paused. Review it in Microsoft Advertising before repeating this request.`, true); throw error; }
    }); send(result.status, result.data); return true;
  }
  const change = path.match(/^\/campaigns\/([1-9]\d{0,18})$/);
  if (change && req.method === 'POST') {
    fields(body, ['status', 'dailyBudget', 'confirmed']); if (body.confirmed !== true) fail(400, 'MICROSOFT_CONFIRMATION_REQUIRED', 'Confirm the campaign status or budget change and any provider charges.');
    if (body.status !== undefined && !['Active', 'Paused'].includes(body.status) || body.status === undefined && body.dailyBudget === undefined) fail(400, 'INVALID_MICROSOFT_UPDATE', 'Choose Active, Paused or a daily budget.');
    const campaignId = id(change[1]), current = (await campaigns(api, mapping)).find(row => row.id === campaignId); if (!current) fail(404, 'MICROSOFT_CAMPAIGN_NOT_FOUND', 'This search campaign was not found in the project account.');
    if (!['Active', 'Paused'].includes(current.status) || body.dailyBudget !== undefined && (current.sharedBudget !== false || !['DailyBudgetStandard', 'DailyBudgetAccelerated'].includes(current.budgetType))) fail(422, 'MICROSOFT_CAMPAIGN_UNSUPPORTED', 'Manage terminal campaigns, shared or unconfirmed budgets and unsupported budget types in Microsoft Advertising.');
    const patch = { Id: campaignId, ...(body.status ? { Status: body.status } : {}), ...(body.dailyBudget !== undefined ? { DailyBudget: amount(body.dailyBudget) } : {}) }, result = await operation(context, async key => {
      // An activation spends the budget the campaign has after this change; a budget change alone spends the new budget.
      if (patch.Status === 'Active' || patch.DailyBudget !== undefined) await assertAdSpendApproval(context, { subjectId: campaignId, platform: 'microsoft', action: patch.Status === 'Active' ? 'microsoft/campaign-status' : 'microsoft/campaign-budget', amount: patch.DailyBudget ?? current.dailyBudget, currency: mapping.currency, currentAmount: current.dailyBudget, activates: patch.Status === 'Active' }, key);
      noErrors(await api(campaignApi, '/Campaigns', { AccountId: mapping.accountId, Campaigns: [patch] }, 'PUT'));
      let confirmed: ReturnType<typeof campaignView>;
      try { confirmed = (await campaigns(api, mapping)).find(row => row.id === campaignId)!; if (!confirmed || patch.Status && confirmed.status !== patch.Status || patch.DailyBudget !== undefined && confirmed.dailyBudget !== patch.DailyBudget) throw new Error('Campaign update mismatch.'); }
      catch { fail(502, 'MICROSOFT_READBACK_REQUIRED', 'Microsoft did not confirm the requested campaign change. Check the provider before repeating it.', true); }
      for (const local of (await store.list(project.id, 'campaigns')).filter((row: ProviderRecord) => row.nativeProvider === 'microsoft' && row.nativeAccountId === mapping.accountId && row.nativeCampaignId === campaignId)) await store.update(project.id, 'campaigns', local.id, { status: confirmed.status.toLowerCase(), ...(patch.DailyBudget !== undefined ? { budget: confirmed.dailyBudget } : {}), providerStatus: confirmed.status });
      return { campaign: confirmed };
    }, ['ads', 'microsoft', campaignId]); send(result.status, result.data); return true;
  }
  if (path === '/reports' && req.method === 'POST') {
    fields(body, ['fromDate', 'toDate']); for (const value of [body.fromDate, body.toDate]) if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) fail(400, 'INVALID_MICROSOFT_REPORT_DATE', 'Choose valid report start and end dates.');
    if (body.fromDate > body.toDate || Date.parse(body.toDate) - Date.parse(body.fromDate) >= 366 * 86400000 || body.toDate > new Date().toISOString().slice(0, 10)) fail(400, 'INVALID_MICROSOFT_REPORT_DATE', 'Choose at most 366 inclusive report days ending no later than today.');
    const date = (value: string) => ({ Year: Number(value.slice(0, 4)), Month: Number(value.slice(5, 7)), Day: Number(value.slice(8, 10)) });
    const result = await api(reportingApi, '/GenerateReport/Submit', { ReportRequest: { Type: 'CampaignPerformanceReportRequest', ReportName: 'Campaign performance', Format: 'Csv', FormatVersion: '2.0', Aggregation: 'Summary', ReturnOnlyCompleteData: false, ExcludeReportFooter: true, ExcludeReportHeader: true, Scope: { AccountIds: [mapping.accountId] }, Time: { CustomDateRangeStart: date(body.fromDate), CustomDateRangeEnd: date(body.toDate), ReportTimeZone: 'GreenwichMeanTimeDublinEdinburghLisbonLondon' }, Columns: ['AccountId', 'CampaignId', 'CampaignName', 'Impressions', 'Clicks', 'Spend', 'Conversions'] } });
    if (typeof result.ReportRequestId !== 'string' || !result.ReportRequestId || result.ReportRequestId.length > 40) fail(502, 'INVALID_MICROSOFT_REPORT', 'Microsoft did not return a readable report request.');
    const report = { id: randomUUID(), fromDate: body.fromDate, toDate: body.toDate, status: 'Pending', createdAt: new Date().toISOString() }; await assertCurrent(); await db.execute(sql`INSERT INTO microsoft_ad_reports (id,project_id,account_id,request_id,data) VALUES (${report.id}, ${project.id}, ${mapping.accountId}, ${result.ReportRequestId}, ${JSON.stringify(report)})`); send(200, { report }); return true;
  }
  const report = path.match(/^\/reports\/([\w-]+)$/);
  if (report && req.method === 'GET') {
    const row = (await db.execute(sql`SELECT * FROM microsoft_ad_reports WHERE id=${report[1]} AND project_id=${project.id} AND account_id=${mapping.accountId}`)).rows[0] as ProviderRecord | undefined; if (!row) fail(404, 'MICROSOFT_REPORT_NOT_FOUND', 'This report was not found in the project account.');
    const result = await api(reportingApi, '/GenerateReport/Poll', { ReportRequestId: row.request_id }), remote = result.ReportRequestStatus;
    if (!plain(remote) || !['Pending', 'Success', 'Error'].includes(remote.Status)) fail(502, 'INVALID_MICROSOFT_REPORT', 'Microsoft did not return a readable report status.');
    let downloadUrl; if (remote.Status === 'Success' && remote.ReportDownloadUrl) { try { downloadUrl = mediaUrl(remote.ReportDownloadUrl); } catch { fail(502, 'INVALID_MICROSOFT_REPORT', 'Microsoft returned an unsupported report download address.'); } }
    send(200, { report: { ...row.data, status: remote.Status, ...(downloadUrl ? { downloadUrl } : {}), empty: remote.Status === 'Success' && !downloadUrl } }); return true;
  }
  fail(404, 'MICROSOFT_ACTION_NOT_FOUND', 'This Microsoft Advertising action was not found.');
}
