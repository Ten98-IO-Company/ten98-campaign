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
    const context = { React, ...ui, tab: 'comments', selected: { id: 'post' }, focusedComment: '', busy: '', readOnly: false, accountId: 'rd', account: { platform: 'reddit', name: 'Reddit account' }, capabilities: { commentEdit: true }, canReply: false, privateReplyTarget: null, projectId: 'project-a', threadRows: [row], detail: {}, commentEdit, when: () => '', link: () => '', states: {}, triageLabel: () => '', waitingFor: () => '', userId: '', triageError: '', assignees: [], TriageControls: () => null, changeTriage() {}, notesFor: () => null, ...changes };
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
  const start = source.indexOf("<Stack as=\"section\" gap={3} aria-label={tab === 'mentions'"), markup = source.slice(start, source.indexOf('\n      {loaded && !visibleRows.length && ', start)); assert.ok(start > 0);
  const code = await transformWithOxc('function MentionCards() { return (' + markup + '); }', 'MentionCards.tsx', { jsx: { runtime: 'classic' } });
  const rows = [{ id: 'mention-document', content: '<Campaign update>', authorName: null, authorUsername: null, publishedAt: null, permalink: accepted }, { id: 'another-document', content: 'More content', authorName: 'Sam', permalink: null }, { id: 'unsafe-document', permalink: 'https://evil.test/post' }];
  const component = new Function('React', ...uiNames, 'visibleRows', 'tab', 'account', 'when', 'link', 'readOnly', 'states', 'triageLabel', 'userId', 'TriageControls', 'accountId', 'triageError', 'busy', 'assignees', 'changeTriage', 'notesFor', code.code + '; return MentionCards;')(React, ...uiValues, rows, 'mentions', { name: 'Connected account' }, () => 'Time unavailable', safeLink, true, {}, () => '', '', () => null, 'li', '', '', [], () => {}, () => null);
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
  const action = compile(section('async function action(', '  async function write('), { pending, version, revision: { current: 0 }, setBusy: value => busy.push(value), setError: value => errors.push(value), setNotice() {}, rememberFocus() {} });
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
  const context = { noteDrafts: {}, replyButtons: [], buttonReview: '', retainedButtonReply: null, projectId: 'p', accountId: 'a', tab: 'messages', selected: { id: 'current' }, focusedComment: '', message: '', attachmentUrl: '', attachmentType: 'image', attachmentName: '', attachmentPreview: '', messageTag: '', templateMode: false, templateKey: '', templateComponents: [], replyTarget: null, privateReplyTarget: null, privateDraft: '', commentEdit: null, messageActionTarget: null, actionText: '', actionEmoji: '👍', controlAction: '', controlNote: '', targetAppId: '263902037430900', openingMessage: '', recipient: '', openingTemplateKey: '', openingTemplateComponents: [], confirmSend: false, confirmReplace: false, confirmControl: false, confirmAccept: false, confirmMessageAction: false, readOnly: false, historyQuery: 'old invoice', historyDirection: 'incoming' };
  const code = section('  const replyDraft =', '  useEffect(() => { onDraftChange(draftSnapshot');
  const snapshot = changes => compile('function snapshot() {' + code + ' return draftSnapshot; }', { ...context, ...changes })();
  assert.equal(snapshot(), '');
  // An unsent internal note is a draft too, so leaving the item asks first.
  assert.notEqual(snapshot({ noteDrafts: { '["a","conversation","current"]': 'Call back Monday' } }), '');
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

// Team triage overlay: the actual helpers, change handler and detail controls from the source.
const { validPostInstant } = await import('../shared/social-posts.ts');
function triageHelpers() {
  const start = source.indexOf('// Team triage overlay'), end = source.indexOf('function TriageControls(', start); assert.ok(start > 0 && end > start);
  return new Function('validPostInstant', 'when', stripTypeScriptTypes(source.slice(start, end)) + '; return { triageFilters, triageNames, triageKinds, triageKey, triageComments, triageVisible, waitingFor, triageLabel, snoozeUntil, validSnooze, mergeTriage, loadItemStates, snoozePresets };')(validPostInstant, value => 'at ' + value);
}
async function triageControls(useState = initial => [initial, () => {}]) {
  const start = source.indexOf('function TriageControls('), end = source.indexOf('\nexport default function UnifiedInbox(', start); assert.ok(start > 0 && end > start);
  const { code } = await transformWithOxc(source.slice(start, end), 'TriageControls.tsx', { jsx: { runtime: 'classic' } }), helpers = triageHelpers();
  return new Function('React', 'useState', 'when', ...Object.keys(helpers), ...uiNames, code + '; return TriageControls;')(React, useState, value => 'at ' + value, ...Object.values(helpers), ...uiValues);
}
// The component's own scoping line: a tab sees only the states of its account and kind.
const triageScope = context => compile('function scope() {' + source.match(/^  const triageKind = triageKinds\[tab\].*;$/m)[0] + ' return { triageKind, states, triageError }; }', context)();
function triageContext(overrides = {}) {
  const helpers = triageHelpers(), calls = [], context = { ...helpers, path, tab: 'messages', accountId: 'tg', readOnly: false, version: { current: 1 }, pending: { current: false }, revision: { current: 0 }, errors: [], notices: [], setBusy() {}, when: value => 'at ' + value, ...overrides };
  context.triage = overrides.triage || { accountId: 'tg', kind: 'conversation', states: { 'thread-1': { accountId: 'tg', kind: 'conversation', resourceId: 'thread-1', status: 'open', updatedAt: '2026-10-22T08:00:00.000Z' } }, error: '' };
  const first = Object.keys(context.triage.states)[0];
  context.setTriage = value => { context.triage = typeof value === 'function' ? value(context.triage) : value; };
  context.setError = value => context.errors.push(value); context.setNotice = value => context.notices.push(value);
  context.requester = { current: async (...args) => { calls.push(args); return overrides.respond ? overrides.respond(...args) : { state: { ...context.triage.states[first], ...args[2], updatedAt: '2026-10-22T09:00:00.000Z' } }; } };
  context.rememberFocus = () => {}; context.action = compile(section('async function action(', '  async function write('), context);
  // Each call closes over the states of a fresh render, as React would.
  const changeTriage = (...args) => compile(section('async function changeTriage(', '  async function searchHistory('), { ...context, ...triageScope(context) })(...args);
  return { context, calls, changeTriage };
}

