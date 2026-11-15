import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, scrypt } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
  const stored = async (email: string): Promise<string> => (await app.database.pool.query("SELECT a.password FROM account a JOIN \"user\" u ON u.id = a.\"userId\" WHERE u.email = $1 AND a.\"providerId\" = 'credential'", [email])).rows[0]?.password ?? '';
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
  assert.equal((await pool.query("SELECT id FROM \"user\" WHERE email = 'invitee@example.test'")).rowCount, 0, 'No account was created.');
  assert.equal((await pool.query("SELECT a.id FROM account a LEFT JOIN \"user\" u ON u.id = a.\"userId\" WHERE u.id IS NULL OR u.email = 'invitee@example.test'")).rowCount, 0, 'No credential was left behind.');
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
  assert.equal((await app.database.pool.query('SELECT count(*)::int AS n FROM session')).rows[0].n, 1);
  // Expected to fail until runtime #131 (keyed-hash session tokens): Better Auth 1.7.7 stores the token itself.
  assert.equal((await app.database.pool.query('SELECT count(*)::int AS n FROM session WHERE token = $1', [raw])).rows[0].n, 0, 'Only a keyed hash of the session token is stored.');
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
    await pool.query("DELETE FROM \"user\" WHERE id = 'leaving'");
    await holder.query('COMMIT');
    const refused = await pending;
    assert.equal(refused.status, 401); assert.equal(refused.cookie, '');
  } finally { holder.release(); }
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM session WHERE \"userId\" <> (SELECT id FROM \"user\" WHERE email = 'owner@example.test')")).rows[0].n, 0);
});

test('a sign-in never keeps a session for an account other than the one it locked', pg, async t => {
  const { app, request, signIn } = await fixture(t), { pool } = app.database;
  assert.equal((await request('/auth/setup', { body: { name: 'Owner', email: 'owner@example.test', password: 'owner identity fixture password' } })).status, 201);
  // The schema refuses two emails that differ only in case (user_email_lowercase, user_email_normalized_idx), so this fixture
  // drops both in its own database to reach the case the identity check guards: the lock takes the first row by
  // lower(email) (the mixed-case one, stored first) while Better Auth signs in the exact lower-case address. The mismatch
  // must roll the session back.
  await pool.query('ALTER TABLE "user" DROP CONSTRAINT user_email_lowercase; DROP INDEX user_email_normalized_idx');
  const hash = await hashPassword('twin fixture password');
  await addUsers(pool, [{ id: 'twin-mixed', name: 'Mixed', email: 'Twin@example.test', password: hash }, { id: 'twin-lower', name: 'Lower', email: 'twin@example.test', password: hash }]);
  const result = await signIn('twin@example.test', 'twin fixture password');
  assert.equal(result.status, 401); assert.equal(result.cookie, '');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM session WHERE \"userId\" IN ('twin-mixed', 'twin-lower')")).rows[0].n, 0, 'The session Better Auth wrote was rolled back.');
});

test('emails are stored lower-case and unique ignoring case, and the preset finds its email index', pg, async t => {
  const { app } = await fixture(t), { pool } = app.database;
  await addUsers(pool, [{ id: 'case-lower', name: 'Lower', email: 'case@example.test' }]);
  await assert.rejects(addUsers(pool, [{ id: 'case-upper', name: 'Upper', email: 'Case@Example.test' }]), (error: { code?: string; constraint?: string }) => error.code === '23514' && error.constraint === 'user_email_lowercase');
  await assert.rejects(addUsers(pool, [{ id: 'case-again', name: 'Again', email: 'case@example.test' }]), (error: { code?: string }) => error.code === '23505');
  // The definition the preset's assertEmailIndex (code-system e428dce src/auth.mts:740) requires on "user".
  const { rows: [index] } = await pool.query(`SELECT EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = to_regclass('"user"') AND i.indisunique AND i.indisvalid AND i.indpred IS NULL AND i.indnatts = 1 AND pg_get_expr(i.indexprs, i.indrelid) = 'lower(email)') AS indexed`);
  assert.equal(index.indexed, true);
});

