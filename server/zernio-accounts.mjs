import { IntegrationError, operation, scopedAccounts, requireAccount } from './integrations.mjs';

const fail = (status, code, message, uncertain = false) => { throw new IntegrationError(status, code, message, uncertain); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const label = value => value == null || typeof value === 'string' && value.length <= 2000;
const boolean = value => value == null || typeof value === 'boolean';
const date = value => value == null || typeof value === 'string' && value.length <= 100 && Number.isFinite(Date.parse(value));
const strings = value => value === undefined || Array.isArray(value) && value.length <= 200 && value.every(item => typeof item === 'string' && item.length <= 4000);
const id = value => { if (typeof value !== 'string' || !value || value.length > 500 || /[\s\u0000-\u001f]/.test(value)) fail(400, 'INVALID_ACCOUNT', 'Choose a valid connected account.'); return value; };
const socialReconnect = new Set(['facebook', 'instagram', 'linkedin', 'twitter', 'tiktok', 'youtube', 'threads', 'pinterest', 'reddit', 'googlebusiness', 'whatsapp', 'discord', 'slack']);
const adsReconnect = { googleads: 'googleads', redditads: 'redditads', tiktokads: 'tiktok', xads: 'twitter', metaads: 'facebook', linkedinads: 'linkedin', pinterestads: 'pinterest' };

function publicAccount(account) {
  if (!boolean(account.needsReconnection)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable connection details.');
  return { _id: account._id, platform: account.platform, displayName: account.displayName, username: account.username, isActive: account.isActive, needsReconnection: account.needsReconnection, canReconnect: socialReconnect.has(account.platform) || Object.hasOwn(adsReconnect, account.platform) };
}
function sync(value) {
  if (value === undefined) return undefined;
  if (!object(value) || !['ok', 'failing', 'stalled', 'never_synced'].includes(value.status) || !date(value.lastSyncedAt)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable analytics synchronization health.');
  return { status: value.status, lastSyncedAt: value.lastSyncedAt };
}
function restriction(value) {
  if (value == null) return undefined;
  if (!object(value) || ['code', 'subcode'].some(key => value[key] != null && !Number.isSafeInteger(value[key])) || !label(value.message) || ['firstSeenAt', 'lastSeenAt', 'pausedUntil'].some(key => !date(value[key]))) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable messaging restrictions.');
  return Object.fromEntries(['code', 'subcode', 'message', 'firstSeenAt', 'lastSeenAt', 'pausedUntil'].map(key => [key, value[key]]));
}
function health(row, account, detailed = false) {
  if (!object(row) || row.accountId !== account._id || row.platform !== account.platform || row.profileId != null && String(row.profileId?._id || row.profileId) !== String(account.profileId?._id || account.profileId)) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned health for a different connected account.');
  if (!['healthy', 'warning', 'error'].includes(row.status) || !strings(row.issues) || !strings(row.recommendations) || ['canPost', 'canFetchAnalytics', 'tokenValid', 'needsReconnect'].some(key => !boolean(row[key])) || !date(row.tokenExpiresAt)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable account health.');
  const result = { accountId: account._id, platform: account.platform, status: row.status, canPost: row.canPost, canFetchAnalytics: row.canFetchAnalytics, tokenValid: row.tokenValid, tokenExpiresAt: row.tokenExpiresAt, needsReconnect: row.needsReconnect, issues: row.issues || [], recommendations: row.recommendations || [], analyticsSync: sync(row.analyticsSync), messagingRestriction: restriction(row.messagingRestriction) };
  if (!detailed) return result;
  if (row.tokenStatus !== undefined) {
    const token = row.tokenStatus;
    if (!object(token) || !boolean(token.valid) || !boolean(token.needsRefresh) || !date(token.expiresAt) || !label(token.expiresIn)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable token health.');
    result.tokenStatus = { valid: token.valid, needsRefresh: token.needsRefresh, expiresAt: token.expiresAt, expiresIn: token.expiresIn };
  }
  if (row.permissions !== undefined) {
    const permissions = row.permissions;
    if (!object(permissions) || !boolean(permissions.canPost) || !boolean(permissions.canFetchAnalytics) || !strings(permissions.missingRequired)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable account permissions.');
    result.permissions = { canPost: permissions.canPost, canFetchAnalytics: permissions.canFetchAnalytics, missingRequired: permissions.missingRequired || [] };
    for (const key of ['posting', 'analytics', 'optional']) {
      const rows = permissions[key] === undefined ? [] : permissions[key];
      if (!Array.isArray(rows) || rows.length > 200 || rows.some(item => !object(item) || typeof item.scope !== 'string' || !item.scope || item.scope.length > 500 || typeof item.granted !== 'boolean' || typeof item.required !== 'boolean')) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable permission details.');
      result.permissions[key] = rows.map(item => ({ scope: item.scope, granted: item.granted, required: item.required }));
    }
  }
  if (row.platformConnection !== undefined) {
    const connection = row.platformConnection;
    if (account.platform !== 'whatsapp' || !object(connection) || !['connected', 'disconnected', 'unknown'].includes(connection.status) || !date(connection.checkedAt) || !label(connection.phoneStatus) || !boolean(connection.inboundWebhookSubscribed)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable WhatsApp link health.');
    result.platformConnection = { status: connection.status, checkedAt: connection.checkedAt, phoneStatus: connection.phoneStatus, inboundWebhookSubscribed: connection.inboundWebhookSubscribed };
  }
  return result;
}
function callback(context) {
  let origin;
  try { origin = new URL(context.config?.appUrl || context.config?.APP_URL || 'http://127.0.0.1:3000'); } catch { fail(503, 'INVALID_CALLBACK', 'Configure a valid app origin before reconnecting providers.'); }
  if (origin.username || origin.password || origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) fail(503, 'INVALID_CALLBACK', 'Configure a valid app origin before reconnecting providers.');
  const url = new URL('/', origin); url.search = new URLSearchParams({ view: 'integrations', project: context.project.id }); return url.href;
}

export async function handleZernioAccounts(context, api, profileId, action) {
  const { req, url, body = {}, role, send } = context;
  if (action === 'health' && req.method === 'GET') {
    const accounts = await scopedAccounts(api, profileId), response = await api('/accounts/health', { profileId });
    if (!Array.isArray(response.accounts) || response.accounts.length > 10000 || accounts.length > 10000) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned an unreadable connection health list.');
    const accountIds = new Set(accounts.map(account => account._id)), scoped = response.accounts.filter(row => object(row) && accountIds.has(row.accountId));
    if (new Set(scoped.map(row => row.accountId)).size !== scoped.length) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned duplicate connection health rows.');
    const byId = new Map(scoped.map(row => [row.accountId, row])), rows = accounts.map(account => ({ ...publicAccount(account), health: byId.has(account._id) ? health(byId.get(account._id), account) : null }));
    send(200, { accounts: rows, summary: { total: rows.length, healthy: rows.filter(row => row.health?.status === 'healthy').length, warning: rows.filter(row => row.health?.status === 'warning').length, error: rows.filter(row => row.health?.status === 'error').length, unknown: rows.filter(row => !row.health).length, needsReconnect: rows.filter(row => row.needsReconnection || row.isActive === false || row.health?.needsReconnect).length } }); return true;
  }
  const match = /^([^/]+)\/(health|reconnect|update|disconnect)$/.exec(action);
  if (!match) return false;
  let accountId; try { accountId = id(decodeURIComponent(match[1])); } catch (error) { if (error instanceof IntegrationError) throw error; fail(400, 'INVALID_ACCOUNT', 'Choose a valid connected account.'); }
  const task = match[2];
  if (!['health', 'reconnect'].includes(task) && req.method !== 'POST' || ['health', 'reconnect'].includes(task) && req.method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', 'This account action does not support that method.');
  if (task !== 'health' && !['owner', 'admin'].includes(role)) fail(403, 'ADMIN_PERMISSION_REQUIRED', 'Only a workspace administrator can change provider accounts.');
  if (task === 'health') {
    const account = requireAccount(await scopedAccounts(api, profileId), accountId), result = health(await api(`/accounts/${encodeURIComponent(accountId)}/health`), account, true);
    send(200, { account: publicAccount(account), health: result }); return true;
  }
  if (task === 'reconnect') {
    const accounts = await scopedAccounts(api, profileId), account = requireAccount(accounts, accountId), query = { profileId, redirect_url: callback(context) };
    let route;
    if (socialReconnect.has(account.platform)) { route = `/connect/${account.platform}`; query.reconnectAccountId = accountId; }
    else if (Object.hasOwn(adsReconnect, account.platform)) {
      const platform = adsReconnect[account.platform]; route = `/connect/${platform}/ads`; query.force = true;
      if (account.platform === 'metaads' && account.metadata?.tokenType === 'system-user') query.loginMode = 'business';
      else if (!['googleads', 'redditads', 'tiktokads'].includes(account.platform)) {
        if (typeof account.parentAccountId !== 'string' || !account.parentAccountId) fail(409, 'POSTING_ACCOUNT_REQUIRED', 'Reconnect the original posting account before repairing this advertising connection.');
        const parent = requireAccount(accounts, account.parentAccountId);
        if (parent.platform !== platform || parent.isActive === false) fail(409, 'POSTING_ACCOUNT_REQUIRED', 'Reconnect the original posting account before repairing this advertising connection.');
        query.accountId = parent._id;
      } else if (account.platform === 'tiktokads' && account.parentAccountId) {
        const parent = requireAccount(accounts, id(account.parentAccountId)); if (parent.platform !== 'tiktok' || parent.isActive === false) fail(409, 'POSTING_ACCOUNT_REQUIRED', 'Reconnect the original TikTok posting account first.'); query.accountId = parent._id;
      }
    } else fail(422, 'CREDENTIAL_CONNECTION_REQUIRED', 'This account uses a credential or platform-specific connection flow. Update it in its connection settings.');
    const response = await api(route, query); let authUrl;
    try { authUrl = new URL(response.authUrl); } catch { fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return a fresh reconnection URL.'); }
    if (authUrl.protocol !== 'https:' || authUrl.username || authUrl.password) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned an invalid reconnection URL.');
    send(200, { authUrl: authUrl.href, accountId }); return true;
  }
  const allowed = task === 'disconnect' ? ['confirmAccountId'] : ['displayName', 'username', 'xCapabilities'];
  if (!object(body) || Object.keys(body).some(key => !allowed.includes(key)) || !Object.keys(body).length) fail(400, 'INVALID_ACCOUNT_UPDATE', 'Use only supported account settings.');
  if (task === 'disconnect' && body.confirmAccountId !== accountId) fail(400, 'DISCONNECT_CONFIRMATION_REQUIRED', 'Confirm the account you want to disconnect.');
  if (task === 'update') {
    for (const key of ['displayName', 'username']) if (body[key] !== undefined && (typeof body[key] !== 'string' || body[key].length > 200 || /[\u0000-\u001f]/.test(body[key]))) fail(400, 'INVALID_ACCOUNT_UPDATE', 'Account names must be plain text with at most 200 characters.');
    if (body.xCapabilities !== undefined && (!object(body.xCapabilities) || !Object.keys(body.xCapabilities).length || Object.keys(body.xCapabilities).some(key => !['analytics', 'inbox'].includes(key) || typeof body.xCapabilities[key] !== 'boolean'))) fail(400, 'INVALID_ACCOUNT_UPDATE', 'Choose whether to enable X analytics and inbox polling.');
  }
  const outcome = await operation(context, async key => {
    const account = requireAccount(await scopedAccounts(api, profileId), accountId); publicAccount(account);
    if (body.xCapabilities !== undefined && account.platform !== 'twitter') fail(400, 'INVALID_ACCOUNT_UPDATE', 'Paid X background operations can only be configured for an X posting account.');
    const response = await api(`/accounts/${encodeURIComponent(accountId)}`, {}, task === 'update' ? body : undefined, key, task === 'update' ? 'PUT' : 'DELETE');
    if (typeof response.message !== 'string' || !response.message.trim() || response.message.length > 2000) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not confirm this account change. Review the provider before retrying.', true);
    let fresh;
    try { fresh = (await scopedAccounts(api, profileId)).find(item => item._id === accountId); }
    catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    if (task === 'disconnect') { if (fresh && fresh.isActive !== false) fail(502, 'ACCOUNT_CHANGE_NOT_CONFIRMED', 'The provider has not confirmed this disconnection.', true); return { accountId, disconnected: true }; }
    if (!fresh || fresh.platform !== account.platform || ['displayName', 'username'].some(name => body[name] !== undefined && fresh[name] !== body[name]) || body.xCapabilities !== undefined && (!object(response.xCapabilities) || Object.entries(body.xCapabilities).some(([name, value]) => response.xCapabilities[name] !== value))) fail(502, 'ACCOUNT_CHANGE_NOT_CONFIRMED', 'The provider has not confirmed the requested account settings.', true);
    let safe; try { safe = publicAccount(fresh); } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    return { account: safe, ...(response.xCapabilities ? { xCapabilities: Object.fromEntries(['analytics', 'inbox'].filter(name => typeof response.xCapabilities[name] === 'boolean').map(name => [name, response.xCapabilities[name]])) } : {}) };
  }, `zernio-account:${accountId}`);
  send(outcome.status, outcome.data); return true;
}
