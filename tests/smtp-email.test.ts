import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { withEmailTransportsForTests, type SmtpMail, type SmtpTransportOptions } from '@ten98/runtime/email';
import { emailConfigured, emailProvider, sendDirect } from '../server/direct-providers.ts';
import { createIntegrationSettings } from '../server/integration-settings.ts';
import { postgresSkip, testApp, testDatabase } from './postgres.mjs';
import { firstProject } from './first-project.ts';

type Fields = Record<string, any>;

// SMTP is Campaign's third email provider, sent through @ten98/runtime/email. Every send here goes to the runtime's own
// in-process test seam (withEmailTransportsForTests): no socket is opened and no mail leaves the machine.
const SMTP: Fields = { EMAIL_FROM: 'receipts@example.com', EMAIL_SMTP_HOST: 'smtp.example.test', EMAIL_SMTP_PORT: '2525', EMAIL_SMTP_USER: 'campaign', EMAIL_SMTP_PASSWORD: 'smtp-fixture-password' };
const CLOUDFLARE: Fields = { CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32), CLOUDFLARE_EMAIL_API_TOKEN: 'test-cloudflare-token', CLOUDFLARE_EMAIL_FROM_ADDRESS: 'receipts@example.com' };
const SES: Fields = { AWS_SES_REGION: 'us-east-1', AWS_SES_ACCESS_KEY_ID: 'AKIAFIXTUREKEY000000', AWS_SES_SECRET_ACCESS_KEY: 'fixture-secret-access-key-0000000000000000', AWS_SES_FROM_ADDRESS: 'receipts@example.com' };
const appUrl = 'https://campaign.example.test';

function fakeSmtp() {
  const sent: { options: SmtpTransportOptions; mail: SmtpMail }[] = []; let failure: Error | undefined;
  const transports = { smtp: (options: SmtpTransportOptions) => ({
    async sendMail(mail: SmtpMail) { if (failure) throw failure; sent.push({ options, mail }); return { accepted: [mail.to], rejected: [], pending: [] }; },
    close() {},
  }) };
  return { sent, fail(error?: Error) { failure = error; }, run: <T>(action: () => Promise<T>) => withEmailTransportsForTests(transports, action) };
}
// Refuses any provider HTTP call, so a send that escaped to SES or Cloudflare fails the test.
function noProviderFetch(t: TestContext) {
  const original = globalThis.fetch;
  globalThis.fetch = async (target: any, options?: any) => { const url = new URL(target); if (url.hostname === '127.0.0.1') return original(target, options); throw new Error('Unexpected provider request: ' + url.href); };
  t.after(() => { globalThis.fetch = original; });
}
const refused = (promise: Promise<unknown>, code: string, uncertain = false) => assert.rejects(promise, (error: any) => error.code === code && Boolean(error.uncertain) === uncertain);

test('SMTP is chosen like the other providers: configured in full, and named by EMAIL_PROVIDER when another is configured too', () => {
  assert.equal(emailProvider(SMTP), 'smtp'); assert.equal(emailConfigured(SMTP), true);
  assert.equal(emailProvider({ ...SMTP, ...CLOUDFLARE }), null, 'Two providers wait for EMAIL_PROVIDER.');
  assert.equal(emailProvider({ ...SMTP, ...CLOUDFLARE, EMAIL_PROVIDER: 'smtp' }), 'smtp');
  assert.equal(emailProvider({ ...SMTP, ...CLOUDFLARE, EMAIL_PROVIDER: 'cloudflare' }), 'cloudflare');
  assert.equal(emailProvider({ ...SMTP, ...CLOUDFLARE, EMAIL_PROVIDER: 'ses' }), null, 'EMAIL_PROVIDER must name a configured provider.');
  assert.equal(emailProvider({ ...SMTP, ...SES, EMAIL_PROVIDER: 'smtp' }), 'smtp');
  for (const broken of [{ EMAIL_SMTP_PASSWORD: '' }, { EMAIL_SMTP_USER: undefined }, { EMAIL_FROM: 'Receipts <receipts@example.com>' }, { EMAIL_SMTP_HOST: '127.0.0.1' }, { EMAIL_SMTP_HOST: '0x7f000001' }]) {
    assert.equal(emailProvider({ ...SMTP, ...broken }), 'cloudflare', JSON.stringify(broken)); assert.equal(emailConfigured({ ...SMTP, ...broken }), false, JSON.stringify(broken));
  }
  // Unchanged without SMTP settings.
  assert.deepEqual([emailProvider({}), emailProvider(CLOUDFLARE), emailProvider(SES), emailProvider({ ...SES, ...CLOUDFLARE }), emailProvider({ ...SES, ...CLOUDFLARE, EMAIL_PROVIDER: 'ses' })], ['cloudflare', 'cloudflare', 'ses', null, 'ses']);
  assert.deepEqual([emailConfigured({}), emailConfigured(CLOUDFLARE), emailConfigured(SES)], [false, true, true]);
});

