import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reviewKeyAction } from '../src/review-keys.ts';

const card = {}, field = {};
const press = (key, extra = {}) => ({ key, altKey: false, ctrlKey: false, metaKey: false, target: card, currentTarget: card, ...extra });

test('review keys act only on the focused card and honour the approval block', () => {
  assert.equal(reviewKeyAction(press('a'), true, false), 'approve');
  assert.equal(reviewKeyAction(press('A'), true, false), 'approve');
  assert.equal(reviewKeyAction(press('r'), true, false), 'reject');
  assert.equal(reviewKeyAction(press('a'), true, true), null, 'A blocked approval cannot be approved by keyboard.');
  assert.equal(reviewKeyAction(press('r'), true, true), 'reject', 'Requesting changes stays available when approval is blocked.');
  assert.equal(reviewKeyAction(press('a'), false, false), null, 'A non-pending card or a missing review role ignores A.');
  for (const modifier of ['altKey', 'ctrlKey', 'metaKey']) assert.equal(reviewKeyAction(press('a', { [modifier]: true }), true, false), null, modifier);
  assert.equal(reviewKeyAction(press('a', { target: field }), true, false), null, 'Typing "a" in the review note never approves.');
  assert.equal(reviewKeyAction(press('ArrowDown'), false, false), 'next');
  assert.equal(reviewKeyAction(press('ArrowUp'), false, false), 'previous');
  assert.equal(reviewKeyAction(press('ArrowDown', { target: field }), true, false), null);
  assert.equal(reviewKeyAction(press('x'), true, false), null);
});

test('approval cards bind the keys to the existing review action and the button block', async () => {
  const source = await readFile(new URL('../src/ContentApprovals.tsx', import.meta.url), 'utf8');
  assert.match(source, /reviewKeyAction\(event, canReview && item\.status === 'pending' && !busy, approveBlocked\(item\)\)/);
  assert.match(source, /void review\(item, action === 'approve' \? 'approved' : 'rejected'\)/);
  assert.match(source, /<Button disabled=\{approveBlocked\(item\)\} onClick=\{\(\) => review\(item, 'approved'\)\}>Approve post<\/Button>/);
  assert.match(source, /aria-keyshortcuts=\{canReview && item\.status === 'pending' \? 'A R' : undefined\}/);
});
