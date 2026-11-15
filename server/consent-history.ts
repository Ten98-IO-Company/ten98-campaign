import { createHmac, hkdfSync, randomUUID } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import type { Database, Executor } from './database.ts';
import { directConsentEvents, directConsentEvidence, projects } from './schema.ts';

/**
 * Retained consent history of direct contacts (migration 0013). Each permission or suppression change appends one
 * event in the transaction of the change itself. Events are never updated or deleted by the app; the table's trigger
 * refuses both, apart from the project or workspace cascade.
 *
 * Destinations are stored only as HMAC-SHA256 under a key derived from the session secret with HKDF and a fixed label,
 * over the same normalized email or phone the contact record (and suppression matching) holds. A new SESSION_SECRET
 * changes the key: later events no longer match earlier ones by destination, though they still do by contact. Rows are
 * never re-keyed in place; `key_version` marks which key wrote each row, and a re-key can only append fresh events for
 * contacts that still exist, from their stored address. Hashes never leave the server.
 */
export const consentKeyVersion = 1;
export type ConsentAction = 'granted' | 'withdrawn' | 'suppressed' | 'suppression_ended' | 'contact_deleted';
export type ConsentEvent = { contactId: string; channel: string; action: ConsentAction; source: string; actor: string; destination: string; evidence?: string };

export function createConsentHistory({ db, secret }: { db: Database; secret: string }) {
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), 'ten98-campaign consent-destination v1', 32));
  const destinationHash = (destination: string) => createHmac('sha256', key).update(destination).digest('hex');

  /** Appends events for one project; call it with the change's own transaction. Events without a destination are skipped. */
  async function record(ex: Executor, projectId: string, events: ConsentEvent[]) {
    const kept = events.filter(event => event.destination);
    if (!kept.length) return;
    const [project] = await ex.select({ workspaceId: projects.workspace_id }).from(projects).where(eq(projects.id, projectId));
    if (!project) throw new Error('Consent history needs an existing project.');
    const at = new Date().toISOString(), rows = kept.map(event => ({ ...event, id: randomUUID() }));
    await ex.insert(directConsentEvents).values(rows.map(event => ({ id: event.id, workspace_id: project.workspaceId, project_id: projectId, contact_id: event.contactId, channel: event.channel, action: event.action, source: event.source, actor: event.actor, destination_hash: destinationHash(event.destination), key_version: consentKeyVersion, created_at: at })));
    // Evidence is optional free text; it is removed with the contact (foreign-key cascade), the event is not.
    const evidence = rows.filter(event => event.evidence && event.action !== 'contact_deleted').map(event => ({ event_id: event.id, contact_id: event.contactId, evidence: event.evidence! }));
    if (evidence.length) await ex.insert(directConsentEvidence).values(evidence);
  }

  const columns = { id: directConsentEvents.id, contactId: directConsentEvents.contact_id, channel: directConsentEvents.channel, action: directConsentEvents.action, source: directConsentEvents.source, actor: directConsentEvents.actor, at: directConsentEvents.created_at, evidence: directConsentEvidence.evidence };
  const read = (where: ReturnType<typeof and>, ex: Executor) => ex.select(columns).from(directConsentEvents).leftJoin(directConsentEvidence, eq(directConsentEvidence.event_id, directConsentEvents.id)).where(where).orderBy(asc(directConsentEvents.seq));

  return {
    record,
    /** One contact's history in its project, oldest first. */
    forContact: (projectId: string, contactId: string, ex: Executor = db) => read(and(eq(directConsentEvents.project_id, projectId), eq(directConsentEvents.contact_id, contactId)), ex),
    /** History for a normalized email or phone in one project, including contacts deleted since. */
    forDestination: (projectId: string, destination: string, ex: Executor = db) => read(and(eq(directConsentEvents.project_id, projectId), eq(directConsentEvents.destination_hash, destinationHash(destination)), eq(directConsentEvents.key_version, consentKeyVersion)), ex),
  };
}
