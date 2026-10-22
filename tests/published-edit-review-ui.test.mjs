import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as ui from '@ten98/ui';
import * as app from '@ten98/ui/app';
import * as social from '../shared/social-posts.ts';

// PostManagement compiled with injectable hooks: the module's review hook, status and component share one hook set.
const source = await readFile(new URL('../src/PostManagement.tsx', import.meta.url), 'utf8');
const { code } = await transformWithOxc(source.replace(/^import .+;\r?\n/gm, '').replace('export default function PostManagement', 'function PostManagement'), 'PostManagement.tsx', { jsx: { runtime: 'classic' } });
function compile(hooks) {
  const context = { React, ...hooks, ...ui, ...app, ...social, PostComposer: () => null, PostVariantPreview: () => null };
  return new Function(...Object.keys(context), code + ';return { PostManagement, YouTubeMetadata, useEditReview, EditReviewStatus, reviewStatus };')(...Object.values(context));
}
const staticHooks = { useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}], useRef: current => ({ current }), useEffect() {} };
// A minimal hook host: state persists between renders, so a returned callback sees the state of the render that made it.
function host() {
  const states = [], refs = []; let s = 0, r = 0;
  const module = compile({ useState: initial => { const k = s++; if (!(k in states)) states[k] = typeof initial === 'function' ? initial() : initial; return [states[k], value => { states[k] = typeof value === 'function' ? value(states[k]) : value; }]; }, useRef: current => { const k = r++; refs[k] ??= { current }; return refs[k]; }, useEffect() {} });
  return { module, refs, render: (...args) => { s = 0; r = 0; return module.useEditReview(...args); } };
}
const required = () => Object.assign(new Error('An owner or administrator must approve this post before it can be sent to a provider.'), { status: 403, code: 'PUBLISHING_APPROVAL_REQUIRED' });
const stale = () => Object.assign(new Error('This post or its creative changed after approval.'), { status: 409, code: 'PUBLISHING_APPROVAL_STALE' });

test('only the publishing-approval answers open the review step', () => {
  const { reviewStatus } = compile(staticHooks);
  assert.equal(reviewStatus(required()), 'required');
  assert.equal(reviewStatus(stale()), 'stale');
  for (const other of [{ status: 403, code: 'APPROVED_PROVIDER_EDIT_RESTRICTED' }, { status: 409, code: 'POST_CHANGED' }, { status: 400, code: 'INVALID_APPROVAL_FIELDS' }, { status: 409, code: 'PUBLISHING_APPROVAL_REQUIRED' }, new Error('offline'), undefined]) assert.equal(reviewStatus(other), null);
});

test('a held change asks for review of exactly its proposal and reports that it awaits review', async () => {
  const sent = [], h = host(), proposal = { accountId: 'acct', content: 'New text' };
  const ask = async value => { sent.push(value); return { item: { post: { id: 'post' }, review: { status: 'pending' } } }; };
  let review = h.render('post', ask);
  assert.equal(review.hold(new Error('offline'), proposal), false); review = h.render('post', ask); assert.equal(review.review, null);
  assert.equal(review.hold(required(), proposal), true); review = h.render('post', ask);
  assert.deepEqual(review.review, { status: 'required', proposal });
  await review.ask(); review = h.render('post', ask);
  assert.deepEqual(sent, [proposal]); assert.equal(review.review.status, 'pending'); assert.equal(review.busy, false);
  // A send before approval is answered "required" again: the step says it is not approved yet rather than starting over.
  review.hold(required(), { ...proposal }); review = h.render('post', ask); assert.equal(review.review.status, 'waiting');
  review.hold(stale(), proposal); review = h.render('post', ask); assert.equal(review.review.status, 'stale');
  review.clear(); review = h.render('post', ask); assert.equal(review.review, null);
});

