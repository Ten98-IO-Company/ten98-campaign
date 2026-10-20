import { IntegrationError, operation, scopedAccounts, mediaUrl } from './integrations.mjs';

const fail = (status, code, message, uncertain = false) => { throw new IntegrationError(status, code, message, uncertain); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\s\u0000-\u001f]/.test(value);
const text = (value, max = 500) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
const fields = (body, allowed) => { if (!object(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_CONNECTION', 'Use only the connection fields shown.'); };
const shopDomain = value => {
  if (typeof value !== 'string') fail(400, 'INVALID_SHOP', 'Enter the store’s myshopify.com domain.');
  const shop = value.trim().toLowerCase().replace(/\.myshopify\.com$/, '');
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(shop)) fail(400, 'INVALID_SHOP', 'Enter the store’s myshopify.com domain without a URL path.');
  return shop + '.myshopify.com';
};
function callback(context) {
  let origin; try { origin = new URL(context.config?.appUrl || context.config?.env?.APP_URL || 'http://127.0.0.1:3000'); } catch { fail(503, 'INVALID_CALLBACK', 'Configure a valid app origin.'); }
  if (origin.username || origin.password || origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname))) fail(503, 'INVALID_CALLBACK', 'Configure a valid app origin.');
  const url = new URL('/', origin); url.search = new URLSearchParams({ view: 'integrations', project: context.project.id }); return url.href;
}
function codeStore(db) {
  db.exec('CREATE TABLE IF NOT EXISTS integration_telegram_codes (project_id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, code TEXT NOT NULL, expires_at TEXT NOT NULL)');
}
async function confirmed(api, profileId, platform, response, expectedUsername) {
  const receipt = response.account;
  if (receipt != null && (!object(receipt) || receipt.platform !== platform || receipt.profileId != null && String(receipt.profileId?._id || receipt.profileId) !== profileId)) fail(502, 'CONNECTION_NOT_CONFIRMED', 'The returned connection belongs to another account or profile.', true);
  const receiptId = response.accountId || receipt?._id || receipt?.accountId;
  const rows = (await scopedAccounts(api, profileId)).filter(row => row.platform === platform && row.isActive === true);
  const matches = receiptId ? rows.filter(row => row._id === receiptId) : typeof receipt?.username === 'string' && receipt.username ? rows.filter(row => row.username === receipt.username) : [];
  if (matches.length !== 1 || receiptId != null && !token(receiptId)) fail(502, 'CONNECTION_NOT_CONFIRMED', 'The new connection could not be confirmed in this project. Refresh connections before retrying.', true);
  const account = matches[0];
  if (expectedUsername && account.username?.toLowerCase() !== expectedUsername.toLowerCase()) fail(502, 'CONNECTION_NOT_CONFIRMED', 'The provider returned a different channel or store.', true);
  return { accountId: account._id, platform: account.platform, displayName: account.displayName || account.username || platform };
}
async function submit(api, path, query, body, key, method = 'POST') {
  try { return await api(path, query, body, key, method); }
  catch (error) { if (!(error instanceof IntegrationError)) throw error; throw new IntegrationError(error.status, error.code, 'Zernio could not complete the connection. Check the account credentials and provider permissions.', error.uncertain || error.status >= 500); }
}

