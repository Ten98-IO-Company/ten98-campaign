import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Transaction } from './database.ts';

/**
 * Host/bootstrap callers supply provenance and own the surrounding transaction; the Transaction type keeps a
 * plain database handle out. The user row lock serialises grants and revocations so audit order matches state.
 */
export async function setInstanceOperator(tx: Transaction, userId: string, enabled: boolean, source: 'bootstrap' | 'host' = 'host'): Promise<boolean> {
  if (typeof enabled !== 'boolean' || !['bootstrap', 'host'].includes(source) || source === 'bootstrap' && !enabled) throw new Error('Invalid operator change.');
  if (!(await tx.execute(sql`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`)).rowCount) throw new Error('The account does not exist.');
  const changed = (await tx.execute(enabled
    ? sql`INSERT INTO instance_operators (user_id) VALUES (${userId}) ON CONFLICT DO NOTHING`
    : sql`DELETE FROM instance_operators WHERE user_id = ${userId}`)).rowCount ?? 0;
  if (source === 'host' || changed) await tx.execute(sql`INSERT INTO instance_operator_audit VALUES (${randomUUID()}, ${userId}, ${source === 'bootstrap' ? 'bootstrap' : enabled ? 'grant' : 'revoke'}, ${source}, ${Date.now()})`);
  return changed > 0;
}