test('an SMTP send goes through the runtime transport, and the suppression hook refuses a suppressed recipient before it', async t => {
  noProviderFetch(t);
  const smtp = fakeSmtp(), contact = { email: 'robin@example.com' }, hour = 3600000;
  const mail = { channel: 'email', campaign: { emailPurpose: 'transactional', subject: 'Your receipt', text: 'Thank you.', html: '<p>Rich receipt</p>' }, contact, env: SMTP, appUrl, project: { id: 'project-a' }, unsubscribeUrl: `${appUrl}/api/direct/unsubscribe/signed-token` };
  assert.deepEqual(await smtp.run(() => sendDirect(mail)), { providerId: null, status: 'accepted', recipient: contact.email });
  assert.equal(smtp.sent.length, 1);
  const [{ options, mail: sent }] = smtp.sent;
  assert.deepEqual([sent.from, sent.to, sent.subject], [SMTP.EMAIL_FROM, contact.email, 'Your receipt']);
  assert.equal(sent.text, `Thank you.\n\nManage email preferences: ${mail.unsubscribeUrl}`);
  assert.doesNotMatch(sent.html, /Rich receipt/, 'SMTP sends the plain-text part; the runtime builds the HTML part from it.');
  assert.deepEqual([options.host, options.port, options.auth, options.requireTLS, options.forceAuth, options.tls.minVersion, options.tls.rejectUnauthorized, options.maxRecipients], ['smtp.example.test', 2525, { user: 'campaign', pass: 'smtp-fixture-password' }, true, true, 'TLSv1.2', true, 1]);

  // A permanent suppression, or a provider hold that has not expired, is refused by the runtime's isSuppressed hook.
  for (const suppression of [{ reason: 'Unsubscribed', at: new Date().toISOString() }, { reason: 'soft_bounce', at: new Date().toISOString(), expiresAt: new Date(Date.now() + hour).toISOString() }]) {
    await refused(smtp.run(() => sendDirect({ ...mail, contact: { ...contact, suppression: { email: suppression } } })), 'RECIPIENT_SUPPRESSED');
  }
  assert.equal(smtp.sent.length, 1, 'Nothing reached the SMTP transport for a suppressed recipient.');
  // Controls: an expired hold, or a suppression on another channel, does not stop the email.
  await smtp.run(() => sendDirect({ ...mail, contact: { ...contact, suppression: { email: { reason: 'soft_bounce', expiresAt: new Date(Date.now() - hour).toISOString() }, sms: { reason: 'STOP' } } } }));
  assert.equal(smtp.sent.length, 2);
});

