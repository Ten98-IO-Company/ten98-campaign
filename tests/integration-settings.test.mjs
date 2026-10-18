import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { createIntegrationSettings } from '../server/integration-settings.mjs';

const secret = 'integration-settings-fixture-secret-at-least-32-characters';
const provider = (manager, id) => manager.describe().providers.find(value => value.id === id);
const rejects = (run, code) => assert.throws(run, error => error.code === code);

test('integration settings encrypt credentials, mask reads, persist overrides, share Google credentials and restore environment values', () => {
  const db = new DatabaseSync(':memory:');
  const original = { ZERNIO_API_KEY: 'ENV_ZERNIO_KEY', ZERNIO_WEBHOOK_SECRET: 'ENV_WEBHOOK_SECRET_LONG', OPENROUTER_API_KEY: 'ENV_OPENROUTER_KEY', OPENROUTER_MODEL: 'vendor/model', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'env-service@example.test', GOOGLE_PRIVATE_KEY: 'ENV_PRIVATE_KEY' }, env = { ...original };
  try {
    const manager = createIntegrationSettings({ db, env, secret });
    assert.equal(manager.revision, 0); assert.equal(provider(manager, 'zernio').source, 'environment');
    assert.equal(provider(manager, 'openrouter').fields.maxTokens, 2048); assert.equal(provider(manager, 'broadsign').fields.environment, 'sandbox');
    assert.equal(provider(manager, 'googleDrive').configured, true); assert.equal(provider(manager, 'googleCalendar').configured, true);
    manager.save('zernio', { apiKey: 'SAVED_ZERNIO_KEY' });
    assert.equal(env.ZERNIO_API_KEY, 'SAVED_ZERNIO_KEY'); assert.equal(env.ZERNIO_WEBHOOK_SECRET, original.ZERNIO_WEBHOOK_SECRET); assert.equal(manager.revision, 1);
    assert.equal(provider(manager, 'zernio').source, 'mixed');
    manager.save('zernio', { apiKey: '' }); assert.equal(env.ZERNIO_API_KEY, 'SAVED_ZERNIO_KEY'); assert.equal(manager.revision, 1);
    const serialized = JSON.stringify(manager.describe());
    for (const credential of ['SAVED_ZERNIO_KEY', ...Object.values(original).filter(value => value.includes('KEY') || value.includes('SECRET'))]) assert.equal(serialized.includes(credential), false);
    const row = db.prepare('SELECT * FROM integration_settings WHERE provider=?').get('zernio');
    assert.equal(Buffer.from(row.nonce).length, 12); assert.equal(Buffer.from(row.tag).length, 16);
    assert.equal(Buffer.from(row.ciphertext).toString().includes('SAVED_ZERNIO_KEY'), false);
    const restartedEnv = { ...original }, restarted = createIntegrationSettings({ db, env: restartedEnv, secret });
    assert.equal(restartedEnv.ZERNIO_API_KEY, 'SAVED_ZERNIO_KEY'); assert.equal(provider(restarted, 'zernio').secretFields.apiKey.configured, true);
    restarted.save('zernio', { apiKey: null });
    assert.equal(restartedEnv.ZERNIO_API_KEY, ''); assert.equal(provider(restarted, 'zernio').configured, false); assert.equal(provider(restarted, 'zernio').secretFields.apiKey.source, 'saved');
    restarted.reset('zernio'); assert.equal(restartedEnv.ZERNIO_API_KEY, original.ZERNIO_API_KEY); assert.equal(provider(restarted, 'zernio').source, 'environment');
    restarted.save('googleCalendar', { serviceAccountEmail: 'saved-service@example.test', privateKey: null });
    assert.equal(restartedEnv.GOOGLE_SERVICE_ACCOUNT_EMAIL, 'saved-service@example.test'); assert.equal(restartedEnv.GOOGLE_PRIVATE_KEY, '');
    assert.equal(provider(restarted, 'googleDrive').configured, false); assert.equal(provider(restarted, 'googleCalendar').fields.serviceAccountEmail, 'saved-service@example.test');
    restarted.reset('googleDrive'); assert.equal(restartedEnv.GOOGLE_PRIVATE_KEY, original.GOOGLE_PRIVATE_KEY); assert.equal(provider(restarted, 'googleCalendar').fields.serviceAccountEmail, original.GOOGLE_SERVICE_ACCOUNT_EMAIL);
    rejects(() => restarted.save('zernio', { apiKey: 'unsafe\nsecret' }), 'INVALID_SETTING');
    rejects(() => restarted.save('zernio', { endpoint: 'https://attacker.example' }), 'INVALID_SETTING');
    rejects(() => restarted.save('openrouter', { maxTokens: 255 }), 'INVALID_SETTING');
    rejects(() => restarted.save('openrouter', { maxSteps: 9 }), 'INVALID_SETTING');
    rejects(() => restarted.save('googleDrive', { privateKey: 'not a private key' }), 'INVALID_GOOGLE_PRIVATE_KEY');
    rejects(() => restarted.save('googleCalendar', { serviceAccountEmail: 'invalid' }), 'INVALID_SETTING');
    rejects(() => restarted.save('googleMaps', { mapId: 'id with space' }), 'INVALID_SETTING');
    rejects(() => restarted.save('broadsign', { environment: 'https://other-host.example' }), 'INVALID_SETTING');
    rejects(() => restarted.save('broadsign', { domainId: '-1' }), 'INVALID_SETTING');
    rejects(() => restarted.reset('__proto__'), 'UNKNOWN_INTEGRATION');
    restarted.save('zernio', { apiKey: 'SECRET_SAVED_BEFORE_TAMPER' });
    assert.throws(() => createIntegrationSettings({ db, env: { ...original }, secret: 'different-session-secret-with-more-than-32-characters' }), /could not be decrypted/);
    db.prepare('UPDATE integration_settings SET tag=? WHERE provider=?').run(Buffer.alloc(16), 'zernio');
    assert.throws(() => createIntegrationSettings({ db, env: { ...original }, secret }), /could not be decrypted/);
  } finally { db.close(); }
});

