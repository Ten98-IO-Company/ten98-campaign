import { sql } from 'drizzle-orm';
import { HttpError, type PublicUser } from './auth.ts';
import type { Executor, Store } from './database.ts';
import type { ProviderRecord } from './provider-core.ts';
import { ACTIVATION_TYPE_LABELS, CONSENT_CHANNELS, activationTag, consentWording, type ActivationType } from '../shared/offline-activations.ts';

type Contacts = { capture: (projectId: string, person: { name?: string; email?: string; phone?: string }, requested: string[], source: string, tag: string) => Promise<ProviderRecord> };
type Context = { req: { method?: string }; url: URL; project: { id: string; name: string }; role: string; user: PublicUser; body: ProviderRecord; store: Store; db: Executor; send: (status: number, body: unknown) => void };
function fail(status: number, message: string): never { throw new HttpError(status, message); }
const optional = (value: unknown, label: string, max: number) => { if (value === undefined || value === '') return undefined; if (typeof value !== 'string' || value.length > max) fail(400, `${label} must be text of at most ${max} characters.`); return value.trim() || undefined; };

// Per activation: contacts captured there (by tag) and its tracking link's visits and QR scans. People reached and spend
// are on the activation itself.
async function results(db: Executor, store: Store, projectId: string) {
  const leads = new Map((await db.execute(sql`SELECT tag, count(*)::int AS count FROM direct_contacts c, json_array_elements_text(CASE WHEN json_typeof(c.data->'tags') = 'array' THEN c.data->'tags' ELSE '[]'::json END) AS tag WHERE c.project_id = ${projectId} AND tag LIKE 'offline:%' GROUP BY tag`)).rows.map((row: any) => [row.tag, row.count]));
  const visits = new Map((await db.execute(sql`SELECT d.link_id, SUM(d.clicks)::int AS clicks, SUM(d.qr_scans)::int AS "qrScans" FROM campaign_link_daily d JOIN campaign_links l ON l.id = d.link_id WHERE l.project_id = ${projectId} GROUP BY d.link_id`)).rows.map((row: any) => [row.link_id, row]));
  return Object.fromEntries((await store.list(projectId, 'activations')).map(activation => { const link: any = activation.linkId && visits.get(activation.linkId); return [activation.id, { leads: leads.get(activationTag(activation.id)) || 0, clicks: link?.clicks || 0, qrScans: link?.qrScans || 0 }]; }));
}

// Field routes below an activation; the activation record itself uses the generic project record routes.
export async function handleActivations({ req, url, project, role, user, body, store, db, send }: Context, contacts: Contacts, limit: (key: string, maximum: number) => Promise<void>): Promise<boolean> {
  if (url.pathname === `/api/projects/${encodeURIComponent(project.id)}/activations/results` && req.method === 'GET') { send(200, { results: await results(db, store, project.id) }); return true; }
  const route = url.pathname.match(/^\/api\/projects\/[^/]+\/activations\/([^/]+)\/leads$/);
  if (!route || req.method !== 'POST') return false;
  if (!['owner', 'admin', 'editor'].includes(role)) fail(403, 'Your workspace role is view only.');
  // About one lead every 7 seconds per staff member over 15 minutes, counting refused attempts.
  await limit('activation-leads:' + user.id, 120);
  const activation = await store.get(project.id, 'activations', decodeURIComponent(route[1]));
  if (!activation) fail(404, 'Activation not found in this project.');
  if (activation.status === 'cancelled') fail(409, 'This activation was cancelled, so it takes no leads.');
  // Minimal data: who to contact and what they agreed to, nothing else about the person.
  if (Object.keys(body).some(key => !['name', 'email', 'phone', 'consents'].includes(key))) fail(400, 'Record only a name, email, phone and consent.');
  const consents = body.consents;
  if (!consents || typeof consents !== 'object' || Array.isArray(consents) || Object.entries(consents).some(([channel, granted]) => !CONSENT_CHANNELS.includes(channel as never) || typeof granted !== 'boolean')) fail(400, 'Use a true or false consent for each channel.');
  const requested = CONSENT_CHANNELS.filter(channel => consents[channel] === true);
  if (!requested.length) fail(400, 'Tick at least one channel the person agreed to. Without an opt-in nothing is saved.');
  // Only the fields given, because the contacts module treats a present key as a destination to validate.
  const person = Object.fromEntries(Object.entries({ name: optional(body.name, 'Name', 120), email: optional(body.email, 'Email', 254), phone: optional(body.phone, 'Phone', 16) }).filter(([, value]) => value !== undefined));
  // Dated when the lead is captured, not when the activation was planned to start.
  const capturedAt = new Date().toISOString();
  const source = `In person at ${ACTIVATION_TYPE_LABELS[activation.type as ActivationType]} “${activation.name}” on ${capturedAt.slice(0, 10)} ${capturedAt.slice(11, 16)} UTC, recorded by ${user.name}. Wording shown: “${consentWording(project.name, requested)}”`;
  send(201, await contacts.capture(project.id, person, requested, source, activationTag(activation.id)));
  return true;
}