test('triage state loads in batches of 100 unique IDs, keyed like the webhook drain, and ignores foreign states', async () => {
  const { loadItemStates, triageKey } = triageHelpers(), calls = [];
  assert.equal(triageKey({ id: 'stored-1', platformConversationId: 't_platform' }), 't_platform'); assert.equal(triageKey({ id: 'stored-2' }), 'stored-2');
  const ids = Array.from({ length: 250 }, (_, index) => 'thread-' + index);
  const request = async (...args) => { calls.push(args); const query = new URL('https://x.test' + args[0]).searchParams; return { states: [...query.getAll('id').map(resourceId => ({ accountId: query.get('accountId'), kind: query.get('kind'), resourceId, status: 'pending', updatedAt: null })), { accountId: 'other', kind: 'conversation', resourceId: 'thread-0', status: 'resolved' }, { accountId: 'tg', kind: 'conversation', resourceId: 'not-requested', status: 'resolved' }], checkedAt: '2026-10-22T09:00:00.000Z' }; };
  const states = await loadItemStates(request, path, 'tg', 'conversation', [...ids, 'thread-1', 'thread-249']);
  assert.equal(calls.length, 3); assert.deepEqual(calls.map(call => call.length), [1, 1, 1], 'Reads are plain GETs with no body or action key.');
  const batches = calls.map(([url]) => { assert.ok(url.startsWith(path + '/item-states?')); const query = new URL('https://x.test' + url).searchParams; assert.equal(query.get('accountId'), 'tg'); assert.equal(query.get('kind'), 'conversation'); assert.deepEqual([...new Set(query.keys())], ['accountId', 'kind', 'id']); return query.getAll('id'); });
  assert.deepEqual(batches.map(batch => batch.length), [100, 100, 50]); assert.deepEqual(batches.flat(), ids);
  assert.equal(Object.keys(states).length, 250); assert.equal(states['thread-0'].status, 'pending'); assert.equal(states['not-requested'], undefined);
  assert.deepEqual(await loadItemStates(async () => { throw new Error('unexpected'); }, path, 'tg', 'conversation', []), {}, 'No IDs make no request.');
});

test('the triage filter defaults to open and pending, keeps unloaded items and labels waiting time and assignee', () => {
  const { triageFilters, triageVisible, waitingFor, triageLabel, mergeTriage } = triageHelpers();
  assert.deepEqual(triageFilters.map(([, label]) => label), ['Open', 'Mine', 'Unassigned', 'Snoozed', 'Done']);
  assert.match(source, /\[triageFilter, setTriageFilter\] = useState\('active'\)/);
  const rows = ['open', 'pending', 'snoozed', 'resolved'].map(status => ({ status }));
  const shown = filter => rows.filter(state => triageVisible(state, filter)).map(state => state.status);
  assert.deepEqual(shown('active'), ['open', 'pending']); assert.deepEqual(shown('snoozed'), ['snoozed']); assert.deepEqual(shown('resolved'), ['resolved']); assert.deepEqual(shown('all'), ['open', 'pending', 'snoozed', 'resolved']);
  const assigned = [{ status: 'open', assigneeId: 'me' }, { status: 'pending', assigneeId: 'teammate' }, { status: 'open', assigneeId: null }, { status: 'resolved', assigneeId: 'me' }, { status: 'snoozed', assigneeId: null }];
  assert.deepEqual(assigned.filter(state => triageVisible(state, 'mine', 'me')), [assigned[0]], 'Mine is open or pending work assigned to the signed-in user.');
  assert.deepEqual(assigned.filter(state => triageVisible(state, 'unassigned', 'me')), [assigned[2]], 'Unassigned is open or pending work without an assignee.');
  assert.deepEqual(assigned.filter(state => triageVisible(state, 'mine', '')), [], 'Without a signed-in user, Mine matches nothing loaded.');
  assert.equal(triageVisible(undefined, 'resolved'), true, 'A conversation whose state has not loaded is never hidden.'); assert.equal(triageVisible(undefined, 'mine', 'me'), true);
  const now = Date.parse('2026-10-22T12:00:00Z');
  assert.equal(waitingFor('2026-10-22T09:00:00Z', now), 'waiting 3h'); assert.equal(waitingFor('2026-10-22T11:35:00Z', now), 'waiting 25m'); assert.equal(waitingFor('2026-10-22T11:59:40Z', now), 'waiting under 1m'); assert.equal(waitingFor('2026-10-19T12:00:00Z', now), 'waiting 3d'); assert.equal(waitingFor(null, now), ''); assert.equal(waitingFor('not a date', now), '');
  assert.equal(triageLabel({ status: 'pending', assigneeId: 'me' }, 'me'), 'Pending · Assigned to you'); assert.equal(triageLabel({ status: 'resolved', assigneeId: 'teammate' }, 'me'), 'Resolved · Assigned'); assert.equal(triageLabel({ status: 'snoozed', assigneeId: null }, 'me'), 'Snoozed'); assert.equal(triageLabel(undefined), '');
  const saved = { 'a': { status: 'resolved', updatedAt: '2026-10-22T09:00:00.000Z' }, 'b': { status: 'open', updatedAt: '2026-10-22T09:00:00.000Z' } };
  const merged = mergeTriage(saved, { a: { status: 'open', updatedAt: '2026-10-22T08:00:00.000Z' }, b: { status: 'open', updatedAt: '2026-10-22T09:00:00.000Z', waitingSince: '2026-10-22T10:00:00.000Z' }, c: { status: 'open', updatedAt: null } });
  assert.equal(merged.a.status, 'resolved', 'A read that started before a change cannot undo it.'); assert.equal(merged.b.waitingSince, '2026-10-22T10:00:00.000Z'); assert.equal(merged.c.status, 'open');
  assert.match(source, /triageVisible\(states\[triageKey\(row, triageKind\)\], triageFilter, userId\)/); assert.match(source, /meta: \[when\(item\.lastMessageAt \|\| item\.updatedTime\), waitingFor\(states\[triageKey\(item\)\]\?\.waitingSince\)\]/);
});

test('snooze presets send local times with an offset, and invalid snoozes never reach the server', async () => {
  const { snoozeUntil, validSnooze } = triageHelpers(), now = new Date(2026, 9, 22, 15, 30, 0), at = value => new Date(Date.parse(value));
  for (const preset of ['hour', 'tomorrow', 'week']) { const value = snoozeUntil(preset, now); assert.ok(validPostInstant(value), value); assert.match(value, /[+-]\d{2}:\d{2}$/); assert.ok(validSnooze(value, now.getTime()), preset); }
  assert.equal(Date.parse(snoozeUntil('hour', now)) - now.getTime(), 3600000);
  const tomorrow = at(snoozeUntil('tomorrow', now)); assert.deepEqual([tomorrow.getDate(), tomorrow.getHours(), tomorrow.getMinutes()], [23, 9, 0]);
  const week = at(snoozeUntil('week', now)); assert.deepEqual([week.getDay(), week.getHours(), week.getDate()], [1, 9, 26], 'Next week is the coming Monday at 9 AM local time.');
  const monday = at(snoozeUntil('week', new Date(2026, 9, 26, 8, 0, 0))); assert.equal(monday.getDate(), 2, 'On a Monday, next week is seven days ahead.');
  assert.equal(validSnooze('2026-10-22T16:30:00', now.getTime()), false, 'A time without a zone is rejected.'); assert.equal(validSnooze(new Date(now.getTime() - 60000).toISOString(), now.getTime()), false); assert.equal(validSnooze(new Date(now.getTime() + 367 * 86400000).toISOString(), now.getTime()), false); assert.equal(validSnooze(undefined, now.getTime()), false);
  const { context, calls, changeTriage } = triageContext();
  await changeTriage({ id: 'thread-1' }, { status: 'snoozed', snoozedUntil: '2020-01-01T09:00:00+04:00' }); assert.equal(calls.length, 0); assert.match(context.errors.at(-1), /future/);
  const until = snoozeUntil('tomorrow'); await changeTriage({ id: 'thread-1' }, { status: 'snoozed', snoozedUntil: until });
  assert.equal(calls.length, 1); assert.deepEqual(calls[0], [path + '/item-states', 'PATCH', { accountId: 'tg', kind: 'conversation', resourceId: 'thread-1', expectedUpdatedAt: '2026-10-22T08:00:00.000Z', status: 'snoozed', snoozedUntil: until }], 'PATCH carries no idempotency key.');
  assert.equal(context.triage.states['thread-1'].status, 'snoozed'); assert.equal(context.triage.states['thread-1'].updatedAt, '2026-10-22T09:00:00.000Z'); assert.match(context.notices.at(-1), /snoozed until/);
});

