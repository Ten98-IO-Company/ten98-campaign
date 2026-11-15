import { createHmac, hkdfSync, randomUUID } from 'node:crypto';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import type { Database, Executor } from './database.ts';
import { fail } from './provider-core.ts';
import { directConsentEvents, directConsentEvidence, directConsentLookupLimits, projects } from './schema.ts';

/**
 * Retained consent history of direct contacts (migration 0013). Each permission or suppression change appends one
 * event in the transaction of the change itself. Events are never updated or deleted by the app; the table's trigger
 * refuses both, apart from the cascade that deletes the project or workspace.
 *
 * The address is stored only as a keyed hash: HMAC-SHA256, base64url, under a key derived with HKDF-SHA256 (empty salt,
 * 32 bytes) and the fixed label below, over the address as the contact record holds it (contacts.destination(), the
 * normalization suppression matching uses: trimmed lower-case email, trimmed E.164 phone). The expression equals the
 * runtime's planned deriveKey/keyedHash (ten98-code-system#154), so adopting those keeps every stored value.
 * The root secret is the session secret, which also keys the stored integration settings: rotating SESSION_SECRET
 * already invalidates those, and it also stops later events from matching earlier ones by address (they still match by
 * contact). Rows are never re-keyed in place; `key_version` marks the key, and a re-key may only append fresh events
 * for contacts that still exist, from their stored address. Hashes never leave the server.
 */
export const consentKeyLabel = 'ten98-campaign:consent-address:v1', consentKeyVersion = 1;
export type ConsentAction = 'granted' | 'withdrawn' | 'suppressed' | 'suppression_ended' | 'contact_deleted';
export type ConsentEvent = { contactId: string; channel: string; action: ConsentAction; source: string; actor: string; destination: string; evidence?: string };
const lookupLimit = 60, lookupWindow = 3_600_000;

export function createConsentHistory({ db, secret }: { db: Database; secret: string }) {
  const key = Buffer.from(hkdfSync('sha256', secret, '', consentKeyLabel, 32));
  const addressHash = (address: string) => createHmac('sha256', key).update(address).digest('base64url');

  /** Appends events for one project; call it with the change's own transaction. Events without an address are skipped. */
  async function record(ex: Executor, projectId: string, events: ConsentEvent[]) {
    const kept = events.filter(event => event.destination);
    if (!kept.length) return;
    const [project] = await ex.select({ workspaceId: projects.workspace_id }).from(projects).where(eq(projects.id, projectId));
    if (!project) throw new Error('Consent history needs an existing project.');
    const at = new Date().toISOString(), rows = kept.map(event => ({ ...event, id: randomUUID() }));
    await ex.insert(directConsentEvents).values(rows.map(event => ({ id: event.id, workspace_id: project.workspaceId, project_id: projectId, contact_id: event.contactId, channel: event.channel, action: event.action, source: event.source, actor: event.actor, destination_hash: addressHash(event.destination), key_version: consentKeyVersion, created_at: at })));
    // Evidence is optional free text; it is removed with the contact (foreign-key cascade), the event is not.
    const evidence = rows.filter(event => event.evidence && event.action !== 'contact_deleted').map(event => ({ event_id: event.id, workspace_id: project.workspaceId, project_id: projectId, contact_id: event.contactId, evidence: event.evidence! }));
    if (evidence.length) await ex.insert(directConsentEvidence).values(evidence);
  }

  const columns = { id: directConsentEvents.id, contactId: directConsentEvents.contact_id, channel: directConsentEvents.channel, action: directConsentEvents.action, source: directConsentEvents.source, actor: directConsentEvents.actor, at: directConsentEvents.created_at, evidence: directConsentEvidence.evidence };
  const read = (where: ReturnType<typeof and>, ex: Executor) => ex.select(columns).from(directConsentEvents).leftJoin(directConsentEvidence, eq(directConsentEvidence.event_id, directConsentEvents.id)).where(where).orderBy(asc(directConsentEvents.seq));

  // One conditional upsert per lookup, so parallel requests cannot all pass a separate read.
  async function countLookup(projectId: string, userId: string) {
    const now = Date.now(), limits = directConsentLookupLimits;
    await db.delete(limits).where(lte(limits.expires_at, now));
    const counted = await db.insert(limits).values({ key: `${projectId}:${userId}`, count: 1, expires_at: now + lookupWindow })
      .onConflictDoUpdate({ target: limits.key, set: { count: sql`${limits.count} + 1` }, setWhere: sql`${limits.count} < ${lookupLimit}` }).returning({ count: limits.count });
    if (!counted.length) fail(429, 'CONSENT_LOOKUP_LIMIT', 'Too many address lookups. Try again in an hour.');
  }

  return {
    record,
    /** One contact's history in its project, oldest first. */
    forContact: (projectId: string, contactId: string, ex: Executor = db) => read(and(eq(directConsentEvents.project_id, projectId), eq(directConsentEvents.contact_id, contactId)), ex),
    /** History of a normalized address in one project, across contacts deleted and re-added since; counted per member. */
    async forAddress(projectId: string, userId: string, address: string) {
      await countLookup(projectId, userId);
      return read(and(eq(directConsentEvents.project_id, projectId), eq(directConsentEvents.destination_hash, addressHash(address)), eq(directConsentEvents.key_version, consentKeyVersion)), db);
    },
  };
}
