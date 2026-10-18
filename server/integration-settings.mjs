import { createCipheriv, createDecipheriv, createPrivateKey, hkdfSync, randomBytes } from 'node:crypto';
import { googleToken, providerRequest, IntegrationError } from './integrations.mjs';

const groups = {
  zernio: { apiKey: 'ZERNIO_API_KEY', webhookSecret: 'ZERNIO_WEBHOOK_SECRET' },
  openrouter: { apiKey: 'OPENROUTER_API_KEY', model: 'OPENROUTER_MODEL', maxTokens: 'OPENROUTER_MAX_TOKENS', maxSteps: 'OPENROUTER_MAX_STEPS' },
  google: { serviceAccountEmail: 'GOOGLE_SERVICE_ACCOUNT_EMAIL', privateKey: 'GOOGLE_PRIVATE_KEY' },
  googleMaps: { browserApiKey: 'GOOGLE_MAPS_BROWSER_API_KEY', mapId: 'GOOGLE_MAPS_MAP_ID' },
  broadsign: { apiKey: 'BROADSIGN_API_KEY', environment: 'BROADSIGN_ENVIRONMENT', domainId: 'BROADSIGN_DOMAIN_ID' },
};
const providers = { zernio: 'Zernio', openrouter: 'OpenRouter', googleDrive: 'Google Drive', googleCalendar: 'Google Calendar', googleMaps: 'Google Maps', broadsign: 'Broadsign' };
const secretFields = new Set(['apiKey', 'webhookSecret', 'privateKey', 'browserApiKey']);
const defaults = { maxTokens: '2048', maxSteps: '4', environment: 'sandbox' };
const groupFor = provider => ['googleDrive', 'googleCalendar'].includes(provider) ? 'google' : provider;
const fail = (status, code, message) => { throw new IntegrationError(status, code, message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

function validate(field, input) {
  if (input === null) return '';
  if (['maxTokens', 'maxSteps'].includes(field)) {
    const number = typeof input === 'string' && /^\d+$/.test(input) ? Number(input) : input;
    if (!Number.isInteger(number) || number < (field === 'maxTokens' ? 256 : 1) || number > (field === 'maxTokens' ? 8192 : 8)) fail(400, 'INVALID_SETTING', `${field === 'maxTokens' ? 'Maximum tokens must be from 256 to 8192' : 'Maximum steps must be from 1 to 8'}.`);
    return String(number);
  }
  if (typeof input !== 'string' || input.length > (field === 'privateKey' ? 20000 : 4096)) fail(400, 'INVALID_SETTING', 'Enter a valid integration setting.');
  const value = input.trim();
  if (!value) return '';
  if (field === 'privateKey') {
    try {
      const key = createPrivateKey(value.replace(/\\n/g, '\n'));
      if (key.asymmetricKeyType !== 'rsa' || key.asymmetricKeyDetails?.modulusLength < 2048) throw new Error();
    } catch { fail(400, 'INVALID_GOOGLE_PRIVATE_KEY', 'Use the RSA private key from your Google service account JSON file.'); }
    return value.replace(/\\n/g, '\n');
  }
  if (/[\u0000-\u001f\u007f]/.test(value)) fail(400, 'INVALID_SETTING', 'Integration settings cannot contain control characters.');
  if (secretFields.has(field) && (value.length < (field === 'webhookSecret' ? 16 : 8) || /\s/.test(value))) fail(400, 'INVALID_SETTING', 'Enter a complete API key or webhook secret without spaces.');
  if (field === 'serviceAccountEmail' && (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) fail(400, 'INVALID_SETTING', 'Enter the Google service account email address.');
  if (field === 'model' && (value.length > 200 || /\s/.test(value))) fail(400, 'INVALID_SETTING', 'Enter an OpenRouter model ID without spaces.');
  if (field === 'mapId' && (value.length > 100 || !/^[A-Za-z0-9_-]+$/.test(value))) fail(400, 'INVALID_SETTING', 'Enter a valid Google map ID.');
  if (field === 'environment' && !['sandbox', 'production'].includes(value)) fail(400, 'INVALID_SETTING', 'Choose the Broadsign sandbox or production environment.');
  if (field === 'domainId' && (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) fail(400, 'INVALID_SETTING', 'Enter a positive numeric Broadsign domain ID.');
  return value;
}

// This helper is limited to fixed, read-only endpoints; provider error bodies never enter responses.
async function readProvider(url, authorization, label) {
  let response;
  try { response = await fetch(url, { method: 'GET', headers: { Authorization: authorization, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(20000) }); }
  catch { fail(502, 'CONNECTION_UNAVAILABLE', `${label} could not be reached. Check the connection and try again.`); }
  if (!response.ok) fail(response.status === 429 ? 429 : response.status >= 500 ? 502 : 400, 'CONNECTION_REJECTED', `${label} rejected the connection test. Check the saved credentials and provider permissions.`);
  try {
    const reader = response.body.getReader(), chunks = []; let size = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error(); } chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { fail(502, 'INVALID_PROVIDER_RESPONSE', `${label} returned an unreadable response.`); }
}

export function createIntegrationSettings({ db, env, secret }) {
  if (typeof secret !== 'string' || secret.length < 32) throw new Error('Integration settings require the instance session secret.');
  const key = hkdfSync('sha256', secret, 'ten98-campaign', 'integration-settings-v1', 32);
  const fallback = Object.fromEntries(Object.values(groups).flatMap(fields => Object.values(fields)).map(name => [name, env[name]]));
  const saved = new Map(); let revision = 0;
  db.exec('CREATE TABLE IF NOT EXISTS integration_settings(provider TEXT PRIMARY KEY,nonce BLOB NOT NULL,ciphertext BLOB NOT NULL,tag BLOB NOT NULL,updated_at TEXT NOT NULL)');
  function decode(row) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, row.nonce); decipher.setAAD(Buffer.from(`integration-settings-v1:${row.provider}`)); decipher.setAuthTag(row.tag);
      const fields = JSON.parse(Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8'));
      if (!plain(fields) || Object.keys(fields).some(field => !Object.hasOwn(groups[row.provider] || {}, field)) || Object.values(fields).some(value => typeof value !== 'string')) throw new Error();
      return fields;
    } catch { throw new Error('Saved integration settings could not be decrypted. Restore the matching session secret and database backup.'); }
  }
  for (const row of db.prepare('SELECT * FROM integration_settings').all()) {
    if (!Object.hasOwn(groups, row.provider)) throw new Error('Saved integration settings contain an unsupported provider.');
    saved.set(row.provider, { fields: decode(row), updatedAt: row.updated_at });
  }
  function apply(group) {
    for (const [field, name] of Object.entries(groups[group])) {
      const value = Object.hasOwn(saved.get(group)?.fields || {}, field) ? saved.get(group).fields[field] : fallback[name];
      if (value === undefined) delete env[name]; else env[name] = value;
    }
  }
  for (const group of Object.keys(groups)) apply(group);
  const requireProvider = provider => { if (!Object.hasOwn(providers, provider)) fail(404, 'UNKNOWN_INTEGRATION', 'This integration is not available.'); return groupFor(provider); };
  function describeProvider(provider) {
    const group = requireProvider(provider), row = saved.get(group), fields = {}, secrets = {}, sources = new Set();
    for (const [field, name] of Object.entries(groups[group])) {
      const overridden = Object.hasOwn(row?.fields || {}, field), value = env[name] || '';
      const source = overridden ? 'saved' : value ? 'environment' : 'unconfigured';
      if (source !== 'unconfigured') sources.add(source);
      if (secretFields.has(field)) secrets[field] = { configured: Boolean(value), source };
      else fields[field] = ['maxTokens', 'maxSteps'].includes(field) ? Number(value || defaults[field]) : value || defaults[field] || '';
    }
    const configured = group === 'google' ? Boolean(env.GOOGLE_SERVICE_ACCOUNT_EMAIL && env.GOOGLE_PRIVATE_KEY) : provider === 'openrouter' ? Boolean(env.OPENROUTER_API_KEY && env.OPENROUTER_MODEL) : provider === 'googleMaps' ? Boolean(env.GOOGLE_MAPS_BROWSER_API_KEY) : Boolean(env[groups[group].apiKey]);
    return { id: provider, label: providers[provider], configured, source: sources.size > 1 ? 'mixed' : [...sources][0] || 'unconfigured', fields, secretFields: secrets, updatedAt: row?.updatedAt || null };
  }
  const describe = () => ({ providers: Object.keys(providers).map(describeProvider), revision });
  return {
    get revision() { return revision; },
    describe,
    save(provider, fields) {
      const group = requireProvider(provider);
      if (!plain(fields) || Object.keys(fields).length === 0 || Object.keys(fields).some(field => !Object.hasOwn(groups[group], field))) fail(400, 'INVALID_SETTING', 'Use only the settings shown for this integration.');
      const values = { ...(saved.get(group)?.fields || {}) }, before = JSON.stringify(Object.values(groups[group]).map(name => env[name]));
      for (const [field, input] of Object.entries(fields)) {
        if (secretFields.has(field) && typeof input === 'string' && !input.trim()) continue;
        values[field] = validate(field, input);
      }
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(Buffer.from(`integration-settings-v1:${group}`));
      const ciphertext = Buffer.concat([cipher.update(JSON.stringify(values), 'utf8'), cipher.final()]), updatedAt = new Date().toISOString();
      db.prepare('INSERT INTO integration_settings VALUES(?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET nonce=excluded.nonce,ciphertext=excluded.ciphertext,tag=excluded.tag,updated_at=excluded.updated_at').run(group, nonce, ciphertext, cipher.getAuthTag(), updatedAt);
      saved.set(group, { fields: values, updatedAt }); apply(group);
      if (before !== JSON.stringify(Object.values(groups[group]).map(name => env[name]))) revision++;
      return describe();
    },
    reset(provider) {
      const group = requireProvider(provider), before = JSON.stringify(Object.values(groups[group]).map(name => env[name]));
      db.prepare('DELETE FROM integration_settings WHERE provider=?').run(group); saved.delete(group); apply(group);
      if (before !== JSON.stringify(Object.values(groups[group]).map(name => env[name]))) revision++;
      return describe();
    },
    async test(provider, context = {}) {
      requireProvider(provider);
      const currentRevision = revision, current = { ...env }, ready = describeProvider(provider);
      if (!ready.configured) fail(409, 'INTEGRATION_NOT_CONFIGURED', 'Save the required credentials before testing this integration.');
      const result = { ok: true, status: 'connected', checkedAt: new Date().toISOString(), readOnly: true };
      if (provider === 'zernio') {
        const data = await providerRequest('https://zernio.com/api/v1/profiles', { method: 'GET', headers: { Authorization: `Bearer ${current.ZERNIO_API_KEY}` } }, 'Zernio');
        if (!Array.isArray(data.profiles)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return the expected profile list.');
        result.message = `Zernio accepted the key and returned ${data.profiles.length} accessible profile${data.profiles.length === 1 ? '' : 's'}. Webhook delivery must be tested from Zernio.`;
      } else if (provider === 'openrouter') {
        const data = await readProvider('https://openrouter.ai/api/v1/key', `Bearer ${current.OPENROUTER_API_KEY}`, 'OpenRouter');
        if (!plain(data.data)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'OpenRouter did not return API key information.');
        result.message = 'OpenRouter accepted the API key. No model request was sent; model availability and inference were not tested.';
      } else if (provider === 'googleDrive') {
        const token = await googleToken(current);
        if (context.driveFolderId) {
          const folder = String(context.driveFolderId);
          if (!/^[\w-]{1,500}$/.test(folder)) fail(400, 'INVALID_MAPPING', 'Choose a valid project Drive folder before testing.');
          const url = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folder)}`); url.searchParams.set('supportsAllDrives', 'true'); url.searchParams.set('fields', 'id,mimeType,trashed,capabilities(canAddChildren)');
          const data = await providerRequest(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } }, 'Google Drive');
          if (data.id !== folder || data.mimeType !== 'application/vnd.google-apps.folder' || data.trashed === true) fail(409, 'INVALID_DRIVE_FOLDER', 'The mapped Drive location is not an accessible active folder.');
          result.message = `The mapped Drive folder is readable.${data.capabilities?.canAddChildren === true ? ' Google reports permission to add files.' : ' Upload permissions were not confirmed.'} No files were changed.`;
        } else {
          const data = await providerRequest('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', { method: 'GET', headers: { Authorization: `Bearer ${token}` } }, 'Google Drive');
          if (!plain(data.user)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Google Drive did not return account information.');
          result.status = 'needs_mapping'; result.message = 'Google Drive accepted the credentials. Map a shared folder to this project to verify its access.';
        }
      } else if (provider === 'googleCalendar') {
        if (context.calendarId) {
          const calendar = String(context.calendarId);
          if (calendar === 'primary' || calendar.length > 1024 || /[\u0000-\u001f]/.test(calendar)) fail(400, 'INVALID_MAPPING', 'Choose a shared calendar ID before testing.');
          const token = await googleToken(current, 'https://www.googleapis.com/auth/calendar.events');
          const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar)}/events`); url.searchParams.set('maxResults', '1'); url.searchParams.set('fields', 'items(id),kind');
          const data = await providerRequest(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } }, 'Google Calendar');
          if (!Array.isArray(data.items) && data.kind !== 'calendar#events') fail(502, 'INVALID_PROVIDER_RESPONSE', 'Google Calendar did not return an event list.');
          result.message = 'The mapped Google Calendar is readable. No events were changed; calendar write permissions were not tested.';
        } else {
          const token = await googleToken(current, 'https://www.googleapis.com/auth/calendar.calendarlist.readonly');
          const data = await providerRequest('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1&fields=kind,items(id)', { method: 'GET', headers: { Authorization: `Bearer ${token}` } }, 'Google Calendar');
          if (!Array.isArray(data.items) && data.kind !== 'calendar#calendarList') fail(502, 'INVALID_PROVIDER_RESPONSE', 'Google Calendar did not return a calendar list.');
          result.status = 'needs_mapping'; result.message = 'Google Calendar accepted the credentials. Map a shared calendar to this project to verify its access.';
        }
      } else if (provider === 'googleMaps') {
        result.ok = false; result.status = 'browser_verification_required'; result.requiresBrowserVerification = true;
        result.message = 'The browser key is configured. Open the map preview to test Maps JavaScript API access, billing, map ID, and this site’s referrer restrictions.';
      } else {
        const base = { sandbox: 'https://direct-sandbox.broadsign.com', production: 'https://direct.broadsign.com' }[current.BROADSIGN_ENVIRONMENT || 'sandbox'];
        if (!base) fail(409, 'INVALID_SETTING', 'Choose the Broadsign sandbox or production environment.');
        const data = await readProvider(`${base}/api/v1/user/current_user`, `Broadsign ${current.BROADSIGN_API_KEY}`, 'Broadsign'), user = data.user || data;
        if (!Number.isSafeInteger(Number(user.domain_id)) || Number(user.domain_id) < 1) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Broadsign did not return the current account domain.');
        if (current.BROADSIGN_DOMAIN_ID && String(user.domain_id) !== current.BROADSIGN_DOMAIN_ID) fail(409, 'BROADSIGN_DOMAIN_MISMATCH', 'The Broadsign key belongs to a different domain than the configured domain ID.');
        result.message = `Broadsign accepted the key for the ${current.BROADSIGN_ENVIRONMENT || 'sandbox'} environment. No inventory or bookings were changed.`;
      }
      if (currentRevision !== revision) fail(409, 'INTEGRATION_SETTINGS_CHANGED', 'Integration settings changed during this test. Test the current settings again.');
      return result;
    },
  };
}