test('a stale triage change reloads that item, keeps no optimistic state and lets the user choose again', async () => {
  const fresh = { accountId: 'tg', kind: 'conversation', resourceId: 'thread-1', status: 'resolved', assigneeId: 'teammate', updatedAt: '2026-10-22T08:30:00.000Z' };
  const { context, calls, changeTriage } = triageContext({ respond: (url, method) => { if (method === 'PATCH') throw Object.assign(new Error('changed'), { status: 409, code: 'INBOX_STATE_CHANGED' }); return { states: [fresh], checkedAt: '2026-10-22T09:00:00.000Z' }; } });
  await changeTriage({ id: 'thread-1' }, { status: 'pending' });
  assert.equal(calls.length, 2); assert.equal(calls[0][1], 'PATCH'); assert.equal(calls[1][0], path + '/item-states?accountId=tg&kind=conversation&id=thread-1'); assert.equal(calls[1].length, 1);
  assert.deepEqual(context.triage.states['thread-1'], fresh); assert.match(context.errors.at(-1), /changed elsewhere.*choose again/); assert.equal(context.pending.current, false);
  context.requester.current = async (...args) => { calls.push(args); return { state: { ...fresh, ...args[2], updatedAt: '2026-10-22T09:30:00.000Z' } }; };
  await changeTriage({ id: 'thread-1' }, { status: 'pending' }); assert.equal(calls.at(-1)[2].expectedUpdatedAt, fresh.updatedAt, 'The retry uses the reloaded token.'); assert.equal(context.triage.states['thread-1'].status, 'pending');
  for (const code of ['ASSIGNEE_NOT_ELIGIBLE', 'INVALID_INBOX_STATE']) {
    const failed = triageContext({ respond: () => { throw Object.assign(new Error('Server message for ' + code), { status: code === 'ASSIGNEE_NOT_ELIGIBLE' ? 409 : 400, code }); } });
    await failed.changeTriage({ id: 'thread-1' }, { assigneeId: 'someone' }); assert.equal(failed.calls.length, 1, code + ' does not reload.'); assert.equal(failed.context.errors.at(-1), 'Server message for ' + code); assert.equal(failed.context.triage.states['thread-1'].updatedAt, '2026-10-22T08:00:00.000Z');
  }
  const foreign = triageContext({ respond: () => ({ state: { accountId: 'other', kind: 'conversation', resourceId: 'thread-1', status: 'resolved', updatedAt: 'x' } }) });
  await foreign.changeTriage({ id: 'thread-1' }, { status: 'resolved' }); assert.equal(foreign.context.triage.states['thread-1'].status, 'open'); assert.match(foreign.context.errors.at(-1), /could not be read/);
});

test('read-only users see triage status without controls, and the handler refuses their changes', async () => {
  const TriageControls = await triageControls(), state = { accountId: 'tg', kind: 'conversation', resourceId: 'thread-1', status: 'pending', waitingSince: new Date(Date.now() - 3 * 3600000 - 60000).toISOString(), assigneeId: 'me', updatedAt: '2026-10-22T08:00:00.000Z' };
  const viewer = renderToStaticMarkup(React.createElement(TriageControls, { state, readOnly: true, busy: false, userId: '', onChange() { throw new Error('no'); } }));
  assert.match(viewer, /Triage: Pending · waiting 3h · Assigned to a teammate/); assert.doesNotMatch(viewer, /<button|<select/);
  const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];
  const changes = [], tree = TriageControls({ state, readOnly: false, busy: false, userId: 'me', onChange: change => changes.push(change) });
  const buttons = Object.fromEntries(elements(tree).filter(node => node.type === ui.Button).map(node => [[node.props.children].flat().join(''), node]));
  assert.deepEqual(Object.keys(buttons), ['Mark open', 'Resolve', 'Snooze', 'Unassign']);
  for (const label of Object.keys(buttons)) buttons[label].props.onClick();
  assert.deepEqual(changes.map(change => change.status ?? 'assignee:' + change.assigneeId), ['open', 'resolved', 'snoozed', 'assignee:null']); assert.ok(validPostInstant(changes[2].snoozedUntil));
  const editor = renderToStaticMarkup(React.createElement(TriageControls, { state: { ...state, status: 'resolved', assigneeId: null }, readOnly: false, busy: false, userId: 'me', onChange() {} }));
  assert.match(editor, />Reopen<\/button>/); assert.match(editor, />Mark pending<\/button>/); assert.match(editor, />Assign to me<\/button>/); assert.doesNotMatch(editor, />Resolve<|>Unassign</); assert.match(editor, /Snooze until/); assert.match(editor, /Tomorrow, 9 AM/);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(TriageControls, { state, readOnly: false, busy: false, userId: '', onChange() {} })), /Assign to me/, 'Without a confirmed user ID there is no Assign to me.');
  assert.match(renderToStaticMarkup(React.createElement(TriageControls, { readOnly: false, busy: false, userId: 'me', onChange() {} })), /Loading triage status…/);
  const { calls, changeTriage } = triageContext({ readOnly: true }); await changeTriage({ id: 'thread-1' }, { status: 'resolved' }); assert.equal(calls.length, 0);
  const comments = triageContext({ tab: 'comments' }); await comments.changeTriage({ id: 'thread-1' }, { status: 'resolved' }); assert.equal(comments.calls.length, 0);
  assert.match(source, /<TriageControls key=\{accountId \+ ':' \+ triageKey\(selected\)\} state=\{states\[triageKey\(selected\)\]\}/);
});

