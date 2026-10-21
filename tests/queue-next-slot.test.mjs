import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = (await readFile(new URL('../src/PostComposer.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const start = source.indexOf('function nextQueueSlot('), body = start < 0 ? '' : source.slice(start, source.indexOf('\n}\n', start) + 2);
const nextSlot = (...args) => new Function(`${stripTypeScriptTypes(body)}; return nextQueueSlot;`)()(...args)?.toISOString() ?? null;

test('the next weekly queue slot is computed in the queue time zone from loaded slots only', () => {
  assert.ok(body, 'PostComposer defines nextQueueSlot.');
  const slots = [{ dayOfWeek: 1, time: '09:00' }, { dayOfWeek: 3, time: '18:00' }];
  // Tuesday 14:00 in Dubai: the Wednesday 18:00 slot comes before next Monday.
  assert.equal(nextSlot(slots, 'Asia/Dubai', new Date('2026-03-03T10:00:00Z')), '2026-03-04T14:00:00.000Z');
  // A slot at the current minute is not offered again; the next one is.
  assert.equal(nextSlot([{ dayOfWeek: 3, time: '18:00' }], 'Asia/Dubai', new Date('2026-03-04T14:00:30Z')), '2026-03-11T14:00:00.000Z');
});

test('queue slots keep their wall-clock time across a daylight-saving change and bad data yields no hint', () => {
  // Saturday 10:00 EST; Sunday 09:00 is already daylight time in New York.
  assert.equal(nextSlot([{ dayOfWeek: 0, time: '09:00' }], 'America/New_York', new Date('2026-03-07T15:00:00Z')), '2026-03-08T13:00:00.000Z');
  // Sunday 02:30 does not exist on 2027-03-14 in New York (clocks jump from 02:00 to 03:00): the post-gap 03:30 EDT is shown.
  assert.equal(nextSlot([{ dayOfWeek: 0, time: '02:30' }], 'America/New_York', new Date('2027-03-13T17:00:00Z')), '2027-03-14T07:30:00.000Z');
  // The repeated hour on 2027-11-07 keeps a real 01:30 rather than skipping the slot.
  assert.equal(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(nextSlot([{ dayOfWeek: 0, time: '01:30' }], 'America/New_York', new Date('2027-11-06T17:00:00Z')))), '01:30');
  assert.equal(nextSlot([], 'Asia/Dubai', new Date('2026-03-03T10:00:00Z')), null);
  assert.equal(nextSlot([{ dayOfWeek: 1, time: '09:00' }], 'Not/AZone', new Date('2026-03-03T10:00:00Z')), null);
  assert.equal(nextSlot([{ dayOfWeek: 9, time: 'soon' }], 'Asia/Dubai', new Date('2026-03-03T10:00:00Z')), null);
});
