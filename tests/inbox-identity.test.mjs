import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

test('the inbox keeps equal provider conversation IDs separate by connected account', () => {
  // Exercise the UI's small identity helper without mounting the app or adding a UI framework.
  const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const declaration = source.match(/^function conversationKey\(row: Row\) \{[^\r\n]+\}$/m)?.[0];
  assert.ok(declaration, 'Keep the inbox identity helper available for the regression check.');
  const key = runInNewContext(declaration.replace('(row: Row)', '(row)') + '; conversationKey');
  const first = { accountId: 'account-a', id: 'shared-contact' }, second = { accountId: 'account-b', id: 'shared-contact' };
  assert.notEqual(key(first), key(second));
  assert.equal(key({ accountId: 'account-a', id: 'local-cache-id', externalConversationId: 'shared-contact' }), key(first));
  assert.equal(key({ accountId: 'account-a', _id: 'shared-contact' }), key(first));
  assert.notEqual(key({ id: 'shared-contact' }), key(first));
  assert.equal([first, second].find(row => key(row) === key(second)), second, 'Selecting account B must keep replies and resolution on account B.');
  assert.equal(new Map([[key(first), first], [key(second), second]]).size, 2);
});

test('inbox message merging retains older history and gives webhook tombstones and receipts precedence', () => {
  const source = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  const declaration = source.match(/^function mergeMessages\(messages: Row\[\], updates: Row\[\]\) \{[^\r\n]+\}$/m)?.[0];
  assert.ok(declaration, 'Keep the message merge helper available for the regression check.');
  const merge = runInNewContext(declaration.replace('(messages: Row[], updates: Row[])', '(messages, updates)') + '; mergeMessages');
  const history = [{ id: 'oldest', content: 'Older page retained', sentAt: '2026-10-18T09:00:00Z' }, { _id: 'deleted', content: 'Old visible content', createdAt: '2026-10-18T10:00:00Z' }, { id: 'receipt', content: 'Reply', createdAt: '2026-10-18T11:00:00Z', deliveryStatus: 'sent' }];
  const updates = [{ id: 'deleted', content: '', deletedAt: '2026-10-18T12:00:00Z', createdAt: '2026-10-18T10:00:00Z' }, { id: 'receipt', content: 'Reply', createdAt: '2026-10-18T11:00:00Z', deliveryStatus: 'read' }, { id: 'newest', content: 'New incoming message', sentAt: '2026-10-18T12:00:00Z' }];
  const merged = merge(history, updates);
  assert.deepEqual(Array.from(merged, row => row.id || row._id), ['oldest', 'deleted', 'receipt', 'newest']);
  assert.equal(merged.find(row => row.id === 'deleted').content, ''); assert.ok(merged.find(row => row.id === 'deleted').deletedAt);
  assert.equal(merged.find(row => row.id === 'receipt').deliveryStatus, 'read');
  assert.equal(merged.length, 4, 'A webhook update replaces an existing message rather than duplicating it.');
  const fetchedOlderPage = [{ id: 'even-older', content: 'First page in time', createdAt: '2026-10-18T08:00:00Z' }, ...history];
  const paged = merge(fetchedOlderPage, merged);
  assert.deepEqual(Array.from(paged, row => row.id || row._id), ['even-older', 'oldest', 'deleted', 'receipt', 'newest']);
  assert.ok(paged.find(row => row.id === 'deleted').deletedAt); assert.equal(paged.find(row => row.id === 'receipt').deliveryStatus, 'read', 'Reading an older REST page cannot overwrite current webhook evidence.');
  const platformOnly = merge([{ platformMessageId: 'native-message', text: 'Before', sentAt: '2026-10-18T07:00:00Z' }], [{ platformMessageId: 'native-message', text: 'Edited', sentAt: '2026-10-18T07:00:00Z' }]);
  assert.equal(platformOnly.length, 1); assert.equal(platformOnly[0].text, 'Edited');
  const timestampFallback = merge([{ id: 'later', createdAt: '', sentAt: '2026-10-18T10:00:00Z' }], [{ id: 'earlier', createdAt: '2026-10-18T09:00:00Z', sentAt: '2026-10-18T11:00:00Z' }]);
  assert.deepEqual(Array.from(timestampFallback, row => row.id), ['earlier', 'later']);
  assert.equal(history.find(row => row.id === 'receipt').deliveryStatus, 'sent', 'Merging does not mutate the loaded history.');
});
