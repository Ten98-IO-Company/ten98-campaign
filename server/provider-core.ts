// Shared provider transport, receipts and post validation used by every provider module.
import { createHash, createSign, randomUUID } from 'node:crypto';
import { readResponseText } from '@ten98/runtime';
import { buildPlatformEntry, normalizeMediaItems, normalizePlatformOptions, normalizePostTags, validPostInstant, resolveVariant, validatePostForPlatforms, wireMediaItems, assetDeliveryIssue } from '../shared/social-posts.ts';
import type { IncomingHttpHeaders } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';

// Provider and stored records are untrusted JSON; every reader below validates the fields it consumes.
export type ProviderRecord = Record<string, any>;
export type MappingCheck = (() => void) | undefined;
export type ZernioApi = (path: string, query?: Record<string, unknown>, body?: unknown, idempotencyKey?: string, method?: string, observeReceipt?: (result: ProviderRecord) => void) => Promise<ProviderRecord>;
export interface PostStore { get(projectId: string, collection: string, id: string): ProviderRecord | null; list(projectId: string, collection: string): ProviderRecord[]; update(projectId: string, collection: string, id: string, data: Record<string, unknown>): ProviderRecord | null }
export interface OperationContext { db: DatabaseSync; project: { id: string }; req: { method?: string; headers: IncomingHttpHeaders }; url: URL; body?: unknown; [key: string]: any }
export interface OperationOutcome { status: number; data: ProviderRecord }
type RestrictionCheck = ReturnType<typeof validatePostForPlatforms>;

