import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/database.ts';
import { handleOoh } from '../server/ooh.mjs';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

async function fixture(run) {
  const db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, project = { id: 'ooh-audit' };
  db.exec(`CREATE TABLE records(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,collection TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE activity(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,message TEXT NOT NULL,created_at TEXT NOT NULL,sample INTEGER NOT NULL DEFAULT 0);`);
  const store = createStore(db), calls = [], state = { providerStatus: 1, proposal: null, item: null, beforeBookResponse: null, beforeItemResponse: null, malformed: undefined };
  globalThis.fetch = async (target, options) => {
    const path = new URL(target).pathname, payload = options.body && JSON.parse(options.body); calls.push({ path, payload }); let result;
    if (path === '/api/v1/user/current_user') result = { id: 1, domain_id: 7 };
    else if (path.startsWith('/api/v1/screen/')) result = { id: Number(path.split('/').at(-1)), domain_id: 7, name: 'Approved screen' };
    else if (path === '/api/v1/proposal') result = state.proposal = { ...payload, id: 800, domain_id: 7, proposal_item_id_list: [], status: 1 };
    else if (path === '/api/v1/proposal/add_screens') { result = state.item = { ...payload, id: 1800 }; state.proposal.proposal_item_id_list = [1800]; }
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
    await run({ db, store, state, calls, invoke, booking, bookingPath: `bookings/${booking.id}` });
  } finally { globalThis.fetch = originalFetch; db.close(); }
}

test('OOH preflight rejects duplicate screens and changed delivery terms before paid submission', async () => {
  await fixture(async ({ state, calls, invoke, bookingPath }) => {
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

test('OOH booking acknowledgement and final readback cannot erase a concurrent cancellation receipt', async () => {
  for (const phase of ['acknowledgement', 'final readback']) await fixture(async ({ db, store, state, calls, invoke, booking, bookingPath }) => {
    let cancellation;
    const cancel = async () => {
      cancellation = await invoke(bookingPath + '/cancel', 'POST', { confirmCancellation: true }, 'ooh-audit-cancel');
      assert.equal(cancellation.status, 200); assert.equal(cancellation.data.booking.stage, 'cancelling');
    };
    if (phase === 'acknowledgement') state.beforeBookResponse = cancel;
    else state.beforeItemResponse = async () => {
      if (JSON.parse(db.prepare('SELECT data FROM project_ooh_bookings WHERE id=?').get(booking.id).data).stage !== 'submitted') return;
      state.beforeItemResponse = null; await cancel();
    };
    const result = await invoke(bookingPath + '/submit', 'POST', { confirmBooking: true }, 'ooh-audit-submit');
    assert.equal(result.status, 409, phase); assert.equal(result.data.operation.status, 'uncertain');
    const saved = JSON.parse(db.prepare('SELECT data FROM project_ooh_bookings WHERE id=?').get(booking.id).data);
    assert.equal(saved.stage, 'cancelling'); assert.equal(saved.cancellationOperationId, cancellation.data.operation.id);
    assert.equal(saved.providerStatus, 15);
    const placements = store.list('ooh-audit', 'placements');
    assert.equal(placements.length, 2); assert.equal(placements.every(placement => placement.providerStatus === 15), true);
    const retry = await invoke(bookingPath + '/cancel', 'POST', { confirmCancellation: true }, 'ooh-audit-again');
    assert.equal(retry.status, 200); assert.equal(calls.filter(call => call.path.endsWith('/cancel')).length, 1);
  });
});

test('OOH malformed provider JSON yields a controlled error without changing saved bookings', async () => {
  await fixture(async ({ db, state, invoke, booking, bookingPath }) => {
    const before = db.prepare('SELECT data FROM project_ooh_bookings WHERE id=?').get(booking.id).data;
    for (const malformed of [null, [], true, 1, 'wrong response']) {
      state.malformed = malformed;
      const result = await invoke(bookingPath + '/report');
      assert.equal(result.status, 502); assert.equal(result.data.error.code, 'INVALID_OOH_RESPONSE');
      assert.equal(db.prepare('SELECT data FROM project_ooh_bookings WHERE id=?').get(booking.id).data, before);
    }
  });
});
