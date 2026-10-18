import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('project loading marks the requested project immediately and ignores superseded responses', async () => {
  const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const reloadSource = source.slice(source.indexOf('async function reload('), source.indexOf('\n  async function run('));
  const pending = [], accepted = [], loadVersion = { current: 0 }, activeProject = { current: 'a' };
  const api = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
  const reload = new Function('api', 'state', 'loadVersion', 'activeProject', 'setLoading', 'setState', `return (${reloadSource});`)(api, { projectId: 'a' }, loadVersion, activeProject, () => {}, value => accepted.push(value));
  const first = reload('a'), second = reload('b');
  assert.equal(activeProject.current, 'b', 'Callbacks from project A must become stale as soon as project B is requested.');
  pending[1].resolve({ projectId: 'b' }); await second;
  pending[0].resolve({ projectId: 'a' }); await first;
  assert.deepEqual(accepted, [{ projectId: 'b' }]); assert.equal(activeProject.current, 'b');
  const failed = reload('c'); pending[2].reject(new Error('Connection lost'));
  await assert.rejects(failed, /Connection lost/); assert.equal(activeProject.current, 'a', 'A failed switch restores the last rendered project.');
});
