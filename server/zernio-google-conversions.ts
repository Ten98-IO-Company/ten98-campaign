import type { DatabaseSync } from 'node:sqlite';
import type { OperationContext, ProviderRecord, ZernioApi } from './provider-core.ts';
type Ctx = OperationContext & { body: any };
import { createHash } from 'node:crypto';
import { IntegrationError, operation, scopedAccounts, requireAccount, adAccounts, campaignTree, validProviderInstant, fail, reportObject as object } from './provider-core.ts';

const writers = new Set(['owner', 'admin', 'editor']), initialized = new WeakSet();
const categories = ['DEFAULT', 'PAGE_VIEW', 'PURCHASE', 'SIGNUP', 'DOWNLOAD', 'ADD_TO_CART', 'BEGIN_CHECKOUT', 'SUBSCRIBE_PAID', 'PHONE_CALL_LEAD', 'IMPORTED_LEAD', 'SUBMIT_LEAD_FORM', 'BOOK_APPOINTMENT', 'REQUEST_QUOTE', 'GET_DIRECTIONS', 'OUTBOUND_CLICK', 'CONTACT', 'ENGAGEMENT', 'STORE_VISIT', 'STORE_SALE', 'QUALIFIED_LEAD', 'CONVERTED_LEAD'];
const actionSettings = ['name', 'status', 'defaultValue', 'alwaysUseDefaultValue', 'category', 'countingType', 'defaultCurrency', 'clickThroughLookbackWindowDays', 'viewThroughLookbackWindowDays', 'primaryForGoal'];
const invalid = (uncertain = false) => fail(502, 'INVALID_GOOGLE_CONVERSION_RESPONSE', 'Zernio returned unreadable or unscoped Google conversion settings.', uncertain);
const plain = (value: any, max = 2000) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const numeric = (value: any) => typeof value === 'string' && /^\d{1,30}$/.test(value);
const enumeration = (value: any) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,99}$/.test(value);
const id = (value: any) => { if (!numeric(value)) fail(400, 'INVALID_GOOGLE_CONVERSION_ID', 'Choose a valid Google customer, action, goal or campaign.'); return value; };
const label = (value: any, max: any) => { if (!plain(value, max) || !value.trim()) fail(400, 'INVALID_GOOGLE_CONVERSION_SETTINGS', 'Complete the conversion settings using plain text.'); return value.trim(); };
const fields = (value: any, allowed: any) => { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'INVALID_GOOGLE_CONVERSION_FIELDS', 'Use only the conversion settings shown in this form.'); };
const sorted = (rows: any) => [...rows].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const digest = (value: any) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (left: any, right: any) => JSON.stringify(left) === JSON.stringify(right);
const goalKey = (value: any) => value.category + ':' + value.origin;
function list(value: any, project: any, key: any, maximum = 5000) {
  // ponytail: one bounded provider list, capped at 5,000 conversion resources; use Google Ads above this ceiling.
  if (!Array.isArray(value) || value.length > maximum) invalid();
  const rows = value.map(project); if (new Set(rows.map(key)).size !== rows.length) invalid(); return rows;
}
function scopedResponse(value: any, scope: any) { if (!object(value) || value.customerId !== scope.adAccountId) invalid(); }
function resource(value: any, scope: any, path: any) { if (value !== undefined && value !== `customers/${scope.adAccountId}/${path}`) invalid(); }
function action(row: ProviderRecord) {
  if (!object(row) || !numeric(row.id) || !plain(row.name, 100) || !row.name.trim() || !['type', 'status', 'category'].every(key => enumeration(row[key]))) invalid();
  const result: ProviderRecord = { id: row.id, name: row.name, type: row.type, status: row.status, category: row.category };
  for (const key of ['origin', 'countingType']) if (row[key] !== undefined) { if (!enumeration(row[key])) invalid(); result[key] = row[key]; }
  for (const key of ['primaryForGoal', 'alwaysUseDefaultValue']) if (row[key] !== undefined) { if (typeof row[key] !== 'boolean') invalid(); result[key] = row[key]; }
  if (row.defaultValue !== undefined) { if (typeof row.defaultValue !== 'number' || !Number.isFinite(row.defaultValue) || row.defaultValue < 0) invalid(); result.defaultValue = row.defaultValue; }
  if (row.defaultCurrency !== undefined) { if (typeof row.defaultCurrency !== 'string' || !/^[A-Z]{3}$/.test(row.defaultCurrency)) invalid(); result.defaultCurrency = row.defaultCurrency; }
  for (const [key, max] of [['clickThroughLookbackWindowDays', 90], ['viewThroughLookbackWindowDays', 30]]) if (row[key] !== undefined) { if (!Number.isInteger(row[key]) || row[key] < 1 || row[key] > max) invalid(); result[key] = row[key]; }
  result.tagSnippets = list(row.tagSnippets, (item: any) => { if (!object(item) || !enumeration(item.type) || ['pageFormat', 'globalSiteTag', 'eventSnippet'].some(key => item[key] !== undefined && !plain(item[key], 100000))) invalid(); return { type: item.type, ...Object.fromEntries(['pageFormat', 'globalSiteTag', 'eventSnippet'].filter(key => item[key] !== undefined).map(key => [key, item[key]])) }; }, (item: any) => JSON.stringify(item), 20);
  return result;
}
function goal(row: ProviderRecord, scope: any, campaignId?: any) {
  if (!object(row) || !enumeration(row.category) || !enumeration(row.origin) || typeof row.biddable !== 'boolean') invalid();
  if (row.resourceName !== undefined && (!plain(row.resourceName, 500) || !row.resourceName.startsWith(`customers/${scope.adAccountId}/${campaignId ? `campaignConversionGoals/${campaignId}~` : 'customerConversionGoals/'}`))) invalid();
  const result: ProviderRecord = { category: row.category, origin: row.origin, biddable: row.biddable };
  if (!campaignId) result.conversionActions = list(row.conversionActions, (item: any) => { if (!object(item) || !numeric(item.id) || !plain(item.name, 100) || !item.name || !enumeration(item.status) || typeof item.primaryForGoal !== 'boolean') invalid(); return { id: item.id, name: item.name, status: item.status, primaryForGoal: item.primaryForGoal }; }, (item: any) => item.id);
  return result;
}
function customGoal(row: ProviderRecord, scope: any) {
  if (!object(row) || !numeric(row.id) || !plain(row.name, 255) || !row.name.trim() || !enumeration(row.status)) invalid();
  resource(row.resourceName, scope, `customConversionGoals/${row.id}`);
  const conversionActionIds = list(row.conversionActionIds, (value: any) => { if (!numeric(value)) invalid(); return value; }, (value: any) => value, 100);
  return { id: row.id, name: row.name, status: row.status, conversionActionIds: conversionActionIds.sort() };
}
function snapshot(value: any, scope: any, key: any, project: any, rowKey: any, freshness = true): ProviderRecord {
  scopedResponse(value, scope);
  const result: ProviderRecord = { customerId: scope.adAccountId, [key]: sorted(list(value[key], project, rowKey)) };
  if (freshness) { if (typeof value.stale !== 'boolean' || value.cachedAt !== null && !validProviderInstant(value.cachedAt)) invalid(); Object.assign(result, { stale: value.stale, cachedAt: value.cachedAt }); }
  return { ...result, version: digest({ accountId: scope.accountId, customerId: scope.adAccountId, [key]: result[key] }) };
}
const readActions = async (api: ZernioApi, scope: any) => snapshot(await api('/ads/conversions/actions', scope.query), scope, 'actions', action, (row: ProviderRecord) => row.id);
const readGoals = async (api: ZernioApi, scope: any) => snapshot(await api('/ads/conversions/goals', scope.query), scope, 'goals', (row: ProviderRecord) => goal(row, scope), goalKey);
const readCustom = async (api: ZernioApi, scope: any) => snapshot(await api('/ads/conversions/custom-goals', scope.query), scope, 'goals', (row: ProviderRecord) => customGoal(row, scope), (row: ProviderRecord) => row.id);
function current(expectedVersion: any, value: any) {
  if (value.stale) fail(409, 'GOOGLE_CONVERSION_DATA_STALE', 'Google returned an older cached snapshot. Wait for a fresh read before changing conversion settings.');
  if (expectedVersion !== value.version) fail(409, 'GOOGLE_CONVERSION_REVIEW_CHANGED', 'These conversion settings changed. Refresh and review them again.');
}
async function campaignScope(api: ZernioApi, scope: any, campaignId: any) {
  const tree = await campaignTree(api, scope.profileId, { ...scope.query, profileId: scope.profileId, platform: 'google' });
  const rows = tree.campaigns.filter((row: ProviderRecord) => row.platform === 'google' && String(row.accountId?._id || row.accountId) === scope.accountId && String(row.platformAdAccountId) === scope.adAccountId && String(row.platformCampaignId) === campaignId);
  if (rows.length !== 1) fail(403, 'CAMPAIGN_OUTSIDE_PROJECT', 'Choose a campaign owned by this connection and Google advertising account.');
  return rows[0];
}
function campaignSnapshot(value: any, scope: any, campaignId: any, freshness = true): ProviderRecord {
  scopedResponse(value, scope);
  if (value.campaignId !== campaignId || !['CUSTOMER', 'CAMPAIGN', 'UNSPECIFIED', 'UNKNOWN'].includes(value.goalConfigLevel) || value.customConversionGoalId !== null && !numeric(value.customConversionGoalId)) invalid();
  const result = snapshot(value, scope, 'goals', (row: ProviderRecord) => goal(row, scope, campaignId), goalKey, freshness);
  const data: ProviderRecord = { ...result, campaignId, goalConfigLevel: value.goalConfigLevel, customConversionGoalId: value.customConversionGoalId };
  return { ...data, version: digest({ accountId: scope.accountId, customerId: scope.adAccountId, campaignId, goalConfigLevel: data.goalConfigLevel, customConversionGoalId: data.customConversionGoalId, goals: data.goals }) };
}
async function readCampaign(api: ZernioApi, scope: any, campaignId: any) { await campaignScope(api, scope, campaignId); return campaignSnapshot(await api(`/ads/campaigns/${campaignId}/conversion-goals`), scope, campaignId); }
function settings(body: any, creating = false) {
  fields(body, creating ? actionSettings.filter(key => key !== 'status').concat('type') : actionSettings);
  if (!Object.keys(body).length) fail(400, 'EMPTY_GOOGLE_CONVERSION_UPDATE', 'Choose a conversion setting to change.');
  const result: ProviderRecord = {};
  if (creating) { if (body.type !== 'WEBPAGE') fail(400, 'INVALID_GOOGLE_CONVERSION_TYPE', 'New conversion actions must use the website type.'); Object.assign(result, { type: 'WEBPAGE', category: 'DEFAULT', ...(body.defaultValue !== undefined && body.alwaysUseDefaultValue === undefined ? { alwaysUseDefaultValue: true } : {}) }); }
  if (creating || body.name !== undefined) result.name = label(body.name, 100);
  for (const key of ['primaryForGoal', 'alwaysUseDefaultValue']) if (body[key] !== undefined) { if (typeof body[key] !== 'boolean') fail(400, 'INVALID_GOOGLE_CONVERSION_SETTINGS', 'Choose explicit conversion value and bidding settings.'); result[key] = body[key]; }
  if (body.status !== undefined) { if (!['ENABLED', 'REMOVED'].includes(body.status) || body.status === 'REMOVED' && Object.keys(body).length !== 1) fail(400, 'INVALID_GOOGLE_CONVERSION_STATUS', 'Remove an action separately from other setting changes.'); result.status = body.status; }
  if (body.category !== undefined) { if (!categories.includes(body.category)) fail(400, 'INVALID_GOOGLE_CONVERSION_CATEGORY', 'Choose a supported conversion category.'); result.category = body.category; }
  if (body.countingType !== undefined) { if (!['ONE_PER_CLICK', 'MANY_PER_CLICK'].includes(body.countingType)) fail(400, 'INVALID_GOOGLE_CONVERSION_SETTINGS', 'Choose one or every conversion per click.'); result.countingType = body.countingType; }
  if (body.defaultValue !== undefined) { if (typeof body.defaultValue !== 'number' || !Number.isFinite(body.defaultValue) || body.defaultValue < 0) fail(400, 'INVALID_GOOGLE_CONVERSION_SETTINGS', 'Enter a non-negative default conversion value.'); result.defaultValue = body.defaultValue; }
  if (body.defaultCurrency !== undefined) { if (typeof body.defaultCurrency !== 'string' || !/^[A-Z]{3}$/.test(body.defaultCurrency)) fail(400, 'INVALID_GOOGLE_CONVERSION_SETTINGS', 'Choose a three-letter uppercase currency.'); result.defaultCurrency = body.defaultCurrency; }
  for (const [key, max] of [['clickThroughLookbackWindowDays', 90], ['viewThroughLookbackWindowDays', 30]]) if (body[key] !== undefined) { if (!Number.isInteger(body[key]) || body[key] < 1 || body[key] > max) fail(400, 'INVALID_GOOGLE_CONVERSION_SETTINGS', 'Choose valid click and view lookback windows.'); result[key] = body[key]; }
  return result;
}
function biddableGoals(value: any, available: any, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 100) fail(400, 'INVALID_GOOGLE_CONVERSION_GOALS', 'Choose up to 100 existing conversion goals.');
  const rows = value.map((row: ProviderRecord) => { fields(row, ['category', 'origin', 'biddable']); if (typeof row.biddable !== 'boolean' || !available.some((item: any) => goalKey(item) === goalKey(row))) fail(400, 'GOOGLE_CONVERSION_GOAL_OUTSIDE_CUSTOMER', 'Choose goals from this advertising account’s reviewed list.'); return { category: row.category, origin: row.origin, biddable: row.biddable }; });
  if (new Set(rows.map(goalKey)).size !== rows.length) fail(400, 'DUPLICATE_GOOGLE_CONVERSION_GOAL', 'Choose each category and origin once.'); return rows;
}
function selectedActions(value: any, available: any) {
  if (!Array.isArray(value) || !value.length || value.length > 100 || value.some(item => !numeric(item) || !available.some((row: ProviderRecord) => row.id === item && row.status !== 'REMOVED')) || new Set(value).size !== value.length) fail(400, 'GOOGLE_CONVERSION_ACTION_OUTSIDE_CUSTOMER', 'Choose between 1 and 100 distinct non-removed conversion actions from this account.');
  return [...value].sort();
}
function tables(db: DatabaseSync) { if (initialized.has(db)) return; db.exec('CREATE TABLE IF NOT EXISTS zernio_google_conversion_mutations(customer_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL)'); initialized.add(db); }
async function mutate(context: Ctx, scope: any, run: any) {
  tables(context.db);
  return operation(context, async key => {
    const values = [scope.adAccountId, context.project.id, key], old = context.db.prepare('SELECT m.request_key,o.status FROM zernio_google_conversion_mutations m LEFT JOIN integration_operations o ON o.project_id=m.project_id AND o.request_key=m.request_key WHERE m.customer_id=?').get(scope.adAccountId) as ProviderRecord;
    if (old && (!old.status || ['pending', 'uncertain'].includes(old.status))) fail(409, 'GOOGLE_CONVERSION_PREVIOUS_OUTCOME_UNRESOLVED', 'This new change was not sent. An administrator must review the previous action for this Google customer in provider outcomes first.');
    context.db.prepare('INSERT INTO zernio_google_conversion_mutations VALUES(?,?,?) ON CONFLICT(customer_id) DO UPDATE SET project_id=excluded.project_id,request_key=excluded.request_key').run(...values);
    try { const result = await run(key); context.db.prepare('DELETE FROM zernio_google_conversion_mutations WHERE customer_id=? AND project_id=? AND request_key=?').run(...values); return result; }
    catch (error) { if (error instanceof IntegrationError && !error.uncertain) context.db.prepare('DELETE FROM zernio_google_conversion_mutations WHERE customer_id=? AND project_id=? AND request_key=?').run(...values); throw error; }
  }, ['google-conversions', scope.adAccountId]);
}
function confirmed(check: any) { if (!check) invalid(true); }
async function afterWrite(run: any) { try { return await run(); } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; } }
async function accountScope(api: ZernioApi, profileId: string, accountId: string, adAccountId: any, write: any) {
  const account = requireAccount(await scopedAccounts(api, profileId), accountId);
  if (account.platform !== 'googleads' || account.isActive === false) fail(409, 'GOOGLE_ACCOUNT_REQUIRED', 'Choose an active Google Ads connection.');
  const nativeRows = (await adAccounts(api, accountId)).accounts;
  if (nativeRows.some((row: ProviderRecord) => !object(row) || !numeric(row.id) || row.selectable !== undefined && typeof row.selectable !== 'boolean') || new Set(nativeRows.map((row: ProviderRecord) => row.id)).size !== nativeRows.length) invalid();
  const native = nativeRows.find((row: ProviderRecord) => row.id === adAccountId); if (!native) fail(403, 'AD_ACCOUNT_OUTSIDE_PROJECT', 'Choose a Google advertising account available through this project connection.');
  if (write && native.selectable === false) fail(409, 'ACCOUNT_UNAVAILABLE', 'This Google advertising account cannot accept changes.');
}
async function writeProvider(api: ZernioApi, scope: any, path: any, query: any, body: any, key: any, method: any) { await accountScope(api, scope.profileId, scope.accountId, scope.adAccountId, true); return api(path, query, body, key, method); }

