import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { createDisplayFormatter } from '@ten98/ui';
import { appFormat, currencyDigits, displayLocale, minorDigits } from '../src/display-locale.ts';

const read = (path: string) => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('Campaign displays in American English in the viewer\'s time zone, inside and outside React', async () => {
  assert.equal(displayLocale, 'en-US', 'Owner decision, 2026-11-15.');
  const main = await read('main.tsx');
  assert.match(main, /<DisplayFormatProvider locale=\{displayLocale\}>/, 'The app root sets the locale and leaves the time zone to the viewer.');
  const utc = createDisplayFormatter({ locale: displayLocale, timeZone: 'UTC' });
  assert.equal(utc.dateTime('2026-11-13T14:05:00Z'), 'Nov 13, 2026, 2:05 PM');
  assert.equal(utc.count(0, { one: 'post', other: 'posts' }), '0 posts', 'English plural rules for English nouns, whatever the browser language.');
  assert.equal(appFormat.number(1234.5), '1,234.5');
  // Every formatter made outside the provider takes the same locale; none falls back to the browser's.
  for (const file of ['ads-view.ts', 'approval-status.ts', 'ZernioBlogDrafts.tsx', 'ZernioMediaUpload.tsx', 'ZernioQueues.tsx', 'OfflineActivations.tsx']) {
    const source = await read(file);
    assert.doesNotMatch(source, /createDisplayFormatter\(\)|createDisplayFormatter\(\{ timeZone|Intl\.DateTimeFormat\(undefined/, file);
  }
});

test('one minor-digit lookup serves every money helper', async () => {
  assert.deepEqual(['JPY', 'USD', 'KWD', 'aed'].map(minorDigits), [0, 2, 3, 2]);
  assert.deepEqual([undefined, '', 'US', 'US$', 12].map(minorDigits), [2, 2, 2, 2, 2], 'Missing or malformed codes default to 2.');
  assert.equal(currencyDigits('US$'), undefined, 'An unusable code has no known minor unit.');
  for (const file of ['AdComposer.tsx', 'approval-status.ts', 'google-micros.ts']) {
    assert.doesNotMatch(await read(file), /resolvedOptions\(\)\.maximumFractionDigits/, `${file} uses minorDigits or currencyDigits.`);
  }
});

test('no hand-rolled plural, dollar sign or fixed-decimal display remains in the swept screens', async () => {
  for (const file of ['AssetLibrary.tsx', 'AccountSettings.tsx', 'AdCampaignDiscovery.tsx']) assert.doesNotMatch(await read(file), /=== 1 \? '/, file);
  const main = await read('main.tsx');
  assert.doesNotMatch(main, /\.toFixed\(2\)/, 'CTR and ROAS read as the Ads metrics do: "2.5×", not "2.50×".');
  const agent = await read('CampaignAgent.tsx');
  assert.doesNotMatch(agent, /`\$\$\{/, 'Cost goes through the shared currency formatter.');
  const declaration = agent.match(/^const usdCost = .+;$/m)?.[0];
  assert.ok(declaration);
  const usdCost = runInNewContext(stripTypeScriptTypes(declaration) + '; usdCost');
  assert.deepEqual([0.000123, 0.5, 2, 0].map(cost => appFormat.currency(usdCost(cost), 'USD')), ['$0.000123', '$0.50', '$2.00', '$0.00'], 'Fractions of a cent stay visible; whole cents keep two decimals.');
});
