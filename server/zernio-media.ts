import type { OperationContext, ProviderRecord, ZernioApi } from './provider-core.ts';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { reportObject as object, IntegrationError, operation , fail } from './provider-core.ts';
import { createStore } from './database.ts';
import type { Executor } from './database.ts';
import { advisoryLock } from './auth.ts';

export const MEDIA_UPLOAD_MAX_BYTES = 5_000_000_000;
export const MEDIA_UPLOAD_TIMEOUT = 30 * 60 * 1000;
export const MEDIA_DELIVERY_FIELDS = ['deliverySource', 'deliveryUploadedAt', 'deliveryExpiresAt', 'deliveryKey', 'deliveryAttemptId', 'deliverySize', 'deliveryMimeType', 'deliveryKind', 'deliveryFilename'];
const formats = [
  ['image/jpeg', ['jpg', 'jpeg'], 'image'], ['image/jpg', ['jpg', 'jpeg'], 'image'], ['image/png', ['png'], 'image'], ['image/webp', ['webp'], 'image'], ['image/gif', ['gif'], 'image'],
  ['video/mp4', ['mp4'], 'video'], ['video/mpeg', ['mpeg', 'mpg'], 'video'], ['video/quicktime', ['mov'], 'video'], ['video/avi', ['avi'], 'video'], ['video/x-msvideo', ['avi'], 'video'], ['video/webm', ['webm'], 'video'], ['video/x-m4v', ['m4v'], 'video'], ['application/pdf', ['pdf'], 'document'],
].map(([contentType, extensions, kind]) => ({ contentType, extensions, kind }));
// Process-local upload state: signed transfer grants, and the attempts whose preparation or transfer runs in this process.
// An attempt left preparing or uploading outside this process's active set is reported as interrupted.
const grants = new Map<string, ProviderRecord>(), active = new Map<string, AbortController>();
const uuid = (value: any) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const fields = (body: any, allowed: any) => { if (!object(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_MEDIA_FIELDS', 'Use only the upload fields shown in this form.'); };
const stable = (value: any): any => Array.isArray(value) ? value.map(stable) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const version = (asset: any) => createHash('sha256').update(JSON.stringify(stable(asset))).digest('hex');
const canonicalMime = (mime: any) => mime === 'image/jpg' ? 'image/jpeg' : mime === 'video/avi' ? 'video/x-msvideo' : mime;
export function closeMediaUploads() { for (const controller of active.values()) controller.abort(); grants.clear(); }
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
  const check = async () => { try { await context.assertProjectMapping?.(profileId); } catch (error: any) { fail(error.status || 409, 'MEDIA_SCOPE_CHANGED', 'Project access, provider mapping or integration settings changed. Refresh before continuing.'); } };
  await check(); for (const [id, grant] of grants) if (Date.parse(grant.uploadExpiresAt) <= Date.now()) grants.delete(id);
  const get = async (id: any, executor: Executor = db, lock = false) => { const row = (await executor.execute(sql`SELECT data FROM zernio_media_uploads WHERE id=${id} AND project_id=${project.id} AND user_id=${user.id} AND profile_id=${profileId}${lock ? sql` FOR UPDATE` : sql``}`)).rows[0] as ProviderRecord | undefined; if (!row) fail(404, 'MEDIA_UPLOAD_NOT_FOUND', 'This upload was not found in the current project and sign-in.'); return row.data; };
  // Completed and cancelled are terminal. The conditional write stops a concurrent cancel, transfer or completion from
  // overwriting one; the stored terminal attempt is returned instead.
  const save = async (attempt: any, executor: Executor = db) => { attempt.updatedAt = new Date().toISOString(); const saved = await executor.execute(sql`UPDATE zernio_media_uploads SET data=${JSON.stringify(attempt)} WHERE id=${attempt.id} AND project_id=${project.id} AND user_id=${user.id} AND profile_id=${profileId} AND data->>'status' NOT IN ('completed','cancelled')`); return saved.rowCount ? attempt : get(attempt.id, executor); };
  const view = async (attempt: any, records = store) => {
    const result = Object.fromEntries(['id', 'projectId', 'status', 'filename', 'contentType', 'size', 'publicUrl', 'uploadExpiresAt', 'uploadedAt', 'expiresAt', 'createdAt', 'updatedAt', 'assetId', 'receivedBytes', 'errorCode', 'storageMayContainFile'].filter(key => attempt[key] !== undefined).map(key => [key, attempt[key]]));
    if (attempt.status === 'completed') { const asset = await records.get(project.id, 'assets', attempt.assetId); if (asset) { result.asset = asset; if (asset.deliveryAttemptId !== attempt.id) result.deliveryChanged = true; } else result.savedAssetMissing = true; }
    return result;
  };
  const current = async (attempt: any) => { if (attempt.status === 'preparing' && !active.has(attempt.id)) return save({ ...attempt, status: 'preparation_failed', errorCode: 'MEDIA_PREPARATION_INTERRUPTED' }); if (attempt.status === 'uploading' && !active.has(attempt.id)) return save({ ...attempt, status: 'transfer_uncertain', errorCode: 'MEDIA_TRANSFER_INTERRUPTED', storageMayContainFile: true }); if (attempt.status === 'awaiting_upload' && Date.parse(attempt.uploadExpiresAt) <= Date.now()) return save({ ...attempt, status: 'expired', errorCode: 'MEDIA_UPLOAD_GRANT_EXPIRED' }); return attempt; };
  async function checkedAsset(attempt: any, records = store) {
    if (!attempt.targetAssetId) return null;
    const asset = await records.get(project.id, 'assets', attempt.targetAssetId);
    if (!asset || asset.sample || version(asset) !== attempt.assetVersion) fail(409, 'MEDIA_ASSET_CHANGED', 'The original asset changed or was removed. Keep this upload separate and review a new upload target.');
    return asset;
  }
  async function prepare(attempt: any) {
    await check(); await checkedAsset(attempt); let response: any;
    try { response = await api('/media/presign', {}, { filename: attempt.filename, contentType: attempt.contentType, size: attempt.size }); }
    catch (error: any) { if (error instanceof IntegrationError) error.uncertain = false; const fresh = await get(attempt.id); if (fresh.status === 'cancelled') return fresh; await save({ ...fresh, status: 'preparation_failed', errorCode: 'MEDIA_PREPARATION_FAILED' }); throw error; }
    try {
      const grant = presigned(response, attempt.filename); await check(); await checkedAsset(attempt);
      const fresh = await get(attempt.id); if (fresh.status === 'cancelled') return fresh;
      grants.set(attempt.id, grant);
      return await save({ ...fresh, publicUrl: grant.publicUrl, key: grant.key, uploadExpiresAt: grant.uploadExpiresAt, status: 'awaiting_upload', errorCode: undefined, receivedBytes: 0, uploadedAt: undefined, expiresAt: undefined, transferHash: undefined, storageMayContainFile: fresh.storageMayContainFile === true });
    } catch (error: any) { if (error instanceof IntegrationError) error.uncertain = false; const fresh = await get(attempt.id); if (fresh.status !== 'cancelled') await save({ ...fresh, status: 'preparation_failed', errorCode: 'MEDIA_PREPARATION_FAILED' }); throw error; }
  }
  async function inspect(attempt: any) {
    if (!attempt.publicUrl) return false;
    await check(); let result; try { result = await api('/tools/validate/media', {}, { url: attempt.publicUrl }); } catch (error: any) { if (error instanceof IntegrationError) error.uncertain = false; throw error; } await check();
    if (!object(result) || typeof result.valid !== 'boolean') fail(502, 'INVALID_MEDIA_INSPECTION', 'The uploaded file could not be verified. Recheck this attempt before uploading again.');
    if (result.valid === false) return false;
    if (result.url !== undefined && result.url !== attempt.publicUrl || !Number.isSafeInteger(result.size) || result.size !== attempt.size || typeof result.contentType !== 'string' || canonicalMime(result.contentType.toLowerCase()) !== canonicalMime(attempt.contentType)) fail(409, 'MEDIA_INSPECTION_MISMATCH', 'The hosted file URL, size or file type did not match this upload. No asset was saved.');
    return true;
  }
  async function exclusive(id: any, run: any) {
    if (active.has(id)) fail(409, 'MEDIA_UPLOAD_IN_PROGRESS', 'This upload is still being transferred or checked. Wait before retrying.');
    const controller = new AbortController(); active.set(id, controller);
    try { return await run(controller); } finally { if (active.get(id) === controller) active.delete(id); }
  }
  if (action === 'options') {
    if ([...url.searchParams.keys()].some(key => key !== 'assetId')) fail(400, 'INVALID_MEDIA_FILTER', 'Choose a current asset or a new upload.');
    const assetId = url.searchParams.get('assetId') || '', asset = assetId ? await store.get(project.id, 'assets', assetId) : null;
    if (assetId && (!asset || asset.sample)) fail(404, 'MEDIA_ASSET_NOT_FOUND', 'Choose an existing, nonsample asset in this project.');
    const attempts = [];
    for (const row of (await db.execute(sql`SELECT data FROM zernio_media_uploads WHERE project_id=${project.id} AND user_id=${user.id} AND profile_id=${profileId} AND asset_id=${assetId} ORDER BY seq DESC LIMIT 20`)).rows as ProviderRecord[]) attempts.push(await view(await current(row.data)));
    await check();
    send(200, { maxSize: MEDIA_UPLOAD_MAX_BYTES, maxFilenameLength: 255, formats, attempts, ...(asset ? { asset, assetVersion: version(asset) } : {}) }); return true;
  }
  if (!action) {
    fields(body, ['attemptId', 'filename', 'contentType', 'size', 'assetId', 'assetVersion']);
    const format = formats.find(row => row.contentType === body.contentType), extension = typeof body.filename === 'string' ? body.filename.slice(body.filename.lastIndexOf('.') + 1).toLowerCase() : '';
    if (!uuid(body.attemptId) || typeof body.filename !== 'string' || !body.filename.trim() || body.filename.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(body.filename) || !format || !format.extensions.includes(extension) || !Number.isSafeInteger(body.size) || body.size < 1 || body.size > MEDIA_UPLOAD_MAX_BYTES || body.assetId !== undefined && (typeof body.assetId !== 'string' || body.assetId.length > 200) || body.assetVersion !== undefined && (typeof body.assetVersion !== 'string' || !/^[a-f0-9]{64}$/.test(body.assetVersion))) fail(400, 'INVALID_MEDIA_FILE', 'Choose a matching image, video or PDF file between one byte and 5 GB.');
    if (Boolean(body.assetId) !== Boolean(body.assetVersion)) fail(400, 'MEDIA_ASSET_REVIEW_REQUIRED', 'Review the current replacement asset before uploading.');
    const input = { filename: body.filename, contentType: body.contentType, kind: format.kind, size: body.size, targetAssetId: body.assetId || '', assetVersion: body.assetVersion || '' }, inputHash = version(input);
    const existing = async () => { const attempt = await get(body.attemptId); if (attempt.inputHash !== inputHash) fail(409, 'MEDIA_ATTEMPT_CONFLICT', 'This upload ID belongs to a different file or asset review.'); send(200, { attempt: await view(await current(attempt)) }); return true; };
    if ((await db.execute(sql`SELECT 1 FROM zernio_media_uploads WHERE id=${body.attemptId}`)).rowCount) return existing();
    const now = new Date().toISOString(), attempt = { id: body.attemptId, projectId: project.id, ...input, inputHash, status: 'preparing', createdAt: now, updatedAt: now };
    let prepared: any = null;
    await exclusive(attempt.id, async () => {
      const inserted = await db.transaction(async tx => {
        // Serialises this user's new attempts so parallel requests cannot pass the open-upload limit together.
        await advisoryLock(tx, 'media-uploads:' + JSON.stringify([project.id, user.id, profileId]));
        const open = (await tx.execute(sql`SELECT count(*) AS count FROM zernio_media_uploads WHERE project_id=${project.id} AND user_id=${user.id} AND profile_id=${profileId} AND data->>'status' NOT IN ('completed','cancelled') AND data->>'createdAt' > ${new Date(Date.now() - 3600000).toISOString()}`)).rows[0] as ProviderRecord;
        if (open.count >= 20) fail(429, 'MEDIA_UPLOAD_LIMIT', 'Finish or cancel existing uploads before preparing more files.');
        await check(); await checkedAsset(attempt);
        return (await tx.execute(sql`INSERT INTO zernio_media_uploads (id, project_id, user_id, profile_id, asset_id, data) VALUES (${attempt.id}, ${project.id}, ${user.id}, ${profileId}, ${attempt.targetAssetId}, ${JSON.stringify(attempt)}) ON CONFLICT (id) DO NOTHING`)).rowCount;
      });
      if (inserted) prepared = await prepare(attempt);
    });
    // A parallel request with the same attempt ID inserted it first: answer as a repeat of that attempt.
    if (!prepared) return existing();
    send(200, { attempt: await view(prepared) }); return true;
  }
  let attempt = await current(await get(route![1]));
  if (req.method === 'GET') { await check(); send(200, { attempt: await view(attempt) }); return true; }
  if (route![2] === 'cancel') {
    fields(body, []); await check();
    if (attempt.status !== 'completed' && attempt.status !== 'cancelled') attempt = await save({ ...attempt, status: 'cancelled', storageMayContainFile: ['uploading', 'uploaded', 'transfer_uncertain'].includes(attempt.status) || attempt.storageMayContainFile });
    grants.delete(attempt.id); active.get(attempt.id)?.abort(); send(200, { attempt: await view(attempt), storageRevoked: false }); return true;
  }
  if (route![2] === 'content') {
    if (attempt.status === 'completed' || attempt.status === 'cancelled') { req.resume(); send(200, { attempt: await view(attempt) }); return true; }
    if (attempt.status !== 'awaiting_upload') fail(409, 'MEDIA_TRANSFER_RECHECK_REQUIRED', 'Recheck the previous transfer outcome before sending this file again.');
    const grant = grants.get(attempt.id);
    if (!grant || Date.parse(grant.uploadExpiresAt) <= Date.now()) fail(409, 'MEDIA_UPLOAD_GRANT_EXPIRED', 'Recheck and retry this upload to prepare a fresh transfer.');
    if (req.headers['content-type'] !== attempt.contentType || !/^\d{1,12}$/.test(req.headers['content-length'] || '') || Number(req.headers['content-length']) !== attempt.size || req.headers['transfer-encoding'] || req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') fail(400, 'MEDIA_TRANSFER_HEADERS_INVALID', 'Send the selected file with its exact file type and byte length.');
    await exclusive(attempt.id, async (controller: any) => {
      await check(); await checkedAsset(attempt); const uploadedAt = new Date().toISOString(); attempt = await save({ ...attempt, status: 'uploading', uploadedAt, expiresAt: new Date(Date.parse(uploadedAt) + 7 * 86400000).toISOString(), storageMayContainFile: true, receivedBytes: 0 });
      let receivedBytes = 0; const hash = createHash('sha256'), abort = () => controller.abort(); req.once('aborted', abort);
      async function* chunks() {
        for await (const chunk of req.iterator({ destroyOnReturn: false })) { await check(); receivedBytes += chunk.length; if (receivedBytes > attempt.size) throw new Error('Invalid upload length'); hash.update(chunk); yield chunk; }
        if (receivedBytes !== attempt.size) throw new Error('Incomplete upload');
        const fresh = await get(attempt.id); if (fresh.status !== 'cancelled') await save({ ...fresh, receivedBytes, transferHash: hash.digest('hex') });
      }
      try {
        const response = await fetch(grant.uploadUrl, { method: 'PUT', headers: { 'Content-Type': attempt.contentType, 'Content-Length': String(attempt.size) }, body: chunks(), duplex: 'half', redirect: 'error', signal: AbortSignal.any([controller.signal, AbortSignal.timeout(MEDIA_UPLOAD_TIMEOUT)]) });
        await response.body?.cancel(); if (response.status !== 200 || receivedBytes !== attempt.size) throw new Error('Storage did not confirm upload');
        await check(); const fresh = await get(attempt.id); if (fresh.status !== 'cancelled') attempt = await save({ ...fresh, status: 'uploaded', errorCode: undefined, receivedBytes }); else attempt = fresh;
      } catch {
        const fresh = await get(attempt.id); attempt = fresh.status === 'cancelled' ? fresh : await save({ ...fresh, status: 'transfer_uncertain', errorCode: 'MEDIA_TRANSFER_UNCERTAIN', receivedBytes, storageMayContainFile: true });
      } finally { req.off('aborted', abort); grants.delete(attempt.id); if (!req.complete) req.resume(); }
    }); await check(); send(200, { attempt: await view(attempt) }); return true;
  }
  fields(body, []);
  return exclusive(attempt.id, async () => {
    const reply = async (attempt: any) => { send(200, { attempt: await view(attempt) }); return true; };
    attempt = await current(await get(attempt.id)); await check(); if (attempt.status === 'completed' || attempt.status === 'cancelled') return reply(attempt);
    await checkedAsset(attempt);
    const present = await inspect(attempt); attempt = await get(attempt.id); await check(); if (attempt.status === 'cancelled') return reply(attempt);
    if (route![2] === 'retry') {
      if (present) return reply(await save({ ...attempt, status: 'uploaded', errorCode: undefined }));
      if (attempt.status === 'awaiting_upload' && grants.has(attempt.id)) return reply(attempt);
      return reply(await prepare(attempt));
    }
    if (!present) return reply(await save({ ...attempt, status: attempt.publicUrl ? 'transfer_uncertain' : 'preparation_failed', errorCode: 'MEDIA_NOT_CONFIRMED' }));
    if (!attempt.uploadedAt || !attempt.expiresAt || Date.parse(attempt.expiresAt) <= Date.now()) fail(409, 'MEDIA_DELIVERY_EXPIRED', 'This temporary upload has expired or has no confirmed transfer time. Upload a fresh file.');
    const outcome = await operation(context, () => db.transaction(async tx => {
      const records = createStore(tx);
      // The attempt row lock makes a concurrent cancel wait for this completion; the asset row lock keeps the reviewed
      // asset version from changing between its check and the delivery update.
      await check(); const fresh = await get(attempt.id, tx, true); if (fresh.status === 'cancelled') return { attempt: await view(fresh, records) }; if (fresh.status === 'completed') return { attempt: await view(fresh, records) };
      if (fresh.targetAssetId) await tx.execute(sql`SELECT id FROM records WHERE id=${fresh.targetAssetId} AND project_id=${project.id} FOR UPDATE`);
      const previous = await checkedAsset(fresh, records), delivery = { deliveryUrl: fresh.publicUrl, deliverySource: 'zernio', deliveryUploadedAt: fresh.uploadedAt, deliveryExpiresAt: fresh.expiresAt, deliveryKey: fresh.key, deliveryAttemptId: fresh.id, deliverySize: fresh.size, deliveryMimeType: canonicalMime(fresh.contentType), deliveryKind: fresh.kind, deliveryFilename: fresh.filename, approval: 'pending' };
      const asset = previous ? await records.update(project.id, 'assets', previous.id, delivery) : await records.create(project.id, 'assets', { name: fresh.filename.slice(0, 250), url: fresh.publicUrl, source: 'zernio', kind: fresh.kind, mimeType: canonicalMime(fresh.contentType), size: fresh.size, filename: fresh.filename, tags: [], ...delivery });
      attempt = await save({ ...fresh, status: 'completed', assetId: asset!.id, errorCode: undefined }, tx); grants.delete(attempt.id); await records.activity(project.id, 'Hosted delivery asset saved for review.'); return { attempt: await view(attempt, records) };
    }), ['media-upload', attempt.id]); send(outcome.status, outcome.data); return true;
  });
}
