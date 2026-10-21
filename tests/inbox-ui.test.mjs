import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import React from 'react';
import * as ui from '@ten98/ui';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformWithOxc } from 'vite';

const source = await readFile(new URL('../src/UnifiedInbox.tsx', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function compile(code, context = {}) { return new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context)); }
const event = { preventDefault() {} }, path = '/projects/project-a/integrations/inbox';
const { AppliedFilters } = ui, uiNames = Object.keys(ui), uiValues = Object.values(ui);
const merge = (before, after) => [...new Map([...before, ...after].map(row => [row.id, row])).values()];

const linkedInReactions = { LIKE: 'Like', PRAISE: 'Celebrate', EMPATHY: 'Love', INTEREST: 'Insightful', APPRECIATION: 'Support', ENTERTAINMENT: 'Funny' };

function whatsappButtonContext() {
  const calls = [], errors = [], notices = [], context = { projectId: 'project-a', path, keys: { current: new Map() }, crypto, version: { current: 1 }, buttonScope: { current: { key: '', generation: 0 } }, account: { platform: 'whatsapp', name: 'QA WhatsApp' }, capabilities: { replyButtons: true }, accountId: 'wa', tab: 'messages', selected: { id: 'thread-1', participantName: 'QA customer' }, readOnly: false, canReply: true, message: 'Choose one', messageLimit: 4096, replyButtons: ['Yes', 'No'], buttonReview: '', templateMode: false, selectedTemplate: null, templateComponents: [], templateRestriction: () => '', attachmentUrl: '', attachmentType: 'image', attachmentName: '', attachmentPreview: '', messageTag: '', replyTarget: null, confirmReplace: false, action: async (_, run) => run(context.version.current), setError: value => errors.push(value), setNotice: value => notices.push(value), resetTemplate() {}, refreshAfterWrite: async () => {} };
  for (const field of ['message', 'messageTag', 'replyButtons', 'buttonReview', 'attachmentUrl', 'attachmentType', 'attachmentName', 'attachmentPreview', 'replyTarget', 'confirmReplace']) context['set' + field[0].toUpperCase() + field.slice(1)] = value => { context[field] = typeof value === 'function' ? value(context[field]) : value; };
  context.requester = { current: async (...args) => { calls.push(args); return { operation: { status: 'complete' }, sent: true, accountId: args[2].accountId, platform: 'whatsapp', messageId: 'wamid.accepted', conversationId: 'thread-1' }; } };
  context.commit = () => {
    const key = compile('function scope() {' + source.match(/^  const buttonScopeKey = .*;$/m)[0] + ' return buttonScopeKey; }', context)();
    context.buttonGeneration = context.buttonScope.current.generation + (context.buttonScope.current.key === key ? 0 : 1); context.buttonScopeKey = key; Object.assign(context.buttonScope.current, { key, generation: context.buttonGeneration });
    context.buttonReviewKey = compile('function reviewKey() {' + source.match(/^  const buttonReviewKey = .*;$/m)[0] + ' return buttonReviewKey; }', context)();
    context.retainedButtonReply = compile('function retained() {' + source.match(/^  const retainedButtonReply = .*;$/m)[0] + ' return retainedButtonReply; }', context)();
  };
  context.handler = () => { context.write = compile(section('async function write(', '  async function loadAccounts('), context); return compile(section('async function reply(', '  async function conversationAction('), context); };
  context.review = () => { context.buttonReview = context.buttonReviewKey; }; context.commit(); context.review();
  return { context, calls, errors, notices };
}

test('native WhatsApp reply controls preview and send exactly reviewed generated-ID buttons', async () => {
  const { context, calls } = whatsappButtonContext(); context.replyButtons = []; context.commit();
  const start = source.indexOf('{retainedButtonReply && <Alert'), end = source.indexOf("{account?.platform === 'whatsapp' && <Field label=\"Reply type\"", start); assert.ok(end > start);
  const { code } = await transformWithOxc(`function Buttons(props) { const { retainedButtonReply, reply, account, capabilities, replyButtons, templateMode, attachmentUrl, setReplyButtons, buttonReview, buttonScopeKey, buttonReviewKey, setButtonReview, message, selected } = props; return <>${source.slice(start, end)}</>; }`, 'WhatsAppButtons.tsx', { jsx: { runtime: 'classic' } });
  const Buttons = new Function('React', ...uiNames, 'accountLabel', code + '; return Buttons;')(React, ...uiValues, account => account.name);
  const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];
  const render = () => { context.commit(); return Buttons({ ...context, reply: context.handler() }); };
  const list = () => elements(render()).find(node => node.type === ui.FieldList);
  for (let index = 0; index < 3; index++) { const field = list(); assert.equal(field.props.addLabel, 'Add reply button'); assert.ok(field.props.items.length < field.props.max); field.props.onAdd(); }
  assert.equal(list().props.items.length, list().props.max, 'A fourth reply button cannot be added.'); assert.equal(context.replyButtons.length, 3);
  assert.equal(list().props.removeLabel(2), 'Remove reply button 3'); list().props.onRemove(2); assert.equal(context.buttonReview, '');
  for (const [index, title] of ['<Yes>', 'No'].entries()) { const field = list(); elements(field.props.renderItem(field.props.items[index], index)).find(node => node.type === ui.Input && node.props.maxLength === 20).props.onChange({ target: { value: title } }); }
  const html = renderToStaticMarkup(render()); assert.match(html, /Reply buttons \(optional\)/); assert.match(html, /WhatsApp reply button preview/); assert.match(html, /QA customer/); assert.match(html, /From QA WhatsApp/); assert.match(html, /&lt;Yes&gt;/); assert.doesNotMatch(html, /payload|reply_1|type="url"/);
  elements(render()).find(node => node.type === ui.Checkbox).props.onChange({ target: { checked: true } });
  await context.handler()(event); assert.deepEqual(calls[0][2], { accountId: 'wa', message: 'Choose one', buttons: [{ type: 'postback', title: '<Yes>', payload: 'reply_1' }, { type: 'postback', title: 'No', payload: 'reply_2' }] }); assert.deepEqual(context.replyButtons, []); assert.equal(context.message, '');
  assert.match(source, /!readOnly && canReply && selected\.folder !== 'requests' && <Form /);
});

test('WhatsApp replies point to approved templates once the loaded history shows the 24-hour window has closed', () => {
  const expression = source.match(/lastInbound = (\(detail\?\.messages \|\| \[\]\)\.reduce\(.*?, 0\));$/m)?.[1]; assert.ok(expression);
  const latest = messages => compile(expression, { detail: { messages } });
  assert.equal(latest([{ direction: 'incoming', createdAt: '2026-10-01T09:00:00Z' }, { direction: 'incoming', createdAt: '2026-10-02T09:00:00Z' }, { direction: 'outgoing', createdAt: '2026-10-03T09:00:00Z' }]), Date.parse('2026-10-02T09:00:00Z'), 'Only the latest received message opens the window.');
  assert.equal(latest([{ direction: 'outgoing', createdAt: '2026-10-03T09:00:00Z' }, { direction: 'incoming', createdAt: 'not a date' }]), 0, 'Without a dated received message no window is inferred.');
  assert.match(source, /account\?\.platform === 'whatsapp' && !templateMode && lastInbound > 0 && Date\.now\(\) - lastInbound > 86400000 && <Alert tone="info">It has been more than 24 hours/);
});

test('WhatsApp button drafts reject invalid, mixed, unreviewed and stale callbacks without sending', async () => {
  for (const change of [{ replyButtons: ['Same', 'Same'] }, { replyButtons: [''] }, { replyButtons: [' Yes'] }, { replyButtons: ['Yes\nNo'] }, { replyButtons: ['x'.repeat(21)] }, { replyButtons: ['1', '2', '3', '4'] }, { message: '🙂'.repeat(257) }, { attachmentUrl: 'https://example.test/file' }, { templateMode: true }, { messageTag: 'HUMAN_AGENT' }, { account: { platform: 'instagram' } }, { capabilities: {} }, { readOnly: true }]) {
    const { context, calls } = whatsappButtonContext(); Object.assign(context, change); context.commit(); context.review(); await context.handler()(event); assert.equal(calls.length, 0, JSON.stringify(change));
  }
  const { context, calls } = whatsappButtonContext(); context.buttonReview = ''; await context.handler()(event); assert.equal(calls.length, 0);
  context.review(); const old = context.handler(); context.selected = { id: 'other' }; context.commit(); context.selected = { id: 'thread-1', participantName: 'QA customer' }; context.commit(); context.review(); await old(event); assert.equal(calls.length, 0, 'A-B-A selection cannot revive an old send callback.');
  const unmounted = context.handler(); context.buttonScope.current.generation++; await unmounted(event); assert.equal(calls.length, 0);
  assert.match(source, /return \(\) => \{ buttonScope\.current\.generation\+\+; \}/);
});

test('fresh WhatsApp send handlers cannot reuse approval after message or label edits return to the original draft', async () => {
  for (const field of ['message', 'replyButtons']) {
    const { context, calls, errors } = whatsappButtonContext(), original = structuredClone(context[field]);
    context[field] = field === 'message' ? 'Temporary changed message' : ['Temporary label']; context.commit();
    context[field] = original; context.commit(); await context.handler()(event);
    assert.equal(calls.length, 0, field + ' A-B-A edits require a new explicit review even with a fresh callback.'); assert.match(errors.at(-1), /Review this account/);
    context.review(); await context.handler()(event); assert.equal(calls.length, 1, 'Only renewed approval permits one send.');
  }
});

test('unknown button replies keep one exact body and key, and outcome checks cannot replace a newer draft', async () => {
  const { context, calls } = whatsappButtonContext(); context.requester.current = async (...args) => { calls.push(args); throw new TypeError('Browser acknowledgement lost'); };
  await assert.rejects(context.handler()(event), /lost/); const original = calls[0][2], key = calls[0][3]; assert.equal(context.keys.current.size, 1); assert.deepEqual(context.replyButtons, ['Yes', 'No']);
  context.message = 'Keep newer draft'; context.replyButtons = ['Changed']; context.commit(); context.review(); await context.handler()(event); assert.equal(calls.length, 1, 'A changed body cannot create a new key while the first outcome is unknown.');
  context.requester.current = async (...args) => { calls.push(args); throw Object.assign(new Error('No matching receipt'), { status: 409, code: 'OPERATION_OUTCOME_UNAVAILABLE' }); };
  await assert.rejects(context.handler()(event, true), /No matching/); assert.deepEqual(calls[1].slice(2), [original, key]); assert.match(calls[1][0], /reply\?check=1$/); assert.equal(context.keys.current.size, 1);
  context.commit(); context.requester.current = async (...args) => { calls.push(args); return { operation: { status: 'complete' }, sent: true, accountId: 'wa', platform: 'whatsapp', messageId: 'wamid.accepted', conversationId: 'thread-1' }; };
  await context.handler()(event, true); assert.deepEqual(calls[2].slice(2), [original, key]); assert.equal(context.keys.current.size, 0); assert.equal(context.message, 'Keep newer draft'); assert.deepEqual(context.replyButtons, ['Changed']);
});

test('a late accepted button reply cannot erase changed labels or a newly read-only draft', async () => {
  for (const change of [{ replyButtons: ['New label'] }, { readOnly: true }]) {
    const { context, calls } = whatsappButtonContext(); let finish; context.requester.current = async (...args) => { calls.push(args); return new Promise(resolve => { finish = resolve; }); };
    const pending = context.handler()(event); Object.assign(context, change); context.commit(); finish({ operation: { status: 'complete' }, sent: true, accountId: 'wa', platform: 'whatsapp', messageId: 'wamid.accepted', conversationId: 'thread-1' }); await pending;
    assert.equal(context.message, 'Choose one'); assert.deepEqual(context.replyButtons, change.replyButtons || ['Yes', 'No']); assert.equal(calls.length, 1);
  }
});

test('Reddit edit receipts retain the same action key until exact account, target and new text are verified', async () => {
  const keys = { current: new Map() }, calls = [], body = { accountId: 'rd', postId: 'post', commentId: 'comment', content: 'Corrected text', expectedCommentVersion: 'review', confirmEdit: true };
  const good = { operation: { status: 'complete' }, edited: true, accountId: 'rd', postId: 'post', commentId: 'comment', platform: 'reddit', content: body.content, comment: { id: 'comment', message: body.content, platform: 'reddit', from: { isOwner: true }, editVersion: 'a'.repeat(64) } }; let result = good;
  const write = compile(section('async function write(', '  async function loadAccounts('), { readOnly: false, path, keys, crypto, account: { platform: 'reddit' }, requester: { current: async (...args) => { calls.push(args); return result; } } });
  for (const patch of [{ operation: { status: 'uncertain' } }, { edited: false }, { accountId: 'other' }, { postId: 'other' }, { commentId: 'other' }, { platform: 'facebook' }, { content: 'Wrong text' }, { comment: { ...good.comment, id: 'other' } }, { comment: { ...good.comment, message: 'Old text' } }, { comment: { ...good.comment, editVersion: '' } }, { comment: { ...good.comment, from: { isOwner: false } } }]) {
    result = { ...good, ...patch }; await assert.rejects(write('comments/edit', body), /draft and action key have been retained/); assert.equal(keys.current.size, 1);
  }
  result = good; await write('comments/edit', body); assert.equal(keys.current.size, 0); assert.equal(new Set(calls.map(call => call[3])).size, 1);
});

test('Reddit edit handler retains failed and newer drafts and rejects stale committed identities', async () => {
  const reviewed = { id: 'comment', editVersion: 'review', message: 'Original', content: 'Corrected' }; reviewed.confirmed = JSON.stringify(['rd', 'post', reviewed.id, reviewed.editVersion, reviewed.message, reviewed.content]);
  const body = { accountId: 'rd', postId: 'post', commentId: 'comment', content: reviewed.content, expectedCommentVersion: 'review', confirmEdit: true }, writes = [], cleared = [], version = { current: 1 };
  const scope = { current: { generation: 1, readOnly: false, edit: reviewed, rows: [{ id: 'comment', from: { isOwner: true }, editVersion: 'review' }] } };
  const context = { path, keys: { current: new Map() }, commentEdit: reviewed, commentScope: scope, commentGeneration: 1, readOnly: false, selected: { id: 'post' }, account: { platform: 'reddit' }, accountId: 'rd', version, action: async (_, run) => run(1), write: async (...args) => writes.push(args), setCommentEdit: value => cleared.push(value), setNotice() {}, refreshAfterWrite: async () => {} };
  const send = changes => compile(section('async function editComment(', '  async function commentAction('), { ...context, ...changes })(body);
  for (const patch of [{ readOnly: true }, { accountId: 'other' }, { selected: { id: 'other' } }, { account: { platform: 'facebook' } }, { commentGeneration: 0 }, { commentEdit: { ...reviewed, confirmed: '' } }]) await send(patch);
  assert.equal(writes.length, 0);
  const failure = Object.assign(new Error('Known rejection'), { status: 400, operation: { status: 'failed' } }); await assert.rejects(send({ write: async () => { throw failure; } })); assert.equal(cleared.length, 1); const failedDraft = cleared.pop()(reviewed); assert.equal(failedDraft.content, reviewed.content); assert.equal(failedDraft.needsRefresh, true); assert.equal(failedDraft.confirmed, ''); assert.equal(failedDraft.blocked, false);
  const unknown = new Error('Receipt unreadable'); let draft = reviewed; await assert.rejects(send({ write: async () => { throw unknown; }, setCommentEdit: update => { draft = update(draft); } })); assert.equal(draft.content, 'Corrected'); assert.equal(draft.blocked, true);
  await send({ write: async () => { scope.current.edit = { ...reviewed, content: 'Newer unsent edit' }; } }); assert.deepEqual(cleared, []);
  scope.current.edit = reviewed; await send({ write: async () => { scope.current.generation++; } }); assert.deepEqual(cleared, []);
  scope.current.generation = 1; await send(); assert.deepEqual(writes[0], ['comments/edit', body]); assert.deepEqual(cleared, [null]);
});

