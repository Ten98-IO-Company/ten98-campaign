import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuth, hashPassword, signInLimits } from '../server/auth.ts';
import { postgresSkip, testDatabase } from './postgres.mjs';

const pg = { skip: postgresSkip }, secret = 'sign-in-limit-fixture-secret-32-characters';
function response() {
  return { headers: {}, status: null, setHeader(name, value) { this.headers[name] = value; }, getHeader(name) { return this.headers[name]; }, writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); }, end() {} };
}
const request = (peer, forwarded) => ({ headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded }, socket: { remoteAddress: peer } });
const addressOf = (trustedProxies, peer, forwarded) => createAuth(undefined, { sessionSecret: secret, appUrl: 'https://campaign.example', trustedProxies }).clientAddress(request(peer, forwarded));

test('an untrusted peer is keyed on its socket address whatever X-Forwarded-For says', () => {
  assert.equal(addressOf([], '198.51.100.50', '203.0.113.7'), '198.51.100.50');
  assert.equal(addressOf(['10.0.0.2'], '198.51.100.50', '203.0.113.7, 10.0.0.2'), '198.51.100.50');
  assert.equal(addressOf(['10.0.0.2'], '::ffff:198.51.100.50', '203.0.113.7'), '198.51.100.50');
});

test('a trusted peer is keyed on the right-most hop that is not a trusted proxy', () => {
  assert.equal(addressOf(['10.0.0.2'], '10.0.0.2', '192.0.2.1, 203.0.113.7'), '203.0.113.7');
  assert.equal(addressOf(['10.0.0.2'], '::ffff:10.0.0.2', '203.0.113.7'), '203.0.113.7', 'an IPv4-mapped peer matches its IPv4 entry');
  assert.equal(addressOf(['10.0.0.2'], '10.0.0.2', '::FFFF:203.0.113.7'), '203.0.113.7');
  assert.equal(addressOf(['10.0.0.2'], '10.0.0.2', '2001:DB8:0:0::1'), '2001:db8::1');
  assert.equal(addressOf(['10.0.0.2'], '10.0.0.2'), '10.0.0.2', 'without the header the proxy is the client');
  assert.equal(addressOf(['10.0.0.2'], '10.0.0.2', '203.0.113.7, not-an-address'), 'not-an-address', 'a malformed hop is untrusted and ends the walk');
});

test('a chain of trusted proxies is walked to the first untrusted hop', () => {
  const chain = ['10.0.0.0/8', '2001:db8:ffff::/48', '192.0.2.10'];
  assert.equal(addressOf(chain, '10.1.2.3', '192.0.2.200, 203.0.113.7, 2001:db8:ffff::5, 192.0.2.10, 10.9.9.9'), '203.0.113.7');
  assert.equal(addressOf(chain, '2001:db8:ffff::1', '198.51.100.9, ::ffff:10.0.0.4'), '198.51.100.9');
  assert.equal(addressOf(chain, '10.1.2.3', '10.0.0.5, 192.0.2.10'), '10.0.0.5', 'when every hop is trusted the left-most one is the client');
});

test('TRUSTED_PROXIES accepts only IP addresses and CIDR ranges', () => {
  for (const entry of ['proxy.example', '10.0.0.0/33', '2001:db8::/129', '10.0.0.0/8/1', '10.0.0.0/', '256.0.0.1']) {
    assert.throws(() => addressOf([entry], '10.0.0.2'), /TRUSTED_PROXIES/, entry);
  }
});

test('failed sign-ins from one client behind a trusted proxy leave other clients able to sign in', pg, async t => {
  const { db } = await testDatabase(t), password = 'proxy fixture password 2026';
  await db.$client.query('INSERT INTO users VALUES ($1, $2, $3, $4)', ['member', 'Member', 'member@example.test', await hashPassword(password)]);
  const auth = createAuth(db, { sessionSecret: secret, appUrl: 'https://campaign.example', trustedProxies: ['10.0.0.2'] }), viaProxy = client => request('10.0.0.2', client);
  for (let attempt = 0; attempt < signInLimits.client; attempt++) {
    await assert.rejects(auth.login(viaProxy('203.0.113.7'), response(), { email: `guess-${attempt}@example.test`, password: 'wrong password guess' }), error => error.status === 401);
  }
  await assert.rejects(auth.login(viaProxy('203.0.113.7'), response(), { email: 'member@example.test', password }), error => error.status === 429);
  const user = await auth.login(viaProxy('198.51.100.9'), response(), { email: 'member@example.test', password });
  assert.equal(user?.id, 'member', 'A different client behind the same proxy can still sign in.');

  // An untrusted peer cannot leave its own limit by varying X-Forwarded-For.
  for (let attempt = 0; attempt < signInLimits.client; attempt++) {
    await assert.rejects(auth.login(request('198.51.100.50', `192.0.2.${attempt}`), response(), { email: `other-${attempt}@example.test`, password: 'wrong password guess' }), error => error.status === 401);
  }
  await assert.rejects(auth.login(request('198.51.100.50', '192.0.2.200'), response(), { email: 'other-final@example.test', password: 'wrong password guess' }), error => error.status === 429);
});

test('the per-account sign-in limit trips across client addresses, and one client alone cannot reach it', pg, async t => {
  const { db } = await testDatabase(t), password = 'account fixture password 2026';
  await db.$client.query('INSERT INTO users VALUES ($1, $2, $3, $4)', ['member', 'Member', 'member@example.test', await hashPassword(password)]);
  const auth = createAuth(db, { sessionSecret: secret, appUrl: 'https://campaign.example', trustedProxies: ['10.0.0.2'] }), viaProxy = client => request('10.0.0.2', client);
  const wrong = { email: 'Member@Example.test', password: 'wrong password guess' }, failed = async (client, status) => assert.rejects(auth.login(viaProxy(client), response(), wrong), error => error.status === status);
  // One client stops at its per-account limit; the account stays open to everyone else.
  for (let attempt = 0; attempt < signInLimits.clientAccount; attempt++) await failed('203.0.113.7', 401);
  await failed('203.0.113.7', 429);
  assert.equal((await auth.login(viaProxy('198.51.100.9'), response(), { email: 'member@example.test', password }))?.id, 'member');
  // The successful sign-in counted too; failures spread over many clients reach the account-wide limit, keyed on the lowercased email.
  for (let attempt = signInLimits.clientAccount + 1; attempt < signInLimits.account; attempt++) await failed(`192.0.2.${attempt}`, 401);
  await failed('192.0.2.250', 429);
  await assert.rejects(auth.login(viaProxy('198.51.100.10'), response(), { email: 'member@example.test', password }), error => error.status === 429);
  await assert.rejects(auth.login(viaProxy('198.51.100.10'), response(), { email: 'someone-else@example.test', password }), error => error.status === 401, 'other accounts are unaffected');
});
