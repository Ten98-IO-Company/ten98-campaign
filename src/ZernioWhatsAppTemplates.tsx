import React, { useEffect, useRef, useState } from 'react';
import WhatsAppTemplate from './WhatsAppTemplate';

type Form = { headerFormat: string; headerText: string; headerExamples: string[]; headerMediaUrl: string; bodyText: string; bodyExamples: string[]; footerText: string; buttons: { type: string; text: string; url: string; phoneNumber: string; example: string }[] };
type Template = { id: string; name: string; language: string; category: string; status: string; version: string; components: any[]; form: Form | null; ttlSeconds: number | null; rejectedReason: string; quality: string | null; managedHere: boolean; canReviewShared: boolean; wabaId: string | null };
type Account = { id: string; name: string; isActive: boolean; wabaId: string | null };
type Props = { projectId: string; canManage: boolean; isOperator: boolean; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any> };
const blank = (): Form => ({ headerFormat: 'none', headerText: '', headerExamples: [], headerMediaUrl: '', bodyText: '', bodyExamples: [], footerText: '', buttons: [] });
const positions = (value: string) => [...new Set([...value.matchAll(/\{\{([1-9]\d*)\}\}/g)].map(match => Number(match[1])))].sort((a, b) => a - b).slice(0, 100);
function exampleComponents(form: Form) {
  const result: any[] = [], header = form.headerFormat;
  if (header === 'text') result.push({ type: 'header', parameters: positions(form.headerText).map((_, index) => ({ type: 'text', text: form.headerExamples[index] || '' })) });
  else if (header !== 'none') result.push({ type: 'header', parameters: [{ type: header, [header]: { link: form.headerMediaUrl } }] });
  result.push({ type: 'body', parameters: positions(form.bodyText).map((_, index) => ({ type: 'text', text: form.bodyExamples[index] || '' })) });
  form.buttons.forEach((button, index) => { if (button.type === 'url' && button.url.endsWith('{{1}}')) result.push({ type: 'button', sub_type: 'url', index: String(index), parameters: [{ type: 'text', text: button.example }] }); });
  return result;
}
function previewDefinition(form: Form) {
  return { components: [...(form.headerFormat === 'none' ? [] : [{ type: 'HEADER', format: form.headerFormat.toUpperCase(), ...(form.headerFormat === 'text' ? { text: form.headerText } : {}) }]), { type: 'BODY', text: form.bodyText }, ...(form.footerText ? [{ type: 'FOOTER', text: form.footerText }] : []), ...(form.buttons.length ? [{ type: 'BUTTONS', buttons: form.buttons.map(button => ({ type: button.type.toUpperCase(), text: button.text, ...(button.type === 'url' ? { url: button.url } : button.type === 'phone_number' ? { phone_number: button.phoneNumber } : {}) })) }] : [])] };
}
export function TemplateContentEditor({ form, onChange }: { form: Form; onChange: (value: Form) => void }) {
  const change = (field: keyof Form, value: unknown) => onChange({ ...form, [field]: value });
  function examples(components: any[]) {
    const part = (type: string) => components.find(row => row.type === type)?.parameters || [];
    onChange({ ...form, headerExamples: part('header').map((row: any) => row.text || ''), bodyExamples: part('body').map((row: any) => row.text || ''), headerMediaUrl: part('header')[0]?.[form.headerFormat]?.link || form.headerMediaUrl, buttons: form.buttons.map((button, index) => ({ ...button, example: components.find(row => row.type === 'button' && String(row.index) === String(index))?.parameters?.[0]?.text || button.example })) });
  }
  return <>
    <label className="field"><span>Header</span><select value={form.headerFormat} onChange={event => onChange({ ...form, headerFormat: event.target.value, headerText: '', headerExamples: [], headerMediaUrl: '' })}><option value="none">No header</option><option value="text">Text</option><option value="image">Image</option><option value="video">Video</option><option value="document">Document</option></select></label>
    {form.headerFormat === 'text' && <label className="field"><span>Header text</span><input required maxLength={60} value={form.headerText} onChange={event => change('headerText', event.target.value)}/><small>One optional numbered value: {'{{1}}'}.</small></label>}
    <label className="field"><span>Message</span><textarea required maxLength={1024} value={form.bodyText} onChange={event => change('bodyText', event.target.value)}/><small>Use consecutive numbered values: {'{{1}}, {{2}}'}. Provide examples below for Meta’s review.</small></label>
    <label className="field"><span>Footer</span><input maxLength={60} value={form.footerText} onChange={event => change('footerText', event.target.value)}/></label>
    {form.buttons.map((button, index) => <div key={index} className="panel"><div className="form-grid"><label className="field"><span>Button {index + 1}</span><select value={button.type} onChange={event => change('buttons', form.buttons.map((row, position) => position === index ? { ...row, type: event.target.value } : row))}><option value="quick_reply">Quick reply</option><option value="url">Website</option><option value="phone_number">Phone</option></select></label><label className="field"><span>Button label</span><input required maxLength={25} value={button.text} onChange={event => change('buttons', form.buttons.map((row, position) => position === index ? { ...row, text: event.target.value } : row))}/></label></div>{button.type === 'url' && <label className="field"><span>Website URL</span><input required type="url" value={button.url} onChange={event => change('buttons', form.buttons.map((row, position) => position === index ? { ...row, url: event.target.value } : row))}/><small>One optional {'{{1}}'} suffix may appear at the end.</small></label>}{button.type === 'phone_number' && <label className="field"><span>International phone number</span><input required type="tel" placeholder="+971501234567" value={button.phoneNumber} onChange={event => change('buttons', form.buttons.map((row, position) => position === index ? { ...row, phoneNumber: event.target.value } : row))}/></label>}<button type="button" className="button" onClick={() => change('buttons', form.buttons.filter((_, position) => position !== index))}>Remove button {index + 1}</button></div>)}
    {form.buttons.length < 10 && <button type="button" className="button" onClick={() => change('buttons', [...form.buttons, { type: 'quick_reply', text: '', url: '', phoneNumber: '', example: '' }])}>Add button</button>}
    <h4>Reviewer examples and preview</h4><WhatsAppTemplate template={previewDefinition(form)} components={exampleComponents(form)} onChange={examples}/>
  </>;
}

