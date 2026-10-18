import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stripTypeScriptTypes } from 'node:module';
import { createApp } from '../server/index.mjs';
import { hashPassword } from '../server/auth.mjs';

test('failed no-project refresh and workspace readback remain visible through the actual app handlers', async () => {
  const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'), context = {
    state: { projectId: null }, loadVersion: { current: 0 }, activeProject: { current: '' }, pendingWork: { current: 0 },
    setLoading() {}, setState() {}, setBusy() {}, setNotice() {}, errors: [], FormData: class { get() { return 'My campaign team'; } },
  };
  let failRead = false, creates = 0;
  context.api = async (path) => {
    if (path === '/workspaces') { creates++; return { projectId: 'created-project' }; }
    if (failRead) throw new Error('Workspace connection lost. Refresh access to try again.');
    return { projectId: null };
  };
  context.setError = value => context.errors.push(value);
  for (const [name, end] of [['reload', '  async function run('], ['run', '  async function integrate('], ['createWorkspace', '  function exportReport(']]) {
    const start = source.indexOf(`async function ${name}(`), handler = source.slice(start, source.indexOf(end, start));
    context[name] = new Function(...Object.keys(context), `return (${stripTypeScriptTypes(handler)});`)(...Object.values(context));
  }
  await context.reload(''); failRead = true;
  await context.run(() => context.reload(''));
  assert.match(context.errors.at(-1), /Workspace connection lost/);
  await context.createWorkspace({ preventDefault() {}, currentTarget: {} });
  assert.equal(creates, 1); assert.match(context.errors.at(-1), /Workspace connection lost/); assert.equal(context.pendingWork.current, 0);
});

test('an account without project access can create its workspace through the actual onboarding handler', async () => {
  const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'), start = source.indexOf('async function createWorkspace(');
  assert.ok(start > -1, 'A signed-in account with no projects needs its own onboarding action.');
  const handler = source.slice(start, source.indexOf('  function exportReport(', start));
  const dataDir = await mkdtemp(join(tmpdir(), 'ten98-onboarding-')), origin = 'http://127.0.0.1:3018', app = createApp({ dataDir, env: {}, appUrl: origin, directScheduler: false });
  let cookie;
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    async function api(path, method = 'GET', body) {
      const response = await fetch(base + '/api' + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      cookie = response.headers.get('set-cookie')?.split(';')[0] || cookie;
      const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
    }
    await api('/auth/setup', 'POST', { name: 'Existing owner', email: 'owner@example.test', password: 'existing owner fixture password', sample: false });
    const existing = await api('/state'), userId = randomUUID();
    app.db.prepare('INSERT INTO users VALUES(?,?,?,?)').run(userId, 'New member', 'new-member@example.test', await hashPassword('new member fixture password'));
    await api('/auth/login', 'POST', { email: 'new-member@example.test', password: 'new member fixture password' });
    const empty = await api('/state'); assert.equal(empty.projectId, null); assert.deepEqual(empty.projects, []); assert.deepEqual(empty.workspaces, []);
    const pendingWork = { current: 0 }, opened = [], context = { pendingWork, FormData: class { get() { return 'My campaign team'; } }, run: async work => { pendingWork.current++; try { return await work(); } finally { pendingWork.current--; } }, api, reload: async id => opened.push(await api('/state?projectId=' + encodeURIComponent(id))) };
    const create = new Function(...Object.keys(context), `return (${stripTypeScriptTypes(handler)});`)(...Object.values(context));
    await create({ preventDefault() {}, currentTarget: {} });
    assert.equal(opened.length, 1); assert.equal(opened[0].workspaces[0].name, 'My campaign team'); assert.equal(opened[0].workspaces[0].role, 'owner');
    assert.equal(opened[0].projects.length, 1); assert.equal(opened[0].projects[0].id, opened[0].projectId); assert.notEqual(opened[0].projectId, existing.projectId); assert.deepEqual(opened[0].campaigns, []);
    pendingWork.current = 1; await create({ preventDefault() {}, currentTarget: {} }); assert.equal((await api('/state')).workspaces.length, 1, 'An in-flight action must not create a second workspace.');
  } finally { await app.close(); await rm(dataDir, { recursive: true, force: true }); }
});
