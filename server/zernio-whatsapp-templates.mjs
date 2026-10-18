import { createHash } from 'node:crypto';
import { IntegrationError, operation, scopedAccounts, requireAccount } from './integrations.mjs';
import { publicMediaUrl } from '../shared/social-posts.mjs';

const fail = (status, code, message, uncertain = false) => { throw new IntegrationError(status, code, message, uncertain); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, max, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const numeric = value => typeof value === 'string' && /^\d{1,40}$/.test(value);
const language = value => typeof value === 'string' && /^[a-z]{2,3}(?:_[A-Za-z0-9]{2,8})?$/.test(value);
const name = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,511}$/.test(value);
const fields = (value, allowed) => { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'INVALID_TEMPLATE_FIELDS', 'Use only the template fields shown in this form.'); };
const canonical = value => JSON.stringify(Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const version = value => createHash('sha256').update(canonical(value)).digest('hex');
const unavailable = (uncertain = false) => fail(502, 'INVALID_TEMPLATE_RESPONSE', 'Zernio did not return a complete template receipt. Check its status before trying again.', uncertain);
const locks = new WeakMap();
const states = ['APPROVED', 'REJECTED', 'PENDING', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION'];
const editableStates = ['APPROVED', 'REJECTED', 'PAUSED'];

function variables(value, maximum = 100) {
  const found = [...value.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]);
  const positions = [...new Set(found.map(Number))].sort((a, b) => a - b);
  if (/\{\{|\}\}/.test(value.replace(/\{\{[1-9]\d*\}\}/g, '')) || found.some(item => !/^[1-9]\d*$/.test(item)) || positions.length > maximum || positions.some((item, index) => item !== index + 1)) fail(400, 'POSITIONAL_VALUES_REQUIRED', 'Use consecutive numbered values such as {{1}} and {{2}}.');
  return positions.length;
}
function samples(value, count, label) {
  if (!Array.isArray(value) || value.length !== count || value.some(item => !text(item, 1024))) fail(400, 'TEMPLATE_EXAMPLES_REQUIRED', `Provide one example for each ${label} value.`);
  return value;
}
function url(value) { try { return publicMediaUrl(value); } catch { fail(400, 'INVALID_TEMPLATE_URL', 'Use a public HTTPS URL for template media and website buttons.'); } }
function ttl(value, category, create = false) {
  if (value === undefined) return undefined;
  const limits = { AUTHENTICATION: [30, 900], UTILITY: [30, 43200], MARKETING: [43200, 2592000] }[category];
  if (!Number.isSafeInteger(value) || !limits || !(create && value === -1 && category !== 'MARKETING') && (value < limits[0] || value > limits[1])) fail(400, 'INVALID_TEMPLATE_TTL', 'Choose a delivery window within this template category’s allowed range.');
  return value;
}
export function templateComponents(form) {
  fields(form, ['headerFormat', 'headerText', 'headerExamples', 'headerMediaUrl', 'bodyText', 'bodyExamples', 'footerText', 'buttons']);
  if (!['none', 'text', 'image', 'video', 'document'].includes(form.headerFormat) || !text(form.bodyText, 1024) || !text(form.footerText, 60, true) || !Array.isArray(form.buttons) || form.buttons.length > 10) fail(400, 'INVALID_TEMPLATE_CONTENT', 'Provide a message, optional header/footer and up to ten supported buttons.');
  const components = [];
  if (form.headerFormat === 'text') {
    if (!text(form.headerText, 60)) fail(400, 'INVALID_TEMPLATE_HEADER', 'Enter a text header of at most 60 characters.');
    const count = variables(form.headerText, 1), values = samples(form.headerExamples, count, 'header');
    components.push({ type: 'header', format: 'text', text: form.headerText, ...(count ? { example: { header_text: values } } : {}) });
  } else if (form.headerFormat !== 'none') components.push({ type: 'header', format: form.headerFormat, example: { header_handle: [url(form.headerMediaUrl)] } });
  const count = variables(form.bodyText), values = samples(form.bodyExamples, count, 'message');
  components.push({ type: 'body', text: form.bodyText, ...(count ? { example: { body_text: [values] } } : {}) });
  if (form.footerText) { if (/\{\{|\}\}/.test(form.footerText)) fail(400, 'INVALID_TEMPLATE_FOOTER', 'Footer text cannot contain variables.'); components.push({ type: 'footer', text: form.footerText }); }
  if (form.buttons.length) components.push({ type: 'buttons', buttons: form.buttons.map(button => {
    fields(button, ['type', 'text', 'url', 'phoneNumber', 'example']);
    if (!['quick_reply', 'url', 'phone_number'].includes(button.type) || !text(button.text, 25)) fail(400, 'INVALID_TEMPLATE_BUTTON', 'Choose a quick reply, website or phone button and provide its label.');
    const result = { type: button.type, text: button.text };
    if (button.type === 'phone_number') { if (!/^\+[1-9]\d{6,14}$/.test(button.phoneNumber || '')) fail(400, 'INVALID_TEMPLATE_PHONE', 'Use an international phone number for the phone button.'); result.phone_number = button.phoneNumber; }
    if (button.type === 'url') {
      if (typeof button.url !== 'string' || button.url.length > 2000) fail(400, 'INVALID_TEMPLATE_URL', 'Enter a website button URL.');
      const dynamic = button.url.endsWith('{{1}}');
      if (/\{\{|\}\}/.test(dynamic ? button.url.slice(0, -5) : button.url)) fail(400, 'INVALID_TEMPLATE_URL', 'A website button supports one {{1}} suffix at the end of a fixed HTTPS URL.');
      url(dynamic ? button.url.slice(0, -5) : button.url); result.url = button.url;
      if (dynamic) { if (!text(button.example, 1024) || /[\r\n]/.test(button.example)) fail(400, 'TEMPLATE_EXAMPLES_REQUIRED', 'Provide an example suffix for the website button.'); const complete = url(button.url.slice(0, -5) + button.example); if (new URL(complete).origin !== new URL(button.url.slice(0, -5)).origin) fail(400, 'INVALID_TEMPLATE_URL', 'The button example must keep the approved website.'); result.example = [button.example]; }
    }
    return result;
  }) });
  return components;
}
function publicComponents(value) {
  if (!Array.isArray(value) || value.length > 20) unavailable();
  return value.map(part => {
    if (!object(part) || !text(part.type, 100) || ['text', 'format'].some(key => part[key] !== undefined && !text(part[key], 32768, true))) unavailable();
    const result = { type: part.type.toLowerCase(), ...(part.format ? { format: part.format.toLowerCase() } : {}), ...(part.text !== undefined ? { text: part.text } : {}) };
    if (part.buttons !== undefined) {
      if (!Array.isArray(part.buttons) || part.buttons.length > 10 || part.buttons.some(button => !object(button) || !text(button.type, 100) || ['text', 'url', 'phone_number'].some(key => button[key] !== undefined && !text(button[key], 32768, true)))) unavailable();
      result.buttons = part.buttons.map(button => ({ type: button.type.toLowerCase(), ...Object.fromEntries(['text', 'url', 'phone_number'].filter(key => button[key] !== undefined).map(key => [key, button[key]])) }));
    }
    if (part.example !== undefined) {
      if (!object(part.example)) unavailable();
      const allowed = ['header_text', 'body_text', 'header_handle'];
      for (const key of allowed) if (part.example[key] !== undefined) {
        const rows = key === 'body_text' ? part.example[key]?.[0] : part.example[key];
        if (!Array.isArray(rows) || rows.length > 100 || rows.some(item => !text(item, 32768, true))) unavailable();
        result.example ||= {}; result.example[key] = key === 'body_text' ? [rows] : rows;
      }
    }
    if (part.add_security_recommendation !== undefined || part.code_expiration_minutes !== undefined || part.example?.body_text_named_params || part.example?.header_text_named_params) result.advanced = true;
    return result;
  });
}
function definition(components) {
  const form = { headerFormat: 'none', headerText: '', headerExamples: [], headerMediaUrl: '', bodyText: '', bodyExamples: [], footerText: '', buttons: [] };
  if (new Set(components.map(part => part.type)).size !== components.length) return null;
  for (const part of components) {
    if (part.advanced || !['header', 'body', 'footer', 'buttons'].includes(part.type)) return null;
    if (part.type === 'header') {
      if (!['text', 'image', 'video', 'document'].includes(part.format)) return null;
      form.headerFormat = part.format; form.headerText = part.text || ''; form.headerExamples = part.example?.header_text || [];
      // Meta replaces uploaded media URLs with handles; require a new public example when editing.
      if (part.example?.header_handle?.[0]) try { form.headerMediaUrl = url(part.example.header_handle[0]); } catch { /* An internal media handle is readable but cannot be submitted as a public URL. */ }
    }
    if (part.type === 'body') { form.bodyText = part.text || ''; form.bodyExamples = part.example?.body_text?.[0] || []; }
    if (part.type === 'footer') form.footerText = part.text || '';
    if (part.type === 'buttons') {
      if (part.buttons.some(button => !['quick_reply', 'url', 'phone_number'].includes(button.type))) return null;
      form.buttons = part.buttons.map(button => ({ type: button.type, text: button.text || '', url: button.url || '', phoneNumber: button.phone_number || '', example: '' }));
    }
    try { if (['body', 'header'].includes(part.type) && part.text) variables(part.text, part.type === 'header' ? 1 : 100); } catch { return null; }
  }
  return form.bodyText ? form : null;
}
function row(value, expectedId) {
  if (!object(value) || !numeric(value.id) || expectedId && value.id !== expectedId || !name(value.name) || !language(value.language) || !text(value.status, 100) || !['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(value.category) || value.message_send_ttl_seconds !== undefined && !Number.isSafeInteger(value.message_send_ttl_seconds) || value.rejected_reason !== undefined && !text(value.rejected_reason, 10000, true)) unavailable();
  const components = publicComponents(value.components), result = { id: value.id, name: value.name, language: value.language, category: value.category, status: value.status, components, ttlSeconds: value.message_send_ttl_seconds ?? null, rejectedReason: value.rejected_reason || '', quality: text(value.quality_score?.score, 100) ? value.quality_score.score : null };
  return { ...result, version: version({ ...result, components: value.components }), form: definition(components) };
}
async function list(api, accountId, filter = {}) {
  const result = await api('/whatsapp/templates', { accountId, ...filter });
  if (result.success !== true || !Array.isArray(result.templates) || result.templates.length > 10000) unavailable();
  const rows = result.templates.map(value => row(value));
  if (new Set(rows.map(value => value.id)).size !== rows.length || new Set(rows.map(value => `${value.name}:${value.language}`)).size !== rows.length || rows.some(value => filter.status && value.status !== filter.status)) unavailable();
  return rows;
}
async function detail(api, accountId, templateId) {
  const result = await api(`/whatsapp/templates/id/${templateId}`, { accountId });
  if (result.success !== true) unavailable(); return row(result.template, templateId);
}
function semantic(components) {
  return components.map(part => ({ type: part.type.toLowerCase(), ...(part.format ? { format: part.format.toLowerCase() } : {}), ...(part.text !== undefined ? { text: part.text } : {}), ...(part.buttons ? { buttons: part.buttons.map(button => ({ type: button.type.toLowerCase(), ...Object.fromEntries(['text', 'url', 'phone_number'].filter(key => button[key] !== undefined).map(key => [key, button[key]])) })) } : {}) })).sort((a, b) => a.type.localeCompare(b.type));
}
async function library(api, accountId, requestedName, requestedLanguage) {
  if (!name(requestedName) || !language(requestedLanguage)) fail(400, 'INVALID_LIBRARY_LOOKUP', 'Enter the exact library name and a language code.');
  const result = await api('/whatsapp/template-library', { accountId, name: requestedName, language: requestedLanguage }), value = result.template;
  if (value === null) return null;
  if (!object(value) || value.name !== requestedName || !language(value.language) || !['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(value.category) || !text(value.body, 32768) || !Array.isArray(value.body_params) || value.body_params.some(item => !text(item, 1024, true)) || !Array.isArray(value.availableLanguages) || value.availableLanguages.some(item => !language(item)) || !Array.isArray(value.buttons) || value.buttons.length > 10 || value.buttons.some(button => !object(button) || !text(button.type, 100) || button.text !== undefined && !text(button.text, 100, true))) unavailable();
  const clean = { name: value.name, language: value.language, category: value.category, body: value.body, bodyParams: value.body_params, availableLanguages: value.availableLanguages, buttons: value.buttons.map(button => ({ type: button.type.toLowerCase(), text: button.text || '' })) };
  return { ...clean, version: version(clean), importable: clean.buttons.every(button => ['quick_reply', 'url', 'phone_number'].includes(button.type)) };
}

export async function handleZernioWhatsAppTemplates(context, api, profileId, action) {
  const { req, url: requestUrl, body = {}, role, db, project, send } = context;
  const mutation = req.method === 'POST', matched = action.match(/^templates\/(\d{1,40})(?:\/(update|delete))?$/);
  if (!(req.method === 'GET' && ['overview', 'templates', 'library'].includes(action)) && !(matched && (req.method === 'GET' && !matched[2] || mutation && matched[2])) && !(mutation && ['templates/create', 'templates/import'].includes(action))) return false;
  db.exec(`CREATE TABLE IF NOT EXISTS zernio_whatsapp_template_ownership(waba_id TEXT NOT NULL,template_id TEXT NOT NULL,project_id TEXT NOT NULL,profile_id TEXT NOT NULL,PRIMARY KEY(waba_id,template_id));
    CREATE TABLE IF NOT EXISTS zernio_whatsapp_template_mutations(waba_id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL)`);
  const assertAccess = () => context.assertProjectMapping?.(profileId);
  assertAccess();
  const accounts = await scopedAccounts(api, profileId), whatsapp = accounts.filter(account => account.platform === 'whatsapp');
  if (action === 'overview') { send(200, { accounts: whatsapp.map(account => ({ id: account._id, name: account.displayName || account.username || 'WhatsApp Business', isActive: account.isActive !== false, wabaId: numeric(account.metadata?.wabaId) ? account.metadata.wabaId : null })) }); return true; }
  const accountId = mutation ? body.accountId : requestUrl.searchParams.get('accountId'), account = requireAccount(accounts, accountId);
  if (account.platform !== 'whatsapp') fail(422, 'WHATSAPP_ACCOUNT_REQUIRED', 'Choose a connected WhatsApp account.');
  const wabaId = numeric(account.metadata?.wabaId) ? account.metadata.wabaId : null;
  const isAdmin = ['owner', 'admin'].includes(role), isOperator = () => Boolean(context.user?.isOperator && db.prepare('SELECT 1 FROM instance_operators WHERE user_id=?').get(context.user.id));
  const ownership = templateId => db.prepare('SELECT project_id,profile_id FROM zernio_whatsapp_template_ownership WHERE waba_id=? AND template_id=?').get(wabaId, templateId);
  const decorate = template => { const owner = ownership(template.id); return { ...template, managedHere: owner?.project_id === project.id && owner.profile_id === profileId, canReviewShared: isAdmin && isOperator(), wabaId }; };
  async function freshAccount() {
    assertAccess(); const fresh = requireAccount(await scopedAccounts(api, profileId), accountId);
    if (fresh.platform !== 'whatsapp' || fresh.isActive === false || !wabaId || fresh.metadata?.wabaId !== wabaId) fail(409, 'WHATSAPP_CONNECTION_CHANGED', 'The WhatsApp connection or business account changed. Refresh before continuing.');
    return fresh;
  }
  if (!mutation) {
    let result;
    if (action === 'templates') { const status = requestUrl.searchParams.get('status'); if (status && !states.includes(status)) fail(400, 'INVALID_TEMPLATE_FILTER', 'Choose a template review status.'); result = { templates: (await list(api, accountId, status ? { status } : {})).map(decorate), wabaId }; }
    else if (action === 'library') result = { library: await library(api, accountId, requestUrl.searchParams.get('name'), requestUrl.searchParams.get('language')) };
    else { if (!(await list(api, accountId)).some(template => template.id === matched[1])) fail(404, 'TEMPLATE_NOT_FOUND', 'This template is not available through this account.'); result = { template: decorate(await detail(api, accountId, matched[1])) }; }
    assertAccess(); send(200, result); return true;
  }
  if (!isAdmin) fail(403, 'TEMPLATE_ADMIN_REQUIRED', 'A workspace owner or administrator must manage WhatsApp business templates.');
  fields(body, ['accountId', 'expectedWabaId', 'name', 'category', 'language', 'form', 'ttlSeconds', 'confirmSubmission', 'expectedVersion', 'confirmTemplateId', 'reviewSharedWabaId', 'libraryName', 'expectedLibraryVersion', 'buttonInputs']);
  if (!wabaId || body.expectedWabaId !== wabaId) fail(409, 'WHATSAPP_BUSINESS_REVIEW_REQUIRED', 'Refresh and review the WhatsApp business account before changing a template.');
  const task = matched?.[2] || action.split('/')[1], templateId = matched?.[1];
  fields(body, ['accountId', 'expectedWabaId', ...(task === 'create' ? ['name', 'category', 'language', 'form', 'ttlSeconds', 'confirmSubmission'] : task === 'import' ? ['name', 'language', 'libraryName', 'expectedLibraryVersion', 'buttonInputs', 'ttlSeconds', 'confirmSubmission'] : ['expectedVersion', 'confirmTemplateId', 'reviewSharedWabaId', ...(task === 'update' ? ['form', 'ttlSeconds'] : [])])]);
  const reviewBusinessScope = () => {
    // Creation provenance cannot prove exclusive use: templates belong to the WABA, not one number or project.
    if (!(isOperator() && body.reviewSharedWabaId === wabaId && body.confirmTemplateId === templateId)) fail(403, 'SHARED_TEMPLATE_REVIEW_REQUIRED', 'An instance operator must explicitly review this variant and WhatsApp business account before editing or deleting it.');
  };
  if (['create', 'import'].includes(task) && (body.confirmSubmission !== true || !name(body.name) || !language(body.language))) fail(400, 'TEMPLATE_SUBMISSION_REVIEW_REQUIRED', 'Review the template name, language and content before submitting.');
  const result = await operation(context, async key => {
    if (!locks.has(db)) locks.set(db, new Set()); const active = locks.get(db);
    // ponytail: one process owns this SQLite database; use a durable WABA lock before adding server processes.
    if (active.has(wabaId)) fail(409, 'WHATSAPP_BUSINESS_BUSY', 'Another template change for this WhatsApp business account is in progress.');
    active.add(wabaId);
    let fenced = false, uncertain = false;
    try {
      const previous = db.prepare('SELECT m.project_id,m.request_key,o.status FROM zernio_whatsapp_template_mutations m LEFT JOIN integration_operations o ON o.project_id=m.project_id AND o.request_key=m.request_key WHERE m.waba_id=?').get(wabaId);
      if (previous && (previous.project_id !== project.id || previous.request_key !== key) && (!previous.status || ['pending', 'uncertain'].includes(previous.status))) fail(409, 'TEMPLATE_PREVIOUS_OUTCOME_UNRESOLVED', 'This new change was not sent. Review the previous template change in provider outcomes before changing this WhatsApp business account again.');
      db.prepare('INSERT INTO zernio_whatsapp_template_mutations VALUES(?,?,?) ON CONFLICT(waba_id) DO UPDATE SET project_id=excluded.project_id,request_key=excluded.request_key').run(wabaId, project.id, key); fenced = true;
      await freshAccount();
      const before = await list(api, accountId); let current;
      if (templateId) {
        if (!before.some(template => template.id === templateId)) fail(404, 'TEMPLATE_NOT_FOUND', 'This template is not available through this account.');
        current = await detail(api, accountId, templateId);
        if (body.expectedVersion !== current.version) fail(409, 'TEMPLATE_CHANGED', 'This template changed. Refresh and review the current version.');
        reviewBusinessScope();
        if (task === 'delete' && body.confirmTemplateId !== templateId) fail(400, 'TEMPLATE_DELETE_REVIEW_REQUIRED', 'Confirm the exact language variant before deleting it.');
      }
      let payload, components, source;
      if (task === 'create') {
        if (!['UTILITY', 'MARKETING'].includes(body.category)) fail(400, 'TEMPLATE_FORMAT_UNAVAILABLE', 'Custom content here supports utility and marketing templates. Authentication requires the dedicated OTP format.');
        components = templateComponents(body.form); payload = { accountId, name: body.name, category: body.category, language: body.language, parameter_format: 'POSITIONAL', components };
      } else if (task === 'import') {
        source = await library(api, accountId, body.libraryName, body.language);
        if (!source || source.version !== body.expectedLibraryVersion || source.language !== body.language) fail(409, 'LIBRARY_TEMPLATE_CHANGED', 'The library language or content changed. Look it up and review it again.');
        if (!source.importable) fail(422, 'LIBRARY_FORMAT_UNAVAILABLE', 'This library template requires an advanced button editor.');
        if (!Array.isArray(body.buttonInputs) || body.buttonInputs.length !== source.buttons.length) fail(400, 'LIBRARY_BUTTON_INPUTS_REQUIRED', 'Provide matching inputs for every library button in order.');
        const inputs = source.buttons.map((button, index) => {
          const input = body.buttonInputs[index]; fields(input, ['type', 'url', 'phoneNumber']);
          if (input.type !== button.type) fail(400, 'LIBRARY_BUTTON_INPUTS_REQUIRED', 'The library button types must match the reviewed template.');
          if (button.type === 'url') return { type: 'url', url: { base_url: url(input.url) } };
          if (button.type === 'phone_number') { if (!/^\+[1-9]\d{6,14}$/.test(input.phoneNumber || '')) fail(400, 'INVALID_TEMPLATE_PHONE', 'Use an international library phone number.'); return { type: 'phone_number', phone_number: input.phoneNumber }; }
          return { type: 'quick_reply' };
        });
        payload = { accountId, name: body.name, category: source.category, language: source.language, library_template_name: source.name, ...(inputs.length ? { library_template_button_inputs: inputs } : {}) };
      } else if (task === 'update') {
        if (!editableStates.includes(current.status)) fail(409, 'TEMPLATE_NOT_EDITABLE', 'Only approved, rejected or paused templates can be edited. Wait for the provider review to finish.');
        if (body.form !== undefined) { if (!current.form || current.category === 'AUTHENTICATION') fail(422, 'TEMPLATE_FORMAT_UNAVAILABLE', 'This template’s advanced components cannot be edited in this form.'); components = templateComponents(body.form); }
        payload = { accountId, ...(components ? { components } : {}) };
      }
      if (task !== 'delete') {
        const seconds = ttl(body.ttlSeconds, current?.category || payload.category, task !== 'update'); if (seconds !== undefined) payload.message_send_ttl_seconds = seconds;
        if (task === 'update' && !components && seconds === undefined) fail(400, 'TEMPLATE_CHANGE_REQUIRED', 'Change the content or delivery window before saving.');
        if (task !== 'update' && before.some(template => template.name === payload.name && template.language === payload.language)) fail(409, 'TEMPLATE_EXISTS', 'That template name and language already exist. Choose its variant to edit it.');
      }
      await freshAccount();
      if (templateId) reviewBusinessScope();
      const receipt = await api(templateId ? `/whatsapp/templates/id/${templateId}` : '/whatsapp/templates', task === 'delete' ? { accountId } : {}, payload, key, task === 'delete' ? 'DELETE' : task === 'update' ? 'PATCH' : 'POST');
      try {
        if (receipt.success !== true) unavailable();
        if (templateId) reviewBusinessScope();
        if (task === 'delete') {
          if (receipt.scope !== 'language' || receipt.language !== current.language) unavailable();
          await freshAccount();
          let deleted = false; try { deleted = (await detail(api, accountId, templateId)).status === 'PENDING_DELETION'; } catch (error) { if (error instanceof IntegrationError && (error.providerStatus === 404 || error.status === 404)) deleted = true; else throw error; }
          if (!deleted) unavailable(); return { deleted: true, templateId, language: current.language };
        }
        const saved = receipt.template;
        if (!object(saved) || !numeric(saved.id) || templateId && saved.id !== templateId || saved.name !== (current?.name || payload.name) || saved.language !== (current?.language || payload.language) || !text(saved.status, 100) || saved.category !== undefined && saved.category !== (current?.category || payload.category) || !templateId && before.some(template => template.id === saved.id)) unavailable();
        if (!templateId) {
          const owned = ownership(saved.id); if (owned && (owned.project_id !== project.id || owned.profile_id !== profileId)) fail(502, 'TEMPLATE_OWNERSHIP_CONFLICT', 'This template already has a different project owner.');
          db.prepare('INSERT OR IGNORE INTO zernio_whatsapp_template_ownership VALUES(?,?,?,?)').run(wabaId, saved.id, project.id, profileId);
        }
        await freshAccount(); const fresh = await detail(api, accountId, saved.id);
        if (fresh.name !== saved.name || fresh.language !== saved.language || fresh.category !== (current?.category || payload.category) || components && canonical(semantic(fresh.components)) !== canonical(semantic(components)) || payload.message_send_ttl_seconds !== undefined && payload.message_send_ttl_seconds !== -1 && fresh.ttlSeconds !== payload.message_send_ttl_seconds) unavailable();
        if (source) {
          const buttons = fresh.components.flatMap(part => part.buttons || []);
          if (fresh.components.find(part => part.type === 'body')?.text !== source.body || buttons.length !== source.buttons.length || source.buttons.some((button, index) => buttons[index]?.type !== button.type || buttons[index]?.text !== button.text || button.type === 'url' && buttons[index]?.url !== body.buttonInputs[index].url || button.type === 'phone_number' && buttons[index]?.phone_number !== body.buttonInputs[index].phoneNumber)) unavailable();
        }
        assertAccess(); return { template: decorate(fresh), submitted: true };
      } catch (error) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    } catch (error) { uncertain = !(error instanceof IntegrationError) || error.uncertain; throw error; }
    finally { if (fenced && !uncertain) db.prepare('DELETE FROM zernio_whatsapp_template_mutations WHERE waba_id=? AND project_id=? AND request_key=?').run(wabaId, project.id, key); active.delete(wabaId); }
  }, `whatsapp-templates:${wabaId}`);
  send(result.status, result.data); return true;
}
