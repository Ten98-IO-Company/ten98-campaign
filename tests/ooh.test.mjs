import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { handleOoh } from '../server/ooh.mjs';
import { createStore } from '../server/database.mjs';

test('Broadsign contracts, approved inventory, paid confirmation, and durable partial failures', async () => {
  const db = new DatabaseSync(':memory:'), originalFetch = globalThis.fetch, calls = [];
  db.exec(`CREATE TABLE records(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,collection TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE activity(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,message TEXT NOT NULL,created_at TEXT NOT NULL,sample INTEGER NOT NULL DEFAULT 0);`);
  const store = createStore(db);
  const project = { id: 'project-a' }, config = { env: {}, BROADSIGN_API_KEY: 'private-server-key', BROADSIGN_ENVIRONMENT: 'sandbox' };
  const connection = { domainId: 7, clientId: 'brand-a', clientName: 'Brand A', screenIds: [101, 102] };
  let nextProposal = 800, state = 1, failure = '', changedScreens = false, duringScreenRead;
  const proposals = new Map(), items = new Map();
  globalThis.fetch = async (target, options) => {
    const url = new URL(target), payload = options.body && JSON.parse(options.body);
    assert.equal(url.origin, 'https://direct-sandbox.broadsign.com'); assert.equal(options.redirect, 'error'); assert.ok(options.signal);
    assert.equal(options.headers.Authorization, 'Broadsign private-server-key');
    calls.push({ url, options, payload }); let result;
    if (url.pathname === '/api/v1/user/current_user') result = { id: 5, domain_id: 7, password: 'never-expose' };
    else if (url.pathname.startsWith('/api/v1/screen/')) {
      if (duringScreenRead) { const run = duringScreenRead; duringScreenRead = null; await run(); }
      result = { id: Number(url.pathname.split('/').at(-1)), domain_id: 7, name: 'Downtown', address: 'Main Street', resolution: '1920x1080', lat: 0, long: 55, secret: 'never-expose' };
    }
    else if (url.pathname === '/api/v1/proposal') {
      assert.equal(payload.client_id, connection.clientId); assert.equal(payload.client_name, connection.clientName); assert.equal(payload.price, 150);
      result = { ...payload, id: nextProposal++, domain_id: 7, proposal_item_id_list: [], status: 1 }; proposals.set(result.id, result);
    } else if (url.pathname === '/api/v1/proposal/add_screens') {
      if (failure === 'item') return new Response('{}', { status: 400 });
      assert.deepEqual(payload.screens, [101, 102]); assert.deepEqual(payload.mode, [{ type: 'ppl', values: { bs_saturation: 1, saturation: 1 }, active: true }]);
      assert.equal(payload.multiplier, 3); assert.equal(payload.inventory_type, 'digital'); assert.equal(payload.status, 1); assert.equal(payload.slot_duration, 10);
      result = { ...payload, id: payload.proposal_id + 1000, price: 165, actual_impressions: 12500, actual_repetitions: 43, performance_update_tm: '2026-10-20 12:30:00' };
      items.set(result.id, result); Object.assign(proposals.get(payload.proposal_id), { price: 165, proposal_item_id_list: [result.id] });
    } else if (url.pathname.startsWith('/api/v1/proposal/proposal_item/')) {
      result = { ...items.get(Number(url.pathname.split('/').at(-1))) }; if (changedScreens) result.screens = [999];
    } else if (url.pathname.startsWith('/api/v1/proposal/book_proposal/')) {
      assert.deepEqual(payload, {}); state = 10; result = { success: true };
    } else if (url.pathname.endsWith('/availability')) result = { proposal_id: Number(url.pathname.split('/').at(-2)), availability: 'available', requested_screen_count: 2, bookable_screen_count: 2 };
    else if (url.pathname.startsWith('/api/v1/proposal/')) result = { ...proposals.get(Number(url.pathname.split('/').at(-1))), status: state };
    else throw new Error(`Unexpected URL ${url}`);
    return new Response(JSON.stringify(result), { status: 200 });
  };
  async function invoke(path, options = {}) {
    let response;
    const { method = 'GET', body = {}, role = 'editor', isOperator = false, selectedProject = project, key = 'request-key01', selectedConfig = config } = options;
    const handled = await handleOoh({ req: { method, headers: { 'idempotency-key': key } }, url: new URL(`http://localhost/api/projects/${selectedProject.id}/ooh/${path}`), body, project: selectedProject, role, user: { isOperator }, db, store, config: selectedConfig, send(status, data) { response = { status, data }; } });
    assert.equal(handled, true); return response;
  }
  const draft = { name: 'City launch', screenIds: [101, 102], startDate: '2026-10-20', endDate: '2026-10-22', slotDuration: 10, price: 150, inventoryType: 'digital' };
  try {
    let result = await invoke('status'); assert.equal(result.data.configured, true); assert.equal(result.data.connection, null);
    result = await invoke('connection', { method: 'POST', role: 'admin', body: connection }); assert.equal(result.status, 403); assert.equal(calls.length, 0);
    result = await invoke('connection', { method: 'POST', role: 'viewer', isOperator: true, body: connection }); assert.equal(result.status, 403);
    result = await invoke('connection', { method: 'POST', role: 'admin', isOperator: true, body: { ...connection, baseUrl: 'http://localhost/private' } }); assert.equal(result.status, 400); assert.equal(calls.length, 0);
    result = await invoke('connection', { method: 'POST', role: 'admin', isOperator: true, body: { ...connection, domainId: 8 } }); assert.equal(result.data.error.code, 'OOH_DOMAIN_MISMATCH');
    const beforePinnedDomain = calls.length;
    result = await invoke('connection', { method: 'POST', role: 'admin', isOperator: true, body: connection, selectedConfig: { ...config, BROADSIGN_DOMAIN_ID: '8' } }); assert.equal(result.status, 403); assert.equal(result.data.error.code, 'OOH_DOMAIN_NOT_ALLOWED'); assert.equal(calls.length, beforePinnedDomain);
    for (const invalid of ['not-a-domain', '0', '-7', '7.5', '7e0', '9007199254740992']) {
      result = await invoke('connection', { method: 'POST', role: 'admin', isOperator: true, body: connection, selectedConfig: { ...config, BROADSIGN_DOMAIN_ID: invalid } }); assert.equal(result.status, 503); assert.equal(result.data.error.code, 'INVALID_OOH_DOMAIN_CONFIGURATION'); assert.equal(calls.length, beforePinnedDomain, 'Invalid pinned domains fail before contacting the provider.');
    }
    result = await invoke('connection', { method: 'POST', role: 'admin', isOperator: true, body: connection, selectedConfig: { ...config, BROADSIGN_DOMAIN_ID: '7' } }); assert.equal(result.status, 200);
    result = await invoke('sync', { method: 'POST', selectedConfig: { ...config, BROADSIGN_DOMAIN_ID: '8' } }); assert.equal(result.status, 403); assert.equal(calls.length, beforePinnedDomain + 1, 'A changed server pin blocks existing mappings before provider calls.');
    result = await invoke('connection', { method: 'POST', role: 'owner', isOperator: true, body: connection, selectedProject: { id: 'project-b' } }); assert.equal(result.data.error.code, 'OOH_SCREEN_ALREADY_MAPPED');
    result = await invoke('sync', { method: 'POST', role: 'viewer' }); assert.equal(result.status, 403);
    result = await invoke('sync', { method: 'POST' }); assert.equal(result.status, 200); assert.equal(result.data.inventory.length, 2);
    assert.equal(result.data.inventory[0].latitude, 0); assert.equal(result.data.inventory[0].longitude, 55); assert.equal(JSON.stringify(result).includes('never-expose'), false);
    duringScreenRead = async () => { const remapped = await invoke('connection', { method: 'POST', role: 'owner', isOperator: true, body: { ...connection, screenIds: [103] } }); assert.equal(remapped.status, 200); };
    result = await invoke('sync', { method: 'POST' }); assert.equal(result.data.error.code, 'OOH_MAPPING_CHANGED');
    result = await invoke('inventory'); assert.deepEqual(result.data.inventory, [], 'A concurrent remap must not reintroduce inventory from the former approved scope.');
    result = await invoke('connection', { method: 'POST', role: 'owner', isOperator: true, body: connection }); assert.equal(result.status, 200);
    result = await invoke('sync', { method: 'POST' }); assert.equal(result.status, 200);
    result = await invoke('inventory', { selectedProject: { id: 'project-b' } }); assert.deepEqual(result.data.inventory, []);
    result = await invoke('bookings', { method: 'POST', body: { ...draft, screenIds: [999] } }); assert.equal(result.status, 403);
    result = await invoke('bookings', { method: 'POST', body: { ...draft, startDate: '2026-02-30' } }); assert.equal(result.status, 400);
    result = await invoke('bookings', { method: 'POST', body: draft, key: '' }); assert.equal(result.status, 400);
    result = await invoke('bookings', { method: 'POST', body: draft, key: 'draft-00001' }); assert.equal(result.status, 200); assert.equal(result.data.booking.stage, 'draft'); assert.equal(result.data.booking.price, 165, 'The provider-calculated quote is the price shown for approval.');
    const booking = result.data.booking, count = calls.filter(call => call.url.pathname === '/api/v1/proposal').length;
    assert.deepEqual(await invoke('bookings', { method: 'POST', body: draft, key: 'draft-00001' }), result);
    assert.equal(calls.filter(call => call.url.pathname === '/api/v1/proposal').length, count);
    result = await invoke(`bookings/${booking.id}/report`, { selectedProject: { id: 'project-b' } }); assert.equal(result.status, 409);
    const readsBeforeReport = calls.filter(call => call.url.pathname.includes('/proposal_item/')).length;
    result = await invoke(`bookings/${booking.id}/report`); assert.equal(result.status, 200); assert.deepEqual(result.data.report, { actualImpressions: 12500, actualPlays: 43, updatedAt: '2026-10-20 12:30:00', rawProofOfPlay: false });
    assert.equal(calls.filter(call => call.url.pathname.includes('/proposal_item/')).length - readsBeforeReport, 1, 'Report data must come from the exact line-item response whose project scope was verified.');
    const placements = store.list(project.id, 'placements'), placementIds = placements.map(item => item.id).sort();
    assert.equal(placements.length, 2, 'Every verified screen has one placement in the shared campaign plan.');
    for (const placement of placements) {
      assert.equal(placement.source, 'broadsign'); assert.equal(placement.externalId, String(booking.proposalId)); assert.equal(placement.proposalItemId, booking.lineItemId); assert.equal(placement.status, 'draft'); assert.equal(placement.providerStatus, 1);
      assert.equal(placement.startDate, draft.startDate); assert.equal(placement.endDate, draft.endDate); assert.equal(placement.latitude, 0); assert.equal(placement.longitude, 55);
      assert.equal(placement.cost, null, 'A combined line-item quote must not be invented as each screen’s cost.'); assert.equal(placement.currency, null);
    }
    assert.deepEqual(store.list('project-b', 'placements'), []);
    result = await invoke(`bookings/${booking.id}/report`); assert.equal(result.status, 200); assert.deepEqual(store.list(project.id, 'placements').map(item => item.id).sort(), placementIds, 'Repeated reports upsert the same provider placements.');
    result = await invoke(`bookings/${booking.id}/submit`, { method: 'POST', body: {} }); assert.equal(result.data.error.code, 'OOH_CONFIRMATION_REQUIRED');
    changedScreens = true;
    result = await invoke(`bookings/${booking.id}/submit`, { method: 'POST', body: { confirmBooking: true }, key: 'changed-001' }); assert.equal(result.data.error.code, 'OOH_BOOKING_CHANGED');
    assert.equal(calls.filter(call => call.url.pathname.includes('book_proposal')).length, 0);
    changedScreens = false;
    result = await invoke(`bookings/${booking.id}/availability`); assert.equal(result.data.availability, 'available');
    result = await invoke(`bookings/${booking.id}/submit`, { method: 'POST', body: { confirmBooking: true }, key: 'submit-0001' }); assert.equal(result.status, 200); assert.equal(result.data.booking.providerStatus, 10);
    assert.equal(store.list(project.id, 'placements').every(item => item.status === 'requested' && item.providerStatus === 10), true, 'Submitted does not mean booked or live.');
    assert.deepEqual(await invoke(`bookings/${booking.id}/submit`, { method: 'POST', body: { confirmBooking: true }, key: 'submit-0001' }), result); assert.equal(calls.filter(call => call.url.pathname.includes('book_proposal')).length, 1);
    for (const [providerStatus, localStatus] of [[9, 'booked'], [11, 'live'], [14, 'completed'], [12, 'cancelled']]) {
      state = providerStatus; result = await invoke(`bookings/${booking.id}/report`); assert.equal(result.status, 200);
      assert.equal(store.list(project.id, 'placements').every(item => item.status === localStatus && item.providerStatus === providerStatus), true);
      assert.deepEqual(store.list(project.id, 'placements').map(item => item.id).sort(), placementIds);
    }
    result = await invoke('connection', { method: 'POST', role: 'owner', isOperator: true, body: { ...connection, clientId: 'brand-b' } }); assert.equal(result.data.error.code, 'OOH_MAPPING_IN_USE');
    result = await invoke('sync', { method: 'POST', selectedConfig: { ...config, BROADSIGN_ENVIRONMENT: 'production' } }); assert.equal(result.data.error.code, 'OOH_ENVIRONMENT_CHANGED');
    failure = 'item';
    const partial = { ...draft, name: 'Partial draft' };
    result = await invoke('bookings', { method: 'POST', body: partial, key: 'partial-001' }); assert.equal(result.data.operation.status, 'uncertain');
    const writes = calls.filter(call => call.url.pathname === '/api/v1/proposal').length;
    result = await invoke('bookings', { method: 'POST', body: partial, key: 'partial-002' }); assert.equal(result.data.error.code, 'OPERATION_UNCERTAIN'); assert.equal(calls.filter(call => call.url.pathname === '/api/v1/proposal').length, writes);
    result = await invoke('bookings'); assert.equal(result.data.bookings.some(item => item.stage === 'proposal-created' && item.proposalId), true, 'A partial provider creation retains its known ID for reconciliation.');
    result = await invoke('status', { selectedConfig: { ...config, BROADSIGN_ENVIRONMENT: 'https://evil.invalid' } }); assert.equal(result.status, 200);
    const before = calls.length;
    result = await invoke('connection', { method: 'POST', role: 'owner', isOperator: true, body: { ...connection, screenIds: [103] }, selectedProject: { id: 'project-c' }, selectedConfig: { ...config, BROADSIGN_ENVIRONMENT: 'https://evil.invalid' } }); assert.equal(result.status, 503); assert.equal(calls.length, before);
  } finally { globalThis.fetch = originalFetch; db.close(); }
});
