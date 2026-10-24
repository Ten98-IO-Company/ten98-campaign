// ten98-campaign#150: a page error from an earlier action does not stay on screen after the section or project changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');

test('the page error clears when the section or the project changes', () => {
  const effect = source.match(/ {2}useEffect\(\(\) => \{ setError\(''\); \}, \[section, state\?\.projectId\]\);/)?.[0];
  assert.ok(effect, 'Changing section or project clears the shared page error.');
  const cleared: string[] = [];
  new Function('useEffect', 'setError', 'section', 'state', effect)((run: () => void, deps: unknown[]) => { assert.deepEqual(deps, ['security', 'project-b']); run(); }, (value: string) => cleared.push(value), 'security', { projectId: 'project-b' });
  assert.deepEqual(cleared, ['']);
  // A new action clears the earlier error and spend block before it runs, and a page change already clears the error.
  assert.match(source, /async function run\(work: \(\) => Promise<any>, success\?: string\) \{\r?\n {4}const requestProject = activeProject\.current;\r?\n {4}pendingWork\.current\+\+;\r?\n {4}setBusy\(true\); setError\(''\); setSpendBlock\(null\);/);
  assert.match(source, /useEffect\(\(\) => \{ setQuery\(''\); setTab\('all'\); setMobile\(false\); setError\(''\); \}, \[page\]\);/);
  // Success notices go to the shared toast, which shows one latest message, and the notice state is emptied at once.
  assert.match(source, /useEffect\(\(\) => \{ if \(!notice\) return; toast\(notice\); setNotice\(''\); \}, \[notice\]\);/);
});
