import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';

const source = await readFile(new URL('../src/ZernioMediaUpload.tsx', import.meta.url), 'utf8');
function handler(name, next, context) {
  const start = source.indexOf(`  async function ${name}(`) >= 0 ? source.indexOf(`  async function ${name}(`) : source.indexOf(`  function ${name}(`);
  const end = source.indexOf(`  ${next}`, start), code = stripTypeScriptTypes(source.slice(start, end).trim());
  assert.ok(start >= 0 && end > start, `The actual ${name} handler must be evaluated.`);
  return new Function(...Object.keys(context), `return (${code});`)(...Object.values(context));
}
const fileOptions = { maxSize: 5_000_000_000, formats: [{ contentType: 'image/jpeg', extensions: ['jpg', 'jpeg'], kind: 'image' }, { contentType: 'video/mp4', extensions: ['mp4'], kind: 'video' }, { contentType: 'application/pdf', extensions: ['pdf'], kind: 'document' }] };
const metadataSource = stripTypeScriptTypes(source.slice(source.indexOf('export function mediaFileMetadata'), source.indexOf('\nexport default function')).replace('export ', ''));
const metadata = new Function(`return (${metadataSource});`)();
const baseAttempt = { id: 'upload-reviewed', projectId: 'project-one', filename: 'creative.jpg', contentType: 'image/jpeg', size: 1024, status: 'awaiting_upload' };
const statuses = ['preparing', 'awaiting_upload', 'uploading', 'transfer_uncertain', 'uploaded', 'completed', 'cancelled', 'preparation_failed', 'expired'];
function acceptance(overrides = {}) {
  const changes = [], saved = [], active = { value: true }, context = { current: () => active.value, projectId: 'project-one', assetId: undefined, statuses, knownAttempt: { current: '' }, notified: { current: new Set() }, setAttempt: item => changes.push(item), setNotice: notice => changes.push(notice), onSaved: item => saved.push(item), ...overrides };
  return { accept: handler('accept', 'async function write(', context), changes, saved, active, context };
}

test('hosted-media selection checks the actual filename, MIME, size and posting-supported media policy', () => {
  assert.deepEqual(metadata({ name: 'creative.JPG', type: 'image/jpeg', size: 1024 }, fileOptions), { filename: 'creative.JPG', contentType: 'image/jpeg', size: 1024 });
  assert.equal(metadata({ name: 'creative.jpg', type: '', size: 5_000_000_000 }, fileOptions).contentType, 'image/jpeg', 'Only an absent browser MIME can be inferred from the allowed extension.');
  for (const file of [{ name: 'creative.jpg', type: 'video/mp4', size: 1 }, { name: 'sound.mp3', type: 'audio/mpeg', size: 1 }, { name: 'captions.srt', type: 'text/plain', size: 1 }, { name: 'x.pdf', type: 'application/pdf', size: 5_000_000_001 }, { name: '../x.jpg', type: 'image/jpeg', size: 1 }, { name: 'x.jpg', type: 'image/jpeg', size: 0 }, { name: 'x.jpg', type: 'image/jpeg', size: NaN }]) assert.throws(() => metadata(file, fileOptions));
});

test('completed upload receipts must match the selected project and replacement asset and notify once', () => {
  const selected = acceptance({ assetId: 'asset-reviewed' }), completed = { ...baseAttempt, status: 'completed', assetId: 'asset-reviewed', asset: { id: 'asset-reviewed', approval: 'pending' }, expiresAt: '2026-10-27T12:00:00Z' };
  for (const attempt of [{ ...completed, projectId: 'different-project' }, { ...completed, assetId: 'other', asset: { id: 'other' } }, { ...completed, asset: undefined }, { ...completed, asset: { ...completed.asset, approval: 'invented' } }, { ...completed, expiresAt: 'not-a-date' }, { ...completed, status: 'maybe-saved' }]) assert.throws(() => selected.accept({ attempt }, baseAttempt.id), /receipt could not be read/);
  assert.deepEqual(selected.saved, []);
  selected.accept({ attempt: completed }, completed.id); selected.accept({ attempt: completed }, completed.id);
  assert.deepEqual(selected.saved, [completed.asset]);
  selected.active.value = false; assert.equal(selected.accept({ attempt: { ...completed, id: 'late' } }, 'late'), null); assert.equal(selected.saved.length, 1);
});

