import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import { PLATFORM_RULES } from '../shared/social-posts.ts';

test('approval cards expose every saved recipient when account copies inherit the shared version', async () => {
  const source = await readFile(new URL('../src/ContentApprovals.tsx', import.meta.url), 'utf8');
  const { code } = await transformWithOxc(source.replace(/^import .*;\r?\n/gm, '').replace('export default function', 'function'), 'ContentApprovals.tsx', { jsx: { runtime: 'classic' } });
  const item = { post: { id: 'post-one', content: 'Shared reviewed caption', platforms: ['facebook'], accounts: ['inherited-account-one', 'inherited-account-two'], platformOverrides: {}, accountOverrides: {}, mediaItems: [] }, status: 'pending', review: { id: 'review-one', requestedAt: '2030-01-01T00:00:00Z' } };
  const data = { requireApproval: true, posts: [item] }, calls = [];
  let stateIndex = 0;
  const ui = Object.entries(await import('@ten98/ui')).filter(([name]) => /^[A-Z]/.test(name));
  const Component = new Function('React', 'useEffect', 'useRef', 'useState', 'PostVariantPreview', 'PLATFORM_RULES', ...ui.map(([name]) => name), code + '; return ContentApprovals;')(React, () => {}, value => ({ current: value }), initial => [stateIndex++ === 0 ? data : initial, () => {}], () => null, PLATFORM_RULES, ...ui.map(([, value]) => value));
  const html = renderToStaticMarkup(Component({ projectId: 'project-one', role: 'owner', request: async (...args) => { calls.push(args); } }));
  assert.match(html, /Selected account IDs:<\/strong> inherited-account-one, inherited-account-two/);
  assert.match(html, /2 selected accounts/);
  assert.match(html, /Approve post/);
  assert.deepEqual(calls, [], 'Rendering the saved recipient scope does not start a provider or approval request.');
});

test('a pending change to a published post shows the account and the proposed values beside the current copy', async () => {
  const source = await readFile(new URL('../src/ContentApprovals.tsx', import.meta.url), 'utf8');
  const { code } = await transformWithOxc(source.replace(/^import .*;\r?\n/gm, '').replace('export default function', 'function'), 'ContentApprovals.tsx', { jsx: { runtime: 'classic' } });
  const ui = Object.entries(await import('@ten98/ui')).filter(([name]) => /^[A-Z]/.test(name));
  const render = (posts, role = 'owner') => {
    let stateIndex = 0; const calls = [];
    const Component = new Function('React', 'useEffect', 'useRef', 'useState', 'PostVariantPreview', 'PLATFORM_RULES', ...ui.map(([name]) => name), code + '; return ContentApprovals;')(React, () => {}, value => ({ current: value }), initial => [stateIndex++ === 0 ? { requireApproval: true, posts } : initial, () => {}], () => null, PLATFORM_RULES, ...ui.map(([, value]) => value));
    const html = renderToStaticMarkup(Component({ projectId: 'project-one', role, request: async (...args) => { calls.push(args); } }));
    assert.deepEqual(calls, []); return html;
  };
  const post = { id: 'live-post', status: 'published', content: 'Shared live text', platforms: ['facebook', 'youtube'], accounts: ['fb-a', 'yt-a'], tags: ['launch'], platformOverrides: {}, accountOverrides: { 'fb-a': { platform: 'facebook', content: 'Live facebook\ntext' } }, providerVariants: [], mediaItems: [], queueId: 'queue-one' };
  const textEdit = { path: 'social/edit-published', accountId: 'fb-a', platform: 'facebook', content: 'Corrected facebook\ntext' };
  const pending = (publishedEdit, status = 'pending') => ({ post, status: 'submitted', queue: null, assets: [], asset: null, review: { id: 'review-live', status, requestedAt: '2030-01-01T00:00:00Z', requestedBy: { name: 'Editor' }, snapshot: { publishedEdit, proposal: {} } } });
  const html = render([pending(textEdit)]);
  assert.match(html, /Change to a published post/);
  assert.match(html, /Account:<\/strong> Facebook · fb-a/);
  assert.match(html, /Current copy[\s\S]*t98-text--pre[^>]*>Live facebook\ntext<[\s\S]*Proposed change[\s\S]*t98-text--pre[^>]*>Corrected facebook\ntext</);
  assert.match(html, /Awaiting review/); assert.match(html, />Approve post</); assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Approve post</, 'a published post’s queue does not block approving its change');
  assert.match(html, /Select Shared live text for bulk review/, 'the change joins keyboard and bulk review');
  // The live copy can also come from the provider when it differs from the stored post.
  assert.match(render([{ ...pending(textEdit), post: { ...post, providerVariants: [{ platform: 'facebook', accountId: 'fb-a', customContent: 'Provider live text' }] } }]), /t98-text--pre[^>]*>Provider live text</);
  const metadata = render([pending({ path: 'social/update-metadata', accountId: 'yt-a', platform: 'youtube', videoId: 'aaaaaaaaaaa', title: 'New title', tags: [] })]);
  assert.match(metadata, /Account:<\/strong> YouTube · yt-a · Video aaaaaaaaaaa/);
  assert.match(metadata, /Current copy[\s\S]*Title:<\/strong> Not available in Campaign[\s\S]*Keyword tags:<\/strong> launch[\s\S]*Proposed change[\s\S]*t98-text--pre[^>]*><strong[^>]*>Title:<\/strong> New title<[\s\S]*Keyword tags:<\/strong> Remove all keyword tags/);
  // Decided changes keep the submitted card; editors see the change without review controls.
  const decided = render([pending(textEdit, 'approved')]);
  assert.doesNotMatch(decided, /Change to a published post|Approve post/); assert.match(decided, /Submitted to provider/);
  const editor = render([pending(textEdit)], 'editor'); assert.match(editor, /Change to a published post/); assert.doesNotMatch(editor, /Approve post|>Request review</);
});
