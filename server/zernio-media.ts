import type { DatabaseSync } from 'node:sqlite';
import type { OperationContext, ProviderRecord, ZernioApi } from './provider-core.ts';
import { createHash } from 'node:crypto';
import { reportObject as object, IntegrationError, operation , fail } from './provider-core.ts';
import { transaction } from './database.ts';

export const MEDIA_UPLOAD_MAX_BYTES = 5_000_000_000;
export const MEDIA_UPLOAD_TIMEOUT = 30 * 60 * 1000;
export const MEDIA_DELIVERY_FIELDS = ['deliverySource', 'deliveryUploadedAt', 'deliveryExpiresAt', 'deliveryKey', 'deliveryAttemptId', 'deliverySize', 'deliveryMimeType', 'deliveryKind', 'deliveryFilename'];
const formats = [
  ['image/jpeg', ['jpg', 'jpeg'], 'image'], ['image/jpg', ['jpg', 'jpeg'], 'image'], ['image/png', ['png'], 'image'], ['image/webp', ['webp'], 'image'], ['image/gif', ['gif'], 'image'],
  ['video/mp4', ['mp4'], 'video'], ['video/mpeg', ['mpeg', 'mpg'], 'video'], ['video/quicktime', ['mov'], 'video'], ['video/avi', ['avi'], 'video'], ['video/x-msvideo', ['avi'], 'video'], ['video/webm', ['webm'], 'video'], ['video/x-m4v', ['m4v'], 'video'], ['application/pdf', ['pdf'], 'document'],
].map(([contentType, extensions, kind]) => ({ contentType, extensions, kind }));
const initialized = new WeakSet(), grants = new WeakMap(), active = new WeakMap();
const uuid = (value: any) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fields = (body: any, allowed: any) => { if (!object(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_MEDIA_FIELDS', 'Use only the upload fields shown in this form.'); };
const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const version = (asset: any) => createHash('sha256').update(JSON.stringify(stable(asset))).digest('hex');
const canonicalMime = (mime: any) => mime === 'image/jpg' ? 'image/jpeg' : mime === 'video/avi' ? 'video/x-msvideo' : mime;
function initialize(db: DatabaseSync) {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS zernio_media_uploads(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,profile_id TEXT NOT NULL,asset_id TEXT NOT NULL,data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS zernio_media_scope ON zernio_media_uploads(project_id,user_id,profile_id,asset_id);`);
  grants.set(db, new Map()); active.set(db, new Map()); initialized.add(db);
}
export function closeMediaUploads(db: DatabaseSync) { for (const controller of active.get(db)?.values() || []) controller.abort(); grants.get(db)?.clear(); }
function presigned(response: any, filename: any) {
  const invalid = () => fail(502, 'INVALID_MEDIA_UPLOAD_GRANT', 'Zernio did not return a trusted upload destination. No file was sent.');
  if (!object(response) || response.expiresIn !== 3600 || typeof response.key !== 'string' || response.key.length > 1500 || !response.key.startsWith('temp/') || response.key.split('/').some(part => !part || ['.', '..'].includes(part)) || /[\\\u0000-\u001f\u007f]/.test(response.key)) invalid();
  let upload: any, published: any;
  try { upload = new URL(response.uploadUrl); published = new URL(response.publicUrl); } catch { invalid(); }
  if (typeof response.uploadUrl !== 'string' || response.uploadUrl.length > 16000 || upload.protocol !== 'https:' || upload.username || upload.password || upload.port || upload.hash || !/^(?:[a-z0-9][a-z0-9-]{0,62}\.)?[a-f0-9]{32}\.r2\.cloudflarestorage\.com$/i.test(upload.hostname) || typeof response.publicUrl !== 'string' || response.publicUrl.length > 4096 || published.origin !== 'https://media.zernio.com' || published.username || published.password || published.search || published.hash) invalid();
  try { if (decodeURIComponent(published.pathname) !== '/' + response.key || !decodeURIComponent(upload.pathname).endsWith('/' + response.key)) invalid(); } catch { invalid(); }
  const suffix = filename.slice(filename.lastIndexOf('.')).toLowerCase(); if (!response.key.toLowerCase().endsWith(suffix)) invalid();
  for (const key of ['X-Amz-Algorithm', 'X-Amz-Signature', 'X-Amz-Expires', 'X-Amz-Date', 'X-Amz-SignedHeaders']) if (upload.searchParams.getAll(key).length !== 1) invalid();
  const date = upload.searchParams.get('X-Amz-Date'), signature = upload.searchParams.get('X-Amz-Signature');
  if (upload.searchParams.get('X-Amz-Algorithm') !== 'AWS4-HMAC-SHA256' || upload.searchParams.get('X-Amz-Expires') !== '3600' || !/^[a-f0-9]{64}$/i.test(signature || '') || !/^\d{8}T\d{6}Z$/.test(date || '') || !upload.searchParams.get('X-Amz-SignedHeaders').split(';').includes('host')) invalid();
  const signedAt = Date.parse(date.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z')), expiresAt = Math.min(Date.now() + 3600000, signedAt + 3600000);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) invalid();
  return { uploadUrl: upload.href, publicUrl: published.href, key: response.key, uploadExpiresAt: new Date(expiresAt).toISOString() };
}

export async function handleZernioMedia(context: OperationContext & { body: any; req: any }, api: ZernioApi, profileId: any, action = '') {
  const { req, body = {}, url, db, project, user, role, store, send } = context;
  const route = /^([0-9a-f-]{36})(?:\/(content|recover|retry|cancel))?$/i.exec(action);
  if (action && action !== 'options' && (!route || !uuid(route[1]))) return false;
  if (!(req.method === 'GET' && (action === 'options' || route && !route[2]) || req.method === 'POST' && (!action || route && ['recover', 'retry', 'cancel'].includes(route[2])) || req.method === 'PUT' && route?.[2] === 'content')) fail(405, 'METHOD_NOT_ALLOWED', 'Use the available media upload controls.');
  if (!['owner', 'admin', 'editor'].includes(role)) fail(403, 'MEDIA_UPLOAD_PERMISSION_REQUIRED', 'Editing permission is required to manage hosted uploads.');
  initialize(db); const check = () => { try { context.assertProjectMapping?.(profileId); } catch (error: any) { fail(error.status || 409, 'MEDIA_SCOPE_CHANGED', 'Project access, provider mapping or integration settings changed. Refresh before continuing.'); } };
  check(); for (const [id, grant] of grants.get(db)) if (Date.parse(grant.uploadExpiresAt) <= Date.now()) grants.get(db).delete(id);
  const select = db.prepare('SELECT data FROM zernio_media_uploads WHERE id=? AND project_id=? AND user_id=? AND profile_id=?');
  const get = (id: any) => { const row = select.get(id, project.id, user.id, profileId) as ProviderRecord | undefined; if (!row) fail(404, 'MEDIA_UPLOAD_NOT_FOUND', 'This upload was not found in the current project and sign-in.'); return JSON.parse(row.data); };
  const save = (attempt: any) => { attempt.updatedAt = new Date().toISOString(); db.prepare('UPDATE zernio_media_uploads SET data=? WHERE id=? AND project_id=? AND user_id=? AND profile_id=?').run(JSON.stringify(attempt), attempt.id, project.id, user.id, profileId); return attempt; };
  const view = (attempt: any) => {
    const result = Object.fromEntries(['id', 'projectId', 'status', 'filename', 'contentType', 'size', 'publicUrl', 'uploadExpiresAt', 'uploadedAt', 'expiresAt', 'createdAt', 'updatedAt', 'assetId', 'receivedBytes', 'errorCode', 'storageMayContainFile'].filter(key => attempt[key] !== undefined).map(key => [key, attempt[key]]));
    if (attempt.status === 'completed') { const asset = store.get(project.id, 'assets', attempt.assetId); if (asset) { result.asset = asset; if (asset.deliveryAttemptId !== attempt.id) result.deliveryChanged = true; } else result.savedAssetMissing = true; }
    return result;
  };
  const current = (attempt: any) => { if (attempt.status === 'preparing' && !active.get(db).has(attempt.id)) return save({ ...attempt, status: 'preparation_failed', errorCode: 'MEDIA_PREPARATION_INTERRUPTED' }); if (attempt.status === 'uploading' && !active.get(db).has(attempt.id)) return save({ ...attempt, status: 'transfer_uncertain', errorCode: 'MEDIA_TRANSFER_INTERRUPTED', storageMayContainFile: true }); if (attempt.status === 'awaiting_upload' && Date.parse(attempt.uploadExpiresAt) <= Date.now()) return save({ ...attempt, status: 'expired', errorCode: 'MEDIA_UPLOAD_GRANT_EXPIRED' }); return attempt; };
  function checkedAsset(attempt: any) {
    if (!attempt.targetAssetId) return null;
    const asset = store.get(project.id, 'assets', attempt.targetAssetId);
    if (!asset || asset.sample || version(asset) !== attempt.assetVersion) fail(409, 'MEDIA_ASSET_CHANGED', 'The original asset changed or was removed. Keep this upload separate and review a new upload target.');
    return asset;
  }
  async function prepare(attempt: any) {
    check(); checkedAsset(attempt); let response: any;
    try { response = await api('/media/presign', {}, { filename: attempt.filename, contentType: attempt.contentType, size: attempt.size }); }
    catch (error: any) { if (error instanceof IntegrationError) error.uncertain = false; const fresh = get(attempt.id); if (fresh.status === 'cancelled') return fresh; save({ ...fresh, status: 'preparation_failed', errorCode: 'MEDIA_PREPARATION_FAILED' }); throw error; }
    try {
      const grant = presigned(response, attempt.filename); check(); checkedAsset(attempt);
      const fresh = get(attempt.id); if (fresh.status === 'cancelled') return fresh;
      grants.get(db).set(attempt.id, grant);
      return save({ ...fresh, publicUrl: grant.publicUrl, key: grant.key, uploadExpiresAt: grant.uploadExpiresAt, status: 'awaiting_upload', errorCode: undefined, receivedBytes: 0, uploadedAt: undefined, expiresAt: undefined, transferHash: undefined, storageMayContainFile: fresh.storageMayContainFile === true });
    } catch (error: any) { if (error instanceof IntegrationError) error.uncertain = false; const fresh = get(attempt.id); if (fresh.status !== 'cancelled') save({ ...fresh, status: 'preparation_failed', errorCode: 'MEDIA_PREPARATION_FAILED' }); throw error; }
  }
  async function inspect(attempt: any) {
    if (!attempt.publicUrl) return false;
    check(); let result; try { result = await api('/tools/validate/media', {}, { url: attempt.publicUrl }); } catch (error: any) { if (error instanceof IntegrationError) error.uncertain = false; throw error; } check();
    if (!object(result) || typeof result.valid !== 'boolean') fail(502, 'INVALID_MEDIA_INSPECTION', 'The uploaded file could not be verified. Recheck this attempt before uploading again.');
    if (result.valid === false) return false;
    if (result.url !== undefined && result.url !== attempt.publicUrl || !Number.isSafeInteger(result.size) || result.size !== attempt.size || typeof result.contentType !== 'string' || canonicalMime(result.contentType.toLowerCase()) !== canonicalMime(attempt.contentType)) fail(409, 'MEDIA_INSPECTION_MISMATCH', 'The hosted file URL, size or file type did not match this upload. No asset was saved.');
    return true;
  }
  async function exclusive(id: any, run: any) {
    if (active.get(db).has(id)) fail(409, 'MEDIA_UPLOAD_IN_PROGRESS', 'This upload is still being transferred or checked. Wait before retrying.');
    const controller = new AbortController(); active.get(db).set(id, controller);
    try { return await run(controller); } finally { if (active.get(db).get(id) === controller) active.get(db).delete(id); }
  }
  if (action === 'options') {
    if ([...url.searchParams.keys()].some(key => key !== 'assetId')) fail(400, 'INVALID_MEDIA_FILTER', 'Choose a current asset or a new upload.');
    const assetId = url.searchParams.get('assetId') || '', asset = assetId ? store.get(project.id, 'assets', assetId) : null;
    if (assetId && (!asset || asset.sample)) fail(404, 'MEDIA_ASSET_NOT_FOUND', 'Choose an existing, nonsample asset in this project.');
    const attempts = db.prepare('SELECT data FROM zernio_media_uploads WHERE project_id=? AND user_id=? AND profile_id=? AND asset_id=? ORDER BY rowid DESC LIMIT 20').all(project.id, user.id, profileId, assetId).map((row: any) => view(current(JSON.parse(row.data)))); check();
    send(200, { maxSize: MEDIA_UPLOAD_MAX_BYTES, maxFilenameLength: 255, formats, attempts, ...(asset ? { asset, assetVersion: version(asset) } : {}) }); return true;
  }
  if (!action) {
    fields(body, ['attemptId', 'filename', 'contentType', 'size', 'assetId', 'assetVersion']);
    const format = formats.find(row => row.contentType === body.contentType), extension = typeof body.filename === 'string' ? body.filename.slice(body.filename.lastIndexOf('.') + 1).toLowerCase() : '';
    if (!uuid(body.attemptId) || typeof body.filename !== 'string' || !body.filename.trim() || body.filename.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(body.filename) || !format || !format.extensions.includes(extension) || !Number.isSafeInteger(body.size) || body.size < 1 || body.size > MEDIA_UPLOAD_MAX_BYTES || body.assetId !== undefined && (typeof body.assetId !== 'string' || body.assetId.length > 200) || body.assetVersion !== undefined && (typeof body.assetVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.assetVersion))) fail(400, 'INVALID_MEDIA_FILE', 'Choose a matching image, video or PDF file between one byte and 5 GB.');
    if (Boolean(body.assetId) !== Boolean(body.assetVersion)) fail(400, 'MEDIA_ASSET_REVIEW_REQUIRED', 'Review the current replacement asset before uploading.');
    const input = { filename: body.filename, contentType: body.contentType, kind: format.kind, size: body.size, targetAssetId: body.assetId || '', assetVersion: body.assetVersion || '' }, inputHash = version(input);
    const row = db.prepare('SELECT data FROM zernio_media_uploads WHERE id=?').get(body.attemptId);
    if (row) { const attempt = get(body.attemptId); if (attempt.inputHash !== inputHash) fail(409, 'MEDIA_ATTEMPT_CONFLICT', 'This upload ID belongs to a different file or asset review.'); send(200, { attempt: view(current(attempt)) }); return true; }
    if (db.prepare('SELECT count(*) AS count FROM zernio_media_uploads WHERE project_id=? AND user_id=? AND profile_id=? AND json_extract(data,\'$.status\') NOT IN (\'completed\',\'cancelled\') AND json_extract(data,\'$.createdAt\')>?').get(project.id, user.id, profileId, new Date(Date.now() - 3600000).toISOString())!.count as number >= 20) fail(429, 'MEDIA_UPLOAD_LIMIT', 'Finish or cancel existing uploads before preparing more files.');
    check(); const now = new Date().toISOString(), attempt = { id: body.attemptId, projectId: project.id, ...input, inputHash, status: 'preparing', createdAt: now, updatedAt: now }; checkedAsset(attempt);
    db.prepare('INSERT INTO zernio_media_uploads VALUES(?,?,?,?,?,?)').run(attempt.id, project.id, user.id, profileId, attempt.targetAssetId, JSON.stringify(attempt));
    send(200, { attempt: view(await exclusive(attempt.id, () => prepare(attempt))) }); return true;
  }
  let attempt = current(get(route![1]));
  if (req.method === 'GET') { check(); send(200, { attempt: view(attempt) }); return true; }
  if (route![2] === 'cancel') {
    fields(body, []); check();
    if (attempt.status !== 'completed' && attempt.status !== 'cancelled') attempt = save({ ...attempt, status: 'cancelled', storageMayContainFile: ['uploading', 'uploaded', 'transfer_uncertain'].includes(attempt.status) || attempt.storageMayContainFile });
    grants.get(db).delete(attempt.id); active.get(db).get(attempt.id)?.abort(); send(200, { attempt: view(attempt), storageRevoked: false }); return true;
  }
  if (route![2] === 'content') {
    if (attempt.status === 'completed' || attempt.status === 'cancelled') { req.resume(); send(200, { attempt: view(attempt) }); return true; }
    if (attempt.status !== 'awaiting_upload') fail(409, 'MEDIA_TRANSFER_RECHECK_REQUIRED', 'Recheck the previous transfer outcome before sending this file again.');
    const grant = grants.get(db).get(attempt.id);
    if (!grant || Date.parse(grant.uploadExpiresAt) <= Date.now()) fail(409, 'MEDIA_UPLOAD_GRANT_EXPIRED', 'Recheck and retry this upload to prepare a fresh transfer.');
    if (req.headers['content-type'] !== attempt.contentType || !/^\d{1,12}$/.test(req.headers['content-length'] || '') || Number(req.headers['content-length']) !== attempt.size || req.headers['transfer-encoding'] || req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') fail(400, 'MEDIA_TRANSFER_HEADERS_INVALID', 'Send the selected file with its exact file type and byte length.');
    await exclusive(attempt.id, async (controller: any) => {
      check(); checkedAsset(attempt); const uploadedAt = new Date().toISOString(); attempt = save({ ...attempt, status: 'uploading', uploadedAt, expiresAt: new Date(Date.parse(uploadedAt) + 7 * 86400000).toISOString(), storageMayContainFile: true, receivedBytes: 0 });
      let receivedBytes = 0; const hash = createHash('sha256'), abort = () => controller.abort(); req.once('aborted', abort);
      async function* chunks() {
        for await (const chunk of req.iterator({ destroyOnReturn: false })) { check(); receivedBytes += chunk.length; if (receivedBytes > attempt.size) throw new Error('Invalid upload length'); hash.update(chunk); yield chunk; }
        if (receivedBytes !== attempt.size) throw new Error('Incomplete upload');
        const fresh = get(attempt.id); if (fresh.status !== 'cancelled') save({ ...fresh, receivedBytes, transferHash: hash.digest('hex') });
      }
      try {
        const response = await fetch(grant.uploadUrl, { method: 'PUT', headers: { 'Content-Type': attempt.contentType, 'Content-Length': String(attempt.size) }, body: chunks(), duplex: 'half', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(MEDIA_UPLOAD_TIMEOUT)]) });
        await response.body?.cancel(); if (response.status !== 200 || receivedBytes !== attempt.size) throw new Error('Storage did not confirm upload');
        check(); const fresh = get(attempt.id); if (fresh.status !== 'cancelled') attempt = save({ ...fresh, status: 'uploaded', errorCode: undefined, receivedBytes }); else attempt = fresh;
      } catch {
        const fresh = get(attempt.id); attempt = fresh.status === 'cancelled' ? fresh : save({ ...fresh, status: 'transfer_uncertain', errorCode: 'MEDIA_TRANSFER_UNCERTAIN', receivedBytes, storageMayContainFile: true });
      } finally { req.off('aborted', abort); grants.get(db).delete(attempt.id); if (!req.complete) req.resume(); }
    }); check(); send(200, { attempt: view(attempt) }); return true;
  }
  fields(body, []);
  return exclusive(attempt.id, async () => {
    const reply = (attempt: any) => { send(200, { attempt: view(attempt) }); return true; };
    attempt = current(get(attempt.id)); check(); if (attempt.status === 'completed' || attempt.status === 'cancelled') return reply(attempt);
    checkedAsset(attempt);
    const present = await inspect(attempt); attempt = get(attempt.id); check(); if (attempt.status === 'cancelled') return reply(attempt);
    if (route![2] === 'retry') {
      if (present) return reply(save({ ...attempt, status: 'uploaded', errorCode: undefined }));
      if (attempt.status === 'awaiting_upload' && grants.get(db).has(attempt.id)) return reply(attempt);
      return reply(await prepare(attempt));
    }
    if (!present) return reply(save({ ...attempt, status: attempt.publicUrl ? 'transfer_uncertain' : 'preparation_failed', errorCode: 'MEDIA_NOT_CONFIRMED' }));
    if (!attempt.uploadedAt || !attempt.expiresAt || Date.parse(attempt.expiresAt) <= Date.now()) fail(409, 'MEDIA_DELIVERY_EXPIRED', 'This temporary upload has expired or has no confirmed transfer time. Upload a fresh file.');
    const outcome = await operation(context, () => transaction(db, () => {
      check(); const fresh = get(attempt.id); if (fresh.status === 'cancelled') return { attempt: view(fresh) }; if (fresh.status === 'completed') return { attempt: view(fresh) };
      const previous = checkedAsset(fresh), delivery = { deliveryUrl: fresh.publicUrl, deliverySource: 'zernio', deliveryUploadedAt: fresh.uploadedAt, deliveryExpiresAt: fresh.expiresAt, deliveryKey: fresh.key, deliveryAttemptId: fresh.id, deliverySize: fresh.size, deliveryMimeType: canonicalMime(fresh.contentType), deliveryKind: fresh.kind, deliveryFilename: fresh.filename, approval: 'pending' };
      const asset = previous ? store.update(project.id, 'assets', previous.id, delivery) : store.create(project.id, 'assets', { name: fresh.filename.slice(0, 250), url: fresh.publicUrl, source: 'zernio', kind: fresh.kind, mimeType: canonicalMime(fresh.contentType), size: fresh.size, filename: fresh.filename, tags: [], ...delivery });
      attempt = save({ ...fresh, status: 'completed', assetId: asset.id, errorCode: undefined }); grants.get(db).delete(attempt.id); store.activity(project.id, 'Hosted delivery asset saved for review.'); return { attempt: view(attempt) };
    }) as any, ['media-upload', attempt.id]); send(outcome.status, outcome.data); return true;
  });
}
