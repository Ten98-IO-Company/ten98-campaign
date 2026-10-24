import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';
import * as designSystem from '@ten98/ui';
import { PLATFORM_RULES } from '../shared/social-posts.ts';
import { adSpendActionLabel, adSpendBlock, adSpendPlatformLabel, approvalBadge, formatMinorUnits, readableApprovalSummary } from '../src/approval-status.ts';

// Client side of ad spend approval (council decision ten98-code-system#35, Q1). The components run with recorded request
// boundaries and stubbed hooks; no provider or approval request leaves the test.
const read = async file => (await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
const ui = Object.entries(designSystem).filter(([name]) => /^[A-Z]|^useConfirmDialog$/.test(name));
const tick = () => new Promise(resolve => setImmediate(resolve));
// Every element in a tree, including elements passed through props such as `actions`; function components stay unrendered.
const nodes = node => Array.isArray(node) ? node.flatMap(nodes) : !React.isValidElement(node) ? [] : [node, ...Object.values(node.props).flatMap(value => Array.isArray(value) || React.isValidElement(value) ? nodes(value) : [])];
const text = node => Array.isArray(node) ? node.map(text).join('') : React.isValidElement(node) ? text(node.props.children) : node == null || node === false ? '' : String(node);
// Server rendering separates adjacent text with empty comments; the assertions read the visible text run.
const html = element => renderToStaticMarkup(element).replace(/<!-- -->/g, '');
const compile = (code, context) => new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context));

const approvals = await read('ContentApprovals.tsx');
const { code: approvalsCode } = await transformWithOxc(approvals.replace(/^import .*;\n/gm, '').replace('export default function', 'function'), 'ContentApprovals.tsx', { jsx: { runtime: 'classic' } });
// Hook state is supplied by call order: `states[n]` replaces the initial value of the nth useState call.
function approvalsModule(states = {}) {
  let index = 0;
  const useState = initial => { const current = index++; return [Object.hasOwn(states, current) ? states[current] : initial, () => {}]; };
  const helpers = { adSpendActionLabel, adSpendPlatformLabel, formatMinorUnits, reviewKeyAction: () => null, useFocusReturn: () => () => {}, PostVariantPreview: () => null, PLATFORM_RULES, document: { getElementById: () => null } };
  return new Function('React', 'useEffect', 'useRef', 'useState', ...Object.keys(helpers), ...ui.map(([name]) => name), approvalsCode + '; return { ContentApprovals, SpendReview };')(React, () => {}, value => ({ current: value }), useState, ...Object.values(helpers), ...ui.map(([, value]) => value));
}
const { code: policyCode } = await transformWithOxc((await read('ApprovalPolicy.tsx')).replace(/^import .*;\n/gm, '').replace('export default function', 'function'), 'ApprovalPolicy.tsx', { jsx: { runtime: 'classic' } });
function policyModule(states = {}) {
  let index = 0;
  const useState = initial => { const current = index++; return [Object.hasOwn(states, current) ? states[current] : initial, () => {}]; };
  return new Function('React', 'useEffect', 'useState', ...ui.map(([name]) => name), policyCode + '; return { ApprovalPolicy };')(React, () => {}, useState, ...ui.map(([, value]) => value));
}

test('in Settings the ad spend switch sits beside the post approval switch and posts only its own flag', async () => {
  for (const [role, shown] of [['owner', true], ['admin', true], ['editor', false], ['viewer', false]]) {
    const calls = [], request = async (...args) => { calls.push(args); return { requireApproval: true, requireAdApproval: true }; };
    const tree = policyModule({ 0: { requireApproval: true, requireAdApproval: false } }).ApprovalPolicy({ projectId: 'project /1', role, request, onChanged: async () => {} });
    const switches = nodes(tree).filter(node => typeof node.props?.onCheckedChange === 'function' && typeof node.props.label === 'string');
    const spend = switches.find(node => node.props.label === 'Require approval before activating ads or raising budgets');
    assert.equal(Boolean(spend), shown, role); if (!shown) continue;
    assert.deepEqual(switches.map(node => node.props.label), ['Require approval before publishing', 'Require approval before activating ads or raising budgets'], 'The two settings sit together.');
    assert.equal(spend.props.checked, false); assert.equal(spend.props.disabled, false);
    spend.props.onCheckedChange(true); await tick();
    assert.deepEqual(calls, [['/projects/project%20%2F1/approvals/policy', 'POST', { requireAdApproval: true }]], 'Only the changed flag is sent; the post setting keeps its stored value.');
    assert.match(html(tree), /Ad spend approval is <strong[^>]*>optional<\/strong>/);
  }
  const busy = policyModule({ 0: { requireApproval: false, requireAdApproval: true }, 1: 'policy' }).ApprovalPolicy({ projectId: 'p', role: 'owner', request: async () => assert.fail('A busy page sends nothing.') });
  const locked = nodes(busy).find(node => node.props.label === 'Require approval before activating ads or raising budgets');
  assert.equal(locked.props.checked, true); assert.equal(locked.props.disabled, true, 'The switch shares the page busy lock.');
});

