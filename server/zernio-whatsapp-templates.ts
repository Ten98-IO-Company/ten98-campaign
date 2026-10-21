import { sql } from 'drizzle-orm';
import type { OperationContext, ZernioApi, ProviderRecord } from './provider-core.ts';
import { createHash } from 'node:crypto';
import { fail, reportObject as object, IntegrationError, claimFence, operation, releaseFence, scopedAccounts, requireAccount } from './provider-core.ts';
import { publicMediaUrl } from '../shared/social-posts.ts';

const text = (value: any, max: any, empty = false) => typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
const numeric = (value: any) => typeof value === 'string' && /^\d{1,40}$/.test(value);
const language = (value: any) => typeof value === 'string' && /^[a-z]{2,3}(?:_[A-Za-z0-9]{2,8})?$/.test(value);
const name = (value: any) => typeof value === 'string' && /^[a-z][a-z0-9_]{0,511}$/.test(value);
const fields = (value: any, allowed: any) => { if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(400, 'INVALID_TEMPLATE_FIELDS', 'Use only the template fields shown in this form.'); };
const canonical = (value: any): string => JSON.stringify(Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value);
const version = (value: any) => createHash('sha256').update(canonical(value)).digest('hex');
const unavailable = (uncertain = false) => fail(502, 'INVALID_TEMPLATE_RESPONSE', 'Zernio did not return a complete template receipt. Check its status before trying again.', uncertain);
const locks = new WeakMap();
const states = ['APPROVED', 'REJECTED', 'PENDING', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION'];
const editableStates = ['APPROVED', 'REJECTED', 'PAUSED'];

function variables(value: any, maximum = 100) {
  const found = [...value.matchAll(/\{\{([^}]+)\}\}/g)].map(match => match[1]);
  const positions = [...new Set(found.map(Number))].sort((a, b) => a - b);
  if (/\{\{|\}\}/.test(value.replace(/\{\{[1-9]\d*\}\}/g, '')) || found.some(item => !/^[1-9]\d*$/.test(item)) || positions.length > maximum || positions.some((item, index) => item !== index + 1)) fail(400, 'POSITIONAL_VALUES_REQUIRED', 'Use consecutive numbered values such as {{1}} and {{2}}.');
  return positions.length;
}
function samples(value: any, count: any, label: any) {
  if (!Array.isArray(value) || value.length !== count || value.some(item => !text(item, 1024))) fail(400, 'TEMPLATE_EXAMPLES_REQUIRED', `Provide one example for each ${label} value.`);
  return value;
}
function url(value: any) { try { return publicMediaUrl(value); } catch { fail(400, 'INVALID_TEMPLATE_URL', 'Use a public HTTPS URL for template media and website buttons.'); } }
function ttl(value: any, category: any, create = false) {
  if (value === undefined) return undefined;
  const limits = ({ AUTHENTICATION: [30, 900], UTILITY: [30, 43200], MARKETING: [43200, 2592000] } as Record<string, number[]>)[category];
  if (!Number.isSafeInteger(value) || !limits || !(create && value === -1 && category !== 'MARKETING') && (value < limits[0] || value > limits[1])) fail(400, 'INVALID_TEMPLATE_TTL', 'Choose a delivery window within this template category’s allowed range.');
  return value;
}
export function templateComponents(form: any) {
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
  if (form.buttons.length) components.push({ type: 'buttons', buttons: form.buttons.map((button: any) => {
    fields(button, ['type', 'text', 'url', 'phoneNumber', 'example']);
    if (!['quick_reply', 'url', 'phone_number'].includes(button.type) || !text(button.text, 25)) fail(400, 'INVALID_TEMPLATE_BUTTON', 'Choose a quick reply, website or phone button and provide its label.');
    const result: ProviderRecord = { type: button.type, text: button.text };
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
function publicComponents(value: any) {
  if (!Array.isArray(value) || value.length > 20) unavailable();
  return value.map((part: any) => {
    if (!object(part) || !text(part.type, 100) || ['text', 'format'].some(key => part[key] !== undefined && !text(part[key], 32768, true))) unavailable();
    const result: ProviderRecord = { type: part.type.toLowerCase(), ...(part.format ? { format: part.format.toLowerCase() } : {}), ...(part.text !== undefined ? { text: part.text } : {}) };
    if (part.buttons !== undefined) {
      if (!Array.isArray(part.buttons) || part.buttons.length > 10 || part.buttons.some((button: any) => !object(button) || !text(button.type, 100) || ['text', 'url', 'phone_number'].some(key => button[key] !== undefined && !text(button[key], 32768, true)))) unavailable();
      result.buttons = part.buttons.map((button: any) => ({ type: button.type.toLowerCase(), ...Object.fromEntries(['text', 'url', 'phone_number'].filter(key => button[key] !== undefined).map(key => [key, button[key]])) }));
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
function definition(components: any) {
  const form = { headerFormat: 'none', headerText: '', headerExamples: [], headerMediaUrl: '', bodyText: '', bodyExamples: [], footerText: '', buttons: [] };
  if (new Set(components.map((part: any) => part.type)).size !== components.length) return null;
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
      if (part.buttons.some((button: any) => !['quick_reply', 'url', 'phone_number'].includes(button.type))) return null;
      form.buttons = part.buttons.map((button: any) => ({ type: button.type, text: button.text || '', url: button.url || '', phoneNumber: button.phone_number || '', example: '' }));
    }
    try { if (['body', 'header'].includes(part.type) && part.text) variables(part.text, part.type === 'header' ? 1 : 100); } catch { return null; }
  }
  return form.bodyText ? form : null;
}
function row(value: any, expectedId?: any) {
  if (!object(value) || !numeric(value.id) || expectedId && value.id !== expectedId || !name(value.name) || !language(value.language) || !text(value.status, 100) || !['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(value.category) || value.message_send_ttl_seconds !== undefined && !Number.isSafeInteger(value.message_send_ttl_seconds) || value.rejected_reason !== undefined && !text(value.rejected_reason, 10000, true)) unavailable();
  const components = publicComponents(value.components), result = { id: value.id, name: value.name, language: value.language, category: value.category, status: value.status, components, ttlSeconds: value.message_send_ttl_seconds ?? null, rejectedReason: value.rejected_reason || '', quality: text(value.quality_score?.score, 100) ? value.quality_score.score : null };
  return { ...result, version: version({ ...result, components: value.components }), form: definition(components) };
}
async function list(api: ZernioApi, accountId: any, filter: ProviderRecord = {}) {
  const result = await api('/whatsapp/templates', { accountId, ...filter });
  if (result.success !== true || !Array.isArray(result.templates) || result.templates.length > 10000) unavailable();
  const rows = result.templates.map((value: any) => row(value));
  if (new Set(rows.map((value: any) => value.id)).size !== rows.length || new Set(rows.map((value: any) => `${value.name}:${value.language}`)).size !== rows.length || rows.some((value: any) => filter.status && value.status !== filter.status)) unavailable();
  return rows;
}
async function detail(api: ZernioApi, accountId: any, templateId: any) {
  const result = await api(`/whatsapp/templates/id/${templateId}`, { accountId });
  if (result.success !== true) unavailable(); return row(result.template, templateId);
}
function semantic(components: any) {
  return components.map((part: any) => ({ type: part.type.toLowerCase(), ...(part.format ? { format: part.format.toLowerCase() } : {}), ...(part.text !== undefined ? { text: part.text } : {}), ...(part.buttons ? { buttons: part.buttons.map((button: any) => ({ type: button.type.toLowerCase(), ...Object.fromEntries(['text', 'url', 'phone_number'].filter(key => button[key] !== undefined).map(key => [key, button[key]])) })) } : {}) })).sort((a: any, b: any) => a.type.localeCompare(b.type));
}
async function library(api: ZernioApi, accountId: any, requestedName: any, requestedLanguage: any) {
  if (!name(requestedName) || !language(requestedLanguage)) fail(400, 'INVALID_LIBRARY_LOOKUP', 'Enter the exact library name and a language code.');
  const result = await api('/whatsapp/template-library', { accountId, name: requestedName, language: requestedLanguage }), value = result.template;
  if (value === null) return null;
  if (!object(value) || value.name !== requestedName || !language(value.language) || !['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(value.category) || !text(value.body, 32768) || !Array.isArray(value.body_params) || value.body_params.some(item => !text(item, 1024, true)) || !Array.isArray(value.availableLanguages) || value.availableLanguages.some(item => !language(item)) || !Array.isArray(value.buttons) || value.buttons.length > 10 || value.buttons.some(button => !object(button) || !text(button.type, 100) || button.text !== undefined && !text(button.text, 100, true))) unavailable();
  const clean = { name: value.name, language: value.language, category: value.category, body: value.body, bodyParams: value.body_params, availableLanguages: value.availableLanguages, buttons: value.buttons.map((button: any) => ({ type: button.type.toLowerCase(), text: button.text || '' })) };
  return { ...clean, version: version(clean), importable: clean.buttons.every((button: any) => ['quick_reply', 'url', 'phone_number'].includes(button.type)) };
}

export async function handleZernioWhatsAppTemplates(context: OperationContext & { body: any }, api: ZernioApi, profileId: any, action: any) {
  const { req, url: requestUrl, body = {}, role, db, project, send } = context;
  const mutation = req.method === 'POST', matched = action.match(/^templates\/(\d{1,40})(?:\/(update|delete))?$/);
  if (!(req.method === 'GET' && ['overview', 'templates', 'library'].includes(action)) && !(matched && (req.method === 'GET' && !matched[2] || mutation && matched[2])) && !(mutation && ['templates/create', 'templates/import'].includes(action))) return false;
  const assertAccess = async () => { await context.assertProjectMapping?.(profileId); };
  await assertAccess();
  const accounts = await scopedAccounts(api, profileId), whatsapp = accounts.filter(account => account.platform === 'whatsapp');
  if (action === 'overview') { send(200, { accounts: whatsapp.map(account => ({ id: account._id, name: account.displayName || account.username || 'WhatsApp Business', isActive: account.isActive !== false, wabaId: numeric(account.metadata?.wabaId) ? account.metadata.wabaId : null })) }); return true; }
  const accountId = mutation ? body.accountId : requestUrl.searchParams.get('accountId'), account = requireAccount(accounts, accountId);
  if (account.platform !== 'whatsapp') fail(422, 'WHATSAPP_ACCOUNT_REQUIRED', 'Choose a connected WhatsApp account.');
  const wabaId = numeric(account.metadata?.wabaId) ? account.metadata.wabaId : null;
  const isAdmin = ['owner', 'admin'].includes(role), isOperator = async () => Boolean(context.user?.isOperator && (await db.execute(sql`SELECT 1 FROM instance_operators WHERE user_id = ${context.user.id}`)).rowCount);
  const ownership = async (templateId: any) => (await db.execute(sql`SELECT project_id, profile_id FROM zernio_whatsapp_template_ownership WHERE waba_id = ${wabaId} AND template_id = ${templateId}`)).rows[0] as ProviderRecord | undefined;
  const decorate = async (template: any) => { const owner = await ownership(template.id); return { ...template, managedHere: owner?.project_id === project.id && owner.profile_id === profileId, canReviewShared: isAdmin && await isOperator(), wabaId }; };
  async function freshAccount() {
    await assertAccess(); const fresh = requireAccount(await scopedAccounts(api, profileId), accountId);
    if (fresh.platform !== 'whatsapp' || fresh.isActive === false || !wabaId || fresh.metadata?.wabaId !== wabaId) fail(409, 'WHATSAPP_CONNECTION_CHANGED', 'The WhatsApp connection or business account changed. Refresh before continuing.');
    return fresh;
  }
  if (!mutation) {
    let result: any;
    if (action === 'templates') { const status = requestUrl.searchParams.get('status'); if (status && !states.includes(status)) fail(400, 'INVALID_TEMPLATE_FILTER', 'Choose a template review status.'); result = { templates: await Promise.all((await list(api, accountId, status ? { status } : {})).map(decorate)), wabaId }; }
    else if (action === 'library') result = { library: await library(api, accountId, requestUrl.searchParams.get('name'), requestUrl.searchParams.get('language')) };
    else { if (!(await list(api, accountId)).some((template: any) => template.id === matched[1])) fail(404, 'TEMPLATE_NOT_FOUND', 'This template is not available through this account.'); result = { template: await decorate(await detail(api, accountId, matched[1])) }; }
    await assertAccess(); send(200, result); return true;
  }
  if (!isAdmin) fail(403, 'TEMPLATE_ADMIN_REQUIRED', 'A workspace owner or administrator must manage WhatsApp business templates.');
  fields(body, ['accountId', 'expectedWabaId', 'name', 'category', 'language', 'form', 'ttlSeconds', 'confirmSubmission', 'expectedVersion', 'confirmTemplateId', 'reviewSharedWabaId', 'libraryName', 'expectedLibraryVersion', 'buttonInputs']);
  if (!wabaId || body.expectedWabaId !== wabaId) fail(409, 'WHATSAPP_BUSINESS_REVIEW_REQUIRED', 'Refresh and review the WhatsApp business account before changing a template.');
  const task = matched?.[2] || action.split('/')[1], templateId = matched?.[1];
  fields(body, ['accountId', 'expectedWabaId', ...(task === 'create' ? ['name', 'category', 'language', 'form', 'ttlSeconds', 'confirmSubmission'] : task === 'import' ? ['name', 'language', 'libraryName', 'expectedLibraryVersion', 'buttonInputs', 'ttlSeconds', 'confirmSubmission'] : ['expectedVersion', 'confirmTemplateId', 'reviewSharedWabaId', ...(task === 'update' ? ['form', 'ttlSeconds'] : [])])]);
  const reviewBusinessScope = async () => {
    // Creation provenance cannot prove exclusive use: templates belong to the WABA, not one number or project.
    if (!(await isOperator() && body.reviewSharedWabaId === wabaId && body.confirmTemplateId === templateId)) fail(403, 'SHARED_TEMPLATE_REVIEW_REQUIRED', 'An instance operator must explicitly review this variant and WhatsApp business account before editing or deleting it.');
  };
  if (['create', 'import'].includes(task) && (body.confirmSubmission !== true || !name(body.name) || !language(body.language))) fail(400, 'TEMPLATE_SUBMISSION_REVIEW_REQUIRED', 'Review the template name, language and content before submitting.');
  const result = await operation(context, async key => {
    if (!locks.has(db)) locks.set(db, new Set()); const active = locks.get(db);
    // Fast in-process rejection; the durable WABA fence below is what excludes other processes.
    if (active.has(wabaId)) fail(409, 'WHATSAPP_BUSINESS_BUSY', 'Another template change for this WhatsApp business account is in progress.');
    active.add(wabaId);
    let fenced = false, uncertain = false;
    try {
      if (!await claimFence(db, 'zernio_whatsapp_template_mutations', wabaId, project.id, key, 'waba_id')) fail(409, 'TEMPLATE_PREVIOUS_OUTCOME_UNRESOLVED', 'This new change was not sent. Review the previous template change in provider outcomes before changing this WhatsApp business account again.');
      fenced = true;
      await freshAccount();
      const before = await list(api, accountId); let current: any;
      if (templateId) {
        if (!before.some((template: any) => template.id === templateId)) fail(404, 'TEMPLATE_NOT_FOUND', 'This template is not available through this account.');
        current = await detail(api, accountId, templateId);
        if (body.expectedVersion !== current.version) fail(409, 'TEMPLATE_CHANGED', 'This template changed. Refresh and review the current version.');
        await reviewBusinessScope();
        if (task === 'delete' && body.confirmTemplateId !== templateId) fail(400, 'TEMPLATE_DELETE_REVIEW_REQUIRED', 'Confirm the exact language variant before deleting it.');
      }
      let payload: any, components: any, source: any;
      if (task === 'create') {
        if (!['UTILITY', 'MARKETING'].includes(body.category)) fail(400, 'TEMPLATE_FORMAT_UNAVAILABLE', 'Custom content here supports utility and marketing templates. Authentication requires the dedicated OTP format.');
        components = templateComponents(body.form); payload = { accountId, name: body.name, category: body.category, language: body.language, parameter_format: 'POSITIONAL', components };
      } else if (task === 'import') {
        source = await library(api, accountId, body.libraryName, body.language);
        if (!source || source.version !== body.expectedLibraryVersion || source.language !== body.language) fail(409, 'LIBRARY_TEMPLATE_CHANGED', 'The library language or content changed. Look it up and review it again.');
        if (!source.importable) fail(422, 'LIBRARY_FORMAT_UNAVAILABLE', 'This library template requires an advanced button editor.');
        if (!Array.isArray(body.buttonInputs) || body.buttonInputs.length !== source.buttons.length) fail(400, 'LIBRARY_BUTTON_INPUTS_REQUIRED', 'Provide matching inputs for every library button in order.');
        const inputs = source.buttons.map((button: any, index: any) => {
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
        if (task !== 'update' && before.some((template: any) => template.name === payload.name && template.language === payload.language)) fail(409, 'TEMPLATE_EXISTS', 'That template name and language already exist. Choose its variant to edit it.');
      }
      await freshAccount();
      if (templateId) await reviewBusinessScope();
      const receipt = await api(templateId ? `/whatsapp/templates/id/${templateId}` : '/whatsapp/templates', task === 'delete' ? { accountId } : {}, payload, key, task === 'delete' ? 'DELETE' : task === 'update' ? 'PATCH' : 'POST');
      try {
        if (receipt.success !== true) unavailable();
        if (templateId) await reviewBusinessScope();
        if (task === 'delete') {
          if (receipt.scope !== 'language' || receipt.language !== current.language) unavailable();
          await freshAccount();
          let deleted = false; try { deleted = (await detail(api, accountId, templateId)).status === 'PENDING_DELETION'; } catch (error: any) { if (error instanceof IntegrationError && (error.providerStatus === 404 || error.status === 404)) deleted = true; else throw error; }
          if (!deleted) unavailable(); return { deleted: true, templateId, language: current.language };
        }
        const saved = receipt.template;
        if (!object(saved) || !numeric(saved.id) || templateId && saved.id !== templateId || saved.name !== (current?.name || payload.name) || saved.language !== (current?.language || payload.language) || !text(saved.status, 100) || saved.category !== undefined && saved.category !== (current?.category || payload.category) || !templateId && before.some((template: any) => template.id === saved.id)) unavailable();
        if (!templateId) {
          const owned = await ownership(saved.id); if (owned && (owned.project_id !== project.id || owned.profile_id !== profileId)) fail(502, 'TEMPLATE_OWNERSHIP_CONFLICT', 'This template already has a different project owner.');
          await db.execute(sql`INSERT INTO zernio_whatsapp_template_ownership (waba_id, template_id, project_id, profile_id) VALUES (${wabaId}, ${saved.id}, ${project.id}, ${profileId}) ON CONFLICT DO NOTHING`);
        }
        await freshAccount(); const fresh = await detail(api, accountId, saved.id);
        if (fresh.name !== saved.name || fresh.language !== saved.language || fresh.category !== (current?.category || payload.category) || components && canonical(semantic(fresh.components)) !== canonical(semantic(components)) || payload.message_send_ttl_seconds !== undefined && payload.message_send_ttl_seconds !== -1 && fresh.ttlSeconds !== payload.message_send_ttl_seconds) unavailable();
        if (source) {
          const buttons = fresh.components.flatMap((part: any) => part.buttons || []);
          if (fresh.components.find((part: any) => part.type === 'body')?.text !== source.body || buttons.length !== source.buttons.length || source.buttons.some((button: any, index: any) => buttons[index]?.type !== button.type || buttons[index]?.text !== button.text || button.type === 'url' && buttons[index]?.url !== body.buttonInputs[index].url || button.type === 'phone_number' && buttons[index]?.phone_number !== body.buttonInputs[index].phoneNumber)) unavailable();
        }
        await assertAccess(); return { template: await decorate(fresh), submitted: true };
      } catch (error: any) { if (error instanceof IntegrationError) error.uncertain = true; throw error; }
    } catch (error: any) { uncertain = !(error instanceof IntegrationError) || error.uncertain; throw error; }
    finally { try { if (fenced && !uncertain) await releaseFence(db, 'zernio_whatsapp_template_mutations', wabaId, project.id, key, 'waba_id'); } finally { active.delete(wabaId); } }
  }, `whatsapp-templates:${wabaId}`);
  send(result.status, result.data); return true;
}