test('connection tests use fixed read-only provider contracts, never inference or writes, and report Maps verification honestly', async () => {
  const db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, calls = [];
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const env = { ZERNIO_API_KEY: 'TEST_ZERNIO_KEY', OPENROUTER_API_KEY: 'TEST_OPENROUTER_KEY', OPENROUTER_MODEL: 'vendor/model', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'service@example.test', GOOGLE_PRIVATE_KEY: privateKey, GOOGLE_MAPS_BROWSER_API_KEY: 'TEST_BROWSER_KEY', GOOGLE_MAPS_MAP_ID: 'map-id', BROADSIGN_API_KEY: 'TEST_BROADSIGN_KEY', BROADSIGN_DOMAIN_ID: '12' };
  const manager = createIntegrationSettings({ db, env, secret });
  let rejectNext = false, onFetch;
  globalThis.fetch = async (target, options) => {
    const url = new URL(target); calls.push({ url: url.href, options });
    assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    onFetch?.(); onFetch = undefined;
    if (rejectNext) { rejectNext = false; return new Response(JSON.stringify({ error: 'TEST_OPENROUTER_KEY must never be returned' }), { status: 401 }); }
    if (url.href === 'https://zernio.com/api/v1/profiles') { assert.equal(options.method, 'GET'); assert.equal(options.headers.Authorization, 'Bearer TEST_ZERNIO_KEY'); return Response.json({ profiles: [{ _id: 'private-id', name: 'PRIVATE_PROFILE_NAME' }] }); }
    if (url.href === 'https://openrouter.ai/api/v1/key') { assert.equal(options.method, 'GET'); assert.equal(options.headers.Authorization, 'Bearer TEST_OPENROUTER_KEY'); return Response.json({ data: { label: 'PRIVATE_KEY_LABEL', limit_remaining: 5 } }); }
    if (url.href === 'https://oauth2.googleapis.com/token') {
      assert.equal(options.method, 'POST'); const assertion = new URLSearchParams(options.body).get('assertion');
      const payload = JSON.parse(Buffer.from(assertion.split('.')[1], 'base64url').toString());
      assert.equal(payload.iss, 'service@example.test'); assert.equal(payload.aud, 'https://oauth2.googleapis.com/token');
      assert.ok(['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'].includes(payload.scope));
      return Response.json({ access_token: 'TOKEN_DO_NOT_RETURN' });
    }
    if (url.hostname === 'www.googleapis.com') {
      assert.equal(options.method, 'GET'); assert.equal(options.headers.Authorization, 'Bearer TOKEN_DO_NOT_RETURN');
      if (url.pathname === '/drive/v3/files/mapped-folder') {
        assert.equal(url.searchParams.get('supportsAllDrives'), 'true'); assert.equal(url.searchParams.get('fields'), 'id,mimeType,trashed,capabilities(canAddChildren)');
        return Response.json({ id: 'mapped-folder', mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } });
      }
      if (url.pathname === '/drive/v3/about') { assert.equal(url.searchParams.get('fields'), 'user(emailAddress)'); return Response.json({ user: { emailAddress: 'PRIVATE_EMAIL' } }); }
      if (decodeURIComponent(url.pathname) === '/calendar/v3/calendars/project@example.test/events') { assert.equal(url.searchParams.get('maxResults'), '1'); return Response.json({ kind: 'calendar#events', items: [{ id: 'PRIVATE_EVENT_ID' }] }); }
      if (url.pathname === '/calendar/v3/users/me/calendarList') { assert.equal(url.searchParams.get('maxResults'), '1'); return Response.json({ kind: 'calendar#calendarList' }); }
    }
    if (url.href === 'https://direct-sandbox.broadsign.com/api/v1/user/current_user') { assert.equal(options.method, 'GET'); assert.equal(options.headers.Authorization, 'Broadsign TEST_BROADSIGN_KEY'); return Response.json({ user: { domain_id: 12, password: 'PROVIDER_PASSWORD_DO_NOT_RETURN' } }); }
    assert.fail(`Unexpected provider call: ${url}`);
  };
  try {
    const results = [];
    results.push(await manager.test('zernio'), await manager.test('openrouter'), await manager.test('googleDrive', { driveFolderId: 'mapped-folder' }), await manager.test('googleCalendar', { calendarId: 'project@example.test' }), await manager.test('broadsign'));
    for (const result of results) { assert.equal(result.ok, true); assert.equal(result.status, 'connected'); assert.equal(result.readOnly, true); assert.ok(result.checkedAt); }
    assert.equal(calls.length, 7);
    assert.equal((await manager.test('googleDrive')).status, 'needs_mapping'); assert.equal((await manager.test('googleCalendar')).status, 'needs_mapping');
    const beforeMaps = calls.length, maps = await manager.test('googleMaps');
    assert.equal(maps.ok, false); assert.equal(maps.status, 'browser_verification_required'); assert.equal(maps.requiresBrowserVerification, true); assert.equal(calls.length, beforeMaps);
    const output = JSON.stringify([...results, maps]);
    for (const forbidden of ['TEST_ZERNIO_KEY', 'TEST_OPENROUTER_KEY', 'TEST_BROWSER_KEY', 'TEST_BROADSIGN_KEY', 'TOKEN_DO_NOT_RETURN', 'PRIVATE_PROFILE_NAME', 'PRIVATE_KEY_LABEL', 'PRIVATE_EVENT_ID', 'PROVIDER_PASSWORD_DO_NOT_RETURN']) assert.equal(output.includes(forbidden), false);
    rejectNext = true;
    await assert.rejects(manager.test('openrouter'), error => error.code === 'CONNECTION_REJECTED' && !error.message.includes('TEST_OPENROUTER_KEY'));
    onFetch = () => manager.save('openrouter', { model: 'vendor/new-model' });
    await assert.rejects(manager.test('zernio'), error => error.code === 'INTEGRATION_SETTINGS_CHANGED');
    manager.save('broadsign', { domainId: '99' });
    await assert.rejects(manager.test('broadsign'), error => error.code === 'BROADSIGN_DOMAIN_MISMATCH');
    manager.save('googleMaps', { browserApiKey: null });
    const beforeMissing = calls.length;
    await assert.rejects(manager.test('googleMaps'), error => error.code === 'INTEGRATION_NOT_CONFIGURED'); assert.equal(calls.length, beforeMissing);
    assert.equal(calls.some(call => call.url.includes('chat/completions')), false);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});