test('SMTP refuses marketing email and content it cannot send as written, before any connection', async t => {
  noProviderFetch(t);
  const smtp = fakeSmtp(), contact = { email: 'robin@example.com', consents: { email: true, emailMarketing: true } };
  const mail = { channel: 'email', campaign: { emailPurpose: 'transactional', subject: 'Your receipt', text: 'Thank you.' }, contact, env: SMTP, appUrl, unsubscribeUrl: `${appUrl}/api/direct/unsubscribe/signed-token` };
  // Marketing needs Amazon SES, which sends the one-click unsubscribe headers; SMTP, like Cloudflare, is transactional only.
  await refused(smtp.run(() => sendDirect({ ...mail, campaign: { ...mail.campaign, emailPurpose: 'marketing' } })), 'TRANSACTIONAL_EMAIL_ONLY');
  await refused(smtp.run(() => sendDirect({ ...mail, campaign: { ...mail.campaign, subject: 'x'.repeat(201) } })), 'INVALID_DIRECT_CONTENT');
  await refused(smtp.run(() => sendDirect({ ...mail, campaign: { ...mail.campaign, text: 'Thank you.\u0085' } })), 'INVALID_DIRECT_CONTENT');
  await refused(smtp.run(() => sendDirect({ ...mail, campaign: { ...mail.campaign, text: 'x'.repeat(65_537) } })), 'INVALID_DIRECT_CONTENT');
  await refused(smtp.run(() => sendDirect({ ...mail, contact: { email: 'robin@exämple.com' } })), 'INVALID_RECIPIENT');
  await assert.rejects(smtp.run(() => sendDirect({ ...mail, assertMapping: () => { throw Object.assign(new Error('Settings changed.'), { code: 'CONNECTION_CHANGED' }); } })), { code: 'CONNECTION_CHANGED' });
  assert.equal(smtp.sent.length, 0);
  // A failure after the message was handed over cannot be told from a lost acknowledgement: it stops for review.
  smtp.fail(new Error('451 secret server detail'));
  await assert.rejects(smtp.run(() => sendDirect(mail)), (error: any) => error.code === 'PROVIDER_UNCERTAIN' && error.uncertain === true && !error.message.includes('secret'));
});

