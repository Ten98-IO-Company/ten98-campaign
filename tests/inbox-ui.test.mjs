import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

const source = await readFile(new URL('../src/UnifiedInbox.tsx', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
function compile(code, context = {}) { return new Function(...Object.keys(context), `return (${stripTypeScriptTypes(code)});`)(...Object.values(context)); }
const event = { preventDefault() {} }, path = '/projects/project-a/integrations/inbox';
const merge = (before, after) => [...new Map([...before, ...after].map(row => [row.id, row])).values()];

test('actual inbox writer retains the same operation key after an uncertain reply and blocks viewers', async () => {
  const keys = { current: new Map() }, calls = [];
  let fail = true;
  const context = { readOnly: false, path, keys, crypto, requester: { current: async (...args) => { calls.push(args); if (fail) throw new Error('Connection lost'); return { success: true }; } } };
  const write = compile(section('async function write(', '  async function loadAccounts('), context);
  await assert.rejects(write('conversations/thread/reply', { accountId: 'account', message: 'Hello' }), /Connection lost/);
  fail = false; await write('conversations/thread/reply', { accountId: 'account', message: 'Hello' });
  assert.equal(calls[0][3], calls[1][3]); assert.equal(keys.current.size, 0); assert.equal(calls[0][0], path + '/conversations/thread/reply');
  await write('conversations/thread/reply', { accountId: 'account', message: 'Hello again' }); assert.notEqual(calls[1][3], calls[2][3]);
  await assert.rejects(compile(section('async function write(', '  async function loadAccounts('), { ...context, readOnly: true })('any', {}), /cannot send/); assert.equal(calls.length, 3);
});

test('full-history search uses the actual provider search loader, preserves page cursors and ignores previous-account results', async () => {
  const calls = [], rows = [], version = { current: 3 }, filters = [], context = { tab: 'messages', accountId: 'account/one', historyFilter: { query: 'old invoice', direction: 'incoming' }, conversationStatus: 'active', requester: { current: async route => { calls.push(route); return { conversations: [{ id: 'older-thread', matchCount: 1, matches: [{ id: 'old', text: 'old invoice' }] }], pagination: { hasMore: true, nextCursor: 'opaque +/' }, meta: { accountsSkipped: [] } }; } }, path, version, merge, setRows: value => rows.push(typeof value === 'function' ? value([]) : value), setPagination() {}, setMeta() {}, setLoaded() {} };
  const fetchList = compile(section('async function fetchList(', '  async function loadList('), context);
  await fetchList(3, 'opaque +/'); const query = new URL(calls[0], 'https://app.example').searchParams; assert.equal(query.get('cursor'), 'opaque +/'); assert.equal(query.get('query'), 'old invoice'); assert.equal(query.get('direction'), 'incoming'); assert.equal(query.has('status'), false); assert.match(calls[0], /conversations\/search\?/); assert.equal(rows[0][0].matches[0].text, 'old invoice');
  version.current = 4; await fetchList(3); assert.equal(rows.length, 1);
  const search = compile(section('async function searchHistory(', '  async function prepareConversation('), { tab: 'messages', accountId: 'account/one', pending: { current: false }, historyQuery: '  old invoice  ', historyDirection: 'outgoing', version, setError() {}, action: async (_, run) => run(version.current), fetchList: async (...args) => filters.push(args), setHistoryFilter: value => filters.push(value), resetSelection: () => filters.push('selection cleared') });
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
  const send = changes => compile(section('async function startConversation(', '  async function fetchList('), { ...context, ...changes })(event);
  for (const changes of [{ confirmSend: false }, { readOnly: true }, { recipient: '' }, { openingMessage: '' }]) await send(changes); assert.equal(calls.length, 0);
  await assert.rejects(send({ write: async () => { throw new Error('Outcome uncertain'); } }), /uncertain/); assert.deepEqual(changed, [], 'An uncertain write retains recipient, text and reviewed state for recovery.');
  await send(); assert.deepEqual(calls[0], ['conversations/start', { accountId: 'x-account', participantUsername: '@alex', message: 'Hello Alex', confirmSend: true }]); assert.deepEqual(changed, [false, '', '']); assert.match(notices[0], /accepted/); assert.match(errors.at(-1), /was accepted/);
  const listed = []; await send({ historyFilter: null, conversationStatus: 'active', merge, fetchThread: async () => ({ id: 'existing-or-new', status: 'active', lastMessageAt: '2026-10-18T12:00:00Z' }), setRows: update => listed.push(update([{ id: 'old-thread' }])) }); assert.equal(listed[0][0].id, 'existing-or-new', 'A newly read-back conversation appears in the normal conversation list immediately.');
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
    const context = { account: {}, templateMode: false, selectedTemplate: null, templateComponents: [], templateRestriction: () => '', resetTemplate() {}, readOnly: false, canReply: true, message: 'Hello there', messageLimit: 10000, accountId: 'account', tab: 'messages', selected: { id: 'opaque/thread ?' }, replyTarget: null, confirmReplace: false, messageTag: 'HUMAN_AGENT', attachmentUrl: '', attachmentType: 'image', attachmentName: '', action: async (_, perform) => perform(1), write: async (...args) => calls.push(args), version: { current: 1 }, setMessage: value => messages.push(value), setAttachmentUrl() {}, setAttachmentName() {}, setMessageTag() {}, setReplyTarget: value => targets.push(value), setConfirmReplace() {}, setNotice: value => notices.push(value), setError: value => errors.push(value), refreshAfterWrite: async () => {}, ...changes };
    await compile(handler, context)(event); return { calls, messages, targets, notices, errors };
  }
  const dm = await run(); assert.deepEqual(dm.calls[0], ['conversations/opaque%2Fthread%20%3F/reply', { accountId: 'account', message: 'Hello there', messageTag: 'HUMAN_AGENT' }]); assert.deepEqual(dm.messages, ['']);
  const file = await run({ message: '', messageTag: '', attachmentUrl: 'https://cdn.example.com/file.pdf', attachmentType: 'file', attachmentName: 'receipt.pdf' }); assert.equal(file.calls[0][1].attachmentName, 'receipt.pdf');
  const oversized = await run({ messageLimit: 10 }); assert.equal(oversized.calls.length, 0); assert.match(oversized.errors[0], /10 characters/); assert.deepEqual(oversized.messages, []);
  const tiktok = await run({ attachmentUrl: 'https://cdn.example.com/image.jpg', messageLimit: 0 }); assert.equal(tiktok.calls.length, 0); assert.match(tiktok.errors[0], /without text/);
  const partial = await run({ write: async () => ({ partialFailure: true, warnings: [{ message: 'File was not delivered' }] }) }); assert.match(partial.notices[0], /only part/); assert.equal(partial.errors[0], 'File was not delivered'); assert.deepEqual(partial.messages, ['']);
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
  const context = { historyFilter: null, tab: 'messages', accountId: 'account/a', conversationStatus: 'archived', requester: { current: async url => { calls.push(url); return { conversations: [{ id: 'one', text: 'fresh' }, { id: 'two' }], pagination: { hasMore: false }, meta: {} }; } }, path, version, merge, setRows: value => { state.rows = typeof value === 'function' ? value(state.rows) : value; }, setPagination() {}, setMeta() {}, setLoaded() {} };
  const list = compile(section('async function fetchList(', '  async function loadList('), context);
  await list(1, 'opaque + cursor'); const query = new URL(calls[0], 'https://app.example').searchParams;
  assert.equal(query.get('accountId'), 'account/a'); assert.equal(query.get('status'), 'archived'); assert.equal(query.get('cursor'), 'opaque + cursor'); assert.deepEqual(state.rows, [{ id: 'one', text: 'fresh' }, { id: 'two' }]);
  version.current = 2; await list(1); assert.equal(state.rows.length, 2);
  const threads = [], details = []; const thread = compile(section('async function fetchThread(', '  async function openItem('), { tab: 'comments', accountId: 'account/a', requester: { current: async url => { threads.push(url); return { comments: [{ id: 'new' }], parent: { id: 'parent' }, pagination: {} }; } }, path, version, merge, setSelected() {}, setFocusedComment() {}, setDetail: update => details.push(update({ comments: [{ id: 'old' }] })) });
  await thread({ id: 'urn:li:share:123/opaque' }, 2, 'next', 'comment/parent'); const threadQuery = new URL(threads[0], 'https://app.example').searchParams;
  assert.equal(threadQuery.get('postId'), 'urn:li:share:123/opaque'); assert.equal(threadQuery.get('commentId'), 'comment/parent'); assert.deepEqual(details[0].comments.map(item => item.id), ['old', 'new']);
});

test('approved WhatsApp reply templates use their exact account/language and exclude free text or attachment drafts', async () => {
  const calls = [], notices = [], errors = [], resets = [], selectedTemplate = { name: 'service_update', language: 'en_GB' }, templateComponents = [{ type: 'body', parameters: [{ type: 'text', text: 'Jordan' }] }];
  const context = { readOnly: false, canReply: true, account: { platform: 'whatsapp' }, templateMode: true, selectedTemplate, templateComponents, templateRestriction: () => '', message: 'Preserved text draft', attachmentUrl: 'https://example.com/file.pdf', attachmentType: 'file', attachmentName: 'draft.pdf', messageLimit: 0, messageTag: 'HUMAN_AGENT', accountId: 'whatsapp-account', tab: 'messages', selected: { id: 'closed/thread' }, replyTarget: null, confirmReplace: false, action: async (_, run) => run(1), write: async (...args) => { calls.push(args); return { sent: true }; }, version: { current: 1 }, setMessage() {}, setAttachmentUrl() {}, setAttachmentName() {}, setMessageTag() {}, setReplyTarget() {}, setConfirmReplace() {}, resetTemplate: () => resets.push(true), setNotice: value => notices.push(value), setError: value => errors.push(value), refreshAfterWrite: async () => {} };
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
  const context = { selected, readOnly: false, conversationStatus: 'active', accountId: 'account', version: { current: 1 }, action: async (_, run) => run(1), write: async (...args) => calls.push(args), setSelected() {}, setRows: update => rows.push(update([selected])), setNotice() {} };
  const change = compile(section('async function conversationAction(', '  async function commentAction('), context);
  await change('read'); assert.deepEqual(calls[0], ['conversations/thread%2Fopaque/read', { accountId: 'account' }]); assert.equal(rows[0][0].unreadCount, 0);
  await change('status'); assert.deepEqual(calls[1][1], { accountId: 'account', status: 'archived' }); assert.deepEqual(rows[1], []);
  const reopened = [], archiveContext = { ...context, selected: { ...selected, status: 'archived' }, setRows: update => reopened.push(update([])) };
  await compile(section('async function conversationAction(', '  async function commentAction('), archiveContext)('status'); assert.equal(reopened[0][0].id, selected.id); assert.equal(reopened[0][0].status, 'active');
  const readArchived = []; await compile(section('async function conversationAction(', '  async function commentAction('), { ...archiveContext, setRows: update => readArchived.push(update([])) })('read'); assert.deepEqual(readArchived[0], [], 'Marking the archived selected thread read must not insert it into the active list.');
  let confirmed = false; const comment = compile(section('async function commentAction(', '  async function deleteReviewReply('), { ...context, window: { confirm: () => confirmed }, refreshAfterWrite: async () => {} });
  await comment('delete', { id: 'comment' }); assert.equal(calls.length, 4); confirmed = true; await comment('delete', { id: 'comment' }); assert.deepEqual(calls[4], ['comments/delete', { accountId: 'account', postId: selected.id, commentId: 'comment' }]);
  const remove = compile(section('async function deleteReviewReply(', '  return <div className="unified-inbox">'), { ...context, window: { confirm: () => confirmed }, setReplyTarget() {}, setMessage() {}, refreshAfterWrite: async () => {} });
  await remove({ id: 'review', replyVersion: 'version' }); assert.deepEqual(calls[5], ['reviews/delete-reply', { accountId: 'account', reviewId: 'review', expectedReplyVersion: 'version', confirmReplace: true }]);
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
  const context = { selected, focusedComment: '', tab: 'messages', version: { current: 1 }, action: async (_, run) => run(1), fetchThread: async () => {}, resetTemplate() {}, setReplyTarget() {}, setMessage: value => cleared.push(value), setConfirmReplace() {}, setMessageTag() {}, setAttachmentUrl() {}, setAttachmentName() {} };
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
  const handler = section('async function sendSms(', '  return <div className="unified-inbox inbox-sms">'), calls = [], messages = [], notices = [], keys = { current: new Map() }, selected = { id: 'sms-thread', participantId: '+971501234567', sender: '+12025550123' };
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
  const open = compile(part('async function openSms(', '  useEffect(() => {'), { ...common, smsAction, smsThread });
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
