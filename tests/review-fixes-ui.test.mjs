import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const app = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'), source = await readFile(new URL('../src/ContentApprovals.tsx', import.meta.url), 'utf8');

test('the composer offers account auto-loading only when the project has a Zernio connection', () => {
  const composer = app.match(/modal\.type === 'post' \? <PostComposer [^\r\n]+?\/>/)?.[0]; assert.ok(composer);
  assert.match(composer, /onLoadAccounts=\{connected \? \(\) => loadRemote\('accounts', 'accounts'\) : undefined\}/, 'Unconnected projects would answer the automatic load with 409 or 503.');
});

test('a failed keyboard review forgets its pending focus move, while a saved one keeps it for the next card', async () => {
  const start = source.indexOf('export default function '), end = source.indexOf('  return <', start);
  function view(request) {
    const state = [], context = { useState(value) { const index = state.length; state.push(index === 0 ? { requireApproval: true, posts: [] } : value); return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }]; }, useRef: value => ({ current: value }), useEffect() {}, document: { getElementById: () => null } };
    return new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source.slice(start, end).replace('export default ', '') + 'return { review, advance };\n}')});`)(...Object.values(context))({ projectId: 'project', role: 'owner', request, onChanged: async () => {} });
  }
  const item = { post: { id: 'post' }, review: { id: 'review' }, status: 'pending' };
  const failed = view(async (_path, method) => { if (method) throw new Error('Review expired'); return {}; });
  failed.advance.current = { id: 'post', index: 0 }; await failed.review(item, 'approved'); assert.equal(failed.advance.current, null);
  const saved = view(async (_path, method) => method ? { item: { ...item, status: 'approved' } } : { requireApproval: true, posts: [] });
  saved.advance.current = { id: 'post', index: 0 }; await saved.review(item, 'approved'); assert.deepEqual(saved.advance.current, { id: 'post', index: 0 });
});
