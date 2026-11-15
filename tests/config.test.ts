import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { configuredSessionSecret, databaseUrl, deploymentConfig, listenAddress } from '../server/config.ts';

type Env = Record<string, string | undefined>;

// The expressions server/index.ts, server/cli.ts and server/database.ts used before @ten98/runtime/config, copied
// verbatim: every deployment setting must keep the value and default it had.
function legacy(env: Env, options: { dataDir?: string; appUrl?: string } = {}) {
  const dataDir = resolve(options.dataDir || env.DATA_DIR || 'data');
  const appUrl = (options.appUrl || env.APP_URL || 'http://127.0.0.1:3018').replace(/\/$/, '');
  const parsed = new URL(appUrl);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== appUrl || parsed.username || parsed.password || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error('APP_URL must be an HTTPS origin, or HTTP loopback for local use.');
  const directScheduler = env.DIRECT_SCHEDULER || 'on';
  if (!['on', 'off'].includes(directScheduler)) throw new Error('DIRECT_SCHEDULER must be on or off.');
  return {
    dataDir, appUrl, directScheduler, databaseUrl: env.DATABASE_URL,
    oidcIssuer: env.OIDC_ISSUER || '', oidcClientId: env.OIDC_CLIENT_ID || '', oidcClientSecret: env.OIDC_CLIENT_SECRET || '',
    oidcAllowedEmails: (env.OIDC_ALLOWED_EMAILS || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
    trustedProxies: env.TRUSTED_PROXIES || '',
  };
}
const outcome = (run: () => unknown) => { try { return { value: run() }; } catch (error) { return { error: (error as Error).message }; } };

test('every deployment setting keeps its value and default: unset, empty, padded and set', () => {
  const values: Record<string, (string | undefined)[]> = {
    DATA_DIR: [undefined, '', 'state', ' padded '],
    APP_URL: [undefined, '', 'https://campaign.example.com', 'https://campaign.example.com/', 'http://localhost:3018', 'http://campaign.example.com', 'ftp://x', ' https://campaign.example.com'],
    DIRECT_SCHEDULER: [undefined, '', 'on', 'off', 'of', ' on'],
    DATABASE_URL: [undefined, '', 'postgres://campaign@127.0.0.1/campaign', ' postgres://padded '],
    OIDC_ISSUER: [undefined, '', 'https://id.example.com', ' padded '],
    OIDC_CLIENT_ID: [undefined, '', 'campaign'],
    OIDC_CLIENT_SECRET: [undefined, '', 'client-secret', ' padded '],
    OIDC_ALLOWED_EMAILS: [undefined, '', 'A@Example.com, b@example.com ,,', ' '],
    TRUSTED_PROXIES: [undefined, '', '10.0.0.0/8,fd00::/8', ' 172.17.0.1 '],
  };
  let compared = 0;
  for (const [name, cases] of Object.entries(values)) for (const value of cases) {
    const env: Env = { [name]: value };
    assert.deepEqual(outcome(() => deploymentConfig(env)), outcome(() => legacy(env)), `${name}=${JSON.stringify(value)}`);
    compared++;
  }
  // Options passed to createApp still win over the environment, and the environment value is then not read.
  const env = { DATA_DIR: 'from-env', APP_URL: 'https://env.example.com', DATA_DIR_FILE: '/missing', APP_URL_FILE: '/missing' };
  assert.deepEqual(deploymentConfig(env, { dataDir: 'option', appUrl: 'https://option.example.com/' }), { ...legacy({}, { dataDir: 'option', appUrl: 'https://option.example.com/' }) });
  assert.ok(compared > 30);
});

test('listen address and DATABASE_URL keep their defaults', () => {
  for (const [PORT, HOST] of [[undefined, undefined], ['', ''], ['4000', '0.0.0.0'], ['not-a-port', ' ::1 ']]) {
    assert.deepEqual(listenAddress({ PORT, HOST }), { port: Number(PORT || 3018), host: HOST || '127.0.0.1' });
  }
  assert.equal(databaseUrl({}), undefined);
  assert.equal(databaseUrl({ DATABASE_URL: 'postgres://x' }), 'postgres://x');
});

test('SESSION_SECRET stays optional, and when set needs 32 characters through readSecret', () => {
  assert.equal(configuredSessionSecret({}), undefined, 'Unset falls back to the generated DATA_DIR/session-secret.');
  assert.equal(configuredSessionSecret({ SESSION_SECRET: '' }), undefined, 'Empty, as a copied `SESSION_SECRET=` line gives, also falls back.');
  const secret = 's'.repeat(32);
  assert.equal(configuredSessionSecret({ SESSION_SECRET: secret }), secret);
  assert.throws(() => configuredSessionSecret({ SESSION_SECRET: 's'.repeat(31) }), (error: any) => error.code === 'CONFIG_INVALID' && /SESSION_SECRET must contain at least 32 characters/.test(error.message) && !error.message.includes('sss'));
});

test('each deployment setting also reads NAME_FILE, and refuses NAME with NAME_FILE', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ten98-config-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = async (name: string, content: string) => { const path = join(dir, name); await writeFile(path, content); return path; };
  const secret = 'f'.repeat(40);
  const env: Env = {
    APP_URL_FILE: await file('app-url', 'https://files.example.com\n'),
    DATABASE_URL_FILE: await file('database-url', 'postgres://campaign@db/campaign\n'),
    OIDC_CLIENT_SECRET_FILE: await file('oidc', '  oidc-secret \n'),
    SESSION_SECRET_FILE: await file('session-secret', secret + '\n'),
    PORT_FILE: await file('port', '4100'),
  };
  const config = deploymentConfig(env);
  assert.deepEqual([config.appUrl, config.databaseUrl, config.oidcClientSecret], ['https://files.example.com', 'postgres://campaign@db/campaign', 'oidc-secret']);
  assert.equal(configuredSessionSecret(env), secret, 'SESSION_SECRET_FILE can name DATA_DIR/session-secret or a Compose secret.');
  assert.equal(listenAddress(env).port, 4100);
  assert.equal(databaseUrl(env), 'postgres://campaign@db/campaign');
  assert.throws(() => deploymentConfig({ ...env, APP_URL: 'https://campaign.example.com' }), (error: any) => error.code === 'CONFIG_INVALID' && error.message === 'Set only APP_URL or APP_URL_FILE');
  assert.throws(() => deploymentConfig({ OIDC_CLIENT_SECRET_FILE: join(dir, 'missing') }), (error: any) => error.code === 'CONFIG_INVALID' && !error.message.includes(dir));
});
