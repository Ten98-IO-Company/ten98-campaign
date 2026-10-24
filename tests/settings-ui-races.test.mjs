import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { workspaceRoles } from '../src/workspace-roles.ts';

const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
class FormValues { constructor(values) { return new Map(Object.entries(values)); } }
const event = values => ({ preventDefault() {}, currentTarget: { reset() {}, ...values } });

// Run the actual component handlers with controlled requests; no provider, DOM or copied loader logic.
async function view(file, names, request, initial = {}) {
  const source = await readFile(new URL(`../src/${file}.tsx`, import.meta.url), 'utf8'), start = source.indexOf('export default function '), end = source.indexOf('  return <', start);
  const state = [], effects = [], refs = [], reloads = [];
  const context = {
    useState(value) { const index = state.length; state.push(Object.hasOwn(initial, index) ? initial[index] : value); return [state[index], next => { state[index] = typeof next === 'function' ? next(state[index]) : next; }]; },
    useRef(value) { const ref = { current: value }; refs.push(ref); return ref; }, useEffect(run) { effects.push(run); },
    FormData: FormValues, window: { confirm: () => true, location: { reload: () => reloads.push(file) } }, crypto, DOMException,
    // Imported app helpers (TeamSettings): the real role list, and a focus-return hook without a DOM.
    workspaceRoles, useFocusReturn: () => () => {}, document: { getElementById: () => null },
    lines: value => String(value || '').split('\n').map(line => line.trim()).filter(Boolean),
    // Pure module-level helpers the component body calls (ContentApprovals), taken from the real source.
    ...Object.fromEntries(['approveBlocked', 'postName', 'reviewItem'].flatMap(name => { const line = source.match(new RegExp(`^const ${name} = (.+);$`, 'm')); return line ? [[name, new Function('return ' + stripTypeScriptTypes(line[1]))()]] : []; })),
  };
  const component = new Function(...Object.keys(context), `return (${stripTypeScriptTypes(source.slice(start, end).replace('export default ', '') + `return { ${names.join(', ')} };\n}`)});`)(...Object.values(context));
  const handlers = component({ projectId: 'project', workspaceId: 'workspace', role: 'owner', isOperator: true, currentUserId: 'self', request });
  return { ...handlers, state, refs, reloads, mount: () => effects.map(run => run()), errors: () => state[file === 'TeamSettings' ? 4 : file === 'ContentApprovals' ? 2 : 3] };
}

test('Microsoft create and edit cannot be overwritten by an older campaign read or its late failure', async () => {
  for (const action of ['create', 'change']) for (const lateFailure of [false, true]) {
    const list = deferred(), write = deferred(), old = { id: 'campaign', name: 'Old', status: 'Paused', dailyBudget: 10 }, confirmed = { ...old, name: 'Confirmed', status: 'Active', dailyBudget: 20 };
    const ui = await view('MicrosoftAds', ['load', 'create', 'change'], async (path, method) => method === 'POST' ? write.promise : path.endsWith('/status') ? { configured: true, mapping: {}, latestReport: null } : list.promise, { 1: [old] });
    const cleanup = ui.mount(); await tick();
    const saving = action === 'create' ? ui.create(event({ name: 'Confirmed', dailyBudget: '20', maxCpc: '1', finalUrl: 'https://example.com', headlines: 'One\nTwo\nThree', descriptions: 'First\nSecond', keywords: 'planner', matchType: 'Exact', locationIds: '1' })) : ui.change(old, { status: 'Active', dailyBudget: 20, confirmed: true });
    if (action === 'create') { if (lateFailure) list.reject(new Error('Obsolete campaign failure')); else list.resolve({ campaigns: [] }); await tick(); assert.deepEqual(ui.state[1], [old]); assert.equal(ui.errors(), ''); }
    write.resolve({ providerCampaign: confirmed, campaign: confirmed }); await saving;
    if (action === 'change') { if (lateFailure) list.reject(new Error('Obsolete campaign failure')); else list.resolve({ campaigns: [old] }); }
    await tick();
    assert.deepEqual(ui.state[1], [confirmed], `${action} keeps its confirmed receipt`); assert.equal(ui.errors(), '');
    cleanup.forEach(close => close?.());
  }
});

