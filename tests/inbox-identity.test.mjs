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
