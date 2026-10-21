import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const composer = await readFile(new URL('../src/AdComposer.tsx', import.meta.url), 'utf8'), connection = await readFile(new URL('../src/OpenAIConnection.tsx', import.meta.url), 'utf8'), details = await readFile(new URL('../src/AdDetails.tsx', import.meta.url), 'utf8');
const compile = (source, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source)});`)(...Object.values(context));
class FormValues { constructor(values) { return new Map(Object.entries(values)); } }

test('actual ChatGPT composer validates lifetime fixed bidding, tracking macros and stays open without a paid creation', async () => {
  const calls = [], notices = [], errors = [], created = [], values = { name: 'Planner', countries: 'US, CA', budgetAmount: '100', endDate: '2090-02-28T19:00', headline: 'Try the planner', body: 'A plan for every team.', imageUrl: 'https://cdn.example.com/image.png', linkUrl: 'https://example.com', bidAmount: '2.5', urlTags: 'utm_source=chatgpt\nclick_id={oppref}\nsource_detail=a=b' };
  const frame = {}, context = { frame, currentFrame: { current: frame }, readOnly: false, loading: false, loadingAds: false, selectedInterests: [], busy: false, isCurrent: () => true, FormData: FormValues, setError: value => errors.push(value), setValidation: value => notices.push(value), connection: { platform: 'openaiads' }, adAccount: { id: 'native' }, currency: 'USD', accountId: 'openai', adAccountId: 'native', platform: 'openai', boosting: false, assets: false, format: 'image', goal: 'traffic', budgetType: 'lifetime', bidding: 'automatic', video: false, carousel: false, cards: 2, lines: value => value.split(/\r?\n/).filter(Boolean), setBusy() {}, requester: { current: async (path, payload) => { calls.push({ path, payload }); return { message: 'Validated with live country checks. No ad created.' }; } }, onCreated: () => created.push(true) };
  context.canInteract = compile(composer.match(/\bcanInteract = (.+);/)[1], context);
  const submit = compile(composer.slice(composer.indexOf('async function submit('), composer.indexOf('  return <form')), context);
  await submit({ preventDefault() {}, currentTarget: values, nativeEvent: { submitter: { getAttribute: () => 'validate' } } });
  assert.deepEqual(errors, ['']); assert.equal(calls[0].path, 'ads/validate'); assert.equal(calls[0].payload.budgetType, 'lifetime'); assert.equal(calls[0].payload.bidAmount, 2.5); assert.equal(calls[0].payload.bidStrategy, 'LOWEST_COST_WITH_BID_CAP'); assert.equal(calls[0].payload.tracking.urlTags[1].value, '{oppref}'); assert.equal(calls[0].payload.tracking.urlTags[2].value, 'a=b'); assert.equal(created.length, 0); assert.match(notices.at(-1), /No ad created/);
});

test('ChatGPT credential form clears the entered key on confirmed connection and ignores a closed form completion', async () => {
  const source = connection.slice(connection.indexOf('async function connect('), connection.indexOf('  return <Stack'));
  for (const closes of [false, true]) {
    const notices = [], errors = [], changed = [], resets = [], mounted = { current: true }; let finish;
    const form = { apiKey: 'sk-ads-qa', reset: () => resets.push(true) };
    const context = { busy: false, mounted, FormData: FormValues, setBusy() {}, setError: value => errors.push(value), setNotice: value => notices.push(value), request: async (path, payload) => { assert.equal(path, 'connect/openai-ads'); assert.deepEqual(payload, { apiKey: 'sk-ads-qa' }); return new Promise(resolve => { finish = resolve; }); }, onConnected: () => changed.push(true) };
    const pending = compile(source, context)({ preventDefault() {}, currentTarget: form });
    if (closes) mounted.current = false;
    finish({ adAccountName: 'QA ChatGPT' }); await pending;
    assert.equal(changed.length, closes ? 0 : 1); assert.equal(resets.length, closes ? 0 : 1); assert.deepEqual(errors, ['']);
    assert.equal(notices.some(item => item.includes('sk-ads-qa')), false);
  }
});

test('ChatGPT campaign budget form submits the chosen lifetime type instead of silently converting it to daily', async () => {
  const source = details.slice(details.indexOf('async function editCampaign('), details.indexOf('  function confirmForm(')), calls = [];
  const context = { FormData: FormValues, campaignId: 'campaign', platform: 'openai', data: { campaign: {} }, act: async action => action(), scopedRequest: async (path, payload) => calls.push({ path, payload }), confirmForm() {}, setRetry() {} };
  await compile(source, context)({ preventDefault() {}, currentTarget: { amount: '150', budgetType: 'lifetime' } });
  assert.deepEqual(calls[0].payload.budget, { amount: 150, type: 'lifetime' });
});

test('AI creative suggestions prefill only a matching platform and format without selecting a paid account or budget', () => {
  const start = composer.indexOf('const draftValue = ') + 'const draftValue = '.length, source = composer.slice(start, composer.indexOf('  const assets =', start)).trim().replace(/;$/, '');
  const initialDraft = { platform: 'google', format: 'search', headline: 'A short search headline', additionalHeadlines: ['A second headline', 'A third headline'], budgetAmount: 999, accountId: 'untrusted-account', keywords: { unsafe: true } };
  const matching = compile(source, { initialDraft, platform: 'google', format: 'search' });
  assert.equal(matching('headline'), initialDraft.headline); assert.equal(matching('additionalHeadlines'), 'A second headline\nA third headline'); assert.equal(matching('keywords'), '');
  assert.equal(compile(source, { initialDraft, platform: 'openai', format: 'image' })('headline'), '');
  assert.equal(compile(source, { initialDraft, platform: 'google', format: 'display' })('headline'), '');
  assert.doesNotMatch(composer, /name="(?:budgetAmount|accountId|adAccountId)" defaultValue=\{draftValue/);
  for (const format of ['pmax', 'demand_video']) {
    const draft = { ...initialDraft, format, body: 'A description for the campaign.', additionalDescriptions: ['A second description.'], imageUrl: 'https://cdn.example.com/landscape.png' }, getValue = compile(source, { initialDraft: draft, platform: 'google', format });
    assert.equal(getValue('headlines'), [draft.headline, ...draft.additionalHeadlines].join('\n')); assert.equal(getValue('descriptions'), [draft.body, ...draft.additionalDescriptions].join('\n'));
    assert.equal(getValue('longHeadline'), draft.headline); assert.equal(getValue('landscape'), draft.imageUrl); assert.equal(getValue('square'), ''); assert.equal(getValue('youtubeVideoIds'), '');
    for (const field of ['headlines', 'descriptions']) assert.ok(composer.includes(`name="${field}" defaultValue={draftValue('${field}')}`), `${format} must attach suggested ${field} to the real input.`);
  }
});
