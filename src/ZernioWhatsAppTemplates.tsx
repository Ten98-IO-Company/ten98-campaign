import React, { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, DataTable, DescriptionList, Disclosure, EmptyState, Field, FieldList, Form, FormActions, FormGrid, Heading, Inline, InlineCode, Input, List, ListItem, Option, ReviewConfirm, Select, Stack, StatusLine, Text, Textarea, type Tone } from '@ten98/ui';
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
  const length = (value: string) => value.length;
  return <Stack gap={3}>
    <Field label="Header"><Select value={form.headerFormat} onChange={event => onChange({ ...form, headerFormat: event.target.value, headerText: '', headerExamples: [], headerMediaUrl: '' })}><Option value="none">No header</Option><Option value="text">Text</Option><Option value="image">Image</Option><Option value="video">Video</Option><Option value="document">Document</Option></Select></Field>
    {form.headerFormat === 'text' && <Field label="Header text" description={<>One optional numbered value: <InlineCode>{'{{1}}'}</InlineCode>.</>} count={{ value: form.headerText, max: 60, measure: length }}><Input required maxLength={60} value={form.headerText} onChange={event => change('headerText', event.target.value)}/></Field>}
    <Field label="Message" description={<>Use consecutive numbered values: <InlineCode>{'{{1}}, {{2}}'}</InlineCode>. Provide examples below for Meta’s review.</>} count={{ value: form.bodyText, max: 1024, measure: length }}><Textarea required maxLength={1024} value={form.bodyText} onChange={event => change('bodyText', event.target.value)}/></Field>
    <Field label="Footer" count={{ value: form.footerText, max: 60, measure: length }}><Input maxLength={60} value={form.footerText} onChange={event => change('footerText', event.target.value)}/></Field>
    <FieldList legend="Buttons" name="buttons" emptyMessage="No buttons. Messages can be sent without them." items={form.buttons} getKey={button => String(form.buttons.indexOf(button))} max={10} addLabel="Add button" removeLabel={index => `Remove button ${index + 1}`} onAdd={() => change('buttons', [...form.buttons, { type: 'quick_reply', text: '', url: '', phoneNumber: '', example: '' }])} onRemove={index => change('buttons', form.buttons.filter((_, position) => position !== index))} renderItem={(button, index) => <FormGrid>
      <Field label={`Button ${index + 1}`}><Select value={button.type} onChange={event => change('buttons', form.buttons.map((row, position) => position === index ? { ...row, type: event.target.value } : row))}><Option value="quick_reply">Quick reply</Option><Option value="url">Website</Option><Option value="phone_number">Phone</Option></Select></Field>
      <Field label="Button label" count={{ value: button.text, max: 25, measure: length }}><Input required maxLength={25} value={button.text} onChange={event => change('buttons', form.buttons.map((row, position) => position === index ? { ...row, text: event.target.value } : row))}/></Field>
      {button.type === 'url' && <Field label="Website URL" description={<>One optional <InlineCode>{'{{1}}'}</InlineCode> suffix may appear at the end.</>}><Input required type="url" value={button.url} onChange={event => change('buttons', form.buttons.map((row, position) => position === index ? { ...row, url: event.target.value } : row))}/></Field>}
      {button.type === 'phone_number' && <Field label="International phone number"><Input required type="tel" placeholder="+971501234567" value={button.phoneNumber} onChange={event => change('buttons', form.buttons.map((row, position) => position === index ? { ...row, phoneNumber: event.target.value } : row))}/></Field>}
    </FormGrid>}/>
    <Heading level={4} size="sm">Reviewer examples and preview</Heading><WhatsAppTemplate template={previewDefinition(form)} components={exampleComponents(form)} onChange={examples}/>
  </Stack>;
}
const statusTone = (status: string): Tone => status === 'APPROVED' ? 'success' : ['REJECTED', 'DISABLED'].includes(status) ? 'danger' : ['PENDING', 'IN_APPEAL', 'PAUSED', 'PENDING_DELETION'].includes(status) ? 'warning' : 'neutral';

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
  return <Card as="section" headingLevel={2} title="WhatsApp templates" description="Manage language variants, review status and delivery windows." actions={accountId && <Button variant="secondary" disabled={busy} onClick={() => action(load)}>Refresh templates</Button>}><Stack gap={4}>
    {error && <Alert tone="danger">{error}</Alert>}{notice && <StatusLine>{notice}</StatusLine>}
    {!accounts.length ? <EmptyState title="No WhatsApp account" description="No WhatsApp account is connected to this project."/> : <>
      <FormGrid><Field label="WhatsApp account"><Select value={accountId} onChange={event => setAccountId(event.target.value)}>{accounts.map(row => <Option key={row.id} value={row.id}>{row.name}{row.isActive ? '' : ' · Reconnection required'}</Option>)}</Select></Field><Field label="Review status"><Select value={status} onChange={event => setStatus(event.target.value)}><Option value="">All statuses</Option>{['APPROVED', 'PENDING', 'REJECTED', 'PAUSED', 'DISABLED', 'IN_APPEAL', 'PENDING_DELETION'].map(value => <Option key={value}>{value}</Option>)}</Select></Field></FormGrid>
      {!wabaId && <Alert tone="warning">This connection does not report its WhatsApp business account. Templates can be read; refresh the connection before changing them.</Alert>}
      <Text tone="muted">Templates are shared by all numbers in the same WhatsApp business account. Only approved language variants can be sent.</Text>
      <DataTable ariaLabel="WhatsApp templates" searchPlaceholder="Search templates…" pageSize={25} rows={templates} rowKey={row => row.id} activeKey={selected?.id} onRowActivate={row => choose(row)} loading={busy && !templates.length} emptyState={<Text>No templates match this status.</Text>} columns={[{ key: 'name', header: 'Template', rowHeader: true, wrap: true, render: row => row.name, sortValue: row => row.name }, { key: 'language', header: 'Language', render: row => row.language, sortValue: row => row.language }, { key: 'category', header: 'Category', render: row => row.category, sortValue: row => row.category }, { key: 'status', header: 'Status', render: row => <Badge tone={statusTone(row.status)}>{row.status}</Badge>, sortValue: row => row.status }]} rowActionsLabel="Action" rowActions={row => <Button variant="secondary" size="sm" disabled={busy} aria-label={`View ${row.name} (${row.language})`} onClick={() => choose(row)}>View</Button>}/>
      {canWrite && <Inline><Button variant="secondary" disabled={busy} onClick={create}>Create template</Button></Inline>}
      <Disclosure summary="Find a pre-approved library template"><Stack gap={3}><Text>Enter its exact name from Meta’s template library. The provider may return a different available language; review it before importing.</Text><Form aria-label="Find a library template" busy={busy} onSubmit={(_, event) => lookup(event)}><FormGrid><Field label="Exact library name" description="Lowercase letters, digits and underscores, starting with a letter."><Input required pattern="[a-z][a-z0-9_]*" value={libraryName} onChange={event => { setLibraryName(event.target.value); setLibrary(null); }}/></Field><Field label="Requested language"><Input required value={libraryLanguage} onChange={event => { setLibraryLanguage(event.target.value); setLibrary(null); }}/></Field></FormGrid><FormActions><Button variant="secondary" type="submit">Look up library template</Button></FormActions></Form></Stack></Disclosure>
      {mode === 'library' && library && <Card as="section" title={`${library.name} · ${library.language}`} description={`${library.category} · Available languages: ${library.availableLanguages.join(', ')}`}><Form aria-label="Import library template" busy={busy} onSubmit={(_, event) => importLibrary(event)}><Text preserveWhitespace>{library.body}</Text>{library.language !== libraryLanguage && <Alert tone="info">The requested language was unavailable. Import will use {library.language}.</Alert>}{!library.importable && <Alert tone="warning">This library template needs advanced button inputs that are not available in this editor.</Alert>}{canWrite && library.importable && <><Field label="New template name" description="Lowercase letters, digits and underscores, starting with a letter."><Input required pattern="[a-z][a-z0-9_]*" value={templateName} onChange={event => { setTemplateName(event.target.value); setReviewed(false); }}/></Field>{library.buttons.map((button: any, index: number) => <Stack key={index} gap={2}><Text weight="medium">{button.text || 'Button'} · {button.type}</Text>{button.type !== 'quick_reply' && <Field label={button.type === 'url' ? 'Website URL' : 'International phone number'}><Input required type={button.type === 'url' ? 'url' : 'tel'} value={buttonInputs[index]?.[button.type === 'url' ? 'url' : 'phoneNumber'] || ''} onChange={event => { setButtonInputs(buttonInputs.map((input, position) => position === index ? { ...input, [button.type === 'url' ? 'url' : 'phoneNumber']: event.target.value } : input)); setReviewed(false); }}/></Field>}</Stack>)}<Field label="Custom delivery window in seconds (optional)"><Input type="number" value={ttlSeconds} onChange={event => { setTtlSeconds(event.target.value); setReviewed(false); }}/></Field><Checkbox checked={reviewed} onChange={event => setReviewed(event.target.checked)} label="I reviewed this template, returned language and button destinations."/><FormActions><Button variant="primary" type="submit" disabled={!reviewed}>Import library template</Button></FormActions></>}</Form></Card>}
      {selected && <Card as="section" title={`${selected.name} · ${selected.language}`} description={`${selected.category} · ${selected.status}${selected.quality ? ` · Quality: ${selected.quality}` : ''}`}><Stack gap={3}>
        {selected.rejectedReason && <Alert tone="danger" title="Rejected by Meta">{selected.rejectedReason}</Alert>}
        <DescriptionList items={[{ term: 'Delivery window', description: selected.ttlSeconds === null ? 'Provider category default' : `${selected.ttlSeconds} seconds` }]}/>
        <List>{selected.components.map((part, index) => <ListItem key={index}><Text preserveWhitespace>{part.text || part.type}{part.format ? ` (${part.format})` : ''}</Text>{part.buttons?.length > 0 && <List>{part.buttons.map((button: any, position: number) => <ListItem key={position}>{button.text || button.type}{button.url ? ` · ${button.url}` : button.phone_number ? ` · ${button.phone_number}` : ''}</ListItem>)}</List>}</ListItem>)}</List>
        <Text tone="muted">Templates belong to the WhatsApp business account and can be used across numbers and projects. An instance operator must review this scope before editing or deleting a variant, including templates created here.</Text>
        {canWrite && selected.canReviewShared && isOperator && <Checkbox checked={sharedReviewed} onChange={event => { setSharedReviewed(event.target.checked); setReviewed(false); setDeleteReviewed(false); }} label={`As an instance operator, I reviewed changes to variant ${selected.id} in shared business account ${wabaId}.`}/>}
      </Stack></Card>}
      {(mode === 'create' && canWrite || selected && canWrite && scopeReviewed && editable) && <Card as="section" title={selected ? 'Edit language variant' : 'Create template'}><Form aria-label={selected ? 'Edit language variant' : 'Create template'} busy={busy} onSubmit={(_, event) => save(event)}>{!selected && <FormGrid><Field label="Template name" description="Lowercase letters, digits and underscores, starting with a letter."><Input required pattern="[a-z][a-z0-9_]*" maxLength={512} value={templateName} onChange={event => { setTemplateName(event.target.value); setReviewed(false); }}/></Field><Field label="Language"><Input required value={templateLanguage} onChange={event => { setTemplateLanguage(event.target.value); setReviewed(false); }}/></Field><Field label="Category"><Select value={category} onChange={event => { setCategory(event.target.value); setTtlSeconds(''); setReviewed(false); }}><Option value="UTILITY">Utility</Option><Option value="MARKETING">Marketing</Option></Select></Field></FormGrid>}{selected && selected.form && selected.category !== 'AUTHENTICATION' && <Checkbox checked={editContent} onChange={event => { setEditContent(event.target.checked); setReviewed(false); }} label="Edit template content and submit it for review again."/>}{selected && (!selected.form || selected.category === 'AUTHENTICATION') && <Text tone="muted">Advanced content is readable here. Its delivery window can be edited separately.</Text>}{(!selected || editContent) && <TemplateContentEditor form={form} onChange={value => { setForm(value); setReviewed(false); }}/>}<Field label="Custom delivery window in seconds (optional)" description={`${category === 'MARKETING' ? '43,200–2,592,000' : category === 'AUTHENTICATION' ? '30–900' : '30–43,200'} seconds. Leave empty to ${selected ? 'keep the current window' : 'use the category default'}. A content edit starts another provider review.`}><Input type="number" step="1" value={ttlSeconds} onChange={event => { setTtlSeconds(event.target.value); setReviewed(false); }}/></Field><Checkbox checked={reviewed} onChange={event => setReviewed(event.target.checked)} label="I reviewed this language variant, content and delivery window."/><FormActions><Button variant="primary" type="submit" disabled={!reviewed || !!selected && !editContent && ttlSeconds === ''}>{selected ? 'Save template changes' : 'Submit template for review'}</Button></FormActions></Form></Card>}
      {selected && canWrite && scopeReviewed && <ReviewConfirm tone="danger" title="Delete this language variant" reviewKey={selected.id + ':' + selected.version} acknowledgements={[]} confirmLabel="Delete language variant" busy={busy} disabledReason={deleteReviewed ? undefined : 'Check the statement above to continue.'} onConfirm={remove}><Stack gap={2}><Text>Other languages stay available. Meta may keep a deleted variant pending deletion and prevent reuse of its name for 30 days.</Text><Checkbox checked={deleteReviewed} disabled={busy} onChange={event => setDeleteReviewed(event.target.checked)} label={`Delete ${selected.name} (${selected.language}), variant ${selected.id}.`}/></Stack></ReviewConfirm>}
    </>}
  </Stack></Card>;
}