test('Microsoft fresh refresh/report actions ignore older account reads and closed views ignore failures', async () => {
  for (const action of ['refresh', 'requestReport', 'refreshReport']) for (const lateFailure of [false, true]) {
    const old = deferred(), fresh = { id: 'new-report', status: 'Pending' }; let reads = 0;
    const ui = await view('MicrosoftAds', ['load', 'action', 'requestReport', 'refreshReport'], async (path, method) => {
      if (path.endsWith('/status')) return ++reads === 1 ? old.promise : { configured: false, mapping: null, latestReport: fresh };
      assert.match(path, /\/reports(?:\/existing)?$/); return { report: fresh };
    }, action === 'refreshReport' ? { 5: { id: 'existing', status: 'Pending' } } : {});
    ui.mount();
    await (action === 'refresh' ? ui.action(ui.load) : action === 'requestReport' ? ui.requestReport(event({ fromDate: '2026-01-01', toDate: '2026-01-02' })) : ui.refreshReport());
    if (lateFailure) old.reject(new Error('Obsolete account failure')); else old.resolve({ configured: true, mapping: {}, latestReport: { id: 'old-report' } });
    await tick(); assert.deepEqual(ui.state[5], fresh); assert.equal(ui.errors(), '');
  }
  const old = deferred(), ui = await view('MicrosoftAds', ['load'], () => old.promise), cleanup = ui.mount(); cleanup.forEach(close => close?.()); old.reject(new Error('Closed')); await tick(); assert.equal(ui.errors(), '');
});

test('invitation create/revoke invalidate an older list before the write and keep the refreshed list', async () => {
  for (const action of ['invite', 'revoke']) for (const lateFailure of [false, true]) for (const completes of ['during', 'after']) {
    const old = deferred(), write = deferred(), fresh = [{ id: 'new', status: action === 'invite' ? 'pending' : 'revoked' }]; let reads = 0;
    const ui = await view('TeamSettings', ['load', 'invite', 'revoke'], async (path, method) => method ? write.promise : path.endsWith('/members') ? { members: [] } : ++reads === 1 ? old.promise : { invitations: fresh });
    const cleanup = ui.mount();
    const saving = action === 'invite' ? ui.invite({ email: 'person@example.com', role: 'editor' }) : ui.revoke({ id: 'old' });
    if (completes === 'during') { if (lateFailure) old.reject(new Error('Obsolete invitation failure')); else old.resolve({ invitations: [{ id: 'old', status: 'pending' }] }); await tick(); assert.deepEqual(ui.state[1], []); assert.equal(ui.errors(), ''); }
    write.resolve({ invitation: fresh[0], url: 'https://example.com/invite/new' }); await saving;
    if (completes === 'after') { if (lateFailure) old.reject(new Error('Obsolete invitation failure')); else old.resolve({ invitations: [{ id: 'old', status: 'pending' }] }); await tick(); }
    assert.deepEqual(ui.state[1], fresh); assert.equal(ui.errors(), ''); if (action === 'invite') assert.equal(ui.state[2].id, 'new');
    cleanup.forEach(close => close?.());
  }
});

test('recovery refresh/review keep the latest receipt list and suppress obsolete failures', async () => {
  for (const action of ['refresh', 'review']) for (const lateFailure of [false, true]) {
    const old = deferred(), write = deferred(), fresh = [{ id: 'receipt', status: 'reviewed-applied' }]; let reads = 0;
    const ui = await view('OperationRecovery', ['load', 'refresh', 'review'], async (_path, method) => method ? write.promise : ++reads === 1 ? old.promise : { operations: fresh }, { 1: { id: 'receipt' } });
    const cleanup = ui.mount();
    const saving = action === 'refresh' ? ui.refresh() : ui.review(event({ resolution: 'applied', note: 'Checked the provider directly.', reference: 'remote', confirmChecked: 'on' }));
    if (action === 'review') { if (lateFailure) old.reject(new Error('Obsolete receipt failure')); else old.resolve({ operations: [{ id: 'receipt', status: 'uncertain' }] }); await tick(); assert.deepEqual(ui.state[0], []); write.resolve({ message: 'Review recorded.' }); }
    await saving;
    if (action === 'refresh') { if (lateFailure) old.reject(new Error('Obsolete receipt failure')); else old.resolve({ operations: [{ id: 'receipt', status: 'uncertain' }] }); }
    await tick(); assert.deepEqual(ui.state[0], fresh); assert.equal(ui.errors(), '');
    cleanup.forEach(close => close?.());
  }
});

