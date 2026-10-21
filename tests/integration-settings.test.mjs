import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { postgresSkip, testDatabase } from './postgres.mjs';
import { createIntegrationSettings } from '../server/integration-settings.ts';

const secret = 'integration-settings-fixture-secret-at-least-32-characters';
const provider = (manager, id) => manager.describe().providers.find(value => value.id === id);
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code);

test('native ad credentials stay encrypted, masked and independent from shared Drive/Calendar credentials', { skip: postgresSkip }, async t => {
  const { db, pool } = await testDatabase(t), env = {};
  {
    const manager = await createIntegrationSettings({ db, env, secret });
    const fields = { clientId: 'native-client-id', clientSecret: 'native-client-secret', refreshToken: 'native-refresh-token', developerToken: 'native-developer-token' };
    await manager.save('googleAdsNative', { ...fields, loginCustomerId: '123-456-7890' }); await manager.save('microsoftAds', fields);
    assert.equal(provider(manager, 'googleAdsNative').configured, true); assert.equal(provider(manager, 'microsoftAds').configured, true);
    assert.equal(provider(manager, 'googleAdsNative').fields.loginCustomerId, '1234567890'); assert.equal(provider(manager, 'googleDrive').configured, false);
    const publicSettings = JSON.stringify(manager.describe()), saved = (await pool.query('SELECT ciphertext FROM integration_settings')).rows;
    for (const key of ['clientSecret', 'refreshToken', 'developerToken']) { assert.equal(publicSettings.includes(fields[key]), false); assert.ok(saved.every(row => !Buffer.from(row.ciphertext).toString().includes(fields[key]))); }
    const afterRestart = {}; await createIntegrationSettings({ db, env: afterRestart, secret });
    assert.equal(afterRestart.GOOGLE_ADS_REFRESH_TOKEN, fields.refreshToken); assert.equal(afterRestart.MICROSOFT_ADS_REFRESH_TOKEN, fields.refreshToken);
    await manager.save('microsoftAds', { clientSecret: null }); assert.equal(provider(manager, 'microsoftAds').configured, true, 'Microsoft public OAuth clients need no client secret.');
    await rejects(manager.save('googleAdsNative', { loginCustomerId: 'short' }), 'INVALID_SETTING');
  }
});

test('connection tests reject malformed UTF-8 and oversized bodies and cancel rejected provider responses', { skip: postgresSkip }, async t => {
  const { db } = await testDatabase(t), originalFetch = globalThis.fetch;
  const manager = await createIntegrationSettings({ db, env: { OPENROUTER_API_KEY: 'fixture', OPENROUTER_MODEL: 'fixture/model' }, secret });
  let response;
  globalThis.fetch = async (_target, options) => { assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); return response; };
  try {
    let oversizedCancelled = false;
    const malformed = new Response(Buffer.concat([Buffer.from('{"data":{"label":"'), Buffer.from([0xc3, 0x28]), Buffer.from('"}}')]));
    const oversized = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); }, cancel() { oversizedCancelled = true; } }));
    for (response of [malformed, oversized, new Response('\ufeff{"data":{"label":"Valid JSON after BOM"}}')]) {
      await assert.rejects(manager.test('openrouter'), error => error.status === 502 && error.code === 'INVALID_PROVIDER_RESPONSE');
      assert.equal(response.body.locked, false);
    }
    assert.equal(oversizedCancelled, true);
    let rejectedCancelled = false;
    response = new Response(new ReadableStream({ cancel() { rejectedCancelled = true; } }), { status: 401 });
    await assert.rejects(manager.test('openrouter'), error => error.status === 400 && error.code === 'CONNECTION_REJECTED');
    assert.equal(rejectedCancelled, true);
  } finally { globalThis.fetch = originalFetch; }
});