export async function handleGoogleConversions(context: Ctx, api: ZernioApi, profileId: string, route: any) {
  const { req, url, body = {}, role, send } = context, match = /^([^/]+)\/(actions|goals|custom-goals|campaigns)(?:\/([^/]+)(?:\/(update|remove))?)?$/.exec(route);
  if (!match) return false;
  let accountId; try { accountId = decodeURIComponent(match[1]); } catch { fail(400, 'INVALID_GOOGLE_CONVERSION_ID', 'Choose a valid Google connection.'); }
  const kind = match[2], resourceId = match[3], verb = match[4], write = req.method === 'POST', creating = resourceId === 'create' && !verb, actionId = kind === 'actions' && resourceId && !creating ? id(resourceId) : null, goalId = kind === 'custom-goals' && resourceId && !creating ? id(resourceId) : null, campaignId = kind === 'campaigns' ? id(resourceId) : null;
  if (!['GET', 'POST'].includes(req.method!) || kind === 'goals' && resourceId && resourceId !== 'update' || verb === 'remove' && kind !== 'custom-goals' || kind === 'campaigns' && !resourceId || write && !(creating && ['actions', 'custom-goals'].includes(kind) || kind === 'goals' && resourceId === 'update' || verb === 'update' || verb === 'remove') || !write && (resourceId && kind !== 'campaigns' || verb)) fail(405, 'METHOD_NOT_ALLOWED', 'Use the available conversion controls.');
  if (write && !writers.has(role)) fail(403, 'GOOGLE_CONVERSION_PERMISSION_REQUIRED', 'Editing permission is required to change Google conversion settings.');
  if (write) { fields(body, ['adAccountId', 'expectedVersion', 'expectedActionsVersion', 'expectedCustomVersion', 'confirmChange', 'settings']); if (body.confirmChange !== true) fail(400, 'GOOGLE_CONVERSION_CONFIRMATION_REQUIRED', 'Review the exact account, resource and conversion settings before saving.'); }
  else if ([...url.searchParams.keys()].some(key => key !== 'adAccountId')) fail(400, 'INVALID_GOOGLE_CONVERSION_FILTER', 'Use the selected Google advertising account.');
  if (!plain(accountId, 500) || !accountId || /\s/.test(accountId)) fail(400, 'INVALID_GOOGLE_CONVERSION_ID', 'Choose a valid Google connection.');
  const adAccountId = id(write ? body.adAccountId : url.searchParams.get('adAccountId')); await accountScope(api, profileId, accountId, adAccountId, write);
  const scope = { accountId, adAccountId, profileId, query: { accountId, adAccountId } };
  if (!write) { const result = kind === 'actions' ? await readActions(api, scope) : kind === 'goals' ? await readGoals(api, scope) : kind === 'custom-goals' ? await readCustom(api, scope) : await readCampaign(api, scope, campaignId); send(200, result); return true; }
  const outcome = await mutate(context, scope, async (key: any) => {
    if (kind === 'actions') {
      const payload = settings(body.settings, creating), before = await readActions(api, scope); current(body.expectedVersion, before);
      if (!creating && !before.actions.some((row: ProviderRecord) => row.id === actionId)) fail(403, 'GOOGLE_CONVERSION_ACTION_OUTSIDE_CUSTOMER', 'Choose a conversion action from this account.');
      const response = await writeProvider(api, scope, creating ? '/ads/conversions/actions' : `/ads/conversions/actions/${actionId}`, {}, { ...scope.query, ...payload }, key, creating ? 'POST' : 'PATCH');
      return afterWrite(async () => {
        if (creating) { if (response.customerId !== undefined) scopedResponse(response, scope); const result = action(response.action); confirmed(!before.actions.some((row: ProviderRecord) => row.id === result.id) && Object.entries(payload).every(([name, value]) => same(result[name], value))); return { action: result }; }
        scopedResponse(response, scope); confirmed(response.action?.id === actionId && Object.entries(payload).every(([name, value]) => same(response.action[name], value))); return { action: { id: actionId, ...payload }, accepted: true };
      });
    }
    if (kind === 'goals') {
      fields(body.settings, ['goals']); const before = await readGoals(api, scope); current(body.expectedVersion, before); const goals = biddableGoals(body.settings.goals, before.goals);
      const response = await writeProvider(api, scope, '/ads/conversions/goals', {}, { ...scope.query, goals }, key, 'PATCH');
      return afterWrite(async () => { const result = snapshot(response, scope, 'goals', (row: ProviderRecord) => goal(row, scope), goalKey, false); confirmed(goals.every((row: ProviderRecord) => result.goals.some((item: any) => goalKey(item) === goalKey(row) && item.biddable === row.biddable))); return { ...result, accepted: true }; });
    }
    if (kind === 'custom-goals') {
      fields(body.settings, verb === 'remove' ? [] : ['name', 'conversionActionIds']); const before = await readCustom(api, scope); current(body.expectedVersion, before);
      const previous = before.goals.find((row: ProviderRecord) => row.id === goalId); if (!creating && !previous) fail(403, 'GOOGLE_CUSTOM_GOAL_OUTSIDE_CUSTOMER', 'Choose a custom goal from this account.');
      const payload: ProviderRecord = {};
      if (creating || body.settings.name !== undefined) payload.name = label(body.settings.name, 255);
      if (creating || body.settings.conversionActionIds !== undefined) { const actions = await readActions(api, scope); current(body.expectedActionsVersion, actions); payload.conversionActionIds = selectedActions(body.settings.conversionActionIds, actions.actions); }
      if (verb !== 'remove' && !Object.keys(payload).length) fail(400, 'EMPTY_GOOGLE_CONVERSION_UPDATE', 'Change the custom goal name or its action set.');
      const response = await writeProvider(api, scope, creating ? '/ads/conversions/custom-goals' : `/ads/conversions/custom-goals/${goalId}`, verb === 'remove' ? scope.query : {}, verb === 'remove' ? undefined : { ...scope.query, ...payload }, key, creating ? 'POST' : verb === 'remove' ? 'DELETE' : 'PATCH');
      return afterWrite(async () => {
        scopedResponse(response, scope);
        if (verb === 'remove') { confirmed(response.goalId === goalId && response.removed === true); const result = await readCustom(api, scope); confirmed(!result.stale && !result.goals.some((row: ProviderRecord) => row.id === goalId)); return { ...result, removed: goalId }; }
        if (creating) { confirmed(numeric(response.id) && !before.goals.some((row: ProviderRecord) => row.id === response.id)); resource(response.resourceName, scope, `customConversionGoals/${response.id}`); const result = await readCustom(api, scope), found = result.goals.find((row: ProviderRecord) => row.id === response.id); confirmed(!result.stale && found && found.name === payload.name && same(found.conversionActionIds, payload.conversionActionIds)); return { ...result, goal: found }; }
        const result = customGoal(response.goal, scope); confirmed(result.id === goalId && result.status === previous.status && result.name === (payload.name ?? previous.name) && same(result.conversionActionIds, payload.conversionActionIds ?? previous.conversionActionIds)); return { goal: result };
      });
    }
    fields(body.settings, ['goals', 'goalConfigLevel', 'customConversionGoalId']); if (!Object.keys(body.settings).length) fail(400, 'EMPTY_GOOGLE_CONVERSION_UPDATE', 'Choose campaign conversion settings to change.');
    const before = await readCampaign(api, scope, campaignId); current(body.expectedVersion, before); const payload: ProviderRecord = {};
    if (body.settings.goals !== undefined) payload.goals = biddableGoals(body.settings.goals, before.goals, 0);
    if (body.settings.goalConfigLevel !== undefined) { if (!['CUSTOMER', 'CAMPAIGN'].includes(body.settings.goalConfigLevel)) fail(400, 'INVALID_GOOGLE_CAMPAIGN_GOALS', 'Choose account-default or campaign conversion goals.'); payload.goalConfigLevel = body.settings.goalConfigLevel; }
    if (body.settings.customConversionGoalId !== undefined) { const selected = body.settings.customConversionGoalId; if (selected !== null) { id(selected); const custom = await readCustom(api, scope); current(body.expectedCustomVersion, custom); if (!custom.goals.some((row: ProviderRecord) => row.id === selected && row.status !== 'REMOVED')) fail(403, 'GOOGLE_CUSTOM_GOAL_OUTSIDE_CUSTOMER', 'Choose a current custom conversion goal from this account.'); } payload.customConversionGoalId = selected; }
    const effectiveLevel = payload.goalConfigLevel ?? before.goalConfigLevel, effectiveCustom = payload.customConversionGoalId === undefined ? before.customConversionGoalId : payload.customConversionGoalId, effectiveGoals = before.goals.map((row: ProviderRecord) => payload.goals?.find((item: any) => goalKey(item) === goalKey(row)) || row);
    if (effectiveLevel === 'CAMPAIGN' && !effectiveCustom && !effectiveGoals.some((row: ProviderRecord) => row.biddable)) fail(400, 'GOOGLE_CAMPAIGN_GOALS_REQUIRED', 'Keep a biddable campaign goal or custom goal, or switch to account defaults.');
    await campaignScope(api, scope, campaignId);
    const response = await writeProvider(api, scope, `/ads/campaigns/${campaignId}/conversion-goals`, {}, payload, key, 'PATCH');
    return afterWrite(async () => { const result = campaignSnapshot(response, scope, campaignId, false); confirmed(result.goalConfigLevel === (payload.goalConfigLevel ?? before.goalConfigLevel) && result.customConversionGoalId === (payload.customConversionGoalId === undefined ? before.customConversionGoalId : payload.customConversionGoalId) && (!payload.goals || payload.goals.every((row: ProviderRecord) => result.goals.some((item: any) => goalKey(item) === goalKey(row) && item.biddable === row.biddable)))); return result; });
  }); send(outcome.status, outcome.data); return true;
}