test('the review queue shows the policy read-only and links owners and administrators to Settings', () => {
  for (const [role, linked] of [['owner', true], ['admin', true], ['editor', false], ['viewer', false]]) {
    const opened = [], tree = approvalsModule({ 0: { requireApproval: true, requireAdApproval: false, posts: [] } }).ContentApprovals({ projectId: 'p', role, request: async () => assert.fail('Rendering sends nothing.'), onOpenSettings: () => opened.push(role) });
    assert.equal(nodes(tree).filter(node => typeof node.props?.onCheckedChange === 'function').length, 0, 'No policy switch on the queue.');
    assert.match(html(tree.props.children[0]), /Publishing approval is <strong[^>]*>required<\/strong>/);
    const link = nodes(tree).find(node => node.type === designSystem.Button && text(node.props.children) === 'Change approval settings');
    assert.equal(Boolean(link), linked, role); if (link) { link.props.onClick(); assert.deepEqual(opened, [role]); }
  }
});

const review = (extra = {}) => ({ id: 'spend-review', status: 'pending', kind: 'ad_spend', consumed: false, requestedBy: { id: 'editor', name: 'Casey Editor' }, requestedAt: '2030-01-01T09:00:00.000Z', reviewedBy: null, reviewedAt: null, note: null, selfApproved: false, snapshot: { subjectId: 'spend-set', platform: 'facebook', action: 'ads/adset-budget', amount: 2500, currency: 'AED', currentAmount: 2000, activates: false }, ...extra });

