import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { closeDatabase, migrate, openDatabase, transaction } from './database.ts';
import { hashPassword } from './auth.ts';
import { setInstanceOperator } from './instance-operators.ts';

class CliError extends Error {}
const usage = 'Usage: node server/cli.ts migrate, or pipe JSON account input to create-user, reset-password, or {email} to grant-operator or revoke-operator.';

// Read JSON from stdin so passwords never appear in process arguments or output.
async function account(command: string, db: DatabaseSync) {
  let raw = '';
  for await (const chunk of process.stdin) { raw += chunk; if (Buffer.byteLength(raw) > 8192) throw new CliError('Account input is too large.'); }
  let input; try { input = JSON.parse(raw); } catch { throw new CliError('Supply valid JSON account input.'); }
  const email = typeof input?.email === 'string' ? input.email.trim().toLowerCase() : '';
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new CliError('Supply a valid email address.');
  if (!db.prepare('SELECT id FROM users LIMIT 1').get()) throw new CliError('Complete first-run setup in the app before provisioning other users.');
  const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email) as { id: string } | undefined;
  if (command === 'grant-operator' || command === 'revoke-operator') {
    if (!existing) throw new CliError('The account does not exist. Create it first.');
    const enabled = command === 'grant-operator', changed = transaction(db, () => setInstanceOperator(db, existing.id, enabled, 'host'));
    console.log(changed ? `${enabled ? 'Granted' : 'Revoked'} instance operator authority ${enabled ? 'to' : 'from'} ${email}. Workspace membership is still required.` : `Instance operator authority for ${email} is already ${enabled ? 'granted' : 'revoked'}.`);
  } else if (command === 'reset-password') {
    if (!existing || !db.prepare('SELECT password FROM users WHERE id=?').get(existing.id)?.password) throw new CliError('A local password account was not found. Use your identity provider for SSO recovery.');
    if (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 128) throw new CliError('Use a password between 12 and 128 characters.');
    const next = await hashPassword(input.password);
    transaction(db, () => { db.prepare('UPDATE users SET password=? WHERE id=?').run(next, existing.id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(existing.id); });
    console.log('Local password reset. All account sessions were signed out.');
  } else {
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120 || /[\u0000-\u001f]/.test(input.name)) throw new CliError('Use a name between 1 and 120 characters.');
    if (typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 128) throw new CliError('Use a password between 12 and 128 characters.');
    if (existing) throw new CliError('An account already uses this email address.');
    db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(randomUUID(), input.name.trim(), email, await hashPassword(input.password));
    console.log(`Created local account for ${email}. Add it to a workspace in the app.`);
  }
}

let db: DatabaseSync | undefined;
const command = process.argv[2];
try {
  if (command === 'migrate') {
    if (!process.env.DATABASE_URL) throw new CliError('Set DATABASE_URL to the PostgreSQL connection string.');
    const applied = await migrate();
    console.log(applied.length ? `Database migrations applied: ${applied.join(', ')}.` : 'Database migrations already applied; all checksums verified.');
  } else {
    if (!['create-user', 'grant-operator', 'revoke-operator', 'reset-password'].includes(command) || process.stdin.isTTY) throw new CliError(usage);
    await account(command, db = openDatabase(resolve(process.env.DATA_DIR || 'data')));
  }
} catch (error: any) {
  // PostgreSQL driver errors can carry connection details, so migrate prints only its own messages.
  console.error(error instanceof CliError || error?.code === 'SCHEMA_MISMATCH' ? error.message
    : command === 'migrate' ? 'Migration failed and was rolled back. Check DATABASE_URL, database availability and permissions.'
    : error.code?.startsWith('SQLITE_') ? 'Account creation failed. Check the database and account details.' : error.message);
  process.exitCode = 1;
} finally {
  db?.close();
  await closeDatabase().catch(() => { console.error('Database shutdown failed.'); process.exitCode = 1; });
}
