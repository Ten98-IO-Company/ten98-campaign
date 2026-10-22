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

test('a pending update to a submitted post shows each proposed field beside the current copy', async () => {
  const source = await readFile(new URL('../src/ContentApprovals.tsx', import.meta.url), 'utf8');
  const { code } = await transformWithOxc(source.replace(/^import .*;\r?\n/gm, '').replace('export default function', 'function'), 'ContentApprovals.tsx', { jsx: { runtime: 'classic' } });
  const ui = Object.entries(await import('@ten98/ui')).filter(([name]) => /^[A-Z]/.test(name));
  const render = (posts, role = 'owner') => {
    let stateIndex = 0; const calls = [];
    const Component = new Function('React', 'useEffect', 'useRef', 'useState', 'PostVariantPreview', 'PLATFORM_RULES', ...ui.map(([name]) => name), code + '; return ContentApprovals;')(React, () => {}, value => ({ current: value }), initial => [stateIndex++ === 0 ? { requireApproval: true, posts } : initial, () => {}], ({ platform, variant }) => React.createElement('output', null, `Preview ${platform}: ${variant.content}`), PLATFORM_RULES, ...ui.map(([, value]) => value));
    const html = renderToStaticMarkup(Component({ projectId: 'project-one', role, request: async (...args) => { calls.push(args); } }));
    assert.deepEqual(calls, [], 'Rendering a proposed update starts no request.'); return html;
  };
  const local = value => new Date(value).toLocaleString().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const facebook = { content: 'Current\ncaption', mediaItems: [], options: {} }, instagram = { content: 'Current\ncaption', mediaItems: [{ type: 'image', url: 'https://cdn.example/one.png' }], options: {} };
  const post = { id: 'queued-post', status: 'scheduled', content: 'Current\ncaption', platforms: ['facebook', 'instagram'], accounts: ['fb-a', 'ig-a'], tags: ['launch'], scheduledAt: '2030-02-01T10:00:00.000Z', mediaItems: [{ type: 'image', url: 'https://cdn.example/one.png' }], assetId: '', platformOverrides: { facebook, instagram }, providerVariants: [], queueId: 'queue-one' };
  const proposal = { content: 'Proposed\ncaption', tags: ['launch', 'spring'], mode: 'scheduled', scheduledAt: '2030-03-01T09:30:00.000Z', mediaItems: [], platformOverrides: { facebook: { content: 'Proposed facebook\ncaption' } }, confirmReplaceVariants: true };
  const snapshot = { content: 'Proposed\ncaption', tags: ['launch', 'spring'], platforms: post.platforms, accounts: post.accounts, mediaItems: [], platformOverrides: { facebook: { content: 'Proposed facebook\ncaption', mediaItems: [], options: {} }, instagram }, assetId: '', campaignId: '', scheduledAt: '2030-03-01T09:30:00.000Z', assets: [], asset: null, proposal };
  const item = (status = 'pending', reviewSnapshot = snapshot) => ({ post, status: 'submitted', queue: null, assets: [], asset: null, review: { id: 'review-update', status, requestedAt: '2030-01-01T00:00:00Z', requestedBy: { name: 'Editor' }, snapshot: reviewSnapshot } });
  const html = render([item()]);  assert.match(html, /Proposed update to a submitted post/);
  assert.match(html, /scope="row">Text<\/th><td>[^]*?t98-text--pre[^>]*>Current\ncaption<[^]*?<\/td><td>[^]*?t98-text--pre[^>]*>Proposed\ncaption</);
  assert.match(html, new RegExp(`scope="row">Schedule</th><td>[^]*?${local(post.scheduledAt)}[^]*?</td><td>[^]*?${local(snapshot.scheduledAt)}`));
  assert.match(html, /scope="row">Keyword tags<\/th><td><ul[^>]*><li[^>]*>launch<\/li><\/ul><\/td><td><ul[^>]*><li[^>]*>launch<\/li><li[^>]*>spring<\/li><\/ul>/);
  assert.match(html, /scope="row">Media<\/th><td>[^]*?1 media item[^]*?<\/td><td>[^]*?No media/);
  assert.match(html, /scope="row">Platform versions<\/th>[^]*?Facebook: changed[^]*?Instagram: unchanged/);
  assert.match(html, /Preview the proposed Facebook version[^]*?Preview facebook: Proposed facebook\ncaption/);
  assert.doesNotMatch(html, /Preview the proposed Instagram version/, 'an unchanged version has no preview');
  assert.doesNotMatch(html, /scope="row">Creative</, 'only proposed fields are compared');
  assert.match(html, /Awaiting review/); assert.match(html, />Approve post</); assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Approve post</, 'a submitted post’s queue does not block approving its update');
  assert.doesNotMatch(html, /next free slot assigned on submission/);
  assert.match(html, /Select Current\ncaption for bulk review/, 'the update joins keyboard and bulk review');
  // A proposed creative is checked from the snapshot, not the live copy.
  const creative = render([item('pending', { ...snapshot, assetId: 'asset-new', asset: { id: 'asset-new', approval: 'pending' }, assets: [{ id: 'asset-new', approval: 'pending' }], proposal: { mode: 'draft', assetId: 'asset-new' } })]);
  assert.match(creative, /scope="row">Creative<\/th><td>[^]*?No referenced creative[^]*?<\/td><td>[^]*?Asset approval required/);
  assert.match(creative, /scope="row">Schedule<\/th>[^]*?Draft at the provider/);
  assert.match(creative, /<button[^>]*disabled=""[^>]*>Approve post</);
  // Decided updates and snapshots without a proposal keep the submitted card; editors see the update without controls.
  for (const settled of [item('approved'), item('pending', { ...snapshot, proposal: undefined })]) { const markup = render([settled]); assert.doesNotMatch(markup, /Proposed update to a submitted post|Approve post/); assert.match(markup, /Submitted to provider/); }
  const editor = render([item()], 'editor'); assert.match(editor, /Proposed update to a submitted post/); assert.doesNotMatch(editor, /Approve post|>Request review</);
});