test('editors can assign a conversation to an eligible teammate from the project assignee directory', async () => {
  const members = [{ id: 'me', name: 'Mira', role: 'owner' }, { id: 'mate', name: 'Sam', role: 'editor' }];
  const state = { accountId: 'tg', kind: 'conversation', resourceId: 'thread-1', status: 'open', assigneeId: 'mate', updatedAt: '2026-10-22T08:00:00.000Z' };
  const shown = renderToStaticMarkup(React.createElement(await triageControls(), { state, readOnly: false, busy: false, userId: 'me', members, onChange() {} }));
  assert.match(shown, /Assigned to Sam/); assert.match(shown, />Mira \(you\)<\/option>/); assert.doesNotMatch(shown, />Sam<\/option>/, 'The current assignee is not offered again.');
  // The picker's choice is local state; with Sam chosen, Assign sends only the assignee.
  const Picked = await triageControls(initial => [initial === '' ? 'mate' : initial, () => {}]), changes = [];
  const elements = node => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements(node.props.children)] : [];
  const assign = elements(Picked({ state: { ...state, assigneeId: null }, readOnly: false, busy: false, userId: 'me', members, onChange: change => changes.push(change) })).find(node => node.type === ui.Button && node.props.children === 'Assign');
  assert.equal(assign.props.disabled, false); assign.props.onClick(); assert.deepEqual(changes, [{ assigneeId: 'mate' }]);
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(await triageControls(), { state, readOnly: false, busy: false, userId: 'me', onChange() {} })), /Assign to<|Choose a teammate/, 'Without the directory only Assign to me and Unassign remain.');
  const { calls, context, changeTriage } = triageContext({ userId: 'me', assignees: members }); await changeTriage({ id: 'thread-1' }, { assigneeId: 'mate' });
  assert.equal(calls.at(-1)[2].assigneeId, 'mate'); assert.deepEqual(context.notices.filter(Boolean).at(-1), 'Conversation assigned to Sam.');
  assert.ok(source.includes("if (readOnly) return; let closed = false; requester.current(`/projects/${encodeURIComponent(projectId)}/assignees`)"), 'Viewers do not read the directory.');
});

// Comments, reviews and mentions use the same overlay, keyed by their own kind and provider ID.
const kindStates = (kind, ids, extra = {}) => Object.fromEntries(ids.map(resourceId => [resourceId, { accountId: 'tg', kind, resourceId, status: 'open', assigneeId: null, waitingSince: null, updatedAt: '2026-10-22T08:00:00.000Z', ...extra }]));
function triageLoader(context) {
  const start = source.indexOf('  // States for the loaded items'), marker = "  }, [tab === 'comments' ? detail : rows, accountId, tab]);", end = source.indexOf(marker, start) + marker.length; assert.ok(start > 0 && end > start);
  return compile('function load() {' + source.slice(start, end) + '}', { useEffect: effect => effect(), ...context });
}

test('comments, reviews and mentions load triage states of their own kind for the loaded items only', async () => {
  const { triageKinds, triageKey, loadItemStates, mergeTriage } = triageHelpers();
  assert.deepEqual(triageKinds, { messages: 'conversation', comments: 'comment', reviews: 'review', mentions: 'mention' });
  assert.equal(triageKey({ id: 'comment-1', platformConversationId: 't_platform' }, 'comment'), 'comment-1', 'Only conversations use the platform thread ID.');
  const cases = [
    ['comments', { threadRows: [{ id: 'comment-1', depth: 0 }, { id: 'reply-1', depth: 1 }], rows: [{ id: 'post-1' }] }, ['comment-1', 'reply-1']],
    ['reviews', { threadRows: [], rows: [{ id: 'review-1' }, { id: 'review-2', platformConversationId: 'unrelated' }] }, ['review-1', 'review-2']],
    ['mentions', { threadRows: [], rows: [{ id: 'mention-1' }] }, ['mention-1']],
  ];
  for (const [tab, items, ids] of cases) {
    const calls = [], kind = triageKinds[tab];
    let triage = { accountId: 'tg', kind: 'conversation', states: kindStates('conversation', ['comment-1', 'review-1', 'mention-1']), error: '' };
    const requester = { current: async (...args) => { calls.push(args); const query = new URL('https://x.test' + args[0]).searchParams; return { states: query.getAll('id').map(resourceId => ({ accountId: 'tg', kind: query.get('kind'), resourceId, status: 'pending', updatedAt: null })) }; } };
    triageLoader({ ...items, tab, triageKind: kind, accountId: 'tg', detail: {}, version: { current: 1 }, requester, path, loadItemStates, mergeTriage, triageKey, setTriage: change => { triage = change(triage); } })();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.length, 1, tab); assert.equal(calls[0].length, 1, 'Reads are plain GETs.');
    const query = new URL('https://x.test' + calls[0][0]).searchParams; assert.equal(query.get('kind'), kind); assert.deepEqual(query.getAll('id'), ids, tab + ' requests its visible items, never the post ID.');
    assert.equal(triage.kind, kind); assert.deepEqual(Object.keys(triage.states), ids, 'A previous kind’s states are dropped, not merged.'); assert.ok(Object.values(triage.states).every(state => state.kind === kind));
  }
  const calls = []; triageLoader({ tab: 'reviews', triageKind: 'review', accountId: '', rows: [{ id: 'review-1' }], threadRows: [], detail: {}, version: { current: 1 }, requester: { current: async (...args) => calls.push(args) }, path, loadItemStates, mergeTriage, triageKey, setTriage() {} })();
  assert.equal(calls.length, 0, 'Without an account nothing is read.');
});

test('switching tabs never shows another kind’s triage states', () => {
  const triage = { accountId: 'tg', kind: 'comment', states: kindStates('comment', ['shared-id']), error: 'Comment read failed' };
  const helpers = triageHelpers();
  assert.deepEqual(triageScope({ ...helpers, triage, accountId: 'tg', tab: 'comments' }).states, triage.states);
  for (const tab of ['messages', 'reviews', 'mentions']) { const scoped = triageScope({ ...helpers, triage, accountId: 'tg', tab }); assert.deepEqual(scoped.states, {}, tab); assert.equal(scoped.triageError, '', tab); }
  assert.deepEqual(triageScope({ ...helpers, triage, accountId: 'other', tab: 'comments' }).states, {}, 'Another account sees nothing.');
});

