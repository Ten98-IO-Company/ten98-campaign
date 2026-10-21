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
