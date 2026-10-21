import { sql } from 'drizzle-orm';
import type { OperationContext, ProviderRecord, ZernioApi } from './provider-core.ts';
type Ctx = OperationContext & { body: any };
import { IntegrationError, operation, scopedAccounts, requireAccount, adAccounts, fail, reportObject as object } from './provider-core.ts';

const platforms = new Set(['metaads', 'googleads', 'linkedinads', 'tiktokads', 'pinterestads', 'xads', 'openaiads', 'redditads']);
const eventTypes = ['order_created', 'lead_created', 'items_added', 'contents_viewed', 'checkout_started', 'registration_completed', 'subscription_created', 'trial_started', 'appointment_scheduled', 'page_viewed', 'app_installed', 'app_opened'];
const validId = (value: any) => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\s\u0000-\u001f]/.test(value);
const identifier = (value: any) => { if (!validId(value)) fail(400, 'INVALID_MEASUREMENT_ID', 'Choose a valid advertising account or tracking tag.'); return value; };
const label = (value: any, max = 2000) => typeof value === 'string' && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
const boolean = (value: any) => value == null || typeof value === 'boolean';
const number = (value: any) => value == null || typeof value === 'number' && Number.isFinite(value) && value >= 0;
const encoded = (value: any) => encodeURIComponent(value);

