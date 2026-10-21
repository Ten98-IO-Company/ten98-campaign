import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../server/database.ts';
import { handleOoh } from '../server/ooh.ts';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { blockWrites, postgresSkip, testDatabase } from './postgres.mjs';

async function fixture(t, run) {
  const { pool, db, sql } = await testDatabase(t), originalFetch = globalThis.fetch, project = { id: 'ooh-audit' };
  await pool.query("INSERT INTO workspaces (id, name) VALUES ('w','W'); INSERT INTO projects (id, workspace_id, name) VALUES ('ooh-audit','w','OOH audit')");
  const store = createStore(db), calls = [], state = { providerStatus: 1, proposal: null, item: null, beforeBookResponse: null, beforeItemResponse: null, malformed: undefined, raw: undefined };
  globalThis.fetch = async (target, options) => {
    const path = new URL(target).pathname, payload = options.body && JSON.parse(options.body); calls.push({ path, payload }); let result;
    if (path === '/api/v1/user/current_user') result = { id: 1, domain_id: 7 };
    else if (path.startsWith('/api/v1/screen/')) result = { id: Number(path.split('/').at(-1)), domain_id: 7, name: 'Approved screen' };
    else if (path === '/api/v1/proposal') { await state.beforeProposalResponse?.(); result = state.proposal = { ...payload, id: 800, domain_id: 7, proposal_item_id_list: [], status: 1 }; }
    else if (path === '/api/v1/proposal/add_screens') { result = state.item = { ...payload, id: 1800 }; state.proposal.proposal_item_id_list = [1800]; }
    else if (path === '/api/v1/proposal/800' && state.raw !== undefined) return new Response(state.raw);
    else if (path === '/api/v1/proposal/800') result = state.malformed !== undefined ? state.malformed : { ...state.proposal, status: state.providerStatus };
    else if (path === '/api/v1/proposal/proposal_item/1800') { await state.beforeItemResponse?.(); result = state.item; }
    else if (path.endsWith('/availability')) result = { proposal_id: 800, availability: 'available', requested_screen_count: 2, bookable_screen_count: 2 };
    else if (path === '/api/v1/proposal/book_proposal/800') { state.providerStatus = 9; await state.beforeBookResponse?.(); result = { success: true }; }
    else if (path === '/api/v1/proposal/proposal_item/1800/cancel') { state.providerStatus = 15; return new Response(null, { status: 204 }); }
    else throw new Error(`Unexpected provider path ${path}`);
    return new Response(JSON.stringify(result));
  };
  async function invoke(path, method = 'GET', body = {}, key = 'ooh-audit-default') {
    let response;
    await handleOoh({ db, store, project, req: { method, headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${project.id}/ooh/${path}`), body, role: 'owner', user: { isOperator: true }, config: { env: {}, BROADSIGN_API_KEY: 'mock-key' }, send(status, data) { response = { status, data }; } });
    return response;
  }
  try {
    assert.equal((await invoke('connection', 'POST', { domainId: 7, clientId: 'brand', clientName: 'Brand', screenIds: [101, 102] })).status, 200);
    assert.equal((await invoke('sync', 'POST')).status, 200);
    const result = await invoke('bookings', 'POST', { name: 'Exact OOH terms', screenIds: [101, 102], startDate: '2026-10-20', endDate: '2026-10-22', slotDuration: 10, inventoryType: 'digital', price: 150 }, 'ooh-audit-draft');
    assert.equal(result.status, 200); const booking = result.data.booking;
    await run({ pool, sql, store, state, calls, invoke, booking, bookingPath: `bookings/${booking.id}` });
  } finally { globalThis.fetch = originalFetch; }
}

test('OOH preflight rejects duplicate screens and changed delivery terms before paid submission', { skip: postgresSkip }, async t => {
  await fixture(t, async ({ state, calls, invoke, bookingPath }) => {
    const original = structuredClone(state.item);
    for (const [label, change] of [
      ['duplicate screen', { screens: [101, 101] }], ['duration', { slot_duration: 30 }], ['inventory type', { inventory_type: 'static' }],
      ['day part', { start_time: '12:00:00' }], ['weekdays', { dow_mask: 1 }], ['frequency', { saturation: 2 }],
      ['buy mode', { mode: [{ type: 'sov', active: true, values: { sov: 50 } }] }],
      ['flight', { flight_duration: 2 }], ['day multiplier', { multiplier: 1 }],
    ]) {
      state.item = { ...original, ...change };
      const result = await invoke(bookingPath + '/submit', 'POST', { confirmBooking: true }, `ooh-audit-${label.replaceAll(' ', '-')}`);
      assert.equal(result.status, 409, `${label} must require review before booking`);
      assert.equal(result.data.error.code, 'OOH_BOOKING_CHANGED');
      assert.equal(calls.filter(call => call.path.includes('/book_proposal/')).length, 0);
    }
    state.item = { ...original, screens: [102, 101], slot_duration: '10.0', mode: [{ type: 'sov', active: false, values: { sov: 15 } }, { type: 'ppl', active: true, values: { saturation: 1, bs_saturation: 1, projected_repetitions: 0 } }] };
    const result = await invoke(bookingPath + '/submit', 'POST', { confirmBooking: true }, 'ooh-audit-valid');
    assert.equal(result.status, 200); assert.equal(calls.filter(call => call.path.includes('/book_proposal/')).length, 1);
  });
});

test('OOH inventory refreshes cannot update a departed view or make more requests after unmount', async () => {
  const source = await readFile(new URL('../src/OohProviders.tsx', import.meta.url), 'utf8');
  const handler = stripTypeScriptTypes(source.slice(source.indexOf('async function load()'), source.indexOf('  async function refresh()')));
  const active = { current: true }, pending = [], accepted = [], local = [], callbacks = { current: items => accepted.push(items) };
  const compile = mode => new Function('active', 'request', 'path', 'setStatus', 'setInventory', 'setBookings', 'setSelected', 'inventoryCallback', 'mode', `return (${handler});`)(active, () => new Promise(resolve => pending.push(resolve)), '/projects/ooh-audit/ooh', value => local.push(value), value => local.push(value), value => local.push(value), () => {}, callbacks, mode);
  const load = compile('workflow');
  const first = load(); active.current = false;
  pending[0]({ configured: true }); pending[1]({ inventory: [{ id: 101 }] }); pending[2]({ bookings: [] });
  await assert.rejects(first, { name: 'AbortError' });
  assert.deepEqual(accepted, []); assert.deepEqual(local, []);
  await assert.rejects(load(), { name: 'AbortError' }); assert.equal(pending.length, 3);
  active.current = true; const current = load();
  pending[3]({ configured: true }); pending[4]({ inventory: [{ id: 102 }] }); pending[5]({ bookings: [] });
  await current; assert.deepEqual(accepted, [[{ id: 102 }]]); assert.equal(local.length, 3);
  const setup = compile('connection'), connecting = setup();
  assert.equal(pending.length, 8, 'Central setup reads status and booking locks, without requesting feature inventory.');
  pending[6]({ configured: true }); pending[7]({ bookings: [] });
  await connecting; assert.deepEqual(accepted.at(-1), []);
});

test('OOH booking acknowledgement and final readback cannot erase a concurrent cancellation receipt', { skip: postgresSkip }, async t => {
  for (const phase of ['acknowledgement', 'final readback']) await fixture(t, async ({ sql, store, state, calls, invoke, booking, bookingPath }) => {
    let cancellation;
    const cancel = async () => {
      cancellation = await invoke(bookingPath + '/cancel', 'POST', { confirmCancellation: true }, 'ooh-audit-cancel');
      assert.equal(cancellation.status, 200); assert.equal(cancellation.data.booking.stage, 'cancelling');
    };
    if (phase === 'acknowledgement') state.beforeBookResponse = cancel;
    else state.beforeItemResponse = async () => {
      if ((await sql.get('SELECT data FROM project_ooh_bookings WHERE id=?', booking.id)).data.stage !== 'submitted') return;
      state.beforeItemResponse = null; await cancel();
    };
    const result = await invoke(bookingPath + '/submit', 'POST', { confirmBooking: true }, 'ooh-audit-submit');
    assert.equal(result.status, 409, phase); assert.equal(result.data.operation.status, 'uncertain');
    const saved = (await sql.get('SELECT data FROM project_ooh_bookings WHERE id=?', booking.id)).data;
    assert.equal(saved.stage, 'cancelling'); assert.equal(saved.cancellationOperationId, cancellation.data.operation.id);
    assert.equal(saved.providerStatus, 15);
    const placements = await store.list('ooh-audit', 'placements');
    assert.equal(placements.length, 2); assert.equal(placements.every(placement => placement.providerStatus === 15), true);
    const retry = await invoke(bookingPath + '/cancel', 'POST', { confirmCancellation: true }, 'ooh-audit-again');
    assert.equal(retry.status, 200); assert.equal(calls.filter(call => call.path.endsWith('/cancel')).length, 1);
  });
});

test('OOH malformed provider JSON yields a controlled error without changing saved bookings', { skip: postgresSkip }, async t => {
  await fixture(t, async ({ sql, state, invoke, booking, bookingPath }) => {
    const before = (await sql.get('SELECT data::text AS data FROM project_ooh_bookings WHERE id=?', booking.id)).data;
    for (const malformed of [null, [], true, 1, 'wrong response']) {
      state.malformed = malformed;
      const result = await invoke(bookingPath + '/report');
      assert.equal(result.status, 502); assert.equal(result.data.error.code, 'INVALID_OOH_RESPONSE');
      assert.equal((await sql.get('SELECT data::text AS data FROM project_ooh_bookings WHERE id=?', booking.id)).data, before);
    }
  });
});

test('OOH provider bodies over 2 MiB, with a BOM or with malformed UTF-8 are refused without changing saved bookings', { skip: postgresSkip }, async t => {
  await fixture(t, async ({ sql, state, invoke, booking, bookingPath }) => {
    const valid = JSON.stringify({ ...state.proposal, status: state.providerStatus });
    state.raw = valid;
    assert.equal((await invoke(bookingPath + '/report')).status, 200, 'The raw-body stub serves an acceptable response.');
    const before = (await sql.get('SELECT data::text AS data FROM project_ooh_bookings WHERE id=?', booking.id)).data;
    const oversized = JSON.stringify({ ...JSON.parse(valid), padding: 'a'.repeat(2 * 1024 * 1024) });
    const badUtf8 = new Uint8Array([...Buffer.from(valid.slice(0, -1) + ',"note":"'), 0xff, ...Buffer.from('"}')]);
    for (const [name, raw] of [['oversized', oversized], ['byte order mark', '﻿' + valid], ['malformed UTF-8', badUtf8]]) {
      state.raw = raw;
      const result = await invoke(bookingPath + '/report');
      assert.equal(result.status, 502, name); assert.equal(result.data.error.code, 'INVALID_OOH_RESPONSE', name);
      assert.equal((await sql.get('SELECT data::text AS data FROM project_ooh_bookings WHERE id=?', booking.id)).data, before, name);
    }
  });
});

// Holds the first provider write open, waits until the other parallel request has answered, then releases the write.
async function parallelWrites(state, hook, requests) {
  let release, arrived; const held = new Promise(resolve => { release = resolve; }), first = new Promise(resolve => { arrived = resolve; });
  state[hook] = async () => { state[hook] = null; arrived(); await held; };
  const pending = requests.map(request => request());
  await Promise.race([first, Promise.all(pending)]); await Promise.race(pending); release();
  return Promise.all(pending);
}

test('OOH parallel duplicate drafts and confirmations reach Broadsign exactly once, under one key or two', { skip: postgresSkip }, async t => {
  for (const keys of [['ooh-audit-same-key', 'ooh-audit-same-key'], ['ooh-audit-key-a', 'ooh-audit-key-b']]) await fixture(t, async ({ state, calls, invoke, bookingPath }) => {
    const writes = path => calls.filter(call => call.path === path).length, proposalsBefore = writes('/api/v1/proposal');
    const draft = { name: 'Parallel duplicate draft', screenIds: [101, 102], startDate: '2026-10-20', endDate: '2026-10-22', slotDuration: 10, inventoryType: 'digital', price: 150 };
    const drafts = await parallelWrites(state, 'beforeProposalResponse', keys.map(key => () => invoke('bookings', 'POST', draft, key + '-draft')));
    assert.equal(writes('/api/v1/proposal') - proposalsBefore, 1, `${keys}: one paid proposal for parallel duplicate drafts`);
    assert.deepEqual(drafts.map(result => result.status).sort(), [200, 409]);
    assert.equal(drafts.find(result => result.status === 409).data.error.code, keys[0] === keys[1] ? 'OPERATION_UNCERTAIN' : 'OPERATION_NOT_SENT');
    const submits = await parallelWrites(state, 'beforeBookResponse', keys.map(key => () => invoke(bookingPath + '/submit', 'POST', { confirmBooking: true }, key + '-submit')));
    assert.equal(writes('/api/v1/proposal/book_proposal/800'), 1, `${keys}: one booking request for parallel confirmations`);
    assert.deepEqual(submits.map(result => result.status).sort(), [200, 409]);
    assert.equal(submits.find(result => result.status === 409).data.error.code, keys[0] === keys[1] ? 'OPERATION_UNCERTAIN' : 'OPERATION_NOT_SENT');
    const retried = await invoke(bookingPath + '/submit', 'POST', { confirmBooking: true }, keys[0] + '-submit');
    assert.equal(writes('/api/v1/proposal/book_proposal/800'), 1, 'A same-key retry after the outcome replays it without another booking request.');
    if (keys[0] === keys[1]) assert.deepEqual(retried, submits.find(result => result.status === 200));
  });
});

test('OOH parallel cancellations send one provider cancellation and end in one cancelling stage', { skip: postgresSkip }, async t => {
  await fixture(t, async ({ sql, calls, invoke, booking, bookingPath }) => {
    assert.equal((await invoke(bookingPath + '/submit', 'POST', { confirmBooking: true }, 'ooh-audit-submit')).status, 200);
    const results = await Promise.all(['ooh-audit-cancel-a', 'ooh-audit-cancel-b'].map(key => invoke(bookingPath + '/cancel', 'POST', { confirmCancellation: true }, key)));
    assert.equal(calls.filter(call => call.path.endsWith('/cancel')).length, 1);
    // The loser is stopped by the receipt check or by the booking row lock; a loser that starts late sees the provider
    // already cancelling and only records that state. None of them sends a second cancellation.
    for (const result of results.filter(result => result.status !== 200)) { assert.equal(result.status, 409); assert.ok(['OPERATION_NOT_SENT', 'OOH_CANCELLATION_PENDING'].includes(result.data.error.code), result.data.error.code); }
    const saved = (await sql.get('SELECT data FROM project_ooh_bookings WHERE id=?', booking.id)).data;
    assert.equal(saved.stage, 'cancelling'); assert.ok(results.some(result => result.status === 200 && result.data.operation.id === saved.cancellationOperationId));
  });
});

test('OOH confirmation racing a cancellation, both reading before either writes, ends in one valid stage', { skip: postgresSkip }, async t => {
  await fixture(t, async ({ pool, sql, state, calls, invoke, booking, bookingPath }) => {
    // Writes to bookings wait behind the gate: the submit has sent its booking and the cancellation has read the booked
    // proposal, so each holds a stale copy when the gate opens. The row lock and compare-and-save must leave one stage.
    const gate = await blockWrites(pool, 'project_ooh_bookings'); let cancelling, submitted, cancelled;
    state.beforeBookResponse = async () => { state.beforeBookResponse = null; cancelling = invoke(bookingPath + '/cancel', 'POST', { confirmCancellation: true }, 'ooh-audit-race-cancel'); };
    const submitting = invoke(bookingPath + '/submit', 'POST', { confirmBooking: true }, 'ooh-audit-race-submit');
    try { await gate.waiting(2); } finally { await gate.release(); }
    [submitted, cancelled] = [await submitting, await cancelling];
    assert.equal(calls.filter(call => call.path.includes('/book_proposal/')).length, 1); assert.equal(calls.filter(call => call.path.endsWith('/cancel')).length, 1);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
    if (submitted.status !== 200) { assert.equal(submitted.status, 409); assert.equal(submitted.data.operation.status, 'uncertain'); }
    const saved = (await sql.get('SELECT data FROM project_ooh_bookings WHERE id=?', booking.id)).data;
    assert.equal(saved.stage, 'cancelling'); assert.equal(saved.providerStatus, 15); assert.equal(saved.cancellationOperationId, cancelled.data.operation.id, 'The submission must not overwrite the cancellation receipt.');
  });
});
