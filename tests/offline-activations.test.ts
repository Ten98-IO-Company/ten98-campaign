import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { postgresSkip, testApp } from './postgres.mjs';

async function start(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'campaign-offline-')), origin = 'http://127.0.0.1:3000';
  const app = await testApp(t, { dataDir, env: {}, appUrl: origin });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  async function request(path: string, method = 'GET', body?: unknown, cookie?: string): Promise<{ status: number; body: any; cookie?: string }> {
    const response = await fetch(base + '/api' + path, { method, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const owner = (await request('/auth/setup', 'POST', { token: app.config.bootstrapToken, name: 'Field Owner', email: 'offline-owner@example.test', password: 'a long offline fixture password', sample: false })).cookie;
  const state = (await request('/state', 'GET', undefined, owner)).body, workspaceId = state.workspaces[0].id;
  // Adds a workspace member with the given role and returns their id and session cookie.
  async function member(role: string | null, name: string) {
    const id = randomUUID(), email = `${name.toLowerCase()}@example.test`, hash = (await app.sql.get('SELECT password FROM users WHERE id=?', state.user.id)).password;
    await app.sql.run('INSERT INTO users VALUES(?,?,?,?)', id, name, email, hash);
    if (role) await app.sql.run('INSERT INTO memberships VALUES(?,?,?)', workspaceId, id, role);
    return { id, cookie: (await request('/auth/login', 'POST', { email, password: 'a long offline fixture password' })).cookie };
  }
  return { app, request, owner, state, project: `/projects/${state.projectId}`, member };
}

const stop = (campaignId: string) => ({ name: 'Mall roadshow — Saturday', type: 'roadshow', campaignId, startAt: '2026-11-07T10:00:00Z', endAt: '2026-11-07T18:00:00Z', location: 'City Centre Mall, atrium' });

test('offline activations are campaign records with validated plans, people and spend, and follow workspace roles', { skip: postgresSkip }, async t => {
  const { request, owner, state, project, member } = await start(t);
  const campaign = await request(project + '/campaigns', 'POST', { name: 'Winter field push', channel: 'offline', budget: 5000 }, owner);
  assert.equal(campaign.status, 201, 'Campaigns accept the offline channel.');
  const campaignId = campaign.body.record.id, editor = await member('editor', 'Erin'), viewer = await member('viewer', 'Vic'), outsider = await member(null, 'Olga');

  const created = await request(project + '/activations', 'POST', { ...stop(campaignId), latitude: 25.2, longitude: 55.3, ownerId: editor.id, teamIds: [state.user.id], materials: [{ label: 'Pop-up banner', done: false }, { label: '500 flyers', done: true }], budget: 1200, spent: 300, reached: 0, promoCode: 'MALL10', notes: 'Skip the food court.' }, owner);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const activation = created.body.record;
  assert.equal(activation.status, 'planned', 'New activations start planned.');
  assert.deepEqual(activation.materials, [{ label: 'Pop-up banner', done: false }, { label: '500 flyers', done: true }]);
  assert.equal(activation.promoCode, 'MALL10');

  const refused: [string, unknown][] = [['type', 'billboard'], ['startAt', ''], ['endAt', '2026-11-06T10:00:00Z'], ['location', ''], ['campaignId', ''], ['campaignId', 'missing'], ['status', 'live'], ['budget', -1], ['spent', 'lots'], ['reached', 2.5], ['latitude', 91], ['ownerId', outsider.id], ['ownerId', viewer.id], ['teamIds', [outsider.id]], ['teamIds', 'nobody'], ['materials', [{ label: '', done: false }]], ['materials', [{ label: 'Banner', done: 'yes' }]], ['materials', Array.from({ length: 31 }, (_, index) => ({ label: 'Item ' + index, done: false }))], ['promoCode', 'has spaces in it'], ['linkId', randomUUID()]];
  for (const [field, value] of refused) {
    assert.equal((await request(project + '/activations', 'POST', { ...stop(campaignId), [field]: value }, owner)).status, 400, `${field}=${JSON.stringify(value)} must be refused.`);
  }

  const updated = await request(project + '/activations/' + activation.id, 'PATCH', { status: 'completed', reached: 340, spent: 950, materials: [{ label: 'Pop-up banner', done: true }] }, editor.cookie);
  assert.equal(updated.status, 200, 'Editors run activations.'); assert.equal(updated.body.record.reached, 340);
  assert.equal((await request(project + '/activations/' + activation.id, 'PATCH', { reached: 1 }, viewer.cookie)).status, 403, 'Viewers are read only.');
  assert.equal((await request(project + '/activations', 'POST', stop(campaignId), outsider.cookie)).status, 404, 'Non-members cannot see the project.');
  const seen = (await request('/state', 'GET', undefined, viewer.cookie)).body.activations;
  assert.deepEqual(seen.map((row: { id: string }) => row.id), [activation.id], 'Members can read the activations of the selected project.');

  assert.equal((await request(project + '/campaigns/' + campaignId, 'DELETE', undefined, owner)).status, 409, 'A campaign with activations cannot be deleted.');
  assert.equal((await request(project + '/activations/' + activation.id, 'DELETE', undefined, owner)).status, 200);
  assert.equal((await request(project + '/campaigns/' + campaignId, 'DELETE', undefined, owner)).status, 200);
});
