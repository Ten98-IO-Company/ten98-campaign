import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as adsView from '../src/ads-view.ts';
import { testDisplayFormat as format } from './display-format.ts';

// Money follows each currency's minor unit (the owner accepted this rounding when the shared formatter replaced the old
// fixed two-decimal display, #308/#309): JPY has none, KWD has three, USD two, and halves round away from zero on the
// decimal value, never on the binary float (2.675 is $2.68, not toFixed's $2.67). Amounts of 100 or more show whole units.
const cells = (metrics: Record<string, number>, currency: string) => adsView.adMetricCells(metrics, currency, false, format).map(({ label, value }: { label: string; value: string }) => [label, value]);

test('ad Spend, CPC and CPM round to each currency\'s minor unit', () => {
  assert.deepEqual(cells({ spend: 1234.5, cpc: 0.4, cpm: 87.6 }, 'JPY'), [['Spend', '¥1,235'], ['CPC', '¥0'], ['CPM', '¥88']], 'JPY has no minor unit.');
  assert.deepEqual(cells({ spend: 12.3456, cpc: 0.1234, cpm: 1.2345 }, 'KWD'), [['Spend', 'KWD\u00a012.346'], ['CPC', 'KWD\u00a00.123'], ['CPM', 'KWD\u00a01.235']], 'KWD has three decimals.');
  assert.deepEqual(cells({ spend: 1234.5678 }, 'KWD'), [['Spend', 'KWD\u00a01,235']], 'From 100 up, whole units in every currency.');
  assert.deepEqual(cells({ spend: 12.345, cpc: 0.125, cpm: 2.675 }, 'USD'), [['Spend', '$12.35'], ['CPC', '$0.13'], ['CPM', '$2.68']], 'Three-decimal values round half away from zero on the decimal value.');
});

test('ad purchase value rounds to the campaign currency\'s minor unit', async () => {
  const details = await readFile(new URL('../src/AdDetails.tsx', import.meta.url), 'utf8');
  assert.match(details, /key: 'purchaseValue'[^\n]*format\.currency\(ad\.metrics\.purchaseValue, data\.campaign\.currency\)/, 'The column formats with the campaign currency and no other options.');
  assert.deepEqual([format.currency(1234.5, 'JPY'), format.currency(12.3456, 'KWD'), format.currency(0.125, 'USD'), format.currency(2.675, 'USD')], ['¥1,235', 'KWD\u00a012.346', '$0.13', '$2.68']);
});
