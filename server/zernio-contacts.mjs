import { createHash, randomUUID } from 'node:crypto';
import { IntegrationError, operation, scopedAccounts, requireAccount } from './integrations.mjs';
import { publicMediaUrl } from '../shared/social-posts.mjs';

const fail = (status, code, message, uncertain = false) => { throw new IntegrationError(status, code, message, uncertain); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, maximum = 20000, empty = false) => typeof value === 'string' && value.length <= maximum && (empty || !!value.trim()) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const token = value => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\s\u0000-\u001f\u007f]/.test(value);
const providerId = value => typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value);
const slug = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(value);
const platforms = new Set(['instagram', 'facebook', 'telegram', 'twitter', 'bluesky', 'reddit', 'whatsapp', 'slack', 'sms']);
const writers = new Set(['owner', 'admin', 'editor']), admins = new Set(['owner', 'admin']), active = new WeakMap();
const fields = (body, allowed) => { if (!object(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_CONTACT_FIELDS', 'Use only the contact fields shown in this form.'); };
const stable = value => Array.isArray(value) ? value.map(stable) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(stable(value)) ?? 'undefined').digest('hex');
const invalid = (uncertain = false) => fail(502, 'INVALID_CONTACT_RESPONSE', 'Zernio did not return complete, scoped contact information.', uncertain);
const telephone = value => typeof value === 'string' && /^\+?[1-9]\d{6,14}$/.test(value) ? value.replace(/^\+/, '') : null;
const channelVersion = channel => digest(channel);
const localVersion = contact => digest(Object.fromEntries(['id', 'name', 'email', 'phone', 'company', 'tags', 'consents', 'suppression', 'consentEvidence', 'identities'].map(key => [key, contact[key] ?? null])));
const metadata = ['name', 'email', 'company', 'avatarUrl', 'tags', 'notes'];
function strings(value, maximum = 100) {
  return Array.isArray(value) && value.length <= maximum && value.every(item => text(item, 200)) && new Set(value).size === value.length;
}
function normalizeContact(value, expected) {
  if (!object(value) || !providerId(value.id) || expected && value.id !== expected || metadata.filter(key => key !== 'tags').some(key => value[key] !== undefined && !text(value[key], key === 'notes' ? 20000 : 1000, true)) || value.tags !== undefined && !strings(value.tags) || ['isSubscribed', 'isBlocked'].some(key => value[key] !== undefined && typeof value[key] !== 'boolean') || value.customFields !== undefined && !object(value.customFields)) invalid();
  return { id: value.id, ...Object.fromEntries(metadata.map(key => [key, value[key] ?? (key === 'tags' ? [] : '')])), isSubscribed: value.isSubscribed ?? null, isBlocked: value.isBlocked ?? null, customFields: value.customFields || {} };
}
function channels(value) {
  if (!Array.isArray(value) || value.length > 10000) invalid();
  const rows = value.map(row => {
    if (!object(row) || !providerId(row.id) || !token(row.accountId) || !platforms.has(row.platform) || !token(row.platformIdentifier) || row.displayIdentifier !== undefined && !text(row.displayIdentifier, 1000, true) || row.isSubscribed !== undefined && typeof row.isSubscribed !== 'boolean' || row.conversationId !== undefined && !token(row.conversationId)) invalid();
    const result = { id: row.id, accountId: row.accountId, platform: row.platform, platformIdentifier: row.platformIdentifier, displayIdentifier: row.displayIdentifier || '', isSubscribed: row.isSubscribed ?? null, conversationId: row.conversationId || null };
    if (['whatsapp', 'sms'].includes(row.platform) && !telephone(row.platformIdentifier)) invalid();
    return result;
  });
  if (new Set(rows.map(row => row.id)).size !== rows.length) invalid(); return rows;
}
async function page(api, profileId, accountId = '', options = {}) {
  const limit = options.limit || 25, skip = options.skip || 0, response = await api('/contacts', { profileId, ...(accountId ? { accountId } : {}), limit, skip, ...(options.search ? { search: options.search } : {}) });
  if (response.success !== true || !Array.isArray(response.contacts) || response.contacts.length > limit || !object(response.pagination) || !Number.isSafeInteger(response.pagination.total) || response.pagination.total < 0 || response.pagination.limit !== limit || response.pagination.skip !== skip || typeof response.pagination.hasMore !== 'boolean' || response.pagination.hasMore && response.contacts.length === 0) invalid();
  const rows = response.contacts.map(row => ({ ...normalizeContact(row), ...(token(row.platformIdentifier) ? { lookupIdentifier: row.platformIdentifier } : {}) })); if (new Set(rows.map(row => row.id)).size !== rows.length) invalid();
  return { rows, pagination: { total: response.pagination.total, limit, skip, hasMore: response.pagination.hasMore } };
}
async function membership(api, profileId, accountId, wanted) {
  const found = new Set();
  if (wanted?.size === 0) return found;
  // ponytail: verify at most 10,000 contacts per selection; narrow the provider audience above this ceiling.
  for (let skip = 0; skip < 10000; skip += 200) {
    const result = await page(api, profileId, accountId, { limit: 200, skip });
    for (const row of result.rows) if (!wanted || wanted.has(row.id)) found.add(row.id);
    if (wanted && found.size === wanted.size || !result.pagination.hasMore) return found;
  }
  fail(503, 'CONTACT_WINDOW_INCOMPLETE', 'This contact is beyond the verified contact window. Narrow the selection in Zernio.');
}
async function readContact(api, contactId) {
  const response = await api(`/contacts/${contactId}`); if (response.success !== true) invalid();
  const contact = normalizeContact(response.contact, contactId), linked = channels(response.channels);
  const version = digest({ ...contact, channels: linked }); return { ...contact, channels: linked, version };
}
async function phoneRows(api, profileId, accountId) {
  const rows = [];
  // ponytail: bulk reconciliation scans at most 10,000 contacts; split larger account migrations outside this app.
  for (let skip = 0; skip < 10000; skip += 200) {
    const result = await page(api, profileId, accountId, { limit: 200, skip });
    if (result.rows.some(row => !telephone(row.lookupIdentifier))) invalid(); rows.push(...result.rows.map(row => ({ id: row.id, phone: telephone(row.lookupIdentifier) })));
    if (!result.pagination.hasMore) return rows;
  }
  fail(503, 'CONTACT_WINDOW_INCOMPLETE', 'This account exceeds the verified bulk reconciliation window.');
}
function localIdentity(local, channel) {
  if (['whatsapp', 'sms'].includes(channel.platform)) return telephone(local.phone) === telephone(channel.platformIdentifier);
  return (local.identities || []).some(identity => identity.platform === channel.platform && identity.accountId === channel.accountId && identity.participantId === channel.platformIdentifier);
}
function permitted(local, channel) { return ['whatsapp', 'sms'].includes(channel.platform) && localIdentity(local, channel) && local.consents?.[channel.platform] === true && !local.suppression?.[channel.platform]; }
function field(row) {
  if (!object(row) || !providerId(row.id) || !text(row.name, 200) || !slug(row.slug) || !['text', 'number', 'date', 'boolean', 'select'].includes(row.type) || row.options !== undefined && !strings(row.options)) invalid();
  const result = { id: row.id, name: row.name, slug: row.slug, type: row.type, options: row.options || [] }; return { ...result, version: digest(result) };
}
async function definitions(api, profileId) {
  const response = await api('/custom-fields', { profileId }); if (response.success !== true || !Array.isArray(response.fields) || response.fields.length > 1000) invalid();
  const rows = response.fields.map(field); if (new Set(rows.map(row => row.id)).size !== rows.length || new Set(rows.map(row => row.slug)).size !== rows.length) invalid(); return rows;
}
function fieldValue(definition, value) {
  const date = typeof value === 'string' && /^\d{4}-\d\d-\d\d$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!(definition.type === 'text' && text(value, 20000, true) || definition.type === 'number' && typeof value === 'number' && Number.isFinite(value) || definition.type === 'boolean' && typeof value === 'boolean' || definition.type === 'date' && date || definition.type === 'select' && definition.options.includes(value))) fail(400, 'INVALID_CUSTOM_FIELD_VALUE', 'Use the value type and available choices defined for this field.');
  return value;
}
function patch(body) {
  fields(body, [...metadata, 'isBlocked']); if (!Object.keys(body).length) fail(400, 'CONTACT_CHANGE_REQUIRED', 'Change a contact field before saving.');
  for (const [key, value] of Object.entries(body)) {
    if (key === 'tags' ? !strings(value) : key === 'isBlocked' ? typeof value !== 'boolean' : !text(value, key === 'notes' ? 20000 : key === 'name' ? 200 : 1000, key !== 'name')) fail(400, 'INVALID_CONTACT_UPDATE', 'Provide valid contact text, tags and block settings.');
    if (key === 'email' && value && (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) fail(400, 'INVALID_CONTACT_EMAIL', 'Enter one valid email address.');
    if (key === 'avatarUrl' && value) try { publicMediaUrl(value); } catch { fail(400, 'INVALID_CONTACT_AVATAR', 'Use a public HTTPS avatar URL.'); }
  }
  return body;
}

export async function handleZernioContacts(context, api, profileId, action) {
  const { req, url, body = {}, db, project, role, send } = context;
  const contactRoute = /^contacts\/([a-f0-9]{24})(?:\/(link|unlink|update|delete|subscription)|\/fields\/([a-z][a-z0-9_]{0,99})\/(set|clear))?$/i.exec(action), fieldRoute = /^fields\/([a-f0-9]{24})\/(update|delete)$/i.exec(action);
  const mutation = req.method === 'POST';
  if (!(req.method === 'GET' && ['overview', 'contacts', 'fields'].includes(action)) && !(contactRoute && (req.method === 'GET' && !contactRoute[2] && !contactRoute[4] || mutation && (contactRoute[2] || contactRoute[4]))) && !(mutation && (['contacts/create', 'contacts/bulk', 'fields/create'].includes(action) || fieldRoute))) return false;
  db.exec(`CREATE TABLE IF NOT EXISTS zernio_contact_links(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,profile_id TEXT NOT NULL,account_id TEXT NOT NULL,local_contact_id TEXT NOT NULL REFERENCES direct_contacts(id) ON DELETE CASCADE,provider_contact_id TEXT NOT NULL,channel_id TEXT NOT NULL,platform TEXT NOT NULL,identifier TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(project_id,profile_id,account_id,provider_contact_id,channel_id),UNIQUE(project_id,profile_id,account_id,local_contact_id));
    CREATE TABLE IF NOT EXISTS zernio_contact_mutations(resource TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL)`);
  const assertAccess = () => context.assertProjectMapping?.(profileId), operator = () => Boolean(context.user?.isOperator && db.prepare('SELECT 1 FROM instance_operators WHERE user_id=?').get(context.user.id));
  assertAccess(); let accounts = (await scopedAccounts(api, profileId)).filter(account => platforms.has(account.platform));
  const localRows = () => context.contacts.list(project.id).map(contact => ({ ...contact, version: localVersion(contact) }));
  if (action === 'overview') { assertAccess(); send(200, { profileId, accounts: accounts.map(account => ({ id: account._id, platform: account.platform, name: account.displayName || account.username || account.platform, isActive: account.isActive !== false })), localContacts: localRows() }); return true; }
  const accountId = mutation ? body.accountId || '' : url.searchParams.get('accountId') || '';
  if (accountId) requireAccount(accounts, accountId);
  const links = providerContactId => db.prepare('SELECT id,account_id AS accountId,local_contact_id AS localContactId,provider_contact_id AS providerContactId,channel_id AS channelId,platform,identifier,created_at AS createdAt FROM zernio_contact_links WHERE project_id=? AND profile_id=? AND provider_contact_id=?').all(project.id, profileId, providerContactId).map(row => ({ ...row }));
  const inProfile = ids => membership(api, profileId, '', new Set(ids));
  function scoped(contact, originHere) {
    const ownChannels = contact.channels.filter(channel => { const account = accounts.find(row => row._id === channel.accountId); if (account && account.platform !== channel.platform) invalid(); return !!account; });
    if (accountId && !ownChannels.some(channel => channel.accountId === accountId) || !accountId && !originHere) fail(403, 'CONTACT_OUTSIDE_PROJECT', 'This contact is not available through the selected project scope.');
    return { ...contact, originHere, exclusive: originHere && ownChannels.length === contact.channels.length, ownChannels };
  }
  async function verified(contactId) {
    const selected = await membership(api, profileId, accountId, new Set([contactId])); if (!selected.has(contactId)) fail(403, 'CONTACT_OUTSIDE_PROJECT', 'This contact is not in the selected profile or connected account.');
    const origin = accountId ? await inProfile([contactId]) : selected;
    return scoped(await readContact(api, contactId), origin.has(contactId));
  }
  function view(contact) {
    const mixed = !contact.exclusive, linked = links(contact.id).filter(link => !link.channelId && !link.accountId && contact.originHere || contact.ownChannels.some(channel => channel.id === link.channelId && channel.accountId === link.accountId));
    const safeFields = Object.fromEntries(Object.entries(contact.customFields).filter(([, value]) => value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value) || text(value, 20000, true)));
    return { id: contact.id, name: mixed ? 'Shared contact' : contact.name, ...(mixed ? {} : Object.fromEntries(metadata.filter(key => key !== 'name').map(key => [key, contact[key]]))), customFields: mixed ? {} : safeFields, isSubscribed: contact.isSubscribed, isBlocked: contact.isBlocked, version: contact.version, originHere: contact.originHere, exclusive: contact.exclusive, metadataMasked: mixed, canReviewShared: admins.has(role) && operator(), channels: contact.ownChannels.map(channel => ({ ...channel, version: channelVersion(channel) })), links: linked };
  }
  async function freshAccounts() { assertAccess(); accounts = (await scopedAccounts(api, profileId)).filter(account => platforms.has(account.platform)); if (accountId && requireAccount(accounts, accountId).isActive === false) fail(409, 'CONTACT_CONNECTION_CHANGED', 'This connection needs reconnection before changing contacts.'); }
  function reviewShared(contact) { if (!contact.exclusive && !(operator() && body.reviewSharedContactId === contact.id && body.reviewProfileId === profileId)) fail(403, 'SHARED_CONTACT_REVIEW_REQUIRED', 'An instance operator must review the shared contact and current project profile before changing global contact data.'); }
  function local(id, expected) { const contact = context.contacts.get(project.id, id); if (!contact || localVersion(contact) !== expected) fail(409, 'LOCAL_CONTACT_CHANGED', 'This local contact or its channel permission changed. Reload and review it again.'); return contact; }
  function saveLink(contact, channel, localContact) {
    const existing = db.prepare('SELECT id,provider_contact_id,channel_id FROM zernio_contact_links WHERE project_id=? AND profile_id=? AND account_id=? AND local_contact_id=?').get(project.id, profileId, channel.accountId, localContact.id);
    if (existing && (existing.provider_contact_id !== contact.id || existing.channel_id !== channel.id)) fail(409, 'LOCAL_CONTACT_ALREADY_LINKED', 'This local contact is linked to another channel on that connected account. Unlink it explicitly first.');
    const other = links(contact.id).find(link => link.accountId === channel.accountId && link.channelId === channel.id && link.localContactId !== localContact.id); if (other) fail(409, 'PROVIDER_CONTACT_ALREADY_LINKED', 'This provider channel is already linked to a different local contact.');
    if (!existing) db.prepare('INSERT INTO zernio_contact_links VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), project.id, profileId, channel.accountId, localContact.id, contact.id, channel.id, channel.platform, channel.platformIdentifier, new Date().toISOString());
  }
  async function runWrite(resource, run, related = []) {
    const outcome = await operation(context, async key => {
      if (!active.has(db)) active.set(db, new Set()); const busy = active.get(db), resources = [resource, ...related];
      if (resources.some(resource => busy.has(resource))) fail(409, 'CONTACT_RESOURCE_BUSY', 'Another change to this contact or field definition is in progress.'); resources.forEach(resource => busy.add(resource)); let fenced = false, uncertain = false;
      try {
        for (const resource of resources) { const prior = db.prepare('SELECT m.project_id,m.request_key,o.status FROM zernio_contact_mutations m LEFT JOIN integration_operations o ON o.project_id=m.project_id AND o.request_key=m.request_key WHERE m.resource=?').get(resource); if (prior && (!prior.status || ['pending', 'uncertain'].includes(prior.status))) fail(409, 'CONTACT_PREVIOUS_OUTCOME_UNRESOLVED', 'This new change was not sent. Review the previous contact action in provider outcomes first.'); }
        for (const resource of resources) db.prepare('INSERT INTO zernio_contact_mutations VALUES(?,?,?) ON CONFLICT(resource) DO UPDATE SET project_id=excluded.project_id,request_key=excluded.request_key').run(resource, project.id, key); fenced = true;
        return await run(key);
      } catch (error) { uncertain = !(error instanceof IntegrationError) || error.uncertain; throw error; }
      finally { for (const resource of resources) { if (fenced && !uncertain) db.prepare('DELETE FROM zernio_contact_mutations WHERE resource=? AND project_id=? AND request_key=?').run(resource, project.id, key); busy.delete(resource); } }
    }, `contacts:${resource}`); send(outcome.status, outcome.data); return true;
  }
  if (!mutation) {
    if (action === 'fields') { const rows = await definitions(api, profileId); assertAccess(); send(200, { fields: rows }); return true; }
    if (action === 'contacts') {
      if ([...url.searchParams.keys()].some(key => !['accountId', 'search', 'limit', 'skip'].includes(key))) fail(400, 'INVALID_CONTACT_FILTER', 'Use account, search and pagination controls only.');
      const limit = Number(url.searchParams.get('limit') || 25), skip = Number(url.searchParams.get('skip') || 0), search = url.searchParams.get('search') || '';
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(skip) || skip < 0 || skip > 10000 || !text(search, 200, true)) fail(400, 'INVALID_CONTACT_FILTER', 'Choose valid contact filters and a page size of at most 100.');
      if (search) {
        const visible = [];
        // ponytail: search verifies at most 10,000 provider matches so hidden shared metadata cannot leak through counts or pagination.
        for (let offset = 0; offset < 10000; offset += 200) {
          const result = await page(api, profileId, accountId, { limit: 200, skip: offset, search }), origin = accountId ? await membership(api, profileId, '', new Set(result.rows.map(row => row.id))) : new Set(result.rows.map(row => row.id));
          for (const row of result.rows) { const safe = view(scoped(await readContact(api, row.id), origin.has(row.id))); if (!safe.metadataMasked && ['name', 'email', 'company'].some(key => String(safe[key] || '').toLowerCase().includes(search.toLowerCase()))) visible.push(safe); }
          if (!result.pagination.hasMore) { assertAccess(); send(200, { contacts: visible.slice(skip, skip + limit), pagination: { total: visible.length, limit, skip, hasMore: skip + limit < visible.length } }); return true; }
        }
        fail(503, 'CONTACT_WINDOW_INCOMPLETE', 'Narrow this contact search to fewer than 10,000 provider matches.');
      }
      const result = await page(api, profileId, accountId, { limit, skip, search }), origin = accountId ? await inProfile(result.rows.map(row => row.id)) : new Set(result.rows.map(row => row.id)), rows = [];
      for (const row of result.rows) rows.push(view(scoped(await readContact(api, row.id), origin.has(row.id))));
      assertAccess(); send(200, { contacts: rows, pagination: result.pagination }); return true;
    }
    const contact = await verified(contactRoute[1]); const channelResponse = await api(`/contacts/${contact.id}/channels`);
    if (channelResponse.success !== true || digest(channels(channelResponse.channels)) !== digest(contact.channels)) invalid();
    const contactFields = contact.originHere ? await definitions(api, profileId) : []; assertAccess(); send(200, { contact: view(contact), fields: contactFields }); return true;
  }
  const task = contactRoute?.[2] || contactRoute?.[4] || fieldRoute?.[2] || action.split('/')[1];
  if (!(task === 'link' || task === 'unlink' ? writers : admins).has(role)) fail(403, 'CONTACT_PERMISSION_REQUIRED', 'Your workspace role cannot perform this contact action.');
  if (fieldRoute || action.startsWith('fields/')) {
    fields(body, task === 'create' ? ['name', 'slug', 'type', 'options', 'confirmed'] : task === 'update' ? ['name', 'options', 'expectedVersion', 'confirmFieldId', 'reviewProfileId', 'confirmed'] : ['expectedVersion', 'confirmFieldId', 'reviewProfileId', 'confirmed']);
    return runWrite(`fields:${profileId}`, async key => {
      let before = await definitions(api, profileId); const current = fieldRoute ? before.find(row => row.id === fieldRoute[1]) : null;
      if (fieldRoute && (!current || current.version !== body.expectedVersion)) fail(409, 'CUSTOM_FIELD_CHANGED', 'Refresh and review the current field definition.');
      if (task !== 'create' && !(operator() && body.confirmFieldId === current.id && body.reviewProfileId === profileId)) fail(403, 'CUSTOM_FIELD_SCOPE_REVIEW_REQUIRED', 'An instance operator must review changes affecting this profile’s contact fields.');
      if (body.confirmed !== true) fail(400, 'CONTACT_REVIEW_REQUIRED', 'Review this field definition before continuing.');
      let payload;
      if (task !== 'delete') {
        if (!text(body.name, 200) || task === 'create' && (!slug(body.slug) || !['text', 'number', 'date', 'boolean', 'select'].includes(body.type)) || (body.type || current?.type) === 'select' && (!strings(body.options) || !body.options.length)) fail(400, 'INVALID_CUSTOM_FIELD', 'Provide a field name, supported type and select choices where needed.');
        payload = { name: body.name, ...((body.type || current?.type) === 'select' ? { options: body.options } : {}), ...(task === 'create' ? { profileId, slug: body.slug, type: body.type } : {}) };
        if (task === 'create' && before.some(row => row.slug === body.slug)) fail(409, 'CUSTOM_FIELD_EXISTS', 'This field slug already exists in the project profile.');
      }
      await freshAccounts();
      before = await definitions(api, profileId);
      if (current && (!operator() || !before.some(row => row.id === current.id && row.version === current.version))) fail(409, 'CUSTOM_FIELD_CHANGED', 'The field definition or operator permission changed. Reload and review it again.');
      if (!current && before.some(row => row.slug === body.slug)) fail(409, 'CUSTOM_FIELD_EXISTS', 'This field slug already exists in the project profile.');
      assertAccess();
      let response;
      try { response = await api(current ? `/custom-fields/${current.id}` : '/custom-fields', {}, payload, key, task === 'delete' ? 'DELETE' : task === 'update' ? 'PATCH' : 'POST'); }
      catch (error) { if (task !== 'delete' || !(error instanceof IntegrationError) || error.code !== 'INVALID_PROVIDER_RESPONSE') throw error; response = {}; }
      try {
        const after = await definitions(api, profileId);
        if (task === 'delete') { if (response.success === false || after.some(row => row.id === current.id)) invalid(); return { deletedFieldId: current.id }; }
        if (response.success !== true) invalid(); const receipt = field(response.field), saved = after.find(row => row.id === receipt.id);
        if (!saved || current && saved.id !== current.id || !current && before.some(row => row.id === saved.id) || saved.name !== payload.name || saved.type !== (current?.type || payload.type) || saved.slug !== (current?.slug || payload.slug) || digest(receipt) !== digest(saved) || payload.options && digest(saved.options) !== digest(payload.options)) invalid();
        return { field: saved };
      } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    });
  }
  if (task === 'create' || task === 'bulk') {
    fields(body, task === 'create' ? ['accountId', 'localContactId', 'expectedLocalVersion', 'platformIdentifier', 'confirmed'] : ['accountId', 'contacts', 'confirmed']);
    if (body.confirmed !== true) fail(400, 'CONTACT_REVIEW_REQUIRED', 'Review the local contact data and selected provider account first.');
    return runWrite(`account:${accountId || profileId}`, async key => {
      await freshAccounts(); const account = accountId ? requireAccount(accounts, accountId) : null;
      if (task === 'bulk') {
        if (!account || !['whatsapp', 'sms'].includes(account.platform) || !Array.isArray(body.contacts) || !body.contacts.length || body.contacts.length > 1000 || body.contacts.some(row => !object(row)) || new Set(body.contacts.map(row => row.localContactId)).size !== body.contacts.length) fail(400, 'INVALID_CONTACT_BULK', 'Select between 1 and 1,000 distinct local contacts and a WhatsApp or SMS account.');
        const selected = body.contacts.map(row => { fields(row, ['localContactId', 'expectedLocalVersion']); const contact = local(row.localContactId, row.expectedLocalVersion); if (!permitted(contact, { accountId, platform: account.platform, platformIdentifier: telephone(contact.phone) })) fail(409, 'LOCAL_CHANNEL_PERMISSION_REQUIRED', 'Bulk import cannot set subscription flags. Every imported phone contact needs current local permission and no suppression.'); return { contact, version: row.expectedLocalVersion }; });
        const before = await phoneRows(api, profileId, accountId), outgoing = selected.filter(row => !before.some(provider => provider.phone === telephone(row.contact.phone)));
        let receipt = null;
        if (outgoing.length) {
          await freshAccounts(); for (const row of selected) local(row.contact.id, row.version);
          // Empty tags prevent the provider's duplicate-import tag merge from changing another profile's shared metadata.
          const payload = { profileId, accountId, platform: account.platform, contacts: outgoing.map(({ contact }) => ({ name: contact.name || contact.phone, email: contact.email, company: contact.company, platformIdentifier: contact.phone, tags: [] })) };
          receipt = await api('/contacts/bulk', {}, payload, key);
        }
        try {
          if (receipt && (receipt.success !== true || ['created', 'skipped', 'total'].some(key => !Number.isSafeInteger(receipt[key]) || receipt[key] < 0) || receipt.total !== outgoing.length || receipt.created + receipt.skipped > receipt.total || !Array.isArray(receipt.errors) || receipt.errors.length > outgoing.length || receipt.errors.some(error => !text(error, 10000)))) invalid();
          const after = await phoneRows(api, profileId, accountId), candidates = new Set(after.filter(provider => selected.some(row => telephone(row.contact.phone) === provider.phone)).map(row => row.id)), origin = await membership(api, profileId, '', candidates), results = [];
          for (const row of selected) {
            const candidates = after.filter(provider => provider.phone === telephone(row.contact.phone));
            if (candidates.length !== 1) { results.push({ localContactId: row.contact.id, status: candidates.length ? 'ambiguous' : 'not_found', error: candidates.length ? 'More than one provider contact matched this phone. Review them individually.' : 'No matching provider channel was returned. This row was not linked.' }); continue; }
            const candidate = await readContact(api, candidates[0].id), scopedCandidate = scoped(candidate, origin.has(candidate.id)), channel = candidate.channels.find(channel => channel.accountId === accountId && channel.platform === account.platform && telephone(channel.platformIdentifier) === telephone(row.contact.phone));
            if (!channel) invalid();
            local(row.contact.id, row.version); assertAccess(); saveLink(candidate, channel, row.contact); results.push({ localContactId: row.contact.id, providerContactId: candidate.id, channelId: channel.id, status: 'linked', contact: view(scopedCandidate) });
          }
          return { results, partial: results.some(row => row.status !== 'linked'), providerReceipt: receipt ? { created: receipt.created, skipped: receipt.skipped, total: receipt.total, errorCount: receipt.errors.length } : null, existing: selected.length - outgoing.length, localConsentUnchanged: true };
        } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
      }
      const selected = local(body.localContactId, body.expectedLocalVersion); let identifier;
      if (account) {
        identifier = ['whatsapp', 'sms'].includes(account.platform) ? telephone(selected.phone) : body.platformIdentifier;
        if (!token(identifier)) fail(400, 'CONTACT_CHANNEL_ID_REQUIRED', 'Provide a valid recipient identifier for this connected account.');
      } else if (body.platformIdentifier !== undefined) fail(400, 'CONTACT_ACCOUNT_REQUIRED', 'Select an account before supplying a channel identifier.');
      const payload = { profileId, name: selected.name || selected.email || selected.phone, email: selected.email, company: selected.company, tags: selected.tags, isSubscribed: !!account && permitted(selected, { platform: account.platform, accountId, platformIdentifier: identifier }), ...(account ? { accountId, platform: account.platform, platformIdentifier: identifier, displayIdentifier: ['whatsapp', 'sms'].includes(account.platform) ? selected.phone : identifier } : {}) };
      const before = await membership(api, profileId, '', null);
      await freshAccounts(); local(selected.id, body.expectedLocalVersion);
      const response = await api('/contacts', {}, payload, key);
      try {
        if (response.success !== true || !providerId(response.contact?.id) || before.has(response.contact.id) || ['name', 'email', 'company', 'isSubscribed'].some(field => response.contact[field] !== payload[field]) || digest(response.contact.tags) !== digest(payload.tags)) invalid();
        const created = await readContact(api, response.contact.id), origin = await membership(api, profileId, '', new Set([created.id]));
        if (!origin.has(created.id) || ['name', 'email', 'company', 'isSubscribed'].some(field => created[field] !== payload[field]) || digest(created.tags) !== digest(payload.tags)) invalid();
        const scopedCreated = scoped(created, true);
        if (account) { const match = created.channels.find(channel => channel.accountId === accountId && channel.platform === account.platform && (telephone(identifier) ? telephone(channel.platformIdentifier) === telephone(identifier) : channel.platformIdentifier === identifier)); if (!match || response.channel?.id !== match.id || created.channels.length !== 1 || !payload.isSubscribed && match.isSubscribed !== false) invalid(); local(selected.id, body.expectedLocalVersion); saveLink(created, match, selected); }
        else { if (created.channels.length) invalid(); saveLink(created, { id: '', accountId: '', platform: '', platformIdentifier: selected.email || selected.phone }, selected); }
        assertAccess(); return { contact: view(scopedCreated), created: true };
      } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    });
  }
  const contactId = contactRoute[1];
  fields(body, ['accountId', 'expectedVersion', 'reviewSharedContactId', 'reviewProfileId', 'confirmed', ...(task === 'link' ? ['localContactId', 'expectedLocalVersion', 'channelId', 'expectedChannelVersion'] : task === 'unlink' ? ['linkId'] : task === 'update' ? ['changes'] : task === 'delete' ? ['confirmContactId'] : task === 'subscription' ? ['subscribed'] : task === 'set' ? ['value', 'expectedFieldVersion'] : ['expectedFieldVersion'])]);
  if (body.confirmed !== true) fail(400, 'CONTACT_REVIEW_REQUIRED', 'Review this contact action before continuing.');
  return runWrite(`contact:${contactId}`, async key => {
    let current = await verified(contactId); if (body.expectedVersion !== current.version) fail(409, 'PROVIDER_CONTACT_CHANGED', 'The connected contact changed. Reload and review it again.');
    if (task === 'link') {
      const selected = local(body.localContactId, body.expectedLocalVersion), channel = !body.channelId && current.originHere && !current.channels.length ? { id: '', accountId: '', platform: '', platformIdentifier: selected.email || selected.phone } : current.ownChannels.find(row => row.id === body.channelId);
      if (!channel || (channel.id ? channelVersion(channel) : current.version) !== body.expectedChannelVersion) fail(409, 'CONTACT_CHANNEL_CHANGED', 'Choose a current channel belonging to this project.');
      if (['whatsapp', 'sms'].includes(channel.platform) && !localIdentity(selected, channel)) fail(409, 'CONTACT_IDENTITY_MISMATCH', 'The local phone number must match this provider channel exactly.');
      assertAccess(); saveLink(current, channel, selected); return { contact: view(current), linked: true };
    }
    if (task === 'unlink') { const link = links(contactId).find(row => row.id === body.linkId); if (!link) fail(404, 'CONTACT_LINK_NOT_FOUND', 'This project contact link was not found.'); assertAccess(); db.prepare('DELETE FROM zernio_contact_links WHERE id=? AND project_id=?').run(link.id, project.id); return { contact: view(current), unlinked: true }; }
    await freshAccounts(); current = scoped(current, current.originHere); reviewShared(current);
    if (task === 'delete' && body.confirmContactId !== contactId) fail(400, 'CONTACT_DELETE_CONFIRMATION_REQUIRED', 'Confirm the exact contact before deleting all its provider channels.');
    let payload, definition, checkSubscription;
    if (task === 'update') payload = patch(body.changes);
    if (task === 'subscription') {
      if (typeof body.subscribed !== 'boolean') fail(400, 'INVALID_CONTACT_SUBSCRIPTION', 'Choose subscribe or unsubscribe explicitly.');
      const mapped = links(contactId);
      if (body.subscribed) {
        checkSubscription = () => { if (!current.exclusive || !current.channels.length || current.isBlocked !== false || current.channels.some(channel => { const link = mapped.find(row => row.channelId === channel.id && row.accountId === channel.accountId), selected = link && context.contacts.get(project.id, link.localContactId); return !selected || !permitted(selected, channel); })) fail(409, 'LOCAL_CHANNEL_PERMISSION_REQUIRED', 'Subscription needs an unblocked, exclusive contact with every phone channel linked to a locally permitted, unsuppressed destination.'); };
        checkSubscription();
      } else for (const channel of current.ownChannels) if (['whatsapp', 'sms'].includes(channel.platform)) context.contacts.suppressDestination(project.id, channel.platform, '+' + telephone(channel.platformIdentifier), 'Unsubscribed in connected contact settings');
      payload = { isSubscribed: body.subscribed };
    }
    if (task === 'set' || task === 'clear') {
      if (!current.originHere) fail(403, 'CUSTOM_FIELD_PROFILE_MISMATCH', 'This contact was created in another profile. Its field definitions cannot be changed through this project.');
      definition = (await definitions(api, profileId)).find(row => row.slug === contactRoute[3]); if (!definition || definition.version !== body.expectedFieldVersion) fail(409, 'CUSTOM_FIELD_CHANGED', 'Reload the current field definition before changing its value.');
      if (task === 'set') payload = { value: fieldValue(definition, body.value) };
    }
    const target = `/contacts/${contactId}${definition ? `/fields/${definition.slug}` : ''}`;
    await freshAccounts(); const beforeWrite = await verified(contactId);
    if (beforeWrite.version !== body.expectedVersion) fail(409, 'PROVIDER_CONTACT_CHANGED', 'This contact changed while preparing the action. Reload and review it again.');
    current = beforeWrite; reviewShared(current); checkSubscription?.(); assertAccess();
    if (definition && !(await definitions(api, profileId)).some(row => row.id === definition.id && row.version === definition.version)) fail(409, 'CUSTOM_FIELD_CHANGED', 'The field definition changed while preparing this value. Reload and review it again.');
    assertAccess();
    let response;
    try { response = await api(target, {}, payload, key, task === 'delete' || task === 'clear' ? 'DELETE' : task === 'set' ? 'PUT' : 'PATCH'); }
    catch (error) { if (!['delete', 'set', 'clear'].includes(task) || !(error instanceof IntegrationError) || error.code !== 'INVALID_PROVIDER_RESPONSE') throw error; response = {}; }
    try {
      if (task === 'delete') {
        if (response.success === false) invalid(); let removed = false;
        try { await readContact(api, contactId); } catch (error) { if (error instanceof IntegrationError && (error.providerStatus === 404 || error.status === 404)) removed = true; else throw error; }
        if (!removed) invalid(); assertAccess(); db.prepare('DELETE FROM zernio_contact_links WHERE project_id=? AND profile_id=? AND provider_contact_id=?').run(project.id, profileId, contactId); return { deletedContactId: contactId, localContactsKept: true };
      }
      await freshAccounts(); const fresh = await verified(contactId);
      if (task === 'set' ? digest(fresh.customFields[definition.slug]) !== digest(payload.value) : task === 'clear' ? Object.hasOwn(fresh.customFields, definition.slug) : response.success !== true || !object(response.contact) || response.contact.id !== contactId || Object.entries(payload).some(([key, value]) => digest(response.contact[key]) !== digest(value) || digest(fresh[key]) !== digest(value))) invalid();
      if (definition && !(await definitions(api, profileId)).some(row => row.id === definition.id && row.version === definition.version)) invalid();
      assertAccess(); return { contact: view(fresh), updated: true };
    } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
  }, task === 'set' || task === 'clear' ? [`fields:${profileId}`] : []);
}