test('the upload scope changes immediately on project, asset or permission changes and never revives an old callback', () => {
  const line = source.match(/  if \(identity\.current\.projectId[^\n]+/)[0], declaration = source.match(/  const view = identity\.current, current = [^\n]+/)[0];
  const identity = { current: { projectId: 'one', assetId: 'a', configured: true, disabled: false } }, mounted = { current: true };
  function render(projectId, assetId = 'a', configured = true, disabled = false) { return new Function('identity', 'mounted', 'projectId', 'assetId', 'configured', 'disabled', `${line}\n${declaration}\nreturn current;`)(identity, mounted, projectId, assetId, configured, disabled); }
  const first = render('one'); assert.equal(first(), true); const other = render('two'); assert.equal(first(), false); assert.equal(other(), true); render('one'); assert.equal(first(), false, 'Returning to a previous project must not reactivate a prior response.');
  const beforePermission = render('one'); render('one', 'a', true, true); assert.equal(beforePermission(), false);
  const beforeAsset = render('one', 'a'); render('one', 'b'); assert.equal(beforeAsset(), false); mounted.current = false; assert.equal(render('one', 'b')(), false);
});

test('recovery reports current approval or a later replacement/removal without retrying an already saved upload', () => {
  const completed = { ...baseAttempt, status: 'completed', assetId: 'asset-reviewed', asset: { id: 'asset-reviewed', approval: 'approved' } }, h = acceptance();
  assert.equal(h.accept({ attempt: completed }, completed.id).status, 'completed'); assert.match(h.changes.find(value => typeof value === 'string'), /Current approval: approved/); assert.deepEqual(h.saved, [completed.asset]);
  const replaced = acceptance(); replaced.accept({ attempt: { ...completed, deliveryChanged: true } }, completed.id); assert.match(replaced.changes.find(value => typeof value === 'string'), /different delivery file/);
  const removed = acceptance(); removed.accept({ attempt: { ...completed, asset: undefined, savedAssetMissing: true } }, completed.id); assert.deepEqual(removed.saved, []); assert.match(removed.changes.find(value => typeof value === 'string'), /since been removed/);
});

test('upload preparation keeps one request key through unreadable receipts and refuses writes after the scope changes', async () => {
  const calls = [], keys = { current: new Map() }, active = { value: true }, context = { current: () => active.value, disabled: false, configured: true, keys, path: '/projects/one/integrations/media/uploads', request: async (...args) => { calls.push(args); return { unreadable: true }; } };
  const write = handler('write', 'async function act(', context), body = { attemptId: 'client-known-id', filename: 'creative.jpg', contentType: 'image/jpeg', size: 1 };
  await write('', body); await write('', body); assert.equal(calls[0][3], calls[1][3]); assert.ok(calls[0][3]);
  active.value = false; await assert.rejects(write('', body), { name: 'AbortError' }); assert.equal(calls.length, 2);
  let finish; active.value = true; context.request = (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); };
  const delayed = handler('write', 'async function act(', context)('', body); active.value = false; finish({ attempt: baseAttempt }); await assert.rejects(delayed, { name: 'AbortError' });
});

function transferHarness() {
  const instances = [], progress = [], accepted = [], active = { value: true }, transfer = { current: null };
  class FakeXHR {
    upload = {};
    constructor() { instances.push(this); }
    open(...args) { this.opened = args; }
    setRequestHeader(...args) { this.header = args; }
    send(file) { this.file = file; }
    abort() { this.onabort?.(); }
  }
  const context = { current: () => active.value, disabled: false, pending: { current: {} }, transfer, path: '/projects/project-one/integrations/media/uploads', XMLHttpRequest: FakeXHR, setProgress: value => progress.push(value), accept: (result, id) => accepted.push({ result, id }) };
  return { sendFile: handler('sendFile', 'async function upload(', context), instances, progress, accepted, active, transfer, pending: context.pending };
}

test('native upload transfers raw bytes to the authenticated same-origin relay and waits for a readable server receipt', async () => {
  const h = transferHarness(), file = { name: 'creative.jpg', type: 'image/jpeg', size: 1024 }, pending = h.sendFile(baseAttempt, file), xhr = h.instances[0];
  assert.deepEqual(xhr.opened, ['PUT', '/api/projects/project-one/integrations/media/uploads/upload-reviewed/content']); assert.equal(xhr.withCredentials, true); assert.deepEqual(xhr.header, ['Content-Type', 'image/jpeg']); assert.equal(xhr.file, file);
  xhr.upload.onprogress({ lengthComputable: true, total: 1024, loaded: 1024 }); assert.deepEqual(h.progress, [100]); assert.deepEqual(h.accepted, [], 'Progress completion must not claim provider receipt or save an asset.');
  xhr.status = 200; xhr.responseText = JSON.stringify({ attempt: { ...baseAttempt, status: 'uploaded' } }); xhr.onload(); await pending; assert.equal(h.accepted[0].id, baseAttempt.id); assert.equal(h.transfer.current, null);
  for (const receipt of [{ status: 200, body: '<html>proxy error</html>' }, { status: 502, body: JSON.stringify({ error: { message: 'Outcome unknown; check status' } }) }]) {
    const bad = h.sendFile(baseAttempt, file), latest = h.instances.at(-1); latest.status = receipt.status; latest.responseText = receipt.body; const rejected = assert.rejects(bad, /receipt could not be read|Outcome unknown/); latest.onload(); await rejected;
  }
});