test('Reddit inline edit exposes before and after review only for owned comments', async () => {
  const helper = section('  function commentMessage(', '  const noun = '), { code } = await transformWithOxc('function Comments() {' + helper + ' return <ConversationThread label="Post comments" messages={threadRows.map(row => commentMessage(row, selected))}/>; }', 'Comments.tsx', { jsx: { runtime: 'classic' } });
  const row = { id: 'comment', message: 'Original', from: { isOwner: true }, editVersion: 'review', depth: 0 }, commentEdit = { ...row, accountId: 'rd', postId: 'post', content: 'Corrected', confirmed: '' };
  const render = changes => {
    const context = { React, ...ui, tab: 'comments', selected: { id: 'post' }, focusedComment: '', busy: '', readOnly: false, accountId: 'rd', account: { platform: 'reddit', name: 'Reddit account' }, capabilities: { commentEdit: true }, canReply: false, privateReplyTarget: null, projectId: 'project-a', threadRows: [row], detail: {}, commentEdit, when: () => '', link: () => '', ...changes };
    return renderToStaticMarkup(new Function(...Object.keys(context), code + '; return Comments;')(...Object.values(context))());
  };
  const html = render(); assert.match(html, /Edit comment/); assert.match(html, /<figcaption[^>]*>Before</); assert.match(html, /<label[^>]*>After</); assert.match(html, /Original/); assert.match(html, /Corrected/); assert.match(html, /I reviewed this account and the before and after text/); assert.match(html, /disabled="">Save comment edit/); assert.match(html, /after this review can be overwritten/);
  assert.match(render({ commentEdit: { ...commentEdit, blocked: true, pendingBody: {} } }), /<button type="button"[^>]*>Check this edit/);
  for (const changes of [{ readOnly: true, commentEdit: null }, { threadRows: [{ ...row, from: { isOwner: false } }], commentEdit: null }, { account: { platform: 'facebook' }, commentEdit: null }]) assert.doesNotMatch(render(changes), />Edit comment</);
});

test('lost Reddit edit acknowledgments can check the exact retained request without resending newer local text', async () => {
  const original = { id: 'comment', accountId: 'rd', postId: 'post', editVersion: 'review', message: 'Original', content: 'Corrected' }; original.confirmed = JSON.stringify(['rd', 'post', original.id, original.editVersion, original.message, original.content]);
  const body = { accountId: 'rd', postId: 'post', commentId: 'comment', content: original.content, expectedCommentVersion: 'review', confirmEdit: true }, keys = { current: new Map() }, calls = [], version = { current: 1 }; let draft = original, result, lost = true;
  const scope = { current: { generation: 1, readOnly: false, edit: original, rows: [{ id: 'comment', from: { isOwner: true }, editVersion: 'review' }] } };
  const context = { readOnly: false, path, keys, crypto, account: { platform: 'reddit' }, accountId: 'rd', selected: { id: 'post' }, commentScope: scope, commentGeneration: 1, version, action: async (_, run) => run(1), setCommentEdit: update => { draft = typeof update === 'function' ? update(draft) : update; scope.current.edit = draft; }, setNotice() {}, refreshAfterWrite: async () => {}, requester: { current: async (...args) => { calls.push(args); if (lost) throw new TypeError('Browser lost completed response'); if (result instanceof Error) throw result; return result; } } };
  context.write = compile(section('async function write(', '  async function loadAccounts('), context);
  const run = (body, checking = false, changes = {}) => compile(section('async function editComment(', '  async function commentAction('), { ...context, commentEdit: draft, ...changes })(body, checking);
  await assert.rejects(run(body), /lost completed/); assert.equal(draft.blocked, true); assert.deepEqual(draft.pendingBody, body); assert.equal(keys.current.size, 1);
  const pendingBody = draft.pendingBody; draft = { ...draft, content: 'A newer local correction', confirmed: '' }; scope.current.edit = draft;
  lost = false; result = Object.assign(new Error('Still uncertain'), { status: 409, code: 'OPERATION_UNCERTAIN' }); await assert.rejects(run(pendingBody, true), /Still uncertain/);
  assert.equal(calls.length, 2); assert.deepEqual(calls[1][2], body); assert.equal(calls[1][3], calls[0][3]); assert.equal(draft.content, 'A newer local correction'); assert.equal(keys.current.size, 1);
  const count = calls.length; for (const changes of [{ readOnly: true }, { accountId: 'other' }, { selected: { id: 'other' } }, { commentGeneration: 0 }]) await run(pendingBody, true, changes); assert.equal(calls.length, count);
  result = { operation: { status: 'complete' }, edited: true, accountId: 'rd', postId: 'post', commentId: 'comment', platform: 'reddit', content: body.content, comment: { id: 'comment', platform: 'reddit', message: body.content, from: { isOwner: true }, editVersion: 'b'.repeat(64) } };
  await run(pendingBody, true); assert.equal(calls.length, count + 1); assert.equal(calls.at(-1)[3], calls[0][3]); assert.equal(keys.current.size, 0); assert.equal(draft.content, 'A newer local correction'); assert.equal(draft.message, body.content); assert.equal(draft.editVersion, result.comment.editVersion); assert.equal(draft.blocked, false); assert.equal(draft.pendingBody, undefined); assert.equal(draft.confirmed, '');
  await run(pendingBody, true); assert.equal(calls.length, count + 1, 'A closed check cannot create a new action key.');
  draft = { ...original }; scope.current.edit = draft; lost = true; await assert.rejects(run(body));
  lost = false; result = Object.assign(new Error('Provider rejected the original edit'), { status: 400, operation: { status: 'failed' } }); await assert.rejects(run(draft.pendingBody, true), /rejected the original/);
  assert.equal(draft.content, body.content); assert.equal(draft.blocked, false); assert.equal(draft.pendingBody, undefined); assert.equal(draft.confirmed, ''); assert.equal(keys.current.size, 0);
  const failedCount = calls.length; await run(body); assert.equal(calls.length, failedCount, 'A known failed check requires fresh explicit review before retrying.');
});

