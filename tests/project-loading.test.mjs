import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

test('overlapping app work stays busy and stale project callbacks cannot start provider actions or replace errors', async () => {
  const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const runSource = source.slice(source.indexOf('async function run('), source.indexOf('\n  async function integrate('));
  const integrationSource = source.slice(source.indexOf('async function integrate('), source.indexOf('\n  useEffect(() => { if (!notice)'));
  const compile = value => stripTypeScriptTypes(value, { mode: 'strip' });
  const activeProject = { current: 'a' }, pendingWork = { current: 0 }, busy = [], errors = [], notices = [], calls = [];
  const run = new Function('activeProject', 'pendingWork', 'setBusy', 'setError', 'setNotice', compile(runSource) + '; return run;')(activeProject, pendingWork, value => busy.push(value), value => errors.push(value), value => notices.push(value));
  let finishFirst, finishSecond;
  const first = run(() => new Promise(resolve => { finishFirst = resolve; }), 'Saved A');
  const second = run(() => new Promise(resolve => { finishSecond = resolve; }), 'Saved B');
  finishSecond('b'); await second; assert.equal(busy.at(-1), true, 'Another pending operation must keep actions disabled.');
  activeProject.current = 'b'; finishFirst('a'); await first;
  assert.equal(busy.at(-1), false); assert.equal(pendingWork.current, 0); assert.deepEqual(notices, ['Saved B']);
  let fail; activeProject.current = 'a'; const stale = run(() => new Promise((resolve, reject) => { fail = reject; }));
  activeProject.current = 'b'; fail(new Error('Old project failure')); await stale; assert.equal(errors.includes('Old project failure'), false);
  const integrate = new Function('state', 'activeProject', 'pendingKeys', 'crypto', 'api', 'endpoint', compile(integrationSource) + '; return integrate;')({ projectId: 'a' }, activeProject, { current: new Map() }, {}, (...args) => calls.push(args), path => path);
  await assert.rejects(integrate('drive/upload', { name: 'old.txt' }), { name: 'AbortError' });
  assert.deepEqual(calls, [], 'A delayed file read or callback from the former project must not start a provider write.');
});

test('project loading marks the requested project immediately and ignores superseded responses', async () => {
  const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const reloadSource = source.slice(source.indexOf('async function reload('), source.indexOf('\n  function leaveEditor('));
  const pending = [], accepted = [], loadVersion = { current: 0 }, activeProject = { current: 'a' };
  const api = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  const reload = new Function('api', 'state', 'loadVersion', 'activeProject', 'setLoading', 'setState', 'navigationRef', 'writeNavigation', 'inboxDraft', `return (${stripTypeScriptTypes(reloadSource)});`)(api, { projectId: 'a', projects: ['a', 'b', 'c'].map(id => ({ id })) }, loadVersion, activeProject, () => {}, value => accepted.push(value), { current: {} }, () => {}, { current: { dirty: false, revision: 0 } });
  const first = reload('a'), second = reload('b');
  assert.equal(activeProject.current, 'b', 'Callbacks from project A must become stale as soon as project B is requested.');
  pending[1].resolve({ projectId: 'b', projects: [{ id: 'b' }] }); await second;
  pending[0].resolve({ projectId: 'a' }); await first;
  assert.deepEqual(accepted, [{ projectId: 'b', projects: [{ id: 'b' }] }]); assert.equal(activeProject.current, 'b');
  const failed = reload('c'); pending[2].reject(new Error('Connection lost'));
  await assert.rejects(failed, /Connection lost/); assert.equal(activeProject.current, 'a', 'A failed switch restores the last rendered project.');
});

test('completed saves and deletes refresh their project without closing a newer dialog or switching its workspace', async () => {
  const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  for (const [start, end, type, args] of [
    ['async function savePost(', '  async function remove(', 'post', [{ content: 'Original post' }]],
    ['async function submitForm(', '  async function savePost(', 'workspace', [{ preventDefault() {}, currentTarget: {} }]],
    ['async function remove(', '  async function clearSampleData(', 'post', ['posts', { id: 'original', name: 'Original' }]],
  ]) {
    const modal = { type, item: type === 'post' ? { id: 'original' } : undefined }, modalRef = { current: modal }, closed = [], reloads = [];
    let finish;
    const context = { state: { projectId: 'a' }, activeProject: { current: 'a' }, modal, modalRef, pendingWork: { current: 0 }, setBusy() {}, setError() {}, setNotice() {}, setModal: value => closed.push(value), reload: async id => reloads.push(id), run: work => work(), api: () => new Promise(resolve => { finish = resolve; }), endpoint: value => value, workspace: { id: 'workspace-a' }, window: { confirm: () => true }, FormData: class { *[Symbol.iterator]() { yield ['name', 'Original']; } } };
    const handler = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
    const invoke = new Function(...Object.keys(context), `return (${stripTypeScriptTypes(handler)});`)(...Object.values(context));
    const pending = invoke(...args); modalRef.current = { type: 'post', item: { id: 'newer-draft' } }; finish({ projectId: 'new-workspace-project' }); await pending;
    assert.deepEqual(closed, [], `${start} must preserve a newer dialog.`); assert.deepEqual(reloads, ['a'], 'Refresh records without navigating away from the newer draft.');
    modalRef.current = modal; const current = invoke(...args); finish({}); await current;
    assert.deepEqual(closed, [null], 'The original dialog still closes after its own successful action.');
  }
});