test('the triage filter hides reviews and mentions by status, and filters comments inside the thread', () => {
  const { triageVisible, triageKey, triageComments } = triageHelpers(), conversationMatches = compile(section('function conversationMatches(', 'function SmsInbox('));
  const line = source.match(/^  const visibleRows = .*;$/m)[0], visible = context => compile('function shown() {' + line + ' return visibleRows; }', { historyFilter: null, search: '', userId: 'me', conversationMatches, triageVisible, triageKey, ...context })().map(row => row.id);
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }], states = { a: { status: 'open' }, b: { status: 'resolved' } };
  for (const [tab, triageKind] of [['reviews', 'review'], ['mentions', 'mention']]) {
    assert.deepEqual(visible({ tab, triageKind, rows, states, triageFilter: 'active' }), ['a', 'c'], tab + ': resolved items leave the default view; unloaded ones stay.');
    assert.deepEqual(visible({ tab, triageKind, rows, states, triageFilter: 'resolved' }), ['b', 'c']);
  }
  assert.deepEqual(visible({ tab: 'comments', triageKind: 'comment', rows, states, triageFilter: 'resolved' }), ['a', 'b', 'c'], 'Posts are never hidden by comment states.');
  const thread = [{ id: 'kept', replies: [] }, { id: 'parent', replies: [{ id: 'reply', replies: [] }, { id: 'done', replies: [] }] }, { id: 'closed', replies: [{ id: 'closed-reply', replies: [] }] }];
  const status = { kept: 'open', parent: 'resolved', reply: 'pending', done: 'resolved', closed: 'resolved', 'closed-reply': 'snoozed' };
  const ids = rows => rows.map(row => [row.id, ids(row.replies)]);
  assert.deepEqual(ids(triageComments(thread, row => triageVisible({ status: status[row.id] }, 'active'))), [['kept', []], ['parent', [['reply', []]]]], 'A resolved parent stays only to show its matching reply.');
  assert.deepEqual(ids(triageComments(thread, () => true)), ids(thread));
  assert.ok(source.includes("const shownComments = triageComments(detail?.comments || [], row => triageVisible(states[row.id], triageFilter, userId));"));
  assert.ok(source.includes('replies: shownComments }] : shownComments).map((item: Row) => commentMessage(item, selected))'));
  assert.match(source, /^      <SegmentedControl label="View" value=\{triageFilter\} onValueChange=\{setTriageFilter\} options=\{triageFilters\.map/m, 'The views are offered on every tab.');
});

test('review, mention and comment rows show their triage label, with waiting time except on mentions', async () => {
  const TriageControls = await triageControls(), { triageLabel, waitingFor } = triageHelpers(), waitingSince = new Date(Date.now() - 3 * 3600000 - 60000).toISOString();
  const start = source.indexOf("<Stack as=\"section\" gap={3} aria-label={tab === 'mentions'"), markup = source.slice(start, source.indexOf('\n      {loaded && !visibleRows.length && ', start));
  const { code } = await transformWithOxc('function Cards() { return (' + markup + '); }', 'Cards.tsx', { jsx: { runtime: 'classic' } });
  const names = ['visibleRows', 'tab', 'account', 'when', 'link', 'readOnly', 'canReply', 'capabilities', 'busy', 'prepareReply', 'setConfirming', 'states', 'triageLabel', 'waitingFor', 'userId', 'TriageControls', 'accountId', 'triageError', 'assignees', 'changeTriage', 'title', 'notesFor'];
  const render = (tab, ids, readOnly, extra = {}) => renderToStaticMarkup(React.createElement(new Function('React', ...uiNames, ...names, code + '; return Cards;')(React, ...uiValues, ids.map(id => ({ id, content: 'Text', text: 'Text' })), tab, {}, () => 'when', () => undefined, readOnly, false, {}, '', () => {}, () => {}, kindStates(tab === 'mentions' ? 'mention' : 'review', ids, { status: 'pending', assigneeId: 'me', waitingSince, ...extra }), triageLabel, waitingFor, 'me', TriageControls, 'tg', '', [], () => {}, value => value || '', () => null)));
  const reviews = render('reviews', ['review-1'], false);
  assert.match(reviews, /when · Pending · Assigned to you · waiting 3h/); assert.match(reviews, /Triage: Pending · waiting 3h · Assigned to you/); assert.match(reviews, />Resolve<\/button>/);
  const mentions = render('mentions', ['mention-1'], false);
  assert.match(mentions, /<summary[^>]*><span[^>]*>Read mention · LinkedIn author · when · Pending · Assigned to you/); assert.match(mentions, /Triage: Pending · Assigned to you/); assert.match(mentions, />Resolve<\/button>/);
  assert.doesNotMatch(mentions, /waiting/, 'Mentions never show waiting text.');
  const viewer = render('reviews', ['review-1'], true); assert.match(viewer, /Triage: Pending/); assert.doesNotMatch(viewer, /<button|<select/, 'Viewers see the status without controls.');
  assert.doesNotMatch(renderToStaticMarkup(React.createElement(TriageControls, { kind: 'mention', state: { status: 'open', waitingSince }, readOnly: true, busy: false, userId: '', onChange() {} })), /waiting/);
  assert.match(renderToStaticMarkup(React.createElement(TriageControls, { kind: 'mention', error: 'x', readOnly: false, busy: false, userId: '', onChange() {} })), /Refresh the mentions to try again/);

  const helper = section('  function commentMessage(', '  const noun = '), comments = await transformWithOxc('function Comments() {' + helper + ' return <ConversationThread label="Post comments" messages={threadRows.map(row => commentMessage(row, selected))}/>; }', 'Comments.tsx', { jsx: { runtime: 'classic' } });
  const context = { React, ...ui, tab: 'comments', selected: { id: 'post' }, focusedComment: '', busy: '', readOnly: false, accountId: 'tg', account: { platform: 'facebook' }, capabilities: {}, canReply: false, privateReplyTarget: null, projectId: 'project-a', threadRows: [{ id: 'comment-1', message: 'Hello', likeCount: 2, depth: 0 }], detail: {}, commentEdit: null, when: () => '', link: () => '', states: kindStates('comment', ['comment-1'], { status: 'resolved', assigneeId: 'mate', waitingSince }), triageLabel, waitingFor, userId: 'me', triageError: '', assignees: [{ id: 'mate', name: 'Sam' }], TriageControls, changeTriage() {}, notesFor: () => null };
  const thread = renderToStaticMarkup(new Function(...Object.keys(context), comments.code + '; return Comments;')(...Object.values(context))());
  assert.match(thread, /2 likes · Resolved · Assigned · waiting 3h/); assert.match(thread, /Comment triage/); assert.match(thread, /Triage: Resolved · waiting 3h · Assigned to Sam/); assert.match(thread, />Reopen<\/button>/);
});