test('an ad spend review shows the current and requested amounts and decides through the review endpoint', async () => {
  const path = '/projects/project-one/approvals', calls = [], changed = [];
  const request = async (...args) => { calls.push(args); return args[1] ? { review: { ...review(), status: 'approved' } } : { requireAdApproval: true, reviews: [] }; };
  // The review card itself is presentational; the page owns the comment and the decision request.
  const card = (row, canReview = true) => approvalsModule().SpendReview({ review: row, canReview, busy: false, note: 'Within plan', noteError: false, onNote() {}, onDecide() {}, onKeyDown() {} });
  const page = () => nodes(approvalsModule({ 0: { requireApproval: true, requireAdApproval: true, posts: [] }, 4: 'all', 5: { 'spend:spend-review': 'Within plan' }, 13: { reviews: [review()] } }).ContentApprovals({ projectId: 'project-one', role: 'owner', request, onChanged: async () => { changed.push(true); } })).find(node => node.type.name === 'SpendReview');
  const markup = html(card(review()));
  assert.match(markup, /Raise ad set budget · Facebook/); assert.match(markup, /Ad set spend-set/);
  assert.equal(formatMinorUnits(2000, 'AED'), new Intl.NumberFormat(undefined, { style: 'currency', currency: 'AED' }).format(20));
  assert.match(markup, new RegExp(`scope="row">Budget</th><td>[^]*?${formatMinorUnits(2000, 'AED').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^]*?</td><td>[^]*?${formatMinorUnits(2500, 'AED').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), 'Current spend sits beside the requested amount.');
  assert.match(markup, /does not start delivery on its own/); assert.doesNotMatch(markup, /scope="row">Delivery</);
  assert.match(markup, /Requested by Casey Editor/); assert.match(markup, /Awaiting review/);
  page().props.onDecide('approved'); await tick(); await tick();
  assert.deepEqual(calls, [[`${path}/ad-spend/review`, 'POST', { reviewId: 'spend-review', decision: 'approved', note: 'Within plan' }], [`${path}/ad-spend`]], 'The decision uses the ad spend review route, then the list refreshes.');
  assert.equal(changed.length, 1, 'The Approvals badge refreshes after a decision.');
  calls.length = 0; page().props.onDecide('rejected'); await tick();
  assert.deepEqual(calls[0], [`${path}/ad-spend/review`, 'POST', { reviewId: 'spend-review', decision: 'rejected', note: 'Within plan' }]);

  // An activation names the delivery change; an unreadable current budget is shown as unavailable.
  const activation = html(card(review({ snapshot: { subjectId: '4242', platform: 'microsoft', action: 'microsoft/campaign-status', amount: 3000, currency: 'USD', currentAmount: null, activates: true } })));
  assert.match(activation, /Activate Microsoft search campaign · Microsoft Advertising/); assert.match(activation, /Budget that starts spending<\/th><td>[^]*?Not available/); assert.match(activation, /scope="row">Delivery<\/th>[^]*?Starts when the change is sent/);
  // Editors see the card without decision controls; decided cards say whether the approval was used.
  assert.doesNotMatch(html(card(review(), false)), /Approve spend change|Request changes/);
  assert.match(html(card(review({ status: 'approved', reviewedBy: { name: 'Olive Owner' }, reviewedAt: '2030-01-01T10:00:00.000Z' }))), /Approved by Olive Owner[^]*?Approved and not yet used/);
  assert.match(html(card(review({ status: 'approved', consumed: true, reviewedAt: '2030-01-01T10:00:00.000Z', reviewedBy: { name: 'Olive Owner' } }))), /used by a provider change/);
  assert.match(html(card(review({ status: 'rejected', reviewedAt: '2030-01-01T10:00:00.000Z', note: 'Superseded by a newer ad spend request.' }))), /· Changes requested · [^]*?Superseded by a newer ad spend request/);
});

test('a held-back spend change explains the review the server opened and links to Approvals', async () => {
  const failure = code => Object.assign(new Error('Server message'), { status: code === 'AD_SPEND_APPROVAL_REQUIRED' ? 403 : 409, code });
  assert.deepEqual(adSpendBlock(failure('AD_SPEND_APPROVAL_REQUIRED'))?.review, true);
  assert.deepEqual(adSpendBlock(failure('AD_SPEND_APPROVAL_MISMATCH'))?.review, true);
  assert.deepEqual(adSpendBlock(failure('AD_SPEND_AMOUNT_UNAVAILABLE'))?.review, false);
  for (const code of ['AD_SPEND_WRITE_REQUIRED', 'INVALID_AD_SPEND_REQUEST', 'BUDGET_REVIEW_CHANGED', undefined]) assert.equal(adSpendBlock(failure(code)), null, String(code));
  assert.equal(adSpendBlock(null), null);

  const notice = await read('AdSpendNotice.tsx');
  const { code } = await transformWithOxc(notice.replace(/^import .*;\n/gm, '').replace('export default function', 'function'), 'AdSpendNotice.tsx', { jsx: { runtime: 'classic' } });
  const AdSpendNotice = new Function('React', 'Alert', 'Button', code + '; return AdSpendNotice;')(React, designSystem.Alert, designSystem.Button);
  let opened = 0;
  const required = AdSpendNotice({ block: adSpendBlock(failure('AD_SPEND_APPROVAL_REQUIRED')), onOpenApprovals: () => { opened++; } }), markup = html(required);
  assert.match(markup, /Sent for approval/); assert.match(markup, /nothing was sent to the provider/); assert.match(markup, /waiting in Approvals/);
  nodes(required).find(node => node.type === designSystem.Button && text(node) === 'Open approvals').props.onClick(); assert.equal(opened, 1);
  assert.match(html(AdSpendNotice({ block: adSpendBlock(failure('AD_SPEND_APPROVAL_MISMATCH')), onOpenApprovals() {} })), /differs from the approved one[^]*?amount, currency, platform, campaign or action[^]*?Open approvals/);
  const unavailable = html(AdSpendNotice({ block: adSpendBlock(failure('AD_SPEND_AMOUNT_UNAVAILABLE')), onOpenApprovals() {} }));
  assert.match(unavailable, /cannot be checked exactly/); assert.doesNotMatch(unavailable, /Open approvals/, 'An amount that cannot be matched has no review to open.');

  // Each control that activates ads or raises budgets routes the refusal to the notice instead of a plain error.
  const main = await read('main.tsx'), details = await read('AdDetails.tsx'), microsoft = await read('MicrosoftAds.tsx'), google = await read('NativeGoogleAds.tsx');
  const handlers = [
    ['main.tsx run', () => { const errors = [], blocks = [], summaries = []; return { errors, blocks, summaries, run: compile(main.slice(main.indexOf('async function run('), main.indexOf('  async function integrate(')), { activeProject: { current: 'project-a' }, pendingWork: { current: 0 }, setBusy() {}, setNotice() {}, setError: value => { if (value) errors.push(value); }, setSpendBlock: value => { if (value) blocks.push(value); }, adSpendBlock, loadApprovalSummary: id => { summaries.push(id); } }) }; }],
    ['AdDetails act', () => { const errors = [], blocks = []; return { errors, blocks, run: compile(details.slice(details.indexOf('async function act('), details.indexOf('  async function readAd(')), { isCurrent: () => true, setBusy() {}, setNotice() {}, onChanged() {}, setError: value => { if (value) errors.push(value); }, setSpendBlock: value => { if (value) blocks.push(value); }, adSpendBlock }) }; }],
    ['MicrosoftAds action', () => { const errors = [], blocks = []; return { errors, blocks, run: compile(microsoft.slice(microsoft.indexOf('async function action('), microsoft.indexOf('  async function write(')), { pending: { current: false }, active: { current: true }, readVersion: { current: 0 }, setBusy() {}, setNotice() {}, setError: value => { if (value) errors.push(value); }, setSpendBlock: value => { if (value) blocks.push(value); }, adSpendBlock }) }; }],
    ['NativeGoogleAds act', () => { const errors = [], blocks = [], start = google.indexOf('async function act(', google.indexOf('function ShoppingAccount(')); return { errors, blocks, run: compile(google.slice(start, google.indexOf('  async function write(', start)), { pending: { current: false }, active: { current: true }, setBusy() {}, setNotice() {}, setError: value => { if (value) errors.push(value); }, setSpendBlock: value => { if (value) blocks.push(value); }, adSpendBlock }) }; }],
  ];
  for (const [name, make] of handlers) {
    const held = make(); await held.run(async () => { throw failure('AD_SPEND_APPROVAL_REQUIRED'); });
    assert.deepEqual(held.blocks.map(block => block.code), ['AD_SPEND_APPROVAL_REQUIRED'], name); assert.deepEqual(held.errors, [], `${name}: the notice replaces the plain error`);
    if (held.summaries) assert.deepEqual(held.summaries, ['project-a'], 'The Approvals badge picks up the review the server opened.');
    const plain = make(); await plain.run(async () => { throw failure('AD_SPEND_WRITE_REQUIRED'); });
    assert.deepEqual(plain.blocks, [], name); assert.deepEqual(plain.errors, ['Server message'], `${name}: other refusals keep the plain error`);
  }
  assert.match(main, /\{spendBlock && <AdSpendNotice block=\{spendBlock\} onOpenApprovals=\{\(\) => \{ setSpendBlock\(null\); setPage\('Approvals'\); \}\} onDismiss=\{\(\) => setSpendBlock\(null\)\}\/>\}/);
  for (const [name, source] of [['AdDetails', details], ['MicrosoftAds', microsoft], ['NativeGoogleAds', google]]) assert.match(source, /\{spendBlock && <AdSpendNotice block=\{spendBlock\} onOpenApprovals=\{onOpenApprovals\}\/>\}/, name);
  for (const mount of [/<AdDetails request=\{integrate\}[^\n]*?onOpenApprovals=\{\(\) => setPage\('Approvals'\)\}/, /<NativeGoogleAds onOpenIntegrations=\{\(\) => setPage\('Integrations'\)\} onOpenApprovals=\{\(\) => setPage\('Approvals'\)\}/, /<MicrosoftAds onOpenIntegrations=\{\(\) => setPage\('Integrations'\)\} onOpenApprovals=\{\(\) => setPage\('Approvals'\)\}/]) assert.match(main, mount);
});

test('the Approvals badge counts pending ad spend reviews beside pending posts', () => {
  const summary = (pending, pendingAdSpend) => ({ requireApproval: true, pending, statuses: {}, ...(pendingAdSpend === undefined ? {} : { pendingAdSpend }) });
  assert.equal(approvalBadge(summary(0, 0)), null); assert.equal(approvalBadge(null), null);
  assert.deepEqual(approvalBadge(summary(2, 0)), { count: 2, label: '2 posts awaiting review' });
  assert.deepEqual(approvalBadge(summary(0, 1)), { count: 1, label: '1 ad spend change awaiting review' });
  assert.deepEqual(approvalBadge(summary(1, 3)), { count: 4, label: '1 post and 3 ad spend changes awaiting review' });
  assert.deepEqual(approvalBadge(summary(2)), { count: 2, label: '2 posts awaiting review' }, 'A summary without the ad spend count still badges its posts.');
  assert.equal(readableApprovalSummary(summary(1, 2)), true);
  for (const value of [-1, 1.5, '2', null]) assert.equal(readableApprovalSummary(summary(1, value)), false, String(value));
});

test('an OOH booking held back by ad spend approval explains itself, and a missing account currency points to Integrations', async () => {
  const failure = code => Object.assign(new Error('Server message'), { status: code === 'AD_SPEND_APPROVAL_REQUIRED' ? 403 : 409, code });
  const ooh = await read('OohProviders.tsx'), main = await read('main.tsx');
  const make = () => { const errors = [], blocks = [], reviews = []; return { errors, blocks, reviews, run: compile(ooh.slice(ooh.indexOf('async function action('), ooh.indexOf('  async function saveMapping(')), { busy: false, active: { current: true }, setBusy() {}, setNotice() {}, setError: value => { if (value) errors.push(value); }, setSpendBlock: value => { if (value) blocks.push(value); }, adSpendBlock, onSpendReview: () => { reviews.push(1); } }) }; };
  const held = make(); await held.run(async () => { throw failure('AD_SPEND_APPROVAL_REQUIRED'); });
  assert.deepEqual(held.blocks.map(block => block.code), ['AD_SPEND_APPROVAL_REQUIRED']); assert.deepEqual(held.errors, []); assert.equal(held.reviews.length, 1, 'The Approvals badge picks up the opened review.');
  const currency = make(); await currency.run(async () => { throw failure('AD_SPEND_AMOUNT_UNAVAILABLE'); });
  assert.deepEqual(currency.blocks.map(block => block.review), [false]); assert.equal(currency.reviews.length, 0);
  const plain = make(); await plain.run(async () => { throw failure('INVALID_OOH_PRICE'); }); assert.deepEqual(plain.errors, ['Server message']); assert.deepEqual(plain.blocks, []);
  assert.match(ooh, /spendBlock\.review \? <AdSpendNotice block=\{spendBlock\} onOpenApprovals=\{onOpenApprovals\}/);
  assert.match(ooh, /title="Set the Broadsign account currency"[^\n]*onClick=\{onOpenIntegrations\}>Open Connections</);
  assert.match(main, /<OohProviders onOpenIntegrations=\{\(\) => setPage\('Integrations'\)\} onOpenApprovals=\{\(\) => setPage\('Approvals'\)\} onSpendReview=/);
  assert.equal(adSpendActionLabel('ooh/booking'), 'Submit OOH booking');
});

test('changing the ad spend setting is confirmed first, and an expired approval reads as needing re-approval', async () => {
  const source = await read('ContentApprovals.tsx'), policySource = await read('ApprovalPolicy.tsx');
  assert.match(policySource, /<AdSpendPolicySwitch label="Require approval before activating ads or raising budgets"/);
  const wrapper = policySource.slice(policySource.indexOf('function AdSpendPolicySwitch('), policySource.indexOf('export default function ApprovalPolicy('));
  assert.ok(wrapper.includes('const [confirm, dialog] = useConfirmDialog();')); assert.match(wrapper, /voids every unused ad spend approval and pending ad spend request/);
  assert.match(wrapper, /if \(await confirm\(\{[^]*?\}\)\) onCheckedChange\(next\);/, 'The page handler runs only after confirmation.');
  assert.ok(source.includes('}, [path, required]);'), 'The ad spend list reloads when the setting changes, so voided reviews show as rejected.');
  const expired = adSpendBlock(Object.assign(new Error('Server message'), { status: 403, code: 'AD_SPEND_APPROVAL_EXPIRED' }));
  assert.equal(expired.review, true); assert.equal(expired.title, 'Needs re-approval'); assert.match(expired.text, /more than 7 days old[^]*new review/);
});

test('an unused approval past the server expiry reads as expired and needing re-approval', () => {
  const card = extra => html(approvalsModule().SpendReview({ review: review({ status: 'approved', reviewedAt: '2030-01-01T10:00:00.000Z', reviewedBy: { id: 'owner', name: 'Olive Owner' }, ...extra }), canReview: true, busy: false, note: '', noteError: false, onNote() {}, onDecide() {}, onKeyDown() {} }));
  const expired = card({ consumed: false, expiresAt: '2000-01-01T00:00:00.000Z' });
  assert.match(expired, />Expired</); assert.match(expired, /expired before it was used[^<]*re-approval/); assert.doesNotMatch(expired, /not yet used/);
  const current = card({ consumed: false, expiresAt: '2999-01-01T00:00:00.000Z' });
  assert.match(current, />Approved</); assert.match(current, /Approved and not yet used/);
  assert.match(card({ consumed: false }), /Approved and not yet used/, 'Without a server expiry the card keeps the approved wording.');
  assert.match(card({ consumed: true, expiresAt: '2000-01-01T00:00:00.000Z' }), /used by a provider change/, 'A used approval never reads as expired.');
});
