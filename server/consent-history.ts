import { createHmac, hkdfSync, randomUUID } from 'node:crypto';
import { and, asc, eq, lt, sql } from 'drizzle-orm';
import type { Database, Executor } from './database.ts';
import { IntegrationError } from './provider-core.ts';
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
/** Where a consent or suppression change came from: a fixed vocabulary, assigned per path in `consentOrigin`. */
export type ConsentSource = 'manual' | 'csv_import' | 'lead_capture' | 'provider_lead' | 'connected_settings' | 'unsubscribe_link' | 'sms_keyword' | 'provider_bounce' | 'provider_complaint' | 'provider_opt_out' | 'provider_hold';
/** `actor` is `user:<id>` when a member acted, otherwise `system:<provider>`. */
export type ConsentOrigin = { source: ConsentSource; actor: string };
/** `contactId` is '' for an address that is no contact in the project; such an event keeps no evidence. */
export type ConsentEvent = ConsentOrigin & { contactId: string; channel: string; action: ConsentAction; destination: string; evidence?: string };
const member = (source: ConsentSource) => (userId: string): ConsentOrigin => ({ source, actor: 'user:' + userId });
const system = (source: ConsentSource, provider: string): ConsentOrigin => ({ source, actor: 'system:' + provider });
/** Every path that changes consent or suppression, with the origin its events record. Keep this the only such map. */
export const consentOrigin = {
  /** The contact form: add, edit, suppress or delete. */
  manual: member('manual'),
  csvImport: member('csv_import'),
  /** In-person lead capture at an offline activation. */
  leadCapture: member('lead_capture'),
  /** A provider lead-form lead a member imports. */
  providerLead: member('provider_lead'),
  /** A member unsubscribing a connected contact. */
  connectedSettings: member('connected_settings'),
  /** The recipient's own click on Campaign's unsubscribe link. */
  unsubscribeLink: system('unsubscribe_link', 'campaign'),
  /** A signed Twilio STOP or START keyword. */
  smsKeyword: system('sms_keyword', 'twilio'),
  /** Twilio error 21610: the carrier reports that the recipient opted out. */
  smsOptOut: system('provider_opt_out', 'twilio'),
  /** An email provider's bounce or complaint, by the reason it reported or was classified as. */
  emailFeedback: (provider: string, reason: string | undefined) => system(reason === 'complaint' ? 'provider_complaint' : 'provider_bounce', provider),
  /** An email provider reporting that the recipient unsubscribed. */
  emailOptOut: (provider: string) => system('provider_opt_out', provider),
  /** A provider's temporary hold, which ends at its expiry. */
  emailHold: (provider: string) => system('provider_hold', provider),
};
// Up to 60 lookups at once, refilled at one a minute (so up to 119 in the first hour, then 60 an hour).
const lookupBurst = 60, lookupInterval = 60_000;

// PostgreSQL takes at most 65,535 bound values per statement; an event binds 11 (evidence 5), so write in batches.
const batchSize = 1000;

/** Database errors carry the failed query's bound values (address hashes, evidence); report them without those. */
async function quietly<T>(work: () => Promise<T>, message: string): Promise<T> {
  try { return await work(); } catch (error: any) {
    if (error?.status) throw error;
    throw Object.assign(new Error(message), { code: error?.cause?.code ?? error?.code });
  }
}

export function createConsentHistory({ db, secret }: { db: Database; secret: string }) {
  const key = Buffer.from(hkdfSync('sha256', secret, '', consentKeyLabel, 32));
  const addressHash = (address: string) => createHmac('sha256', key).update(address).digest('base64url');

  /**
   * Appends events for one project; call it with the change's own transaction. An event of a contact without an address
   * for its channel (say, suppressing SMS for an email-only contact) is kept with an empty hash, so it is listed for the
   * contact but never matches an address. The database stamps each event's time and order.
   */
  async function record(ex: Executor, projectId: string, events: ConsentEvent[]) {
    const kept = events.filter(event => event.destination || event.contactId);
    if (!kept.length) return;
    const [project] = await ex.select({ workspaceId: projects.workspace_id }).from(projects).where(eq(projects.id, projectId));
    if (!project) throw new Error('Consent history needs an existing project.');
    const at = new Date().toISOString(), rows = kept.map(event => ({ ...event, id: randomUUID() }));
    const values = rows.map(event => ({ id: event.id, workspace_id: project.workspaceId, project_id: projectId, contact_id: event.contactId, channel: event.channel, action: event.action, source: event.source, actor: event.actor, destination_hash: event.destination ? addressHash(event.destination) : '', key_version: consentKeyVersion, created_at: at }));
    await quietly(async () => { for (let i = 0; i < values.length; i += batchSize) await ex.insert(directConsentEvents).values(values.slice(i, i + batchSize)); }, 'The consent history could not be written.');
    // Evidence is optional free text; it is removed with the contact (foreign-key cascade), the event is not. An address
    // that is no contact has nowhere to keep it.
    const evidence = rows.filter(event => event.evidence && event.contactId && event.action !== 'contact_deleted').map(event => ({ event_id: event.id, workspace_id: project.workspaceId, project_id: projectId, contact_id: event.contactId, evidence: event.evidence! }));
    await quietly(async () => { for (let i = 0; i < evidence.length; i += batchSize) await ex.insert(directConsentEvidence).values(evidence.slice(i, i + batchSize)); }, 'The consent history could not be written.');
  }

  const columns = { id: directConsentEvents.id, contactId: directConsentEvents.contact_id, channel: directConsentEvents.channel, action: directConsentEvents.action, source: directConsentEvents.source, actor: directConsentEvents.actor, at: directConsentEvents.created_at, evidence: directConsentEvidence.evidence };
  // Ordered by seq: created_at is the time of the change's transaction, so the events of one import share it.
  const read = (where: ReturnType<typeof and>, ex: Executor) => quietly(() => ex.select(columns).from(directConsentEvents).leftJoin(directConsentEvidence, eq(directConsentEvidence.event_id, directConsentEvents.id)).where(where).orderBy(asc(directConsentEvents.seq)), 'The consent history could not be read.');

  // Cell-rate limiter (GCRA): `allowed_at` is when the key's bucket would be full again. A lookup is allowed while it lies
  // less than the burst ahead of now, and moves it one interval on. One conditional upsert, so parallel lookups cannot all
  // pass a separate read. App-local stopgap: it moves to the runtime's shared limiter when that ships (the minor after
  // @ten98/runtime 0.29.0).
  async function countLookup(projectId: string, userId: string) {
    const now = Date.now(), limits = directConsentLookupLimits, key = `${projectId}:${userId}`, tolerance = (lookupBurst - 1) * lookupInterval;
    await db.delete(limits).where(lt(limits.allowed_at, now));
    const allowed = await db.insert(limits).values({ key, allowed_at: now + lookupInterval })
      .onConflictDoUpdate({ target: limits.key, set: { allowed_at: sql`GREATEST(${limits.allowed_at}, ${now}) + ${lookupInterval}` }, setWhere: sql`GREATEST(${limits.allowed_at}, ${now}) - ${now} <= ${tolerance}` }).returning({ key: limits.key });
    if (allowed.length) return;
    const [row] = await db.select({ at: limits.allowed_at }).from(limits).where(eq(limits.key, key));
    const error = new IntegrationError(429, 'CONSENT_LOOKUP_LIMIT', 'Too many address lookups. Try again shortly.');
    error.retryAfter = Math.max(1, Math.ceil(((row?.at ?? now) - now - tolerance) / 1000)); throw error;
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
export type ConsentHistory = ReturnType<typeof createConsentHistory>;