test('comment, review and mention triage changes carry their kind and provider ID and name the item', async () => {
  const members = [{ id: 'mate', name: 'Sam' }];
  for (const [tab, kind, id, change, notice] of [['comments', 'comment', 'comment-1', { status: 'resolved' }, 'Comment resolved.'], ['reviews', 'review', 'review-1', { assigneeId: 'mate' }, 'Review assigned to Sam.'], ['mentions', 'mention', 'mention-1', { status: 'pending' }, 'Mention marked pending.']]) {
    const { context, calls, changeTriage } = triageContext({ tab, userId: 'me', assignees: members, triage: { accountId: 'tg', kind, states: kindStates(kind, [id]), error: '' } });
    await changeTriage({ id, platformConversationId: 'ignored' }, change);
    assert.deepEqual(calls, [[path + '/item-states', 'PATCH', { accountId: 'tg', kind, resourceId: id, expectedUpdatedAt: '2026-10-22T08:00:00.000Z', ...change }]], tab);
    assert.equal(context.notices.at(-1), notice); assert.equal(context.triage.kind, kind); assert.equal(context.triage.states[id].updatedAt, '2026-10-22T09:00:00.000Z');
    const viewer = triageContext({ tab, readOnly: true, triage: { accountId: 'tg', kind, states: kindStates(kind, [id]), error: '' } }); await viewer.changeTriage({ id }, change); assert.equal(viewer.calls.length, 0, tab + ' refuses viewer changes.');
  }
  const crossed = triageContext({ tab: 'reviews', triage: { accountId: 'tg', kind: 'comment', states: kindStates('comment', ['review-1']), error: '' } });
  await crossed.changeTriage({ id: 'review-1' }, { status: 'resolved' }); assert.equal(crossed.calls.length, 0, 'Another kind’s state with the same ID is never written.');
  const wrongKind = triageContext({ tab: 'reviews', triage: { accountId: 'tg', kind: 'review', states: kindStates('review', ['review-1']), error: '' }, respond: () => ({ state: { ...kindStates('comment', ['review-1'])['review-1'], status: 'resolved' } }) });
  await wrongKind.changeTriage({ id: 'review-1' }, { status: 'resolved' }); assert.equal(wrongKind.context.triage.states['review-1'].status, 'open'); assert.match(wrongKind.context.errors.at(-1), /Refresh the reviews/);
});

test('a stale comment, review or mention change reloads that kind and item only', async () => {
  for (const [tab, kind, id] of [['comments', 'comment', 'comment-1'], ['reviews', 'review', 'review-1'], ['mentions', 'mention', 'mention-1']]) {
    const fresh = { ...kindStates(kind, [id])[id], status: 'resolved', updatedAt: '2026-10-22T08:30:00.000Z' };
    const { context, calls, changeTriage } = triageContext({ tab, triage: { accountId: 'tg', kind, states: kindStates(kind, [id, 'other-' + kind]), error: '' }, respond: (url, method) => { if (method === 'PATCH') throw Object.assign(new Error('changed'), { status: 409, code: 'INBOX_STATE_CHANGED' }); return { states: [fresh] }; } });
    await changeTriage({ id }, { status: 'pending' });
    assert.equal(calls.length, 2); assert.deepEqual(calls[1], [path + '/item-states?' + new URLSearchParams([['accountId', 'tg'], ['kind', kind], ['id', id]])]);
    assert.deepEqual(context.triage.states[id], fresh); assert.equal(context.triage.states['other-' + kind].status, 'open'); assert.equal(context.triage.kind, kind);
    assert.equal(context.errors.at(-1), `This ${kind}’s triage changed elsewhere. Its latest status is shown; choose again to apply your change.`);
  }
});

// Internal team notes: the actual ItemNotes component with ordered hooks, the shared action lock and a stubbed transport.
const settleNotes = () => new Promise(resolve => setImmediate(resolve));
const deferredNote = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const treeOf = node => Array.isArray(node) ? node.flatMap(treeOf) : React.isValidElement(node) ? [node, ...treeOf(node.props.children)] : [];
const labelOf = node => Array.isArray(node) ? node.map(labelOf).join('') : React.isValidElement(node) ? labelOf(node.props.children) : node == null || typeof node === 'boolean' ? '' : String(node);
const note = (id, authorId, body = 'Note ' + id) => ({ id, authorId, authorName: authorId === 'me' ? 'Mira' : 'Sam', body, createdAt: '2026-10-22T08:00:00.000Z' });
async function mountNotes(overrides = {}) {
  const start = source.indexOf('// Internal team notes'), end = source.indexOf('\nexport default function UnifiedInbox(', start); assert.ok(start > 0 && end > start);
  const { code } = await transformWithOxc(source.slice(start, end), 'ItemNotes.tsx', { jsx: { runtime: 'classic' } });
  const states = [], refs = [], effects = []; let stateIndex = 0, refIndex = 0, effectIndex = 0;
  const useState = initial => { const index = stateIndex++; if (!(index in states)) states[index] = initial; return [states[index], value => { states[index] = typeof value === 'function' ? value(states[index]) : value; }]; };
  const useRef = initial => refs[refIndex++] ||= { current: initial };
  const useEffect = (callback, deps) => { const index = effectIndex++, previous = effects[index]; if (!previous || deps.some((value, i) => !Object.is(value, previous.deps[i]))) effects[index] = { deps, callback, cleanup: previous?.cleanup }; };
  const ItemNotes = new Function('React', ...uiNames, 'useState', 'useRef', 'useEffect', 'when', 'merge', code + '; return ItemNotes;')(React, ...uiValues, useState, useRef, useEffect, value => 'at ' + value, merge);
  const calls = [], errors = [], notices = [], replies = [];
  const context = { version: { current: 1 }, pending: { current: false }, revision: { current: 0 }, setBusy() {}, setError: value => errors.push(value), setNotice: value => notices.push(value), rememberFocus() {} };
  const action = compile(section('async function action(', '  async function write('), context);
  const request = (...args) => { calls.push(args); const reply = replies.shift(); return reply ? reply(...args) : Promise.resolve({ notes: [] }); };
  let props = { path, request, accountId: 'tg', kind: 'conversation', resourceId: 'thread-1', readOnly: false, role: 'editor', userId: 'me', busy: false, defaultOpen: true, run: action, onNotice: value => notices.push(value), ...overrides };
  const h = {
    calls, errors, notices, replies, context,
    render(next = {}) { props = { ...props, ...next }; stateIndex = refIndex = effectIndex = 0; return ItemNotes(props); },
    flush() { for (const effect of effects) if (effect.callback) { effect.cleanup?.(); effect.cleanup = effect.callback(); effect.callback = null; } },
    async step(next) { h.render(next); h.flush(); await settleNotes(); h.render(); h.flush(); await settleNotes(); return h.render(); },
    html() { return renderToStaticMarkup(h.render()); },
    find(type, label) { return treeOf(h.render()).find(node => node.type === type && (label === undefined || labelOf(node.props.children) === label)); },
    type(value) { h.find(ui.Textarea).props.onChange({ target: { value } }); },
    submit() { return h.find(ui.Form).props.onSubmit(new FormData(), event); },
  };
  return h;
}