export async function handleZernioConnections(context, api, profileId, action) {
  const { req, url, body = {}, role, send, db } = context;
  const match = /^(bluesky|wordpress|shopify|whop|telegram)\/(credentials|oauth|code|status)$/.exec(action);
  if (!match) return false;
  if (!['owner', 'admin'].includes(role)) fail(403, 'ADMIN_PERMISSION_REQUIRED', 'Only a workspace administrator can connect channels and stores.');
  const [ , platform, task ] = match;
  if (req.method !== (task === 'oauth' ? 'GET' : 'POST')) fail(405, 'METHOD_NOT_ALLOWED', 'Use the available connection controls.');
  if (task === 'oauth') {
    if (!['shopify', 'wordpress'].includes(platform) || [...url.searchParams.keys()].some(key => !(platform === 'shopify' && key === 'shop'))) fail(400, 'INVALID_CONNECTION', 'Choose a supported store connection.');
    const response = await api(`/connect/${platform}`, { profileId, redirect_url: callback(context), ...(platform === 'shopify' ? { shop: shopDomain(url.searchParams.get('shop')) } : {}) });
    let authUrl; try { authUrl = new URL(response.authUrl); } catch { fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return a connection URL.'); }
    if (authUrl.protocol !== 'https:' || authUrl.username || authUrl.password) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned an invalid connection URL.');
    send(200, { authUrl: authUrl.href }); return true;
  }
  if (task === 'code') {
    if (platform !== 'telegram') fail(400, 'INVALID_CONNECTION', 'Access codes are only available for Telegram.'); fields(body, []); codeStore(db);
    const outcome = await operation(context, async () => {
      const response = await api('/connect/telegram', { profileId });
      if (!token(response.code) || !/^[A-Za-z0-9_]{5,32}$/.test(response.botUsername || '') || !Number.isFinite(Date.parse(response.expiresAt)) || Date.parse(response.expiresAt) <= Date.now() || Date.parse(response.expiresAt) > Date.now() + 16 * 60000 || !Array.isArray(response.instructions) || response.instructions.length > 20 || response.instructions.some(row => !text(row, 2000))) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned an unreadable Telegram access code.', true);
      db.prepare('INSERT INTO integration_telegram_codes VALUES (?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET profile_id=excluded.profile_id, code=excluded.code, expires_at=excluded.expires_at').run(context.project.id, profileId, response.code, response.expiresAt);
      return { code: response.code, botUsername: response.botUsername, expiresAt: response.expiresAt, instructions: response.instructions };
    }, 'telegram-code'); send(outcome.status, outcome.data); return true;
  }
  if (task === 'status') {
    if (platform !== 'telegram') fail(400, 'INVALID_CONNECTION', 'Access-code status is only available for Telegram.'); fields(body, ['code']); codeStore(db);
    const saved = db.prepare('SELECT * FROM integration_telegram_codes WHERE project_id=?').get(context.project.id);
    if (!token(body.code) || !saved || saved.profile_id !== profileId || saved.code !== body.code) fail(403, 'CODE_OUTSIDE_PROJECT', 'Generate a Telegram code for this project before checking it.');
    if (Date.parse(saved.expires_at) <= Date.now()) { send(200, { status: 'expired' }); return true; }
    const response = await api('/connect/telegram', { code: saved.code }, undefined, undefined, 'PATCH');
    if (!['pending', 'connected', 'expired'].includes(response.status)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned an unreadable Telegram connection status.');
    const account = response.status === 'connected' ? await confirmed(api, profileId, 'telegram', response) : undefined;
    send(200, { status: response.status, ...(account ? { account } : {}) }); return true;
  }
  const allowed = { bluesky: ['identifier', 'appPassword'], wordpress: ['siteUrl', 'username', 'applicationPassword'], shopify: ['shop', 'accessToken'], whop: ['apiKey'], telegram: ['chatId'] }[platform];
  fields(body, allowed); if (allowed.some(key => !text(body[key], ['appPassword', 'applicationPassword', 'accessToken', 'apiKey'].includes(key) ? 4096 : 500))) fail(400, 'INVALID_CONNECTION', 'Fill the required connection fields.');
  const payload = { ...body, profileId };
  let path = `/connect/${platform}/credentials`, expected = platform;
  if (platform === 'wordpress') {
    if (body.username.length > 255 || /:/.test(body.username) || body.applicationPassword.length > 1024) fail(400, 'INVALID_CONNECTION', 'Use a valid WordPress username and application password.');
    const site = new URL(mediaUrl(body.siteUrl)); if (site.search || site.hash) fail(400, 'INVALID_CONNECTION', 'Use the HTTPS WordPress site URL without a query or fragment.'); payload.siteUrl = site.href; path = '/connect/wordpress/token';
  } else if (platform === 'shopify') { payload.shop = shopDomain(body.shop); path = '/connect/shopify/token'; }
  else if (platform === 'whop') { path = '/connect/whop-ads/credentials'; expected = 'whopads'; }
  else if (platform === 'telegram') { if (!/^(?:-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/.test(body.chatId)) fail(400, 'INVALID_CONNECTION', 'Use a Telegram chat ID or @channel username.'); path = '/connect/telegram'; }
  if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='integration_operations'").get() && db.prepare("SELECT id FROM integration_operations WHERE project_id=? AND request_key<>? AND status IN ('pending','uncertain') AND action_path='POST /integrations/connections/:id/credentials'").get(context.project.id, req.headers['idempotency-key'])) fail(409, 'OPERATION_UNCERTAIN', 'Review the previous unconfirmed connection before submitting another credential request.');
  const outcome = await operation(context, async key => {
    if (platform === 'bluesky') {
      const users = await api('/users'); if (!token(users.currentUserId)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not identify the current API user.');
      payload.state = `${users.currentUserId}-${profileId}`; delete payload.profileId;
    }
    const response = await submit(api, path, {}, payload, key);
    const expectedUsername = platform === 'shopify' ? payload.shop : platform === 'wordpress' ? new URL(payload.siteUrl).hostname : platform === 'bluesky' && !body.identifier.includes('@') ? body.identifier.trim() : platform === 'telegram' && body.chatId.startsWith('@') ? body.chatId.slice(1) : undefined;
    try { return { account: await confirmed(api, profileId, expected, response, expectedUsername) }; }
    catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
  }, `connect:${platform}`);
  send(outcome.status, outcome.data); return true;
}
