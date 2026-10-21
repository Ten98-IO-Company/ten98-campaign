import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = (await readFile(new URL('../src/PostComposer.tsx', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const localTime = source.match(/^const localTime = .+;$/m)?.[0];
const start = source.indexOf('function presetTime('), preset = start < 0 ? '' : source.slice(start, source.indexOf('\n}\n', start) + 2);

function presetsIn(zone, now) {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    const presetTime = new Function(`${stripTypeScriptTypes(localTime + '\n' + preset)}; return presetTime;`)();
    // The composer saves its datetime-local value with new Date(value).toISOString(); presets must survive that conversion.
    return Object.fromEntries(['tomorrow-9', 'tomorrow-18', 'monday-9'].map(key => { const value = presetTime(key, new Date(now)); return [key, { value, saved: new Date(value).toISOString() }]; }));
  } finally { process.env.TZ = previous; if (previous === undefined) delete process.env.TZ; }
}

test('quick schedule presets are wall-clock times in the composer time zone', () => {
  assert.ok(localTime && preset, 'PostComposer defines presetTime beside localTime.');
  // Friday 23:30 in Dubai is still Friday there although it is already 19:30 UTC.
  const dubai = presetsIn('Asia/Dubai', '2026-03-06T19:30:00Z');
  assert.deepEqual(dubai['tomorrow-9'], { value: '2026-03-07T09:00', saved: '2026-03-07T05:00:00.000Z' });
  assert.deepEqual(dubai['tomorrow-18'], { value: '2026-03-07T18:00', saved: '2026-03-07T14:00:00.000Z' });
  assert.deepEqual(dubai['monday-9'], { value: '2026-03-09T09:00', saved: '2026-03-09T05:00:00.000Z' });
});

test('presets keep 9 AM local across a daylight-saving change and a Monday moves a full week', () => {
  // Saturday before US daylight saving starts on Sunday 8 March 2026.
  const newYork = presetsIn('America/New_York', '2026-03-07T15:00:00Z');
  assert.deepEqual(newYork['tomorrow-9'], { value: '2026-03-08T09:00', saved: '2026-03-08T13:00:00.000Z' });
  assert.deepEqual(newYork['monday-9'], { value: '2026-03-09T09:00', saved: '2026-03-09T13:00:00.000Z' });
  const monday = presetsIn('Europe/London', '2026-06-01T07:00:00Z');
  assert.equal(monday['monday-9'].value, '2026-06-08T09:00', 'On a Monday the preset is the following Monday, not today.');
  assert.equal(monday['tomorrow-18'].saved, '2026-06-02T17:00:00.000Z');
});
