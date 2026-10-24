// ten98-campaign#241: technical terms QA round 4 still found after the #220 plain-language sweep stay out of the screens
// they were found on. Each old phrase is checked in the source that renders it, beside the plain wording that replaced it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = (file: string) => readFile(new URL('../src/' + file, import.meta.url), 'utf8');
const screens: [file: string, gone: string[], shown: string[]][] = [
  ['PostComposer.tsx', ['Connect them in Integrations', 'Connect social accounts in Integrations', 'Connect Zernio in Integrations', 'Open integrations'], ['Connect them in Settings › Connections', 'Open Connections']],
  ['DirectCampaigns.tsx', ['sending in Integrations', 'contact hygiene'], ['sending in Settings › Connections', 'Check the contacts before sending.']],
  ['CampaignLinks.tsx', ['Website origins:', 'Project administrators manage this setup.'], ['Your website addresses:']],
  ['main.tsx', ['label="Provider name"'], ['label="Partner name"']],
  ['OohMap.tsx', ["header: 'Placement'", 'legend="Placement"', 'label="Placement name"'], ["header: 'Billboard'", 'legend="Billboard"', 'label="Billboard name"']],
];

for (const [file, gone, shown] of screens) test(`${file} uses plain words instead of Integrations, origins, hygiene, provider and placement`, async () => {
  const text = await source(file);
  for (const phrase of gone) assert.ok(!text.includes(phrase), `${file} still shows “${phrase}”.`);
  for (const phrase of shown) assert.ok(text.includes(phrase), `${file} shows “${phrase}”.`);
});
