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

test('actual reply handler uses scoped provider payloads, explicit review replacement approval and preserves failed drafts', async () => {
  const handler = section('async function reply(', '  async function conversationAction(');
  async function run(changes = {}) {
    const calls = [], messages = [], targets = [], notices = [], errors = [];
    const context = { readOnly: false, canReply: true, message: 'Hello there', messageLimit: 10000, accountId: 'account', tab: 'messages', selected: { id: 'opaque/thread ?' }, replyTarget: null, confirmReplace: false, messageTag: 'HUMAN_AGENT', attachmentUrl: '', attachmentType: 'image', attachmentName: '', action: async (_, perform) => perform(1), write: async (...args) => calls.push(args), version: { current: 1 }, setMessage: value => messages.push(value), setAttachmentUrl() {}, setAttachmentName() {}, setMessageTag() {}, setReplyTarget: value => targets.push(value), setConfirmReplace() {}, setNotice: value => notices.push(value), setError: value => errors.push(value), refreshAfterWrite: async () => {}, ...changes };
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
  const context = { tab: 'messages', accountId: 'account/a', conversationStatus: 'archived', requester: { current: async url => { calls.push(url); return { conversations: [{ id: 'one', text: 'fresh' }, { id: 'two' }], pagination: { hasMore: false }, meta: {} }; } }, path, version, merge, setRows: value => { state.rows = typeof value === 'function' ? value(state.rows) : value; }, setPagination() {}, setMeta() {}, setLoaded() {} };
  const list = compile(section('async function fetchList(', '  async function loadList('), context);
  await list(1, 'opaque + cursor'); const query = new URL(calls[0], 'https://app.example').searchParams;
  assert.equal(query.get('accountId'), 'account/a'); assert.equal(query.get('status'), 'archived'); assert.equal(query.get('cursor'), 'opaque + cursor'); assert.deepEqual(state.rows, [{ id: 'one', text: 'fresh' }, { id: 'two' }]);
  version.current = 2; await list(1); assert.equal(state.rows.length, 2);
  const threads = [], details = []; const thread = compile(section('async function fetchThread(', '  async function openItem('), { tab: 'comments', accountId: 'account/a', requester: { current: async url => { threads.push(url); return { comments: [{ id: 'new' }], parent: { id: 'parent' }, pagination: {} }; } }, path, version, merge, setSelected() {}, setFocusedComment() {}, setDetail: update => details.push(update({ comments: [{ id: 'old' }] })) });
  await thread({ id: 'urn:li:share:123/opaque' }, 2, 'next', 'comment/parent'); const threadQuery = new URL(threads[0], 'https://app.example').searchParams;
  assert.equal(threadQuery.get('postId'), 'urn:li:share:123/opaque'); assert.equal(threadQuery.get('commentId'), 'comment/parent'); assert.deepEqual(details[0].comments.map(item => item.id), ['old', 'new']);
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
  const context = { selected, focusedComment: '', tab: 'messages', version: { current: 1 }, action: async (_, run) => run(1), fetchThread: async () => {}, setReplyTarget() {}, setMessage: value => cleared.push(value), setConfirmReplace() {}, setMessageTag() {}, setAttachmentUrl() {}, setAttachmentName() {} };
  const open = compile(section('async function openItem(', '  async function refreshAfterWrite('), context);
  await open(selected); assert.deepEqual(cleared, []); await open({ id: 'different-thread' }); assert.deepEqual(cleared, ['']);
  const refresh = compile(section('async function refreshAfterWrite(', '  function prepareReply('), { tab: 'messages', selected, focusedComment: '', version: { current: 1 }, fetchThread: async () => { throw new Error('Provider read failed'); }, setError: value => errors.push(value) });
  await refresh(1); assert.match(errors[0], /change was confirmed/);
});

test('webhook polling reads only the local update feed until new relevant activity arrives', async () => {
  const handler = section('const poll = async () =>', '    void poll();').replace('const poll = ', '').trim().replace(/;$/, ''), calls = [], refreshed = [];
  const responses = [{ updates: [], cursor: 8 }, { updates: [{ event: 'comment.received' }], cursor: 9 }, { updates: [{ event: 'message.received' }], cursor: 10 }];
  const context = { checking: false, pending: { current: false }, requester: { current: async url => { calls.push(url); return responses.shift(); } }, path, accountId: 'account', cursor: undefined, closed: false, generation: 1, version: { current: 1 }, tab: 'messages', loaded: true, selected: { id: 'thread' }, focusedComment: '', action: async (_, run) => run(1), fetchList: async () => refreshed.push('list'), fetchThread: async () => refreshed.push('thread'), setNotice() {} };
  const poll = compile(handler, context); await poll(); await poll(); assert.deepEqual(refreshed, []); await poll(); assert.deepEqual(refreshed, ['list', 'thread']);
  assert.equal(new URL(calls[0], 'https://app.example').searchParams.has('after'), false); assert.equal(new URL(calls[1], 'https://app.example').searchParams.get('after'), '8'); assert.ok(calls.every(url => url.startsWith(path + '/updates?')));
  await compile(handler, { ...context, pending: { current: true } })(); assert.equal(calls.length, 3);
});

test('the actual action lock rejects double clicks and stale operation results do not alter a new project', async () => {
  const pending = { current: false }, version = { current: 1 }, busy = [], errors = [];
  const action = compile(section('async function action(', '  async function write('), { pending, version, setBusy: value => busy.push(value), setError: value => errors.push(value), setNotice() {} });
  let finish, sends = 0; const first = action('Replying', async () => { sends++; await new Promise(resolve => { finish = resolve; }); }); await action('Reply again', async () => { sends++; }); assert.equal(sends, 1);
  version.current = 2; finish(); await first; assert.deepEqual(busy, ['Replying']); assert.deepEqual(errors, ['']);
});
