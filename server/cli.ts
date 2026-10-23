import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { assertSchema, closeDatabase, getDatabase, migrate, type Database } from './database.ts';
import { hashPassword, lockUser } from './auth.ts';
import { setInstanceOperator } from './instance-operators.ts';

class CliError extends Error {}
const usage = 'Usage: node server/cli.ts migrate, or pipe JSON account input to create-user, reset-password, or {email} to grant-operator or revoke-operator.';

// Read JSON from stdin so passwords never appear in process arguments or output.
async function account(command: string, db: Database) {
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (Buffer.byteLength(raw) > 8192) throw new CliError('Account input is too large.'); }
  let input; try { input = JSON.parse(raw); } catch { throw new CliError('Supply valid JSON account input.'); }
  const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CliError('Supply a valid email address.');
  if (!(await db.execute(sql`SELECT id FROM users LIMIT 1`)).rowCount) throw new CliError('Complete first-run setup in the app before provisioning other users.');
  const existing = (await db.execute(sql`SELECT id FROM users WHERE email = ${email}`)).rows[0] as { id: string } | undefined;
  if (command === 'grant-operator' || command === 'revoke-operator') {
    if (!existing) throw new CliError('The account does not exist. Create it first.');
    const enabled = command === 'grant-operator', changed = await db.transaction(tx => setInstanceOperator(tx, existing.id, enabled, 'host'));
    console.log(changed ? `${enabled ? 'Granted' : 'Revoked'} instance operator authority ${enabled ? 'to' : 'from'} ${email}. Workspace membership is still required.` : `Instance operator authority for ${email} is already ${enabled ? 'granted' : 'revoked'}.`);
  } else if (command === 'reset-password') {
    if (!existing || !(await db.execute(sql`SELECT password FROM users WHERE id = ${existing.id}`)).rows[0]?.password) throw new CliError('A local password account was not found. Use your identity provider for SSO recovery.');
    if (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 128) throw new CliError('Use a password between 12 and 128 characters.');
    const next = await hashPassword(input.password);
    // The user row lock orders the reset against a sign-in or password change running in the app.
    await db.transaction(async tx => { await lockUser(tx, existing.id); await tx.execute(sql`UPDATE users SET password = ${next} WHERE id = ${existing.id}`); await tx.execute(sql`DELETE FROM sessions WHERE user_id = ${existing.id}`); });
    console.log('Local password reset. All account sessions were signed out.');
  } else {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120 || /[\u0000-\u001f]/.test(input.name)) throw new CliError('Use a name between 1 and 120 characters.');
    if (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 128) throw new CliError('Use a password between 12 and 128 characters.');
    if (existing) throw new CliError('An account already uses this email address.');
    const hash = await hashPassword(input.password);
    // A unique-email violation means a concurrent signup won; report it as the existing-account error.
    try { await db.execute(sql`INSERT INTO users VALUES (${randomUUID()}, ${input.name.trim()}, ${email}, ${hash})`); }
    catch (error: any) { if (error?.cause?.code === '23505' || error?.code === '23505') throw new CliError('An account already uses this email address.'); throw error; }
    console.log(`Created local account for ${email}. Add it to a workspace in the app.`);
  }
}

const command = process.argv[2];
try {
  if (command === 'migrate') {
    if (!process.env.DATABASE_URL) throw new CliError('Set DATABASE_URL to the PostgreSQL connection string.');
    const applied = await migrate();
    console.log(applied.length ? `Database migrations applied: ${applied.join(', ')}.` : 'Database migrations already applied; all checksums verified.');
  } else {
    if (!['create-user', 'grant-operator', 'revoke-operator', 'reset-password'].includes(command) || process.stdin.isTTY) throw new CliError(usage);
    if (!process.env.DATABASE_URL) throw new CliError('Set DATABASE_URL to the PostgreSQL connection string.');
    const { pool, db } = getDatabase();
    await assertSchema(pool);
    await account(command, db);
  }
} catch (error: any) {
  // PostgreSQL driver errors can carry connection details, so only this command's own messages are printed.
  console.error(error instanceof CliError || error?.code === 'SCHEMA_MISMATCH' ? error.message
    : command === 'migrate' ? 'Migration failed and was rolled back. Check DATABASE_URL, database availability and permissions.'
    : 'Account command failed. Check DATABASE_URL, the database and the account details.');
  process.exitCode = 1;
} finally {
  await closeDatabase().catch(() => { console.error('Database shutdown failed.'); process.exitCode = 1; });
}
