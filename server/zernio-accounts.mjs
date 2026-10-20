import { createHash } from 'node:crypto';
import { IntegrationError, operation, scopedAccounts, requireAccount, mediaUrl } from './provider-core.ts';
import { publicMediaUrl } from '../shared/social-posts.ts';

const fail = (status, code, message, uncertain = false) => { throw new IntegrationError(status, code, message, uncertain); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const label = value => value == null || typeof value === 'string' && value.length <= 2000;
const boolean = value => value == null || typeof value === 'boolean';
const date = value => value == null || typeof value === 'string' && value.length <= 100 && Number.isFinite(Date.parse(value));
const strings = value => value === undefined || Array.isArray(value) && value.length <= 200 && value.every(item => typeof item === 'string' && item.length <= 4000);
const id = value => { if (typeof value !== 'string' || !value || value.length > 500 || /[\s\u0000-\u001f]/.test(value)) fail(400, 'INVALID_ACCOUNT', 'Choose a valid connected account.'); return value; };
const socialReconnect = new Set(['facebook', 'instagram', 'linkedin', 'twitter', 'tiktok', 'youtube', 'threads', 'pinterest', 'reddit', 'googlebusiness', 'whatsapp', 'discord', 'slack']);
const adsReconnect = { googleads: 'googleads', redditads: 'redditads', tiktokads: 'tiktok', xads: 'twitter', metaads: 'facebook', linkedinads: 'linkedin', pinterestads: 'pinterest' };

function blueskyLanguages(value, provider = false) {
  if (value === null) return null;
  try {
    if (!Array.isArray(value) || value.length < 1 || value.length > 3 || value.some(item => typeof item !== 'string' || item.length > 100)) throw new Error();
    const result = value.map(item => Intl.getCanonicalLocales(item)[0]);
    if (result.some(item => !item) || new Set(result).size !== value.length) throw new Error();
    return result;
  } catch { fail(provider ? 502 : 400, provider ? 'INVALID_PROVIDER_RESPONSE' : 'INVALID_BLUESKY_LANGUAGES', provider ? 'Zernio returned unreadable Bluesky default languages.' : 'Enter 1 to 3 distinct BCP-47 language codes, such as en, pt or en-US, or explicitly clear the default.'); }
}
function accountSettingsAccess(context, profileId) {
  try { context.assertProjectMapping?.(profileId); context.assertIntegrationSettings?.(); }
  catch (error) { fail(error.status === 403 ? 403 : 409, error.status === 403 ? 'PROJECT_ACCESS_CHANGED' : 'PROJECT_CONNECTION_CHANGED', 'Your project access or connection changed. Refresh before continuing.'); }
}
function whatsappNumberInfo(response) {
  const invalid = () => fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable WhatsApp number status.');
  if (!object(response)) invalid();
  const result = {}, text = value => typeof value === 'string' && value.length <= 2000;
  for (const [key, fields] of [['phone', ['display_phone_number', 'verified_name', 'name_status', 'quality_rating', 'messaging_limit_tier', 'status', 'platform_type']], ['waba', ['name', 'business_verification_status', 'timezone_id']]]) {
    if (response[key] === undefined) continue;
    if (key === 'waba' && response[key] === null) { result.waba = null; continue; }
    if (!object(response[key])) invalid();
    const row = response[key], selected = {};
    for (const field of fields) if (row[field] !== undefined) { if (!text(row[field])) invalid(); selected[field] = row[field]; }
    if (key === 'phone') {
      if (row.is_official_business_account !== undefined) { if (typeof row.is_official_business_account !== 'boolean') invalid(); selected.is_official_business_account = row.is_official_business_account; }
      if (row.throughput !== undefined) {
        if (!object(row.throughput) || row.throughput.level !== undefined && !text(row.throughput.level)) invalid();
        selected.throughput = row.throughput.level === undefined ? {} : { level: row.throughput.level };
      }
    }
    result[key] = selected;
  }
  return result;
}
async function whatsappNumberSnapshot(context, api, profileId, accountId) {
  accountSettingsAccess(context, profileId);
  const account = requireAccount(await scopedAccounts(api, profileId), accountId);
  accountSettingsAccess(context, profileId);
  if (account.platform !== 'whatsapp') fail(400, 'INVALID_WHATSAPP_ACCOUNT', 'Choose a connected WhatsApp account.');
  const identity = row => JSON.stringify([row._id, row.platform, row.platformUserId ?? null, row.username ?? null, row.isActive ?? null, row.needsReconnection ?? null, row.metadata?.phoneNumberId ?? null, row.metadata?.wabaId ?? null]), before = identity(account);
  const response = await api('/whatsapp/number-info', { accountId });
  accountSettingsAccess(context, profileId);
  const number = whatsappNumberInfo(response), fresh = requireAccount(await scopedAccounts(api, profileId), accountId);
  accountSettingsAccess(context, profileId);
  if (identity(fresh) !== before) fail(409, 'WHATSAPP_ACCOUNT_CHANGED', 'The connected WhatsApp number changed. Reload its status.');
  return { accountId, platform: 'whatsapp', loadedAt: new Date().toISOString(), ...number };
}
async function blueskySnapshot(context, api, profileId, accountId) {
  accountSettingsAccess(context, profileId);
  const account = requireAccount(await scopedAccounts(api, profileId), accountId);
  if (account.platform !== 'bluesky' || account.isActive === false) fail(400, 'INVALID_BLUESKY_ACCOUNT', 'Choose an active Bluesky posting account.');
  const response = await api(`/accounts/${encodeURIComponent(accountId)}/bluesky-settings`);
  if (!object(response)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable Bluesky settings.');
  const defaultLangs = blueskyLanguages(response.defaultLangs, true), identity = row => JSON.stringify([row._id, row.platform, row.platformUserId ?? null, row.username ?? null, row.isActive ?? null]);
  const fresh = requireAccount(await scopedAccounts(api, profileId), accountId);
  accountSettingsAccess(context, profileId);
  if (identity(fresh) !== identity(account)) fail(409, 'BLUESKY_ACCOUNT_CHANGED', 'The connected Bluesky account changed. Reload its settings.');
  const accountVersion = createHash('sha256').update(JSON.stringify([profileId, identity(account)])).digest('hex');
  return { accountId, defaultLangs, accountVersion, version: createHash('sha256').update(JSON.stringify([accountVersion, defaultLangs])).digest('hex') };
}

function telegramCommands(value, provider = false) {
  if (!Array.isArray(value) || value.length > 100 || value.some(row => !object(row) || !provider && Object.keys(row).some(key => !['command', 'description'].includes(key)) || typeof row.command !== 'string' || !/^[a-z0-9_]{1,32}$/.test(row.command) || typeof row.description !== 'string' || !row.description.trim() || [...row.description].length > 256 || /[\u0000-\u001f\u007f]/.test(row.description)) || new Set(value.map(row => row.command)).size !== value.length) fail(provider ? 502 : 400, provider ? 'INVALID_PROVIDER_RESPONSE' : 'INVALID_TELEGRAM_COMMANDS', provider ? 'Zernio returned unreadable Telegram bot commands.' : 'Use up to 100 distinct commands: 1 to 32 lowercase letters, digits or underscores without a slash, each with a description of 1 to 256 characters.');
  return value.map(({ command, description }) => ({ command, description }));
}
async function telegramSnapshot(context, api, profileId, accountId) {
  accountSettingsAccess(context, profileId);
  const account = requireAccount(await scopedAccounts(api, profileId), accountId);
  if (account.platform !== 'telegram' || account.isActive === false) fail(400, 'INVALID_TELEGRAM_ACCOUNT', 'Choose an active Telegram account.');
  const response = await api(`/accounts/${encodeURIComponent(accountId)}/telegram-commands`);
  const commands = telegramCommands(response?.data, true), identity = row => JSON.stringify([row._id, row.platform, row.platformUserId ?? null, row.username ?? null, row.isActive ?? null]);
  const fresh = requireAccount(await scopedAccounts(api, profileId), accountId);
  accountSettingsAccess(context, profileId);
  if (identity(fresh) !== identity(account)) fail(409, 'TELEGRAM_ACCOUNT_CHANGED', 'The connected Telegram account changed. Reload its commands.');
  const accountVersion = createHash('sha256').update(JSON.stringify([profileId, identity(account)])).digest('hex');
  return { accountId, commands, accountVersion, version: createHash('sha256').update(JSON.stringify([accountVersion, commands])).digest('hex') };
}

function slackDefaults(value, provider = false) {
  const invalid = () => fail(provider ? 502 : 400, provider ? 'INVALID_PROVIDER_RESPONSE' : 'INVALID_SLACK_DEFAULTS', provider ? 'Zernio returned unreadable Slack message identity settings.' : 'Enter an author name of at most 80 characters and a public HTTPS avatar URL, or explicitly clear each default.');
  if (!object(value)) invalid();
  const defaultUsername = provider && value.defaultUsername === null ? '' : value.defaultUsername, defaultIconUrl = provider && value.defaultIconUrl === null ? '' : value.defaultIconUrl;
  if (typeof defaultUsername !== 'string' || defaultUsername.length > 80 || /[\u0000-\u001f\u007f]/.test(defaultUsername) || typeof defaultIconUrl !== 'string' || defaultIconUrl.length > 4000) invalid();
  if (defaultIconUrl) { try { mediaUrl(defaultIconUrl); } catch { invalid(); } }
  return { defaultUsername, defaultIconUrl };
}
async function slackSnapshot(context, api, profileId, accountId) {
  accountSettingsAccess(context, profileId);
  const account = requireAccount(await scopedAccounts(api, profileId), accountId);
  if (account.platform !== 'slack' || account.isActive === false) fail(400, 'INVALID_SLACK_ACCOUNT', 'Choose an active Slack channel account.');
  const response = await api(`/accounts/${encodeURIComponent(accountId)}/slack-settings`), settings = response?.account;
  if (!object(settings) || settings._id !== accountId || settings.platform !== 'slack') fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned Slack settings for a different account.');
  if (['channelId', 'teamId'].some(key => typeof settings[key] !== 'string' || !settings[key] || settings[key].length > 500 || /[\s\u0000-\u001f]/.test(settings[key])) || !label(settings.channelName) || !label(settings.teamName) || settings.channelType != null && !['public', 'private'].includes(settings.channelType)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable Slack channel details.');
  const defaults = slackDefaults(settings, true), identity = row => JSON.stringify([row._id, row.platform, row.platformUserId ?? null, row.username ?? null, row.isActive ?? null]);
  const fresh = requireAccount(await scopedAccounts(api, profileId), accountId);
  accountSettingsAccess(context, profileId);
  if (identity(fresh) !== identity(account)) fail(409, 'SLACK_ACCOUNT_CHANGED', 'The connected Slack account changed. Reload its settings.');
  const accountVersion = createHash('sha256').update(JSON.stringify([profileId, identity(account), settings.teamId, settings.channelId, settings.channelType ?? null])).digest('hex');
  return { accountId, ...defaults, channelId: settings.channelId, channelName: settings.channelName ?? null, teamId: settings.teamId, teamName: settings.teamName ?? null, accountVersion, version: createHash('sha256').update(JSON.stringify([accountVersion, defaults])).digest('hex') };
}

function discordDefaults(value, provider = false) {
  const invalid = () => fail(provider ? 502 : 400, provider ? 'INVALID_PROVIDER_RESPONSE' : 'INVALID_DISCORD_DEFAULTS', provider ? 'Zernio returned unreadable Discord message identity settings.' : 'Enter an author name of 1 to 80 characters without clyde or discord and a public HTTPS avatar URL, or explicitly clear each default.');
  if (!object(value)) invalid();
  const webhookUsername = provider && value.webhookUsername == null ? '' : value.webhookUsername, webhookAvatarUrl = provider && value.webhookAvatarUrl == null ? '' : value.webhookAvatarUrl;
  if (typeof webhookUsername !== 'string' || [...webhookUsername].length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(webhookUsername) || /clyde|discord/i.test(webhookUsername) || webhookUsername && !webhookUsername.trim() || typeof webhookAvatarUrl !== 'string' || webhookAvatarUrl.length > 4000) invalid();
  if (webhookAvatarUrl) { try { publicMediaUrl(webhookAvatarUrl); } catch { invalid(); } }
  return { webhookUsername, webhookAvatarUrl };
}
function discordSettings(response, accountId) {
  const settings = response?.account;
  if (!object(settings) || settings._id !== accountId || settings.platform !== 'discord') fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned Discord settings for a different account.');
  if (['channelId', 'guildId'].some(key => typeof settings[key] !== 'string' || !/^[1-9]\d{0,19}$/.test(settings[key])) || !['0', '5', '15'].includes(settings.channelType) || !label(settings.channelName)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable Discord channel details.');
  return { accountId, ...discordDefaults(settings, true), guildId: settings.guildId, channelId: settings.channelId, channelType: settings.channelType, channelName: settings.channelName ?? null };
}
async function discordSnapshot(context, api, profileId, accountId) {
  accountSettingsAccess(context, profileId);
  const account = requireAccount(await scopedAccounts(api, profileId), accountId);
  if (account.platform !== 'discord' || account.isActive === false || account.needsReconnection === true) fail(400, 'INVALID_DISCORD_ACCOUNT', 'Choose an active connected Discord channel account.');
  const settings = discordSettings(await api(`/accounts/${encodeURIComponent(accountId)}/discord-settings`), accountId), identity = row => JSON.stringify([row._id, row.platform, row.platformUserId ?? null, row.username ?? null, row.isActive ?? null, row.needsReconnection ?? null]);
  const fresh = requireAccount(await scopedAccounts(api, profileId), accountId);
  accountSettingsAccess(context, profileId);
  if (identity(fresh) !== identity(account)) fail(409, 'DISCORD_ACCOUNT_CHANGED', 'The connected Discord account changed. Reload its settings.');
  const accountVersion = createHash('sha256').update(JSON.stringify([profileId, identity(account), settings.guildId, settings.channelId, settings.channelType])).digest('hex');
  return { ...settings, accountVersion, version: createHash('sha256').update(JSON.stringify([accountVersion, settings.webhookUsername, settings.webhookAvatarUrl])).digest('hex') };
}

function publicAccount(account) {
  if (!boolean(account.needsReconnection)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable connection details.');
  return { _id: account._id, platform: account.platform, displayName: account.displayName, username: account.username, isActive: account.isActive, needsReconnection: account.needsReconnection, canReconnect: socialReconnect.has(account.platform) || Object.hasOwn(adsReconnect, account.platform) };
}
function facebookSubscription(response, mutation = false) {
  if (!object(response) || typeof response.pageId !== 'string' || !response.pageId || response.pageId.length > 500 || /[\s\u0000-\u001f\u007f]/.test(response.pageId) || /^0+$/.test(response.pageId) || typeof response.appSubscribed !== 'boolean' || typeof response.leadgen !== 'boolean' || !Array.isArray(response.subscribedFields) || response.subscribedFields.length > 200 || response.subscribedFields.some(field => typeof field !== 'string' || !field.trim() || field.length > 200 || /[\u0000-\u001f\u007f]/.test(field)) || !label(response.warning) || mutation && typeof response.resubscribed !== 'boolean') fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned unreadable Facebook Page subscription details.');
  // The provider schema permits opaque strings; normalize numeric aliases without inventing a numeric-only contract.
  const pageId = /^\d+$/.test(response.pageId) ? BigInt(response.pageId).toString() : response.pageId;
  return { pageId, appSubscribed: response.appSubscribed, leadgen: response.leadgen, subscribedFields: [...new Set(response.subscribedFields)].sort(), warning: response.warning ?? null, ...(mutation ? { resubscribed: response.resubscribed } : {}) };
}
async function facebookSubscriptionSnapshot(context, api, profileId, accountId) {
  accountSettingsAccess(context, profileId);
  const account = requireAccount(await scopedAccounts(api, profileId), accountId);
  accountSettingsAccess(context, profileId);
  if (account.platform !== 'facebook' || account.isActive !== true || !boolean(account.needsReconnection) || account.needsReconnection === true) fail(400, 'INVALID_FACEBOOK_ACCOUNT', 'Choose an active connected Facebook Page account.');
  const identity = row => JSON.stringify([row._id, row.platform, row.platformUserId ?? null, row.username ?? null, row.isActive ?? null, row.needsReconnection ?? null]), accountIdentity = identity(account);
  const response = await api(`/accounts/${encodeURIComponent(accountId)}/webhook-subscription`);
  accountSettingsAccess(context, profileId);
  const subscription = facebookSubscription(response), fresh = requireAccount(await scopedAccounts(api, profileId), accountId);
  accountSettingsAccess(context, profileId);
  if (identity(fresh) !== accountIdentity) fail(409, 'FACEBOOK_ACCOUNT_CHANGED', 'The connected Facebook account changed. Reload its Page subscription.');
  const accountVersion = createHash('sha256').update(JSON.stringify([profileId, accountIdentity, subscription.pageId])).digest('hex');
  return { accountId, ...subscription, accountVersion, version: createHash('sha256').update(JSON.stringify([accountVersion, subscription])).digest('hex') };
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
  const match = /^([^/]+)\/(health|reconnect|update|disconnect|bluesky-settings|telegram-commands|slack-settings|discord-settings|webhook-subscription|whatsapp-number-info)$/.exec(action);
  if (!match) return false;
  let accountId; try { accountId = id(decodeURIComponent(match[1])); } catch (error) { if (error instanceof IntegrationError) throw error; fail(400, 'INVALID_ACCOUNT', 'Choose a valid connected account.'); }
  const task = match[2];
  if (task === 'whatsapp-number-info') {
    if (req.method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', 'WhatsApp number status is read only.');
    if (url.search || !object(body) || Object.keys(body).length) fail(400, 'UNSUPPORTED_WHATSAPP_NUMBER_SCOPE', 'Read the connected WhatsApp number without extra options.');
    send(200, await whatsappNumberSnapshot(context, api, profileId, accountId)); return true;
  }
  if (task === 'webhook-subscription') {
    if (!['GET', 'POST'].includes(req.method)) fail(405, 'METHOD_NOT_ALLOWED', 'Use the available Facebook Page subscription controls.');
    if (url.search) fail(400, 'UNSUPPORTED_FACEBOOK_SUBSCRIPTION_SCOPE', 'Inspect the subscription of the connected Facebook Page without extra options.');
    if (req.method === 'GET') { send(200, await facebookSubscriptionSnapshot(context, api, profileId, accountId)); return true; }
    if (!['owner', 'admin'].includes(role)) fail(403, 'ADMIN_PERMISSION_REQUIRED', 'Only a workspace administrator can change provider accounts.');
    if (!object(body) || Object.keys(body).some(key => !['expectedVersion', 'confirmed'].includes(key)) || body.confirmed !== true || typeof body.expectedVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedVersion)) fail(400, 'FACEBOOK_SUBSCRIPTION_REVIEW_REQUIRED', 'Load and review the current Facebook Page subscription before re-subscribing.');
    const { db } = context;
    db.exec('CREATE TABLE IF NOT EXISTS zernio_facebook_subscription_mutations(resource TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL)');
    const outcome = await operation(context, async key => {
      const before = await facebookSubscriptionSnapshot(context, api, profileId, accountId);
      if (before.version !== body.expectedVersion) fail(409, 'FACEBOOK_SUBSCRIPTION_CHANGED', 'The Facebook Page or subscription changed. Load and review its latest subscription.');
      const current = await facebookSubscriptionSnapshot(context, api, profileId, accountId);
      if (current.version !== before.version) fail(409, 'FACEBOOK_SUBSCRIPTION_CHANGED', 'The Facebook Page or subscription changed. Load and review its latest subscription.');
      accountSettingsAccess(context, profileId);
      const resource = JSON.stringify([current.pageId]), old = db.prepare('SELECT o.status FROM zernio_facebook_subscription_mutations m LEFT JOIN integration_operations o ON o.project_id=m.project_id AND o.request_key=m.request_key WHERE m.resource=?').get(resource);
      if (old && (!old.status || ['pending', 'uncertain'].includes(old.status))) fail(409, 'FACEBOOK_PREVIOUS_OUTCOME_UNRESOLVED', 'This action was not sent. Review the previous Facebook Page subscription action in provider outcomes first.');
      db.prepare('INSERT INTO zernio_facebook_subscription_mutations VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET project_id=excluded.project_id,request_key=excluded.request_key').run(resource, context.project.id, key);
      // ponytail: Meta can switch the selected Page after this check; provider support for an atomic expectedPageId is needed to close that external race.
      try {
        const response = await api(`/accounts/${encodeURIComponent(accountId)}/webhook-subscription`, {}, undefined, key, 'POST');
        accountSettingsAccess(context, profileId);
        const receipt = facebookSubscription(response, true);
        if (receipt.pageId !== before.pageId) fail(502, 'FACEBOOK_SUBSCRIPTION_NOT_CONFIRMED', 'Zernio returned a subscription for a different Facebook Page.', true);
        const after = await facebookSubscriptionSnapshot(context, api, profileId, accountId);
        accountSettingsAccess(context, profileId);
        if (after.accountVersion !== before.accountVersion || after.pageId !== receipt.pageId || after.appSubscribed !== receipt.appSubscribed || after.leadgen !== receipt.leadgen || JSON.stringify(after.subscribedFields) !== JSON.stringify(receipt.subscribedFields)) fail(502, 'FACEBOOK_SUBSCRIPTION_NOT_CONFIRMED', 'The Facebook Page or actual subscription could not be independently verified after re-subscribing.', true);
        return { ...after, resubscribed: receipt.resubscribed, readback: true };
      } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    }, `zernio-account:${accountId}`);
    send(outcome.status, outcome.data); return true;
  }
  if (task === 'discord-settings') {
    if (!['GET', 'POST'].includes(req.method)) fail(405, 'METHOD_NOT_ALLOWED', 'Use the available Discord identity controls.');
    if (url.search) fail(400, 'INVALID_DISCORD_DEFAULTS', 'Discord defaults apply to the connected channel without per-post options.');
    if (req.method === 'GET') { send(200, await discordSnapshot(context, api, profileId, accountId)); return true; }
    if (!['owner', 'admin'].includes(role)) fail(403, 'ADMIN_PERMISSION_REQUIRED', 'Only a workspace administrator can change provider accounts.');
    if (!object(body) || Object.keys(body).some(key => !['webhookUsername', 'webhookAvatarUrl', 'clearUsername', 'clearAvatar', 'expectedVersion', 'confirmed'].includes(key)) || body.confirmed !== true || typeof body.clearUsername !== 'boolean' || typeof body.clearAvatar !== 'boolean' || !/^[a-f0-9]{64}$/.test(body.expectedVersion || '')) fail(400, 'DISCORD_REVIEW_REQUIRED', 'Load and review the current Discord message identity before saving.');
    const defaults = discordDefaults(body), { db } = context, resource = JSON.stringify([accountId]);
    if (body.clearUsername !== (defaults.webhookUsername === '') || body.clearAvatar !== (defaults.webhookAvatarUrl === '')) fail(400, 'INVALID_DISCORD_DEFAULTS', 'Enter defaults, or explicitly select Clear for each empty field.');
    db.exec('CREATE TABLE IF NOT EXISTS zernio_discord_mutations(resource TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL)');
    const outcome = await operation(context, async key => {
      const before = await discordSnapshot(context, api, profileId, accountId);
      if (before.version !== body.expectedVersion) fail(409, 'DISCORD_SETTINGS_CHANGED', 'The Discord server, channel or default identity changed. Load and review the latest settings.');
      accountSettingsAccess(context, profileId);
      const old = db.prepare('SELECT o.status FROM zernio_discord_mutations m LEFT JOIN integration_operations o ON o.project_id=m.project_id AND o.request_key=m.request_key WHERE m.resource=?').get(resource);
      if (old && (!old.status || ['pending', 'uncertain'].includes(old.status))) fail(409, 'DISCORD_PREVIOUS_OUTCOME_UNRESOLVED', 'This action was not sent. Review the previous Discord identity action in provider outcomes first.');
      db.prepare('INSERT INTO zernio_discord_mutations VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET project_id=excluded.project_id,request_key=excluded.request_key').run(resource, context.project.id, key);
      const response = await api(`/accounts/${encodeURIComponent(accountId)}/discord-settings`, {}, defaults, key, 'PATCH');
      try {
        const receipt = discordSettings(response, accountId);
        if (['guildId', 'channelId', 'channelType'].some(field => receipt[field] !== before[field]) || Object.entries(defaults).some(([field, value]) => receipt[field] !== value)) fail(502, 'DISCORD_CHANGE_NOT_CONFIRMED', 'Zernio did not confirm the requested Discord message identity.', true);
        const after = await discordSnapshot(context, api, profileId, accountId);
        if (Object.entries(defaults).some(([field, value]) => after[field] !== value) || after.accountVersion !== before.accountVersion) fail(502, 'DISCORD_CHANGE_NOT_CONFIRMED', 'The Discord identity or connected channel could not be verified after saving.', true);
        return { ...after, readback: true };
      } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    }, `zernio-account:${accountId}`);
    send(outcome.status, outcome.data); return true;
  }
  if (task === 'slack-settings') {
    if (!['GET', 'POST'].includes(req.method)) fail(405, 'METHOD_NOT_ALLOWED', 'Use the available Slack identity controls.');
    if (url.search) fail(400, 'INVALID_SLACK_DEFAULTS', 'Slack defaults apply to the connected channel without per-post options.');
    if (req.method === 'GET') { send(200, await slackSnapshot(context, api, profileId, accountId)); return true; }
    if (!['owner', 'admin'].includes(role)) fail(403, 'ADMIN_PERMISSION_REQUIRED', 'Only a workspace administrator can change provider accounts.');
    if (!object(body) || Object.keys(body).some(key => !['defaultUsername', 'defaultIconUrl', 'clearUsername', 'clearIcon', 'expectedVersion', 'confirmed'].includes(key)) || body.confirmed !== true || typeof body.clearUsername !== 'boolean' || typeof body.clearIcon !== 'boolean' || !/^[a-f0-9]{64}$/.test(body.expectedVersion || '')) fail(400, 'SLACK_REVIEW_REQUIRED', 'Load and review the current Slack message identity before saving.');
    const defaults = slackDefaults(body), { db } = context, resource = JSON.stringify([accountId]);
    if (body.clearUsername !== (defaults.defaultUsername === '') || body.clearIcon !== (defaults.defaultIconUrl === '') || !body.clearUsername && !defaults.defaultUsername.trim()) fail(400, 'INVALID_SLACK_DEFAULTS', 'Enter defaults, or explicitly select Clear for each empty field.');
    db.exec('CREATE TABLE IF NOT EXISTS zernio_slack_mutations(resource TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL)');
    const outcome = await operation(context, async key => {
      const before = await slackSnapshot(context, api, profileId, accountId);
      if (before.version !== body.expectedVersion) fail(409, 'SLACK_SETTINGS_CHANGED', 'The Slack channel or default identity changed. Load and review the latest settings.');
      accountSettingsAccess(context, profileId);
      const old = db.prepare('SELECT o.status FROM zernio_slack_mutations m LEFT JOIN integration_operations o ON o.project_id=m.project_id AND o.request_key=m.request_key WHERE m.resource=?').get(resource);
      if (old && (!old.status || ['pending', 'uncertain'].includes(old.status))) fail(409, 'SLACK_PREVIOUS_OUTCOME_UNRESOLVED', 'This action was not sent. Review the previous Slack identity action in provider outcomes first.');
      db.prepare('INSERT INTO zernio_slack_mutations VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET project_id=excluded.project_id,request_key=excluded.request_key').run(resource, context.project.id, key);
      await api(`/accounts/${encodeURIComponent(accountId)}/slack-settings`, {}, defaults, key, 'PATCH');
      try {
        const after = await slackSnapshot(context, api, profileId, accountId);
        if (after.defaultUsername !== defaults.defaultUsername || after.defaultIconUrl !== defaults.defaultIconUrl || after.accountVersion !== before.accountVersion) fail(502, 'SLACK_CHANGE_NOT_CONFIRMED', 'The Slack message identity or connected channel could not be verified after saving.', true);
        return { ...after, readback: true };
      } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    }, `zernio-account:${accountId}`);
    send(outcome.status, outcome.data); return true;
  }
  if (task === 'telegram-commands') {
    if (!['GET', 'POST'].includes(req.method)) fail(405, 'METHOD_NOT_ALLOWED', 'Use the available Telegram command controls.');
    if (url.search) fail(400, 'UNSUPPORTED_TELEGRAM_SCOPE', 'Zernio exposes only the provider-default bot menu; custom scope and locale are unavailable.');
    if (req.method === 'GET') { send(200, await telegramSnapshot(context, api, profileId, accountId)); return true; }
    if (!['owner', 'admin'].includes(role)) fail(403, 'ADMIN_PERMISSION_REQUIRED', 'Only a workspace administrator can change provider accounts.');
    if (!object(body) || Object.keys(body).some(key => !['commands', 'clear', 'expectedVersion', 'confirmed'].includes(key)) || body.confirmed !== true || typeof body.clear !== 'boolean' || !/^[a-f0-9]{64}$/.test(body.expectedVersion || '')) fail(400, 'TELEGRAM_REVIEW_REQUIRED', 'Load and review the current Telegram command menu before saving.');
    const commands = telegramCommands(body.commands), { db } = context, resource = JSON.stringify([profileId, accountId]);
    if (body.clear ? commands.length !== 0 : commands.length === 0) fail(400, 'INVALID_TELEGRAM_COMMANDS', 'Add commands, or explicitly select Clear all bot commands.');
    db.exec('CREATE TABLE IF NOT EXISTS zernio_telegram_mutations(resource TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL)');
    const outcome = await operation(context, async key => {
      const before = await telegramSnapshot(context, api, profileId, accountId);
      if (before.version !== body.expectedVersion) fail(409, 'TELEGRAM_COMMANDS_CHANGED', 'The account or bot menu changed. Load and review the latest commands.');
      accountSettingsAccess(context, profileId);
      const old = db.prepare('SELECT o.status FROM zernio_telegram_mutations m LEFT JOIN integration_operations o ON o.project_id=m.project_id AND o.request_key=m.request_key WHERE m.resource=?').get(resource);
      if (old && (!old.status || ['pending', 'uncertain'].includes(old.status))) fail(409, 'TELEGRAM_PREVIOUS_OUTCOME_UNRESOLVED', 'This action was not sent. Review the previous Telegram command action in provider outcomes first.');
      db.prepare('INSERT INTO zernio_telegram_mutations VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET project_id=excluded.project_id,request_key=excluded.request_key').run(resource, context.project.id, key);
      await api(`/accounts/${encodeURIComponent(accountId)}/telegram-commands`, {}, body.clear ? undefined : { commands }, key, body.clear ? 'DELETE' : 'PUT');
      try {
        const after = await telegramSnapshot(context, api, profileId, accountId);
        if (JSON.stringify(after.commands) !== JSON.stringify(commands) || after.accountVersion !== before.accountVersion) fail(502, 'TELEGRAM_CHANGE_NOT_CONFIRMED', 'The bot menu or connected account could not be verified after saving.', true);
        return { ...after, readback: true };
      } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    }, `zernio-account:${accountId}`);
    send(outcome.status, outcome.data); return true;
  }
  if (task === 'bluesky-settings') {
    if (!['GET', 'POST'].includes(req.method)) fail(405, 'METHOD_NOT_ALLOWED', 'Use the available Bluesky settings controls.');
    if (req.method === 'GET') { send(200, await blueskySnapshot(context, api, profileId, accountId)); return true; }
    if (!['owner', 'admin'].includes(role)) fail(403, 'ADMIN_PERMISSION_REQUIRED', 'Only a workspace administrator can change provider accounts.');
    if (!object(body) || Object.keys(body).some(key => !['defaultLangs', 'expectedVersion', 'confirmed'].includes(key)) || body.confirmed !== true || !/^[a-f0-9]{64}$/.test(body.expectedVersion || '')) fail(400, 'BLUESKY_REVIEW_REQUIRED', 'Load and review the current Bluesky settings before saving.');
    const defaultLangs = blueskyLanguages(body.defaultLangs), { db } = context, resource = JSON.stringify([profileId, accountId]);
    db.exec('CREATE TABLE IF NOT EXISTS zernio_bluesky_mutations(resource TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL)');
    const outcome = await operation(context, async key => {
      const before = await blueskySnapshot(context, api, profileId, accountId);
      if (before.version !== body.expectedVersion) fail(409, 'BLUESKY_SETTINGS_CHANGED', 'The account or default languages changed. Load and review the latest settings.');
      accountSettingsAccess(context, profileId);
      const old = db.prepare('SELECT o.status FROM zernio_bluesky_mutations m LEFT JOIN integration_operations o ON o.project_id=m.project_id AND o.request_key=m.request_key WHERE m.resource=?').get(resource);
      if (old && (!old.status || ['pending', 'uncertain'].includes(old.status))) fail(409, 'BLUESKY_PREVIOUS_OUTCOME_UNRESOLVED', 'This action was not sent. Review the previous Bluesky settings action in provider outcomes first.');
      db.prepare('INSERT INTO zernio_bluesky_mutations VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET project_id=excluded.project_id,request_key=excluded.request_key').run(resource, context.project.id, key);
      const response = await api(`/accounts/${encodeURIComponent(accountId)}/bluesky-settings`, {}, { defaultLangs }, key, 'PATCH');
      try {
        if (!object(response) || JSON.stringify(blueskyLanguages(response.defaultLangs, true)) !== JSON.stringify(defaultLangs)) fail(502, 'BLUESKY_CHANGE_NOT_CONFIRMED', 'Zernio did not confirm the requested Bluesky default languages.', true);
        const after = await blueskySnapshot(context, api, profileId, accountId);
        if (JSON.stringify(after.defaultLangs) !== JSON.stringify(defaultLangs) || after.accountVersion !== before.accountVersion) fail(502, 'BLUESKY_CHANGE_NOT_CONFIRMED', 'The Bluesky settings or connected account could not be verified after saving.', true);
        return { ...after, readback: true };
      } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    }, `zernio-account:${accountId}`);
    send(outcome.status, outcome.data); return true;
  }
  if (!['health', 'reconnect'].includes(task) && req.method !== 'POST' || ['health', 'reconnect'].includes(task) && req.method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', 'This account action does not support that method.');
  if (task !== 'health' && !['owner', 'admin'].includes(role)) fail(403, 'ADMIN_PERMISSION_REQUIRED', 'Only a workspace administrator can change provider accounts.');
  if (task === 'health') {
    const account = requireAccount(await scopedAccounts(api, profileId), accountId), result = health(await api(`/accounts/${encodeURIComponent(accountId)}/health`), account, true);
    send(200, { account: publicAccount(account), health: result }); return true;
  }
  if (task === 'reconnect') {
    const accounts = await scopedAccounts(api, profileId), account = requireAccount(accounts, accountId), query = { profileId, redirect_url: callback(context) };
    let route;
    if (socialReconnect.has(account.platform)) {
      route = `/connect/${account.platform}`; query.reconnectAccountId = accountId;
      if (account.platform === 'instagram') {
        const loginMethod = account.metadata?.loginMethod;
        if (account.metadata !== undefined && !object(account.metadata) || loginMethod !== undefined && !['instagram_login', 'facebook_login'].includes(loginMethod)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not identify this Instagram account’s login method. Refresh connections before reconnecting.');
        if (loginMethod !== undefined) query.loginMethod = loginMethod;
      }
    } else if (Object.hasOwn(adsReconnect, account.platform)) {
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
