import { randomUUID } from 'node:crypto';
import { IntegrationError, operation } from './integrations.mjs';
import { transaction } from './database.mjs';

// Contracts: https://docs.broadsign.com/broadsign-platform/en/Documentation_Gteed_Campaigns/g-c-new-campaign-rest.html
// API-key auth: https://docs.broadsign.com/broadsign-platform/en/Documentation_Settings/settings-api-keys.html
const HOSTS = { production: 'https://direct.broadsign.com', sandbox: 'https://direct-sandbox.broadsign.com' };
const WRITERS = new Set(['owner', 'admin', 'editor']);
const PLACEMENT_STATUS = { 1: 'draft', 3: 'requested', 4: 'requested', 5: 'requested', 9: 'booked', 10: 'requested', 11: 'live', 12: 'cancelled', 14: 'completed', 15: 'requested' };
const fail = (status, code, message, uncertain = false) => { throw new IntegrationError(status, code, message, uncertain); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function fields(value, allowed) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'INVALID_OOH_FIELDS', 'Use the supported fields for this OOH action.');
}
function text(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f]/.test(value)) fail(400, 'INVALID_OOH_INPUT', `Enter a valid ${label}.`);
  return value.trim();
}
function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(400, 'INVALID_OOH_INPUT', `Enter a positive numeric ${label}.`);
  return value;
}
function dates(body) {
  for (const key of ['startDate', 'endDate']) if (typeof body[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(body[key]) || !Number.isFinite(Date.parse(body[key])) || new Date(body[key]).toISOString().slice(0, 10) !== body[key]) fail(400, 'INVALID_OOH_DATES', 'Use valid start and end dates.');
  if (body.endDate < body.startDate || Date.parse(body.endDate) - Date.parse(body.startDate) >= 366 * 86400000) fail(400, 'INVALID_OOH_DATES', 'Use an ordered booking period of at most 366 days, including both dates.');
}
function initialize(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS project_ooh_connections(project_id TEXT PRIMARY KEY,provider TEXT NOT NULL,external_scope_id TEXT NOT NULL,config_public TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS project_ooh_inventory(project_id TEXT NOT NULL,screen_id INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(project_id,screen_id));
    CREATE TABLE IF NOT EXISTS project_ooh_bookings(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,data TEXT NOT NULL);`);
}
function mapping(db, projectId) {
  const row = db.prepare('SELECT * FROM project_ooh_connections WHERE project_id=?').get(projectId);
  return row ? { provider: row.provider, domainId: Number(row.external_scope_id), ...JSON.parse(row.config_public) } : null;
}
function list(db, table, projectId) { return db.prepare(`SELECT data FROM ${table} WHERE project_id=? ORDER BY rowid DESC`).all(projectId).map(row => JSON.parse(row.data)); }
function saveBooking(db, projectId, booking) { db.prepare('INSERT INTO project_ooh_bookings VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data WHERE project_ooh_bookings.project_id=excluded.project_id').run(booking.id, projectId, JSON.stringify(booking)); return booking; }
function canRetryCancellation(db, projectId, booking) {
  const id = booking.cancellationOperationId;
  if (booking.stage !== 'cancellation-requested' || !id || operation.active?.get(db)?.has(id) || !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='integration_operation_reviews'").get()) return false;
  return Boolean(db.prepare("SELECT o.id FROM integration_operations o JOIN integration_operation_reviews r ON r.operation_id=o.id AND r.project_id=o.project_id WHERE o.id=? AND o.project_id=? AND o.status='reviewed-not-applied' AND r.resolution='not_applied' AND o.action_path='POST /ooh/bookings/:id/cancel'").get(id, projectId));
}
function coordinate(value, limit) { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit ? value : null; }
function screenView(screen) {
  return { id: Number(screen.id), name: String(screen.name || screen.id).slice(0, 250), location: String(screen.address || '').slice(0, 500), resolution: String(screen.resolution || '').slice(0, 80), latitude: coordinate(screen.lat, 90), longitude: coordinate(screen.long, 180), syncedAt: new Date().toISOString() };
}
function placementRecords({ db, store, project }, booking) {
  const inventory = list(db, 'project_ooh_inventory', project.id), existing = store.list(project.id, 'placements');
  return transaction(db, () => booking.screenIds.map(screenId => {
    const screen = inventory.find(item => item.id === screenId);
    if (!screen) fail(409, 'OOH_SYNC_REQUIRED', 'Sync the approved provider locations before updating the campaign plan.');
    const data = { source: 'broadsign', externalId: String(booking.proposalId), proposalItemId: booking.lineItemId, screenId, bookingId: booking.id, providerStatus: Number(booking.providerStatus), name: `${booking.name} · ${screen.name}`.slice(0, 250), type: booking.inventoryType === 'digital' ? 'digital' : 'billboard', location: screen.location || screen.name, locationSource: 'provider', latitude: screen.latitude, longitude: screen.longitude, startDate: booking.startDate, endDate: booking.endDate, status: PLACEMENT_STATUS[booking.providerStatus], cost: null, currency: null };
    // Broadsign reports the quote for the whole line item, not a per-screen cost or currency breakdown.
    const previous = existing.find(item => item.source === 'broadsign' && item.externalId === data.externalId && item.proposalItemId === data.proposalItemId && item.screenId === screenId);
    return previous ? store.update(project.id, 'placements', previous.id, data) : store.create(project.id, 'placements', data);
  }));
}
async function provider(env, path, body, method = body === undefined ? 'GET' : 'POST') {
  const base = HOSTS[env.BROADSIGN_ENVIRONMENT || 'sandbox'];
  if (!base) fail(503, 'INVALID_OOH_ENVIRONMENT', 'BROADSIGN_ENVIRONMENT must be sandbox or production.');
  if (!env.BROADSIGN_API_KEY) fail(503, 'OOH_NOT_CONFIGURED', 'Configure the Broadsign API key on the server.');
  const writing = method !== 'GET';
  try { env.assertIntegrationSettings?.(); } catch { fail(409, 'OOH_CREDENTIALS_CHANGED', 'Integration credentials changed. Refresh this project before continuing.'); }
  let response;
  try { response = await fetch(`${base}${path}`, { method, headers: { Authorization: `Broadsign ${env.BROADSIGN_API_KEY}`, Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(20000) }); }
  catch { fail(502, 'OOH_UNAVAILABLE', 'Broadsign did not confirm the request.', writing); }
  if (!response.ok) fail(response.status === 429 ? 429 : response.status >= 500 ? 502 : 400, 'OOH_PROVIDER_REJECTED', 'Broadsign could not complete this request. Check the connection and request details.', writing && (response.status >= 500 || [408, 409].includes(response.status)));
  try {
    // The cancellation contract has no response body; a scoped GET below verifies the actual state.
    if (method === 'POST' && path.endsWith('/cancel')) {
      await response.body?.cancel();
      try { env.assertIntegrationSettings?.(); } catch { fail(409, 'OOH_CREDENTIALS_CHANGED', 'Integration credentials changed during this request. Review the provider outcome.', true); }
      return {};
    }
    const reader = response.body.getReader(), chunks = []; let size = 0;
    for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error(); } chunks.push(next.value); }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    try { env.assertIntegrationSettings?.(); } catch { fail(409, 'OOH_CREDENTIALS_CHANGED', 'Integration credentials changed during this request. Review the provider outcome.', writing); }
    return result;
  } catch (error) { if (error instanceof IntegrationError) throw error; fail(502, 'INVALID_OOH_RESPONSE', 'Broadsign returned an unreadable response.', writing); }
}
async function verifyDomain(env, connection) {
  if (env.BROADSIGN_DOMAIN_ID !== undefined && env.BROADSIGN_DOMAIN_ID !== '') {
    const pinned = String(env.BROADSIGN_DOMAIN_ID).trim();
    if (!/^[1-9]\d*$/.test(pinned) || !Number.isSafeInteger(Number(pinned))) fail(503, 'INVALID_OOH_DOMAIN_CONFIGURATION', 'BROADSIGN_DOMAIN_ID must be a positive numeric domain ID.');
    if (Number(pinned) !== connection.domainId) fail(403, 'OOH_DOMAIN_NOT_ALLOWED', 'This project’s domain is not permitted by the server’s Broadsign configuration.');
  }
  const result = await provider(env, '/api/v1/user/current_user');
  const current = result?.user || result;
  if (Number(current?.domain_id) !== connection.domainId) fail(403, 'OOH_DOMAIN_MISMATCH', 'The Broadsign account does not match this project’s approved domain.');
}
function requireMapping(db, projectId, env) {
  const connection = mapping(db, projectId);
  if (!connection) fail(409, 'OOH_NOT_MAPPED', 'An instance operator must map Broadsign inventory to this project.');
  if (connection.environment !== (env.BROADSIGN_ENVIRONMENT || 'sandbox')) fail(409, 'OOH_ENVIRONMENT_CHANGED', 'The server environment changed. An operator must approve a new mapping.');
  return connection;
}
async function checkedProposal(env, connection, booking, strict = false) {
  const proposal = await provider(env, `/api/v1/proposal/${booking.proposalId}`);
  if (Number(proposal.id) !== booking.proposalId || Number(proposal.domain_id) !== connection.domainId || String(proposal.client_id) !== connection.clientId) fail(403, 'OOH_BOOKING_OUTSIDE_PROJECT', 'This provider booking no longer matches the approved project scope.');
  if (!Object.hasOwn(PLACEMENT_STATUS, Number(proposal.status))) fail(502, 'INVALID_OOH_RESPONSE', 'Broadsign returned an unrecognized booking status.');
  if (strict && (!Array.isArray(proposal.proposal_item_id_list) || proposal.proposal_item_id_list.length !== 1 || Number(proposal.proposal_item_id_list[0]) !== booking.lineItemId)) fail(409, 'OOH_BOOKING_CHANGED', 'The provider line items changed. Review this booking in Broadsign.');
  let item;
  if (strict) {
    item = await provider(env, `/api/v1/proposal/proposal_item/${booking.lineItemId}`);
    if (Number(item.id) !== booking.lineItemId || Number(item.proposal_id) !== booking.proposalId || !Array.isArray(item.screens) || item.screens.length !== booking.screenIds.length || item.screens.some(id => !booking.screenIds.includes(id)) || item.start_date !== booking.startDate || item.end_date !== booking.endDate || Number(item.price) !== booking.price || Number(proposal.price) !== booking.price) fail(409, 'OOH_BOOKING_CHANGED', 'The provider screens, dates, or quote changed. Review this booking in Broadsign before submission.');
  }
  return { proposal, item };
}
async function availability(env, connection, booking) {
  const { proposal } = await checkedProposal(env, connection, booking, true);
  if (Number(proposal.status) !== 1) fail(409, 'OOH_PROPOSAL_NOT_SAVED', 'The provider proposal is no longer a saved draft. Refresh its delivery status before continuing.');
  const result = await provider(env, `/api/v1/proposal/${booking.proposalId}/availability?type=book`);
  if (Number(result.proposal_id) !== booking.proposalId || typeof result.availability !== 'string') fail(502, 'INVALID_OOH_RESPONSE', 'Broadsign did not return availability for this booking.');
  return { availability: result.availability, providerStatus: Number(proposal.status), requestedScreens: result.requested_screen_count ?? null, bookableScreens: result.bookable_screen_count ?? null, checkedAt: new Date().toISOString() };
}

export async function handleOoh(context) {
  const { req, url, body = {}, project, role, user, db, store, send } = context;
  const prefix = `/api/projects/${encodeURIComponent(project.id)}/ooh/`;
  if (!url.pathname.startsWith(prefix)) return false;
  const path = url.pathname.slice(prefix.length), env = { ...(context.config?.env === undefined ? process.env : context.config.env), ...(context.config || {}) };
  try {
    initialize(db);
    if (!['owner', 'admin', 'editor', 'viewer'].includes(role)) fail(403, 'OOH_PROJECT_ACCESS_REQUIRED', 'Project membership is required.');
    if (!['GET', 'POST'].includes(req.method)) fail(405, 'METHOD_NOT_ALLOWED', 'This OOH action does not support that method.');
    if (req.method === 'POST' && !WRITERS.has(role)) fail(403, 'WRITE_PERMISSION_REQUIRED', 'Editing permission is required for this action.');
    if (path === 'status' && req.method === 'GET') {
      send(200, { configured: Boolean(env.BROADSIGN_API_KEY), environment: env.BROADSIGN_ENVIRONMENT || 'sandbox', connection: mapping(db, project.id), rawProofOfPlay: false }); return true;
    }
    if (path === 'connection' && req.method === 'POST') {
      if (!user?.isOperator || !['owner', 'admin'].includes(role)) fail(403, 'OPERATOR_PERMISSION_REQUIRED', 'Only an instance operator who administers this workspace can map provider inventory.');
      fields(body, ['domainId', 'clientId', 'clientName', 'screenIds']);
      if (!Array.isArray(body.screenIds) || !body.screenIds.length || body.screenIds.length > 100) fail(400, 'INVALID_OOH_SCREENS', 'Approve between 1 and 100 screen IDs.');
      const connection = { provider: 'broadsign', domainId: integer(body.domainId, 'domain ID'), clientId: text(body.clientId, 'client ID'), clientName: text(body.clientName, 'client name'), screenIds: [...new Set(body.screenIds.map(id => integer(id, 'screen ID')))].sort((a, b) => a - b), environment: env.BROADSIGN_ENVIRONMENT || 'sandbox' };
      const current = mapping(db, project.id);
      if (current && JSON.stringify(current) !== JSON.stringify(connection) && list(db, 'project_ooh_bookings', project.id).length) fail(409, 'OOH_MAPPING_IN_USE', 'Bookings exist for this mapping. Use a new project for a different provider scope.');
      await verifyDomain(env, connection);
      if (list(db, 'project_ooh_bookings', project.id).length && JSON.stringify(mapping(db, project.id)) !== JSON.stringify(connection)) fail(409, 'OOH_MAPPING_IN_USE', 'A booking was started for this mapping. Use a new project for a different provider scope.');
      for (const other of db.prepare('SELECT project_id,external_scope_id,config_public FROM project_ooh_connections WHERE project_id<>?').all(project.id)) {
        const approved = JSON.parse(other.config_public);
        if (Number(other.external_scope_id) === connection.domainId && approved.environment === connection.environment && approved.screenIds.some(id => connection.screenIds.includes(id))) fail(409, 'OOH_SCREEN_ALREADY_MAPPED', 'A screen is already assigned to another project.');
      }
      if (JSON.stringify(mapping(db, project.id)) === JSON.stringify(connection)) { send(200, { connection }); return true; }
      db.prepare('INSERT INTO project_ooh_connections VALUES(?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET external_scope_id=excluded.external_scope_id,config_public=excluded.config_public').run(project.id, 'broadsign', String(connection.domainId), JSON.stringify({ clientId: connection.clientId, clientName: connection.clientName, screenIds: connection.screenIds, environment: connection.environment }));
      db.prepare('DELETE FROM project_ooh_inventory WHERE project_id=?').run(project.id);
      store?.activity(project.id, 'Approved Broadsign project inventory mapping.'); send(200, { connection }); return true;
    }
    if (path === 'inventory' && req.method === 'GET') { send(200, { inventory: list(db, 'project_ooh_inventory', project.id) }); return true; }
    if (path === 'bookings' && req.method === 'GET') { send(200, { bookings: list(db, 'project_ooh_bookings', project.id).map(booking => ({ ...booking, canRetryCancellation: canRetryCancellation(db, project.id, booking) })) }); return true; }
    const connection = requireMapping(db, project.id, env);
    if (path === 'sync' && req.method === 'POST') {
      fields(body, []); await verifyDomain(env, connection); const inventory = [];
      // ponytail: up to 100 approved screens per project; add a paged background sync for larger networks.
      for (const id of connection.screenIds) {
        const screen = await provider(env, `/api/v1/screen/${id}`);
        if (Number(screen?.id) !== id || (screen.domain_id !== undefined && Number(screen.domain_id) !== connection.domainId)) fail(502, 'INVALID_OOH_RESPONSE', 'Broadsign returned a screen outside the approved inventory.');
        inventory.push(screenView(screen));
      }
      if (JSON.stringify(mapping(db, project.id)) !== JSON.stringify(connection)) fail(409, 'OOH_MAPPING_CHANGED', 'The approved inventory mapping changed during sync. Reload before continuing.');
      db.exec('BEGIN IMMEDIATE');
      try { db.prepare('DELETE FROM project_ooh_inventory WHERE project_id=?').run(project.id); for (const screen of inventory) db.prepare('INSERT INTO project_ooh_inventory VALUES(?,?,?)').run(project.id, screen.id, JSON.stringify(screen)); db.exec('COMMIT'); }
      catch (error) { db.exec('ROLLBACK'); throw error; }
      store?.activity(project.id, `Synced ${inventory.length} approved Broadsign screens.`); send(200, { inventory }); return true;
    }
    if (path === 'bookings' && req.method === 'POST') {
      fields(body, ['name', 'screenIds', 'startDate', 'endDate', 'slotDuration', 'price', 'inventoryType']); dates(body);
      const name = text(body.name, 'booking name');
      if (!['digital', 'static'].includes(body.inventoryType)) fail(400, 'INVALID_OOH_TYPE', 'Choose digital screens or static faces.');
      if (!Array.isArray(body.screenIds) || !body.screenIds.length || body.screenIds.length > 100 || body.screenIds.some(id => !connection.screenIds.includes(id))) fail(403, 'OOH_SCREEN_OUTSIDE_PROJECT', 'Choose approved project screens.');
      const screenIds = [...new Set(body.screenIds)];
      const inventory = list(db, 'project_ooh_inventory', project.id);
      if (screenIds.some(id => !inventory.some(screen => screen.id === id))) fail(409, 'OOH_SYNC_REQUIRED', 'Sync the approved inventory before drafting a booking.');
      if (!Number.isSafeInteger(body.slotDuration) || body.slotDuration < 1 || body.slotDuration > 120) fail(400, 'INVALID_OOH_DURATION', 'Use an ad duration between 1 and 120 seconds.');
      if (typeof body.price !== 'number' || !Number.isFinite(body.price) || body.price < 0 || body.price > 1000000000) fail(400, 'INVALID_OOH_PRICE', 'Enter a nonnegative quote in the provider account’s currency.');
      await verifyDomain(env, connection);
      const result = await operation(context, async () => {
        if (JSON.stringify(mapping(db, project.id)) !== JSON.stringify(connection)) fail(409, 'OOH_MAPPING_CHANGED', 'The approved provider mapping changed. Reload before drafting a booking.');
        const booking = saveBooking(db, project.id, { id: randomUUID(), name, screenIds, startDate: body.startDate, endDate: body.endDate, slotDuration: body.slotDuration, inventoryType: body.inventoryType, price: body.price, proposalId: null, lineItemId: null, providerStatus: 1, stage: 'creating', createdAt: new Date().toISOString() });
        let proposal;
        try { proposal = await provider(env, '/api/v1/proposal', { name, description: `Campaign manager project ${project.id}`, price: body.price, discount: 0, client_id: connection.clientId, client_name: connection.clientName }); }
        catch (error) { if (error instanceof IntegrationError && !error.uncertain) db.prepare('DELETE FROM project_ooh_bookings WHERE project_id=? AND id=?').run(project.id, booking.id); throw error; }
        if (!Number.isSafeInteger(proposal.id) || proposal.id < 1 || Number(proposal.domain_id) !== connection.domainId || String(proposal.client_id) !== connection.clientId) fail(502, 'INVALID_OOH_RESPONSE', 'The new provider proposal could not be identified within this project.', true);
        booking.proposalId = proposal.id; booking.stage = 'proposal-created'; saveBooking(db, project.id, booking);
        try {
        const item = await provider(env, '/api/v1/proposal/add_screens', { name, price: body.price, status: 1, screens: screenIds, package_id: null, proposal_id: proposal.id, multiplier: Math.round((Date.parse(body.endDate) - Date.parse(body.startDate)) / 86400000) + 1, start_date: body.startDate, end_date: body.endDate, start_time: '00:00:00', end_time: '23:59:59', flight_duration: 1, flight_type: 0, dow_mask: 127, slot_duration: body.slotDuration, saturation: 1, filters: [], bs_saturation: 1, available_only: false, deployed_only: false, mode: [{ type: 'ppl', values: { bs_saturation: 1, saturation: 1 }, active: true }], inventory_type: body.inventoryType, is_preemptible: false });
        if (!Number.isSafeInteger(item.id) || item.id < 1 || Number(item.proposal_id) !== booking.proposalId || typeof item.price !== 'number' || !Number.isFinite(item.price) || item.price < 0) fail(502, 'INVALID_OOH_RESPONSE', 'The new provider line item or quote could not be identified.', true);
        booking.lineItemId = item.id; booking.price = item.price; booking.stage = 'draft'; saveBooking(db, project.id, booking);
        store?.activity(project.id, 'Created a saved OOH proposal in Broadsign.'); return { booking };
        } catch { fail(409, 'OOH_PARTIAL_DRAFT', 'A provider proposal was created but its line item needs reconciliation in Broadsign. Do not create it again automatically.', true); }
      }); send(result.status, result.data); return true;
    }
    const route = path.match(/^bookings\/([^/]+)\/(availability|submit|report|cancel)$/);
    if (route) {
      const row = db.prepare('SELECT data FROM project_ooh_bookings WHERE id=? AND project_id=?').get(route[1], project.id);
      if (!row) fail(404, 'OOH_BOOKING_NOT_FOUND', 'This booking does not belong to this project.');
      const booking = JSON.parse(row.data);
      if (!booking.lineItemId) fail(409, 'OOH_INCOMPLETE_DRAFT', 'This draft was only partly created. Reconcile it in Broadsign before continuing.');
      await verifyDomain(env, connection);
      if (route[2] === 'availability' && req.method === 'GET') {
        const result = await availability(env, connection, booking);
        if (db.prepare('SELECT data FROM project_ooh_bookings WHERE id=? AND project_id=?').get(booking.id, project.id)?.data !== row.data) fail(409, 'OOH_BOOKING_CHANGED', 'This booking changed during the availability check. Refresh before continuing.');
        booking.providerStatus = result.providerStatus; saveBooking(db, project.id, booking);
        send(200, { ...result, placements: placementRecords(context, booking) }); return true;
      }
      if (route[2] === 'report' && req.method === 'GET') {
        const { proposal, item } = await checkedProposal(env, connection, booking, true);
        if (db.prepare('SELECT data FROM project_ooh_bookings WHERE id=? AND project_id=?').get(booking.id, project.id)?.data !== row.data) fail(409, 'OOH_BOOKING_CHANGED', 'This booking changed during the delivery check. Refresh before continuing.');
        const report = { actualImpressions: typeof item.actual_impressions === 'number' && Number.isFinite(item.actual_impressions) && item.actual_impressions >= 0 ? item.actual_impressions : null, actualPlays: typeof item.actual_repetitions === 'number' && Number.isFinite(item.actual_repetitions) && item.actual_repetitions >= 0 ? item.actual_repetitions : null, updatedAt: typeof item.performance_update_tm === 'string' ? item.performance_update_tm.slice(0, 100) : null, rawProofOfPlay: false };
        Object.assign(booking, { providerStatus: Number(proposal.status), report, ...([12, 14, 15].includes(Number(proposal.status)) ? { stage: Number(proposal.status) === 12 ? 'cancelled' : Number(proposal.status) === 14 ? 'ended' : 'cancelling' } : {}) }); saveBooking(db, project.id, booking); send(200, { booking, report, placements: placementRecords(context, booking) }); return true;
      }
      if (route[2] === 'cancel' && req.method === 'POST') {
        fields(body, ['confirmCancellation']);
        if (body.confirmCancellation !== true) fail(400, 'OOH_CANCELLATION_CONFIRMATION_REQUIRED', 'Confirm cancellation under the media provider’s terms. Refunds and charges are not determined by this app.');
        const result = await operation(context, async () => {
          // Re-read inside the durable operation so concurrent requests cannot reuse a stale local stage.
          const current = JSON.parse(db.prepare('SELECT data FROM project_ooh_bookings WHERE id=? AND project_id=?').get(booking.id, project.id).data);
          const { proposal } = await checkedProposal(env, connection, current, true), before = Number(proposal.status);
          if ([12, 15].includes(before)) {
            Object.assign(current, { providerStatus: before, stage: before === 12 ? 'cancelled' : 'cancelling' }); saveBooking(db, project.id, current);
            return { booking: current, cancellation: { requested: true, confirmed: before === 12 }, placements: placementRecords(context, current) };
          }
          if (['cancellation-requested', 'cancelling', 'cancelled'].includes(current.stage) && !canRetryCancellation(db, project.id, current)) fail(409, 'OOH_CANCELLATION_PENDING', 'A cancellation was already requested. Refresh the delivery report or review Broadsign before taking another action.');
          if (![3, 9, 10, 11].includes(before)) fail(409, 'OOH_NOT_CANCELLABLE', 'Only submitted, booked, or live proposals can be cancelled here. Review saved or ended proposals in Broadsign.');
          const latest = JSON.parse(db.prepare('SELECT data FROM project_ooh_bookings WHERE id=? AND project_id=?').get(booking.id, project.id).data);
          if (['cancellation-requested', 'cancelling', 'cancelled'].includes(latest.stage) && !canRetryCancellation(db, project.id, latest)) fail(409, 'OOH_CANCELLATION_PENDING', 'A cancellation was already requested. Refresh its provider status before continuing.');
          // This synchronous receipt blocks another local cancellation while the provider request is in flight.
          const previousCancellation = { stage: current.stage, cancellationOperationId: current.cancellationOperationId, cancellationRequestedAt: current.cancellationRequestedAt };
          const receipt = db.prepare("SELECT id FROM integration_operations WHERE project_id=? AND request_key=? AND status='pending'").get(project.id, req.headers['idempotency-key']);
          if (!receipt) fail(409, 'OOH_CANCELLATION_RECEIPT_REQUIRED', 'A durable cancellation receipt is required before contacting Broadsign.');
          current.providerStatus = before; current.stage = 'cancellation-requested'; current.cancellationOperationId = receipt.id; current.cancellationRequestedAt = new Date().toISOString(); saveBooking(db, project.id, current);
          try { await provider(env, `/api/v1/proposal/proposal_item/${current.lineItemId}/cancel`, undefined, 'POST'); }
          catch (error) {
            if (error instanceof IntegrationError && !error.uncertain) { Object.assign(current, previousCancellation); saveBooking(db, project.id, current); }
            throw error;
          }
          let checked;
          try { checked = await checkedProposal(env, connection, current, true); }
          catch { fail(409, 'OOH_CANCELLATION_UNCONFIRMED', 'Broadsign accepted the cancellation request, but its latest state could not be read. Reconcile it before retrying.', true); }
          const actual = Number(checked.proposal.status);
          Object.assign(current, { providerStatus: actual, stage: actual === 12 ? 'cancelled' : actual === 14 ? 'ended' : actual === 15 ? 'cancelling' : 'cancellation-requested' }); saveBooking(db, project.id, current);
          const placements = placementRecords(context, current);
          store?.activity(project.id, actual === 12 ? 'Broadsign confirmed an OOH cancellation.' : 'Requested an OOH cancellation; awaiting Broadsign confirmation.');
          return { booking: current, cancellation: { requested: true, confirmed: actual === 12 }, placements };
        }); send(result.status, result.data); return true;
      }
      if (route[2] === 'submit' && req.method === 'POST') {
        fields(body, ['confirmBooking']);
        if (body.confirmBooking !== true) fail(400, 'OOH_CONFIRMATION_REQUIRED', 'Explicitly confirm this paid booking before submission.');
        const result = await operation(context, async () => {
          if (booking.stage !== 'draft') fail(409, 'OOH_ALREADY_SUBMITTED', 'This proposal has already been submitted or requires reconciliation.');
          const available = await availability(env, connection, booking);
          if (available.availability !== 'available') fail(409, 'OOH_UNAVAILABLE', 'The requested inventory is not available for booking.');
          await provider(env, `/api/v1/proposal/book_proposal/${booking.proposalId}`, {});
          booking.stage = 'submitted'; saveBooking(db, project.id, booking);
          let proposal;
          try { ({ proposal } = await checkedProposal(env, connection, booking, true)); }
          catch { fail(409, 'OOH_STATUS_UNCONFIRMED', 'The provider accepted a booking request but its final status needs reconciliation in Broadsign.', true); }
          if (![3, 9, 10, 11].includes(Number(proposal.status))) fail(502, 'OOH_STATUS_UNCONFIRMED', 'Broadsign did not confirm booking submission. Reconcile the proposal before retrying.', true);
          booking.providerStatus = Number(proposal.status); saveBooking(db, project.id, booking); const placements = placementRecords(context, booking);
          store?.activity(project.id, 'Submitted an OOH proposal for Broadsign booking.'); return { booking, placements };
        }); send(result.status, result.data); return true;
      }
    }
    fail(404, 'OOH_ACTION_NOT_FOUND', 'This OOH action was not found.');
  } catch (error) {
    send(error instanceof IntegrationError ? error.status : 500, { error: { code: error instanceof IntegrationError ? error.code : 'OOH_ERROR', message: error instanceof IntegrationError ? error.message : 'The OOH request could not be completed.' } }); return true;
  }
}
