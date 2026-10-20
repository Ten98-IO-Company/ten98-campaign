import test from 'node:test';
import assert from 'node:assert/strict';
import { validProviderInstant } from '../server/provider-core.ts';
import { assertQueueReceipt } from '../server/zernio-queues.mjs';

test('provider publication timestamps require real calendar dates and an unambiguous offset', () => {
  for (const value of ['2070-11-01T09:00:00Z', '2068-02-29T00:00:00.123Z', '2070-11-01T00:05:06+14:00', '2070-11-01T09:00:00-04:00']) {
    assert.equal(validProviderInstant(value), true, value);
    assert.doesNotThrow(() => assertQueueReceipt({ status: 'scheduled', scheduledFor: value }, { queueId: 'queue-a' }, 'profile-a'));
  }
  for (const value of ['2070-11-01T09:00:00', 'March 1, 2070', '2070-02-31T09:00:00Z', '2070-02-29T09:00:00Z', '2070-11-01T24:00:00Z', '2070-11-01T09:00:00+25:00', '2070-13-01T09:00:00Z', '', null, 1]) {
    assert.equal(validProviderInstant(value), false, String(value));
    assert.throws(() => assertQueueReceipt({ status: 'scheduled', scheduledFor: value }, { queueId: 'queue-a' }, 'profile-a'), error => error.status === 502 && error.uncertain === true);
  }
});