test('integration settings encrypt credentials, mask reads, persist overrides, share Google credentials and restore environment values', { skip: postgresSkip }, async t => {
  const { db, pool } = await testDatabase(t);
  const original = { ZERNIO_API_KEY: 'ENV_ZERNIO_KEY', ZERNIO_WEBHOOK_SECRET: 'ENV_WEBHOOK_SECRET_LONG', OPENROUTER_API_KEY: 'ENV_OPENROUTER_KEY', OPENROUTER_MODEL: 'vendor/model', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'env-service@example.test', GOOGLE_PRIVATE_KEY: 'ENV_PRIVATE_KEY' }, env = { ...original };
  {
    const manager = await createIntegrationSettings({ db, env, secret });
    assert.equal(manager.revision, 0); assert.equal(provider(manager, 'zernio').source, 'environment');
    assert.equal(provider(manager, 'openrouter').fields.maxTokens, 2048); assert.equal(provider(manager, 'broadsign').fields.environment, 'sandbox');
    assert.equal(provider(manager, 'googleDrive').configured, true); assert.equal(provider(manager, 'googleCalendar').configured, true);
    await manager.save('zernio', { apiKey: 'SAVED_ZERNIO_KEY' });
    assert.equal(env.ZERNIO_API_KEY, 'SAVED_ZERNIO_KEY'); assert.equal(env.ZERNIO_WEBHOOK_SECRET, original.ZERNIO_WEBHOOK_SECRET); assert.equal(manager.revision, 1);
    assert.equal(provider(manager, 'zernio').source, 'mixed');
    await manager.save('zernio', { apiKey: '' }); assert.equal(env.ZERNIO_API_KEY, 'SAVED_ZERNIO_KEY'); assert.equal(manager.revision, 1);
    const serialized = JSON.stringify(manager.describe());
    for (const credential of ['SAVED_ZERNIO_KEY', ...Object.values(original).filter(value => value.includes('KEY') || value.includes('SECRET'))]) assert.equal(serialized.includes(credential), false);
    const { rows: [row] } = await pool.query('SELECT * FROM integration_settings WHERE provider=$1', ['zernio']);
    assert.equal(Buffer.from(row.nonce).length, 12); assert.equal(Buffer.from(row.tag).length, 16);
    assert.equal(Buffer.from(row.ciphertext).toString().includes('SAVED_ZERNIO_KEY'), false);
    const restartedEnv = { ...original }, restarted = await createIntegrationSettings({ db, env: restartedEnv, secret });
    assert.equal(restartedEnv.ZERNIO_API_KEY, 'SAVED_ZERNIO_KEY'); assert.equal(provider(restarted, 'zernio').secretFields.apiKey.configured, true);
    await restarted.save('zernio', { apiKey: null });
    assert.equal(restartedEnv.ZERNIO_API_KEY, ''); assert.equal(provider(restarted, 'zernio').configured, false); assert.equal(provider(restarted, 'zernio').secretFields.apiKey.source, 'saved');
    await restarted.reset('zernio'); assert.equal(restartedEnv.ZERNIO_API_KEY, original.ZERNIO_API_KEY); assert.equal(provider(restarted, 'zernio').source, 'environment');
    await restarted.save('googleCalendar', { serviceAccountEmail: 'saved-service@example.test', privateKey: null });
    assert.equal(restartedEnv.GOOGLE_SERVICE_ACCOUNT_EMAIL, 'saved-service@example.test'); assert.equal(restartedEnv.GOOGLE_PRIVATE_KEY, '');
    assert.equal(provider(restarted, 'googleDrive').configured, false); assert.equal(provider(restarted, 'googleCalendar').fields.serviceAccountEmail, 'saved-service@example.test');
    await restarted.reset('googleDrive'); assert.equal(restartedEnv.GOOGLE_PRIVATE_KEY, original.GOOGLE_PRIVATE_KEY); assert.equal(provider(restarted, 'googleCalendar').fields.serviceAccountEmail, original.GOOGLE_SERVICE_ACCOUNT_EMAIL);
    await rejects(restarted.save('zernio', { apiKey: 'unsafe\nsecret' }), 'INVALID_SETTING');
    await rejects(restarted.save('zernio', { endpoint: 'https://attacker.example' }), 'INVALID_SETTING');
    await rejects(restarted.save('openrouter', { maxTokens: 255 }), 'INVALID_SETTING');
    await rejects(restarted.save('openrouter', { maxSteps: 9 }), 'INVALID_SETTING');
    await rejects(restarted.save('googleDrive', { privateKey: 'not a private key' }), 'INVALID_GOOGLE_PRIVATE_KEY');
    await rejects(restarted.save('googleCalendar', { serviceAccountEmail: 'invalid' }), 'INVALID_SETTING');
    await rejects(restarted.save('googleMaps', { mapId: 'id with space' }), 'INVALID_SETTING');
    await rejects(restarted.save('broadsign', { environment: 'https://other-host.example' }), 'INVALID_SETTING');
    await rejects(restarted.save('broadsign', { domainId: '-1' }), 'INVALID_SETTING');
    await rejects(restarted.reset('__proto__'), 'UNKNOWN_INTEGRATION');
    await restarted.save('zernio', { apiKey: 'SECRET_SAVED_BEFORE_TAMPER' });
    await assert.rejects(createIntegrationSettings({ db, env: { ...original }, secret: 'different-session-secret-with-more-than-32-characters' }), /could not be decrypted/);
    await pool.query('UPDATE integration_settings SET tag=$1 WHERE provider=$2', [Buffer.alloc(16), 'zernio']);
    await assert.rejects(createIntegrationSettings({ db, env: { ...original }, secret }), /could not be decrypted/);
  }
});