function event(row: ProviderRecord) {
  if (!object(row) || !validId(row.id) || !label(row.name) || ['type', 'siteEvent', 'siteEventId', 'status', 'currency'].some(key => row[key] != null && !label(row[key], 500)) || ['defaultValue', 'clickWindowDays', 'viewWindowDays'].some(key => !number(row[key])) || ['alwaysUseDefaultValue', 'primary'].some(key => !boolean(row[key]))) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned an unreadable conversion event.');
  return Object.fromEntries(['id', 'name', 'type', 'siteEvent', 'siteEventId', 'status', 'currency', 'defaultValue', 'clickWindowDays', 'viewWindowDays', 'alwaysUseDefaultValue', 'primary'].filter(key => row[key] !== undefined).map(key => [key, row[key]]));
}
function eventList(rows: any) {
  if (!Array.isArray(rows) || rows.length > 10000) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned an unreadable conversion event list.');
  const result = rows.map(event);
  if (new Set(result.map((row: ProviderRecord) => row.id)).size !== result.length) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned duplicate conversion events.');
  return result;
}
function tag(row: ProviderRecord, platform: any, detailed = false) {
  if (!object(row) || !validId(row.id) || row.platform !== platform || !label(row.name) || !['pixel', 'tag', 'insight_tag'].includes(row.kind) || !['active', 'inactive'].includes(row.status) || ['siteTagId', 'ownerAdAccountId', 'ownerBusinessId'].some(key => row[key] != null && !label(row[key], 500)) || ['isUnavailable', 'installed', 'autoTagging'].some(key => !boolean(row[key])) || ['lastFiredTime', 'creationTime'].some(key => !number(row[key])) || row.code !== undefined && !label(row.code, 100000)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned an unreadable tracking tag.');
  const result = Object.fromEntries(['id', 'name', 'platform', 'kind', 'status', 'siteTagId', 'lastFiredTime', 'creationTime', 'isUnavailable', 'installed', 'ownerAdAccountId', 'ownerBusinessId', 'autoTagging'].filter(key => row[key] !== undefined).map(key => [key, row[key]]));
  if (detailed && row.code !== undefined) result.code = row.code;
  if (detailed && row.events !== undefined) result.events = eventList(row.events);
  return result;
}
function platformReceipt(response: any, account: ProviderRecord) {
  if (!object(response) || response.platform !== account.platform) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned tracking data for a different platform.');
}
async function tags(api: ZernioApi, account: ProviderRecord, adAccountId: any) {
  const response = await api(`/accounts/${encoded(account._id)}/${account.platform === 'redditads' ? 'conversion-destinations' : 'tracking-tags'}`, account.platform === 'redditads' ? {} : { adAccountId });
  platformReceipt(response, account);
  if (account.platform === 'redditads') {
    if (!Array.isArray(response.destinations) || response.destinations.length > 10000 || response.destinations.some((row: ProviderRecord) => !object(row) || !validId(row.adAccountId))) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not identify the advertising account for each Reddit pixel.');
    const result = response.destinations.filter((row: ProviderRecord) => row.adAccountId === adAccountId).map((row: ProviderRecord) => {
      if (!validId(row.id) || !label(row.name) || row.status != null && !label(row.status, 100)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned an unreadable Reddit pixel.');
      return { id: row.id, name: row.name, platform: account.platform, kind: 'pixel', status: row.status || 'unknown', ownerAdAccountId: row.adAccountId };
    });
    if (new Set(result.map((row: ProviderRecord) => row.id)).size !== result.length) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned duplicate Reddit pixels.');
    return result;
  }
  if (!Array.isArray(response.tags) || response.tags.length > 10000 || response.hasMore === true || response.pagination?.hasMore === true) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return a complete tracking tag list.');
  const result = response.tags.map((row: ProviderRecord) => tag(row, account.platform));
  if (new Set(result.map((row: ProviderRecord) => row.id)).size !== result.length) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned duplicate tracking tags.');
  return result;
}

export async function handleZernioMeasurement(context: Ctx, api: ZernioApi, profileId: string, action: any) {
  const { req, url, body = {}, role, send } = context;
  if (action === 'accounts' && req.method === 'GET') {
    const accounts = (await scopedAccounts(api, profileId)).filter(account => platforms.has(account.platform)).map(account => ({ _id: account._id, platform: account.platform, displayName: account.displayName, username: account.username, isActive: account.isActive, canCreate: account.platform !== 'redditads', canRename: account.platform === 'metaads', canDiagnose: account.platform === 'metaads' }));
    send(200, { accounts }); return true;
  }
  const match = /^([^/]+)\/(ad-accounts|tags)(?:\/([^/]+)(?:\/(events|diagnostics|update))?)?$/.exec(action);
  if (!match || match[2] === 'ad-accounts' && match[3]) return false;
  let accountId, tagId;
  try { accountId = identifier(decodeURIComponent(match[1])); if (match[3]) tagId = identifier(decodeURIComponent(match[3])); }
  catch (error) { if (error instanceof IntegrationError) throw error; fail(400, 'INVALID_MEASUREMENT_ID', 'Choose a valid connected account or tracking tag.'); }
  const creating = match[2] === 'tags' && tagId === 'create' && !match[4], updating = match[4] === 'update';
  if ((creating || updating) ? req.method !== 'POST' : req.method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', 'This measurement action does not support that method.');
  if ((creating || updating) && !['owner', 'admin'].includes(role)) fail(403, 'ADMIN_PERMISSION_REQUIRED', 'Only a workspace administrator can change tracking tags.');
  const account = requireAccount(await scopedAccounts(api, profileId), accountId);
  if (!platforms.has(account.platform)) fail(422, 'MEASUREMENT_UNAVAILABLE', 'Choose an advertising connection with measurement support.');
  const nativeAccounts = (await adAccounts(api, accountId)).accounts;
  if (nativeAccounts.some((row: ProviderRecord) => !object(row) || !validId(row.id) || row.name != null && !label(row.name) || row.currency != null && (typeof row.currency !== 'string' || !/^[A-Z]{3}$/.test(row.currency)) || !boolean(row.selectable))) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable advertising accounts.');
  if (match[2] === 'ad-accounts' && !tagId) { send(200, { accounts: nativeAccounts.map((row: ProviderRecord) => ({ id: row.id, name: row.name, currency: row.currency, selectable: row.selectable })) }); return true; }
  const adAccountId = identifier(creating || updating ? body.adAccountId : url.searchParams.get('adAccountId'));
  const native = nativeAccounts.find((row: ProviderRecord) => row.id === adAccountId);
  if (!native) fail(403, 'AD_ACCOUNT_OUTSIDE_PROJECT', 'This advertising account is not available through this project connection.');
  const list = await tags(api, account, adAccountId);
  if (!tagId) { send(200, { platform: account.platform, tags: list, canCreate: account.platform !== 'redditads', canRename: account.platform === 'metaads', canDiagnose: account.platform === 'metaads' }); return true; }
  const selected = list.find((row: ProviderRecord) => row.id === tagId);
  if (!creating && !selected) fail(403, 'TAG_OUTSIDE_ACCOUNT', 'This tracking tag is not available to the selected advertising account.');
  const path = `/accounts/${encoded(accountId)}/tracking-tags`, query = { adAccountId };
  if (creating || updating) {
    if (account.isActive === false || native.selectable === false) fail(409, 'ACCOUNT_UNAVAILABLE', 'Reconnect an available advertising account before changing tracking tags.');
    if (account.platform === 'redditads' || updating && account.platform !== 'metaads') fail(422, 'MEASUREMENT_ACTION_UNAVAILABLE', account.platform === 'redditads' ? 'Create Reddit pixels in Reddit Ads Manager, then refresh this list.' : 'This platform does not support renaming tags here.');
    const allowed = creating ? ['adAccountId', 'name', 'defaultEventType'] : ['adAccountId', 'name'];
    if (!object(body) || Object.keys(body).some(key => !allowed.includes(key)) || !label(body.name, account.platform === 'tiktokads' ? 40 : 200) || !body.name.trim() || account.platform === 'tiktokads' && /[\p{Extended_Pictographic}\uFE0F\u20E3]/u.test(body.name)) fail(400, 'INVALID_MEASUREMENT_SETTINGS', 'Enter a valid tag name using the fields available for this platform.');
    if (body.defaultEventType !== undefined && (account.platform !== 'openaiads' || !eventTypes.includes(body.defaultEventType))) fail(400, 'INVALID_MEASUREMENT_SETTINGS', 'Choose a supported ChatGPT conversion event.');
    const payload = { adAccountId, name: body.name.trim(), ...(body.defaultEventType ? { defaultEventType: body.defaultEventType } : {}) };
    const unresolved = async () => { if (creating && (await context.db.execute(sql`SELECT id FROM integration_operations WHERE project_id = ${context.project.id} AND request_key <> ${req.headers['idempotency-key'] as string} AND status IN ('pending','uncertain') AND action_path = 'POST /integrations/measurement/:id/tags/create'`)).rowCount) fail(409, 'OPERATION_UNCERTAIN', 'Review the previous tracking tag creation before creating another pixel.'); };
    await unresolved();
    // ponytail: unknown tag creation blocks this project; use persisted per-account resource locks if concurrent account provisioning is needed.
    const outcome = await operation(context, async key => {
      // Parallel creations on different accounts both pass the check above; each re-checks after its own receipt is
      // committed, so at least one sees the other pending and two creations cannot send concurrently.
      await unresolved();
      let response;
      try { response = await api(creating ? path : `${path}/${encoded(tagId)}`, {}, payload, key, creating ? 'POST' : 'PATCH'); }
      catch (error) { if (creating && account.platform === 'openaiads' && error instanceof IntegrationError) error.uncertain = true; throw error; }
      try {
        platformReceipt(response, account); const receipt = tag(response.tag, account.platform, true);
        if (updating && receipt.id !== tagId || creating && ['metaads', 'openaiads', 'tiktokads', 'pinterestads'].includes(account.platform) && list.some((row: ProviderRecord) => row.id === receipt.id) || (account.platform === 'metaads' || account.platform === 'tiktokads') && receipt.name !== payload.name) fail(502, 'MEASUREMENT_CHANGE_NOT_CONFIRMED', 'Zernio did not confirm the requested tracking tag.');
        const fresh = await tags(api, account, adAccountId);
        if (!fresh.some((row: ProviderRecord) => row.id === receipt.id && (!updating || row.name === payload.name))) fail(502, 'MEASUREMENT_CHANGE_NOT_CONFIRMED', 'The tracking tag is not confirmed in this advertising account.');
        return { tag: receipt, platform: account.platform };
      } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    }, `measurement:${accountId}:${adAccountId}`);
    send(outcome.status, outcome.data); return true;
  }
  if (account.platform === 'redditads') { if (match[4]) fail(422, 'MEASUREMENT_ACTION_UNAVAILABLE', 'Reddit pixel events and diagnostics must be inspected in Reddit Ads Manager.'); send(200, { platform: account.platform, tag: selected, instructions: 'Install and inspect this pixel in Reddit Ads Manager. Conversion campaigns require the selected event to have fired already; website lead campaigns require Lead.' }); return true; }
  if (match[4] === 'diagnostics') {
    if (account.platform !== 'metaads') fail(422, 'MEASUREMENT_ACTION_UNAVAILABLE', 'This platform does not expose tracking tag diagnostics.');
    const response = await api(`${path}/${encoded(tagId)}/diagnostics`); platformReceipt(response, account);
    if (!Array.isArray(response.checks) || response.checks.length > 1000 || response.checks.some((row: ProviderRecord) => !object(row) || ['key', 'title', 'description', 'result'].some(key => row[key] != null && !label(row[key], 4000)))) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable tracking diagnostics.');
    send(200, { platform: account.platform, checks: response.checks.map((row: ProviderRecord) => Object.fromEntries(['key', 'title', 'description', 'result'].filter(key => row[key] !== undefined).map(key => [key, row[key]]))) }); return true;
  }
  if (match[4] === 'events') {
    const response = await api(`${path}/${encoded(tagId)}/events`, query); platformReceipt(response, account);
    send(200, { platform: account.platform, events: eventList(response.events) }); return true;
  }
  const response = await api(`${path}/${encoded(tagId)}`, query); platformReceipt(response, account); const detail = tag(response.tag, account.platform, true);
  if (detail.id !== tagId) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned a different tracking tag.');
  send(200, { platform: account.platform, tag: detail }); return true;
}
