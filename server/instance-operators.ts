import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

/** Host/bootstrap callers supply provenance and own the surrounding SQLite transaction. */
export function setInstanceOperator(db: DatabaseSync, userId: string, enabled: boolean, source: 'bootstrap' | 'host' = 'host'): boolean {
  if (!db.isTransaction) throw new Error('Operator changes require a database transaction.');
  if (typeof enabled !== 'boolean' || !['bootstrap', 'host'].includes(source) || source === 'bootstrap' && !enabled) throw new Error('Invalid operator change.');
  const changed = db.prepare(enabled ? 'INSERT OR IGNORE INTO instance_operators VALUES(?)' : 'DELETE FROM instance_operators WHERE user_id=?').run(userId).changes;
  if (source === 'host' || changed) db.prepare('INSERT INTO instance_operator_audit VALUES(?,?,?,?,?)').run(randomUUID(), userId, source === 'bootstrap' ? 'bootstrap' : enabled ? 'grant' : 'revoke', source, Date.now());
  return Number(changed) > 0;
}
