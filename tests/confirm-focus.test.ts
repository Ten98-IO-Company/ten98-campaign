import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// Since @ten98/ui 0.38.0 a non-danger ConfirmDialog opens with focus on Confirm, so a held or repeated Enter on the
// button that opened it confirms at once. Every confirm here must therefore either be a plain `danger` dialog (which
// opens on Cancel) or say where focus starts. Confirms that publish, send, spend or act publicly start on Cancel.
const consequential: [string, string][] = [
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
const confirms = async (): Promise<{ file: string; tag: string }[]> => {
  const files = (await readdir(new URL('../src/', import.meta.url))).filter(name => /\.tsx$/.test(name)), found: { file: string; tag: string }[] = [];
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

// The imperative useConfirmDialog() renders the same ConfirmDialog, so its questions follow the same rule: the hook's
// defaults, or each confirm({ … }) call, must make it a danger question or say where focus starts.
const settles = (options: string) => /\bdanger: true\b/.test(options) || /\binitialFocus: '(cancel|confirm)'/.test(options);
const confirmCalls = async () => {
  const files = (await readdir(new URL('../src/', import.meta.url))).filter(name => /\.tsx$/.test(name)), found: { file: string; hook: string; call: string }[] = [];
  for (const file of files) {
    const source = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'), hook = source.match(/useConfirmDialog\(([^)]*)\)/)?.[1];
    if (hook === undefined) continue;
    for (const match of source.matchAll(/\bconfirm\(\{[^\n]*?\}\)/g)) found.push({ file, hook, call: match[0] });
  }
  return found;
};

test('consequential confirm() questions open with focus on Cancel', async () => {
  const calls = await confirmCalls();
  for (const [file, fragment] of [['main.tsx', "confirmLabel: 'Activate campaign'"], ['ApprovalPolicy.tsx', "'Require approval' : 'Stop requiring approval'"]]) { // resumes ad spend; voids ad spend approvals
    const matching = calls.filter(item => item.file === file && item.call.includes(fragment));
    assert.equal(matching.length, 1, `${file}: one confirm() matches ${fragment}`);
    assert.match(matching[0].call, /\binitialFocus: 'cancel'/, `${file}: ${fragment} must open on Cancel`);
  }
});

test('every confirm() question is a danger question or declares where focus starts', async () => {
  const calls = await confirmCalls();
  assert.ok(calls.length >= 8, `found ${calls.length} confirm() calls`);
  for (const { file, hook, call } of calls) assert.ok(settles(hook) || settles(call), `${file}: ${call.slice(0, 140)}`);
});
