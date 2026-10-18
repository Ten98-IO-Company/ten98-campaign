import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const main = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
const source = main.slice(main.indexOf('async function shortenPostLinks('), main.indexOf('  const filtered =', main.indexOf('async function shortenPostLinks(')));
const compile = context => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source)});`)(...Object.values(context));
test('caption shortening uses project links and preserves platform copies, punctuation and media delivery URLs', async () => {
  const calls = [], activeProject = { current: 'project-a' }, state = { projectId: 'project-a' };
  const api = async (path, method, body) => { calls.push({ path, method, body }); return method === 'POST' ? { link: { shortUrl: 'https://go.example.com/s/new-link' } } : { links: [{ shortUrl: 'https://go.example.com/s/existing' }] }; };
  const mediaItems = [{ type: 'image', url: 'https://cdn.example.com/art.jpg' }];
  const result = await compile({ state, activeProject, api })({ content: 'Visit https://example.com/s/launch. Or https://go.example.com/s/existing', campaignId: 'launch', mediaItems, platformOverrides: { instagram: { content: 'Launch https://example.com/s/launch!', mediaItems }, facebook: { content: '', options: { firstComment: 'Unchanged' } } } });
  assert.equal(result.content, 'Visit https://go.example.com/s/new-link. Or https://go.example.com/s/existing');
  assert.equal(result.platformOverrides.instagram.content, 'Launch https://go.example.com/s/new-link!');
  assert.equal(result.platformOverrides.facebook.content, ''); assert.deepEqual(result.platformOverrides.instagram.mediaItems, mediaItems);
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.body), [{ name: 'example.com', destination: 'https://example.com/s/launch', campaignId: 'launch' }]);
  assert.ok(calls.every(call => call.path.startsWith('/projects/project-a/links')));
});
test('caption shortening stops before a stale project can create or apply more links', async () => {
  const activeProject = { current: 'project-a' }; let writes = 0;
  const api = async (path, method) => { if (method === 'POST') writes++; activeProject.current = 'project-b'; return { links: [] }; };
  await assert.rejects(compile({ state: { projectId: 'project-a' }, activeProject, api })({ content: 'https://example.com' }), { name: 'AbortError' });
  assert.equal(writes, 0);
});

test('root shortening tracks separate account captions while reusing shared destinations and preserving account media/options', async () => {
  const calls = [], mediaItems = [{ type: 'image', url: 'https://cdn.example.test/account.jpg' }], options = { firstComment: 'Keep https://example.test/comment unchanged' };
  const api = async (path, method, body) => { calls.push({ path, method, body }); return method === 'POST' ? { link: { shortUrl: `https://go.example.test/s/${calls.filter(call => call.method === 'POST').length}` } } : { links: [] }; };
  const draft = { content: 'Shared https://example.test/shared', campaignId: 'account-campaign', platformOverrides: { facebook: { content: 'Platform https://example.test/platform' } }, accountOverrides: { 'account-one': { platform: 'facebook', content: 'Account one https://example.test/account. Shared https://example.test/shared!', mediaItems, options }, 'account-two': { platform: 'facebook', content: '', options: { postType: 'feed' } }, 'account-three': { platform: 'instagram', mediaItems } } };
  const result = await compile({ state: { projectId: 'project-a' }, activeProject: { current: 'project-a' }, api })(draft);
  assert.equal(result.accountOverrides['account-one'].content, 'Account one https://go.example.test/s/3. Shared https://go.example.test/s/1!');
  assert.equal(result.accountOverrides['account-two'].content, ''); assert.equal(Object.hasOwn(result.accountOverrides['account-three'], 'content'), false);
  assert.deepEqual(result.accountOverrides['account-one'].mediaItems, mediaItems); assert.deepEqual(result.accountOverrides['account-one'].options, options); assert.equal(draft.accountOverrides['account-one'].content, 'Account one https://example.test/account. Shared https://example.test/shared!');
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.body), ['shared', 'platform', 'account'].map(path => ({ name: 'example.test', destination: 'https://example.test/' + path, campaignId: 'account-campaign' })));
  assert.ok(calls.every(call => call.path === '/projects/project-a/links'));
});
test('personalized URL tokens stay available for recipient-specific substitution', async () => {
  const activeProject = { current: 'project-a' }; let writes = 0;
  const api = async (path, method) => { if (method === 'POST') writes++; return { links: [] }; };
  const content = 'Your details: https://example.com/?email={{email}} and https://example.com/{{name}}';
  const result = await compile({ state: { projectId: 'project-a' }, activeProject, api })({ content });
  assert.equal(result.content, content); assert.equal(writes, 0);
});
test('shortening preserves balanced URL parentheses and removes surrounding sentence punctuation', async () => {
  const calls = [], api = async (_, method, body) => { if (method === 'POST') { calls.push(body.destination); return { link: { shortUrl: `https://go.example/s/${calls.length}` } }; } return { links: [] }; };
  const result = await compile({ state: { projectId: 'project-a' }, activeProject: { current: 'project-a' }, api })({ content: '(See https://en.wikipedia.org/wiki/Function_(mathematics)). And [https://example.com/path[item]].' });
  assert.deepEqual(calls, ['https://en.wikipedia.org/wiki/Function_(mathematics)', 'https://example.com/path[item]']);
  assert.equal(result.content, '(See https://go.example/s/1). And [https://go.example/s/2].');
});
test('closed post composers do not apply a late short-link result', async () => {
  const composer = await readFile(new URL('../src/PostComposer.tsx', import.meta.url), 'utf8');
  const handler = composer.slice(composer.indexOf('async function shortenLinks('), composer.indexOf('  const selectedCheck =', composer.indexOf('async function shortenLinks(')));
  let release; const pending = new Promise(resolve => { release = resolve; }), writes = [], alive = { current: true };
  const context = { onShortenLinks: () => pending, disabled: false, alive, values: { content: 'https://example.com' }, setShortening() {}, setError() {}, setContent: value => writes.push(value), setOverrides: value => writes.push(value), setProviderCheck() {} };
  const run = new Function(...Object.keys(context), `return (${stripTypeScriptTypes(handler)});`)(...Object.values(context))();
  alive.current = false; release({ content: 'https://go.example.com/s/test', platformOverrides: {} }); await run;
  assert.deepEqual(writes, []);
});

test('the composer applies root-shortened account captions alongside shared and platform captions', async () => {
  const composer = await readFile(new URL('../src/PostComposer.tsx', import.meta.url), 'utf8'), handler = composer.slice(composer.indexOf('async function shortenLinks('), composer.indexOf('  const selectedCheck =', composer.indexOf('async function shortenLinks(')));
  const values = { content: 'Shared https://example.test', accountOverrides: { 'account-one': { platform: 'facebook', content: 'Account https://example.test/account' } } }, result = { content: 'Shared https://go.example.test/s/shared', platformOverrides: {}, accountOverrides: { 'account-one': { platform: 'facebook', content: 'Account https://go.example.test/s/account' } } }, writes = {};
  const context = { onShortenLinks: async draft => { assert.equal(draft, values); return result; }, disabled: false, alive: { current: true }, values, setShortening() {}, setError() {}, setContent: value => { writes.content = value; }, setOverrides: value => { writes.platformOverrides = value; }, setAccountOverrides: value => { writes.accountOverrides = value; }, setProviderCheck() {} };
  await new Function(...Object.keys(context), `return (${stripTypeScriptTypes(handler)});`)(...Object.values(context))(); assert.deepEqual(writes, result);
});
