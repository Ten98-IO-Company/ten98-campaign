import test from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, type Credential } from '../server/auth.ts';

// The type check (tsc -p tsconfig.backend.json, part of `pnpm test`) is the real assertion: if Credential stopped being a
// brand, the @ts-expect-error below would be unused and fail the build.
test('account writes accept only a Credential made by hashPassword', async () => {
  const made: Credential = await hashPassword('credential brand fixture password');
  assert.equal(typeof made, 'string');
  // @ts-expect-error A plain string is not a Credential, so no caller can store a hash that server/auth.ts did not make.
  const forged: Credential = 'not a hash from server/auth.ts';
  assert.equal(typeof forged, 'string');
});
