// Regression tests for the queries in server/calendar.ts: calendar mappings, plan generations and the unfinished-sync
// check, one assertion per query, over a real PostgreSQL database. calendar.test.mjs covers the end-to-end sync scenarios.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { handleCalendar } from '../server/calendar.ts';
import { postgresSkip, testDatabase } from './postgres.mjs';
import { seedAccounts } from './fixtures/accounts.ts';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const env = { GOOGLE_SERVICE_ACCOUNT_EMAIL: 'qa@example.test', GOOGLE_PRIVATE_KEY: privateKey };
type Reply = { status: number; data: any };
type Post = Record<string, unknown>;

// The Google event ID the app derives for a planned record (eventId in server/calendar.ts).
const eventId = (projectId: string, collection: string, recordId: string, accountId = '', generation = 0) => 'ten98' + createHash('sha256').update(`${projectId}:${collection}:${recordId}${accountId ? ':account:' + accountId : ''}${generation ? ':generation:' + generation : ''}`).digest('hex');
const postStore = (posts: Post[] = []) => ({ list: async (_project: string, collection: string) => collection === 'posts' ? structuredClone(posts) : [], activity: async () => undefined });

// A database holding the given projects, and a caller that runs one calendar request as an operator who owns the project.
async function fixture(t: TestContext, projects: string[]) {
  const { db, pool } = await testDatabase(t);
  await seedAccounts(pool, { workspaces: [{ id: 'workspace', name: 'Workspace' }] });
  for (const id of projects) await pool.query('INSERT INTO projects (id, workspace_id, name) VALUES ($1, $2, $3)', [id, 'workspace', id]);
  let sequence = 0;
  const caller = (project: string, store: ReturnType<typeof postStore> = postStore()) => async (suffix: string, { method = 'GET', body = {} as unknown } = {}): Promise<Reply> => {
    let reply: Reply | undefined;
    await handleCalendar({ req: { method, headers: { 'idempotency-key': `calendar-queries-${++sequence}` } }, url: new URL(`http://localhost/api/projects/${project}/calendar/${suffix}`), project: { id: project }, user: { isOperator: true }, role: 'owner', db, store, body, config: { env }, send(status, data) { reply = { status, data }; } });
    return reply!;
  };
  return { pool, caller, map: (project: string, calendarId: string) => pool.query('INSERT INTO calendar_connections VALUES ($1, $2)', [project, calendarId]) };
}

// Replaces fetch with a Google Calendar that lists `events`, answers a single-event read with 404 and echoes writes.
function googleStub() {
  const original = globalThis.fetch, state = { events: [] as unknown[], calls: [] as { method: string; id?: string }[] };
  globalThis.fetch = async (target: string | URL | Request, options: RequestInit = {}) => {
    const url = new URL(String(target));
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture-token' });
    const method = options.method || 'GET', id = url.pathname.split('/events/')[1];
    state.calls.push({ method, id });
    if (method !== 'GET') return Response.json({ ...JSON.parse(String(options.body)), etag: '"revision"' });
    return id ? Response.json({}, { status: 404 }) : Response.json({ items: state.events });
  };
  return Object.assign(state, { restore() { globalThis.fetch = original; } });
}

test('mapping a calendar replaces the earlier one, refuses a calendar another project holds and clears with an empty ID', { skip: postgresSkip }, async t => {
  const { pool, caller } = await fixture(t, ['project-a', 'project-b']), a = caller('project-a'), b = caller('project-b');
  const map = (call: typeof a, calendarId: string) => call('connection', { method: 'POST', body: { calendarId } });
  const mappings = async () => Object.fromEntries((await pool.query('SELECT project_id, calendar_id FROM calendar_connections')).rows.map(row => [row.project_id, row.calendar_id]));
  assert.equal((await map(a, 'one@example.test')).status, 200); assert.deepEqual(await mappings(), { 'project-a': 'one@example.test' });
  assert.equal((await map(a, 'two@example.test')).status, 200); assert.deepEqual(await mappings(), { 'project-a': 'two@example.test' }, 'Mapping again replaces the earlier calendar.');
  assert.equal((await map(b, 'two@example.test')).status, 409); assert.deepEqual(await mappings(), { 'project-a': 'two@example.test' }, 'A calendar another project holds is refused.');
  assert.equal((await map(a, 'two@example.test')).status, 200, 'A project may map the calendar it already holds.');
  assert.equal((await map(b, 'one@example.test')).status, 200, 'A calendar the first project left is free.');
  assert.deepEqual((await a('status')).data, { configured: true, mapped: true, calendarId: 'two@example.test' }); assert.deepEqual((await b('status')).data, { configured: true, mapped: true, calendarId: 'one@example.test' });
  assert.equal((await map(a, '')).status, 200); assert.deepEqual(await mappings(), { 'project-b': 'one@example.test' }, 'An empty ID removes only this project’s mapping.');
  assert.deepEqual((await a('status')).data, { configured: true, mapped: false, calendarId: '' });
});

