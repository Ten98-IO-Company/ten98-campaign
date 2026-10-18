import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createStore } from '../server/database.mjs';
import { handleOoh } from '../server/ooh.mjs';

// Independent contract: https://direct.broadsign.com/api/v1/apidocs.json
// GET proposal_item accepts include_screens; booking's 200 response has no JSON schema.
async function fixture(run, { requireScreenQuery = true, bookingReply = '{}', bookedStatus = 10 } = {}) {
  const db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, calls = [], project = { id: 'ooh-round4' };
  db.exec(`CREATE TABLE records(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,collection TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE activity(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,message TEXT NOT NULL,created_at TEXT NOT NULL,sample INTEGER NOT NULL DEFAULT 0);`);
  const store = createStore(db); let proposal, item, status = 1;
  globalThis.fetch = async (target, options = {}) => {
    const url = new URL(target), payload = options.body && JSON.parse(options.body); calls.push({ path: url.pathname, search: url.search, method: options.method }); let result;
    if (url.pathname === '/api/v1/user/current_user') result = { id: 1, domain_id: 7 };
    else if (url.pathname === '/api/v1/screen/101') result = { id: 101, domain_id: 7, name: 'Approved screen', lat: 25, long: 55 };
    else if (url.pathname === '/api/v1/proposal') result = proposal = { ...payload, id: 800, domain_id: 7, proposal_item_id_list: [] };
    else if (url.pathname === '/api/v1/proposal/add_screens') { result = item = { ...payload, id: 1800 }; proposal.proposal_item_id_list = [1800]; }
    else if (url.pathname === '/api/v1/proposal/800') result = { ...proposal, status };
    else if (url.pathname === '/api/v1/proposal/proposal_item/1800') {
      result = { ...item }; if (requireScreenQuery && url.searchParams.get('include_screens') !== 'true') delete result.screens;
    } else if (url.pathname === '/api/v1/proposal/800/availability') result = { proposal_id: 800, availability: 'available' };
    else if (url.pathname === '/api/v1/proposal/book_proposal/800') { status = bookedStatus; return new Response(bookingReply, { status: 200 }); }
    else throw new Error('Unexpected provider endpoint: ' + url.pathname);
    return new Response(JSON.stringify(result));
  };
  async function invoke(path, method = 'GET', body = {}, key = 'ooh-round4-default') {
    let response;
    await handleOoh({ db, store, project, req: { method, headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${project.id}/ooh/${path}`), body, role: 'owner', user: { isOperator: true }, config: { env: {}, BROADSIGN_API_KEY: 'fixture-key' }, send(status, data) { response = { status, data }; } });
    return response;
  }
  try {
    assert.equal((await invoke('connection', 'POST', { domainId: 7, clientId: 'brand', clientName: 'Fixture brand', screenIds: [101] })).status, 200);
    assert.equal((await invoke('sync', 'POST')).status, 200);
    const drafted = await invoke('bookings', 'POST', { name: 'Contract regression', screenIds: [101], startDate: '2026-10-20', endDate: '2026-10-22', slotDuration: 10, inventoryType: 'digital', price: 150 }, 'ooh-round4-draft');
    assert.equal(drafted.status, 200); const booking = drafted.data.booking;
    await run({ db, store, calls, invoke, booking, path: `bookings/${booking.id}` });
  } finally { globalThis.fetch = originalFetch; db.close(); }
}

test('OOH strict reads explicitly request screen IDs before validating availability and delivery', async () => {
  await fixture(async ({ calls, invoke, path }) => {
    const available = await invoke(path + '/availability');
    assert.equal(available.status, 200, JSON.stringify(available.data)); assert.equal(available.data.availability, 'available');
    assert.equal((await invoke(path + '/report')).status, 200);
    const reads = calls.filter(call => call.path === '/api/v1/proposal/proposal_item/1800');
    assert.equal(reads.length, 2); assert.ok(reads.every(call => new URLSearchParams(call.search).get('include_screens') === 'true'));
  });
});

test('OOH booking accepts bodyless or text success only after its scoped status readback confirms submission', async () => {
  for (const bookingReply of [null, 'Success', '"Success"']) await fixture(async ({ calls, invoke, path }) => {
    const result = await invoke(path + '/submit', 'POST', { confirmBooking: true }, 'ooh-round4-submit');
    assert.equal(result.status, 200, JSON.stringify(result.data)); assert.equal(result.data.booking.providerStatus, 10);
    assert.equal(result.data.placements[0].status, 'requested');
    assert.deepEqual(await invoke(path + '/submit', 'POST', { confirmBooking: true }, 'ooh-round4-submit'), result);
    assert.equal(calls.filter(call => call.path.includes('/book_proposal/')).length, 1);
  }, { requireScreenQuery: false, bookingReply });
  await fixture(async ({ calls, invoke, path }) => {
    const result = await invoke(path + '/submit', 'POST', { confirmBooking: true }, 'ooh-round4-submit');
    assert.equal(result.status, 409); assert.equal(result.data.operation.status, 'uncertain');
    assert.equal((await invoke(path + '/submit', 'POST', { confirmBooking: true }, 'ooh-round4-new-key')).status, 409);
    assert.equal(calls.filter(call => call.path.includes('/book_proposal/')).length, 1);
  }, { requireScreenQuery: false, bookingReply: null, bookedStatus: 1 });
});