test('connection tests reject non-object provider responses as unreadable without leaking them', async () => {
  const db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch;
  const env = { OPENROUTER_API_KEY: 'TEST_OPENROUTER_KEY', OPENROUTER_MODEL: 'vendor/model', BROADSIGN_API_KEY: 'TEST_BROADSIGN_KEY', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 'TEST_TWILIO_TOKEN', TWILIO_FROM_NUMBER: '+12025550100', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_ZONE_ID: 'b'.repeat(32), CLOUDFLARE_EMAIL_API_TOKEN: 'TEST_EMAIL_KEY', CLOUDFLARE_EMAIL_FROM_ADDRESS: 'sender@example.test' };
  const manager = createIntegrationSettings({ db, env, secret });
  try {
    for (const payload of [null, [], 'PRIVATE_PROVIDER_RESPONSE', 123]) {
      globalThis.fetch = async () => Response.json(payload);
      for (const name of ['openrouter', 'broadsign', 'twilio', 'cloudflareEmail']) await assert.rejects(manager.test(name), error => error.status === 502 && error.code === 'INVALID_PROVIDER_RESPONSE' && !error.message.includes('PRIVATE_PROVIDER_RESPONSE'));
    }
  } finally { globalThis.fetch = originalFetch; db.close(); }
});
