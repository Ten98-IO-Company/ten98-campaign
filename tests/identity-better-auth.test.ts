import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, scrypt } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestContext } from 'node:test';
import { lockWaiters, postgresSkip, testApp } from './postgres.mjs';
import { hashPassword } from '../server/auth.ts';
import { addMemberships, addUsers } from './fixtures/accounts.ts';

// Campaign identity on Better Auth (@ten98/runtime/auth, ten98-code-system#97): every path that creates or changes a
// local password leaves an account that signs in through Better Auth, and refuses a wrong password.
const pg = { skip: postgresSkip }, origin = 'http://127.0.0.1:3018';
const cli = fileURLToPath(new URL('../server/cli.ts', import.meta.url));
const betterAuthHash = /^[0-9a-f]{32}:[0-9a-f]{128}$/;
// Asynchronous, so the in-process server keeps answering while the CLI runs.
function runCli(url: string, command: string, input: unknown): Promise<{ status: number | null; output: string }> {
  const preloads = process.execArgv.flatMap((value: string, index: number, values: string[]) => value === '--import' ? [value, values[index + 1]] : []);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...preloads, cli, command], { env: { DATABASE_URL: url }, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', (chunk: Buffer) => { output += chunk; }); child.stderr.on('data', (chunk: Buffer) => { output += chunk; });
    child.on('error', reject); child.on('close', status => resolve({ status, output }));
    child.stdin.end(JSON.stringify(input));
  });
}
type Reply = { status: number; data: any; cookie: string };
async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-identity-')); t.after(() => rm(dataDir, { recursive: true, force: true }));
  const app = await testApp(t, { dataDir, env: {}, appUrl: origin, directScheduler: false });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', () => resolve()));
  const request = async (path: string, { body, cookie, method = body ? 'POST' : 'GET' }: { body?: unknown; cookie?: string; method?: string } = {}): Promise<Reply> => {
    const response = await fetch(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/api${path}`, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), cookie: response.headers.getSetCookie().filter(value => /\.session_token=[^;]/.test(value)).map(value => value.split(';')[0]).join('; ') };
  };
  const signIn = (email: string, password: string) => request('/auth/login', { body: { email, password } });
  const stored = async (email: string): Promise<string> => (await app.database.pool.query("SELECT a.password FROM accounts a JOIN users u ON u.id = a.user_id WHERE u.email = $1 AND a.provider_id = 'credential'", [email])).rows[0]?.password ?? '';
  return { app, request, signIn, stored };
}

test('setup, invitation acceptance and CLI create-user and reset-password accounts sign in through Better Auth and refuse a wrong password', pg, async t => {
  const { app, request, signIn, stored } = await fixture(t);
  const setup = await request('/auth/setup', { body: { name: 'Owner', email: 'owner@example.test', password: 'owner identity fixture password' } });
  assert.equal(setup.status, 201); assert.ok(setup.cookie, 'The first sign-up is signed in.');
  assert.equal((await request('/session', { cookie: setup.cookie })).data.user.email, 'owner@example.test');
  assert.match(await stored('owner@example.test'), betterAuthHash);
  assert.equal((await signIn('owner@example.test', 'owner identity fixture password')).status, 200);
  assert.equal((await signIn('owner@example.test', 'not the owner password')).status, 401);

  const workspaceId = (await request('/state', { cookie: setup.cookie })).data.workspaces[0].id;
  const invited = await request(`/workspaces/${workspaceId}/invitations`, { body: { email: 'invitee@example.test', role: 'editor' }, cookie: setup.cookie });
  const token = new URL(invited.data.url).hash.slice('#invite='.length);
  const accepted = await request('/invitations/accept', { body: { token, name: 'Invitee', password: 'invitee identity fixture password' } });
  assert.equal(accepted.status, 200); assert.equal(accepted.data.created, true); assert.ok(accepted.cookie, 'A new invited account is signed in after its transaction commits.');
  assert.equal((await request('/session', { cookie: accepted.cookie })).data.user.email, 'invitee@example.test');
  assert.match(await stored('invitee@example.test'), betterAuthHash);
  assert.equal((await signIn('invitee@example.test', 'invitee identity fixture password')).status, 200);
  assert.equal((await signIn('invitee@example.test', 'not the invitee password')).status, 401);

  const created = await runCli(app.database.url, 'create-user', { name: 'Host user', email: 'host@example.test', password: 'host identity fixture password' });
  assert.equal(created.status, 0, created.output); assert.match(await stored('host@example.test'), betterAuthHash);
  const host = await signIn('host@example.test', 'host identity fixture password');
  assert.equal(host.status, 200); assert.equal((await signIn('host@example.test', 'not the host password')).status, 401);

  const reset = await runCli(app.database.url, 'reset-password', { email: 'host@example.test', password: 'replacement host fixture password' });
  assert.equal(reset.status, 0, reset.output); assert.equal(reset.output.includes('replacement host fixture password'), false);
  assert.equal((await request('/session', { cookie: host.cookie })).data.user, null, 'The CLI reset ended the old session.');
  assert.equal((await signIn('host@example.test', 'host identity fixture password')).status, 401);
  assert.equal((await signIn('host@example.test', 'replacement host fixture password')).status, 200);
});

test('a password stored before the move signs in once with it and is rehashed by Better Auth', pg, async t => {
  const { app, request, signIn, stored } = await fixture(t);
  assert.equal((await request('/auth/setup', { body: { name: 'Owner', email: 'owner@example.test', password: 'owner identity fixture password' } })).status, 201);
  // Campaign's pre-move format: scrypt$<32 hex salt, used as text>$<64-byte key in hex>, N=65536.
  const password = 'legacy member fixture password', salt = randomBytes(16).toString('hex');
  const key = await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 65536, maxmem: 128 * 1024 * 1024 }, (error, value) => error ? reject(error) : resolve(value)));
  const legacy = `scrypt$${salt}$${key.toString('hex')}`;
  const [{ id: workspaceId }] = (await app.database.pool.query('SELECT id FROM workspaces')).rows;
  await addUsers(app.database.pool, [{ id: 'legacy-member', name: 'Legacy', email: 'legacy@example.test', password: legacy }]);
  await addMemberships(app.database.pool, [[workspaceId, 'legacy-member', 'editor']]);
  assert.equal((await signIn('legacy@example.test', 'not the legacy password')).status, 401);
  assert.equal(await stored('legacy@example.test'), legacy, 'A failed sign-in leaves the legacy hash.');
  const signedIn = await signIn('legacy@example.test', password);
  assert.equal(signedIn.status, 200); assert.equal(signedIn.data.user.id, 'legacy-member');
  const upgraded = await stored('legacy@example.test');
  assert.notEqual(upgraded, legacy); assert.match(upgraded, betterAuthHash, 'The first successful sign-in replaced the legacy hash.');
  assert.equal((await signIn('legacy@example.test', password)).status, 200);
  assert.equal((await signIn('legacy@example.test', 'not the legacy password')).status, 401);
  // A password change from the upgraded account writes Better Auth's format too.
  assert.equal((await request('/account/password', { body: { currentPassword: password, newPassword: 'changed legacy member password' }, cookie: signedIn.cookie })).status, 200);
  assert.match(await stored('legacy@example.test'), betterAuthHash); assert.equal((await signIn('legacy@example.test', 'changed legacy member password')).status, 200);
});

test('a failure inside invitation acceptance leaves neither an account nor a membership, and the invitation stays usable', pg, async t => {
  const { app, request, signIn } = await fixture(t), { pool } = app.database;
  const setup = await request('/auth/setup', { body: { name: 'Owner', email: 'owner@example.test', password: 'owner identity fixture password' } });
  const workspaceId = (await request('/state', { cookie: setup.cookie })).data.workspaces[0].id;
  const invited = await request(`/workspaces/${workspaceId}/invitations`, { body: { email: 'invitee@example.test', role: 'viewer' }, cookie: setup.cookie });
  const token = new URL(invited.data.url).hash.slice('#invite='.length), signup = { token, name: 'Invitee', password: 'invitee identity fixture password' };
  await pool.query("CREATE FUNCTION fail_join() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic join failure'; END $$");
  await pool.query('CREATE TRIGGER fail_join BEFORE INSERT ON memberships FOR EACH ROW EXECUTE FUNCTION fail_join()');
  const failed = await request('/invitations/accept', { body: signup });
  assert.equal(failed.status, 500); assert.equal(failed.cookie, '', 'No session is issued for a failed acceptance.');
  assert.equal((await pool.query("SELECT id FROM users WHERE email = 'invitee@example.test'")).rowCount, 0, 'No account was created.');
  assert.equal((await pool.query("SELECT a.id FROM accounts a LEFT JOIN users u ON u.id = a.user_id WHERE u.id IS NULL OR u.email = 'invitee@example.test'")).rowCount, 0, 'No credential was left behind.');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM memberships WHERE workspace_id = $1', [workspaceId])).rows[0].n, 1, 'Only the owner belongs to the workspace.');
  assert.equal((await pool.query("SELECT accepted_at FROM workspace_invitations WHERE email = 'invitee@example.test'")).rows[0].accepted_at, null);
  await pool.query('DROP TRIGGER fail_join ON memberships; DROP FUNCTION fail_join()');
  const accepted = await request('/invitations/accept', { body: signup });
  assert.equal(accepted.status, 200); assert.equal(accepted.data.role, 'viewer'); assert.ok(accepted.cookie);
  assert.equal((await signIn('invitee@example.test', 'invitee identity fixture password')).status, 200);
});

test('a session token is never stored as the raw cookie token', pg, async t => {
  const { app, request } = await fixture(t);
  const setup = await request('/auth/setup', { body: { name: 'Owner', email: 'owner@example.test', password: 'owner identity fixture password' } });
  const raw = decodeURIComponent(setup.cookie.split('=')[1]).split('.')[0];
  assert.equal((await app.database.pool.query('SELECT count(*)::int AS n FROM sessions')).rows[0].n, 1);
  // Expected to fail until runtime #131 (keyed-hash session tokens): Better Auth 1.7.7 stores the token itself.
  assert.equal((await app.database.pool.query('SELECT count(*)::int AS n FROM sessions WHERE token = $1', [raw])).rows[0].n, 0, 'Only a keyed hash of the session token is stored.');
});

test('a sign-in whose account is gone by the time it holds the lock is refused before Better Auth looks the email up again', pg, async t => {
  const { app, request, signIn } = await fixture(t), { pool } = app.database;
  assert.equal((await request('/auth/setup', { body: { name: 'Owner', email: 'owner@example.test', password: 'owner identity fixture password' } })).status, 201);
  await addUsers(pool, [{ id: 'leaving', name: 'Leaving', email: 'leaving@example.test', password: await hashPassword('leaving fixture password') }]);
  // Hold the sign-in at the email lock, after its pre-check passed; remove the account; then let it take the lock.
  const holder = await pool.connect();
  try {
    await holder.query('BEGIN'); await holder.query("SELECT pg_advisory_xact_lock(109859, hashtext('leaving@example.test'))");
    const pending = signIn('leaving@example.test', 'leaving fixture password');
    await lockWaiters(holder, 1);
    await pool.query("DELETE FROM users WHERE id = 'leaving'");
    await holder.query('COMMIT');
    const refused = await pending;
    assert.equal(refused.status, 401); assert.equal(refused.cookie, '');
  } finally { holder.release(); }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sessions WHERE user_id <> (SELECT id FROM users WHERE email = 'owner@example.test')")).rows[0].n, 0);
});

test('a sign-in never keeps a session for an account other than the one it locked', pg, async t => {
  const { app, request, signIn } = await fixture(t), { pool } = app.database;
  assert.equal((await request('/auth/setup', { body: { name: 'Owner', email: 'owner@example.test', password: 'owner identity fixture password' } })).status, 201);
  // The schema refuses two emails that differ only in case (users_email_lower_key), so this fixture drops that index in its
  // own database to reach the case the identity check guards: the lock takes the first row by lower(email) (the mixed-case
  // one, stored first) while Better Auth signs in the exact lower-case address. The mismatch must roll the session back.
  await pool.query('DROP INDEX users_email_lower_key');
  const hash = await hashPassword('twin fixture password');
  await addUsers(pool, [{ id: 'twin-mixed', name: 'Mixed', email: 'Twin@example.test', password: hash }, { id: 'twin-lower', name: 'Lower', email: 'twin@example.test', password: hash }]);
  const result = await signIn('twin@example.test', 'twin fixture password');
  assert.equal(result.status, 401); assert.equal(result.cookie, '');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM sessions WHERE user_id IN ('twin-mixed', 'twin-lower')")).rows[0].n, 0, 'The session Better Auth wrote was rolled back.');
});

test('two accounts can never share an email that differs only in case, and migration 0013 refuses an installation where they do', pg, async t => {
  const { app } = await fixture(t), { pool } = app.database;
  await addUsers(pool, [{ id: 'case-lower', name: 'Lower', email: 'case@example.test' }]);
  await assert.rejects(addUsers(pool, [{ id: 'case-upper', name: 'Upper', email: 'Case@Example.test' }]), (error: { code?: string; constraint?: string }) => error.code === '23505' && error.constraint === 'users_email_lower_key');
  // An installation from before the move that already has such accounts stops at 0013, before anything changes.
  const { migrationSources } = await import('../server/database.ts'), client = await pool.connect();
  try {
    await client.query('CREATE SCHEMA premove; SET search_path TO premove');
    const sources = await migrationSources();
    for (const source of sources.filter(source => source.version < '0013')) await client.query(source.sql);
    await client.query("INSERT INTO users VALUES ('a', 'A', 'twin@example.test', NULL), ('b', 'B', 'Twin@example.test', NULL)");
    await assert.rejects(client.query(sources.find(source => source.version === '0013')!.sql), /same email address in different letter case/);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM information_schema.columns WHERE table_schema = 'premove' AND table_name = 'users' AND column_name = 'password'")).rows[0].n, 1, 'Nothing changed.');
  } finally { client.release(true); }
});

test('AUTH_SECRET_FILE must name a file holding the secret; it never falls back to a generated one', async t => {
  const { authSecret } = await import('../server/auth.ts');
  const dir = await mkdtemp(join(tmpdir(), 'campaign-auth-secret-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = (name: string, value: string) => { const path = join(dir, name); writeFileSync(path, value); return path; };
  assert.throws(() => authSecret(dir, { AUTH_SECRET_FILE: file('empty', '') }), /at least 32 characters/);
  assert.throws(() => authSecret(dir, { AUTH_SECRET_FILE: file('short', 'too short\n') }), /at least 32 characters/);
  assert.equal(existsSync(join(dir, 'auth-secret')), false, 'No secret was generated in DATA_DIR.');
  assert.equal(authSecret(dir, { AUTH_SECRET_FILE: file('ok', 'a'.repeat(40) + '\n') }), 'a'.repeat(40));
  assert.throws(() => authSecret(dir, { AUTH_SECRET: 'x'.repeat(40), AUTH_SECRET_FILE: file('both', 'b'.repeat(40)) }), /not both/);
  const generated = authSecret(dir); assert.ok(generated.length >= 32); assert.equal(authSecret(dir), generated, 'The generated secret is kept.');
});

test('an SSO-only account never gains a password through a reset link', pg, async t => {
  const { app } = await fixture(t), { pool } = app.database;
  const { createAuth } = await import('../server/auth.ts');
  await addUsers(pool, [{ id: 'sso-only', name: 'SSO', email: 'sso@example.test' }]);
  const auth = createAuth(app.database.db, { appUrl: origin, sessionSecret: 'sso reset fixture session secret of 32+ chars', authSecret: 'sso reset fixture auth secret of 32+ characters', oidcIssuer: '', oidcClientId: '', oidcAllowedEmails: [] });
  const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as never;
  assert.equal(await auth.requestPasswordReset(req, 'sso@example.test'), null, 'No link is issued.');
  // A link for the account that exists anyway (written before its password was removed, say) is refused under the lock.
  await pool.query("INSERT INTO verifications (id, identifier, value, expires_at, created_at, updated_at) VALUES ('planted', 'reset-password:AAAAAAAAAAAAAAAAAAAAAAAA', 'sso-only', $1, $2, $2)", [Date.now() + 3600000, Date.now()]);
  await assert.rejects(auth.resetPassword(req, 'AAAAAAAAAAAAAAAAAAAAAAAA', 'a new sso fixture password'), (error: { status?: number }) => error.status === 400);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM accounts WHERE user_id = 'sso-only'")).rows[0].n, 0, 'No credential was created.');
});

test('the sign-in pre-check runs the legacy and the modern verifier once for unknown, legacy and modern accounts alike', async () => {
  const { verifyStoredPassword } = await import('../server/locked-auth.ts');
  const legacyHash = `scrypt$${'a'.repeat(32)}$${'b'.repeat(128)}`, modernHash = `${'c'.repeat(32)}:${'d'.repeat(128)}`;
  const cases = [[undefined, true, true, false], [null, true, true, false], [legacyHash, true, false, true], [legacyHash, false, true, false], [modernHash, false, true, true], [modernHash, true, false, false]] as const;
  for (const [stored, legacyMatches, modernMatches, expected] of cases) {
    const calls: string[] = [];
    const verifiers = {
      legacy: async (hash: string) => { calls.push('legacy:' + (hash === legacyHash ? 'stored' : 'dummy')); return legacyMatches; },
      modern: async ({ hash }: { hash: string }) => { calls.push('modern:' + (hash === modernHash ? 'stored' : 'dummy')); return modernMatches; },
    };
    assert.equal(await verifyStoredPassword(stored, 'fixture password', verifiers), expected, String(stored));
    assert.deepEqual(calls.map(call => call.split(':')[0]).sort(), ['legacy', 'modern'], 'Both derives run, whatever is stored.');
    if (!stored) assert.deepEqual(calls.sort(), ['legacy:dummy', 'modern:dummy'], 'With no account both run on dummy hashes, and sign-in never succeeds.');
  }
});