test('internal notes use each tab’s triage kind and resource ID, and load only when opened', async () => {
  const line = source.match(/^  const notesFor = .*;$/m)[0], { code } = await transformWithOxc('function make() {' + line + ' return notesFor; }', 'Notes.tsx', { jsx: { runtime: 'classic' } });
  const marker = () => null, requester = { current: async () => ({}) }, action = async () => {}, setNotice = () => {};
  const notesFor = new Function('React', 'ItemNotes', 'accountId', 'path', 'requester', 'readOnly', 'role', 'userId', 'busy', 'action', 'setNotice', 'setNoteDrafts', code + '; return make();')(React, marker, 'tg', path, requester, false, 'admin', 'me', '', action, setNotice, () => {});
  const element = notesFor('review', 'review-1');
  assert.equal(element.type, marker); assert.equal(element.key, JSON.stringify(['tg', 'review', 'review-1']), 'Each item mounts its own notes.');
  const { onDraftChange, ...props } = element.props;
  assert.deepEqual(props, { path, request: requester.current, accountId: 'tg', kind: 'review', resourceId: 'review-1', readOnly: false, role: 'admin', userId: 'me', busy: false, defaultOpen: false, run: action, onNotice: setNotice });
  assert.equal(typeof onDraftChange, 'function', 'An unsent note reports itself as a draft.');
  assert.equal(notesFor('conversation', 't_platform', true).props.defaultOpen, true);
  assert.ok(source.includes("{notesFor('conversation', triageKey(selected), true)}"), 'Messages open the selected conversation’s notes, keyed like triage.');
  assert.ok(source.includes("onChange={change => changeTriage(item, change)}/></Disclosure>{notesFor('comment', item.id)}"), 'Each comment has its own notes.');
  for (const kind of ['review', 'mention']) assert.ok(source.includes(`kind="${kind}" state={states[item.id]} error={triageError} readOnly={readOnly} busy={!!busy} userId={userId} members={assignees} onChange={change => changeTriage(item, change)}/>{notesFor('${kind}', item.id)}`), kind);

  for (const [kind, resourceId] of [['comment', 'comment-1'], ['review', 'review-1'], ['mention', 'mention-1']]) {
    const h = await mountNotes({ kind, resourceId, defaultOpen: false });
    await h.step(); assert.equal(h.calls.length, 0, kind + ' notes are not read for a closed row.');
    assert.match(h.html(), /Internal notes, visible only to your team/);
    h.find(ui.Disclosure).props.onOpenChange(true); await h.step();
    assert.deepEqual(h.calls, [[path + '/item-notes?' + new URLSearchParams({ accountId: 'tg', kind, resourceId })]], kind + ' reads are plain GETs.');
    assert.match(h.html(), /No internal notes yet/);
  }
  const h = await mountNotes({ resourceId: 't_platform' }); h.replies.push(async () => ({ notes: [note('n-1', 'mate', 'Called the customer.\nWaiting on a refund.'), { id: 'bad' }, { ...note('n-2', 'gone'), authorName: 'Former team member' }] }));
  await h.step(); assert.deepEqual(h.calls, [[path + '/item-notes?accountId=tg&kind=conversation&resourceId=t_platform']]);
  const html = h.html();
  assert.match(html, /Internal notes, visible only to your team \(2\)/); assert.match(html, /Sam/); assert.match(html, /Former team member/); assert.match(html, /<time[^>]*dateTime="2026-10-22T08:00:00.000Z"/i); assert.match(html, /at 2026-10-22T08:00:00.000Z/);
  assert.match(html, /Called the customer.\nWaiting on a refund./, 'Newlines are preserved.'); assert.ok(html.indexOf('Called the customer') < html.indexOf('Note n-2'), 'Oldest first, as returned.');
  const failed = await mountNotes(); failed.replies.push(async () => { throw new Error('Notes unavailable'); }); await failed.step();
  assert.match(failed.html(), /Notes unavailable/); assert.equal(failed.calls.length, 1, 'A failed read is not retried automatically.');
  failed.find(ui.Button, 'Load notes again').props.onClick(); await failed.step(); assert.equal(failed.calls.length, 2); assert.match(failed.html(), /No internal notes yet/);
});

test('editors add a note with its exact body once, append the returned note and clear the box; viewers only read', async () => {
  const h = await mountNotes({ kind: 'comment', resourceId: 'comment-1' }); h.replies.push(async () => ({ notes: [note('n-1', 'mate')] })); await h.step();
  assert.equal(h.find(ui.Textarea).props.maxLength, 4000); assert.equal(h.find(ui.Button, 'Add note').props.disabled, true, 'An empty note cannot be added.');
  h.type('  Follow up\nby Friday ');
  const count = h.find(ui.Field).props.count; assert.equal(count.max, 4000); assert.equal(count.measure(count.value), 22, 'The live count follows the typed text.');
  const post = deferredNote(); h.replies.push(() => post.promise);
  const first = h.submit(), second = h.submit(); h.render(); const third = h.submit();
  assert.equal(h.calls.length, 2, 'Double clicks send one POST.'); const { id: sentId, ...sent } = h.calls[1][2];
  assert.deepEqual([h.calls[1][0], h.calls[1][1], sent], [path + '/item-notes', 'POST', { accountId: 'tg', kind: 'comment', resourceId: 'comment-1', body: '  Follow up\nby Friday ' }], 'The POST carries the typed body.');
  assert.match(sentId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'A client note id lets a retried add return the saved note.');
  post.resolve({ note: { ...note('n-2', 'me'), body: 'Follow up\nby Friday' } }); await Promise.all([first, second, third]);
  assert.equal(h.context.pending.current, false); assert.equal(h.find(ui.Textarea).props.value, ''); assert.equal(h.notices.at(-1), 'Note added.');
  const html = h.html(); assert.match(html, /\(2\)/); assert.ok(html.indexOf('Note n-1') < html.indexOf('Follow up\nby Friday'), 'The new note is appended.');
  const failed = await mountNotes(); await failed.step(); failed.type('Keep me'); failed.replies.push(async () => { throw Object.assign(new Error('Write a note of 1 to 4,000 characters.'), { status: 400, code: 'INVALID_INBOX_NOTE' }); });
  await failed.submit(); await settleNotes(); assert.equal(failed.calls.length, 2, 'A failed add is not retried.'); assert.equal(failed.errors.at(-1), 'Write a note of 1 to 4,000 characters.'); assert.equal(failed.find(ui.Textarea).props.value, 'Keep me', 'A failed note stays in the box.');
  const viewer = await mountNotes({ readOnly: true, role: 'viewer' }); viewer.replies.push(async () => ({ notes: [note('n-1', 'me')] })); await viewer.step();
  const shown = viewer.html(); assert.match(shown, /Note n-1/); assert.doesNotMatch(shown, /<textarea|<form|Add note|Delete note/, 'Viewers get the list only.');
  assert.equal(viewer.find(ui.Form), undefined); assert.equal(viewer.find(ui.Button, 'Delete note'), undefined);
});