test('approval refresh and review actions invalidate the old queue without hiding current errors', async () => {
  for (const action of ['refresh', 'review']) for (const lateFailure of [false, true]) {
    const old = deferred(), write = deferred(), item = { post: { id: 'post' }, review: { id: 'review' }, status: 'pending' }, fresh = { requireApproval: true, posts: [{ ...item, status: 'approved' }] }; let reads = 0;
    const ui = await view('ContentApprovals', ['load', 'action', 'review'], async (_path, method) => method ? write.promise : ++reads === 1 ? old.promise : fresh, { 0: { requireApproval: false, posts: [item] } });
    const cleanup = ui.mount();
    const saving = action === 'refresh' ? ui.action('refresh', ui.load) : ui.review(item, 'approved');
    if (action === 'review') { if (lateFailure) old.reject(new Error('Obsolete queue failure')); else old.resolve({ requireApproval: false, posts: [{ ...item, post: { id: 'obsolete' } }] }); await tick(); assert.equal(ui.state[0].posts[0].post.id, 'post'); write.resolve({ item: fresh.posts[0] }); }
    await saving;
    if (action === 'refresh') { if (lateFailure) old.reject(new Error('Obsolete queue failure')); else old.resolve({ requireApproval: false, posts: [item] }); }
    await tick(); assert.deepEqual(ui.state[0], fresh); assert.equal(ui.errors(), '');
    cleanup.forEach(close => close?.());
  }
  const ui = await view('ContentApprovals', ['load', 'action'], async () => { throw new Error('Current queue failure'); });
  await ui.action('refresh', ui.load); assert.equal(ui.errors(), 'Current queue failure');
});

test('invitation, recovery and approval loaders ignore errors after their view closes', async () => {
  for (const file of ['TeamSettings', 'OperationRecovery', 'ContentApprovals']) {
    const old = deferred(), ui = await view(file, ['load'], () => old.promise), cleanup = ui.mount(); cleanup.forEach(close => close?.()); old.reject(new Error('Closed view failure')); await tick(); assert.equal(ui.errors(), '');
  }
});

test('current list failures still surface and malformed permission-scoped lists are rejected', async () => {
  for (const file of ['MicrosoftAds', 'TeamSettings', 'OperationRecovery', 'ContentApprovals']) {
    const ui = await view(file, ['load'], async () => { throw new Error('Current read failed'); }); ui.mount(); await tick(); assert.equal(ui.errors(), 'Current read failed');
  }
  for (const file of ['TeamSettings', 'OperationRecovery']) {
    const ui = await view(file, ['load'], async () => ({})); await assert.rejects(ui.load(), /could not be read/);
  }
});

test('a queued action invalidates a rejected initial read before its outer error handler runs', async () => {
  for (const file of ['MicrosoftAds', 'TeamSettings', 'OperationRecovery', 'ContentApprovals']) {
    const old = deferred(); let reads = 0, saving;
    const ui = await view(file, file === 'TeamSettings' ? ['invite'] : file === 'OperationRecovery' ? ['refresh'] : ['action'], (_path, method) => {
      if (method) return Promise.resolve({ invitation: { id: 'new' }, url: 'https://example.com/invite/new' });
      if (++reads === 1) return old.promise;
      return Promise.resolve({ invitations: [], operations: [], members: [] });
    });
    ui.mount(); old.reject(new Error('Obsolete queued error'));
    queueMicrotask(() => { saving = file === 'TeamSettings' ? ui.invite({ email: 'person@example.com', role: 'editor' }) : file === 'OperationRecovery' ? ui.refresh() : file === 'MicrosoftAds' ? ui.action(async () => {}) : ui.action('policy', async () => {}); });
    await tick(); await saving; assert.equal(ui.errors(), '', file);
  }
});

test('team changes reload the app only for your own membership and never after Settings closes', async () => {
  for (const action of ['changeRole', 'remove']) for (const id of ['self', 'colleague']) for (const closed of [false, true]) {
    const write = deferred(); let reads = 0;
    const ui = await view('TeamSettings', ['changeRole', 'remove'], async (path, method) => method ? write.promise : (reads++, path.endsWith('/members') ? { members: [] } : { invitations: [] }));
    const cleanup = ui.mount(); await tick(); const before = reads;
    const saving = ui[action]({ id, role: 'viewer' }); if (closed) cleanup.forEach(close => close?.());
    write.resolve({ ok: true }); await saving;
    assert.deepEqual(ui.reloads, !closed && id === 'self' ? ['TeamSettings'] : [], `${action} ${id} closed=${closed}`);
    assert.equal(reads - before, !closed && id === 'colleague' ? 2 : 0, 'Only a current colleague change refreshes the team.');
  }
});
