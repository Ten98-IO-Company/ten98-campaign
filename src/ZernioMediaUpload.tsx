import { useEffect, useRef, useState } from 'react';

type Format = { contentType: string; extensions: string[]; kind: 'image' | 'video' | 'document' };
type Options = { maxSize: number; formats: Format[]; asset?: { id: string; name?: string; url?: string }; assetVersion?: string; attempts?: Attempt[] };
type Attempt = { id: string; projectId: string; filename: string; contentType: string; size: number; status: string; expiresAt?: string; assetId?: string; savedAssetMissing?: boolean; deliveryChanged?: boolean; asset?: { id: string; [key: string]: any } };
type Props = { projectId: string; configured: boolean; disabled?: boolean; assetId?: string; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>; onSaved: (asset: { id: string; [key: string]: any }) => void };
const statuses = ['preparing', 'awaiting_upload', 'uploading', 'transfer_uncertain', 'uploaded', 'completed', 'cancelled', 'preparation_failed', 'expired'];
const labels: Record<string, string> = { preparing: 'Preparing upload', awaiting_upload: 'Ready to transfer', uploading: 'Transferring file', transfer_uncertain: 'Transfer needs checking', uploaded: 'File received; save the delivery asset', completed: 'Delivery asset saved', cancelled: 'Upload cancelled', preparation_failed: 'Preparation failed', expired: 'Temporary upload expired' };

export function mediaFileMetadata(file: Pick<File, 'name' | 'type' | 'size'>, options: Options) {
  const filename = file.name;
  if (!filename.trim() || filename.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(filename) || ['.', '..'].includes(filename)) throw new Error('Choose a file with a plain filename of up to 255 characters.');
  if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > options.maxSize) throw new Error(`Choose a non-empty file no larger than ${(options.maxSize / 1_000_000_000).toLocaleString()} GB.`);
  const matches = options.formats.filter(format => format.extensions.some(extension => filename.toLowerCase().endsWith('.' + extension.replace(/^\./, '').toLowerCase())));
  const format = file.type ? matches.find(item => item.contentType === file.type.toLowerCase()) : matches[0];
  if (!format) throw new Error('The filename and file type must match a supported image, video or PDF format.');
  return { filename, contentType: format.contentType, size: file.size };
}

