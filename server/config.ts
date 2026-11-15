// Campaign's deployment settings, read through @ten98/runtime/config: each takes NAME, or the trimmed contents of the file
// NAME_FILE names (a Compose secret), never both. Values and defaults are the ones Campaign always had.
// Provider credentials are not read here: integration-settings.ts overlays saved values onto the same env object at run
// time, and each provider reads its own fields from it.
import { resolve } from 'node:path';
import { readEnvironment, readSecret } from '@ten98/runtime/config';

type Env = Readonly<Record<string, string | undefined>>;

export function deploymentConfig(env: Env, overrides: { dataDir?: string; appUrl?: string } = {}) {
  const read = (name: string) => readEnvironment(name, env);
  const dataDir = resolve(overrides.dataDir || read('DATA_DIR') || 'data');
  const appUrl = (overrides.appUrl || read('APP_URL') || 'http://127.0.0.1:3018').replace(/\/$/, '');
  const parsed = new URL(appUrl);
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.origin !== appUrl || parsed.username || parsed.password || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error('APP_URL must be an HTTPS origin, or HTTP loopback for local use.');
  // DIRECT_SCHEDULER=off starts the app without sending due direct campaigns (for example to verify an upgrade before
  // switching traffic). Unset or empty (as a copied `DIRECT_SCHEDULER=` line gives) means on; any other value than on/off
  // refuses to start, so a typo cannot leave sending enabled.
  const directScheduler = read('DIRECT_SCHEDULER') || 'on';
  if (!['on', 'off'].includes(directScheduler)) throw new Error('DIRECT_SCHEDULER must be on or off.');
  return {
    dataDir, appUrl, directScheduler, databaseUrl: read('DATABASE_URL'),
    oidcIssuer: read('OIDC_ISSUER') || '', oidcClientId: read('OIDC_CLIENT_ID') || '', oidcClientSecret: read('OIDC_CLIENT_SECRET') || '',
    oidcAllowedEmails: (read('OIDC_ALLOWED_EMAILS') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean),
    trustedProxies: read('TRUSTED_PROXIES') || '',
  };
}

/** SESSION_SECRET is optional (a generated one is kept in DATA_DIR); a configured one needs 32 characters. */
export const configuredSessionSecret = (env: Env): string | undefined => readEnvironment('SESSION_SECRET', env) ? readSecret('SESSION_SECRET', { env }) : undefined;
export const databaseUrl = (env: Env = process.env) => readEnvironment('DATABASE_URL', env);
export const listenAddress = (env: Env = process.env) => ({ port: Number(readEnvironment('PORT', env) || 3018), host: readEnvironment('HOST', env) || '127.0.0.1' });