test('late upload progress and receipts cannot update a different project or closed modal', async () => {
  const h = transferHarness(), pending = h.sendFile(baseAttempt, {}), xhr = h.instances[0]; h.active.value = false; xhr.upload.onprogress({ lengthComputable: true, total: 1, loaded: 1 }); xhr.status = 200; xhr.responseText = JSON.stringify({ attempt: { ...baseAttempt, status: 'completed' } }); xhr.onload(); await pending; assert.deepEqual(h.progress, []); assert.deepEqual(h.accepted, []);
});

test('cancel uses the server result when completion wins the race and never calls an upload cancelled merely because XHR aborted', async () => {
  const accepted = acceptance(), changes = [], pending = { current: {} }, transfer = { current: { abort() { changes.push('aborted'); } } }, context = { current: () => true, disabled: false, configured: true, knownAttempt: { current: baseAttempt.id }, busy: 'upload', pending, transfer, setBusy: value => changes.push(['busy', value]), setError: value => changes.push(['error', value]), setNotice: value => changes.push(['notice', value]), write: async () => ({ attempt: { ...baseAttempt, status: 'completed', assetId: 'new-asset', asset: { id: 'new-asset', approval: 'pending' } } }), accept: accepted.accept };
  await handler('cancel', 'async function complete(', context)();
  assert.equal(changes.filter(item => item === 'aborted').length, 1); assert.deepEqual(accepted.saved.map(asset => asset.id), ['new-asset']); assert.equal(changes.some(item => Array.isArray(item) && item[0] === 'notice' && item[1].includes('cancelled')), false); assert.equal(pending.current, null);
  context.write = async () => ({ attempt: { ...baseAttempt, status: 'cancelled' } }); await handler('cancel', 'async function complete(', context)(); assert.equal(accepted.saved.length, 1); assert.equal(changes.some(item => Array.isArray(item) && item[0] === 'notice' && item[1].includes('cancelled')), true);
});

test('saving or uncertain recovery verifies through recover while retry cannot send a different file or resend an already completed attempt', async () => {
  const calls = [], context = { knownAttempt: { current: baseAttempt.id }, attempt: { ...baseAttempt, status: 'uploaded' }, act: (label, run) => run(undefined), pending: { current: undefined }, write: async (...args) => { calls.push(args); return { attempt: { ...baseAttempt, status: 'completed' } }; }, accept: result => result.attempt };
  await handler('complete', 'function choose(', context)(); assert.deepEqual(calls, [['/upload-reviewed/recover', {}]]);
  let sent = false; const retryContext = { ...context, current: () => true, file: { name: 'different.jpg', type: 'image/jpeg', size: 1 }, options: fileOptions, mediaFileMetadata: metadata, setProgress() {}, sendFile: async () => { sent = true; } };
  await assert.rejects(handler('recover', 'async function cancel(', retryContext)(true), /same file/); assert.equal(calls.length, 1);
  retryContext.file = { name: baseAttempt.filename, type: baseAttempt.contentType, size: baseAttempt.size }; await handler('recover', 'async function cancel(', retryContext)(true); assert.equal(sent, false, 'A retry read that reports completion must not transmit bytes again.');
});

test('a superseded upload action cannot clear the cancellation state or report an abort error', async () => {
  let fail; const pending = { current: null }, busy = [], errors = [], context = { current: () => true, disabled: false, configured: true, pending, setBusy: value => busy.push(value), setError: value => errors.push(value), setNotice() {} };
  const act = handler('act', 'async function check(', context), first = act('upload', () => new Promise((resolve, reject) => { fail = reject; }));
  const cancelToken = {}; pending.current = cancelToken; fail(new DOMException('aborted', 'AbortError')); await first; assert.equal(pending.current, cancelToken); assert.deepEqual(busy, ['upload']); assert.deepEqual(errors, ['']);
});