test('review asks are single-flight, scoped to their proposal and need a readable answer', async () => {
  const h = host(), proposal = { accountId: 'acct', content: 'A' }; let finish, calls = 0;
  const ask = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  let review = h.render('post', ask); review.hold(required(), proposal); review = h.render('post', ask);
  const first = review.ask(); review = h.render('post', ask); assert.equal(review.busy, true); await review.ask(); assert.equal(calls, 1);
  review.clear(); review = h.render('post', ask); finish({ item: { post: { id: 'post' }, review: { status: 'pending' } } }); await first; review = h.render('post', ask);
  assert.equal(review.review, null, 'an answer for a cleared change is ignored');
  for (const answer of [{}, { item: { post: { id: 'other' }, review: { status: 'pending' } } }, { item: { post: { id: 'post' }, review: { status: 'rejected' } } }]) {
    const next = host(); let value = next.render('post', async () => answer); value.hold(required(), proposal); value = next.render('post', async () => answer);
    await value.ask(); value = next.render('post', async () => answer);
    assert.equal(value.review.status, 'required'); assert.match(value.review.error, /could not confirm the review/i);
  }
  const failing = host(), invalid = async () => { throw Object.assign(new Error('Use only the fields shown in the approval form.'), { status: 400, code: 'INVALID_APPROVAL_FIELDS' }); };
  let value = failing.render('post', invalid); value.hold(stale(), proposal); value = failing.render('post', invalid); await value.ask(); value = failing.render('post', invalid);
  assert.equal(value.review.status, 'stale'); assert.equal(value.review.error, 'Use only the fields shown in the approval form.');
  const without = host().render('post'); assert.equal(without.ask, undefined);
});

test('the review status explains each state and offers the next step', () => {
  const { EditReviewStatus } = compile(staticHooks), proposal = { accountId: 'acct', content: 'A' }, ask = () => {};
  const html = (review, extra = {}) => renderToStaticMarkup(React.createElement(EditReviewStatus, { review, busy: false, ask, ...extra }));
  assert.equal(html(null), '');
  const needed = html({ status: 'required', proposal });
  assert.match(needed, /owner or administrator to approve changes to published copies/); assert.match(needed, />Request review of this change</); assert.match(needed, /role="status"/);
  assert.match(html({ status: 'stale', proposal }), /no longer matches its approved review/);
  assert.match(html({ status: 'waiting', proposal }), /not approved yet/);
  const pending = html({ status: 'pending', proposal }); assert.match(pending, /awaits review/); assert.doesNotMatch(pending, /Request review of this change/);
  assert.match(html({ status: 'approved', proposal }), /approved\. Send it again/);
  assert.match(html({ status: 'required', proposal, error: 'Not allowed.' }), /role="alert"[^>]*>[\s\S]*Not allowed\./);
  assert.match(html({ status: 'required', proposal }, { busy: true }), /disabled=""[^>]*>Request review of this change</);
  const unavailable = html({ status: 'required', proposal }, { ask: undefined }); assert.doesNotMatch(unavailable, /<button/); assert.match(unavailable, /owner or administrator/);
});

test('published copies keep their direct edit and only show the review step after the server asks for one', () => {
  const { PostManagement } = compile(staticHooks), copy = { accountId: { _id: 'acct', displayName: 'Brand' }, platform: 'twitter', status: 'published', customContent: 'Live text' };
  const html = renderToStaticMarkup(React.createElement(PostManagement, { request: async () => ({}), onRequestReview: async () => ({}), post: { id: 'post', status: 'published', providerResults: [copy] }, canWrite: true }));
  assert.match(html, />Update live text</); assert.doesNotMatch(html, /Request review of this change|awaits review/);
});

test('both published-copy sends hold their exact proposal for review and the ask goes to the approvals route', () => {
  assert.match(source, /act\('social\/edit-published', \{ postId: post\.id, accountId: accountId\(item\), content, confirmEdit: true \}, 'Published copy updated\.', error => \(held = review\.hold\(error, \{ accountId: accountId\(item\), content \}\)\)\); if \(!held\) review\.clear\(\);/);
  assert.match(source, /onRequestReview\('approvals\/posts\/' \+ encodeURIComponent\(post\.id\) \+ '\/request', \{ action, proposal \}\)/);
  assert.match(source, /editReview\.hold\(problem, proposal\)/);
});