test('connection tests use fixed read-only provider contracts, never inference or writes, and report Maps verification honestly', { skip: postgresSkip }, async t => {
  const { db } = await testDatabase(t), originalFetch = globalThis.fetch, calls = [];
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const env = { ZERNIO_API_KEY: 'TEST_ZERNIO_KEY', OPENROUTER_API_KEY: 'TEST_OPENROUTER_KEY', OPENROUTER_MODEL: 'vendor/model', GOOGLE_SERVICE_ACCOUNT_EMAIL: 'service@example.test', GOOGLE_PRIVATE_KEY: privateKey, GOOGLE_MAPS_BROWSER_API_KEY: 'TEST_BROWSER_KEY', GOOGLE_MAPS_MAP_ID: 'map-id', BROADSIGN_API_KEY: 'TEST_BROADSIGN_KEY', BROADSIGN_DOMAIN_ID: '12' };
  const manager = await createIntegrationSettings({ db, env, secret });
  let rejectNext = false, onFetch;
  globalThis.fetch = async (target, options) => {
    const url = new URL(target); calls.push({ url: url.href, options });
    assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    const changing = onFetch; onFetch = undefined; await changing?.();
    if (rejectNext) { rejectNext = false; return new Response(JSON.stringify({ error: 'TEST_OPENROUTER_KEY must never be returned' }), { status: 401 }); }
    if (url.href === 'https://zernio.com/api/v1/profiles') { assert.equal(options.method, 'GET'); assert.equal(options.headers.Authorization, 'Bearer TEST_ZERNIO_KEY'); return Response.json({ profiles: [{ _id: 'private-id', name: 'PRIVATE_PROFILE_NAME' }] }); }
    if (url.href === 'https://openrouter.ai/api/v1/key') { assert.equal(options.method || 'GET', 'GET'); assert.equal(options.headers.Authorization, 'Bearer TEST_OPENROUTER_KEY'); return Response.json({ data: { label: 'PRIVATE_KEY_LABEL', limit_remaining: 5 } }); }
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
    await manager.save('broadsign', { domainId: '99' });
    await assert.rejects(manager.test('broadsign'), error => error.code === 'BROADSIGN_DOMAIN_MISMATCH');
    await manager.save('googleMaps', { browserApiKey: null });
    const beforeMissing = calls.length;
    await assert.rejects(manager.test('googleMaps'), error => error.code === 'INTEGRATION_NOT_CONFIGURED'); assert.equal(calls.length, beforeMissing);
    assert.equal(calls.some(call => call.url.includes('chat/completions')), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('connection tests reject non-object provider responses as unreadable without leaking them', { skip: postgresSkip }, async t => {
  const { db } = await testDatabase(t), originalFetch = globalThis.fetch;
  const env = { OPENROUTER_API_KEY: 'TEST_OPENROUTER_KEY', OPENROUTER_MODEL: 'vendor/model', BROADSIGN_API_KEY: 'TEST_BROADSIGN_KEY', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 'TEST_TWILIO_TOKEN', TWILIO_FROM_NUMBER: '+12025550100', CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_ZONE_ID: 'b'.repeat(32), CLOUDFLARE_EMAIL_API_TOKEN: 'TEST_EMAIL_KEY', CLOUDFLARE_EMAIL_FROM_ADDRESS: 'sender@example.test' };
  const manager = await createIntegrationSettings({ db, env, secret });
  try {
    for (const payload of [null, [], 'PRIVATE_PROVIDER_RESPONSE', 123]) {
      globalThis.fetch = async () => Response.json(payload);
      for (const name of ['openrouter', 'broadsign', 'twilio', 'cloudflareEmail']) await assert.rejects(manager.test(name), error => error.status === 502 && error.code === 'INVALID_PROVIDER_RESPONSE' && !error.message.includes('PRIVATE_PROVIDER_RESPONSE'));
    }
  } finally { globalThis.fetch = originalFetch; }
});