// A database at 0012, as an installation from before the move, seeded with `seed` and then migrated by the ledger.
async function premove(t: TestContext, seed: string) {
  const { testDatabase } = await import('./postgres.mjs'), { migrate, migrationSources } = await import('../server/database.ts');
  const database = await testDatabase(t), { pool } = database, sources = await migrationSources();
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const source of sources.filter(source => source.version < '0013')) await pool.query(source.sql);
  await pool.query('CREATE TABLE schema_version (version text PRIMARY KEY, checksum text NOT NULL)');
  for (const source of sources.filter(source => source.version < '0013')) await pool.query('INSERT INTO schema_version VALUES ($1, $2)', [source.version, source.checksum]);
  await pool.query(seed);
  return { database, migrate: () => migrate(pool) };
}
const legacyHash = async (password: string) => {
  const salt = randomBytes(16).toString('hex');
  const key = await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, { N: 65536, maxmem: 128 * 1024 * 1024 }, (error, value) => error ? reject(error) : resolve(value)));
  return `scrypt$${salt}$${key.toString('hex')}`;
};
const exists = async (pool: { query(text: string): Promise<{ rows: { name: string | null }[] }> }, name: string) => (await pool.query(`SELECT to_regclass('${name}')::text AS name`)).rows[0].name !== null;

test('migration 0013 stops on accounts whose email differs only in case, lists their ids, and changes nothing', pg, async t => {
  const { database, migrate } = await premove(t, "INSERT INTO users VALUES ('a1', 'A', 'twin@example.test', NULL), ('a2', 'B', 'Twin@Example.test', NULL), ('b1', 'C', 'pair@example.test', NULL), ('b2', 'D', 'PAIR@example.test', NULL), ('solo', 'E', 'Solo@Example.test', NULL)");
  await assert.rejects(migrate(), (error: Error) => error.message === 'user_email_lowercase: 2 email address(es) belong to more than one user when case is ignored (accounts: [a1, a2], [b1, b2]); resolve them before this migration');
  const { pool } = database;
  assert.equal(await exists(pool, 'users'), true); assert.equal(await exists(pool, '"user"'), false); assert.equal(await exists(pool, 'sessions'), true);
  assert.deepEqual((await pool.query('SELECT id, email, password FROM users ORDER BY id')).rows.map(row => row.email), ['twin@example.test', 'Twin@Example.test', 'pair@example.test', 'PAIR@example.test', 'Solo@Example.test'], 'No email was rewritten.');
  assert.equal((await pool.query("SELECT max(version) AS v FROM schema_version")).rows[0].v, '0012');
});