test('LinkedIn comment controls require one of six explicit reactions and never infer a live reaction type', async () => {
  const component = section('function LinkedInCommentReaction(', 'function ZernioInbox('), { code } = await transformWithOxc(component, 'LinkedInCommentReaction.tsx', { jsx: { runtime: 'classic' } });
  const Component = new Function('React', ...uiNames, 'useState', 'linkedInReactions', `${code}; return LinkedInCommentReaction;`)(React, ...uiValues, React.useState, linkedInReactions);
  const html = renderToStaticMarkup(React.createElement(Component, { comment: { id: 'comment', isLiked: true, reactionType: 'PRAISE' }, busy: false, onChange() {} }));
  assert.equal((html.match(/<option value="[A-Z]+"/g) || []).length, 6); assert.match(html, /Choose a reaction/); assert.match(html, /required=""/); assert.match(html, /Current reaction type is unknown/); assert.match(html, /Remove reaction/); assert.match(html, /<button type="submit"[^>]*disabled="">Add reaction/);
  for (const reactionType of Object.keys(linkedInReactions)) {
    const calls = [], render = new Function('React', ...uiNames, 'useState', 'linkedInReactions', `${code}; return LinkedInCommentReaction;`)(React, ...uiValues, () => [reactionType, () => {}], linkedInReactions);
    render({ comment: { id: 'comment' }, busy: false, onChange: (...args) => calls.push(args) }).props.onSubmit(event);
    assert.deepEqual(calls, [['like', { id: 'comment' }, reactionType]]);
  }
  assert.match(renderToStaticMarkup(React.createElement(Component, { comment: { id: 'comment', isLiked: true }, busy: true, onChange() {} })), /<select[^>]* required="" disabled=""/);
  assert.match(source, /!readOnly && capabilities\.commentLike && item\.canLike && \(account\?\.platform === 'linkedin' \? <LinkedInCommentReaction/);
});

test('comment reactions validate exact scoped receipts and retain one action key after malformed or lost acknowledgments', async () => {
  const keys = { current: new Map() }, calls = [], body = { accountId: 'li', postId: 'post', commentId: 'comment', reactionType: 'PRAISE' };
  let result = { operation: { status: 'complete' }, ...body, platform: 'linkedin', liked: true, alreadyReacted: true }, lost = false;
  const context = { readOnly: false, path, keys, crypto, account: { platform: 'linkedin' }, linkedInReactions, requester: { current: async (...args) => { calls.push(args); if (lost) throw new TypeError('Lost acknowledgment'); return result; } } };
  const write = compile(section('async function write(', '  async function loadAccounts('), context), good = { ...result };
  for (const mutation of [{ accountId: 'other' }, { postId: 'other' }, { commentId: 'other' }, { platform: 'facebook' }, { liked: false }, { reactionType: 'LIKE' }, { reactionType: undefined }, { alreadyReacted: 'yes' }, { operation: { status: 'pending' } }]) {
    result = { ...good, ...mutation }; await assert.rejects(write('comments/like', body), /action key has been retained/); assert.equal(keys.current.size, 1);
  }
  lost = true; await assert.rejects(write('comments/like', body), /Lost acknowledgment/); lost = false;
  assert.equal(new Set(calls.map(call => call[3])).size, 1);
  for (const reactionType of Object.keys(linkedInReactions)) { result = { ...good, reactionType }; assert.equal((await write('comments/like', { ...body, reactionType })).reactionType, reactionType); }
  assert.equal(keys.current.size, 0);
  result = { operation: { status: 'complete' }, accountId: 'li', postId: 'post', commentId: 'comment', platform: 'linkedin', liked: false }; await write('comments/unlike', { accountId: 'li', postId: 'post', commentId: 'comment' }); assert.equal(keys.current.size, 0);
});

test('retained comment handlers cannot write after role, account, post, comment or A-B-A scope changes', async () => {
  const scope = { current: { key: '', generation: 0, rows: [], readOnly: false } }, calls = [], notices = [], context = { projectId: 'project-a', accountId: 'li', account: { platform: 'linkedin' }, tab: 'comments', selected: { id: 'post-a' }, focusedComment: '', readOnly: false, version: { current: 1 }, threadRows: [{ id: 'comment', canLike: true }], commentEdit: null };
  const capture = changes => compile('function capture() {' + section('const commentScope = useRef(', '  const appliedReviewFilters = [') + ' return commentGeneration; }', { ...context, ...changes, useRef: () => scope, useLayoutEffect: effect => effect() })();
  const generation = capture(), handlerContext = { ...context, commentScope: scope, commentGeneration: generation, linkedInReactions, action: async (_, run) => run(1), write: async (...args) => { calls.push(args); return { reactionType: 'PRAISE', alreadyReacted: true }; }, setNotice: value => notices.push(value), refreshAfterWrite: async () => {} };
  const retained = compile(section('async function commentAction(', '  async function deleteReviewReply('), handlerContext);
  await retained('like', { id: 'comment' }, 'PRAISE'); assert.deepEqual(calls[0], ['comments/like', { accountId: 'li', postId: 'post-a', commentId: 'comment', reactionType: 'PRAISE' }]); assert.match(notices[0], /Celebrate reaction already present/);
  for (const changes of [{ readOnly: true }, { accountId: 'other' }, { selected: { id: 'post-b' } }, { projectId: 'project-b' }]) { capture(changes); await retained('like', { id: 'comment' }, 'PRAISE'); capture({}); await retained('like', { id: 'comment' }, 'PRAISE'); }
  assert.equal(calls.length, 1, 'Returning to the original scope does not revive its retained handler.');
  const current = compile(section('async function commentAction(', '  async function deleteReviewReply('), { ...handlerContext, commentGeneration: scope.current.generation });
  scope.current.rows = []; await current('like', { id: 'comment' }, 'PRAISE'); scope.current.rows = [{ id: 'comment', canLike: false }]; await current('like', { id: 'comment' }, 'PRAISE'); assert.equal(calls.length, 1);
  scope.current.rows = [{ id: 'comment', canLike: true }]; await current('like', { id: 'comment' }, 'INVALID'); await current('unlike', { id: 'comment' }, 'PRAISE'); assert.equal(calls.length, 1);
  const changedBeforeDispatch = compile(section('async function commentAction(', '  async function deleteReviewReply('), { ...handlerContext, commentGeneration: scope.current.generation, action: async (_, run) => { scope.current.generation++; await run(1); } });
  await changedBeforeDispatch('like', { id: 'comment' }, 'PRAISE'); assert.equal(calls.length, 1);
});

test('mention loading keeps opaque pages and newest-first scope while ignoring stale accounts', async () => {
  const calls = [], state = { rows: [], pagination: null }, version = { current: 1 };
  const context = { tab: 'mentions', accountId: 'li/account', historyFilter: null, path, version, merge, requester: { current: async route => { calls.push(route); return { mentions: [{ id: calls.length === 1 ? 'mention-document' : 'next-mention', content: 'Loaded content' }], pagination: { hasMore: calls.length === 1, nextCursor: calls.length === 1 ? 'opaque +/next' : null } }; } }, setRows: update => { state.rows = update(state.rows); }, setPagination: value => { state.pagination = value; }, setMeta() {}, setLoaded() {} };
  const load = compile(section('async function fetchList(', '  async function loadList('), context);
  await load(1); await load(1, 'opaque +/next'); assert.deepEqual(state.rows.map(row => row.id), ['mention-document', 'next-mention']);
  assert.deepEqual(Object.fromEntries(new URL(calls[0], 'https://app.example').searchParams), { accountId: 'li/account', sortOrder: 'desc' });
  assert.deepEqual(Object.fromEntries(new URL(calls[1], 'https://app.example').searchParams), { accountId: 'li/account', sortOrder: 'desc', cursor: 'opaque +/next' });
  const before = structuredClone(state); let finish;
  context.requester.current = async () => new Promise(resolve => { finish = resolve; });
  const stale = load(1); version.current++; context.accountId = 'another-account'; finish({ mentions: [{ id: 'foreign-mention' }], pagination: {} }); await stale; assert.deepEqual(state, before);
  const start = source.indexOf("    if (!accountId || tab === 'mentions') return;"), effect = source.slice(start, source.indexOf('  }, [projectId, accountId, tab,', start));
  assert.ok(start > 0); assert.equal(compile('function mentionPolling() {' + effect + '}', { tab: 'mentions', accountId: 'li/account' })(), undefined, 'Mentions never start the message/comment/review webhook poller.');
});

test('loaded mention search covers content and nullable author identity without provider search', () => {
  const matches = compile(section('function conversationMatches(', 'function SmsInbox('));
  const row = { content: 'Campaign research', authorName: 'Sam Example', authorUsername: 'sam-example' };
  assert.equal(matches(row, 'RESEARCH'), true); assert.equal(matches(row, 'sam example'), true); assert.equal(matches(row, 'sam-example'), true); assert.equal(matches({ ...row, authorName: null, authorUsername: null }, 'sam'), false); assert.equal(matches(row, 'unrelated'), false);
});

test('mention cards expand locally for readers and expose only returned safe LinkedIn post links', async () => {
  const safeLink = compile(section('const link = ', '\nconst merge = ').replace('const link = ', '').trim().replace(/;$/, ''));
  const accepted = 'https://www.linkedin.com/feed/update/urn:li:activity:123';
  assert.equal(safeLink(accepted, true), accepted); assert.equal(safeLink('https://linkedin.com/posts/example', true), 'https://linkedin.com/posts/example');
  for (const unsafe of [null, '', '/posts/123', 'javascript:alert(1)', 'http://www.linkedin.com/post', 'https://user:secret@www.linkedin.com/post', 'https://linkedin.com.evil.test/post', 'https://evil.test/linkedin.com/post']) assert.equal(safeLink(unsafe, true), undefined, String(unsafe));
  assert.equal(safeLink('https://example.test/attachment'), 'https://example.test/attachment', 'Other inbox links retain their existing HTTPS behavior.');
  const start = source.indexOf("<Stack as=\"section\" gap={3} aria-label={tab === 'mentions'"), markup = source.slice(start, source.indexOf('\n      {loaded && !visibleRows.length && listEmpty}', start)); assert.ok(start > 0);
  const code = await transformWithOxc('function MentionCards() { return (' + markup + '); }', 'MentionCards.tsx', { jsx: { runtime: 'classic' } });
  const rows = [{ id: 'mention-document', content: '<Campaign update>', authorName: null, authorUsername: null, publishedAt: null, permalink: accepted }, { id: 'another-document', content: 'More content', authorName: 'Sam', permalink: null }, { id: 'unsafe-document', permalink: 'https://evil.test/post' }];
  const component = new Function('React', ...uiNames, 'visibleRows', 'tab', 'account', 'when', 'link', 'readOnly', code.code + '; return MentionCards;')(React, ...uiValues, rows, 'mentions', { name: 'Connected account' }, () => 'Time unavailable', safeLink, true);
  const html = renderToStaticMarkup(React.createElement(component));
  assert.equal((html.match(/<details/g) || []).length, 3); assert.match(html, /<summary[^>]*><span[^>]*>Read mention/); assert.match(html, /LinkedIn author/); assert.match(html, /Time unavailable/); assert.match(html, /&lt;Campaign update&gt;/); assert.match(html, /Connected account/); assert.match(html, /Open post on LinkedIn/); assert.match(html, /target="_blank" rel="noopener noreferrer"/); assert.equal((html.match(/href=/g) || []).length, 1); assert.equal((html.match(/Post link unavailable/g) || []).length, 2); assert.doesNotMatch(html, /<button|<textarea|<form|evil\.test/);
  const mentions = markup.slice(markup.indexOf("tab === 'mentions' ?"), markup.indexOf(' : <Card as="article"')); assert.ok(mentions.length > 0);
  assert.doesNotMatch(mentions, /onClick|onToggle|openItem|fetchThread|prepareReply|authorUrn|organizationalEntity/, 'Expansion is native and cannot turn a mention document or author URN into a thread or fabricated URL.');
  assert.ok(source.includes("const canReply = tab === 'mentions' ? false")); assert.ok(source.includes('An account listed here is not confirmation that it is an organization.'));
});

test('private comment replies keep the exact operation key until the scoped platform receipt is confirmed', async () => {
  const keys = { current: new Map() }, calls = [], body = { accountId: 'fb', postId: 'post', commentId: 'comment', message: 'Reply privately', expectedCommentVersion: 'version', confirmSend: true };
  const good = { operation: { status: 'complete' }, sent: true, accountId: 'fb', postId: 'post', commentId: 'comment', platform: 'facebook', messageId: 'message-1' }; let result = good;
  const write = compile(section('async function write(', '  async function loadAccounts('), { readOnly: false, path, keys, crypto, privateReplyTarget: { platform: 'facebook' }, requester: { current: async (...args) => { calls.push(args); return result; } } });
  for (const invalid of [{ ...good, operation: { status: 'uncertain' } }, { ...good, sent: false }, { ...good, accountId: 'other' }, { ...good, postId: 'other' }, { ...good, commentId: 'other' }, { ...good, platform: 'instagram' }, { ...good, messageId: '' }]) {
    result = invalid; await assert.rejects(write('comments/private-reply', body), /retained/); assert.equal(keys.current.size, 1);
  }
  result = good; await write('comments/private-reply', body); assert.equal(keys.current.size, 0); assert.ok(calls.every(row => row[3] === calls[0][3]));
});

test('private comment composer submits only its exact reviewed recipient, comment, message and interactive options', async () => {
  const component = section('function PrivateCommentReply(', 'function ZernioInbox('), handler = component.slice(component.indexOf('async function submit('), component.indexOf('  const optionNoun ='));
  const target = { id: 'comment', accountId: 'ig', postId: 'post', privateReplyVersion: 'reviewed-version' }, elements = [{ type: 'url', title: 'View details', url: 'https://example.com/details' }], sent = [], context = { target, busy: false, eligible: true, confirmed: 'review', review: 'review', message: 'Thanks for your question.', limit: 1000, mode: 'buttons', elements, onSend: async body => sent.push(body) };
  for (const changes of [{ busy: true }, { eligible: false }, { confirmed: 'earlier-review' }, { message: ' ' }, { message: 'x'.repeat(1001) }, { elements: [] }]) await compile(handler, { ...context, ...changes })(event);
  assert.deepEqual(sent, []);
  await compile(handler, context)(event); assert.deepEqual(sent[0], { accountId: 'ig', postId: 'post', commentId: 'comment', expectedCommentVersion: 'reviewed-version', message: context.message, confirmSend: true, buttons: elements });
  await compile(handler, { ...context, mode: 'text', elements: [] })(event); assert.equal(Object.hasOwn(sent[1], 'buttons'), false); assert.equal(Object.hasOwn(sent[1], 'quickReplies'), false);
  const { code } = await transformWithOxc(component, 'PrivateCommentReply.tsx', { jsx: { runtime: 'classic' } });
  let values = ['Preview message', 'buttons', elements, ''];
  const render = new Function('React', ...uiNames, 'useEffect', 'useState', 'title', `${code}; return PrivateCommentReply;`)(React, ...uiValues, () => {}, () => [values.shift(), () => {}], value => value);
  const html = renderToStaticMarkup(render({ target: { ...target, platform: 'instagram', from: { name: 'Alex' }, message: 'Public question' }, current: { privateReplyEligible: true, privateReplyVersion: target.privateReplyVersion }, busy: false, onSend() {}, onCancel() {} }));
  assert.match(html, /Private message preview/); assert.match(html, /Preview message/); assert.match(html, /View details/); assert.match(html, /https:\/\/example.com\/details/); assert.match(html, /does not grant marketing permission/); assert.match(html, /Send private reply<\/button>/); assert.doesNotMatch(html, /Call a phone number/); assert.equal(sent.length, 2, 'Rendering a preview must never send.');
  assert.match(component, /JSON\.stringify\(\[target\.accountId, target\.postId, target\.id, target\.privateReplyVersion, message, mode, elements\]\)/, 'Review must be invalidated by a changed recipient, comment, caption, mode or button.');
});

test('private reply handler retains unsuccessful drafts and ignores a stale account, post, comment or generation', async () => {
  const target = { id: 'comment', accountId: 'ig', postId: 'post', privateReplyVersion: 'version' }, body = { accountId: 'ig', postId: 'post', commentId: 'comment', expectedCommentVersion: 'version', message: 'Thanks', confirmSend: true }, writes = [], cleared = [], notices = [], version = { current: 1 };
  const context = { readOnly: false, privateReplyTarget: target, selected: { id: 'post' }, accountId: 'ig', version, action: async (_, run) => run(1), write: async (...args) => { writes.push(args); }, setPrivateReplyTarget: value => cleared.push(value), setDetail() {}, setNotice: value => notices.push(value), refreshAfterWrite: async () => {} };
  const send = (changes = {}, draft = body) => compile(section('async function sendPrivateCommentReply(', '  async function loadReplyTemplates('), { ...context, ...changes })(draft);
  for (const changes of [{ readOnly: true }, { privateReplyTarget: null }, { selected: null }, { accountId: 'fb' }, { selected: { id: 'another-post' } }, { privateReplyTarget: { ...target, id: 'other-comment' } }, { privateReplyTarget: { ...target, privateReplyVersion: 'changed-version' } }]) await send(changes);
  await send({}, { ...body, confirmSend: false }); assert.equal(writes.length, 0);
  await assert.rejects(send({ write: async () => { throw new Error('Outcome unknown'); } }), /unknown/); assert.deepEqual(cleared, []);
  await send(); assert.deepEqual(writes[0], ['comments/private-reply', body]); assert.deepEqual(cleared, [null]); assert.match(notices[0], /Marketing permission has not changed/);
  version.current = 2; await send(); assert.deepEqual(cleared, [null]);
});

test('consumed and unknown private reply failures immediately disable the composer and comment action while retaining the draft', async () => {
  const comment = { id: 'comment', privateReplyEligible: true, privateReplyVersion: 'version' }, target = { ...comment, accountId: 'ig', postId: 'post', platform: 'instagram' }, body = { accountId: 'ig', postId: 'post', commentId: 'comment', expectedCommentVersion: 'version', message: 'Keep this private reply draft.', confirmSend: true }, cleared = [], version = { current: 1 };
  const component = section('function PrivateCommentReply(', 'function ZernioInbox('), { code } = await transformWithOxc(component, 'PrivateCommentReply.tsx', { jsx: { runtime: 'classic' } });
  for (const failure of [Object.assign(new Error('Do not retry.'), { status: 409, code: 'PRIVATE_REPLY_CONSUMED', operation: { status: 'failed' } }), Object.assign(new Error('Unknown outcome.'), { status: 409, code: 'OPERATION_UNCERTAIN', operation: { status: 'uncertain' } }), new Error('The reply receipt could not be read.')]) {
    let detail = { comments: [{ id: 'parent', replies: [comment] }], parent: comment };
    const send = compile(section('async function sendPrivateCommentReply(', '  async function loadReplyTemplates('), { readOnly: false, privateReplyTarget: target, selected: { id: 'post' }, accountId: 'ig', version, action: async (_, run) => run(1), write: async () => { throw failure; }, setDetail: update => { detail = update(detail); }, setPrivateReplyTarget: value => cleared.push(value), setNotice() {}, refreshAfterWrite: async () => {} });
    await assert.rejects(send(body), error => error === failure); const current = detail.comments[0].replies[0];
    assert.equal(current.privateReplyEligible, false); assert.equal(detail.parent.privateReplyEligible, false); assert.equal(current.privateReplyStatus, failure.code === 'PRIVATE_REPLY_CONSUMED' ? 'consumed' : 'uncertain'); assert.deepEqual(cleared, []);
    const review = JSON.stringify([target.accountId, target.postId, target.id, target.privateReplyVersion, body.message, 'text', []]); let states = [body.message, 'text', [], review];
    const render = new Function('React', ...uiNames, 'useEffect', 'useState', 'title', `${code}; return PrivateCommentReply;`)(React, ...uiValues, () => {}, () => [states.shift(), () => {}], value => value);
    const html = renderToStaticMarkup(render({ target, current, busy: false, onSend() {}, onCancel() {} })); assert.match(html, /Keep this private reply draft/); assert.match(html, /disabled="">Send private reply/); assert.match(html, /already has a private reply recorded/);
  }
  for (const failure of [Object.assign(new Error('Known input rejection.'), { status: 400, code: 'PROVIDER_REJECTED', operation: { status: 'failed' } }), Object.assign(new Error('Known preflight failure.'), { status: 502, operation: { status: 'failed' } })]) {
    let updates = 0;
    const send = compile(section('async function sendPrivateCommentReply(', '  async function loadReplyTemplates('), { readOnly: false, privateReplyTarget: target, selected: { id: 'post' }, accountId: 'ig', version, action: async (_, run) => run(1), write: async () => { throw failure; }, setDetail: () => { updates++; } });
    await assert.rejects(send(body)); assert.equal(updates, 0, 'Definitely failed requests remain retryable after correcting input or connection.');
  }
});

test('stored-copy deletion preserves review on failure, rejects changed messages and clears only the confirmed target', async () => {
  const selected = { id: 'thread/opaque', deleteVersion: 'latest-message-v1' }, target = { ...selected, accountId: 'account-a' }, calls = [], cleared = [], rows = [], notices = [], version = { current: 1 };
  const context = { readOnly: false, selected, deleteTarget: target, confirmStoredDelete: true, accountId: 'account-a', action: async (_, run) => run(1), write: async (...args) => { calls.push(args); return { deletedMessages: 3 }; }, version, resetSelection: () => cleared.push(true), setRows: update => rows.push(update([selected, { id: 'other' }])), setNotice: value => notices.push(value) };
  const submit = changes => { const active = { ...context, ...changes }; return compile(section('async function submitStoredDelete(', '  function prepareMessageAction('), active)(active.confirmStoredDelete); };
  for (const change of [{ readOnly: true }, { confirmStoredDelete: false }, { selected: { ...selected, deleteVersion: 'new-message' } }, { accountId: 'other' }]) await submit(change);
  assert.equal(calls.length, 0); await assert.rejects(submit({ write: async () => { throw new Error('Unknown'); } }), /Unknown/); assert.equal(cleared.length, 0);
  await submit(); assert.deepEqual(calls[0], ['conversations/thread%2Fopaque/delete', { accountId: 'account-a', expectedDeleteVersion: selected.deleteVersion, confirmConversationId: selected.id }]); assert.deepEqual(rows[0], [{ id: 'other' }]); assert.equal(cleared.length, 1); assert.match(notices[0], /platform thread and local contact remain/);
  version.current = 2; await submit(); assert.equal(cleared.length, 1, 'A late receipt cannot clear another project’s selection.');
});

test('typing uses an inline WhatsApp review, binds its current thread and reports false without claiming delivery', async () => {
  const calls = [], notices = [], reviews = [], errors = [], selected = { id: 'thread', deleteVersion: 'latest-v1' }, context = { readOnly: false, selected, accountId: 'wa', account: { platform: 'whatsapp' }, capabilities: { typing: true }, typingReview: '', setTypingReview: value => reviews.push(value), setError: value => errors.push(value), action: async (_, run) => run(1), write: async (...args) => { calls.push(args); return { delivered: false }; }, version: { current: 1 }, setNotice: value => notices.push(value) };
  const send = (changes = {}, confirmed = false) => compile(section('async function sendTyping(', '  function prepareStoredDelete('), { ...context, ...changes })(confirmed);
  await send(); assert.equal(calls.length, 0); const reviewed = reviews.at(-1); assert.equal(reviewed, JSON.stringify(['wa', 'thread', 'latest-v1']));
  await send({ typingReview: reviewed, selected: { ...selected, deleteVersion: 'new-message' } }, true); assert.equal(calls.length, 0); assert.match(errors.at(-1), /conversation changed/);
  await send({ typingReview: reviewed }, true); assert.deepEqual(calls[0], ['conversations/thread/typing', { accountId: 'wa', confirmTyping: true }]); assert.match(notices[0], /No typing indicator was sent/);
  await send({ account: { platform: 'telegram' }, write: async () => ({ delivered: true }) }); assert.match(notices.at(-1), /Typing indicator sent to the platform/);
  const count = calls.length; await send({ readOnly: true }); assert.equal(calls.length, count);
  assert.doesNotMatch(section('async function sendTyping(', '  function prepareStoredDelete('), /window\.confirm/); assert.match(source, /onConfirm=\{\(\) => sendTyping\(true\)\}/);
});

test('attachment loading validates returned URLs and ignores a late completion after the target changes', async () => {
  const component = section('function InboxAttachment(', 'function MessageActions('), handler = component.slice(component.indexOf('async function load('), component.indexOf('\n  return <Stack'));
  const calls = [], saved = [], errors = [], generation = { current: 1 }, target = path + '/conversations/thread/messages/message/attachments/0', item = { type: 'image' };
  const context = { loading: false, busy: false, generation, target, accountId: 'wa', item, request: async (...args) => { calls.push(args); return { attachment: { type: 'image', downloadUrl: `/api${target}?accountId=wa&download=1`, refreshed: false } }; }, link: value => value?.startsWith('https:') ? value : undefined, setLoading() {}, setError: value => errors.push(value), setResolved: value => saved.push(value) };
  const load = changes => compile(handler, { ...context, ...changes })();
  await load(); assert.equal(saved.length, 1); assert.deepEqual(calls[0], [target + '?accountId=wa']);
  await load({ request: async () => ({ attachment: { type: 'image', downloadUrl: '/api/foreign-private-file', refreshed: false } }) }); assert.match(errors.at(-1), /could not be verified/); assert.equal(saved.length, 1);
  await load({ request: async () => { generation.current++; return { attachment: { type: 'image', url: 'https://cdn.example.test/image.jpg', refreshed: true } }; } }); assert.equal(saved.length, 1);
});

test('a refreshed message attachment remounts its resolver at the same message and index', async () => {
  const element = source.match(/<InboxAttachment key=.+?\/>/)[0];
  const { code } = await transformWithOxc(`function render(selected, item, attachment, index) { return ${element}; }`, 'AttachmentKey.tsx', { jsx: { runtime: 'classic' } });
  const render = new Function('React', 'InboxAttachment', 'path', 'accountId', 'requester', 'busy', `${code}; return render;`)(React, () => null, path, 'account', { current() {} }, false);
  const before = render({ id: 'thread' }, { id: 'message', version: 'attachment-before' }, { type: 'image', filename: 'before.jpg' }, 0), after = render({ id: 'thread' }, { id: 'message', version: 'attachment-after' }, { type: 'image', filename: 'after.jpg' }, 0);
  assert.notEqual(before.key, after.key, 'A changed canonical message version must discard both the old resolved URL and its pending request.');
  assert.notEqual(render({ id: 'thread' }, { id: 'message' }, { type: 'image', url: 'https://cdn.example.test/a.jpg' }, 0).key, render({ id: 'thread' }, { id: 'message' }, { type: 'image', url: 'https://cdn.example.test/b.jpg' }, 0).key, 'Legacy responses without a version still reset on attachment identity changes.');
});

test('WhatsApp selected-button history renders escaped selection facts without guessing labels or exposing deleted responses', async () => {
  const historyStart = source.indexOf('<ConversationThread label="Message history"'), history = source.slice(historyStart, source.indexOf("\n        {!readOnly && canReply && selected.folder !== 'requests'", historyStart)); assert.ok(historyStart > 0);
  const { code } = await transformWithOxc(`function History({ items, platform = 'whatsapp' }) { const detail = { messages: items }, account = { platform }, selected = { id: 'thread', participantName: 'Customer' }; return ${history}; }`, 'SelectedButtonHistory.tsx', { jsx: { runtime: 'classic' } });
  const History = new Function('React', ...uiNames, 'when', 'InboxAttachment', 'MessageActions', 'path', 'accountId', 'requester', 'busy', 'readOnly', 'prepareMessageAction', 'openItem', `${code}; return History;`)(React, ...uiValues, () => 'Now', () => null, () => null, path, 'wa', { current() {} }, false, true, () => {}, () => {});
  const response = { id: 'button-response', direction: 'incoming', message: '', metadata: { interactiveType: 'button_reply', interactiveId: 'reply_2' } }, render = (items, platform) => renderToStaticMarkup(React.createElement(History, { items, platform }));
  const empty = render([response]); assert.match(empty, /Reply button selected/); assert.match(empty, /ID: reply_2/); assert.doesNotMatch(empty, /<button|href=|<img/);
  const escaped = render([{ ...response, message: '<b>Yes & please</b>', metadata: { interactiveType: 'button_reply', interactiveId: '<script>reply_1</script>' } }]); assert.match(escaped, /&lt;b&gt;Yes &amp; please&lt;\/b&gt;/); assert.match(escaped, /&lt;script&gt;reply_1&lt;\/script&gt;/); assert.doesNotMatch(escaped, /<script|<b>/);
  for (const change of [{ isDeleted: true }, { metadata: { ...response.metadata, isDeleted: true } }, { deliveryStatus: 'deleted' }]) { const hidden = render([{ ...response, message: 'Deleted label', ...change }]); assert.doesNotMatch(hidden, /Reply button selected|reply_2|Deleted label/); assert.match(hidden, /This message was deleted/); }
  for (const item of [{ ...response, direction: 'outgoing' }, { ...response, metadata: { interactiveType: 'list_reply', interactiveId: 'list-row' } }, { ...response, metadata: { interactiveType: 'button_reply', interactiveId: {} } }, { ...response, metadata: null }]) assert.doesNotMatch(render([item]), /Reply button selected/);
  assert.doesNotMatch(render([response], 'facebook'), /Reply button selected/); assert.equal((empty.match(/Reply button selected/g) || []).length, 1);
});

test('typing and conversation deletion receipts retain keys until their exact result is verified', async () => {
  const keys = { current: new Map() }, calls = []; let result = { operation: { status: 'complete' }, accepted: true, conversationId: 'other-thread', deleted: true, deletedMessages: 2, scope: 'zernio_copy' };
  const write = compile(section('async function write(', '  async function loadAccounts('), { readOnly: false, path, keys, crypto, requester: { current: async (...args) => { calls.push(args); return result; } } });
  await assert.rejects(write('conversations/thread/delete', { accountId: 'account' }), /retained/); assert.equal(keys.current.size, 1);
  result = { ...result, conversationId: 'thread' }; await write('conversations/thread/delete', { accountId: 'account' }); assert.equal(keys.current.size, 0); assert.equal(calls[0][3], calls[1][3]);
  result = { operation: { status: 'complete' }, accepted: true, conversationId: 'thread' }; await assert.rejects(write('conversations/thread/typing', { accountId: 'account' }), /retained/);
  result.delivered = false; await write('conversations/thread/typing', { accountId: 'account' }); assert.equal(keys.current.size, 0);
});

test('message action handlers submit the reviewed snapshot, retain failures and reject a stale or read-only target', async () => {
  const calls = [], cleared = [], notices = [], version = { current: 1 }, item = { id: 'message/opaque', version: 'message-version', message: 'Original', actions: { canEdit: true, canDelete: true } }, target = { kind: 'edit', item, conversationId: 'thread/opaque', accountId: 'account-a' };
  const context = { readOnly: false, selected: { id: 'thread/opaque' }, accountId: 'account-a', messageActionTarget: target, actionText: 'Edited message', actionEmoji: '👍', confirmMessageAction: true, action: async (_, run) => run(1), write: async (...args) => { calls.push(args); return { observed: true }; }, version, setMessageActionTarget: value => cleared.push(value), setNotice: value => notices.push(value), refreshAfterWrite: async () => {} };
  const submit = changes => { const active = { ...context, ...changes }; return compile(section('async function submitMessageAction(', '  async function submitControl('), active)(active.confirmMessageAction); };
  for (const changes of [{ readOnly: true }, { selected: { id: 'other' } }, { accountId: 'other' }, { messageActionTarget: { ...target, kind: 'delete' }, confirmMessageAction: false }]) await submit(changes); assert.equal(calls.length, 0);
  await assert.rejects(submit({ write: async () => { throw new Error('Unknown outcome'); } }), /Unknown/); assert.deepEqual(cleared, []);
  await submit(); assert.deepEqual(calls[0], ['conversations/thread%2Fopaque/messages/message%2Fopaque/edit', { accountId: 'account-a', expectedMessageVersion: 'message-version', text: 'Edited message' }]); assert.deepEqual(cleared, [null]); assert.match(notices[0], /confirmed in message history/);
  await submit({ messageActionTarget: { ...target, kind: 'react' }, write: async () => ({ observed: false }) }); assert.match(notices.at(-1), /not yet confirmed/);
  const count = cleared.length; version.current = 2; await submit(); assert.equal(cleared.length, count, 'A late action cannot close the next project or account’s draft.');
});

test('handover and request-acceptance handlers require review and retain drafts until confirmed', async () => {
  const calls = [], controls = [], notices = [], cleared = [], threads = [], selected = { id: 'thread', version: 'conversation-version', folder: 'requests', controlActions: ['pass', 'request'] }, version = { current: 1 };
  const context = { readOnly: false, selected, accountId: 'account-a', controlAction: 'pass', targetAppId: '263902037430900', controlNote: 'Customer asked for support', confirmControl: selected.version, confirmAccept: selected.version, capabilities: { acceptRequest: true }, message: 'Thanks for your request', action: async (_, run) => run(1), write: async (...args) => { calls.push(args); return { conversation: { ...selected, threadControl: 'other' }, requested: false }; }, version, setSelected: update => controls.push(update(selected)), setConfirmControl: value => cleared.push(value), setControlAction() {}, setNotice: value => notices.push(value), refreshAfterWrite: async () => {}, setMessage: value => cleared.push(value), setConfirmAccept: value => cleared.push(value), setRows: update => cleared.push(update([selected])), fetchThread: async item => threads.push(item), setError() {} };
  const control = changes => { const active = { ...context, ...changes }; return compile(section('async function submitControl(', '  async function submitAccept('), active)(active.confirmControl); };
  await control({ confirmControl: false }); await control({ readOnly: true }); assert.equal(calls.length, 0);
  await assert.rejects(control({ write: async () => { throw new Error('Outcome uncertain'); } }), /uncertain/); assert.deepEqual(cleared, []);
  await control(); assert.deepEqual(calls[0], ['conversations/thread/thread-control', { accountId: 'account-a', action: 'pass', expectedConversationVersion: 'conversation-version', confirmControl: true, targetAppId: '263902037430900', metadata: 'Customer asked for support' }]); assert.equal(controls[0].threadControl, 'other');
  await control({ controlAction: 'request', write: async () => ({ requested: true, conversation: selected }) }); assert.match(notices.at(-1), /must still transfer/);
  const accept = changes => { const active = { ...context, ...changes }; return compile(section('async function submitAccept(', '  async function editComment('), active)(active.confirmAccept); };
  const count = calls.length; await accept({ confirmAccept: false }); await accept({ selected: { ...selected, folder: undefined } }); assert.equal(calls.length, count);
  await accept(); assert.deepEqual(calls.at(-1), ['conversations/thread/accept', { accountId: 'account-a', message: 'Thanks for your request', expectedConversationVersion: 'conversation-version', confirmSend: true }]); assert.equal(threads[0].folder, undefined, 'Accepted requests cannot regain their old request-folder flag during refresh.'); assert.equal(controls.at(-1).folder, undefined); assert.ok(cleared.some(value => Array.isArray(value) && value.length === 0));
});

test('conversation confirmations retain the reviewed version across refreshes and uncertain retries', async () => {
  let selected = { id: 'thread', version: 'reviewed-version', folder: 'requests', controlActions: ['pass'] }, confirmControl = false, confirmAccept = false, uncertain = true;
  const calls = [], keys = { current: new Map() }, version = { current: 1 };
  // The review panels confirm the conversation version shown when they were acknowledged; a new version clears their checks.
  assert.ok(source.includes('reviewKey={JSON.stringify([selected.id, selected.version, controlAction, targetAppId, controlNote])}')); assert.ok(source.includes('reviewKey={JSON.stringify([selected.id, selected.version, message])}'));
  const confirm = kind => {
    const marker = `onConfirm={() => submit${kind}(`, start = source.indexOf(marker) + 'onConfirm={'.length;
    assert.ok(start > 'onConfirm={'.length);
    const reviewed = compile(source.slice(start, source.indexOf('}', start)).replace(`submit${kind}`, 'confirmed'), { selected, confirmed: value => value })();
    if (kind === 'Control') confirmControl = reviewed; else confirmAccept = reviewed;
  };
  confirm('Control'); confirm('Accept');
  assert.equal(confirmControl, selected.version); assert.equal(confirmAccept, selected.version);
  const fetchThread = compile(section('async function fetchThread(', '  async function openItem('), {
    tab: 'messages', accountId: 'account', path, version, merge,
    requester: { current: async () => ({ conversation: { ...selected, version: 'refreshed-version', threadControl: 'other' }, messages: [] }) },
    setSelected: value => { selected = value; }, setFocusedComment() {}, setDetail() {},
  });
  await fetchThread(selected, 1);
  const write = compile(section('async function write(', '  async function loadAccounts('), {
    readOnly: false, path, keys, crypto, requester: { current: async (...args) => {
      calls.push(args); if (uncertain) throw Object.assign(new Error('Outcome uncertain'), { status: 409, code: 'OPERATION_UNCERTAIN' });
      return { operation: { status: 'complete' }, accepted: true, conversation: selected, control: { owner: 'other' } };
    } },
  });
  const submit = kind => compile(section(`async function submit${kind}(`, kind === 'Control' ? '  async function submitAccept(' : '  async function editComment('), {
    readOnly: false, selected, accountId: 'account', controlAction: 'pass', targetAppId: '263902037430900', controlNote: '', confirmControl, confirmAccept,
    capabilities: { acceptRequest: true }, message: 'Acceptance reply', action: async (_, run) => run(1), write, version,
    setSelected() {}, setConfirmControl: value => { confirmControl = value; }, setControlAction() {}, setNotice() {}, refreshAfterWrite() {},
    setMessage() {}, setConfirmAccept() {}, setRows() {}, fetchThread() {}, setError() {},
  })(kind === 'Control' ? confirmControl : confirmAccept);
  await submit('Control'); await submit('Accept');
  assert.equal(calls.length, 0, 'A refreshed conversation cannot inherit either earlier review confirmation.');
  confirm('Control');
  await assert.rejects(submit('Control'), /uncertain/);
  assert.equal(confirmControl, 'refreshed-version'); assert.equal(keys.current.size, 1);
  uncertain = false; await submit('Control');
  assert.equal(calls[0][2].expectedConversationVersion, 'refreshed-version');
  assert.deepEqual(calls[0], calls[1], 'Retrying the unchanged reviewed snapshot keeps its request body and action key.');
  assert.equal(keys.current.size, 0);
});

test('new action receipts are validated before their operation keys are released', async () => {
  const keys = { current: new Map() }, calls = [], suffix = 'conversations/thread/messages/message/react'; let response = { operation: { status: 'complete' }, accepted: true, action: 'react', messageId: 'wrong' };
  const write = compile(section('async function write(', '  async function loadAccounts('), { readOnly: false, path, keys, crypto, requester: { current: async (...args) => { calls.push(args); return response; } } });
  await assert.rejects(write(suffix, { accountId: 'account' }), /retained/); assert.equal(keys.current.size, 1);
  response = { ...response, messageId: 'message' }; await write(suffix, { accountId: 'account' }); assert.equal(keys.current.size, 0); assert.equal(calls[0][3], calls[1][3]);
});

test('rendered message controls preserve deletion scope, reactions, history and reader permissions', async () => {
  const { code } = await transformWithOxc(section('function MessageActions(', 'function ZernioInbox('), 'MessageActions.tsx', { jsx: { runtime: 'classic' } });
  const Component = new Function('React', ...uiNames, 'when', `${code}; return MessageActions;`)(React, ...uiValues, value => value || 'Unknown');
  const props = { item: { id: 'message', message: 'Text', direction: 'outgoing', reactions: [{ emoji: '👍', fromMe: true }, { emoji: '❤️', fromMe: false }], editHistory: [{ text: '<previous>', editedAt: '2026-10-18' }], actions: { canEdit: true, canDelete: true, canReact: true, canUnreact: true, deleteScope: 'self' } }, platform: 'reddit', busy: false, readOnly: false, onAction() {} };
  const rendered = renderToStaticMarkup(React.createElement(Component, props)); assert.match(rendered, /Remove from my view/); assert.match(rendered, /Your reaction/); assert.match(rendered, /Contact reaction/); assert.match(rendered, /Previous message versions/); assert.match(rendered, /&lt;previous&gt;/);
  const reader = renderToStaticMarkup(React.createElement(Component, { ...props, readOnly: true })); assert.doesNotMatch(reader, /<button/); assert.match(reader, /Your reaction/);
  const unknown = renderToStaticMarkup(React.createElement(Component, { ...props, item: { ...props.item, reactions: [{ emoji: '🔥' }] } })); assert.match(unknown, /Sender not reported/); assert.doesNotMatch(unknown, /Contact reaction/);
  const apple = renderToStaticMarkup(React.createElement(Component, { ...props, platform: 'imessage', item: { ...props.item, actions: { ...props.item.actions, deleteScope: 'unsend' } } })); assert.match(apple, /Unsend message/); assert.match(apple, /15 minutes/);
});

test('actual inbox writer retains the same operation key after an uncertain reply and blocks viewers', async () => {
  const keys = { current: new Map() }, calls = [];
  let fail = true;
  const context = { readOnly: false, path, keys, crypto, requester: { current: async (...args) => { calls.push(args); if (fail) throw new Error('Connection lost'); return { operation: { status: 'complete' }, sent: true, accountId: 'account', platform: 'facebook', messageId: 'sent-message' }; } }, account: { platform: 'facebook' } };
  const write = compile(section('async function write(', '  async function loadAccounts('), context);
  await assert.rejects(write('conversations/thread/reply', { accountId: 'account', message: 'Hello' }), /Connection lost/);
  fail = false; await write('conversations/thread/reply', { accountId: 'account', message: 'Hello' });
  assert.equal(calls[0][3], calls[1][3]); assert.equal(keys.current.size, 0); assert.equal(calls[0][0], path + '/conversations/thread/reply');
  await write('conversations/thread/reply', { accountId: 'account', message: 'Hello again' }); assert.notEqual(calls[1][3], calls[2][3]);
  await assert.rejects(compile(section('async function write(', '  async function loadAccounts('), { ...context, readOnly: true })('any', {}), /cannot send/); assert.equal(calls.length, 3);
});

test('reply receipts retain their action key for malformed, foreign and contradictory partial acknowledgements', async () => {
  const keys = { current: new Map() }, calls = [], body = { accountId: 'ig', message: 'Unsent text', attachmentUrl: 'https://cdn.example.com/photo.png', attachmentType: 'image' }, valid = { operation: { status: 'complete' }, sent: true, accountId: 'ig', platform: 'instagram', messageId: 'attachment-sent', partialFailure: { part: 'text', error: 'Text rejected' }, messageIds: ['attachment-sent'] }; let result;
  const write = compile(section('async function write(', '  async function loadAccounts('), { readOnly: false, path, keys, crypto, account: { platform: 'instagram' }, requester: { current: async (...args) => { calls.push(args); return result; } } });
  for (const bad of [null, {}, { ...valid, accountId: 'other' }, { ...valid, platform: 'reddit' }, { ...valid, messageId: undefined }, { ...valid, partialFailure: undefined, messageIds: undefined }, { ...valid, partialFailure: true }, { ...valid, partialFailure: { part: 'attachment', error: 'Wrong part' } }, { ...valid, messageIds: ['attachment-sent', 'text-sent'] }, { ...valid, messageIds: ['wrong'] }]) {
    result = bad; await assert.rejects(write('conversations/thread/reply', body), /draft and action key have been retained/); assert.equal(keys.current.size, 1);
  }
  assert.equal(new Set(calls.map(call => call[3])).size, 1); result = valid; await write('conversations/thread/reply', body); assert.equal(keys.current.size, 0);
});

test('shared inbox writes release explicit failed receipts but retain unknown outcomes and contradictory uncertainty codes', async () => {
  for (const [status, operation, code, release] of [
    [502, { id: 'failed-inspection', status: 'failed' }, 'PROVIDER_REJECTED', true], [400, undefined, 'INVALID_INBOX_CONTENT', true],
    [502, undefined, 'PROVIDER_UNAVAILABLE', false], [409, { status: 'uncertain' }, 'OPERATION_UNCERTAIN', false], [409, { status: 'pending' }, 'OPERATION_IN_PROGRESS', false],
    [400, { status: 'unknown' }, 'PROVIDER_REJECTED', false], [400, {}, 'PROVIDER_REJECTED', false], [502, { status: 'failed' }, 'OPERATION_UNCERTAIN', false], [502, { status: 'failed' }, 'OPERATION_PENDING', false],
  ]) {
    const keys = { current: new Map() }, calls = [], context = { readOnly: false, path, keys, crypto, requester: { current: async (...args) => { calls.push(args); throw Object.assign(new Error('Synthetic failure'), { status, operation, code }); } } }, write = compile(section('async function write(', '  async function loadAccounts('), context);
    for (const suffix of ['conversations/thread/reply', 'conversations/thread/read', 'conversations/thread/typing', 'conversations/thread/delete', 'conversations/thread/thread-control', 'conversations/thread/accept', 'conversations/thread/messages/message/edit', 'comments/reply', 'reviews/delete-reply']) {
      keys.current.clear(); await assert.rejects(write(suffix, { accountId: 'ig' }), /Synthetic failure/); assert.equal(keys.current.size, release ? 0 : 1, `${suffix}: ${status}/${operation?.status}/${code}`);
    }
  }
});

test('a missing second Meta message acknowledgement preserves the actual reply draft and action key', async () => {
  const keys = { current: new Map() }, cleared = [], calls = [], context = { replyButtons: [], readOnly: false, canReply: true, account: { platform: 'instagram' }, tab: 'messages', templateMode: false, message: 'Do not lose this text', messageLimit: 1000, accountId: 'ig', selected: { id: 'thread' }, replyTarget: null, confirmReplace: false, attachmentUrl: 'https://cdn.example.com/photo.png', attachmentType: 'image', attachmentName: '', messageTag: '', path, keys, crypto, action: async (_, run) => run(1), version: { current: 1 }, setMessage: value => cleared.push(value), setAttachmentUrl: value => cleared.push(value), setAttachmentName: value => cleared.push(value), setAttachmentPreview() {}, setAttachmentType() {}, setMessageTag() {}, setReplyTarget() {}, setConfirmReplace() {}, setNotice() {}, setError() {}, refreshAfterWrite: async () => {}, requester: { current: async (...args) => { calls.push(args); return { operation: { status: 'complete' }, sent: true, accountId: 'ig', platform: 'instagram', messageId: 'attachment-only' }; } } };
  context.write = compile(section('async function write(', '  async function loadAccounts('), context);
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(compile(section('async function reply(', '  async function conversationAction('), context)(event), /draft and action key have been retained/);
  assert.deepEqual(cleared, []); assert.equal(keys.current.size, 1); assert.equal(calls[0][3], calls[1][3]);
});

test('partial Meta sends keep only the unsent text and an explicit follow-up cannot resend the accepted attachment', async () => {
  const calls = [], notices = [], keys = { current: new Map() }, context = { replyButtons: [], account: { platform: 'instagram' }, templateMode: false, selectedTemplate: null, templateComponents: [], templateRestriction: () => '', resetTemplate() {}, readOnly: false, canReply: true, message: 'Keep this rejected text', messageLimit: 1000, accountId: 'ig', tab: 'messages', selected: { id: 'thread' }, replyTarget: null, confirmReplace: false, messageTag: 'HUMAN_AGENT', attachmentUrl: 'https://cdn.example.com/accepted.png', attachmentType: 'image', attachmentName: 'accepted.png', path, keys, crypto, version: { current: 1 }, action: async (_, run) => run(1), setReplyTarget() {}, setConfirmReplace() {}, setError() {}, refreshAfterWrite: async () => {}, setNotice: value => notices.push(value) };
  for (const [setter, name] of [['setMessage', 'message'], ['setAttachmentUrl', 'attachmentUrl'], ['setAttachmentName', 'attachmentName'], ['setAttachmentPreview', 'attachmentPreview'], ['setMessageTag', 'messageTag'], ['setAttachmentType', 'attachmentType']]) context[setter] = value => { context[name] = value; };
  context.requester = { current: async (...args) => { calls.push(args); return { operation: { status: 'complete' }, sent: true, accountId: 'ig', platform: 'instagram', messageId: calls.length === 1 ? 'attachment-sent' : 'text-sent', ...(calls.length === 1 ? { partialFailure: { part: 'text', error: 'Rejected text' } } : {}) }; } };
  context.write = compile(section('async function write(', '  async function loadAccounts('), context);
  await compile(section('async function reply(', '  async function conversationAction('), context)(event);
  assert.equal(context.message, 'Keep this rejected text'); assert.equal(context.messageTag, 'HUMAN_AGENT'); assert.equal(context.attachmentUrl, ''); assert.equal(context.attachmentName, ''); assert.match(notices[0], /text was not sent/); assert.equal(calls.length, 1, 'A partial receipt never automatically sends the remaining text.');
  await compile(section('async function reply(', '  async function conversationAction('), context)(event);
  assert.deepEqual(calls[1][2], { accountId: 'ig', message: 'Keep this rejected text', messageTag: 'HUMAN_AGENT' }); assert.equal(context.message, ''); assert.notEqual(calls[0][3], calls[1][3]);
});

test('attachment fields expose supported audio, account limits and an explicit preview without sending', async () => {
  const markup = source.match(/<Disclosure summary="Attach a public file">.*?<\/Disclosure>/)[0], attachment = section('function Attachment(', 'function InboxAttachment(');
  const { code } = await transformWithOxc(`${attachment}\nfunction Fields(props) { const { capabilities, account, attachmentType, attachmentUrl, attachmentName, attachmentPreview, message, setAttachmentType, setAttachmentUrl, setAttachmentName, setAttachmentPreview } = props; return ${markup}; }`, 'ReplyAttachment.tsx', { jsx: { runtime: 'classic' } });
  const Fields = new Function('React', ...uiNames, 'useState', 'link', 'title', `${code}; return Fields;`)(React, ...uiValues, React.useState, value => value?.startsWith('https:') ? value : undefined, value => value);
  const props = { capabilities: { attachmentTypes: ['image', 'video', 'audio', 'file'], attachmentRules: { audio: { maxMB: 25, formats: 'AAC, M4A, WAV or MP4; no MP3 or OGG/Opus' } } }, account: { platform: 'instagram' }, attachmentType: 'audio', attachmentUrl: 'https://cdn.example.com/audio.m4a', attachmentName: 'audio.m4a', attachmentPreview: '', message: 'Follow-up text', setAttachmentType() {}, setAttachmentUrl() {}, setAttachmentName() {}, setAttachmentPreview() {} };
  const before = renderToStaticMarkup(React.createElement(Fields, props)); assert.match(before, /value="audio" selected=""/); assert.match(before, /Maximum 25 MB/); assert.match(before, /no MP3 or OGG\/Opus/); assert.match(before, /two separate messages/); assert.doesNotMatch(before, /<audio/);
  const preview = renderToStaticMarkup(React.createElement(Fields, { ...props, attachmentPreview: props.attachmentUrl })); assert.match(preview, /<audio/); assert.match(preview, /preload="none"/);
  const x = renderToStaticMarkup(React.createElement(Fields, { ...props, account: { platform: 'twitter' }, capabilities: { attachmentTypes: ['image', 'video'] }, attachmentType: 'image', attachmentPreview: '' })); assert.doesNotMatch(x, /value="audio"|value="file"|two separate messages/);
  assert.doesNotMatch(before, /Document filename/); assert.doesNotMatch(x, /Document filename/);
  const document = renderToStaticMarkup(React.createElement(Fields, { ...props, account: { platform: 'whatsapp' }, attachmentType: 'file' })); assert.match(document, /Document filename \(optional\)/);
  const media = renderToStaticMarkup(React.createElement(Fields, { ...props, account: { platform: 'whatsapp' }, attachmentType: 'audio' })); assert.doesNotMatch(media, /Document filename/);
});

test('optional history search keeps conversation actions, active results and provider limits outside its native disclosure', async () => {
  const start = source.lastIndexOf("    {tab === 'messages' &&", source.indexOf('<Form aria-label="Search message history"')), end = source.indexOf('\n    {starting &&', start);
  assert.ok(start > 0 && end > start);
  const { code } = await transformWithOxc(`function HistorySearch(props) { const { tab, historyQuery, historyDirection, busy, accountId, connected, historyFilter, readOnly, capabilities, starting, setHistoryQuery, setHistoryDirection, searchHistory, loadList, prepareConversation } = props; return <>${source.slice(start, end)}</>; }`, 'HistorySearch.tsx', { jsx: { runtime: 'classic' } });
  const HistorySearch = new Function('React', ...uiNames, code + '; return HistorySearch;')(React, ...uiValues), props = { tab: 'messages', historyQuery: 'kept search draft', historyDirection: 'incoming', busy: '', accountId: 'account/one', connected: true, historyFilter: { query: 'invoice', direction: 'incoming' }, readOnly: false, capabilities: { start: true }, starting: false, setHistoryQuery() {}, setHistoryDirection() {}, searchHistory() {}, loadList() {}, prepareConversation() {} };
  const render = changes => renderToStaticMarkup(React.createElement(HistorySearch, { ...props, ...changes }));
  const html = render(), disclosure = html.match(/<details[\s\S]*?<\/details>/)?.[0]; assert.ok(disclosure, 'Search fields must stay mounted inside a native disclosure.');
  assert.match(disclosure, /<summary[^>]*><span[^>]*>Search message history<\/span>/); assert.doesNotMatch(disclosure.match(/^<details[^>]*>/)[0], /\bopen=/);
  assert.match(disclosure, /value="kept search draft"/); assert.match(disclosure, /value="incoming" selected=""/); assert.match(disclosure, />Search history<\/button>/); assert.match(disclosure, /whole tokens/);
  const outside = html.replace(disclosure, ''); for (const text of ['Return to conversations', 'New conversation', 'History results for', 'up to three recent matching messages', 'Live-only accounts may be skipped', 'history stored by Zernio']) assert.ok(outside.includes(text), text);
  assert.doesNotMatch(disclosure, /Return to conversations|New conversation|History results for|Live-only accounts|up to three/);
  const viewer = render({ readOnly: true }); assert.doesNotMatch(viewer, /New conversation/); assert.match(viewer, /Return to conversations/); assert.match(viewer, /Search history/);
  assert.doesNotMatch(render({ historyFilter: null, capabilities: {} }), /Return to conversations|New conversation|History results for/);
  assert.equal(render({ tab: 'comments' }).trim(), '');
  assert.match(source.slice(0, start), /Provider reply windows and account permissions apply/); assert.match(source.slice(end), /Some connected accounts cannot be searched/);
});

test('full-history search uses the actual provider search loader, preserves page cursors and ignores previous-account results', async () => {
  const calls = [], rows = [], version = { current: 3 }, filters = [], context = { tab: 'messages', accountId: 'account/one', historyFilter: { query: 'old invoice', direction: 'incoming' }, conversationStatus: 'active', requester: { current: async route => { calls.push(route); return { conversations: [{ id: 'older-thread', matchCount: 1, matches: [{ id: 'old', text: 'old invoice' }] }], pagination: { hasMore: true, nextCursor: 'opaque +/' }, meta: { accountsSkipped: [] } }; } }, path, version, merge, setRows: value => rows.push(typeof value === 'function' ? value([]) : value), setPagination() {}, setMeta() {}, setLoaded() {} };
  const fetchList = compile(section('async function fetchList(', '  async function loadList('), context);
  await fetchList(3, 'opaque +/'); const query = new URL(calls[0], 'https://app.example').searchParams; assert.equal(query.get('cursor'), 'opaque +/'); assert.equal(query.get('query'), 'old invoice'); assert.equal(query.get('direction'), 'incoming'); assert.equal(query.has('status'), false); assert.match(calls[0], /conversations\/search\?/); assert.equal(rows[0][0].matches[0].text, 'old invoice');
  version.current = 4; await fetchList(3); assert.equal(rows.length, 1);
  const search = compile(section('async function searchHistory(', '  async function prepareConversation('), { tab: 'messages', accountId: 'account/one', pending: { current: false }, historyQuery: '  old invoice  ', switchSelection: change => change(), historyDirection: 'outgoing', version, setError() {}, action: async (_, run) => run(version.current), fetchList: async (...args) => filters.push(args), setHistoryFilter: value => filters.push(value), resetSelection: () => filters.push('selection cleared') });
  await search(event); assert.deepEqual(filters[0], [4, '', { query: 'old invoice', direction: 'outgoing' }]); assert.deepEqual(filters[1], { query: 'old invoice', direction: 'outgoing' }); assert.equal(version.current, 4);
});

test('new-conversation preparation rejects stale results and does not overwrite an existing reply template draft', async () => {
  const calls = [], recipients = [], opening = [], templates = [], version = { current: 1 }, context = { readOnly: false, capabilities: { start: true }, accountId: 'wa/account', account: { platform: 'whatsapp' }, action: async (_, run) => run(1), requester: { current: async route => { calls.push(route); return route.includes('/direct/templates') ? { templates: [{ name: 'approved', status: 'APPROVED' }, { name: 'draft', status: 'PENDING' }] } : { recipients: [{ id: 'permitted-contact' }] }; } }, path, projectId: 'project/one', version, setRecipients: value => recipients.push(value), setOpeningTemplates: value => templates.push(value), setStarting: value => opening.push(value), setConfirmSend() {} };
  const prepare = changes => compile(section('async function prepareConversation(', '  async function startConversation('), { ...context, ...changes })();
  await prepare(); assert.equal(new URL(calls[0], 'https://app.example').searchParams.get('accountId'), 'wa/account'); assert.equal(templates[0].length, 1); assert.deepEqual(opening, [true]); assert.equal(recipients[0][0].id, 'permitted-contact');
  version.current = 2; await prepare(); assert.equal(recipients.length, 1); assert.equal(templates.length, 1); const count = calls.length; await prepare({ readOnly: true }); await prepare({ capabilities: { start: false } }); assert.equal(calls.length, count);
});

test('opening-message sends require review, retain failed drafts and separate accepted sends from a failed thread refresh', async () => {
  const calls = [], changed = [], notices = [], errors = [], version = { current: 1 }, context = { readOnly: false, capabilities: { start: true, messageLimit: 10000 }, accountId: 'x-account', account: { platform: 'twitter' }, recipient: '@alex', openingMessage: 'Hello Alex', confirmSend: true, openingTemplate: null, openingTemplateComponents: [], templateRestriction: () => '', action: async (_, run) => run(1), write: async (...args) => { calls.push(args); return { conversationId: 'existing-or-new', platform: 'twitter' }; }, version, setStarting: value => changed.push(value), setRecipient: value => changed.push(value), setOpeningMessage: value => changed.push(value), setConfirmSend() {}, setOpeningTemplateKey() {}, setOpeningTemplateComponents() {}, setNotice: value => notices.push(value), fetchThread: async () => { throw new Error('Temporary read failure'); }, setError: value => errors.push(value) };
  const send = changes => { const active = { replyDraft: false, ...context, ...changes }; return compile(section('async function startConversation(', '  async function fetchList('), active)(active.confirmSend); };
  for (const changes of [{ confirmSend: false }, { readOnly: true }, { recipient: '' }, { openingMessage: '' }]) await send(changes); assert.equal(calls.length, 0);
  await assert.rejects(send({ write: async () => { throw new Error('Outcome uncertain'); } }), /uncertain/); assert.deepEqual(changed, [], 'An uncertain write retains recipient, text and reviewed state for recovery.');
  await send(); assert.deepEqual(calls[0], ['conversations/start', { accountId: 'x-account', participantUsername: '@alex', message: 'Hello Alex', confirmSend: true }]); assert.deepEqual(changed, [false, '', '']); assert.match(notices[0], /accepted/); assert.match(errors.at(-1), /was accepted/);
  const listed = []; await send({ historyFilter: null, conversationStatus: 'active', merge, fetchThread: async () => ({ id: 'existing-or-new', status: 'active', lastMessageAt: '2026-10-18T12:00:00Z' }), setRows: update => listed.push(update([{ id: 'old-thread' }])) }); assert.equal(listed[0][0].id, 'existing-or-new', 'A newly read-back conversation appears in the normal conversation list immediately.');
  const kept = []; await send({ replyDraft: true, fetchThread: async () => kept.push('changed recipient') }); assert.deepEqual(kept, []); assert.match(notices.at(-1), /original conversation/);
  changed.length = 0; version.current = 2; await send(); assert.deepEqual(changed, [], 'A late send receipt cannot clear the next account’s opening draft.');
});

test('an old Zernio update read cannot overwrite a manual search and later polling continues normally', async () => {
  const handler = section('const poll = async () =>', '    void poll();').replace('const poll = ', '').trim().replace(/;$/, ''), revision = { current: 0 }, refreshed = [];
  let finish, first = true;
  const context = { revision, checking: false, pending: { current: false }, requester: { current: async () => first ? (first = false, new Promise(resolve => { finish = resolve; })) : { cursor: 2, updates: [{ event: 'message.received' }] } }, path, accountId: 'account', cursor: undefined, closed: false, generation: 1, version: { current: 1 }, tab: 'messages', loaded: true, selected: null, focusedComment: '', action: async (_, run) => run(1), fetchList: async () => refreshed.push('current search'), fetchThread: async () => {}, setNotice() {} };
  const poll = compile(handler, context), earlier = poll(); revision.current++; finish({ cursor: 1, updates: [{ event: 'message.received' }] }); await earlier; assert.deepEqual(refreshed, []);
  await poll(); assert.deepEqual(refreshed, ['current search'], 'Rejecting an older update does not disable subsequent provider refreshes.');
});

test('actual reply handler uses scoped provider payloads, explicit review replacement approval and preserves failed drafts', async () => {
  const handler = section('async function reply(', '  async function conversationAction(');
  async function run(changes = {}) {
    const calls = [], messages = [], targets = [], notices = [], errors = [];
    const context = { replyButtons: [], retainedButtonReply: null, buttonScopeKey: 'legacy', buttonGeneration: 0, buttonScope: { current: { key: 'legacy', generation: 0 } }, account: {}, templateMode: false, selectedTemplate: null, templateComponents: [], templateRestriction: () => '', resetTemplate() {}, readOnly: false, canReply: true, message: 'Hello there', messageLimit: 10000, accountId: 'account', tab: 'messages', selected: { id: 'opaque/thread ?' }, replyTarget: null, confirmReplace: false, messageTag: 'HUMAN_AGENT', attachmentUrl: '', attachmentType: 'image', attachmentName: '', action: async (_, perform) => perform(1), write: async (...args) => calls.push(args), version: { current: 1 }, setMessage: value => messages.push(value), setAttachmentUrl() {}, setAttachmentName() {}, setAttachmentPreview() {}, setAttachmentType() {}, setMessageTag() {}, setReplyTarget: value => targets.push(value), setConfirmReplace() {}, setNotice: value => notices.push(value), setError: value => errors.push(value), refreshAfterWrite: async () => {}, ...changes };
    await compile(handler, context)(event); return { calls, messages, targets, notices, errors };
  }
  const dm = await run(); assert.deepEqual(dm.calls[0], ['conversations/opaque%2Fthread%20%3F/reply', { accountId: 'account', message: 'Hello there', messageTag: 'HUMAN_AGENT' }]); assert.deepEqual(dm.messages, ['']);
  const file = await run({ account: { platform: 'whatsapp' }, message: '', messageTag: '', attachmentUrl: 'https://cdn.example.com/file.pdf', attachmentType: 'file', attachmentName: 'receipt.pdf' }); assert.equal(file.calls[0][1].attachmentName, 'receipt.pdf');
  for (const changes of [{ account: { platform: 'instagram' }, attachmentType: 'file' }, { account: { platform: 'whatsapp' }, attachmentType: 'image' }]) assert.equal((await run({ message: '', messageTag: '', attachmentUrl: 'https://cdn.example.com/file', attachmentName: 'hidden-name.pdf', ...changes })).calls[0][1].attachmentName, undefined, 'Hidden filenames cannot leak into unsupported reply payloads.');
  const oversized = await run({ messageLimit: 10 }); assert.equal(oversized.calls.length, 0); assert.match(oversized.errors[0], /10 characters/); assert.deepEqual(oversized.messages, []);
  const tiktok = await run({ attachmentUrl: 'https://cdn.example.com/image.jpg', messageLimit: 0 }); assert.equal(tiktok.calls.length, 0); assert.match(tiktok.errors[0], /without text/);
  const partial = await run({ account: { platform: 'instagram' }, attachmentUrl: 'https://cdn.example.com/accepted.jpg', write: async () => ({ partialFailure: { part: 'text', error: 'Text rejected' }, warnings: [{ message: 'Text was not delivered' }] }) }); assert.match(partial.notices[0], /text was not sent/); assert.equal(partial.errors[0], 'Text was not delivered'); assert.deepEqual(partial.messages, [], 'A confirmed attachment must not erase the unsent text draft.');
  const comment = await run({ tab: 'comments', selected: { id: 'post' }, replyTarget: { id: 'comment' } }); assert.deepEqual(comment.calls[0], ['comments/reply', { accountId: 'account', postId: 'post', commentId: 'comment', message: 'Hello there' }]);
  const review = { id: 'review', reply: { text: 'Old' }, replyVersion: 'current-reply-hash' };
  assert.equal((await run({ tab: 'reviews', replyTarget: review })).calls.length, 0);
  const approved = await run({ tab: 'reviews', replyTarget: review, confirmReplace: true }); assert.equal(approved.calls[0][1].expectedReplyVersion, review.replyVersion); assert.equal(approved.calls[0][1].confirmReplace, true);
  for (const changes of [{ readOnly: true }, { canReply: false }, { message: '' }, { selected: null }]) assert.equal((await run(changes)).calls.length, 0);
  const cleared = []; await assert.rejects(run({ write: async () => { throw new Error('Reply window closed'); }, setMessage: value => cleared.push(value) }), /window closed/); assert.deepEqual(cleared, []);
  assert.deepEqual((await run({ version: { current: 2 } })).messages, [], 'An old project response must not clear the next project’s draft.');
});

test('actual list and thread loaders preserve opaque IDs, account scope and pagination without accepting stale project responses', async () => {
  const calls = [], state = { rows: [{ id: 'one', text: 'old' }] }, version = { current: 1 };
  const context = { historyFilter: null, folder: 'inbox', tab: 'messages', accountId: 'account/a', conversationStatus: 'archived', requester: { current: async url => { calls.push(url); return { conversations: [{ id: 'one', text: 'fresh' }, { id: 'two' }], pagination: { hasMore: false }, meta: {} }; } }, path, version, merge, setRows: value => { state.rows = typeof value === 'function' ? value(state.rows) : value; }, setPagination() {}, setMeta() {}, setLoaded() {} };
  const list = compile(section('async function fetchList(', '  async function loadList('), context);
  await list(1, 'opaque + cursor'); const query = new URL(calls[0], 'https://app.example').searchParams;
  assert.equal(query.get('accountId'), 'account/a'); assert.equal(query.get('status'), 'archived'); assert.equal(query.get('cursor'), 'opaque + cursor'); assert.deepEqual(state.rows, [{ id: 'one', text: 'fresh' }, { id: 'two' }]);
  version.current = 2; await list(1); assert.equal(state.rows.length, 2);
  const threads = [], details = []; const thread = compile(section('async function fetchThread(', '  async function openItem('), { tab: 'comments', accountId: 'account/a', requester: { current: async url => { threads.push(url); return { comments: [{ id: 'new' }], parent: { id: 'parent' }, pagination: {} }; } }, path, version, merge, setSelected() {}, setFocusedComment() {}, setDetail: update => details.push(update({ comments: [{ id: 'old' }] })) });
  await thread({ id: 'urn:li:share:123/opaque' }, 2, 'next', 'comment/parent'); const threadQuery = new URL(threads[0], 'https://app.example').searchParams;
  assert.equal(threadQuery.get('postId'), 'urn:li:share:123/opaque'); assert.equal(threadQuery.get('commentId'), 'comment/parent'); assert.deepEqual(details[0].comments.map(item => item.id), ['old', 'new']);
});

test('review filters stay on first pages, pagination, manual loads and provider refreshes while stale scope results are ignored', async () => {
  const calls = [], state = { rows: [], pagination: null }, version = { current: 1 }, reviewFilters = { minRating: '2', maxRating: '4', hasReply: 'false', sortBy: 'rating', sortOrder: 'asc' };
  const context = { tab: 'reviews', accountId: 'gb/account', reviewFilters, historyFilter: null, path, version, merge, pending: { current: false }, requester: { current: async url => { calls.push(url); return { reviews: [{ id: calls.length === 2 ? 'next-review' : 'first-review' }], pagination: { hasMore: true, nextCursor: 'next +/cursor' } }; } }, setRows: update => { state.rows = typeof update === 'function' ? update(state.rows) : update; }, setPagination: value => { state.pagination = value; }, setMeta() {}, setLoaded() {}, setHistoryFilter() {}, resetSelection() {}, switchSelection: change => change(), action: async (_, run) => run(version.current) };
  const list = (...args) => compile(section('async function fetchList(', '  async function loadList('), context)(...args);
  context.fetchList = list;
  await list(1); await list(1, 'next +/cursor'); assert.deepEqual(state.rows.map(row => row.id), ['first-review', 'next-review']);
  await compile(section('async function loadList(', '  async function fetchThread('), context)('', true);
  await compile(section('async function refreshAfterWrite(', '  function prepareReply('), { ...context, setError: assert.fail })(1);
  const poll = section('const poll = async () =>', '    void poll();').replace('const poll = ', '').trim().replace(/;$/, '');
  await compile(poll, { ...context, revision: { current: 0 }, checking: false, closed: false, generation: 1, cursor: undefined, loaded: true, selected: null, focusedComment: '', setNotice() {}, requester: { current: async () => ({ cursor: 1, updates: [{ event: 'review.updated' }] }) } })();
  assert.equal(calls.length, 5);
  for (const [index, url] of calls.entries()) assert.deepEqual(Object.fromEntries(new URL(url, 'https://app.example').searchParams), { accountId: 'gb/account', ...reviewFilters, ...(index === 1 ? { cursor: 'next +/cursor' } : {}) });
  context.reviewFilters = {}; await list(1); assert.deepEqual(Object.fromEntries(new URL(calls.at(-1), 'https://app.example').searchParams), { accountId: 'gb/account' });
  const before = structuredClone(state); let finish;
  context.requester.current = async () => new Promise(resolve => { finish = resolve; });
  const earlier = list(1, 'old-cursor'); version.current++; context.accountId = 'different-account'; context.reviewFilters = { hasReply: 'true' };
  finish({ reviews: [{ id: 'obsolete-account-or-filter' }], pagination: { hasMore: false } }); await earlier; assert.deepEqual(state, before);
  assert.ok(source.includes('loaded, historyFilter, reviewFilters, readOnly]'), 'Webhook refresh closures follow the active review filters.');
});

test('approved WhatsApp reply templates use their exact account/language and exclude free text or attachment drafts', async () => {
  const calls = [], notices = [], errors = [], resets = [], selectedTemplate = { name: 'service_update', language: 'en_GB' }, templateComponents = [{ type: 'body', parameters: [{ type: 'text', text: 'Jordan' }] }];
  const context = { replyButtons: [], retainedButtonReply: null, buttonScopeKey: 'legacy', buttonGeneration: 0, buttonScope: { current: { key: 'legacy', generation: 0 } }, readOnly: false, canReply: true, account: { platform: 'whatsapp' }, templateMode: true, selectedTemplate, templateComponents, templateRestriction: () => '', message: 'Preserved text draft', attachmentUrl: 'https://example.com/file.pdf', attachmentType: 'file', attachmentName: 'draft.pdf', messageLimit: 0, messageTag: 'HUMAN_AGENT', accountId: 'whatsapp-account', tab: 'messages', selected: { id: 'closed/thread' }, replyTarget: null, confirmReplace: false, action: async (_, run) => run(1), write: async (...args) => { calls.push(args); return { sent: true }; }, version: { current: 1 }, setMessage() {}, setAttachmentUrl() {}, setAttachmentName() {}, setAttachmentPreview() {}, setAttachmentType() {}, setMessageTag() {}, setReplyTarget() {}, setConfirmReplace() {}, resetTemplate: () => resets.push(true), setNotice: value => notices.push(value), setError: value => errors.push(value), refreshAfterWrite: async () => {} };
  const reply = changes => compile(section('async function reply(', '  async function conversationAction('), { ...context, ...changes })(event);
  await reply(); assert.deepEqual(calls[0], ['conversations/closed%2Fthread/reply', { accountId: 'whatsapp-account', templateName: 'service_update', templateLanguage: 'en_GB', templateComponents }]); assert.match(notices[0], /accepted/); assert.equal(resets.length, 1);
  await reply({ selectedTemplate: null }); await reply({ templateRestriction: () => 'Unsupported' }); await reply({ readOnly: true }); assert.equal(calls.length, 1); assert.equal(errors.length, 2);
  await assert.rejects(reply({ write: async () => { throw new Error('Outcome uncertain'); } }), /uncertain/); assert.equal(resets.length, 1, 'A rejected/uncertain send preserves the selected template and parameter draft.');
  await reply({ version: { current: 2 } }); assert.equal(resets.length, 1, 'A stale reply cannot clear another project draft.');
});

test('reply template loading keeps only approved scoped definitions and ignores stale account responses', async () => {
  const calls = [], templates = [], notices = [], version = { current: 1 }, context = { readOnly: false, account: { platform: 'whatsapp' }, accountId: 'account/one', selected: { id: 'thread' }, projectId: 'project/one', action: async (_, run) => run(1), requester: { current: async path => { calls.push(path); return { templates: [{ name: 'ready', status: 'APPROVED' }, { name: 'draft', status: 'PENDING' }] }; } }, version, setTemplates: value => templates.push(value), setTemplateKey() {}, setTemplateComponents() {}, setNotice: value => notices.push(value) };
  const load = changes => compile(section('async function loadReplyTemplates(', '  async function reply('), { ...context, ...changes })();
  await load(); assert.equal(calls[0], '/projects/project%2Fone/direct/templates?accountId=account%2Fone'); assert.deepEqual(templates[0], [{ name: 'ready', status: 'APPROVED' }]);
  version.current = 2; await load(); assert.equal(templates.length, 1); await load({ readOnly: true }); await load({ account: { platform: 'facebook' } }); assert.equal(calls.length, 2);
});

test('read/archive are explicit writes and destructive public changes require confirmation', async () => {
  const calls = [], rows = [], selected = { id: 'thread/opaque', status: 'active', unreadCount: 2 };
  const context = { selected, readOnly: false, conversationStatus: 'active', historyFilter: null, accountId: 'account', version: { current: 1 }, action: async (_, run) => run(1), write: async (...args) => calls.push(args), setSelected() {}, setRows: update => rows.push(update([selected])), setNotice() {} };
  const change = compile(section('async function conversationAction(', '  async function sendTyping('), context);
  await change('read'); assert.deepEqual(calls[0], ['conversations/thread%2Fopaque/read', { accountId: 'account' }]); assert.equal(rows[0][0].unreadCount, 0);
  await change('status'); assert.deepEqual(calls[1][1], { accountId: 'account', status: 'archived' }); assert.deepEqual(rows[1], []);
  const reopened = [], archiveContext = { ...context, selected: { ...selected, status: 'archived' }, setRows: update => reopened.push(update([])) };
  await compile(section('async function conversationAction(', '  async function sendTyping('), archiveContext)('status'); assert.equal(reopened[0][0].id, selected.id); assert.equal(reopened[0][0].status, 'active');
  const readArchived = []; await compile(section('async function conversationAction(', '  async function sendTyping('), { ...archiveContext, setRows: update => readArchived.push(update([])) })('read'); assert.deepEqual(readArchived[0], [], 'Marking the archived selected thread read must not insert it into the active list.');
  const comment = compile(section('async function commentAction(', '  async function deleteReviewReply('), { ...context, commentScope: { current: { generation: 1, rows: [{ id: 'comment' }], readOnly: false } }, commentGeneration: 1, refreshAfterWrite: async () => {} });
  const remove = compile(section('async function deleteReviewReply(', '  function commentMessage('), { ...context, setReplyTarget() {}, setMessage() {}, refreshAfterWrite: async () => {} });
  // Delete, hide and review-reply removal buttons only open the confirmation dialog; its confirm action performs the write.
  assert.doesNotMatch(source, /onClick=\{\(\) => (commentAction\('(delete|hide)'|deleteReviewReply\()/); assert.match(source, /onClick=\{\(\) => setConfirming\(\{ kind: 'delete', comment: item \}\)\}/); assert.match(source, /: setConfirming\(\{ kind: 'hide', comment: item \}\)/); assert.match(source, /onClick=\{\(\) => setConfirming\(\{ kind: 'review', review: item \}\)\}/);
  const dialogStart = source.indexOf('onConfirm={() => confirming?.kind') + 'onConfirm={'.length, dialogConfirm = source.slice(dialogStart, source.indexOf('}/>', dialogStart));
  const confirmWith = confirming => compile(dialogConfirm, { confirming, commentAction: comment, deleteReviewReply: remove })();
  await confirmWith(null); assert.equal(calls.length, 4, 'Nothing is written until the confirmation is accepted.');
  await confirmWith({ kind: 'delete', comment: { id: 'comment' } }); assert.deepEqual(calls[4], ['comments/delete', { accountId: 'account', postId: selected.id, commentId: 'comment' }]);
  await confirmWith({ kind: 'review', review: { id: 'review', replyVersion: 'version' } }); assert.deepEqual(calls[5], ['reviews/delete-reply', { accountId: 'account', reviewId: 'review', expectedReplyVersion: 'version', confirmReplace: true }]);
});

test('history search retains matching conversations after mark-read, archive and reopen', async () => {
  for (const [kind, status, expectedStatus] of [['read', 'archived', 'archived'], ['status', 'active', 'archived'], ['status', 'archived', 'active']]) {
    const selected = { id: 'archived-hit', status, unreadCount: 2, matches: [{ text: 'old invoice' }] }, other = { id: 'other-hit' };
    let rows = [selected, other];
    const context = { selected, readOnly: false, conversationStatus: 'active', historyFilter: { query: 'old invoice' }, accountId: 'account', version: { current: 1 }, action: async (_, run) => run(1), write: async () => {}, setSelected() {}, setRows: update => { rows = update(rows); }, setNotice() {} };
    await compile(section('async function conversationAction(', '  async function sendTyping('), context)(kind);
    assert.deepEqual(rows, [{ ...selected, status: expectedStatus, unreadCount: kind === 'read' ? 0 : 2 }, other], `${kind} on ${status} retains the history hit and its matching message`);
  }
});

test('private reply limits follow account capabilities and attachment caption restrictions', () => {
  const limit = compile(section('function privateMessageLimit(', 'function Attachment('));
  assert.equal(limit({ messageLimit: 1000 }, 'instagram', ''), 1000);
  assert.equal(limit({ messageLimit: 40000 }, 'slack', ''), 40000);
  assert.equal(limit({ messageLimit: 4096 }, 'whatsapp', 'https://cdn.example.com/file'), 1024);
  assert.equal(limit({ messageLimit: 4096 }, 'telegram', 'https://cdn.example.com/file'), 1024);
  assert.equal(limit({ messageLimit: 6000 }, 'tiktok', 'https://cdn.example.com/image'), 0);
  assert.equal(limit({ messageLimit: 6000 }, 'tiktok', ''), 6000);
});

test('thread refresh preserves an unfinished reply and post-write read failures never claim the confirmed write failed', async () => {
  const cleared = [], selected = { id: 'thread' }, errors = [];
  const context = { selected, focusedComment: '', tab: 'messages', switchSelection: change => change(), version: { current: 1 }, action: async (_, run) => run(1), fetchThread: async () => {}, resetTemplate() {}, setReplyButtons() {}, setButtonReview() {}, setReplyTarget() {}, setPrivateReplyTarget() {}, setCommentEdit() {}, setMessage: value => cleared.push(value), setConfirmReplace() {}, setMessageTag() {}, setAttachmentUrl() {}, setAttachmentName() {}, setAttachmentPreview() {}, setAttachmentType() {}, setMessageActionTarget() {}, setControlAction() {}, setTargetAppId() {}, setControlNote() {}, setConfirmControl() {}, setConfirmAccept() {} };
  const open = compile(section('async function openItem(', '  async function refreshAfterWrite('), context);
  await open(selected); assert.deepEqual(cleared, []); await open({ id: 'different-thread' }); assert.deepEqual(cleared, ['']);
  const refresh = compile(section('async function refreshAfterWrite(', '  function prepareReply('), { tab: 'messages', selected, focusedComment: '', version: { current: 1 }, fetchThread: async () => { throw new Error('Provider read failed'); }, setError: value => errors.push(value) });
  await refresh(1); assert.match(errors[0], /change was confirmed/);
});

test('webhook polling reads only the local update feed until new relevant activity arrives', async () => {
  const handler = section('const poll = async () =>', '    void poll();').replace('const poll = ', '').trim().replace(/;$/, ''), calls = [], refreshed = [];
  const responses = [{ updates: [], cursor: 8 }, { updates: [{ event: 'comment.received' }], cursor: 9 }, { updates: [{ event: 'message.received' }], cursor: 10 }];
  const context = { revision: { current: 0 }, checking: false, pending: { current: false }, requester: { current: async url => { calls.push(url); return responses.shift(); } }, path, accountId: 'account', cursor: undefined, closed: false, generation: 1, version: { current: 1 }, tab: 'messages', loaded: true, selected: { id: 'thread' }, focusedComment: '', action: async (_, run) => run(1), fetchList: async () => refreshed.push('list'), fetchThread: async () => refreshed.push('thread'), setNotice() {} };
  const poll = compile(handler, context); await poll(); await poll(); assert.deepEqual(refreshed, []); await poll(); assert.deepEqual(refreshed, ['list', 'thread']);
  assert.equal(new URL(calls[0], 'https://app.example').searchParams.has('after'), false); assert.equal(new URL(calls[1], 'https://app.example').searchParams.get('after'), '8'); assert.ok(calls.every(url => url.startsWith(path + '/updates?')));
  await compile(handler, { ...context, pending: { current: true } })(); assert.equal(calls.length, 3);
});

test('the actual action lock rejects double clicks and stale operation results do not alter a new project', async () => {
  const pending = { current: false }, version = { current: 1 }, busy = [], errors = [];
  const action = compile(section('async function action(', '  async function write('), { pending, version, revision: { current: 0 }, setBusy: value => busy.push(value), setError: value => errors.push(value), setNotice() {} });
  let finish, sends = 0; const first = action('Replying', async () => { sends++; await new Promise(resolve => { finish = resolve; }); }); await action('Reply again', async () => { sends++; }); assert.equal(sends, 1);
  version.current = 2; finish(); await first; assert.deepEqual(busy, ['Replying']); assert.deepEqual(errors, ['']);
});

test('SMS replies bind the selected conversation, block opted-out/viewer sends and reuse uncertain operation keys', async () => {
  const handler = section('async function sendSms(', '  return <Stack gap={4}>'), calls = [], messages = [], notices = [], keys = { current: new Map() }, selected = { id: 'sms-thread', participantId: '+971501234567', sender: '+12025550123' };
  const context = { readOnly: false, selected, blocked: false, status: { configured: true }, message: 'Your order is ready', setError() {}, path: '/projects/a/sms-inbox', smsAction: async (_, run) => run(1), keys, crypto, requester: { current: async (...args) => { calls.push(args); return { sent: true, conversation: selected, message: { id: 'outgoing', message: 'Your order is ready', direction: 'outgoing' } }; } }, version: { current: 1 }, setMessage: value => messages.push(value), setSelected() {}, setDetail() {}, setRows() {}, setNotice: value => notices.push(value), merge };
  for (const changes of [{ readOnly: true }, { blocked: true }, { status: { configured: false } }, { message: '' }, { selected: null }]) await compile(handler, { ...context, ...changes })(event);
  assert.equal(calls.length, 0);
  const failure = Object.assign(new Error('Outcome uncertain'), { status: 409, code: 'OPERATION_UNCERTAIN' });
  await assert.rejects(compile(handler, { ...context, requester: { current: async (...args) => { calls.push(args); throw failure; } } })(event), /uncertain/); assert.deepEqual(messages, []);
  await compile(handler, context)(event); assert.equal(calls[0][3], calls[1][3]); assert.deepEqual(calls[1].slice(0, 3), ['/projects/a/sms-inbox/conversations/sms-thread/reply', 'POST', { message: 'Your order is ready' }]); assert.deepEqual(messages, ['']); assert.match(notices[0], /accepted by Twilio/); assert.equal(keys.current.size, 0);
  await compile(handler, { ...context, version: { current: 2 } })(event); assert.deepEqual(messages, [''], 'An old project reply must not clear another project’s message.');
});

test('SMS polling reads local data only and applies fresh STOP state without discarding older loaded conversations', async () => {
  const handler = section('const pollSms = async () =>', '    const timer = window.setInterval(pollSms').replace('const pollSms = ', '').trim().replace(/;$/, '');
  const calls = [], states = [], current = [{ id: 'one', blocked: false }, { id: 'older', lastMessageAt: '2025-01-01' }], context = { rows: current, checking: false, pending: { current: false }, revision: { current: 0 }, requester: { current: async (...args) => { calls.push(args); return args[0].endsWith('/messages') ? { conversation: { id: 'one', blocked: true }, messages: [] } : { conversations: [{ id: 'one', blocked: true, lastMessageAt: '2030-01-01' }], pagination: {} }; } }, path: '/projects/a/sms-inbox', selected: { id: 'one' }, closed: false, generation: 1, version: { current: 1 }, merge, setRows: update => states.push(update(current)), setPagination() {}, setSelected: value => states.push(value), setDetail() {} };
  await compile(handler, context)(); assert.equal(states[0][0].blocked, true); assert.equal(states[0][1].id, 'older'); assert.equal(states[1].blocked, true); assert.ok(calls.every(args => args.length === 1 && args[0].startsWith('/projects/a/sms-inbox/')));
});

test('campaign WhatsApp navigation loads only its explicit scoped account and never guesses a recipient thread', async () => {
  const marker = 'requester.current(path + \'/status\').then(', start = source.indexOf(marker, source.indexOf('function ZernioInbox(')) + marker.length;
  const handler = source.slice(start, source.indexOf(').catch(failure', start));
  const calls = [], rows = [], errors = [], searches = [], context = { generation: 1, version: { current: 1 }, setStatus() {}, setAccounts() {}, tab: 'messages', initialChannel: 'whatsapp', initialAccountId: 'campaign-account', initialSearch: '+971501234567', setPlatform() {}, setSearch: value => searches.push(value), setError: value => errors.push(value), setAccountId() {}, requester: { current: async url => { calls.push(url); return { conversations: [{ id: 'user-selected-later', participantId: '971501234567' }], pagination: {} }; } }, path, setRows: value => rows.push(value), setPagination() {}, setMeta() {}, setLoaded() {} };
  const accounts = [{ id: 'other', platform: 'whatsapp', capabilities: { messages: true } }, { id: 'campaign-account', platform: 'whatsapp', capabilities: { messages: true } }];
  await compile(handler, context)({ accounts }); assert.equal(new URL(calls[0], 'https://app.example').searchParams.get('accountId'), 'campaign-account'); assert.deepEqual(searches, ['+971501234567']); assert.equal(rows[0][0].id, 'user-selected-later');
  await compile(handler, { ...context, initialAccountId: 'unavailable' })({ accounts }); assert.equal(calls.length, 1); assert.match(errors[0], /unavailable/);
  const match = compile(section('function conversationMatches(', 'function SmsInbox(')); assert.equal(match({ participantId: '971501234567' }, '+971501234567'), true); assert.equal(match({ participantId: 'BSUID.opaque' }, '+971501234567'), false);
});

test('a failed SMS thread selection keeps the current poll alive while rejecting reads from before the selection', async () => {
  const smsSource = source.slice(source.indexOf('function SmsInbox('), source.indexOf('export default function UnifiedInbox('));
  const part = (start, end) => smsSource.slice(smsSource.indexOf(start), smsSource.indexOf(end, smsSource.indexOf(start)));
  const version = { current: 1 }, pending = { current: false }, revision = { current: 0 }, selected = { id: 'current-thread' }, accepted = [], errors = [];
  let oldResolve; const oldRead = new Promise(resolve => { oldResolve = resolve; }); let firstPoll = true;
  const requester = { current: async route => {
    if (route.includes('/unavailable-thread/')) throw new Error('Transient thread failure');
    if (route.endsWith('/conversations')) { if (firstPoll) { firstPoll = false; return oldRead; } return { conversations: [{ ...selected, blocked: true }], pagination: {} }; }
    return { conversation: { ...selected, blocked: true }, messages: [] };
  } };
  const common = { rows: [selected], version, pending, revision, selected, requester, path: '/projects/p/sms-inbox', setRows() {}, setPagination() {}, setSelected: value => accepted.push(value), setDetail() {}, setMessage() {}, merge };
  const smsAction = compile(part('async function smsAction(', '  async function smsList('), { ...common, setBusy() {}, setError: value => errors.push(value), setNotice() {} });
  const smsThread = compile(part('async function smsThread(', '  async function openSms('), common);
  const open = compile(part('async function openSms(', '  useEffect(() => {'), { ...common, smsAction, smsThread, onSwitch: change => change() });
  const polling = part('const pollSms = async () =>', '    const timer = window.setInterval(pollSms').replace('const pollSms = ', '').trim().replace(/;$/, '');
  const poll = compile(polling, { ...common, generation: 1, checking: false, closed: false });
  const earlier = poll(); await open({ id: 'unavailable-thread' }); oldResolve({ conversations: [{ ...selected, blocked: false }], pagination: {} }); await earlier;
  assert.deepEqual(accepted, [], 'A poll started before the selection must not overwrite a later action.'); assert.equal(pending.current, false); assert.match(errors.at(-1), /Transient/);
  await poll(); assert.equal(accepted.at(-1)?.blocked, true, 'A later STOP or message must still update the currently selected thread after the failed selection.');
});

test('SMS polling retains the oldest loaded page cursors while updating messages and opt-outs', async () => {
  const handler = section('const pollSms = async () =>', '    const timer = window.setInterval(pollSms').replace('const pollSms = ', '').trim().replace(/;$/, '');
  let pagination = { hasMore: true, nextCursor: '100' }, detail = { messages: [{ id: 'older' }, { id: 'overlap' }], pagination: { hasMore: true, nextCursor: '101' } };
  const context = { rows: [{ id: 'thread' }], checking: false, pending: { current: false }, revision: { current: 0 }, path: '/projects/a/sms-inbox', selected: { id: 'thread' }, closed: false, generation: 1, version: { current: 1 }, merge, setRows() {}, setSelected() {},
    setPagination: update => { pagination = typeof update === 'function' ? update(pagination) : update; }, setDetail: update => { detail = update(detail); },
    requester: { current: async path => path.endsWith('/messages') ? { conversation: { id: 'thread', blocked: true }, messages: [{ id: 'newest' }, { id: 'overlap' }], pagination: { hasMore: true, nextCursor: '201' } } : { conversations: [{ id: 'thread' }], pagination: { hasMore: true, nextCursor: '200' } } },
  };
  await compile(handler, context)();
  assert.equal(pagination.nextCursor, '100', 'Polling must not send Load older conversations back to page two.');
  assert.equal(detail.pagination.nextCursor, '101', 'Polling must not send Load older messages back to page two.');
  assert.deepEqual(detail.messages.map(item => item.id), ['older', 'overlap', 'newest']); assert.equal(detail.conversation.blocked, true);
  for (const hasMore of [true, false]) {
    pagination = { hasMore, nextCursor: hasMore ? '1' : null }; detail = { messages: [{ id: 'old-tail' }], pagination: { ...pagination } }; context.rows = [{ id: 'old-tail' }];
    const messages = context.requester.current;
    context.requester = { current: async path => path.endsWith('/messages') ? messages(path) : { conversations: [{ id: 'old-tail', lastMessageAt: '2030-01-01' }, { id: 'new-head' }], pagination: { hasMore: true, nextCursor: '200' } } };
    await compile(handler, context)();
    assert.equal(pagination.nextCursor, '200', 'New conversations remain reachable even when a known conversation moves to the newest page.');
    assert.equal(detail.pagination.nextCursor, '201', 'A burst without overlap must expose the gap before older loaded messages.');
  }
});


function selectionGuard(snapshot = 'draft') {
  const context = { draft: { current: snapshot }, switching: { current: false }, pendingSwitch: null, props: {}, setSwitchBusy() {}, setPendingSwitch: value => { context.pendingSwitch = value; } };
  for (const [name, next] of [['reportDraft', 'requestSwitch'], ['requestSwitch', 'keepEditing'], ['keepEditing', 'discardAndSwitch']]) context[name] = (...args) => compile(section(`function ${name}(`, `  function ${next}(`), context)(...args);
  context.discardAndSwitch = () => compile(section('function discardAndSwitch(', '  const draftChanged ='), context)();
  return context;
}

test('actual selection guard defers all work, keeps editing, rejects edited snapshots and blocks busy switches', async () => {
  const guard = selectionGuard(), changed = [];
  await guard.requestSwitch(() => changed.push('first')); assert.deepEqual(changed, []);
  guard.keepEditing(); await guard.discardAndSwitch(); assert.deepEqual(changed, []);
  await guard.requestSwitch(() => changed.push('obsolete'));
  guard.reportDraft('edited draft'); await guard.discardAndSwitch(); assert.deepEqual(changed, []);
  await guard.requestSwitch(() => changed.push('latest')); await guard.discardAndSwitch(); assert.deepEqual(changed, ['latest']);
  guard.reportDraft('edited draft', true); await guard.requestSwitch(() => changed.push('busy')); await guard.discardAndSwitch(); assert.deepEqual(changed, ['latest']);
  guard.reportDraft(''); await guard.requestSwitch(() => changed.push('clean')); assert.deepEqual(changed, ['latest', 'clean']);
});

test('dirty conversation switches preserve attachment and options until a confirmed successful read, and reject a stale scope', async () => {
  const guard = selectionGuard(), version = { current: 1 }, pending = { current: false }, selected = { id: 'current' }, reads = [], cleared = [];
  const draft = { replyButtons: ['Yes', 'No'], buttonReview: 'approved-old-thread', message: 'Unsent reply', attachmentUrl: 'https://example.test/voice.mp3', attachmentType: 'audio', attachmentName: 'voice', messageTag: 'HUMAN_AGENT', templateMode: true, templateComponents: [{ type: 'body', parameters: [] }] };
  const context = { selected, focusedComment: '', tab: 'messages', version, pending, onSwitch: guard.requestSwitch, action: async (_, run) => run(version.current), fetchThread: async item => { reads.push(item.id); }, resetTemplate: () => cleared.push('template'), setReplyButtons: value => { draft.replyButtons = value; }, setButtonReview: value => { draft.buttonReview = value; }, setReplyTarget() {}, setPrivateReplyTarget() {}, setCommentEdit() {}, setMessage: value => { cleared.push('message'); draft.message = value; }, setConfirmReplace() {}, setMessageTag: value => { draft.messageTag = value; }, setAttachmentUrl: value => { draft.attachmentUrl = value; }, setAttachmentName: value => { draft.attachmentName = value; }, setAttachmentType: value => { draft.attachmentType = value; }, setAttachmentPreview() {}, setMessageActionTarget() {}, setControlAction() {}, setTargetAppId() {}, setControlNote() {}, setConfirmControl() {}, setConfirmAccept() {} };
  context.switchSelection = change => compile(section('function switchSelection(', '  function resetTemplate('), context)(change);
  const open = changes => compile(section('async function openItem(', '  async function refreshAfterWrite('), { ...context, ...changes });
  const original = structuredClone(draft);
  await open()({ id: 'next' }); assert.deepEqual(reads, []); assert.deepEqual(draft, original);
  guard.keepEditing(); await guard.discardAndSwitch(); assert.deepEqual(reads, []); assert.deepEqual(draft, original);
  await open()({ id: 'next' }); version.current++; await guard.discardAndSwitch(); assert.deepEqual(reads, []); assert.deepEqual(draft, original);
  await open({ fetchThread: async () => { throw new Error('Read failed'); } })({ id: 'next' }); await assert.rejects(guard.discardAndSwitch(), /Read failed/); assert.deepEqual(draft, original);
  await open()({ id: 'next' }); await guard.discardAndSwitch(); assert.deepEqual(reads, ['next']); assert.deepEqual(draft.replyButtons, []); assert.equal(draft.buttonReview, ''); assert.equal(draft.message, ''); assert.equal(draft.attachmentUrl, ''); assert.equal(draft.attachmentName, ''); assert.equal(draft.attachmentType, 'image'); assert.equal(draft.messageTag, ''); assert.deepEqual(cleared, ['message', 'template']);
  draft.replyButtons = ['Keep on same thread']; draft.buttonReview = 'same-thread-approval'; cleared.length = 0; await open()(selected); await open()(selected, 'older'); assert.deepEqual(cleared, [], 'Refreshing and paging the current thread retain its draft.'); assert.deepEqual(draft.replyButtons, ['Keep on same thread']); assert.equal(draft.buttonReview, 'same-thread-approval');
});

test('actual account and feed handlers preserve their current selection until explicit discard', async () => {
  const guard = selectionGuard(), changes = [], version = { current: 1 }, pending = { current: false };
  const context = { accountId: 'account-a', version, pending, onSwitch: guard.requestSwitch, resetList: () => { changes.push('reset'); version.current++; }, setAccountId: value => changes.push(value) };
  context.switchSelection = change => compile(section('function switchSelection(', '  function resetTemplate('), context)(change);
  const start = source.indexOf('<Field label="Connected account">'), handlerStart = source.indexOf('onChange={', start) + 'onChange={'.length;
  const change = compile(source.slice(handlerStart, source.indexOf('}><Option', handlerStart)), context), selectionEvent = { target: { value: 'account-b' } };
  change(selectionEvent); selectionEvent.target.value = 'account-c'; assert.deepEqual(changes, []);
  guard.keepEditing(); await guard.discardAndSwitch(); assert.deepEqual(changes, []);
  change({ target: { value: 'account-b' } }); await guard.discardAndSwitch(); assert.deepEqual(changes, ['reset', 'account-b'], 'Deferred selection captures the chosen account, never a later event value.');
  const feedStart = source.indexOf('onValueChange={item => { if (tab !== item)'), feedHandler = source.slice(feedStart + 'onValueChange={'.length, source.indexOf('} items={', feedStart));
  const feed = compile(feedHandler, { tab: 'messages', requestSwitch: guard.requestSwitch, reportDraft: guard.reportDraft, setTab: value => changes.push(value) });
  feed('sms'); assert.deepEqual(changes, ['reset', 'account-b']); await guard.discardAndSwitch(); assert.deepEqual(changes, ['reset', 'account-b', 'sms']); assert.equal(guard.draft.current, '');
});

test('native review filters capture deferred choices and preserve pending replies until the current draft is discarded', async () => {
  const guard = selectionGuard(), version = { current: 1 }, pending = { current: false }, changes = [], context = { reviewFilters: { minRating: '2', maxRating: '4' }, version, pending, onSwitch: guard.requestSwitch, resetList: () => { changes.push('reset'); version.current++; }, setReviewFilters: filters => { context.reviewFilters = filters; changes.push(filters); } };
  context.switchSelection = change => compile(section('function switchSelection(', '  function resetTemplate('), context)(change);
  const change = (...args) => compile(section('function changeReviewFilter(', '  useEffect(() => {'), context)(...args);
  const start = source.indexOf("onChange={event => changeReviewFilter('hasReply',"), handlerStart = start + 'onChange={'.length;
  const select = compile(source.slice(handlerStart, source.indexOf('}', handlerStart)), { changeReviewFilter: change }), selectionEvent = { target: { value: 'false' } };
  select(selectionEvent); selectionEvent.target.value = 'true'; assert.deepEqual(changes, []); assert.ok(guard.pendingSwitch);
  guard.keepEditing(); await guard.discardAndSwitch(); assert.deepEqual(changes, []);
  select({ target: { value: 'false' } }); guard.reportDraft('An edited reply'); await guard.discardAndSwitch(); assert.deepEqual(changes, []);
  select({ target: { value: 'false' } }); version.current++; await guard.discardAndSwitch(); assert.deepEqual(changes, [], 'An obsolete account cannot apply a deferred filter.');
  selectionEvent.target.value = 'false'; select(selectionEvent); selectionEvent.target.value = 'true'; await guard.discardAndSwitch();
  assert.deepEqual(changes, ['reset', { minRating: '2', maxRating: '4', hasReply: 'false' }]);
  changes.length = 0; pending.current = true; change('sortBy', 'rating'); assert.deepEqual(changes, []); pending.current = false;
  guard.reportDraft(''); await change('minRating', ''); assert.deepEqual(context.reviewFilters, { maxRating: '4', hasReply: 'false' });
  const controlsStart = source.indexOf('<Stack as="section" aria-label="Review filters"'), controls = source.slice(controlsStart, source.indexOf('</Stack>', controlsStart) + '</Stack>'.length);
  const { code } = await transformWithOxc('function ReviewFilters() { return (' + controls + '); }', 'ReviewFilters.tsx', { jsx: { runtime: 'classic' } });
  const render = new Function('React', ...uiNames, 'reviewFilters', 'busy', 'changeReviewFilter', code + '; return ReviewFilters;')(React, ...uiValues, { minRating: '2', maxRating: '4', hasReply: 'false' }, '', () => {}), html = renderToStaticMarkup(React.createElement(render));
  assert.equal((html.match(/<select/g) || []).length, 5); assert.match(html, /value="false" selected="">Without a reply/); assert.match(html, /value="5" disabled=""/); assert.match(html, /value="1" disabled=""/);
  const summaryLine = source.split('\n').find(line => line.includes('<AppliedFilters filters={appliedReviewFilters}')), summaryDeclaration = section('  const appliedReviewFilters =', '  const replyDraft =');
  const summaryCode = await transformWithOxc('function ReviewSummary() {' + summaryDeclaration + 'return (' + summaryLine.trim().slice(1, -1) + '); }', 'ReviewSummary.tsx', { jsx: { runtime: 'classic' } });
  function summary(reviewFilters, loaded = true, accountId = 'gb', tab = 'reviews') {
    const component = new Function('React', 'AppliedFilters', 'reviewFilters', 'loaded', 'accountId', 'tab', summaryCode.code + '; return ReviewSummary;')(React, AppliedFilters, reviewFilters, loaded, accountId, tab);
    return renderToStaticMarkup(React.createElement(component));
  }
  const applied = { minRating: '2', maxRating: '4', hasReply: 'false', sortBy: 'rating', sortOrder: 'asc' }, appliedHtml = summary(applied);
  assert.match(appliedHtml, /class="t98-applied-filters"/); assert.match(appliedHtml, /aria-label="Loaded review filters"/);
  for (const text of ['Minimum rating', '2/5', 'Maximum rating', '4/5', 'Without a reply', 'Review sort', 'Rating', 'Sort direction', 'Ascending']) assert.ok(appliedHtml.includes(text), text);
  assert.doesNotMatch(appliedHtml, /<button|With a reply|Clear all filters/); assert.match(summary({ hasReply: 'true' }), /With a reply/);
  for (const args of [[applied, false], [applied, true, ''], [applied, true, 'gb', 'comments'], [{}], [{ sortBy: 'date', sortOrder: 'desc' }]]) assert.equal(summary(...args), '', 'Only nondefault filters for loaded review results are labeled as applied.');
});

test('SMS selection waits for discard and cancels a deferred selection from an obsolete scope', async () => {
  const guard = selectionGuard(), version = { current: 1 }, reads = [], cleared = [], selected = { id: 'current' };
  const context = { selected, version, pending: { current: false }, onSwitch: guard.requestSwitch, smsAction: async (_, run) => run(version.current), smsThread: async item => reads.push(item.id), setMessage: value => cleared.push(value) };
  const open = compile(section('async function openSms(', '  useEffect(() => {'), context);
  await open({ id: 'next' }); assert.deepEqual(reads, []); guard.keepEditing(); await guard.discardAndSwitch(); assert.deepEqual(cleared, []);
  await open({ id: 'next' }); version.current++; await guard.discardAndSwitch(); assert.deepEqual(reads, []);
  const fresh = compile(section('async function openSms(', '  useEffect(() => {'), context); await fresh({ id: 'next' }); await guard.discardAndSwitch(); assert.deepEqual(reads, ['next']); assert.deepEqual(cleared, ['']);
});


test('the actual draft snapshot protects attachment-only and option-only drafts and invalidates reviewed changes', async () => {
  const context = { replyButtons: [], buttonReview: '', retainedButtonReply: null, projectId: 'p', accountId: 'a', tab: 'messages', selected: { id: 'current' }, focusedComment: '', message: '', attachmentUrl: '', attachmentType: 'image', attachmentName: '', attachmentPreview: '', messageTag: '', templateMode: false, templateKey: '', templateComponents: [], replyTarget: null, privateReplyTarget: null, privateDraft: '', commentEdit: null, messageActionTarget: null, actionText: '', actionEmoji: '👍', controlAction: '', controlNote: '', targetAppId: '263902037430900', openingMessage: '', recipient: '', openingTemplateKey: '', openingTemplateComponents: [], confirmSend: false, confirmReplace: false, confirmControl: false, confirmAccept: false, confirmMessageAction: false, readOnly: false, historyQuery: 'old invoice', historyDirection: 'incoming' };
  const code = section('  const replyDraft =', '  useEffect(() => { onDraftChange(draftSnapshot');
  const snapshot = changes => compile('function snapshot() {' + code + ' return draftSnapshot; }', { ...context, ...changes })();
  assert.equal(snapshot(), '');
  for (const changes of [{ message: ' ' }, { attachmentUrl: 'https://example.test/file' }, { attachmentType: 'audio' }, { attachmentName: 'report.pdf' }, { messageTag: 'HUMAN_AGENT' }, { templateMode: true }, { templateKey: 'template' }, { templateComponents: [{}] }, { replyButtons: ['Yes'] }, { buttonReview: 'reviewed' }, { retainedButtonReply: { message: 'Unknown reply', buttons: [] } }]) assert.notEqual(snapshot(changes), '', JSON.stringify(changes));
  const acceptKey = compile('function acceptKey(selected, message) { return ' + source.match(/title="Review the acceptance reply" reviewKey=\{(JSON\.stringify\(\[selected\.id, selected\.version, message\]\))\}/)[1] + '; }');
  assert.notEqual(acceptKey({ id: 'thread', version: 'v1' }, 'draft'), acceptKey({ id: 'thread', version: 'v1' }, 'edited draft'), 'Editing a reviewed acceptance reply clears its acknowledgement.'); assert.notEqual(acceptKey({ id: 'thread', version: 'v1' }, 'draft'), acceptKey({ id: 'thread', version: 'v2' }, 'draft'), 'A refreshed conversation clears its acknowledgement.');
  assert.notEqual(snapshot({ privateReplyTarget: { id: 'comment' }, privateDraft: 'before' }), snapshot({ privateReplyTarget: { id: 'comment' }, privateDraft: 'after' }));
  assert.notEqual(snapshot({ commentEdit: { id: 'comment', content: 'before' } }), snapshot({ commentEdit: { id: 'comment', content: 'after' } }));
  for (const [field, setter, value] of [['historyQuery', 'setHistoryQuery', 'new invoice'], ['historyDirection', 'setHistoryDirection', 'outgoing']]) {
    const guard = selectionGuard(snapshot({ message: 'Keep this reply' })), reads = [], cleared = [];
    const active = { ...context, message: 'Keep this reply', pending: { current: false }, version: { current: 1 }, onSwitch: guard.requestSwitch, setError() {}, action: async (_, run) => run(1), fetchList: async (...args) => reads.push(args), setHistoryFilter() {}, resetSelection: () => cleared.push('draft cleared') };
    active.switchSelection = change => compile(section('function switchSelection(', '  function resetTemplate('), active)(change);
    active[setter] = next => { active[field] = next; guard.reportDraft(snapshot(active)); };
    const search = () => compile(section('async function searchHistory(', '  async function prepareConversation('), active)(event);
    await search(); assert.ok(guard.pendingSwitch); assert.deepEqual(reads, []);
    const start = source.indexOf(`onChange={event => ${setter}(`) + 'onChange={'.length;
    compile(source.slice(start, source.indexOf('}', start)), active)({ target: { value } });
    await guard.discardAndSwitch(); assert.deepEqual(reads, [], `${field} edits must cancel the old pending query.`); assert.deepEqual(cleared, []); assert.equal(active.message, 'Keep this reply');
    await search(); await guard.discardAndSwitch(); assert.deepEqual(reads, [[1, '', { query: active.historyQuery, direction: active.historyDirection }]]); assert.deepEqual(cleared, ['draft cleared']);
  }
});


test('lost Reddit edit response terminal unsent receipt requires a fresh comment read and acknowledgment', async () => {
  for (const terminal of [{ status: 409, code: 'OPERATION_NOT_SENT' }, { status: 502, code: 'PROVIDER_UNAVAILABLE' }]) {
  const body = { accountId: 'rd', postId: 'post', commentId: 'comment', content: 'Keep my correction', expectedCommentVersion: 'version', confirmEdit: true }, keys = { current: new Map() }; let writes = 0, draft = { id: 'comment', editVersion: 'version', message: 'Before', content: body.content }; draft.confirmed = JSON.stringify(['rd', 'post', draft.id, draft.editVersion, draft.message, draft.content]);
  const scope = { current: { generation: 1, readOnly: false, edit: draft, rows: [{ id: 'comment', from: { isOwner: true }, editVersion: 'version' }] } }, context = { readOnly: false, path, keys, crypto, account: { platform: 'reddit' }, accountId: 'rd', selected: { id: 'post' }, commentScope: scope, commentGeneration: 1, version: { current: 1 }, action: async (_, run) => run(1), setCommentEdit: update => { draft = update(draft); scope.current.edit = draft; }, setNotice() {}, refreshAfterWrite() {}, requester: { current: async () => { if (++writes === 1) throw new TypeError('Response lost'); throw Object.assign(new Error('Not sent'), { ...terminal, operation: { status: 'failed' } }); } } };
  context.write = compile(section('async function write(', '  async function loadAccounts('), context); const run = (value, checking) => compile(section('async function editComment(', '  async function commentAction('), { ...context, commentEdit: draft })(value, checking);
  await assert.rejects(run(body, false), /lost/); const pending = draft.pendingBody; await assert.rejects(run(pending, true), /Not sent/); assert.equal(draft.content, body.content); assert.equal(draft.blocked, false); assert.equal(draft.needsRefresh, true); assert.equal(draft.confirmed, ''); assert.equal(draft.pendingBody, undefined); assert.equal(keys.current.size, 0); await run(pending, true); await run(body, false); assert.equal(writes, 2);
  const read = compile(section('async function fetchThread(', '  async function openItem('), { ...context, tab: 'comments', commentsWithDepth: rows => rows, setSelected() {}, setFocusedComment() {}, setDetail() {}, requester: { current: async () => ({ comments: [{ id: 'comment', message: 'Current text', editVersion: 'fresh-version', from: { isOwner: true } }] }) } }); await read({ id: 'post' }, 1); assert.equal(draft.needsRefresh, false); assert.equal(draft.editVersion, 'fresh-version'); assert.equal(draft.message, 'Current text'); assert.equal(draft.content, body.content); assert.equal(draft.confirmed, ''); await run({ ...body, expectedCommentVersion: 'fresh-version' }, false); assert.equal(writes, 2);
  }
});