async function fixture(t: TestContext, env: Fields = { ...SMTP }) {
  noProviderFetch(t);
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-smtp-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const app = await testApp(t, { dataDir, env, appUrl, directScheduler: false });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', () => resolve()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`; let cookie: string | undefined;
  async function request(path: string, method = 'GET', body?: unknown): Promise<{ status: number; data: any; cookie?: string }> {
    const response = await fetch(base + path, { method, headers: { Origin: appUrl, ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); return { status: response.status, data: text && response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const setup = await request('/api/auth/setup', 'POST', { name: 'QA owner', email: 'smtp-owner@example.test', password: 'fixture-passphrase-long-enough' }); setup.data.projectId = await firstProject(app, setup); assert.equal(setup.status, 201); cookie = setup.cookie;
  const path = `/api/projects/${setup.data.projectId}/direct`;
  const person = async (email: string, consents: Fields = { email: true }) => { const result = await request(path + '/contacts', 'POST', { name: email, email, consents, consentSource: 'Customer request, recorded in CRM' }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.contact; };
  const campaign = async (fields: Fields) => { const result = await request(path + '/campaigns', 'POST', { name: 'Receipt', channel: 'email', subject: 'Your receipt', text: 'Thank you.', ...fields }); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data.campaign.id as string; };
  return { app, env, path, request, person, campaign };
}

test('an SMTP campaign sends to consented contacts and marks one suppressed after scheduling as suppressed, unsent', { skip: postgresSkip }, async t => {
  const f = await fixture(t), smtp = fakeSmtp();
  const status = (await f.request(f.path + '/status')).data;
  assert.deepEqual([status.emailProvider, status.providers.email, status.marketingAvailable], ['smtp', true, false]);
  const alex = await f.person('alex@example.com'), bob = await f.person('bob@example.com'), carol = await f.person('carol@example.com', { email: false });
  const id = await f.campaign({ contactIds: [alex.id, bob.id, carol.id] }), preview = (await f.request(f.path + `/campaigns/${id}/preview`, 'POST', {})).data;
  assert.equal(preview.audience.eligible, 2); assert.deepEqual(preview.audience.exclusions.map((row: Fields) => [row.id, row.reason]), [[carol.id, 'No recorded consent']]);
  assert.equal((await f.request(f.path + `/campaigns/${id}/send`, 'POST', { confirmed: true, transactionalConfirmed: true, previewToken: preview.previewToken })).status, 200);
  assert.equal((await f.request(f.path + `/contacts/${bob.id}/suppress`, 'POST', { channel: 'email', reason: 'Asked to stop by phone' })).status, 200);
  await smtp.run(async () => { for (let pass = 0; pass < 3; pass++) await f.app.direct.processPending(); });
  assert.deepEqual(smtp.sent.map(row => row.mail.to), ['alex@example.com']);
  assert.match(smtp.sent[0].mail.text, /^Thank you\.\n\nManage email preferences: https:\/\/campaign\.example\.test\/api\/direct\/unsubscribe\/\S+$/);
  const detail = (await f.request(f.path + `/campaigns/${id}`)).data, byRecipient = Object.fromEntries(detail.deliveries.map((row: Fields) => [row.recipient, row]));
  assert.equal(detail.campaign.emailProvider, 'smtp'); assert.equal(detail.campaign.status, 'completed');
  assert.deepEqual([byRecipient['alex@example.com'].status, byRecipient['alex@example.com'].providerId], ['accepted', null]);
  assert.deepEqual([byRecipient['bob@example.com'].status, byRecipient['bob@example.com'].error], ['suppressed', 'Suppressed: Asked to stop by phone']);
});

test('marketing email is refused while SMTP is the sender, and nothing is sent', { skip: postgresSkip }, async t => {
  const f = await fixture(t), smtp = fakeSmtp();
  const reader = await f.person('reader@example.com', { email: true, emailMarketing: true }), customer = await f.person('customer@example.com');
  const id = await f.campaign({ name: 'Autumn newsletter', emailPurpose: 'marketing', subject: 'Autumn offers', text: 'New this autumn.', contactIds: [reader.id, customer.id] });
  await smtp.run(async () => {
    for (const action of ['preview', 'send', 'test']) {
      const result = await f.request(f.path + `/campaigns/${id}/${action}`, 'POST', { confirmed: true });
      assert.deepEqual([result.status, result.data.error?.code], [409, 'MARKETING_PROVIDER_REQUIRED'], action);
    }
    await f.app.direct.processPending();
  });
  assert.equal(smtp.sent.length, 0);
});

test('a scheduled SMTP campaign stops for review when the SMTP settings change before it sends', { skip: postgresSkip }, async t => {
  const f = await fixture(t), smtp = fakeSmtp(), alex = await f.person('alex@example.com');
  const id = await f.campaign({ contactIds: [alex.id] }), preview = (await f.request(f.path + `/campaigns/${id}/preview`, 'POST', {})).data;
  assert.equal((await f.request(f.path + `/campaigns/${id}/send`, 'POST', { confirmed: true, transactionalConfirmed: true, previewToken: preview.previewToken })).status, 200);
  f.env.EMAIL_SMTP_HOST = 'other-smtp.example.test';
  await smtp.run(() => f.app.direct.processPending());
  const detail = (await f.request(f.path + `/campaigns/${id}`)).data;
  assert.equal(detail.campaign.status, 'attention'); assert.match(detail.campaign.lastError, /Integration settings changed/); assert.equal(smtp.sent.length, 0);
});

test('Settings lists SMTP email from the environment without its values, and keeps it env-only', { skip: postgresSkip }, async t => {
  noProviderFetch(t);
  const database = await testDatabase(t);
  const secret = 'integration-secret-'.padEnd(48, 'x'), smtpEntry = (manager: any) => manager.describe().providers.find((row: Fields) => row.id === 'smtpEmail');
  const configured = await createIntegrationSettings({ db: database.db, env: { ...SMTP }, secret });
  assert.deepEqual(smtpEntry(configured), { id: 'smtpEmail', label: 'SMTP email', configured: true, source: 'environment', fields: {}, secretFields: {}, updatedAt: null });
  const described = JSON.stringify(configured.describe());
  for (const value of Object.values(SMTP)) assert.equal(described.includes(value), false, 'No SMTP setting value is described.');
  await assert.rejects(configured.save('smtpEmail', { password: 'saved-password' }), { code: 'INVALID_SETTING' });
  const check = await configured.test('smtpEmail');
  assert.deepEqual([check.ok, check.status], [false, 'send_test_required']); assert.match(check.message, /no email was sent/);
  await configured.save('amazonSes', { emailProvider: 'smtp' });
  const partial = await createIntegrationSettings({ db: database.db, env: { EMAIL_SMTP_HOST: 'smtp.example.test' }, secret });
  assert.deepEqual([smtpEntry(partial).configured, smtpEntry(partial).source], [false, 'environment'], 'Incomplete settings show where they come from, and not set up.');
  const absent = await createIntegrationSettings({ db: database.db, env: {}, secret });
  assert.deepEqual([smtpEntry(absent).configured, smtpEntry(absent).source], [false, 'unconfigured']);
  await assert.rejects(absent.test('smtpEmail'), { code: 'INTEGRATION_NOT_CONFIGURED' });
});