test('note deletion is offered for your own notes or to owners and admins, confirms first and reloads after a 404', async () => {
  const listed = { notes: [note('n-1', 'me'), note('n-2', 'mate')] }, deletes = h => treeOf(h.render()).filter(node => node.type === ui.Button && labelOf(node.props.children) === 'Delete note');
  for (const [role, userId, count] of [['editor', 'me', 1], ['editor', '', 0], ['admin', 'me', 2], ['owner', 'other', 2]]) {
    const h = await mountNotes({ role, userId }); h.replies.push(async () => structuredClone(listed)); await h.step();
    assert.equal(deletes(h).length, count, role + ' ' + (userId || 'unknown user'));
  }
  const h = await mountNotes({ role: 'admin' }); h.replies.push(async () => structuredClone(listed)); await h.step();
  deletes(h)[1].props.onClick();
  assert.equal(h.calls.length, 1, 'Choosing delete only asks first.'); const dialog = h.find(ui.ConfirmDialog); assert.equal(dialog.props.open, true); assert.equal(dialog.props.danger, true);
  dialog.props.onOpenChange(false); assert.equal(h.find(ui.ConfirmDialog).props.open, false); assert.equal(h.calls.length, 1, 'Cancelling sends nothing.');
  deletes(h)[1].props.onClick(); h.replies.push(async () => ({ deleted: true })); await h.find(ui.ConfirmDialog).props.onConfirm();
  assert.deepEqual(h.calls[1], [path + '/item-notes/n-2', 'DELETE']); assert.doesNotMatch(h.html(), /Note n-2/); assert.equal(h.notices.at(-1), 'Note deleted.');
  h.replies.push(async () => { throw Object.assign(new Error('This note was not found, or only its author or an administrator can delete it.'), { status: 404, code: 'INBOX_NOTE_NOT_FOUND' }); }, async () => ({ notes: [note('n-3', 'mate')] }));
  deletes(h)[0].props.onClick(); await h.find(ui.ConfirmDialog).props.onConfirm(); await h.step();
  assert.deepEqual(h.calls.slice(2), [[path + '/item-notes/n-1', 'DELETE'], [path + '/item-notes?accountId=tg&kind=conversation&resourceId=thread-1']], 'A missing note reloads that item’s notes.');
  assert.equal(h.errors.at(-1), 'This note was not found, or only its author or an administrator can delete it.'); const html = h.html(); assert.match(html, /Note n-3/); assert.doesNotMatch(html, /Note n-1/);
  const other = await mountNotes(); other.replies.push(async () => structuredClone(listed)); await other.step();
  other.replies.push(async () => { throw Object.assign(new Error('Editing permission is required for this inbox action.'), { status: 403, code: 'WRITE_PERMISSION_REQUIRED' }); });
  deletes(other)[0].props.onClick(); await other.find(ui.ConfirmDialog).props.onConfirm(); assert.equal(other.calls.length, 2, 'Other failures do not reload.'); assert.match(other.html(), /Note n-1/);
});

test('switching item never shows another item’s notes or applies a stale read or add', async () => {
  const h = await mountNotes({ resourceId: 'thread-a' }), first = deferredNote(), second = deferredNote(); h.replies.push(() => first.promise, () => second.promise);
  h.render(); h.flush(); assert.equal(h.calls.length, 1);
  h.render({ resourceId: 'thread-b' }); h.flush(); h.render(); h.flush();
  assert.deepEqual(h.calls.map(call => new URL('https://x.test' + call[0]).searchParams.get('resourceId')), ['thread-a', 'thread-b']);
  first.resolve({ notes: [note('a-1', 'mate', 'Thread A note')] }); await settleNotes(); h.render(); h.flush();
  assert.doesNotMatch(h.html(), /Thread A note/); assert.match(h.html(), /Loading notes…/, 'A stale read is ignored.');
  second.resolve({ notes: [note('b-1', 'mate', 'Thread B note')] }); await h.step(); assert.match(h.html(), /Thread B note/);
  h.render({ accountId: 'other' }); h.flush(); assert.doesNotMatch(h.html(), /Thread B note/, 'Another account starts empty.'); await h.step();
  const add = await mountNotes({ resourceId: 'thread-a' }); await add.step(); add.type('For thread A'); const post = deferredNote(); add.replies.push(() => post.promise);
  const sent = add.submit(); await add.step({ resourceId: 'thread-b' });
  post.resolve({ note: note('a-2', 'me', 'For thread A') }); await sent; add.render();
  assert.doesNotMatch(add.html(), /For thread A/, 'A late add does not appear on another item.'); assert.equal(add.notices.includes('Note added.'), false); assert.equal(add.find(ui.Textarea).props.value, '');
});

// The not-set-up state is one empty state, covered with the running component in inbox-flow-ui.test.ts.
test('the webhook warning offers Open integrations, and Refresh connections reports setup through the status read only', async () => {
  const zernio = section('function ZernioInbox(', '\nfunction ');
  assert.match(zernio, /^function ZernioInbox\(\{[^}]*onOpenIntegrations[^}]*\}/, 'ZernioInbox receives the navigation prop the shell passes.');
  const actionJsx = zernio.match(/const integrationsAction = (onOpenIntegrations \? <Button[^\n]*?<\/Button> : undefined);/)?.[1], warnings = zernio.match(/\{connected && tab !== 'mentions' && status\?\.webhookConfigured === false && <Alert[\s\S]*?<\/Alert>\}/)?.[0];
  assert.ok(actionJsx); assert.ok(warnings);
  const { code } = await transformWithOxc(`const make = onOpenIntegrations => (${actionJsx}); const render = (status, connected, tab, integrationsAction) => (<>${warnings}</>);`, 'InboxSetup.tsx', { jsx: { runtime: 'classic' } });
  const [make, render] = new Function('React', 'Button', 'Alert', `${code}; return [make, render];`)(React, ui.Button, ui.Alert), opened = [], action = make(() => opened.push('Integrations'));
  assert.equal(make(undefined), undefined);
  const webhook = renderToStaticMarkup(render({ configured: true, mapped: true, webhookConfigured: false }, true, 'messages', action));
  assert.equal((webhook.match(/<button[^>]*>Open integrations<\/button>/g) || []).length, 1, 'A set-up inbox without webhooks shows the webhook banner, which links to Integrations.'); assert.match(webhook, /inbox webhooks/);
  action.props.onClick(); assert.deepEqual(opened, ['Integrations']);
  assert.doesNotMatch(renderToStaticMarkup(render({ configured: true, mapped: true, webhookConfigured: false }, true, 'messages', undefined)), /Open integrations/);
  const requests = [], statuses = [];
  const refresh = compile(section('async function loadAccounts(', '  async function changeTriage('), { switchSelection: change => change(), action: async (_, run) => run(1), version: { current: 1 }, path, accountId: '', tab: 'messages', requester: { current: async target => { requests.push(target); return { configured: false, mapped: false, webhookConfigured: false, accounts: [] }; } }, setStatus: value => statuses.push(value), setAccounts() {}, setRows() {}, resetSelection() {}, setAccountId() {} });
  await refresh();
  assert.deepEqual(requests, [path + '/status'], 'The status read reports missing setup as data, so no duplicate error alert is added.'); assert.equal(statuses[0].configured, false);
});
