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

test('staff capture leads at an activation with explicit per-channel consent, and suppression and unticked boxes are respected', { skip: postgresSkip }, async t => {
  const { app, request, owner, project, member } = await start(t);
  const campaignId = (await request(project + '/campaigns', 'POST', { name: 'Winter field push', channel: 'offline' }, owner)).body.record.id;
  const activation = (await request(project + '/activations', 'POST', stop(campaignId), owner)).body.record, leads = `${project}/activations/${activation.id}/leads`;
  const editor = await member('editor', 'Erin'), viewer = await member('viewer', 'Vic'), count = async () => Number((await app.sql.get('SELECT count(*)::int AS n FROM direct_contacts')).n);
  const tag = 'offline:' + activation.id.slice(0, 8);

  let response = await request(leads, 'POST', { name: 'Pat Doe', email: 'pat@example.test', phone: '+447700900123', consents: { email: true, sms: true, whatsapp: false } }, editor.cookie);
  assert.equal(response.status, 201, JSON.stringify(response.body)); assert.deepEqual([response.body.recorded, response.body.refused], [['email', 'sms'], []]);
  assert.equal(JSON.stringify(response.body).includes('pat@example.test'), false, 'The staff phone gets no contact details back.');
  let contact = (await request(project + '/direct/contacts', 'GET', undefined, owner)).body.contacts.find((row: any) => row.email === 'pat@example.test');
  // The field wording asks for news and offers, so an email opt-in is also marketing permission (#165).
  assert.deepEqual(contact.consents, { email: true, sms: true, whatsapp: false, emailMarketing: true }); assert.deepEqual(contact.tags, [tag]);
  for (const channel of ['email', 'sms', 'emailMarketing']) assert.match(contact.consentEvidence[channel].source, /In person at Roadshow stop “Mall roadshow — Saturday” .* recorded by Erin\. Wording shown: “.*Brand launch.*”/);

  const before = await count();
  assert.equal((await request(leads, 'POST', { name: 'No thanks', email: 'nothanks@example.test', consents: { email: false } }, editor.cookie)).status, 400, 'Without an opt-in nothing is stored.');
  assert.equal((await request(leads, 'POST', { email: 'x@example.test', consents: { sms: true } }, editor.cookie)).status, 400, 'SMS consent needs a phone number.');
  assert.equal((await request(leads, 'POST', { email: 'x@example.test', consents: { email: true }, notes: 'lives at no. 4' }, editor.cookie)).status, 400, 'Only minimal fields are accepted.');
  assert.equal((await request(leads, 'POST', { email: 'x@example.test', consents: { email: true } }, viewer.cookie)).status, 403);
  assert.equal((await request(`${project}/activations/${campaignId}/leads`, 'POST', { email: 'x@example.test', consents: { email: true } }, editor.cookie)).status, 404);
  assert.equal(await count(), before);

  await request(`${project}/direct/contacts/${contact.id}/suppress`, 'POST', { channel: 'email', reason: 'Asked not to be contacted' }, owner);
  response = await request(leads, 'POST', { email: 'pat@example.test', consents: { email: true } }, editor.cookie);
  assert.equal(response.status, 409, 'A suppressed destination cannot be opted back in from the field.'); assert.match(response.body.error, /opted out/);
  contact = (await request(project + '/direct/contacts', 'GET', undefined, owner)).body.contacts.find((row: any) => row.id === contact.id);
  assert.equal(contact.consents.email, false); assert.equal(contact.consents.emailMarketing, false); assert.equal(contact.consents.sms, true, 'An unticked box never withdraws an existing opt-in.');

  const second = (await request(project + '/activations', 'POST', { ...stop(campaignId), name: 'Station flyering', type: 'street_team' }, owner)).body.record;
  response = await request(`${project}/activations/${second.id}/leads`, 'POST', { name: 'Someone else', phone: '+447700900123', consents: { whatsapp: true } }, editor.cookie);
  assert.equal(response.status, 201, JSON.stringify(response.body)); contact = (await request(project + '/direct/contacts', 'GET', undefined, owner)).body.contacts.find((row: any) => row.id === contact.id);
  assert.deepEqual(contact.tags, [tag, 'offline:' + second.id.slice(0, 8)], 'Repeat meetings add the activation tag.'); assert.equal(contact.name, 'Pat Doe', 'A field entry does not rename a known contact.');

  await request(project + '/activations/' + second.id, 'PATCH', { status: 'cancelled' }, owner);
  assert.equal((await request(`${project}/activations/${second.id}/leads`, 'POST', { email: 'late@example.test', consents: { email: true } }, editor.cookie)).status, 409, 'Cancelled activations take no leads.');

  // Rate limit per staff member, counting refused attempts too, so a stolen session cannot flood Contacts.
  const busy = await member('editor', 'Bo'), statuses = [];
  for (let attempt = 0; attempt < 121; attempt++) statuses.push((await request(leads, 'POST', { consents: {} }, busy.cookie)).status);
  assert.deepEqual([statuses.slice(0, 120).every(status => status === 400), statuses[120]], [true, 429]);
  assert.equal((await request(leads, 'POST', { email: 'still-fine@example.test', consents: { email: true } }, editor.cookie)).status, 201, 'Each staff member has their own allowance.');
});

