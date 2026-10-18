import { createHash } from 'node:crypto';
import { IntegrationError, operation, scopedAccounts, requireAccount, adAccounts, mediaUrl, validProviderInstant } from './integrations.mjs';

const platforms = new Set(['metaads', 'facebook', 'instagram', 'linkedinads']), administrators = new Set(['owner', 'admin']), writers = new Set(['owner', 'admin', 'editor']), initialized = new WeakSet();
const fail = (status, code, message, uncertain = false) => { throw new IntegrationError(status, code, message, uncertain); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const token = value => typeof value === 'string' && !!value && value.length <= 500 && !/[\s\u0000-\u001f\u007f]/.test(value);
const identifier = value => { if (!token(value)) fail(400, 'INVALID_LEAD_ID', 'Choose a valid advertising account, form or lead.'); return value; };
const text = (value, maximum = 20000) => typeof value === 'string' && value.length <= maximum && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const label = (value, maximum = 200) => { if (!text(value, maximum) || !value.trim()) fail(400, 'INVALID_LEAD_SETTINGS', 'Complete the required form fields using plain text.'); return value.trim(); };
const fields = (body, allowed) => { if (!object(body) || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_LEAD_FIELDS', 'Use only the lead controls shown in this form.'); };
const invalid = (uncertain = false) => fail(502, 'INVALID_PROVIDER_RESPONSE', 'Zernio returned an unreadable lead form or lead response.', uncertain);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const encoded = value => encodeURIComponent(value);
const formIdentifier = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : value;
const localized = value => typeof value === 'string' ? value : object(value?.localized) ? Object.values(value.localized).find(item => typeof item === 'string') || '' : '';
function tables(db) {
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS zernio_lead_associations(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,profile_id TEXT NOT NULL,account_id TEXT NOT NULL,form_id TEXT NOT NULL,lead_id TEXT NOT NULL,contact_id TEXT NOT NULL REFERENCES direct_contacts(id) ON DELETE CASCADE,lead_version TEXT NOT NULL,imported_at TEXT NOT NULL,PRIMARY KEY(project_id,profile_id,account_id,form_id,lead_id));
    CREATE TABLE IF NOT EXISTS zernio_test_leads(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,profile_id TEXT NOT NULL,account_id TEXT NOT NULL,form_id TEXT NOT NULL,lead_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(project_id,profile_id,account_id,form_id,lead_id));
    CREATE TABLE IF NOT EXISTS zernio_lead_mutations(project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,request_key TEXT NOT NULL);`);
  initialized.add(db);
}
function page(value, limit) {
  if (!object(value) || typeof value.hasMore !== 'boolean' || value.cursor != null && (!token(value.cursor) || value.cursor.length > 500) || value.hasMore && !value.cursor) invalid();
  return { hasMore: value.hasMore, cursor: value.cursor ?? null };
}
function filters(url) {
  if ([...url.searchParams.keys()].some(key => !['adAccountId', 'cursor', 'limit'].includes(key))) fail(400, 'INVALID_LEAD_FILTER', 'Use the available advertising account and pagination controls.');
  const limit = Number(url.searchParams.get('limit') || 25), cursor = url.searchParams.get('cursor');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || cursor !== null && !token(cursor)) fail(400, 'INVALID_LEAD_FILTER', 'Choose a page size between 1 and 100 and a valid page cursor.');
  return { limit, ...(cursor ? { cursor } : {}) };
}
function question(row, index) {
  if (!object(row)) invalid();
  const key = row.key || row.name || row.predefinedField?.toLowerCase() || ({ EMAIL: 'email', PHONE: 'phone_number', FULL_NAME: 'full_name', FIRST_NAME: 'first_name', LAST_NAME: 'last_name' }[row.type]) || String(row.questionId ?? row.id ?? index);
  const name = localized(row.label || row.question || row.name || row.predefinedField || row.type), type = row.type || row.kind || (row.typeSpecificQuestionDetails?.multipleChoiceQuestionDetails ? 'multipleChoice' : 'text');
  if (!text(String(key), 200) || !String(key).trim() || !text(name, 2000) || !text(type, 100)) invalid();
  const choices = row.options || row.choices || row.typeSpecificQuestionDetails?.multipleChoiceQuestionDetails?.choices || [];
  if (!Array.isArray(choices) || choices.length > 100) invalid();
  const options = choices.map(choice => { if (!object(choice) || !text(String(choice.key ?? choice.id ?? ''), 200) || !text(localized(choice.value || choice.text || choice.label), 2000)) invalid(); return { key: String(choice.key ?? choice.id ?? ''), value: localized(choice.value || choice.text || choice.label) }; });
  const required = row.required ?? row.responseRequired, responseEditable = row.responseEditable, maxResponseLength = row.maxResponseLength ?? row.typeSpecificQuestionDetails?.textQuestionDetails?.maxResponseLength;
  if (required !== undefined && typeof required !== 'boolean' || responseEditable !== undefined && typeof responseEditable !== 'boolean' || maxResponseLength !== undefined && (!Number.isSafeInteger(maxResponseLength) || maxResponseLength < 1)) invalid();
  return { key: String(key), label: name || String(key), type, options, ...(required === undefined ? {} : { required }), ...(responseEditable === undefined ? {} : { responseEditable }), ...(maxResponseLength === undefined ? {} : { maxResponseLength }) };
}
function form(row, scope) {
  const id = formIdentifier(row?.id), name = localized(row?.name), status = row?.status || row?.state || 'Not reported';
  if (!object(row) || !token(id) || !text(name, 200) || !name.trim() || !text(status, 100)) invalid();
  for (const [key, expected] of [['accountId', scope.account._id], ['profileId', scope.profileId], ['adAccountId', scope.adAccountId]]) if (row[key] != null && String(row[key]?._id || row[key]) !== expected) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned a form outside the selected project account.');
  const rawQuestions = row.questions || row.content?.questions || [], headline = localized(row.headline || row.content?.headline), description = localized(row.description || row.content?.description), privacyPolicyUrl = row.privacy_policy_url || row.privacyPolicyUrl || row.content?.legalInfo?.privacyPolicyUrl || row.legal_content?.privacy_policy?.url || '';
  if (!Array.isArray(rawQuestions) || rawQuestions.length > 100 || !text(headline, 2000) || !text(description) || !text(privacyPolicyUrl, 8192)) invalid();
  const consents = row.consents || row.content?.consents || [];
  if (!Array.isArray(consents) || consents.length > 20 || consents.some(row => !object(row) || !text(localized(row.description), 2000) || (row.required ?? row.consentRequired) != null && typeof (row.required ?? row.consentRequired) !== 'boolean')) invalid();
  const thankYou = Object.fromEntries(['Title', 'Body', 'WebsiteUrl'].map((key, index) => ['thankYou' + key, row['thankYou' + key] || row.thank_you_page?.[['title', 'body', 'website_url'][index]] || '']));
  if (Object.values(thankYou).some(value => !text(value, 8192))) invalid();
  const result = { id, name, status, questions: rawQuestions.map(question), headline, description, privacyPolicyUrl, consents: consents.map(row => ({ description: localized(row.description), required: (row.required ?? row.consentRequired) === true })), ...thankYou };
  return { ...result, version: digest(result) };
}
async function forms(api, scope, params = { limit: 25 }) {
  const response = await api('/ads/lead-forms', { accountId: scope.account._id, ...(scope.account.platform === 'linkedinads' ? { adAccountId: scope.adAccountId } : {}), ...params });
  if (response.status !== 'success' || !Array.isArray(response.forms) || response.forms.length > params.limit) invalid();
  const rows = response.forms.map(row => form(row, scope)); if (new Set(rows.map(row => row.id)).size !== rows.length) invalid();
  return { forms: rows, pagination: page(response.pagination, params.limit) };
}
async function verifiedForm(api, scope, formId) {
  let cursor; const seen = new Set();
  // ponytail: verify at most 2,000 forms; use the provider dashboard above this ceiling.
  for (let index = 0; index < 20; index++) {
    const result = await forms(api, scope, { limit: 100, ...(cursor ? { cursor } : {}) });
    if (result.forms.some(row => row.id === formId)) {
      const response = await api(`/ads/lead-forms/${encoded(formId)}`, { accountId: scope.account._id });
      if (response.status !== 'success') invalid(); const detail = form(response.form, scope); if (detail.id !== formId) invalid(); return detail;
    }
    if (!result.pagination.hasMore) fail(403, 'FORM_OUTSIDE_ACCOUNT', 'This form does not belong to the selected connection and advertising account.');
    cursor = result.pagination.cursor; if (seen.has(cursor)) invalid(); seen.add(cursor);
  }
  fail(503, 'INCOMPLETE_PROVIDER_DATA', 'The form is beyond the verified list window. Narrow the selection in the provider dashboard.');
}
async function formIds(api, scope) {
  let cursor; const ids = new Set(), seen = new Set();
  for (let index = 0; index < 20; index++) {
    const result = await forms(api, scope, { limit: 100, ...(cursor ? { cursor } : {}) }); result.forms.forEach(row => ids.add(row.id));
    if (!result.pagination.hasMore) return ids;
    cursor = result.pagination.cursor; if (seen.has(cursor)) invalid(); seen.add(cursor);
  }
  fail(503, 'INCOMPLETE_PROVIDER_DATA', 'Refresh or use the provider dashboard: a complete pre-creation form list could not be verified.');
}
function createdSettingsMatch(detail, payload, linkedin) {
  const settings = payload.platformSpecificData;
  if (detail.name !== payload.name || detail.privacyPolicyUrl !== payload.privacyPolicyUrl || detail.questions.length !== settings.questions.length) return false;
  if (!settings.questions.every((requested, index) => {
    const expected = question(requested, index), actual = detail.questions[index];
    return expected.type === actual.type && (linkedin || requested.type === 'CUSTOM' ? expected.key === actual.key && expected.label === actual.label : true) && JSON.stringify(expected.options) === JSON.stringify(actual.options) && (requested.required === undefined || requested.required === actual.required) && (requested.responseEditable === undefined || requested.responseEditable === actual.responseEditable) && (requested.maxResponseLength === undefined || requested.maxResponseLength === actual.maxResponseLength);
  })) return false;
  return linkedin ? detail.headline === settings.headline && detail.description === settings.description && detail.status === settings.state && JSON.stringify(detail.consents) === JSON.stringify(settings.consents || []) : ['thankYouTitle', 'thankYouBody', 'thankYouWebsiteUrl'].every(key => !settings[key] || detail[key] === settings[key]);
}
function lead(row, scope, formId) {
  if (!object(row) || !token(row.id) || row.formId !== formId || row.accountId != null && row.accountId !== scope.account._id || row.adAccountId != null && row.adAccountId !== scope.adAccountId) fail(502, 'INVALID_PROVIDER_SCOPE', 'Zernio returned a lead outside the selected form and account.');
  if (!object(row.fields) || Object.keys(row.fields).length > 100 || Object.entries(row.fields).some(([key, value]) => !text(key, 200) || !key || !text(value)) || row.isOrganic != null && typeof row.isOrganic !== 'boolean' || ['leadgenId', 'adId', 'campaignId'].some(key => row[key] != null && !token(row[key]))) invalid();
  let createdTime = row.createdTime ?? null;
  if (createdTime !== null) { if (typeof createdTime !== 'string') invalid(); const normalized = createdTime.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'); if (!validProviderInstant(normalized)) invalid(); createdTime = new Date(normalized).toISOString(); }
  const result = { id: row.id, formId, createdTime, fields: Object.fromEntries(Object.entries(row.fields).sort(([a], [b]) => a.localeCompare(b))), ...Object.fromEntries(['leadgenId', 'adId', 'campaignId', 'isOrganic'].filter(key => row[key] != null).map(key => [key, row[key]])) };
  return { ...result, version: digest(result) };
}
async function leads(api, scope, formId, params = { limit: 25 }) {
  const linkedin = scope.account.platform === 'linkedinads', response = await api(linkedin ? '/ads/leads' : `/ads/lead-forms/${encoded(formId)}/leads`, { accountId: scope.account._id, ...(linkedin ? { adAccountId: scope.adAccountId, formId } : {}), ...params });
  if (response.status !== 'success' || !Array.isArray(response.leads) || response.leads.length > params.limit) invalid();
  const rows = response.leads.map(row => lead(row, scope, formId)); if (new Set(rows.map(row => row.id)).size !== rows.length) invalid();
  return { leads: rows, pagination: page(response.pagination, params.limit) };
}
async function verifiedLead(api, scope, formId, leadId) {
  let cursor; const seen = new Set();
  // ponytail: verify at most 2,000 submitted leads per import; export older responses through the provider.
  for (let index = 0; index < 20; index++) {
    const result = await leads(api, scope, formId, { limit: 100, ...(cursor ? { cursor } : {}) }), found = result.leads.find(row => row.id === leadId);
    if (found) return found;
    if (!result.pagination.hasMore) fail(403, 'LEAD_OUTSIDE_FORM', 'This submitted lead was not found in the selected form.');
    cursor = result.pagination.cursor; if (seen.has(cursor)) invalid(); seen.add(cursor);
  }
  fail(503, 'INCOMPLETE_PROVIDER_DATA', 'The lead is beyond the verified retrieval window. Use the provider export.');
}
function expected(value, actual, name) { if (value !== actual) fail(409, 'LEAD_REVIEW_CHANGED', `This ${name} changed. Refresh it and review the current fields before continuing.`); }
function association(context, scope, formId, leadId) {
  return context.db.prepare('SELECT contact_id AS contactId,imported_at AS importedAt FROM zernio_lead_associations WHERE project_id=? AND profile_id=? AND account_id=? AND form_id=? AND lead_id=?').get(context.project.id, scope.profileId, scope.account._id, formId, leadId) || null;
}
async function mutate(context, run) {
  tables(context.db);
  return operation(context, async key => {
    const old = context.db.prepare('SELECT m.request_key,o.status FROM zernio_lead_mutations m LEFT JOIN integration_operations o ON o.project_id=m.project_id AND o.request_key=m.request_key WHERE m.project_id=?').get(context.project.id);
    if (old && old.request_key !== key && (!old.status || ['pending', 'uncertain'].includes(old.status))) fail(409, 'LEAD_PREVIOUS_OUTCOME_UNRESOLVED', 'Review the previous lead action in provider outcomes before making another lead change.');
    context.db.prepare('INSERT INTO zernio_lead_mutations VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET request_key=excluded.request_key').run(context.project.id, key);
    try { const result = await run(key); context.db.prepare('DELETE FROM zernio_lead_mutations WHERE project_id=? AND request_key=?').run(context.project.id, key); return result; }
    catch (error) { if (error instanceof IntegrationError && !error.uncertain) context.db.prepare('DELETE FROM zernio_lead_mutations WHERE project_id=? AND request_key=?').run(context.project.id, key); throw error; }
  }, 'lead-acquisition');
}
function createBody(body, scope) {
  fields(body, ['adAccountId', 'name', 'privacyPolicyUrl', 'questions', 'headline', 'description', 'state', 'consents', 'thankYouTitle', 'thankYouBody', 'thankYouWebsiteUrl']);
  const name = label(body.name), privacyPolicyUrl = mediaUrl(label(body.privacyPolicyUrl, 8192)), linkedin = scope.account.platform === 'linkedinads';
  if (!Array.isArray(body.questions) || !body.questions.length || body.questions.length > 20) fail(400, 'INVALID_LEAD_QUESTIONS', 'Add between 1 and 20 supported form questions.');
  const questions = body.questions.map(row => {
    if (linkedin) {
      fields(row, ['kind', 'name', 'question', 'required', 'responseEditable', 'maxResponseLength', 'choices']);
      if (!['text', 'multipleChoice'].includes(row.kind) || row.required !== undefined && typeof row.required !== 'boolean' || row.responseEditable !== undefined && typeof row.responseEditable !== 'boolean') fail(400, 'INVALID_LEAD_QUESTIONS', 'Choose a text or multiple-choice question with explicit required settings.');
      const result = { kind: row.kind, name: label(row.name, 100), question: label(row.question, 2000), ...(row.required === undefined ? {} : { required: row.required }), ...(row.responseEditable === undefined ? {} : { responseEditable: row.responseEditable }) };
      if (row.kind === 'text') { if (row.choices !== undefined || row.maxResponseLength !== undefined && (!Number.isSafeInteger(row.maxResponseLength) || row.maxResponseLength < 1 || row.maxResponseLength > 10000)) fail(400, 'INVALID_LEAD_QUESTIONS', 'Choose a valid text response limit.'); if (row.maxResponseLength !== undefined) result.maxResponseLength = row.maxResponseLength; }
      else { if (row.maxResponseLength !== undefined || !Array.isArray(row.choices) || !row.choices.length || row.choices.length > 100) fail(400, 'INVALID_LEAD_QUESTIONS', 'Add choices to this question.'); result.choices = row.choices.map(choice => { fields(choice, ['id', 'text']); if (!Number.isSafeInteger(choice.id) || choice.id < 0) fail(400, 'INVALID_LEAD_QUESTIONS', 'Use unique non-negative choice numbers.'); return { id: choice.id, text: label(choice.text, 2000) }; }); if (new Set(result.choices.map(choice => choice.id)).size !== result.choices.length) fail(400, 'INVALID_LEAD_QUESTIONS', 'Choice numbers must be unique.'); }
      return result;
    }
    fields(row, ['type', 'key', 'label', 'options']);
    if (!['EMAIL', 'PHONE', 'FULL_NAME', 'FIRST_NAME', 'LAST_NAME', 'CUSTOM'].includes(row.type)) fail(400, 'INVALID_LEAD_QUESTIONS', 'Choose a supported prefilled or custom question.');
    if (row.type !== 'CUSTOM') { if (Object.keys(row).some(key => key !== 'type')) fail(400, 'INVALID_LEAD_QUESTIONS', 'Prefilled questions must not supply their own labels or keys.'); return { type: row.type }; }
    const result = { type: 'CUSTOM', key: label(row.key, 100), label: label(row.label, 2000) };
    if (row.options !== undefined) { if (!Array.isArray(row.options) || !row.options.length || row.options.length > 100) fail(400, 'INVALID_LEAD_QUESTIONS', 'Add at least one custom choice.'); result.options = row.options.map(option => { fields(option, ['key', 'value']); return { key: label(option.key, 100), value: label(option.value, 2000) }; }); if (new Set(result.options.map(option => option.key)).size !== result.options.length) fail(400, 'INVALID_LEAD_QUESTIONS', 'Custom choice keys must be unique.'); }
    return result;
  });
  const keys = questions.map(row => row.name || row.key || row.type); if (new Set(keys).size !== keys.length) fail(400, 'INVALID_LEAD_QUESTIONS', 'Each form question must have its own name or type.');
  const settings = { questions };
  if (linkedin) {
    if (['thankYouTitle', 'thankYouBody', 'thankYouWebsiteUrl'].some(key => body[key] !== undefined)) fail(400, 'INVALID_LEAD_FIELDS', 'Thank-you screen controls are available for Meta forms.');
    Object.assign(settings, { adAccountId: scope.adAccountId, headline: label(body.headline, 255), description: label(body.description, 1500), state: body.state || 'DRAFT' });
    if (!['DRAFT', 'PUBLISHED'].includes(settings.state)) fail(400, 'INVALID_LEAD_SETTINGS', 'Choose a draft or published LinkedIn form.');
    if (body.consents !== undefined) { if (!Array.isArray(body.consents) || body.consents.length > 20) fail(400, 'INVALID_LEAD_SETTINGS', 'Use at most 20 consent notices.'); settings.consents = body.consents.map(row => { fields(row, ['description', 'required']); if (row.required !== undefined && typeof row.required !== 'boolean') fail(400, 'INVALID_LEAD_SETTINGS', 'Choose whether the consent checkbox is required.'); return { description: label(row.description, 2000), required: row.required === true }; }); }
  } else {
    if (['headline', 'description', 'state', 'consents'].some(key => body[key] !== undefined)) fail(400, 'INVALID_LEAD_FIELDS', 'Use the Meta form controls for this connection.');
    for (const key of ['thankYouTitle', 'thankYouBody']) if (body[key]) settings[key] = label(body[key], 2000);
    if (body.thankYouWebsiteUrl) settings.thankYouWebsiteUrl = mediaUrl(label(body.thankYouWebsiteUrl, 8192));
  }
  return { accountId: scope.account._id, name, privacyPolicyUrl, platformSpecificData: settings };
}

async function leadAccount(api, profileId, accountId) {
  const account = requireAccount(await scopedAccounts(api, profileId), identifier(accountId));
  if (!platforms.has(account.platform) || account.isActive === false) fail(422, 'LEADS_UNAVAILABLE', 'Choose an active Meta or LinkedIn advertising connection.');
  const native = (await adAccounts(api, account._id)).accounts;
  if (!Array.isArray(native) || native.some(row => !object(row) || !token(row.id) || row.name != null && !text(row.name, 200) || row.selectable != null && typeof row.selectable !== 'boolean') || new Set(native.map(row => row.id)).size !== native.length) invalid();
  return { account, native };
}
function advertiser(scope, adAccountId) {
  identifier(adAccountId);
  if (!scope.native.some(row => row.id === adAccountId && row.selectable !== false)) fail(403, 'AD_ACCOUNT_OUTSIDE_PROJECT', 'Choose an available advertising account from this project connection.');
  return { account: scope.account, adAccountId };
}
export async function validateAdLeadForm(api, profileId, body) {
  if (body.goal !== 'lead_generation' || !['facebook', 'instagram', 'linkedin'].includes(body.platform)) {
    if (body.leadFormReview !== undefined) fail(400, 'UNEXPECTED_LEAD_FORM_REVIEW', 'Choose the native lead-generation goal before selecting a lead form.');
    return null;
  }
  if (!object(body.leadFormReview)) fail(400, 'LEAD_FORM_REVIEW_REQUIRED', 'Choose and review a verified lead form before creating the ad.');
  fields(body.leadFormReview, ['id', 'name', 'version']);
  const reviewed = body.leadFormReview, formId = identifier(body.leadGenFormId);
  if (reviewed.id !== formId || !text(reviewed.name, 200) || !reviewed.name.trim() || typeof reviewed.version !== 'string' || !/^[a-f0-9]{64}$/.test(reviewed.version)) fail(400, 'LEAD_FORM_REVIEW_REQUIRED', 'Choose and review a verified lead form before creating the ad.');
  const found = await leadAccount(api, profileId, body.accountId), scope = { ...advertiser(found, body.adAccountId), profileId };
  if ((found.account.platform === 'linkedinads') !== (body.platform === 'linkedin')) fail(400, 'AD_CONNECTION_MISMATCH', 'Choose a lead form from this advertising network.');
  const detail = await verifiedForm(api, scope, formId);
  if (detail.status !== (body.platform === 'linkedin' ? 'PUBLISHED' : 'ACTIVE')) fail(409, 'LEAD_FORM_UNAVAILABLE', 'This form is not available for new ads. Choose an active Meta form or a published LinkedIn form.');
  expected(reviewed.version, detail.version, 'form'); expected(reviewed.name, detail.name, 'form');
  return detail;
}

export async function handleZernioLeads(context, api, profileId, action) {
  const { req, url, body = {}, role, send } = context;
  if (action === 'accounts' && req.method === 'GET') { send(200, { accounts: (await scopedAccounts(api, profileId)).filter(row => platforms.has(row.platform)).map(row => ({ _id: row._id, platform: row.platform, displayName: row.displayName, username: row.username, isActive: row.isActive })) }); return true; }
  const match = /^([^/]+)\/(ad-accounts|forms)(?:\/([^/]+)(?:\/(leads|archive|test-leads)(?:\/([^/]+)(?:\/(import|delete))?)?)?)?$/.exec(action);
  if (!match || match[2] === 'ad-accounts' && match[3]) return false;
  let accountId, formId, leadId;
  try { accountId = identifier(decodeURIComponent(match[1])); if (match[3]) formId = identifier(decodeURIComponent(match[3])); if (match[5]) leadId = identifier(decodeURIComponent(match[5])); } catch (error) { if (error instanceof IntegrationError) throw error; fail(400, 'INVALID_LEAD_ID', 'Choose valid connected account, form and lead identifiers.'); }
  const creating = formId === 'create' && !match[4], importing = match[4] === 'leads' && match[6] === 'import', archiving = match[4] === 'archive' && !leadId, testCreate = match[4] === 'test-leads' && leadId === 'create' && !match[6], testDelete = match[4] === 'test-leads' && match[6] === 'delete', mutation = creating || importing || archiving || testCreate || testDelete;
  if (leadId && !importing && !testCreate && !testDelete || match[4] && !['leads', 'archive', 'test-leads'].includes(match[4]) || match[4] === 'test-leads' && !mutation) return false;
  if (req.method !== (mutation ? 'POST' : 'GET')) fail(405, 'METHOD_NOT_ALLOWED', 'Use the available lead form controls.');
  if (mutation && !(importing ? writers : administrators).has(role)) fail(403, 'LEAD_PERMISSION_REQUIRED', importing ? 'Editing permission is required to import a lead contact.' : 'A workspace owner or administrator must change lead forms and test leads.');
  const found = await leadAccount(api, profileId, accountId), { account, native } = found;
  if (match[2] === 'ad-accounts') { send(200, { accounts: native.filter(row => row.selectable !== false).map(row => ({ id: row.id, name: row.name || row.id, selectable: row.selectable !== false })) }); return true; }
  const adAccountId = identifier(mutation ? body.adAccountId : url.searchParams.get('adAccountId'));
  const scope = { ...advertiser(found, adAccountId), profileId }; tables(context.db);
  if (!formId) { send(200, { platform: account.platform, ...await forms(api, scope, filters(url)) }); return true; }
  if (creating) {
    const payload = createBody(body, scope), outcome = await mutate(context, async key => {
      const before = await formIds(api, scope), response = await api('/ads/lead-forms', {}, payload, key); if (response.status !== 'success' || !token(response.form?.id) || before.has(response.form.id)) invalid(true);
      try { const detail = await verifiedForm(api, scope, response.form.id); if (!createdSettingsMatch(detail, payload, account.platform === 'linkedinads')) invalid(true); return { form: detail, platform: account.platform }; } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    }); send(outcome.status, outcome.data); return true;
  }
  if (!mutation) {
    const params = filters(url), detail = await verifiedForm(api, scope, formId);
    if (match[4] === 'leads') { const response = await leads(api, scope, formId, params); send(200, { platform: account.platform, form: detail, ...response, leads: response.leads.map(row => ({ ...row, association: association(context, scope, formId, row.id) })) }); }
    else send(200, { platform: account.platform, form: detail, testLeads: context.db.prepare('SELECT lead_id AS id,created_at AS createdAt FROM zernio_test_leads WHERE project_id=? AND profile_id=? AND account_id=? AND form_id=?').all(context.project.id, profileId, accountId, formId) });
    return true;
  }
  fields(body, importing ? ['adAccountId', 'expectedLeadVersion', 'confirmImport', 'mapping'] : archiving ? ['adAccountId', 'expectedFormVersion', 'confirmArchive'] : testCreate ? ['adAccountId', 'expectedFormVersion', 'confirmTest', 'fieldData'] : ['adAccountId', 'confirmDelete']);
  const outcome = await mutate(context, async key => {
    const detail = await verifiedForm(api, scope, formId);
    if (importing) {
      if (body.confirmImport !== true) fail(400, 'LEAD_IMPORT_CONFIRMATION_REQUIRED', 'Review the selected lead fields before importing this contact.');
      const current = await verifiedLead(api, scope, formId, leadId); expected(body.expectedLeadVersion, current.version, 'lead');
      const previous = association(context, scope, formId, leadId);
      if (previous) return { association: previous, contact: context.contacts.get(context.project.id, previous.contactId), alreadyImported: true };
      fields(body.mapping, ['name', 'email', 'phone', 'company']);
      const mapped = Object.fromEntries(Object.entries(body.mapping).filter(([, value]) => value !== '').map(([name, source]) => { if (!text(source, 200) || !Object.hasOwn(current.fields, source)) fail(400, 'INVALID_LEAD_MAPPING', 'Map contact fields only from this verified lead’s answers.'); return [name, current.fields[source].trim()]; }));
      if (!mapped.email && !mapped.phone) fail(400, 'LEAD_CONTACT_IDENTITY_REQUIRED', 'Map an email address or international phone number before importing.');
      if (mapped.phone) mapped.phone = mapped.phone.replace(/[()\s.-]/g, '');
      context.assertProjectMapping?.(profileId);
      let contact; try { contact = context.contacts.save(context.project.id, mapped); } catch (error) { if (Number.isInteger(error.status)) fail(error.status, 'LEAD_CONTACT_REJECTED', error.message); throw error; }
      // ponytail: the contact API owns its transaction; canonical destination matching makes a crash-before-association retry deduplicate instead of creating another contact.
      const importedAt = new Date().toISOString(); context.db.prepare('INSERT INTO zernio_lead_associations VALUES(?,?,?,?,?,?,?,?)').run(context.project.id, profileId, accountId, formId, leadId, contact.id, current.version, importedAt);
      return { contact, association: { contactId: contact.id, importedAt } };
    }
    if (archiving) {
      expected(body.expectedFormVersion, detail.version, 'form'); if (body.confirmArchive !== formId) fail(400, 'LEAD_ARCHIVE_CONFIRMATION_REQUIRED', 'Confirm the exact form before archiving it.');
      const response = await api(`/ads/lead-forms/${encoded(formId)}`, { accountId }, undefined, key, 'DELETE');
      if (response.status !== 'success' || response.formId !== formId || response.archived !== true) invalid(true);
      try { const confirmed = await api(`/ads/lead-forms/${encoded(formId)}`, { accountId }), result = form(confirmed.form, scope); if (confirmed.status !== 'success' || result.id !== formId || result.status !== 'ARCHIVED') invalid(true); return { form: result, archived: true }; } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    }
    if (account.platform === 'linkedinads') fail(422, 'TEST_LEADS_UNAVAILABLE', 'LinkedIn does not expose test-lead creation or deletion.');
    if (testCreate) {
      expected(body.expectedFormVersion, detail.version, 'form');
      if (body.confirmTest !== true || !Array.isArray(body.fieldData) || !body.fieldData.length || body.fieldData.length > 20) fail(400, 'TEST_LEAD_CONFIRMATION_REQUIRED', 'Review the test answers and confirm creating a synthetic test lead.');
      const data = body.fieldData.map(row => { fields(row, ['name', 'values']); if (!detail.questions.some(question => question.key === row.name) || !Array.isArray(row.values) || !row.values.length || row.values.length > 20 || row.values.some(value => !text(value, 2000) || !value.trim())) fail(400, 'INVALID_TEST_LEAD', 'Use only the selected form’s question keys and non-empty test answers.'); return { name: row.name, values: row.values }; });
      if (new Set(data.map(row => row.name)).size !== data.length) fail(400, 'INVALID_TEST_LEAD', 'Supply each test question once.');
      const response = await api(`/ads/lead-forms/${encoded(formId)}/test-leads`, {}, { accountId, fieldData: data }, key);
      if (response.status !== 'success' || !token(response.testLead?.id)) invalid(true);
      const createdAt = new Date().toISOString(); context.db.prepare('INSERT INTO zernio_test_leads VALUES(?,?,?,?,?,?)').run(context.project.id, profileId, accountId, formId, response.testLead.id, createdAt); return { testLead: { id: response.testLead.id, createdAt } };
    }
    if (body.confirmDelete !== leadId || !context.db.prepare('SELECT lead_id FROM zernio_test_leads WHERE project_id=? AND profile_id=? AND account_id=? AND form_id=? AND lead_id=?').get(context.project.id, profileId, accountId, formId, leadId)) fail(403, 'TEST_LEAD_OUTSIDE_FORM', 'Choose a test lead created for this form by this project. Real leads cannot be deleted here.');
    const response = await api(`/ads/lead-forms/${encoded(formId)}/test-leads`, { accountId, leadId }, undefined, key, 'DELETE');
    if (response.status !== 'success' || !Array.isArray(response.deleted) || response.deleted.length !== 1 || response.deleted[0] !== leadId) invalid(true);
    context.db.prepare('DELETE FROM zernio_test_leads WHERE project_id=? AND profile_id=? AND account_id=? AND form_id=? AND lead_id=?').run(context.project.id, profileId, accountId, formId, leadId); return { deleted: leadId };
  }); send(outcome.status, outcome.data); return true;
}