export default function ZernioWhatsAppTemplates({ projectId, canManage, isOperator, request }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]), [accountId, setAccountId] = useState(''), [templates, setTemplates] = useState<Template[]>([]), [status, setStatus] = useState('');
  const [selected, setSelected] = useState<Template | null>(null), [mode, setMode] = useState('detail'), [form, setForm] = useState<Form>(blank), [templateName, setTemplateName] = useState(''), [category, setCategory] = useState('UTILITY'), [templateLanguage, setTemplateLanguage] = useState('en');
  const [ttlSeconds, setTtlSeconds] = useState(''), [editContent, setEditContent] = useState(false), [reviewed, setReviewed] = useState(false), [sharedReviewed, setSharedReviewed] = useState(false), [deleteReviewed, setDeleteReviewed] = useState(false);
  const [libraryName, setLibraryName] = useState(''), [libraryLanguage, setLibraryLanguage] = useState('en'), [library, setLibrary] = useState<any>(null), [buttonInputs, setButtonInputs] = useState<any[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const active = useRef(true), scope = useRef({ identity: '' }), requester = useRef(request), reads = useRef(0), busyRef = useRef(false), keys = useRef(new Map<string, string>());
  const path = `/projects/${encodeURIComponent(projectId)}/integrations/whatsapp-templates`, identity = JSON.stringify([path, accountId, status, canManage, isOperator]);
  if (scope.current.identity !== identity) scope.current = { identity };
  const view = scope.current, current = () => active.current && scope.current === view; requester.current = request;
  const account = accounts.find(row => row.id === accountId), wabaId = account?.wabaId, scopeReviewed = !!selected && selected.canReviewShared && isOperator && sharedReviewed, canWrite = canManage && account?.isActive && !!wabaId;
  useEffect(() => { active.current = true; return () => { active.current = false; reads.current++; }; }, []);
  useEffect(() => {
    let cancelled = false; setAccounts([]); setAccountId(''); setTemplates([]); setSelected(null); setMode('detail'); setError(''); setNotice('');
    requester.current(`${path}/overview`).then(result => { if (cancelled) return; if (!Array.isArray(result.accounts)) throw new Error('WhatsApp accounts could not be read.'); setAccounts(result.accounts); setAccountId(result.accounts[0]?.id || ''); }).catch(failure => { if (!cancelled) setError(failure.message); });
    return () => { cancelled = true; };
  }, [path, canManage, isOperator]);
  useEffect(() => {
    busyRef.current = false; setBusy(false); setTemplates([]); setSelected(null); setLibrary(null); setMode('detail'); setReviewed(false); setSharedReviewed(false); setDeleteReviewed(false); setError(''); setNotice(''); reads.current++;
    if (accountId) action(load);
  }, [identity]);
  async function action(run: () => Promise<void>) {
    if (!current() || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try { await run(); } catch (failure) { if (current()) setError((failure as Error).message || 'The template request could not be confirmed.'); }
    finally { if (current()) { busyRef.current = false; setBusy(false); } }
  }
  async function load() {
    const read = ++reads.current, result = await requester.current(`${path}/templates?accountId=${encodeURIComponent(accountId)}${status ? `&status=${encodeURIComponent(status)}` : ''}`);
    if (!current() || read !== reads.current) return;
    if (!Array.isArray(result.templates)) throw new Error('WhatsApp templates could not be read.'); setTemplates(result.templates);
  }
  async function choose(template: Template) {
    await action(async () => {
      const result = await requester.current(`${path}/templates/${template.id}?accountId=${encodeURIComponent(accountId)}`); if (!current()) return;
      if (result.template?.id !== template.id || typeof result.template.version !== 'string') throw new Error('This language variant could not be read.');
      const row = result.template; setSelected(row); setMode('detail'); setForm(row.form ? structuredClone(row.form) : blank()); setTemplateName(row.name); setTemplateLanguage(row.language); setCategory(row.category); setTtlSeconds(''); setEditContent(false); setReviewed(false); setSharedReviewed(false); setDeleteReviewed(false);
    });
  }
  function create() { setSelected(null); setMode('create'); setForm(blank()); setTemplateName(''); setTemplateLanguage('en'); setCategory('UTILITY'); setTtlSeconds(''); setReviewed(false); setSharedReviewed(false); setDeleteReviewed(false); setError(''); setNotice(''); }
  async function write(task: string, body: any) {
    if (!current()) throw new DOMException('The project or account changed.', 'AbortError');
    const target = `${path}/${task}`, fingerprint = `${target}:${JSON.stringify(body)}`;
    let key = keys.current.get(fingerprint); if (!key) { key = crypto.randomUUID(); keys.current.set(fingerprint, key); }
    try {
      const result = await requester.current(target, 'POST', body, key), row = result.template;
      const valid = task.endsWith('/delete') ? result.deleted === true && result.templateId === body.confirmTemplateId && typeof result.language === 'string' : typeof row?.id === 'string' && /^\d+$/.test(row.id) && typeof row.version === 'string' && row.wabaId === body.expectedWabaId && (task.includes('/update') ? row.id === task.split('/')[1] : row.name === body.name && row.language === body.language);
      if (result.operation?.status !== 'complete' || !valid) throw new Error('The template receipt could not be read. Your action key has been retained.');
      keys.current.delete(fingerprint); if (!current()) throw new DOMException('The project or account changed.', 'AbortError'); return result;
    } catch (failure) { const receipt = failure as Error & { status?: number; code?: string; operation?: { status?: string } }; if (receipt.status && receipt.status < 500 && !['OPERATION_UNCERTAIN', 'OPERATION_IN_PROGRESS', 'OPERATION_PENDING'].includes(receipt.code || '') && !['uncertain', 'pending'].includes(receipt.operation?.status || '')) keys.current.delete(fingerprint); throw failure; }
  }
  const shared = () => selected ? { reviewSharedWabaId: sharedReviewed ? wabaId : '', confirmTemplateId: selected.id } : {};
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!canWrite || !reviewed || selected && !scopeReviewed) return;
    const body = { accountId, expectedWabaId: wabaId, ...(ttlSeconds !== '' ? { ttlSeconds: Number(ttlSeconds) } : {}), ...(selected ? { expectedVersion: selected.version, ...(editContent ? { form } : {}), ...shared() } : { name: templateName, category, language: templateLanguage, form, confirmSubmission: true }) };
    await action(async () => { const result = await write(selected ? `templates/${selected.id}/update` : 'templates/create', body); if (!current()) return; setSelected(result.template); setMode('detail'); setForm(result.template.form || blank()); setEditContent(false); setTtlSeconds(''); setReviewed(false); setSharedReviewed(false); setDeleteReviewed(false); await load(); if (current()) setNotice(`Template submitted. Current provider status: ${result.template.status}. Only approved templates can be sent.`); });
  }
  async function remove() {
    if (!canWrite || !selected || !scopeReviewed || !deleteReviewed) return;
    const target = selected;
    await action(async () => { await write(`templates/${target.id}/delete`, { accountId, expectedWabaId: wabaId, expectedVersion: target.version, ...shared(), confirmTemplateId: target.id }); if (!current()) return; setSelected(null); setMode('detail'); setDeleteReviewed(false); setSharedReviewed(false); await load(); if (current()) setNotice(`Deletion confirmed for ${target.name} (${target.language}). Meta may keep it pending deletion during its grace period.`); });
  }
  async function lookup(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); await action(async () => {
      const result = await requester.current(`${path}/library?accountId=${encodeURIComponent(accountId)}&name=${encodeURIComponent(libraryName)}&language=${encodeURIComponent(libraryLanguage)}`); if (!current()) return;
      if (result.library !== null && (!result.library || typeof result.library.version !== 'string' || !Array.isArray(result.library.buttons))) throw new Error('The library template could not be read.');
      setLibrary(result.library); setSelected(null); setMode('library'); setTemplateName(result.library?.name || ''); setButtonInputs((result.library?.buttons || []).map((button: any) => ({ type: button.type, url: '', phoneNumber: '' }))); setReviewed(false); setTtlSeconds(''); if (!result.library) setNotice('No library template matched that exact name.');
    });
  }
  async function importLibrary(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!canWrite || !library?.importable || !reviewed) return;
    await action(async () => {
      const result = await write('templates/import', { accountId, expectedWabaId: wabaId, name: templateName, language: library.language, libraryName: library.name, expectedLibraryVersion: library.version, buttonInputs, confirmSubmission: true, ...(ttlSeconds !== '' ? { ttlSeconds: Number(ttlSeconds) } : {}) });
      if (!current()) return; setSelected(result.template); setMode('detail'); setForm(result.template.form || blank()); setEditContent(false); setReviewed(false); setTtlSeconds(''); await load(); if (current()) setNotice(`Library template imported. Current provider status: ${result.template.status}.`);
    });
  }
  const editable = !!selected && ['APPROVED', 'REJECTED', 'PAUSED'].includes(selected.status);
  return <section className="panel settings-panel">
    <div className="panel-heading"><div><h2>WhatsApp templates</h2><p>Manage language variants, review status and delivery windows.</p></div>{accountId && <button type="button" className="button" disabled={busy} onClick={() => action(load)}>Refresh templates</button>}</div>
    {error && <p className="alert" role="alert">{error}</p>}{notice && <p className="helper-note" role="status">{notice}</p>}
    {!accounts.length ? <p>No WhatsApp account is connected to this project.</p> : <>
      <div className="form-grid"><label className="field"><span>WhatsApp account</span><select value={accountId} onChange={event => setAccountId(event.target.value)}>{accounts.map(row => <option key={row.id} value={row.id}>{row.name}{row.isActive ? '' : ' · Reconnection required'}</option>)}</select></label><label className="field"><span>Review status</span><select value={status} onChange={event => setStatus(event.target.value)}><option value="">All statuses</option>{['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION'].map(value => <option key={value}>{value}</option>)}</select></label></div>
      {!wabaId && <p className="helper-note">This connection does not report its WhatsApp business account. Templates can be read; refresh the connection before changing them.</p>}
      <p className="helper-note">Templates are shared by all numbers in the same WhatsApp business account. Only approved language variants can be sent.</p>
      {templates.length ? <div className="table-scroll"><table><thead><tr><th>Template</th><th>Language</th><th>Category</th><th>Status</th><th>Action</th></tr></thead><tbody>{templates.map(row => <tr key={row.id}><td>{row.name}</td><td>{row.language}</td><td>{row.category}</td><td>{row.status}</td><td><button type="button" className="button" disabled={busy} onClick={() => choose(row)}>View {row.name} ({row.language})</button></td></tr>)}</tbody></table></div> : <p>{busy ? 'Loading templates…' : 'No templates match this status.'}</p>}
      {canWrite && <p><button type="button" className="button" disabled={busy} onClick={create}>Create template</button></p>}
      <details><summary>Find a pre-approved library template</summary><p>Enter its exact name from Meta’s template library. The provider may return a different available language; review it before importing.</p><form onSubmit={lookup}><fieldset disabled={busy}><div className="form-grid"><label className="field"><span>Exact library name</span><input required pattern="[a-z][a-z0-9_]*" value={libraryName} onChange={event => { setLibraryName(event.target.value); setLibrary(null); }}/></label><label className="field"><span>Requested language</span><input required value={libraryLanguage} onChange={event => { setLibraryLanguage(event.target.value); setLibrary(null); }}/></label></div><button className="button">Look up library template</button></fieldset></form></details>
      {mode === 'library' && library && <form onSubmit={importLibrary}><fieldset disabled={busy}><h3>{library.name} · {library.language}</h3><p>{library.category} · Available languages: {library.availableLanguages.join(', ')}</p><p style={{ whiteSpace: 'pre-wrap' }}>{library.body}</p>{library.language !== libraryLanguage && <p className="helper-note">The requested language was unavailable. Import will use {library.language}.</p>}{!library.importable && <p className="helper-note">This library template needs advanced button inputs that are not available in this editor.</p>}{canWrite && library.importable && <><label className="field"><span>New template name</span><input required pattern="[a-z][a-z0-9_]*" value={templateName} onChange={event => { setTemplateName(event.target.value); setReviewed(false); }}/></label>{library.buttons.map((button: any, index: number) => <div key={index}><p>{button.text || 'Button'} · {button.type}</p>{button.type !== 'quick_reply' && <label className="field"><span>{button.type === 'url' ? 'Website URL' : 'International phone number'}</span><input required type={button.type === 'url' ? 'url' : 'tel'} value={buttonInputs[index]?.[button.type === 'url' ? 'url' : 'phoneNumber'] || ''} onChange={event => { setButtonInputs(buttonInputs.map((input, position) => position === index ? { ...input, [button.type === 'url' ? 'url' : 'phoneNumber']: event.target.value } : input)); setReviewed(false); }}/></label>}</div>)}<label className="field"><span>Custom delivery window in seconds (optional)</span><input type="number" value={ttlSeconds} onChange={event => { setTtlSeconds(event.target.value); setReviewed(false); }}/></label><label><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)}/> I reviewed this template, returned language and button destinations.</label><p><button className="button" disabled={!reviewed}>Import library template</button></p></>}</fieldset></form>}
      {selected && <><h3>{selected.name} · {selected.language}</h3><p>{selected.category} · {selected.status}{selected.quality ? ` · Quality: ${selected.quality}` : ''}</p>{selected.rejectedReason && <p className="alert">{selected.rejectedReason}</p>}<p>Delivery window: {selected.ttlSeconds === null ? 'Provider category default' : `${selected.ttlSeconds} seconds`}</p><div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{selected.components.map((part, index) => <div key={index}><p>{part.text || part.type}{part.format ? ` (${part.format})` : ''}</p>{part.buttons?.map((button: any, position: number) => <p key={position}>{button.text || button.type}{button.url ? ` · ${button.url}` : button.phone_number ? ` · ${button.phone_number}` : ''}</p>)}</div>)}</div>
        <p className="helper-note">Templates belong to the WhatsApp business account and can be used across numbers and projects. An instance operator must review this scope before editing or deleting a variant, including templates created here.</p>
        {canWrite && selected.canReviewShared && isOperator && <label><input type="checkbox" checked={sharedReviewed} onChange={event => { setSharedReviewed(event.target.checked); setReviewed(false); setDeleteReviewed(false); }}/> As an instance operator, I reviewed changes to variant {selected.id} in shared business account {wabaId}.</label>}
      </>}
      {(mode === 'create' && canWrite || selected && canWrite && scopeReviewed && editable) && <form onSubmit={save}><fieldset disabled={busy}><h3>{selected ? 'Edit language variant' : 'Create template'}</h3>{!selected && <div className="form-grid"><label className="field"><span>Template name</span><input required pattern="[a-z][a-z0-9_]*" maxLength={512} value={templateName} onChange={event => { setTemplateName(event.target.value); setReviewed(false); }}/></label><label className="field"><span>Language</span><input required value={templateLanguage} onChange={event => { setTemplateLanguage(event.target.value); setReviewed(false); }}/></label><label className="field"><span>Category</span><select value={category} onChange={event => { setCategory(event.target.value); setTtlSeconds(''); setReviewed(false); }}><option value="UTILITY">Utility</option><option value="MARKETING">Marketing</option></select></label></div>}{selected && selected.form && selected.category !== 'AUTHENTICATION' && <label><input type="checkbox" checked={editContent} onChange={event => { setEditContent(event.target.checked); setReviewed(false); }}/> Edit template content and submit it for review again.</label>}{selected && (!selected.form || selected.category === 'AUTHENTICATION') && <p className="helper-note">Advanced content is readable here. Its delivery window can be edited separately.</p>}{(!selected || editContent) && <TemplateContentEditor form={form} onChange={value => { setForm(value); setReviewed(false); }}/>}<label className="field"><span>Custom delivery window in seconds (optional)</span><input type="number" step="1" value={ttlSeconds} onChange={event => { setTtlSeconds(event.target.value); setReviewed(false); }}/><small>{category === 'MARKETING' ? '43,200–2,592,000' : category === 'AUTHENTICATION' ? '30–900' : '30–43,200'} seconds. Leave empty to {selected ? 'keep the current window' : 'use the category default'}. A content edit starts another provider review.</small></label><label><input type="checkbox" checked={reviewed} onChange={event => setReviewed(event.target.checked)}/> I reviewed this language variant, content and delivery window.</label><p><button className="button" disabled={!reviewed || !!selected && !editContent && ttlSeconds === ''}>{selected ? 'Save template changes' : 'Submit template for review'}</button></p></fieldset></form>}
      {selected && canWrite && scopeReviewed && <fieldset disabled={busy}><h3>Delete this language variant</h3><p>Other languages stay available. Meta may keep a deleted variant pending deletion and prevent reuse of its name for 30 days.</p><label><input type="checkbox" checked={deleteReviewed} onChange={event => setDeleteReviewed(event.target.checked)}/> Delete {selected.name} ({selected.language}), variant {selected.id}.</label><p><button type="button" className="button" disabled={!deleteReviewed} onClick={remove}>Delete language variant</button></p></fieldset>}
    </>}
  </section>;
}