test('plan generations only move forward, whatever order Google lists events in', { skip: postgresSkip }, async t => {
  const { pool, caller, map } = await fixture(t, ['project-a']), stub = googleStub(), call = caller('project-a');
  try {
    await map('project-a', 'plan@example.test'); await pool.query("INSERT INTO calendar_plan_generations VALUES ('project-a', 'plan@example.test', 'posts', 'rec1', '', 3, 3)");
    const planEvent = (recordId: string, generation: number) => ({ id: eventId('project-a', 'posts', recordId, '', generation), summary: 'Plan', start: { dateTime: '2070-01-01T10:00:00Z' }, end: { dateTime: '2070-01-01T10:30:00Z' }, extendedProperties: { private: { ten98ProjectId: 'project-a', ten98RecordId: recordId, ten98Collection: 'posts', ...(generation ? { ten98Generation: String(generation) } : {}) } } });
    const generations = async () => (await pool.query('SELECT record_id, generation, known_generation FROM calendar_plan_generations ORDER BY record_id')).rows;
    // [generation of the listed event, stored generation, stored known generation]
    for (const [listed, generation, known] of [[1, 3, 3], [5, 5, 5], [2, 5, 5]]) {
      stub.events = [planEvent('rec1', listed)]; assert.equal((await call('events')).status, 200);
      assert.deepEqual(await generations(), [{ record_id: 'rec1', generation, known_generation: known }], `after listing generation ${listed}`);
    }
    stub.events = [planEvent('rec2', 0)]; assert.equal((await call('events')).status, 200);
    assert.deepEqual(await generations(), [{ record_id: 'rec1', generation: 5, known_generation: 5 }, { record_id: 'rec2', generation: 0, known_generation: 0 }], 'A first sighting records its own generation as known.');
  } finally { stub.restore(); }
});

test('the plan uses only the generations of its project and mapped calendar', { skip: postgresSkip }, async t => {
  const { pool, caller, map } = await fixture(t, ['project-a', 'project-b']), stub = googleStub(), call = caller('project-a', postStore([{ id: 'rec1', content: 'Hello', scheduledAt: '2070-01-01T10:00:00Z' }]));
  try {
    await map('project-a', 'plan@example.test');
    // The project's own row first; the rows of another project and of another calendar follow, so a missing filter would let them win.
    await pool.query("INSERT INTO calendar_plan_generations VALUES ('project-a', 'plan@example.test', 'posts', 'rec1', '', 2, -1), ('project-b', 'plan@example.test', 'posts', 'rec1', '', 9, -1), ('project-a', 'other@example.test', 'posts', 'rec1', '', 8, -1)");
    const plan = await call('plan'); assert.equal(plan.status, 200, JSON.stringify(plan.data));
    assert.deepEqual(plan.data.upserts.map((event: { id: string }) => event.id), [eventId('project-a', 'posts', 'rec1', '', 2)]);
  } finally { stub.restore(); }
});

test('a planned event Google no longer lists is probed only for an account Google is known to have held', { skip: postgresSkip }, async t => {
  const post = { id: 'rec1', content: 'Hello', platforms: ['instagram'], accounts: ['first', 'second'], scheduledAt: '2070-01-01T10:00:00Z', accountOverrides: { first: { platform: 'instagram', content: 'First caption', scheduledAt: '' }, second: { platform: 'instagram', content: 'Second caption', scheduledAt: '2070-01-03T10:00:00Z' } } };
  const { pool, caller, map } = await fixture(t, ['project-a']), stub = googleStub(), call = caller('project-a', postStore([post]));
  try {
    await map('project-a', 'plan@example.test');
    await pool.query("INSERT INTO calendar_plan_generations VALUES ('project-a', 'plan@example.test', 'posts', 'rec1', 'first', 0, 0)");
    const plan = await call('plan'); assert.equal(plan.status, 200, JSON.stringify(plan.data));
    assert.deepEqual(stub.calls.filter(request => request.id).map(request => request.id), [eventId('project-a', 'posts', 'rec1', 'first')], 'Only the account with a known generation is read back from Google.');
  } finally { stub.restore(); }
});

test('an unfinished plan sync of the project blocks the next one; other projects, other actions and settled syncs do not', { skip: postgresSkip }, async t => {
  const { pool, caller, map } = await fixture(t, ['project-a', 'project-b']), stub = googleStub(), call = caller('project-a', postStore([{ id: 'rec1', content: 'Plan', scheduledAt: '2070-01-01T10:00:00Z' }]));
  try {
    await map('project-a', 'plan@example.test');
    // Each earlier receipt has its own resource key, so only the sync's own check can stop the request.
    const receipt = (id: string, project: string, status: string, actionPath: string) => pool.query("INSERT INTO integration_operations (id, project_id, request_key, request_hash, status, created_at, action_path, resource_key) VALUES ($1, $2, $3, 'unrelated-hash', $4, $5, $6, 'earlier-action')", [id, project, 'key-' + id, status, new Date().toISOString(), actionPath]);
    await receipt('other-project', 'project-b', 'uncertain', 'POST /calendar/sync'); await receipt('failed', 'project-a', 'failed', 'POST /calendar/sync'); await receipt('reviewed', 'project-a', 'reviewed-applied', 'POST /calendar/sync');
    await receipt('other-action', 'project-a', 'uncertain', 'POST /calendar/events'); await receipt('legacy-other-request', 'project-a', 'uncertain', '');
    const synced = await call('sync', { method: 'POST' }); assert.equal(synced.status, 200, JSON.stringify(synced.data)); assert.equal(synced.data.created, 1);
    await receipt('blocking', 'project-a', 'pending', 'POST /calendar/sync');
    const writes = () => stub.calls.filter(request => request.method !== 'GET').length, before = writes();
    const blocked = await call('sync', { method: 'POST' });
    assert.equal(blocked.status, 409); assert.match(blocked.data.error.message, /earlier unconfirmed Calendar plan sync/); assert.equal(writes(), before, 'No Google write follows.');
  } finally { stub.restore(); }
});