test('activation results count leads by tag and link visits and scans, and the calendar plan shows activations as timed events', { skip: postgresSkip }, async t => {
  const { app, request, owner, project } = await start(t);
  const campaignId = (await request(project + '/campaigns', 'POST', { name: 'Winter field push', channel: 'offline' }, owner)).body.record.id;
  const mall = (await request(project + '/activations', 'POST', stop(campaignId), owner)).body.record;
  const station = (await request(project + '/activations', 'POST', { ...stop(campaignId), name: 'Station flyering', type: 'street_team', status: 'cancelled' }, owner)).body.record;
  const link = (await request(project + '/links', 'POST', { name: 'Mall stop', destination: 'https://shop.example.com/winter?utm_medium=offline', campaignId }, owner)).body.link;
  await request(project + '/activations/' + mall.id, 'PATCH', { linkId: link.id }, owner);
  await app.sql.run('INSERT INTO campaign_link_daily VALUES(?,?,?,?),(?,?,?,?)', link.id, '2026-11-07', 40, 12, link.id, '2026-11-08', 5, 3);
  for (const [email, consents] of [['a@example.test', { email: true }], ['b@example.test', { email: true }]] as const) assert.equal((await request(`${project}/activations/${mall.id}/leads`, 'POST', { email, consents }, owner)).status, 201);
  await request(project + '/direct/contacts', 'POST', { email: 'manual@example.test', tags: ['offline:not-ours'] }, owner);

  const results = await request(project + '/activations/results', 'GET', undefined, owner);
  assert.equal(results.status, 200, JSON.stringify(results.body));
  assert.deepEqual(results.body.results, { [mall.id]: { leads: 2, clicks: 45, qrScans: 15 }, [station.id]: { leads: 0, clicks: 0, qrScans: 0 } });

  const { calendarPlan } = await import('../server/calendar.ts');
  const { createStore } = await import('../server/database.ts');
  const plan = await calendarPlan(createStore(app.database.db), (await request('/state', 'GET', undefined, owner)).body.projectId);
  const field = plan.filter((event: any) => event.extendedProperties.private.ten98Collection === 'activations');
  assert.deepEqual(field.map((event: any) => [event.summary, event.start, event.end]), [['Field · Mall roadshow — Saturday', { dateTime: mall.startAt }, { dateTime: mall.endAt }]], 'Cancelled activations stay off the calendar.');
  assert.match(field[0].description, /Roadshow stop · City Centre Mall, atrium/);
});

test('a member who leaves or loses editing access is dropped from an activation instead of blocking later edits', { skip: postgresSkip }, async t => {
  const { app, request, owner, state, project, member } = await start(t);
  const campaignId = (await request(project + '/campaigns', 'POST', { name: 'Winter field push', channel: 'offline' }, owner)).body.record.id;
  const erin = await member('editor', 'Erin'), dan = await member('editor', 'Dan'), workspaceId = state.workspaces[0].id;
  const activation = (await request(project + '/activations', 'POST', { ...stop(campaignId), ownerId: erin.id, teamIds: [erin.id, dan.id, state.user.id] }, owner)).body.record;
  await app.sql.run("UPDATE memberships SET role='viewer' WHERE workspace_id=? AND user_id=?", workspaceId, erin.id);
  await app.sql.run('DELETE FROM memberships WHERE workspace_id=? AND user_id=?', workspaceId, dan.id);

  const edited = await request(project + '/activations/' + activation.id, 'PATCH', { reached: 25 }, owner);
  assert.equal(edited.status, 200, 'An edit that does not touch people still saves: ' + JSON.stringify(edited.body));
  assert.deepEqual([edited.body.record.reached, edited.body.record.ownerId, edited.body.record.teamIds], [25, '', [state.user.id]], 'Stale owner and team are dropped, current members kept.');
  assert.equal((await request(project + '/activations/' + activation.id, 'PATCH', { teamIds: [state.user.id, erin.id] }, owner)).status, 400, 'People chosen in this edit must still be editing members.');
  assert.equal((await request(project + '/activations/' + activation.id, 'PATCH', { ownerId: dan.id }, owner)).status, 400);
});

test('activations only reference campaigns and links of their own project, and viewers cannot create or delete them', { skip: postgresSkip }, async t => {
  const { request, owner, state, project, member } = await start(t);
  const campaignId = (await request(project + '/campaigns', 'POST', { name: 'Winter field push', channel: 'offline' }, owner)).body.record.id;
  const other = `/projects/${(await request('/projects', 'POST', { workspaceId: state.workspaces[0].id, name: 'Other brand' }, owner)).body.project.id}`;
  const foreignCampaign = (await request(other + '/campaigns', 'POST', { name: 'Other campaign', channel: 'offline' }, owner)).body.record.id;
  const foreignLink = (await request(other + '/links', 'POST', { name: 'Other link', destination: 'https://shop.example.com/other', campaignId: foreignCampaign }, owner)).body.link.id;
  assert.equal((await request(project + '/activations', 'POST', stop(foreignCampaign), owner)).status, 400, 'A campaign from another project is refused.');
  assert.equal((await request(project + '/activations', 'POST', { ...stop(campaignId), linkId: foreignLink }, owner)).status, 400, 'A link from another project is refused.');
  const activation = (await request(project + '/activations', 'POST', stop(campaignId), owner)).body.record, viewer = await member('viewer', 'Vic');
  assert.equal((await request(project + '/activations', 'POST', stop(campaignId), viewer.cookie)).status, 403);
  assert.equal((await request(project + '/activations/' + activation.id, 'DELETE', undefined, viewer.cookie)).status, 403);
});