test('cancellation during preparation prevents a late preparation receipt from starting a file transfer', async () => {
  let finish; const sent = [], accepted = [], pending = { current: null }, context = { file: { name: baseAttempt.filename, type: baseAttempt.contentType, size: baseAttempt.size }, options: fileOptions, attempt: null, knownAttempt: { current: baseAttempt.id }, pending, assetId: undefined, mediaFileMetadata: metadata, write: () => new Promise(resolve => { finish = resolve; }), accept: (...args) => accepted.push(args), setProgress() {}, sendFile: (...args) => sent.push(args), act: async (label, run) => { const token = {}; pending.current = token; await run(token); } };
  const upload = handler('upload', 'async function recover(', context)(); pending.current = { cancelled: true }; finish({ attempt: baseAttempt }); await upload;
  assert.deepEqual(accepted, []); assert.deepEqual(sent, [], 'Cancelling a preparing upload must prevent its delayed continuation from sending bytes.');
  const h = transferHarness(), transfer = h.sendFile(baseAttempt, {}), xhr = h.instances[0]; h.pending.current = { cancellation: true }; xhr.upload.onprogress({ lengthComputable: true, total: 1, loaded: 1 }); xhr.status = 200; xhr.responseText = JSON.stringify({ attempt: { ...baseAttempt, status: 'uploaded' } }); xhr.onload(); await transfer; assert.deepEqual(h.progress, []); assert.deepEqual(h.accepted, [], 'Only the authoritative cancellation response may update the cancelled action.');
});
test('resuming a ready or uncertain transfer lets the user choose the original file again', () => {
  const line = source.match(/  const terminal = [^\n]+/)[0];
  const canChoose = new Function('attempt', 'busy', `${line}\nreturn canChoose;`);
  assert.equal(canChoose({ ...baseAttempt, status: 'awaiting_upload' }, ''), true);
  assert.equal(canChoose({ ...baseAttempt, status: 'transfer_uncertain' }, ''), true);
  assert.equal(canChoose({ ...baseAttempt, status: 'uploaded' }, ''), false);
  assert.equal(canChoose({ ...baseAttempt, status: 'awaiting_upload' }, 'retry'), false);
});

test('shared transfer progress preserves unknown length, receipt uncertainty and native recovery controls', async () => {
  const { code } = await transformWithOxc('function UploadView() {\n' + source.slice(source.indexOf('  return <')), 'UploadView.tsx', { jsx: { runtime: 'classic' } });
  const labels = new Function(stripTypeScriptTypes(source.match(/^const labels:[^\n]+/m)[0]) + '; return labels;')();
  const noop = () => {}, file = { name: baseAttempt.filename, type: baseAttempt.contentType, size: baseAttempt.size };
  function render(overrides = {}) {
    const context = { React, ...Object.fromEntries(Object.entries(ui).filter(([name]) => /^[A-Z]/.test(name))), assetId: 'asset-reviewed', configured: true, options: { ...fileOptions, asset: { id: 'asset-reviewed', name: 'Original creative' } }, disabled: false, busy: '', canChoose: true, file, attempt: { ...baseAttempt, status: 'transfer_uncertain', expiresAt: '2026-10-27T12:00:00Z' }, knownAttempt: { current: baseAttempt.id }, labels, progress: null, error: '', notice: '', terminal: false, setRefresh: noop, choose: noop, upload: noop, act: noop, check: noop, recover: noop, complete: noop, cancel: noop, ...overrides };
    const View = new Function(...Object.keys(context), code + '; return UploadView;')(...Object.values(context));
    return renderToStaticMarkup(React.createElement(View));
  }
  for (const progress of [0, 42, 100]) {
    const html = render({ busy: 'upload', progress });
    assert.match(html, /class="t98-progress"/);
    assert.match(html, new RegExp(`<progress[^>]*value="${progress}"[^>]*aria-label="File transfer progress"`));
    if (progress === 100) assert.match(html, /File sent; waiting for the server to confirm receipt\./);
    assert.doesNotMatch(html, /Delivery asset saved|Metadata verified|Media changes pending/);
  }
  const unknown = render({ busy: 'retry' });
  assert.match(unknown, /<progress class="t98-progress" aria-label="File transfer progress" aria-busy="true"><\/progress>/);
  assert.doesNotMatch(unknown, /value="|%<\/span>/);
  const recovery = render();
  for (const text of ['Its original link, tags and description are retained', 'Transfer needs checking', 'Temporary file expires', 'Check upload status', 'Recheck and save delivery asset', 'Retry transfer after checking', 'Cancel upload']) assert.ok(recovery.includes(text), text);
  assert.match(recovery, /<input[^>]* type="file"[^>]* accept="\.jpg,\.jpeg,\.mp4,\.pdf"/);
  assert.doesNotMatch(recovery, /<progress|Move earlier|Alt text/);
});