export default function ZernioMediaUpload({ projectId, configured, disabled = false, assetId, request, onSaved }: Props) {
  const path = `/projects/${encodeURIComponent(projectId)}/integrations/media/uploads`;
  const [options, setOptions] = useState<Options | null>(null), [file, setFile] = useState<File | null>(null), [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(''), [progress, setProgress] = useState<number | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [refresh, setRefresh] = useState(0);
  const mounted = useRef(true), identity = useRef({ projectId, assetId, configured, disabled }), pending = useRef<object | null>(null), transfer = useRef<XMLHttpRequest | null>(null), knownAttempt = useRef(''), keys = useRef(new Map<string, string>()), notified = useRef(new Set<string>());
  if (identity.current.projectId !== projectId || identity.current.assetId !== assetId || identity.current.configured !== configured || identity.current.disabled !== disabled) identity.current = { projectId, assetId, configured, disabled };
  const view = identity.current, current = () => mounted.current && identity.current === view;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; transfer.current?.abort(); }; }, []);
  useEffect(() => {
    let active = true; pending.current = null; transfer.current?.abort(); knownAttempt.current = ''; keys.current.clear(); notified.current.clear(); setOptions(null); setFile(null); setAttempt(null); setBusy(''); setProgress(null); setError(''); setNotice('');
    if (configured) request(path + '/options' + (assetId ? '?assetId=' + encodeURIComponent(assetId) : '')).then(result => {
      if (!active || !current()) return;
      if (!Number.isSafeInteger(result.maxSize) || result.maxSize < 1 || result.maxSize > 5_000_000_000 || !Array.isArray(result.formats) || !result.formats.length || result.formats.some((item: Format) => !item || typeof item.contentType !== 'string' || !['image', 'video', 'document'].includes(item.kind) || !Array.isArray(item.extensions) || !item.extensions.length || item.extensions.some(extension => typeof extension !== 'string' || !/^\.?[a-z0-9]+$/i.test(extension))) || assetId && (result.asset?.id !== assetId || typeof result.assetVersion !== 'string' || !result.assetVersion)) throw new Error('The upload settings could not be read. Reload them before uploading.');
      if (result.attempts !== undefined && (!Array.isArray(result.attempts) || result.attempts.some((item: Attempt) => !item || typeof item.id !== 'string' || item.projectId !== projectId || !statuses.includes(item.status) || typeof item.filename !== 'string'))) throw new Error('The earlier upload list could not be read. Reload before continuing.');
      setOptions(result);
    }).catch(failure => { if (active && current()) setError(failure.message || 'The upload settings could not be loaded.'); });
    return () => { active = false; transfer.current?.abort(); };
  }, [path, assetId, configured, disabled, refresh, request]);
  function accept(result: any, expectedId: string) {
    if (!current()) return null;
    const item = result?.attempt;
    if (!item || item.id !== expectedId || item.projectId !== projectId || !statuses.includes(item.status) || typeof item.filename !== 'string' || typeof item.contentType !== 'string' || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 5_000_000_000 || item.status === 'completed' && (typeof item.assetId !== 'string' || !item.assetId || assetId && item.assetId !== assetId || item.savedAssetMissing !== true && (typeof item.asset?.id !== 'string' || !['pending', 'approved', 'rejected'].includes(item.asset.approval) || item.assetId !== item.asset.id)) || item.expiresAt !== undefined && (typeof item.expiresAt !== 'string' || !Number.isFinite(Date.parse(item.expiresAt)))) throw new Error('The upload receipt could not be read. Check its status before retrying.');
    knownAttempt.current = item.id; setAttempt(item);
    if (item.status === 'completed' && !notified.current.has(item.id)) { notified.current.add(item.id); setNotice(item.savedAssetMissing ? 'This upload completed earlier, but its asset has since been removed.' : item.deliveryChanged ? 'This upload completed earlier. The asset now has a different delivery file.' : `Delivery asset saved. Current approval: ${item.asset.approval}.`); if (item.asset) onSaved(item.asset); }
    return item as Attempt;
  }
  async function write(suffix: string, body: unknown) {
    if (!current() || disabled || !configured) throw new DOMException('The upload view changed.', 'AbortError');
    const signature = suffix + ':' + JSON.stringify(body); let key = keys.current.get(signature); if (!key) { key = crypto.randomUUID(); keys.current.set(signature, key); }
    const result = await request(path + suffix, 'POST', body, key);
    if (!current()) throw new DOMException('The upload view changed.', 'AbortError');
    return result;
  }
  async function act(label: string, work: (token: object) => Promise<void>) {
    if (!current() || disabled || !configured || pending.current) return;
    const token = {}; pending.current = token; setBusy(label); setError(''); setNotice('');
    try { await work(token); } catch (failure) { if (current() && pending.current === token && (failure as Error).name !== 'AbortError') setError((failure as Error).message || 'The upload could not be confirmed. Check its status before retrying.'); }
    finally { if (current() && pending.current === token) { pending.current = null; setBusy(''); } }
  }
  async function check() {
    const id = knownAttempt.current; if (!id || !current()) return;
    accept(await request(path + '/' + encodeURIComponent(id)), id);
  }
  async function sendFile(item: Attempt, selected: File) {
    if (!current() || disabled || item.status !== 'awaiting_upload') return;
    const action = pending.current;
    await new Promise<void>((resolve, reject) => {
      const xhr = new XMLHttpRequest(); transfer.current = xhr;
      xhr.open('PUT', '/api' + path + '/' + encodeURIComponent(item.id) + '/content'); xhr.withCredentials = true; xhr.setRequestHeader('Content-Type', item.contentType);
      xhr.upload.onprogress = event => { if (current() && pending.current === action) setProgress(event.lengthComputable && event.total ? Math.min(100, Math.floor(event.loaded / event.total * 100)) : null); };
      xhr.onload = () => {
        if (transfer.current === xhr) transfer.current = null;
        if (!current() || pending.current !== action) { resolve(); return; }
        try { const result = JSON.parse(xhr.responseText); if (xhr.status < 200 || xhr.status >= 300) throw new Error(typeof result.error === 'string' ? result.error : result.error?.message || 'The transfer could not be confirmed. Check its status.'); accept(result, item.id); resolve(); }
        catch (failure) { reject(failure instanceof SyntaxError ? new Error('The transfer receipt could not be read. Check its status before retrying.') : failure); }
      };
      xhr.onerror = () => { if (transfer.current === xhr) transfer.current = null; reject(new Error('The transfer connection ended. Check its status before retrying.')); };
      xhr.onabort = () => { if (transfer.current === xhr) transfer.current = null; reject(new DOMException('Transfer interrupted. Check its status before retrying.', 'AbortError')); };
      xhr.send(selected);
    });
  }
  async function upload() {
    if (!file || !options || attempt && !['preparation_failed', 'expired', 'cancelled'].includes(attempt.status)) return;
    await act('upload', async token => {
      const metadata = mediaFileMetadata(file, options), id = knownAttempt.current || crypto.randomUUID(); knownAttempt.current = id;
      const result = await write('', { attemptId: id, ...metadata, ...(assetId ? { assetId, assetVersion: options.assetVersion } : {}) });
      if (pending.current !== token) return;
      const item = accept(result, id);
      if (item?.status === 'awaiting_upload') { setProgress(0); await sendFile(item, file); }
    });
  }
  async function recover(retry = false) {
    const id = knownAttempt.current; if (!id || !current()) return;
    await act(retry ? 'retry' : 'check', async token => {
      if (retry && (!file || !options || JSON.stringify(mediaFileMetadata(file, options)) !== JSON.stringify({ filename: attempt?.filename, contentType: attempt?.contentType, size: attempt?.size }))) throw new Error('Select the same file before retrying this transfer.');
      const result = await write('/' + encodeURIComponent(id) + (retry ? '/retry' : '/recover'), {});
      if (pending.current !== token) return;
      const item = accept(result, id);
      if (retry && item?.status === 'awaiting_upload' && file) { setProgress(0); await sendFile(item, file); }
    });
  }
  async function cancel() {
    const id = knownAttempt.current; if (!current() || disabled || !configured || !id || busy && busy !== 'upload' && busy !== 'retry') return;
    const token = {}; pending.current = token; setBusy('cancel'); setError(''); transfer.current?.abort();
    try { const item = accept(await write('/' + encodeURIComponent(id) + '/cancel', {}), id); if (current() && item?.status === 'cancelled') setNotice('Upload cancelled. Cancellation cannot remove a file already received by Zernio.'); }
    catch (failure) { if (current()) setError((failure as Error).message || 'Cancellation could not be confirmed. Check the upload status.'); }
    finally { if (current() && pending.current === token) { pending.current = null; setBusy(''); } }
  }
  async function complete() {
    const id = knownAttempt.current; if (!id || attempt?.status !== 'uploaded') return;
    await act('save', async () => { accept(await write('/' + encodeURIComponent(id) + '/recover', {}), id); });
  }
  function choose(selected: File | null) {
    if (pending.current) return; setError(''); setNotice('');
    try { if (selected && options) mediaFileMetadata(selected, options); setFile(selected); }
    catch (failure) { setFile(null); setError((failure as Error).message); }
  }
  const terminal = attempt && ['cancelled', 'preparation_failed', 'expired'].includes(attempt.status), canChoose = !busy && (!attempt || terminal || ['awaiting_upload', 'transfer_uncertain'].includes(attempt.status));
  return <section className="settings-panel" aria-label="Upload delivery media">
    <h3>{assetId ? 'Replace delivery file' : 'Upload delivery file'}</h3>
    <p className="field-help">Upload an image, video or PDF to Zernio for a public delivery URL. Submit a scheduled, queued or immediate post within seven days so Zernio can retain that post’s copy. Saving a draft does not retain the file. Re-upload this library file after it expires. Platform publishing limits still apply.</p>
    {!configured ? <p>Configure Zernio and connect this project before uploading.</p> : <>
      {!!options?.attempts?.filter(item => !['completed', 'cancelled', 'expired'].includes(item.status)).length && !knownAttempt.current && <details><summary>Resume an earlier upload</summary><ul>{options.attempts.filter(item => !['completed', 'cancelled', 'expired'].includes(item.status)).map(item => <li key={item.id}>{item.filename} · {labels[item.status] || 'Check status'} <button type="button" className="button" disabled={disabled || Boolean(busy)} onClick={() => act('check', async () => { accept(await request(path + '/' + encodeURIComponent(item.id)), item.id); })}>Review upload</button></li>)}</ul></details>}
      {options?.asset && <p>Replacing the delivery file for <strong>{options.asset.name || options.asset.id}</strong>. Its original link, tags and description are retained; approval resets to pending.</p>}
      <button type="button" className="button" disabled={Boolean(busy)} onClick={() => setRefresh(value => value + 1)}>Reload upload settings</button>
      {options && <><label className="field"><span>Delivery file · up to {(options.maxSize / 1_000_000_000).toLocaleString()} GB</span><input type="file" accept={options.formats.flatMap(format => format.extensions.map(extension => '.' + extension.replace(/^\./, ''))).join(',')} disabled={disabled || !canChoose} onChange={event => choose(event.target.files?.[0] || null)}/></label>{file && <p className="field-help">{file.name} · {file.size.toLocaleString()} bytes</p>}</>}
      {attempt && <p role="status">{labels[attempt.status]}{attempt.expiresAt ? ` · Temporary file expires ${new Date(attempt.expiresAt).toLocaleString()}` : ''}</p>}
      {['upload', 'retry'].includes(busy) && <div><progress max={100} {...(progress === null ? {} : { value: progress })} aria-label="File transfer progress"/><p className="field-help">{progress === 100 ? 'File sent; waiting for the server to confirm receipt.' : progress === null ? 'Transferring file…' : `${progress}% transferred`}</p></div>}
      <div className="button-row">
        {!attempt && <button type="button" className="button" disabled={disabled || Boolean(busy) || !file || !options} onClick={upload}>{knownAttempt.current ? 'Retry upload preparation' : 'Upload file'}</button>}
        {knownAttempt.current && attempt?.status !== 'completed' && <button type="button" className="button" disabled={disabled || Boolean(busy)} onClick={() => act('check', check)}>Check upload status</button>}
        {attempt && ['uploading', 'transfer_uncertain'].includes(attempt.status) && <button type="button" className="button" disabled={disabled || Boolean(busy)} onClick={() => recover()}>Recheck and save delivery asset</button>}
        {attempt && ['awaiting_upload', 'transfer_uncertain', 'preparation_failed'].includes(attempt.status) && <button type="button" className="button" disabled={disabled || Boolean(busy) || !file || !options} onClick={() => recover(true)}>Retry transfer after checking</button>}
        {attempt?.status === 'uploaded' && <button type="button" className="button primary" disabled={disabled || Boolean(busy)} onClick={complete}>Save delivery asset with pending approval</button>}
        {knownAttempt.current && (!attempt || !['completed', 'cancelled', 'expired'].includes(attempt.status)) && <button type="button" className="button" disabled={disabled || Boolean(busy) && !['upload', 'retry'].includes(busy)} onClick={cancel}>Cancel upload</button>}
        {terminal && <button type="button" className="button" disabled={disabled || Boolean(busy)} onClick={() => { knownAttempt.current = ''; setAttempt(null); setProgress(null); setNotice(''); setError(''); }}>Start a new upload</button>}
      </div>
    </>}
    {error && <p className="alert" role="alert">{error}</p>}{notice && <p className="helper-note" role="status">{notice}</p>}
  </section>;
}