test('after 0013 a pre-move account with a mixed-case email and an old password signs in, its hash is upgraded exactly once, and an OIDC account counts as verified', pg, async t => {
  const password = 'pre-move member fixture password';
  const { database, migrate } = await premove(t, `INSERT INTO installation VALUES (1, true) ON CONFLICT (id) DO UPDATE SET claimed = true; INSERT INTO users VALUES ('mixed', 'Mixed', 'Mixed.Case@Example.test', '${await legacyHash(password)}'), ('sso', 'SSO', 'sso@example.test', NULL); INSERT INTO oidc_identities VALUES ('https://auth.example/application/o/campaign/', 'subject-1', 'sso'); INSERT INTO sessions VALUES ('old-session', 'mixed', 9999999999999); INSERT INTO password_resets VALUES ('old-reset', 'mixed', 9999999999999, 0)`);
  await migrate();
  const { pool, db } = database;
  assert.deepEqual((await pool.query('SELECT id, email, "emailVerified" FROM "user" ORDER BY id')).rows, [{ id: 'mixed', email: 'mixed.case@example.test', emailVerified: false }, { id: 'sso', email: 'sso@example.test', emailVerified: true }]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM session')).rows[0].n, 0, 'Every session ends at the move.');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM verification')).rows[0].n, 0, 'Pending reset links end at the move.');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM "twoFactor"')).rows[0].n, 0, 'Campaign had no second factors before 0013.');
  const { createApp } = await import('../server/index.ts'), dataDir = await mkdtemp(join(tmpdir(), 'campaign-premove-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const app = await createApp({ dataDir, env: {}, appUrl: origin, directScheduler: false, database: { pool, db } });
  t.after(() => app.close());
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', () => resolve()));
  const signIn = async (email: string) => (await fetch(`http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/auth/login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).status;
  const stored = async () => (await pool.query("SELECT password, \"updatedAt\" FROM account WHERE \"userId\" = 'mixed' AND \"providerId\" = 'credential'")).rows[0];
  assert.match((await stored()).password, /^scrypt\$/, 'The old hash arrived unchanged.');
  assert.equal(await signIn('Mixed.Case@Example.test'), 200, 'The address as typed before still signs in.');
  const upgraded = await stored();
  assert.match(upgraded.password, betterAuthHash, 'The first sign-in replaced the legacy hash.');
  assert.equal(await signIn('mixed.case@example.test'), 200);
  assert.deepEqual(await stored(), upgraded, 'The second sign-in did not rehash it again.');
});

test('migration 0013 can be reversed in development and applied again to the same schema', pg, async t => {
  const { database, migrate } = await premove(t, "INSERT INTO users VALUES ('local', 'Local', 'local@example.test', 'scrypt$fixture')");
  const { pool } = database;
  const shape = async () => ({
    columns: (await pool.query("SELECT table_name, column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'public' ORDER BY table_name, ordinal_position")).rows,
    constraints: (await pool.query("SELECT conrelid::regclass::text AS table_name, conname, contype, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY 1, 2")).rows,
    indexes: (await pool.query("SELECT tablename, indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1, 2")).rows,
  });
  const before = await shape();
  assert.deepEqual(await migrate(), ['0013']); const applied = await shape();
  await pool.query(await readFile(new URL('../migrations/dev/0013_better_auth.down.sql', import.meta.url), 'utf8'));
  assert.deepEqual(await shape(), before, 'The reverse restores the pre-move schema.');
  assert.deepEqual((await pool.query("SELECT id, email, password FROM users")).rows, [{ id: 'local', email: 'local@example.test', password: 'scrypt$fixture' }]);
  assert.deepEqual(await migrate(), ['0013']); assert.deepEqual(await shape(), applied, 'Applied again, the schema is the same.');
  assert.deepEqual(await migrate(), [], 'The ledger never applies it twice.');
});

test('identity times keep their UTC instant whatever the database session time zone, and expiry is compared as an instant', pg, async t => {
  const { app, request } = await fixture(t), { pool } = app.database;
  const setup = await request('/auth/setup', { body: { name: 'Owner', email: 'owner@example.test', password: 'owner identity fixture password' } });
  const instant = new Date('2026-11-15T23:30:00.123Z'), client = await pool.connect();
  try {
    await client.query("SET TIME ZONE 'Pacific/Kiritimati'");
    const { drizzle } = await import('drizzle-orm/node-postgres'), schema = await import('../server/schema.ts');
    const db = drizzle(client, { schema });
    await db.update(schema.sessions).set({ updatedAt: instant });
    const [row] = await db.select({ updatedAt: schema.sessions.updatedAt }).from(schema.sessions);
    assert.equal(row.updatedAt.getTime(), instant.getTime());
    assert.equal((await client.query('SELECT "updatedAt" FROM session')).rows[0].updatedAt.toISOString(), instant.toISOString());
  } finally { client.release(true); }
  // A session an hour from expiry is accepted, and once it has just expired it is refused (Better Auth then deletes it).
  await pool.query(`UPDATE session SET "expiresAt" = now() + interval '1 hour'`);
  assert.equal((await request('/session', { cookie: setup.cookie })).data.user.email, 'owner@example.test');
  await pool.query(`UPDATE session SET "expiresAt" = now() - interval '1 second'`);
  assert.equal((await request('/session', { cookie: setup.cookie })).data.user, null);
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
  await pool.query("INSERT INTO verification (id, identifier, value, \"expiresAt\") VALUES ('planted', 'reset-password:AAAAAAAAAAAAAAAAAAAAAAAA', 'sso-only', now() + interval '1 hour')");
  await assert.rejects(auth.resetPassword(req, 'AAAAAAAAAAAAAAAAAAAAAAAA', 'a new sso fixture password'), (error: { status?: number }) => error.status === 400);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM account WHERE \"userId\" = 'sso-only'")).rows[0].n, 0, 'No credential was created.');
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
