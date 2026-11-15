import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// Since @ten98/ui 0.38.0 a non-danger ConfirmDialog opens with focus on Confirm, so a held or repeated Enter on the
// button that opened it confirms at once. Every confirm here must therefore either be a plain `danger` dialog (which
// opens on Cancel) or say where focus starts. Confirms that publish, send, spend or act publicly start on Cancel.
const consequential = [
  ['main.tsx', 'open={!!publishing}'], // publish now, schedule or queue a post
  ['AdDetails.tsx', 'open={confirmingEnable}'], // enable an ad that can spend
  ['NativeGoogleAds.tsx', "title={confirming?.title || ''}"], // Google campaign enable and budget changes
  ['MicrosoftAds.tsx', 'title="Apply this Microsoft campaign change?"'], // campaign changes that can incur charges
  ['GoogleAdsTools.tsx', 'title={`${verb} keyword`}'], // add or enable a keyword
  ['DirectCampaigns.tsx', 'open={confirmingTest}'], // send a test SMS or email
  ['CampaignAgent.tsx', 'title="Have you reviewed this request'], // permits a new paid model request
  ['PostManagement.tsx', 'danger={confirming?.danger}'], // retry publishing, edit a live post
  ['UnifiedInbox.tsx', "danger={confirming?.kind !== 'hide'}"], // hide a public comment
  ['CampaignLinks.tsx', 'open={!!archiving}'], // restore a public short link
];
const confirms = async () => {
  const files = (await readdir(new URL('../src/', import.meta.url))).filter(name => /\.tsx$/.test(name)), found = [];
  for (const file of files) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
    for (const match of source.matchAll(/<ConfirmDialog\b[^\n]*/g)) found.push({ file, tag: match[0] });
  }
  return found;
};

test('consequential confirms open with focus on Cancel', async () => {
  const all = await confirms();
  for (const [file, fragment] of consequential) {
    const matching = all.filter(item => item.file === file && item.tag.includes(fragment));
    assert.equal(matching.length, 1, `${file}: one confirm matches ${fragment}`);
    assert.match(matching[0].tag, /\binitialFocus="cancel"/, `${file}: ${fragment} must open on Cancel`);
  }
});

test('every confirm is a plain danger dialog or declares where focus starts', async () => {
  const all = await confirms();
  assert.ok(all.length >= 20, `found ${all.length} confirms`);
  for (const { file, tag } of all) assert.ok(/\sdanger(?=[\s/>])(?!=)/.test(tag) || /\binitialFocus="(cancel|confirm)"/.test(tag), `${file}: ${tag.slice(0, 120)}`);
});