const ZERNIO = 'https://zernio.com/api/v1';
export class IntegrationError extends Error {
  declare status: number; declare code: string; declare uncertain: boolean;
  declare providerStatus?: number; declare providerCode?: string | number; declare privateReplyConsumed?: boolean; declare privateReplyOutcome?: string;
  constructor(status: number, code: string, message: string, uncertain: unknown = false) {
    super(message); Object.assign(this, { status, code, uncertain });
  }
}
export function fail(status: number, code: string, message: string): never { throw new IntegrationError(status, code, message); }
const secretField = /token|secret|password|authorization|api.?key|credentials|private.?key/i;
export function redact(value: any): any {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !secretField.test(key)).map(([key, item]) => [key, redact(item)]));
}
export function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function checkMapping(check: MappingCheck, uncertain: unknown = false): void {
  try { check?.(); } catch (error: any) { if (!uncertain && [403, 404].includes(error.status)) throw new IntegrationError(error.status, 'PROJECT_ACCESS_CHANGED', 'Your project access changed. Refresh before continuing.'); throw new IntegrationError(409, 'PROJECT_CONNECTION_CHANGED', uncertain ? 'The project connection changed after the provider received this action. Reconcile the previous connection.' : 'The project connection changed. Reload this project before continuing.', uncertain); }
}
async function providerJson(response: Response, signal: AbortSignal, allowEmpty = false): Promise<any> {
  const body = await readResponseText(response, { maxBytes: 8 * 1024 * 1024, signal, preserveBOM: true });
  return allowEmpty && body.length === 0 ? {} : JSON.parse(body);
}
export async function providerRequest(url: string | URL, options: RequestInit = {}, provider = 'Zernio', assertMapping?: MappingCheck, observeReceipt?: (result: ProviderRecord) => void): Promise<ProviderRecord> {
  const target = new URL(url);
  if (target.protocol !== 'https:' || !['zernio.com', 'www.googleapis.com', 'oauth2.googleapis.com', 'googleads.googleapis.com', 'login.microsoftonline.com', 'clientcenter.api.bingads.microsoft.com', 'campaign.api.bingads.microsoft.com', 'reporting.api.bingads.microsoft.com', 'api.twilio.com', 'api.cloudflare.com'].includes(target.hostname)) fail(500, 'INVALID_PROVIDER', 'The provider endpoint is invalid.');
  checkMapping(assertMapping);
  const signal = AbortSignal.timeout(['/api/v1/ads/create', '/api/v1/ads/boost'].includes(target.pathname) ? 180000 : 20000);
  let response: Response;
  try { response = await fetch(target, { ...options, redirect: 'error', signal }); }
  catch { throw new IntegrationError(502, 'PROVIDER_UNAVAILABLE', `${provider} did not confirm the request.`, options.method && options.method !== 'GET'); }
  if (!response.ok) {
    const status = response.status === 429 ? 429 : response.status >= 500 ? 502 : 400;
    let providerCode: string | number | undefined; const privateReply: { privateReplyConsumed?: boolean; privateReplyOutcome?: string } = {};
    if (target.hostname === 'zernio.com' && response.status === 404 && (options.method || 'GET') === 'GET' && /^\/api\/v1\/commerce\/products\/[^/]+$/.test(target.pathname)) {
      try { const result = await providerJson(response, signal); if (result && typeof result === 'object' && !Array.isArray(result) && ['product_not_found', 'account_not_found'].includes(result.code)) providerCode = result.code; } catch { /* An unreadable or unrecognized absence never proves deletion. */ }
      checkMapping(assertMapping);
    }
    if (target.hostname === 'zernio.com' && /^\/api\/v1\/inbox\/comments\/[^/]+\/[^/]+\/private-reply$/.test(target.pathname)) {
      try {
        const result = await providerJson(response, signal), details = result?.details;
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
        if (typeof details?.privateReplyConsumed === 'boolean') privateReply.privateReplyConsumed = details.privateReplyConsumed;
        if (details?.privateReplyOutcome === 'unknown') privateReply.privateReplyOutcome = 'unknown';
      } catch { privateReply.privateReplyOutcome = 'unknown'; }
    }
    if (target.hostname === 'api.twilio.com') { try { const result = await providerJson(response, signal); if (Number.isSafeInteger(result?.code) && result.code >= 10000 && result.code <= 99999) providerCode = result.code; } catch { /* Preserve the sanitized rejection when the error body is unreadable. */ } }
    throw Object.assign(new IntegrationError(status, response.status === 429 ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_REJECTED', `${provider} ${response.status === 429 ? 'rate limit reached. Try again later.' : 'could not complete this request. Check the connection and request details.'}`, (response.status >= 500 || [408, 409].includes(response.status)) && options.method && options.method !== 'GET'), { providerStatus: response.status, ...privateReply, ...(providerCode === undefined ? {} : { providerCode }) });
  }
  if (response.status === 204) { checkMapping(assertMapping, options.method && options.method !== 'GET'); return {}; }
  let result: ProviderRecord;
  try {
    result = await providerJson(response, signal, response.status === 200 && target.hostname === 'zernio.com' && ((/^\/api\/v1\/accounts\/[^/]+\/telegram-commands$/.test(target.pathname) && ['PUT', 'DELETE'].includes(options.method!)) || (/^\/api\/v1\/accounts\/[^/]+\/slack-settings$/.test(target.pathname) && options.method === 'PATCH')));
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
  } catch { throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', `${provider} returned an unreadable response.`, options.method && options.method !== 'GET'); }
  try { observeReceipt?.(result); }
  catch { throw new IntegrationError(502, 'PROVIDER_REFERENCE_NOT_RECORDED', 'The provider response could not be recorded.', options.method && options.method !== 'GET'); }
  checkMapping(assertMapping, options.method && options.method !== 'GET');
  return result;
}
export function zernioClient(key: string, assertMapping?: MappingCheck): ZernioApi {
  return async (path, query = {}, body, idempotencyKey, method, observeReceipt) => {
    const url = new URL(`${ZERNIO}${path}`);
    for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== '') url.searchParams.set(name, String(value));
    return providerRequest(url, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: { Authorization: `Bearer ${key}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey, ...(path === '/posts' ? { 'x-request-id': idempotencyKey } : {}) } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, 'Zernio', assertMapping, observeReceipt);
  };
}
export const reportObject = (value: any): value is ProviderRecord => value && typeof value === 'object' && !Array.isArray(value);
export async function scopedAccounts(api: ZernioApi, profileId: string): Promise<ProviderRecord[]> {
  const result = await api('/accounts', { profileId });
  if (!Array.isArray(result.accounts) || result.accounts.some((account: any) => !reportObject(account) || typeof account._id !== 'string' || !account._id || typeof account.platform !== 'string' || !account.platform)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return an account list.');
  // Fail closed if Zernio ever returns an account outside the requested profile.
  const accounts: ProviderRecord[] = result.accounts.filter((account: any) => String(account.profileId?._id || account.profileId) === profileId);
  if (accounts.some(account => ['displayName', 'username', 'name'].some(key => account[key] != null && typeof account[key] !== 'string') || account.isActive != null && typeof account.isActive !== 'boolean')) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return readable connected account details.');
  return accounts;
}
export function requireAccount(accounts: ProviderRecord[], accountId: string): ProviderRecord {
  const account = accounts.find(item => item._id === accountId);
  if (!account) fail(403, 'ACCOUNT_OUTSIDE_PROJECT', 'This account is not connected to this project.');
  return account;
}
export async function campaignTree(api: ZernioApi, profileId: string, dates: Record<string, string> = {}): Promise<ProviderRecord> {
  const all: ProviderRecord[] = []; let last!: ProviderRecord; let backfillPending = false;
  for (let page = 1; page <= 10; page++) {
    const result = await api('/ads/tree', { profileId, ...dates, page, limit: 100, source: 'all' });
    if (!Array.isArray(result.campaigns)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return a campaign tree.');
    if (result.campaigns.some((campaign: any) => String(campaign.profileId?._id || campaign.profileId) !== profileId)) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned campaign data without the expected project profile.');
    all.push(...result.campaigns); last = result; backfillPending ||= Boolean(result.backfillPending);
    const pagination = result.pagination || {};
    const pages = pagination.pages ?? pagination.totalPages ?? (pagination.total === undefined ? undefined : Math.ceil(pagination.total / 100));
    if (pagination.hasMore === false || (pages !== undefined && page >= pages) || (pages === undefined && pagination.hasMore !== true && result.campaigns.length < 100)) return { ...redact(last), campaigns: redact(all), backfillPending, complete: !backfillPending, pagination: { ...pagination, page: 1, pages: 1, total: all.length, hasMore: false } };
  }
  fail(503, 'INCOMPLETE_PROVIDER_DATA', 'The campaign tree exceeds the current reporting limit.');
}
export async function adAccounts(api: ZernioApi, accountId: string): Promise<ProviderRecord> {
  const result = await api('/ads/accounts', { accountId, inScopeOnly: true });
  if (!reportObject(result) || !Array.isArray(result.accounts) || result.stale !== undefined && typeof result.stale !== 'boolean' || result.cachedAt != null && !validPostInstant(result.cachedAt)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return valid advertising account access information.');
  if (result.stale === true) fail(503, 'AD_ACCOUNT_MEMBERSHIP_STALE', 'The provider returned an older advertising account list after its quota was exhausted. Wait for a current access check before continuing.');
  return result;
}
export async function operation(context: OperationContext, action: (key: string) => Promise<ProviderRecord>, resourceKey?: unknown): Promise<OperationOutcome> {
  const { db, project, req, url, body } = context;
  const key = req.headers['idempotency-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,200}$/.test(key)) fail(400, 'IDEMPOTENCY_KEY_REQUIRED', 'Send a unique Idempotency-Key header for this action.');
  const receiptOnly = url.searchParams.has('check');
  if (receiptOnly && (url.searchParams.getAll('check').length !== 1 || url.searchParams.get('check') !== '1' || [...url.searchParams.keys()].some(name => name !== 'check'))) fail(400, 'INVALID_OUTCOME_CHECK', 'Use the exact retained action to check its outcome.');
  db.exec(`CREATE TABLE IF NOT EXISTS integration_operations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL, status TEXT NOT NULL, response TEXT, http_status INTEGER, created_at TEXT NOT NULL, action_path TEXT NOT NULL DEFAULT '', run_id TEXT NOT NULL DEFAULT '', UNIQUE(project_id, request_key))`);
  const columns = new Set(db.prepare('PRAGMA table_info(integration_operations)').all().map(column => column.name as string));
  for (const name of ['action_path', 'run_id', 'resource_key']) if (!columns.has(name)) db.exec(`ALTER TABLE integration_operations ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
  db.exec('CREATE INDEX IF NOT EXISTS integration_operations_resource ON integration_operations(project_id,resource_key,status)');
  if (!operation.active.has(db)) operation.active.set(db, new Set());
  const active = operation.active.get(db)!;
  const hash = createHash('sha256').update(canonical({ method: req.method, path: url.pathname, body })).digest('hex');
  const existing = db.prepare('SELECT * FROM integration_operations WHERE project_id = ? AND request_key = ?').get(project.id, key) as ProviderRecord | undefined;
  if (existing) {
    if (existing.request_hash !== hash) fail(409, 'IDEMPOTENCY_CONFLICT', 'This action key belongs to a different request.');
    if (existing.status === 'uncertain' || existing.status === 'pending') fail(409, 'OPERATION_UNCERTAIN', 'The provider outcome needs reconciliation. This action cannot be retried automatically.');
    if (existing.status.startsWith('reviewed-')) return { status: 409, data: { operation: { id: existing.id, status: existing.status }, error: { code: 'OPERATION_REVIEWED', message: 'This action key is closed after an operator review. Reuse of this key cannot send another provider request.' } } };
    return { status: existing.http_status, data: JSON.parse(existing.response) };
  }
  if (receiptOnly) fail(409, 'OPERATION_OUTCOME_UNAVAILABLE', 'No matching local receipt was found. The original action is retained. Review the provider before explicitly preparing a new action.');
  const blockedHash = db.prepare("SELECT id FROM integration_operations WHERE project_id = ? AND request_hash = ? AND status IN ('pending', 'uncertain', 'reviewed-applied')").get(project.id, hash);
  // ponytail: one process owns this SQLite connection; use database resource locks before running multiple server processes.
  const resource = resourceKey ? canonical([project.id, resourceKey]) : null;

  const id = randomUUID();
  const known = new Set(['products', 'collections', 'rename', 'price', 'deactivate', 'activate', 'store', 'blogs', 'articles', 'create', 'google-conversions', 'actions', 'goals', 'custom-goals', 'remove', 'contacts', 'fields', 'bulk', 'subscription', 'link', 'unlink', 'set', 'clear', 'recycling', 'posts', 'apply', 'stop', 'review', 'leads', 'forms', 'import', 'archive', 'test-leads', 'whatsapp-templates', 'templates', 'library', 'connections', 'credentials', 'code', 'react', 'unreact', 'thread-control', 'accept','queues', 'preview', 'accounts', 'health', 'reconnect', 'disconnect', 'bluesky-settings', 'telegram-commands', 'slack-settings', 'discord-settings', 'webhook-subscription', 'measurement', 'tags', 'diagnostics', 'ad-accounts', 'admin', 'profile', 'groups','native-google-ads', 'microsoft-ads', 'shopping', 'cpc', 'keywords', 'keyword', 'bidding', 'negatives', 'google', 'planner', 'ideas', 'history', 'targeting', 'search-terms', 'reports', 'report', 'download', 'mapping', 'validate', 'budget', 'integrations', 'social', 'publish', 'schedule', 'cancel-schedule', 'update', 'cancel', 'retry', 'status', 'edit-published', 'update-metadata', 'unpublish', 'ads', 'copy', 'copy-review', 'copy-status', 'create', 'boost', 'ad-status', 'edit', 'adset', 'campaign', 'drive', 'upload', 'calendar', 'events', 'sync', 'connection', 'connect', 'openai-ads', 'ooh', 'bookings', 'submit', 'inbox', 'conversations', 'messages', 'comments', 'private-reply', 'webhook-settings', 'redeliver', 'test', 'thread', 'reviews', 'reply', 'read', 'hide', 'unhide', 'delete', 'like', 'unlike', 'moderate', 'delete-reply']);
  const actionPath = `${req.method} ${url.pathname.replace(/^\/api\/projects\/[^/]+/, '').split('/').map(part => !part || known.has(part) ? part : ':id').join('/')}`;
  const unresolved = resource && db.prepare("SELECT id,status FROM integration_operations WHERE project_id=? AND status IN ('pending','uncertain') AND (resource_key=? OR resource_key='')").get(project.id, resource);
  const blocked = blockedHash || unresolved || resource && active.has(resource);
  // A blocked key is terminal: a later outcome check must never turn into its first provider request.
  const notSent = blocked ? { status: 409, data: { operation: { id, status: 'failed' }, error: { code: 'OPERATION_NOT_SENT', message: 'No provider request was sent. An earlier action needs review or is still running. Resolve its outcome, then refresh and explicitly review a new action.' } } } : null;
  db.prepare('INSERT INTO integration_operations (id, project_id, request_key, request_hash, status, created_at, action_path, run_id, resource_key, response, http_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, project.id, key, hash, notSent ? 'failed' : 'pending', new Date().toISOString(), actionPath, operation.runId, resource || canonical([project.id, null]), notSent ? JSON.stringify(notSent.data) : null, notSent?.status ?? null);
  if (notSent) return notSent;
  active.add(id); if (resource) active.add(resource);
  try {
    let outcome: OperationOutcome;
    try { outcome = { status: 200, data: { operation: { id, status: 'complete' }, ...await action(key) } }; }
    catch (error) {
      const uncertain = !(error instanceof IntegrationError) || error.uncertain;
      outcome = { status: uncertain ? 409 : (error as IntegrationError).status, data: { operation: { id, status: uncertain ? 'uncertain' : 'failed' }, error: { code: uncertain ? 'OPERATION_UNCERTAIN' : (error as IntegrationError).code, message: uncertain ? 'The provider outcome needs reconciliation. Check the provider before making another attempt.' : (error as IntegrationError).message } } };
    }
    const updated = db.prepare("UPDATE integration_operations SET status = ?, response = ?, http_status = ? WHERE id = ? AND status = 'pending'").run(outcome.data.operation.status, JSON.stringify(outcome.data), outcome.status, id);
    if (!updated.changes) fail(409, 'OPERATION_REVIEWED', 'This action was closed by an operator review. Its review and original receipt were preserved.');
    return outcome;
  } finally { active.delete(id); if (resource) active.delete(resource); }
}
// Process-local state: active resource locks per connection and this process's run identity.
operation.active = new WeakMap<DatabaseSync, Set<string>>();
operation.runId = randomUUID();
export function mediaUrl(value: unknown): string {
  let url!: URL;
  try { url = new URL(value as string); } catch { fail(400, 'INVALID_MEDIA', 'Media must have a public HTTPS delivery URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hostname.includes(':') || /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/i.test(url.hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname) || /\.(local|internal)$/.test(url.hostname) || ['drive.google.com', 'docs.google.com'].includes(url.hostname)) fail(400, 'INVALID_MEDIA', 'Media needs a public HTTPS delivery URL. Private Drive preview links cannot be published.');
  return url.href;
}
export function commonMedia(post: ProviderRecord, assets: ProviderRecord[]) { return resolveVariant({ ...post, platformOverrides: {} }, 'facebook', assets).mediaItems; }
function checkMediaUrls(items: ProviderRecord[]) {
  for (const item of items) {
    mediaUrl(item.url);
    for (const key of ['thumbnail', 'instagramThumbnail']) if (typeof item[key] === 'string') mediaUrl(item[key]);
    if (Array.isArray(item.subtitles)) for (const subtitle of item.subtitles) if (subtitle?.url) mediaUrl(subtitle.url);
  }
}
export function postRestrictions(post: ProviderRecord, platforms: string[], assets: ProviderRecord[], targets?: ProviderRecord[], providerOwnedMediaUrls: Set<string> = new Set()): RestrictionCheck {
  const checks: RestrictionCheck[] = targets?.length && Object.keys(post.accountOverrides || {}).length ? targets.map(target => {
    const accountId = String(target._id || target.accountId?._id || target.accountId), result = validatePostForPlatforms(post, [target.platform], { assets, accountId, providerOwnedMediaUrls });
    return { ...result, errors: result.errors.map(issue => ({ ...issue, accountId })), warnings: result.warnings.map(issue => ({ ...issue, accountId })), variants: Object.fromEntries(Object.entries(result.variants).map(([platform, variant]) => [accountId + ':' + platform, variant])) };
  }) : [validatePostForPlatforms(post, platforms, { assets, providerOwnedMediaUrls })];
  const result: RestrictionCheck = { valid: checks.every(check => check.valid), errors: checks.flatMap(check => check.errors), warnings: checks.flatMap(check => check.warnings), variants: Object.assign({}, ...checks.map(check => check.variants)) };
  for (const variant of Object.values(result.variants)) checkMediaUrls(variant.mediaItems);
  return result;
}
export function assertPostRestrictions(result: RestrictionCheck): void {
  if (!result.valid) fail(422, 'POST_RESTRICTIONS', result.errors.map(item => `${item.platform}: ${item.message}`).join(' ').slice(0, 4000));
}
export async function providerPostValidation(api: ZernioApi, payload: ProviderRecord, { assets = [], providerOwnedMediaUrls = new Set() }: { assets?: ProviderRecord[]; providerOwnedMediaUrls?: Set<string> } = {}) {
  const expired = new Set(assets.filter(asset => assetDeliveryIssue(asset) && providerOwnedMediaUrls.has(asset.deliveryUrl)).map(asset => asset.deliveryUrl));
  const retained = payload.platforms.filter((target: any) => [...(target.customMedia ?? payload.mediaItems ?? []), ...(target.platformSpecificData?.threadItems || []).flatMap((item: any) => item.mediaItems || [])].some((item: any) => expired.has(item.url)));
  const warnings = retained.map((target: any) => ({ platform: target.platform, field: 'provider', message: 'Existing provider media was retained. Its temporary library link has expired; new media still needs a valid upload.' }));
  let result: ProviderRecord;
  // This account-aware check validates structure, not source URL availability; keep every retained destination.
  try { result = await api('/tools/validate/post', {}, payload); }
  catch (error) { if (error instanceof IntegrationError) error.uncertain = false; throw error; }
  const validRows = (rows: unknown, field: string) => rows === undefined || (Array.isArray(rows) && rows.length <= 200 && rows.every((item: any) => item && typeof item.platform === 'string' && item.platform.length <= 100 && typeof item[field] === 'string' && item[field].length <= 10000));
  if (!result || typeof result.valid !== 'boolean' || !validRows(result.errors, 'error') || !validRows(result.warnings, 'warning') || (!result.valid && !result.errors?.length) || (result.valid && result.errors?.length)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return a valid post restriction check.');
  return { valid: result.valid, errors: (result.errors || []).map((item: any) => ({ platform: item.platform, field: 'provider', message: item.error })), warnings: [...warnings, ...(result.warnings || []).map((item: any) => ({ platform: item.platform, field: 'provider', message: item.warning }))] };
}
export function localStatus(status: unknown): string {
  return ['published', 'failed', 'scheduled', 'draft', 'partial', 'cancelled'].includes(status as string) ? status as string : 'submitted';
}
export function providerMediaItems(items: unknown[]) {
  const fields = new Set(['type', 'url', 'title', 'altText', 'filename', 'size', 'bytes', 'mimeType', 'thumbnail', 'instagramThumbnail', 'subtitles', 'width', 'height', 'duration']);
  return normalizeMediaItems(items.map(item => {
    if (!reportObject(item)) throw new TypeError('Invalid provider media item.');
    const value: ProviderRecord = Object.fromEntries(Object.entries(item).filter(([key]) => fields.has(key)));
    if (Array.isArray(value.subtitles)) value.subtitles = value.subtitles.map((track: unknown) => reportObject(track) ? { url: track.url, language: track.language } : track);
    return value;
  }));
}
export const validProviderInstant = validPostInstant;
export function assertPostResult(remote: any, profileId: string, { id, targets, uncertain = true }: { id?: string; targets?: ProviderRecord[]; uncertain?: boolean } = {}): void {
  const validText = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\s\u0000-\u001f]/.test(value);
  const reference = (value: any) => value?._id || value;
  const invalid = (): never => { throw new IntegrationError(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not confirm the expected post and publishing accounts.', uncertain); };
  const optionalText = (value: unknown, max = 100000) => value == null || typeof value === 'string' && value.length <= max;
  const optionalDate = (value: unknown) => value == null || value === '' || validProviderInstant(value);
  const media = (items: unknown) => {
    if (items == null) return;
    // Provider responses may add fields; validate the media fields consumed by our editor without rejecting those additions.
    try { providerMediaItems(items as unknown[]); } catch { invalid(); }
  };
  const options = (value: any) => {
    if (value == null) return;
    if (!reportObject(value) || ['title', 'postType', 'mediaType', 'contentType', 'firstComment'].some(key => !optionalText(value[key]))) invalid();
    if (value.threadItems != null) {
      if (!Array.isArray(value.threadItems) || value.threadItems.length > 100) invalid();
      for (const item of value.threadItems) { if (!reportObject(item) || !optionalText(item.content)) invalid(); media(item.mediaItems); }
    }
    if (value.poll != null) {
      const poll = value.poll;
      if (!reportObject(poll) || poll.question != null && !(typeof poll.question === 'string' || reportObject(poll.question) && optionalText(poll.question.text))) invalid();
      if (poll.options != null && (!Array.isArray(poll.options) || poll.options.length > 100 || poll.options.some((item: unknown) => typeof item !== 'string'))) invalid();
      if (poll.answers != null && (!Array.isArray(poll.answers) || poll.answers.length > 100 || poll.answers.some((item: any) => !reportObject(item) || !reportObject(item.poll_media) || typeof item.poll_media.text !== 'string'))) invalid();
    }
  };
  if (!reportObject(remote) || !validText(remote._id) || id && remote._id !== id || !validText(remote.status) || remote.content !== undefined && typeof remote.content !== 'string' || remote.profileId !== undefined && reference(remote.profileId) !== profileId) invalid();
  if (!optionalDate(remote.scheduledFor) || !optionalDate(remote.publishedAt) || remote.isDraft !== undefined && typeof remote.isDraft !== 'boolean') invalid();
  if (Object.hasOwn(remote, 'tags')) try { normalizePostTags(remote.tags, { preserve: true }); } catch { invalid(); }
  media(remote.mediaItems);
  if (remote.platforms !== undefined) {
    if (!Array.isArray(remote.platforms) || !remote.platforms.length) invalid();
    for (const target of remote.platforms) {
      if (!reportObject(target) || !target.platform && !target.accountId || target.platform !== undefined && !validText(target.platform) || target.accountId !== undefined && !validText(reference(target.accountId)) || target.customContent !== undefined && typeof target.customContent !== 'string') invalid();
      if (!optionalText(target.status, 500) || !optionalText(target.platformPostUrl, 8192) || !optionalDate(target.scheduledFor) || ['errorMessage', 'errorCategory', 'errorSource'].some(key => !optionalText(target[key], 10000)) || target.error != null && !(typeof target.error === 'string' || reportObject(target.error) && optionalText(target.error.message, 10000))) invalid();
      if (reportObject(target.accountId) && ['displayName', 'username', 'name'].some(key => !optionalText(target.accountId[key], 1000))) invalid();
      if (target.platformSpecificData != null && !reportObject(target.platformSpecificData)) invalid();
      media(target.customMedia);
      try {
        const configuration = targetConfiguration(target); options(configuration.options);
        if (configuration.options) normalizePlatformOptions(target.platform, configuration.options);
      } catch { throw new IntegrationError(502, 'UNSUPPORTED_PROVIDER_OPTIONS', 'Zernio returned unsupported provider publishing options. Manage or reconcile this copy in the native dashboard before continuing.', uncertain); }
      // Zernio's minimal create receipt may omit accountId or platform. Check every identity it does return.
      if (targets && !targets.some(expected => (target.platform === undefined || target.platform === expected.platform) && (target.accountId === undefined || reference(target.accountId) === reference(expected.accountId)))) invalid();
    }
  }
}
export async function scopedPost(api: ZernioApi, profileId: string, post: ProviderRecord | null | undefined, activeOnly = false, activeAccountId?: string): Promise<ProviderRecord> {
  if (!post?.externalId || post.zernioProfileId !== profileId) fail(404, 'POST_NOT_SUBMITTED', 'No submitted post was found for this project.');
  if (post.providerDeletedAt) fail(409, 'POST_CANCELLED', 'This provider record was removed. Create a new draft to publish again.');
  const result = await api(`/posts/${encodeURIComponent(post.externalId)}`), accounts = await scopedAccounts(api, profileId);
  assertPostResult(result.post, profileId, { id: post.externalId, uncertain: false });
  if (!Array.isArray(result.post.platforms)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio did not return the submitted post.');
  for (const item of result.post.platforms) {
    const account = requireAccount(accounts, String(item.accountId?._id || item.accountId));
    if (account.platform !== item.platform) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned a post with an inconsistent account platform.');
    if (activeOnly && (activeAccountId === undefined || account._id === activeAccountId) && account.isActive === false) fail(409, 'ACCOUNT_UNAVAILABLE', 'A selected publishing account needs reconnection before this post can be submitted.');
  }
  return result.post;
}
export function targetConfiguration(target: ProviderRecord): ProviderRecord {
  let options = target.platformSpecificData;
  if (target.platform === 'tiktok' && options && typeof options === 'object') {
    const { isDraft, tiktokSettings, ...settings } = options;
    options = Object.fromEntries(Object.entries({ ...tiktokSettings, ...settings }).map(([key, value]) => [key.replace(/_([a-z])/g, (_: string, letter: string) => letter.toUpperCase()), value]));
    if (isDraft === true) options.draft = true;
  }
  if (Array.isArray(options?.threadItems)) options = { ...options, threadItems: options.threadItems.map((item: unknown) => reportObject(item) ? { ...item, ...(Array.isArray(item.mediaItems) ? { mediaItems: providerMediaItems(item.mediaItems) } : {}) } : item) };
  return { ...(typeof target.customContent === 'string' ? { content: target.customContent } : {}), ...(Array.isArray(target.customMedia) ? { mediaItems: providerMediaItems(target.customMedia) } : {}), ...(options && typeof options === 'object' ? { options } : {}) };
}
export async function remotePostModel(store: PostStore, projectId: string, post: ProviderRecord, remote: ProviderRecord): Promise<ProviderRecord> {
  const assetIds: string[] = [...new Set([post.assetId, ...Object.values(post.platformOverrides || {}).map((item: any) => item?.assetId), ...Object.values(post.accountOverrides || {}).map((item: any) => item?.assetId)].filter(id => typeof id === 'string' && id))];
  const assets = (await Promise.all(assetIds.map(id => store.get(projectId, 'assets', id)))).filter(Boolean) as ProviderRecord[], platformOverrides: ProviderRecord = {}, accountOverrides: ProviderRecord = {};
  const reference = (target: any) => String(target.accountId?._id || target.accountId), ownTime = (target: any) => target.scheduledFor && Date.parse(target.scheduledFor) !== Date.parse(remote.scheduledFor) ? target.scheduledFor : '';
  for (const platform of new Set<string>(remote.platforms.map((target: any) => target.platform))) {
    const copies: ProviderRecord[] = remote.platforms.filter((target: any) => target.platform === platform), first = targetConfiguration(copies[0]);
    const unchanged = copies.every(target => {
      try {
        const expected = buildPlatformEntry(post, platform, reference(target), assets), expectedTime = expected.scheduledFor || post.scheduledAt || post.scheduledFor || '', actualTime = target.scheduledFor || remote.scheduledFor || '';
        return canonical(targetConfiguration(expected)) === canonical(targetConfiguration(target)) && (expectedTime === actualTime || expectedTime && actualTime && Date.parse(expectedTime) === Date.parse(actualTime));
      } catch { return false; }
    });
    if (unchanged) {
      if (post.platformOverrides?.[platform]) platformOverrides[platform] = post.platformOverrides[platform];
      for (const target of copies) if (post.accountOverrides?.[reference(target)]) accountOverrides[reference(target)] = post.accountOverrides[reference(target)];
      continue;
    }
    const divergent = copies.some(target => canonical(targetConfiguration(target)) !== canonical(first) || ownTime(target) !== ownTime(copies[0]));
    const perAccount = divergent || copies.some(target => ownTime(target) || post.accountOverrides?.[reference(target)]);
    // Repeated destinations on one account cannot be represented by an account-keyed editor. Keep raw copies readable instead.
    if (perAccount && new Set(copies.map(reference)).size === copies.length) {
      for (const target of copies) {
        const id = reference(target), configuration = targetConfiguration(target), previous = post.accountOverrides?.[id] || post.platformOverrides?.[platform];
        let expected: ProviderRecord | undefined;
        try { expected = targetConfiguration(buildPlatformEntry(post, platform, id, assets)); } catch {}
        const copy: ProviderRecord = { platform, ...configuration };
        if (previous?.assetId && canonical(expected) === canonical(configuration)) { copy.assetId = previous.assetId; delete copy.mediaItems; }
        if (ownTime(target)) copy.scheduledAt = target.scheduledFor;
        else if (post.accountOverrides?.[id] && Object.hasOwn(post.accountOverrides[id], 'scheduledAt')) copy.scheduledAt = target.scheduledFor && Date.parse(target.scheduledFor) === Date.parse(post.accountOverrides[id].scheduledAt) ? target.scheduledFor : '';
        accountOverrides[id] = copy;
      }
      continue;
    }
    if (divergent || !Object.keys(first).length) continue;
    const previous = post.platformOverrides?.[platform];
    let expected: ProviderRecord | undefined;
    try { if (previous) expected = targetConfiguration(buildPlatformEntry({ ...post, accountOverrides: {} }, platform, '', assets)); } catch {}
    platformOverrides[platform] = previous && canonical(expected) === canonical(first) ? previous : first;
  }
  return { ...post, ...(Object.hasOwn(remote, 'tags') ? { tags: normalizePostTags(remote.tags, { preserve: true }) } : {}), ...(typeof remote.content === 'string' ? { content: remote.content } : {}), ...(Array.isArray(remote.mediaItems) ? { mediaItems: providerMediaItems(remote.mediaItems) } : {}), platforms: [...new Set(remote.platforms.map((target: any) => target.platform))], accounts: remote.platforms.map(reference), platformOverrides, ...(Object.keys(accountOverrides).length || Object.hasOwn(post, 'accountOverrides') ? { accountOverrides } : {}), providerResults: redact(remote.platforms), scheduledAt: remote.status === 'draft' || remote.isDraft === true ? '' : remote.scheduledFor || '' };
}
export function remoteRestrictionPayload(post: ProviderRecord, remote: ProviderRecord, { content = remote.content ?? post.content, tags = remote.tags ?? post.tags, mediaItems = remote.mediaItems ?? post.mediaItems, overrides, accountOverrides, assets = [] }: { content?: any; tags?: any; mediaItems?: any; overrides?: any; accountOverrides?: any; assets?: ProviderRecord[] } = {}): ProviderRecord {
  const platforms = remote.platforms.map((target: any) => {
    const base = { platform: target.platform, accountId: String(target.accountId?._id || target.accountId) };
    if (overrides !== undefined || accountOverrides !== undefined) {
      const entry: ProviderRecord = buildPlatformEntry({ ...post, content, mediaItems, platformOverrides: overrides ?? post.platformOverrides, accountOverrides: accountOverrides ?? post.accountOverrides }, target.platform, base.accountId, assets), namespace = target.platform === 'facebook' ? 'facebookSettings' : target.platform === 'tiktok' ? 'tiktokSettings' : null;
      if (namespace && target.platformSpecificData?.[namespace] && !Object.hasOwn(entry.platformSpecificData || {}, namespace)) entry.platformSpecificData = { ...entry.platformSpecificData, [namespace]: {} };
      return { ...entry, ...(accountOverrides === undefined && !entry.scheduledFor && target.scheduledFor ? { scheduledFor: target.scheduledFor } : {}) };
    }
    const configuration = targetConfiguration(target);
    return { ...base, ...(typeof configuration.content === 'string' ? { customContent: configuration.content } : {}), ...(configuration.mediaItems ? { customMedia: wireMediaItems(configuration.mediaItems) } : {}), ...(configuration.options ? { platformSpecificData: configuration.options } : {}), ...(target.scheduledFor ? { scheduledFor: target.scheduledFor } : {}) };
  });
  return { content: content || '', ...(tags !== undefined ? { tags: normalizePostTags(tags, { preserve: true }) } : {}), ...(mediaItems !== undefined ? { mediaItems: wireMediaItems(providerMediaItems(mediaItems)) } : {}), platforms };
}
export function validateRemotePayload(payload: ProviderRecord, assets: ProviderRecord[] = [], post: ProviderRecord = {}, providerOwnedMediaUrls: Set<string> = new Set()): void {
  for (const target of payload.platforms) {
    const variant = resolveVariant(post, target.platform, assets, String(target.accountId?._id || target.accountId)), known = [...variant.mediaItems, ...commonMedia(post, assets), ...(variant.options.threadItems || []).flatMap((item: any) => item.mediaItems || [])];
    const metadata = (items: ProviderRecord[]) => items.map(item => ({ ...known.find(existing => existing.type === item.type && existing.url === item.url), ...item }));
    const configuration = targetConfiguration(target);
    if (configuration.mediaItems) configuration.mediaItems = metadata(configuration.mediaItems);
    if (configuration.options?.threadItems) configuration.options = { ...configuration.options, threadItems: configuration.options.threadItems.map((item: any) => ({ ...item, ...(item.mediaItems ? { mediaItems: metadata(item.mediaItems) } : {}) })) };
    const single = { content: payload.content, tags: payload.tags, mediaItems: metadata(payload.mediaItems || []), platformOverrides: { [target.platform]: configuration } };
    assertPostRestrictions(postRestrictions(single, [target.platform], assets, undefined, providerOwnedMediaUrls));
  }
}
export async function savePostSnapshot(store: PostStore, projectId: string, post: ProviderRecord, remote: ProviderRecord, extra: Record<string, unknown> = {}, targets?: ProviderRecord[], source: ProviderRecord = post): Promise<ProviderRecord> {
  assertPostResult(remote, post.zernioProfileId, { id: post.externalId, targets });
  // Creation receipts can omit the submitted platform configuration; retain the draft until a full status read.
  const model = source.externalId && Array.isArray(remote.platforms) && remote.platforms.every(target => target.platform && target.accountId) ? await remotePostModel(store, projectId, post, remote) : {};
  const current = store.get(projectId, 'posts', post.id);
  if (current && canonical(current) !== canonical(source)) throw new IntegrationError(409, 'POST_CHANGED', 'The post changed during the provider request. Refresh it before continuing and review any unconfirmed provider action.', true);
  const updated = await store.update(projectId, 'posts', post.id, { ...model, ...(Object.hasOwn(remote, 'tags') ? { tags: normalizePostTags(remote.tags, { preserve: true }) } : {}), status: localStatus(remote.status), providerStatus: remote.status, ...(Array.isArray(remote.platforms) ? { providerResults: redact(remote.platforms) } : {}), ...(typeof remote.content === 'string' ? { content: remote.content } : {}), ...(remote.publishedAt ? { publishedAt: remote.publishedAt } : {}), ...extra });
  if (!updated) throw new IntegrationError(409, 'POST_REMOVED', 'The local post was removed while the provider accepted this action. Reconcile the provider outcome.', true);
  return updated;
}
export async function googleToken(env: { GOOGLE_SERVICE_ACCOUNT_EMAIL?: string; GOOGLE_PRIVATE_KEY: string }, scope = 'https://www.googleapis.com/auth/drive'): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const unsigned = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({ iss: env.GOOGLE_SERVICE_ACCOUNT_EMAIL, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 })}`;
  let signature!: string;
  try { signature = createSign('RSA-SHA256').update(unsigned).sign(env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'), 'base64url'); }
  catch { fail(503, 'DRIVE_CONFIGURATION', 'The Google service account credentials need attention.'); }
  const result = await providerRequest('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }).toString() }, 'Google Drive');
  if (typeof result.access_token !== 'string' || !result.access_token || result.access_token.length > 16384 || /[\s\u0000-\u001f]/.test(result.access_token)) fail(502, 'INVALID_PROVIDER_RESPONSE', 'Google Drive did not grant access.');
  return result.access_token;
}
