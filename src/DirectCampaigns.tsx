import React, { useEffect, useRef, useState } from 'react';
import { Alert, AudienceSummary, Badge, Button, Card, Checkbox, CheckboxGroup, ConfirmDialog, ContentPreview, CopyButton, DataTable, DateTimeField, DescriptionList, Disclosure, EmptyState, Field, Fieldset, Form, FormActions, FormGrid, Grid, Heading, Inline, Input, List, ListItem, LoadMore, OperationResults, Option, ReviewConfirm, SandboxedPreview, Select, Stack, StatusLine, Tabs, Text, Textarea, type OperationStatus } from '@ten98/ui';
import WhatsAppTemplate, { templateRestriction, templatePreviewText } from './WhatsAppTemplate';
import { useFocusReturn } from './focus-return';

// Provider deliverability reports that are not a recipient's own suppression, such as a Cloudflare policy block (#77).
type DeliverabilityAlert = { provider: string; kind: string; contacts: number; expiresAt: string | null };
const emailProviderName = (provider: string) => ({ cloudflare: 'Cloudflare', ses: 'Amazon SES' }[provider] || provider);
const emailProviderConsole = (provider: string) => ({ cloudflare: 'Cloudflare Email Sending', ses: 'the Amazon SES console' }[provider] || provider);
// SES `undetermined` feedback is a bounce SES could not classify; other kinds are sender-side policy blocks.
const deliverabilityCopy = (alert: DeliverabilityAlert) => alert.kind === 'undetermined' ? { title: `${emailProviderName(alert.provider)} could not classify bounces for ${alert.contacts} ${alert.contacts === 1 ? 'contact' : 'contacts'}`, body: `Check the bounce details in ${emailProviderConsole(alert.provider)}. Each one counts toward the repeated-bounce limit for that contact.` } : { title: `${emailProviderName(alert.provider)} reports a ${alert.kind} block for ${alert.contacts} ${alert.contacts === 1 ? 'contact' : 'contacts'}`, body: `It may concern your sending account, not the recipients, so they were not suppressed. Check ${emailProviderConsole(alert.provider)}.` };
// The status reports a null email provider when Amazon SES and Cloudflare are both configured and none is chosen (EMAIL_PROVIDER_REQUIRED).
const emailProviderChoice = 'Amazon SES and Cloudflare are both configured. Choose which one sends email under Amazon SES email in Integrations.';
const deliverabilityAlerts = (status: any): DeliverabilityAlert[] => (Array.isArray(status?.deliverabilityAlerts) ? status.deliverabilityAlerts : []).filter((row: any) => typeof row?.provider === 'string' && typeof row.kind === 'string' && Number.isSafeInteger(row.contacts) && row.contacts > 0 && (row.expiresAt === null || typeof row.expiresAt === 'string'));

type Row = { id: string; [key: string]: any };
type Channel = 'email' | 'sms' | 'whatsapp';
type Props = { projectId: string; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>; readOnly?: boolean; onOpenReplies?: (channel: 'sms' | 'whatsapp', accountId?: string, phone?: string) => void; onShortenText?: (text: string, campaignId?: string) => Promise<string>; onOpenIntegrations?: () => void };
type Draft = { name: string; channel: Channel; subject: string; text: string; html: string; accountId: string; templateName: string; templateLanguage: string; templateComponents: any[]; contactIds: string[]; tags: string[] };
const labels = { email: 'Email', sms: 'SMS', whatsapp: 'WhatsApp' };
const channels: Channel[] = ['email', 'sms', 'whatsapp'];
const split = (value = '') => [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))];
const blank = (): Draft => ({ name: '', channel: 'email', subject: '', text: '', html: '', accountId: '', templateName: '', templateLanguage: 'en', templateComponents: [], contactIds: [], tags: [] });
const contactBlank = () => ({ name: '', email: '', phone: '', company: '', tags: '', consents: { email: false, sms: false, whatsapp: false }, consentSource: '' });
function campaignDraft(campaign?: Row): Draft { return { ...blank(), ...Object.fromEntries(Object.keys(blank()).filter(key => campaign?.[key] !== undefined).map(key => [key, campaign![key]])) }; }
function campaignBody(draft: Draft, audienceMode: string) {
  const audience = { contactIds: audienceMode === 'contacts' ? draft.contactIds : [], tags: audienceMode === 'tags' ? draft.tags : [] };
  if (audienceMode === 'contacts' && !audience.contactIds.length) throw new Error('Choose at least one contact, or switch to all eligible contacts.');
  if (audienceMode === 'tags' && !audience.tags.length) throw new Error('Enter at least one audience tag, or switch to all eligible contacts.');
  return { name: draft.name, channel: draft.channel, ...audience, ...(draft.channel === 'email' ? { subject: draft.subject, text: draft.text, html: draft.html, emailPurpose: 'transactional' } : draft.channel === 'sms' ? { text: draft.text } : { accountId: draft.accountId, templateName: draft.templateName, templateLanguage: draft.templateLanguage, templateComponents: draft.templateComponents }) };
}
const when = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Not scheduled';
const contactName = (contact: any = {}) => contact.name || contact.email || contact.phone || contact.id || 'Contact';
const statusLabel = (value?: string) => ({ draft: 'Draft', scheduled: 'Scheduled', sending: 'Sending', completed: 'Completed', cancelled: 'Cancelled', attention: 'Needs attention', accepted: 'Accepted by provider', delivered: 'Delivered', failed: 'Failed', suppressed: 'Suppressed', pending: 'Queued', queued: 'Queued by provider', sent: 'Sent by provider', uncertain: 'Outcome needs review' }[value || ''] || value || 'Not reported');
const deliveryStatus = (value?: string): OperationStatus => ({ pending: 'pending', sending: 'pending', queued: 'pending', accepted: 'accepted', sent: 'accepted', delivered: 'delivered', read: 'observed', failed: 'error', undelivered: 'error', suppressed: 'suppressed', cancelled: 'skipped', skipped: 'skipped', uncertain: 'unknown' } as Record<string, OperationStatus>)[value || ''] || 'unknown';
// SMS tests go to one contact with recorded SMS permission (the server checks again); email tests go only to the signed-in user.
// A provider's temporary suppression stops holding the contact once it expires (server/contacts.ts activeSuppression).
const suppressed = (person: Row, channel: string) => { const entry = person.suppression?.[channel]; return entry && !(entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) ? entry : null; };
const smsTestContacts = (people: Row[]) => people.filter(person => person.phone && person.consents?.sms && !person.suppression?.sms);
const testSendErrors: Record<string, string> = {
  SEND_CONFIRMATION_REQUIRED: 'Confirm the test send before it is sent.',
  INVALID_TEST_RECIPIENT: 'Choose a contact with recorded SMS permission and a valid phone number.',
  INVALID_TEST_SEND: 'The test send was not accepted. Refresh the campaign and try again.',
  TEST_SEND_UNSUPPORTED: 'Test sends are available for email and SMS drafts only.',
  CAMPAIGN_LOCKED: 'Only a draft can send a test. Refresh the campaign to see its current status.',
  INTEGRATION_NOT_CONFIGURED: 'Configure this sending provider in Integrations before sending a test.',
  EMAIL_PROVIDER_REQUIRED: emailProviderChoice,
  PUBLIC_URL_REQUIRED: 'Sending needs a public address. The instance operator must set APP_URL to this app’s public HTTPS address.',
  TEST_SEND_LIMIT: 'This project has sent 10 tests in the last hour. Try again later.',
};
const testSendError = (failure: any) => (typeof failure?.code === 'string' && Object.hasOwn(testSendErrors, failure.code) ? testSendErrors[failure.code] : failure?.message) || 'The test could not be sent. Try again.';

export default function DirectCampaigns({ projectId, request, readOnly = false, onOpenReplies, onShortenText, onOpenIntegrations }: Props) {
  const path = `/projects/${encodeURIComponent(projectId)}/direct`, requester = useRef(request), version = useRef(0), csvRead = useRef(0), pending = useRef(false), actionVersion = useRef(0), formRef = useRef<HTMLFormElement>(null);
  requester.current = request;
  const [tab, setTab] = useState('campaigns'), [status, setStatus] = useState<any>(null), [campaigns, setCampaigns] = useState<Row[]>([]), [contacts, setContacts] = useState<Row[]>([]);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [editingId, setEditingId] = useState(''), [draft, setDraft] = useState<Draft>(blank), [audienceMode, setAudienceMode] = useState('all');
  const [detail, setDetail] = useState<any>(null), [preview, setPreview] = useState<{ signature: string; result: any } | null>(null), [templates, setTemplates] = useState<any[]>([]), [templateAccount, setTemplateAccount] = useState('');
  const [confirmationMode, setConfirmationMode] = useState(''), [confirmed, setConfirmed] = useState(false), [transactionalConfirmed, setTransactionalConfirmed] = useState(false), [scheduledAt, setScheduledAt] = useState('');
  const [search, setSearch] = useState(''), [contactEditId, setContactEditId] = useState(''), [contact, setContact] = useState(contactBlank), [csv, setCsv] = useState(''), [importConsent, setImportConsent] = useState({ email: false, sms: false, whatsapp: false }), [importSource, setImportSource] = useState(''), [importResult, setImportResult] = useState<any>(null);
  const [suppression, setSuppression] = useState<{ id: string; channel: Channel; reason: string } | null>(null);
  const [audienceTags, setAudienceTags] = useState('');
  const [confirmingCancel, setConfirmingCancel] = useState(false), [deliveryLimit, setDeliveryLimit] = useState({ id: '', count: 50 });
  const [testContactId, setTestContactId] = useState(''), [confirmingTest, setConfirmingTest] = useState(false), [testSend, setTestSend] = useState<{ campaignId: string; result?: any; error?: string } | null>(null);
  const latestDraft = useRef({ draft, editingId }); latestDraft.current = { draft, editingId };
  const signature = JSON.stringify({ editingId, draft, audienceMode }), current = campaigns.find(item => item.id === editingId), editable = !current || current.status === 'draft';
  const testable = !readOnly && current?.status === 'draft' && (current.channel === 'email' || current.channel === 'sms');
  const retryCancellation = current?.status === 'cancelled' && current.channel === 'whatsapp' && !!current.providerId && current.providerStatus !== 'cancelled' && !!current.lastError;
  const validPreview = preview?.signature === signature ? preview.result : null, ready = !readOnly && editable && !!current && !!validPreview?.previewToken && validPreview?.audience?.eligible > 0 && validPreview.audience.eligible <= 500 && !!status?.providers?.[draft.channel] && status?.publicCallbacks === true;
  const visibleContacts = contacts.filter(item => !search || [item.name, item.email, item.phone, item.company, ...(item.tags || []), ...(item.identities || []).map((identity: Row) => identity.participantId)].some(value => String(value || '').toLowerCase().includes(search.toLowerCase())));
  const selectedTemplate = templateAccount === draft.accountId ? templates.find(item => item.name === draft.templateName && (item.language || item.languageCode) === draft.templateLanguage) : null;

  async function load(generation = version.current) {
    const results = await Promise.allSettled([requester.current(path + '/status'), requester.current(path + '/campaigns'), requester.current(path + '/contacts')]);
    if (generation !== version.current) return;
    const failures = [];
    if (results[0].status === 'fulfilled') setStatus(results[0].value); else { setStatus(null); failures.push('Connection status: ' + (results[0].reason.message || 'unavailable')); }
    if (results[1].status === 'fulfilled' && Array.isArray(results[1].value.campaigns)) setCampaigns(results[1].value.campaigns); else failures.push('Campaign list could not be refreshed.');
    if (results[2].status === 'fulfilled' && Array.isArray(results[2].value.contacts)) setContacts(results[2].value.contacts); else failures.push('Contact list could not be refreshed.');
    if (failures.length) throw new Error(failures.join(' '));
  }
  useEffect(() => {
    const generation = ++version.current; pending.current = false; setBusy('Loading'); setError(''); setNotice(''); setStatus(null); setCampaigns([]); setContacts([]); setEditingId(''); setDraft(blank()); setAudienceMode('all'); setAudienceTags(''); setDetail(null); setPreview(null); setTemplates([]); setTemplateAccount(''); setContactEditId(''); setContact(contactBlank()); setCsv(''); setImportConsent({ email: false, sms: false, whatsapp: false }); setImportSource(''); setImportResult(null); setSuppression(null); setSearch(''); setScheduledAt('');
    load(generation).catch(failure => { if (generation === version.current) setError(failure.message); }).finally(() => { if (generation === version.current) setBusy(''); });
    return () => { version.current++; };
  }, [projectId]);
  useEffect(() => { setConfirmationMode(''); setConfirmed(false); setTransactionalConfirmed(false); }, [signature]);
  useEffect(() => {
    const campaign = detail?.campaign;
    if (!campaign?.id || !['scheduled', 'sending'].includes(campaign.status)) return;
    const generation = version.current; let closed = false, loading = false;
    const refreshProgress = async () => {
      if (loading || pending.current) return; loading = true; const revision = actionVersion.current;
      try { const result = await requester.current(path + '/campaigns/' + encodeURIComponent(campaign.id)); if (!closed && generation === version.current && revision === actionVersion.current) { acceptCampaign(result.campaign, generation); setDetail(result); } }
      catch { /* The explicit refresh remains available if a local progress request fails. */ }
      finally { loading = false; }
    };
    const timer = window.setInterval(refreshProgress, 4000); return () => { closed = true; window.clearInterval(timer); };
  }, [path, detail?.campaign?.id, detail?.campaign?.status]);
  const rememberFocus = useFocusReturn(busy);
  async function action(label: string, run: (generation: number) => Promise<void>) {
    if (pending.current) return; rememberFocus(); const generation = version.current; pending.current = true; actionVersion.current++; setBusy(label); setError(''); setNotice('');
    try { await run(generation); } catch (failure) { if (generation === version.current) setError((failure as any)?.code === 'EMAIL_PROVIDER_REQUIRED' ? emailProviderChoice : (failure as Error).message || 'This action could not be completed.'); }
    finally { if (generation === version.current) { pending.current = false; setBusy(''); } }
  }
  function acceptCampaign(campaign: Row, generation: number) {
    if (generation !== version.current) return;
    setCampaigns(previous => previous.some(item => item.id === campaign.id) ? previous.map(item => item.id === campaign.id ? campaign : item) : [campaign, ...previous]);
    setDetail((previous: any) => ({ ...(previous?.campaign?.id === campaign.id ? previous : {}), campaign }));
  }
  function openDraft(campaign?: Row) {
    setEditingId(campaign?.id || ''); setDraft(campaignDraft(campaign)); setAudienceMode(campaign?.contactIds?.length ? 'contacts' : campaign?.tags?.length ? 'tags' : 'all'); setAudienceTags((campaign?.tags || []).join(', ')); setScheduledAt(''); setPreview(null); setDetail(campaign ? { campaign } : null); setTemplates([]); setTemplateAccount(''); setError('');
  }
  async function saveDraft(generation: number) {
    if (readOnly || !editable) throw new Error('Create or edit a draft before saving.');
    const body = campaignBody(draft, audienceMode), result = await requester.current(path + '/campaigns' + (editingId ? '/' + encodeURIComponent(editingId) : ''), editingId ? 'PATCH' : 'POST', body);
    if (generation !== version.current) return null;
    acceptCampaign(result.campaign, generation); setEditingId(result.campaign.id); setNotice('Campaign draft saved. No messages have been sent.'); return result.campaign as Row;
  }
  async function save(event: React.FormEvent<HTMLFormElement>) { event.preventDefault(); await action('Saving draft', async generation => { await saveDraft(generation); }); }
  async function checkAudience() {
    if (!formRef.current?.reportValidity()) return;
    if (draft.channel === 'whatsapp' && (!selectedTemplate || templateRestriction(selectedTemplate))) { setError(selectedTemplate ? templateRestriction(selectedTemplate) : 'Load the approved template and check its values before reviewing the audience.'); return; }
    await action('Checking audience', async generation => {
      const campaign = await saveDraft(generation); if (!campaign || generation !== version.current) return;
      const result = await requester.current(path + '/campaigns/' + encodeURIComponent(campaign.id) + '/preview', 'POST', {});
      if (generation !== version.current) return;
      acceptCampaign(result.campaign || campaign, generation); setPreview({ signature: JSON.stringify({ editingId: campaign.id, draft, audienceMode }), result }); setNotice('Audience and content checked. Sending remains a separate action.');
    });
  }
  async function openCampaign(campaign: Row) {
    await action('Loading campaign', async generation => {
      const result = await requester.current(path + '/campaigns/' + encodeURIComponent(campaign.id)); if (generation !== version.current) return;
      openDraft(result.campaign); acceptCampaign(result.campaign, generation); setDetail(result);
    });
  }
  async function loadTemplates() {
    if (!draft.accountId) return;
    const accountId = draft.accountId;
    await action('Loading templates', async generation => {
      const result = await requester.current(path + '/templates?accountId=' + encodeURIComponent(accountId)); if (generation !== version.current) return;
      setTemplates((result.templates || []).filter((item: any) => String(item.status || '').toLowerCase() === 'approved')); setTemplateAccount(accountId); setNotice('Approved templates loaded. Choose the language and fill every required value.');
    });
  }
  async function send(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!ready || !confirmed || !['send', 'schedule'].includes(confirmationMode) || draft.channel === 'email' && !transactionalConfirmed) return;
    const campaignId = editingId, mode = confirmationMode;
    const sendTime = Date.parse(scheduledAt);
    if (mode === 'schedule' && (!Number.isFinite(sendTime) || sendTime <= Date.now() || sendTime > Date.now() + 366 * 86400000)) { setError('Choose a future send time within the next 366 days.'); return; }
    const body = { confirmed: true, previewToken: validPreview.previewToken, ...(draft.channel === 'email' ? { transactionalConfirmed: true } : {}), ...(mode === 'schedule' ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}) };
    await action(mode === 'schedule' ? 'Scheduling campaign' : 'Sending campaign', async generation => {
      let result;
      try { result = await requester.current(path + '/campaigns/' + encodeURIComponent(campaignId) + '/' + (mode === 'schedule' ? 'schedule' : 'send'), 'POST', body); }
      catch (failure) { if (generation === version.current) { setPreview(null); setConfirmationMode(''); const latest = await requester.current(path + '/campaigns/' + encodeURIComponent(campaignId)).catch(() => null); if (latest && generation === version.current) { acceptCampaign(latest.campaign, generation); setDetail(latest); } } throw failure; }
      if (generation !== version.current) return;
      acceptCampaign(result.campaign, generation); setDetail(result); setPreview(null); setConfirmationMode(''); setNotice(mode === 'schedule' ? 'Campaign scheduled. Only eligible contacts will be sent messages when it runs.' : 'Campaign send started. Provider acceptance and delivery are reported separately.');
    });
  }
  async function campaignAction(kind: string) {
    if (!current) return;
    await action(kind === 'cancel' ? 'Cancelling remaining messages' : 'Refreshing delivery', async generation => {
      const result = await requester.current(path + '/campaigns/' + encodeURIComponent(current.id) + '/' + kind, 'POST', {}); if (generation !== version.current) return;
      acceptCampaign(result.campaign, generation); setDetail(result); setNotice(kind === 'cancel' ? 'Cancellation recorded. Check the delivery counts for messages already accepted.' : 'Campaign delivery status refreshed.');
    });
  }
  function editContact(item?: Row) {
    setContactEditId(item?.id || ''); setContact({ ...contactBlank(), ...Object.fromEntries(['name', 'email', 'phone', 'company', 'consentSource'].filter(key => item?.[key]).map(key => [key, item![key]])), tags: (item?.tags || []).join(', '), consents: { email: !!item?.consents?.email, sms: !!item?.consents?.sms, whatsapp: !!item?.consents?.whatsapp } });
  }
  async function saveContact(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (readOnly) return;
    await action('Saving contact', async generation => {
      const result = await requester.current(path + '/contacts' + (contactEditId ? '/' + encodeURIComponent(contactEditId) : ''), contactEditId ? 'PATCH' : 'POST', { ...contact, tags: split(contact.tags) }); if (generation !== version.current) return;
      setContacts(previous => previous.some(item => item.id === result.contact.id) ? previous.map(item => item.id === result.contact.id ? result.contact : item) : [result.contact, ...previous]); editContact(contactEditId ? result.contact : undefined); setNotice('Contact saved. Permission is tracked separately for each channel.');
    });
  }
  // A test sends the last saved draft to one recipient and leaves the draft unchanged. Each confirmed click gets a new key,
  // so it is a separate provider request; the server allows 10 per project per hour.
  async function sendTest() {
    const campaign = current, contactId = testContactId;
    if (readOnly || campaign?.status !== 'draft' || !['email', 'sms'].includes(campaign.channel) || campaign.channel === 'sms' && !smsTestContacts(contacts).some(person => person.id === contactId)) return;
    await action('Sending test', async generation => {
      try {
        const result = await requester.current(path + '/campaigns/' + encodeURIComponent(campaign.id) + '/test', 'POST', { confirmed: true, ...(campaign.channel === 'sms' ? { contactId } : {}) }, crypto.randomUUID());
        if (generation === version.current) setTestSend({ campaignId: campaign.id, result: result.test });
      } catch (failure) { if (generation === version.current) setTestSend({ campaignId: campaign.id, error: testSendError(failure) }); }
    });
  }
  async function importContacts(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (readOnly || !csv.trim()) return;
    const dryRun = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'preview';
    await action(dryRun ? 'Checking import' : 'Importing contacts', async generation => {
      const result = await requester.current(path + '/contacts/import', 'POST', { csv, consents: importConsent, consentSource: importSource, ...(dryRun ? { dryRun: true } : {}) }); if (generation !== version.current) return;
      setImportResult({ ...result, dryRun }); if (dryRun) { setNotice('Import checked. No contact records have been changed.'); return; }
      setNotice(`Processed ${result.imported || 0} rows: ${result.created || 0} created, ${result.updated || 0} merged, ${result.skipped || 0} skipped. Review contact hygiene before sending.`);
      const people = await requester.current(path + '/contacts'); if (generation !== version.current) return; setContacts(people.contacts);
    });
  }
  async function readCsv(event: React.ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget, file = input.files?.[0], read = ++csvRead.current; input.value = ''; if (!file) return;
    if (file.size > 1024 * 1024) { setError('Choose a CSV file of at most 1 MB.'); return; }
    const generation = version.current; setCsv(''); setImportResult(null); setError('');
    try { const text = await file.text(); if (generation === version.current && read === csvRead.current) { setCsv(text); setImportResult(null); } } catch { if (generation === version.current && read === csvRead.current) setError('This CSV file could not be read.'); }
  }
  async function suppress(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!suppression || readOnly) return;
    const selected = suppression;
    await action('Suppressing contact', async generation => { const result = await requester.current(path + '/contacts/' + encodeURIComponent(selected.id) + '/suppress', 'POST', { channel: selected.channel, reason: selected.reason }); if (generation !== version.current) return; setContacts(previous => previous.map(item => item.id === result.contact.id ? result.contact : item)); setSuppression(null); setNotice('Contact suppressed for this channel. Imports and consent edits do not remove this suppression.'); });
  }
  async function checkDns() {
    const emailContacts = visibleContacts.filter(item => item.email), unchecked = emailContacts.filter(item => !item.hygiene?.dnsStatus || item.hygiene.dnsStatus === 'unchecked'), ids = (unchecked.length ? unchecked : emailContacts).slice(0, 50).map(item => item.id);
    await action('Checking email domains', async generation => { const result = await requester.current(path + '/contacts/assess-dns', 'POST', { ids }); if (generation !== version.current) return; const updates = new Map((result.contacts || []).map((item: Row) => [item.id, item])); setContacts(previous => previous.map(item => updates.get(item.id) as Row || item)); setNotice(`Checked ${result.checked || 0} email domains. A mail server record does not confirm that a mailbox exists.`); });
  }
  async function shortenText() {
    if (!onShortenText || readOnly || !editable || !['email', 'sms'].includes(draft.channel)) return;
    if (!editingId) { setNotice('Save this draft first so its short links appear in the campaign report.'); return; }
    const text = draft.text, id = editingId, channel = draft.channel;
    await action('Creating short links', async generation => { const shortened = await onShortenText(text, id); if (generation !== version.current) return; if (latestDraft.current.editingId !== id || latestDraft.current.draft.channel !== channel || latestDraft.current.draft.text !== text) { setNotice('Short links created, but the message changed. Copy the links from Links & tracking to keep your newer text.'); return; } setDraft(previous => ({ ...previous, text: shortened })); setNotice('Eligible message links shortened. Review the message and check its audience again before sending.'); });
  }
  function openReplies(campaign: Row, phone?: string) { if (campaign.channel === 'sms' || campaign.channel === 'whatsapp') onOpenReplies?.(campaign.channel, campaign.channel === 'whatsapp' ? campaign.accountId : undefined, phone); }


  const deliveries: any[] = detail?.deliveries || [], deliveriesShown = deliveryLimit.id === current?.id ? deliveryLimit.count : 50, replies = !!onOpenReplies && ['sms', 'whatsapp'].includes(current?.channel);
  const testRecipients = smsTestContacts(contacts), testRecipient = testRecipients.find(person => person.id === testContactId), shownTest = testSend?.campaignId === current?.id ? testSend : null;
  // Without a configured provider for the draft's channel the server refuses the test (INTEGRATION_NOT_CONFIGURED). An unknown status leaves the check to the server.
  const testProviderReady = !status || !!status.providers?.[current?.channel], testProviderReason = current?.channel === 'email' && status?.emailProvider === null ? emailProviderChoice : `Set up ${labels[current?.channel as Channel] || 'this'} sending in Integrations to send a test.`;
  const integrationsAction = onOpenIntegrations ? <Button variant="secondary" size="sm" onClick={onOpenIntegrations}>Open integrations</Button> : undefined;
  return <Stack gap={6}>
    <Inline justify="between" align="center"><Stack gap={1}><Heading level={2}>Direct campaigns</Heading><Text tone="muted">Manage permission-based email, SMS and approved WhatsApp template campaigns with one contact list.</Text></Stack><Button variant="secondary" disabled={!!busy} onClick={() => action('Refreshing campaigns', async generation => { await load(generation); })}>Refresh lists</Button></Inline>
    {error && <Alert tone="danger" actions={error === emailProviderChoice ? integrationsAction : undefined}>{error}</Alert>}{notice && <StatusLine tone="success">{notice}</StatusLine>}{busy && <StatusLine busy>{busy}…</StatusLine>}
    {deliverabilityAlerts(status).map(alert => { const copy = deliverabilityCopy(alert); return <Alert key={alert.provider + ':' + alert.kind} tone="warning" title={copy.title}>{copy.body}{alert.expiresAt ? ` The provider lists it until ${new Date(alert.expiresAt).toLocaleString()}.` : ''}</Alert>; })}
    {status?.emailProvider === 'ses' && typeof status.sesWebhookUrl === 'string' && status.sesWebhookUrl && <Disclosure summary="Amazon SES feedback webhook"><Stack gap={2}><Field label="SNS subscription URL" description="Subscribe the SNS topic of your SES configuration set to this URL over HTTPS so bounces and complaints update your contacts."><Input readOnly value={status.sesWebhookUrl}/></Field><Inline><CopyButton value={status.sesWebhookUrl} label="Copy webhook URL" messages={{ copied: 'Webhook URL copied.' }}/></Inline></Stack></Disclosure>}
    {status?.accountError && <Alert tone="warning" variant="inline">WhatsApp accounts could not be loaded: {status.accountError}. Email and SMS remain available when configured.</Alert>}
    {status?.publicCallbacks === false && <Alert tone="warning" title="Sending needs a public address">Before sending, the instance operator must set APP_URL to this app’s public HTTPS address and restart the service. Unsubscribe links and delivery updates need that address. Drafts and contacts can be saved now.</Alert>}
    <Tabs label="Direct campaign sections" value={tab} onValueChange={setTab} keepMounted={false} items={[{ value: 'campaigns', label: <>Campaigns <Badge>{campaigns.length}</Badge></>, content: <Stack gap={6}>
      <Card as="section" title="Your campaigns" description="Drafts stay local until you explicitly send or schedule them." actions={!readOnly && <Button variant="primary" disabled={!!busy} onClick={() => openDraft()}>New campaign</Button>}>
        <DataTable searchable={false} sortable={false} pagination={false} ariaLabel="Direct campaigns" rows={campaigns} rowKey={campaign => campaign.id} emptyState={<EmptyState title="No direct campaigns yet" description="Create a draft, choose eligible contacts, and check the audience before sending."/>} columns={[{ key: 'name', header: 'Campaign', rowHeader: true, render: campaign => <Text as="strong" weight="semibold">{campaign.name}</Text> }, { key: 'channel', header: 'Channel', render: campaign => labels[campaign.channel as Channel] || campaign.channel }, { key: 'status', header: 'Status', render: campaign => statusLabel(campaign.status) }, { key: 'scheduledAt', header: 'Planned time', render: campaign => when(campaign.scheduledAt) }]} rowActionsLabel="Actions" rowActions={campaign => <Inline gap={2}><Button variant="secondary" size="sm" disabled={!!busy} onClick={() => openCampaign(campaign)}>{campaign.status === 'draft' && !readOnly ? 'Edit draft' : 'View campaign'}</Button>{onOpenReplies && ['sms', 'whatsapp'].includes(campaign.channel) && <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => openReplies(campaign)}>Open replies</Button>}</Inline>}/>
      </Card>
      {(!readOnly || editingId) && <Card as="section" title={current ? current.name : 'New direct campaign'} description={<>{current ? statusLabel(current.status) : 'Draft'}{current?.scheduledAt ? ` · ${when(current.scheduledAt)}` : ''}</>} actions={current && !readOnly && <Button variant="secondary" disabled={!!busy} onClick={() => { openDraft({ ...current, id: '', name: current.name + ' copy' }); setDetail(null); }}>Duplicate as draft</Button>}><Stack gap={6}>
        <Form ref={formRef} onSubmit={(_, event) => save(event)}><Stack as="fieldset" gap={4} disabled={!!busy || readOnly || !editable}>
          <FormGrid><Field label="Campaign name" required><Input required maxLength={120} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })}/></Field><Field label="Channel"><Select value={draft.channel} onChange={event => setDraft({ ...draft, channel: event.target.value as Channel })}>{channels.map(channel => <Option value={channel} key={channel}>{labels[channel]}</Option>)}</Select></Field></FormGrid>
          {status && (draft.channel === 'email' && status.emailProvider === null ? <Alert tone="warning" variant="inline" actions={editable && !readOnly ? integrationsAction : undefined}>{emailProviderChoice} You can save drafts and contacts meanwhile.</Alert> : status.providers?.[draft.channel] ? <StatusLine tone="success">{draft.channel === 'email' && status.emailProvider ? `Email sends through ${emailProviderName(status.emailProvider)}.` : `${labels[draft.channel]} provider configured.`}</StatusLine> : <Alert tone="warning" variant="inline">{labels[draft.channel]} sending is not configured. You can save drafts and contacts while the provider is being set up.</Alert>)}
          {draft.channel === 'email' ? <>
            <Alert tone="info" variant="inline" title="Transactional email">This sender is for account notices, receipts and other expected service messages. Marketing newsletters and promotional email need a marketing provider.</Alert>
            <Field label="Email subject" required><Input required maxLength={200} value={draft.subject} onChange={event => setDraft({ ...draft, subject: event.target.value })}/></Field>
            <Field label="Plain-text email" required><Textarea required rows={6} maxLength={100000} value={draft.text} onChange={event => setDraft({ ...draft, text: event.target.value })}/></Field>
            <Disclosure summary="HTML email (optional)"><Stack gap={3}><Field label="Email HTML"><Textarea rows={6} maxLength={200000} value={draft.html} onChange={event => setDraft({ ...draft, html: event.target.value })}/></Field>{draft.html && <SandboxedPreview title="Email HTML preview" html={draft.html} notice="External images, links and scripts are blocked in this preview."/>}</Stack></Disclosure>
          </> : draft.channel === 'sms' ? <>
            <Field label="SMS message" required description="The audience check reports encoding and billable SMS segments." count={{ value: draft.text, max: 1500 }}><Textarea required rows={5} maxLength={1500} value={draft.text} onChange={event => setDraft({ ...draft, text: event.target.value })}/></Field>
            <ContentPreview label="SMS preview" destination="Recipient" provider="SMS" chrome="message" text={draft.text || undefined} emptyMessage="Your message will appear here."/>
          </> : <>
            <Field label="Connected WhatsApp account" required><Select required value={draft.accountId} onChange={event => { setDraft({ ...draft, accountId: event.target.value, templateName: '', templateComponents: [] }); setTemplates([]); setTemplateAccount(''); }}><Option value="">Choose an account</Option>{(status?.accounts || []).map((account: any) => <Option key={account.id || account._id} value={account.id || account._id}>{account.name || account.displayName || account.username || account.id || account._id}</Option>)}</Select></Field>
            <Inline><Button variant="secondary" disabled={!!busy || !draft.accountId} onClick={loadTemplates}>Load approved templates</Button></Inline>
            <FormGrid><Field label="Approved template" required><Select required value={draft.templateName ? draft.templateName + ':' + draft.templateLanguage : ''} onChange={event => { const chosen = templates.find(item => `${item.name}:${item.language || item.languageCode}` === event.target.value); setDraft({ ...draft, templateName: chosen?.name || '', templateLanguage: chosen?.language || chosen?.languageCode || 'en', templateComponents: [] }); }}><Option value="">Choose a template</Option>{draft.templateName && !templates.some(item => item.name === draft.templateName && (item.language || item.languageCode) === draft.templateLanguage) && <Option value={draft.templateName + ':' + draft.templateLanguage}>{draft.templateName} · {draft.templateLanguage} (saved; verify before sending)</Option>}{templates.map(item => <Option key={item.name + ':' + (item.language || item.languageCode)} disabled={!!templateRestriction(item)} value={item.name + ':' + (item.language || item.languageCode)}>{item.name} · {item.language || item.languageCode}{templateRestriction(item) ? ' · Unsupported components' : ''}</Option>)}</Select></Field><Field label="Template language"><Input value={draft.templateLanguage} readOnly/></Field></FormGrid>
            {selectedTemplate && <WhatsAppTemplate template={selectedTemplate} components={draft.templateComponents} onChange={templateComponents => setDraft({ ...draft, templateComponents })}/>}
            <Text tone="muted" size="sm">Template values are shared by every recipient. Approved text values, image/video/document headers and website-button suffixes are supported. Header files must use direct public HTTPS links: JPEG/PNG images up to 5 MB; MP4/3GPP video up to 16 MB with H.264/AAC; documents up to 100 MB. Drive preview links cannot be sent. Flows, carousels and named variables require a separate provider workflow. WhatsApp permission and an international phone number are required.</Text>
          </>}
          {onShortenText && draft.channel !== 'whatsapp' && <Stack gap={1}><Inline><Button variant="secondary" disabled={!!busy || readOnly || !editable || !editingId || !draft.text.trim()} onClick={shortenText}>Use short links in message</Button></Inline>{!editingId && <Text tone="muted" size="sm">Save this draft first to associate short links with its campaign report.</Text>}</Stack>}{draft.channel !== 'whatsapp' && <Text tone="muted" size="sm">Personalisation fields: {'{{name}}, {{email}}, {{phone}}, {{company}}'}. URLs containing these fields stay unchanged when shortening. The audience preview uses the first eligible contact. SMS includes an opt-out footer.</Text>}
          <Fieldset legend="Audience" description="The audience check excludes contacts without channel permission, missing or invalid addresses, and suppressions. Permission and suppression are checked again when sending.">
            <Field label="Recipients"><Select value={audienceMode} onChange={event => setAudienceMode(event.target.value)}><Option value="all">All eligible contacts in this project</Option><Option value="tags">Contacts matching tags</Option><Option value="contacts">Choose contacts</Option></Select></Field>
            {audienceMode === 'tags' && <Field label="Audience tags" required><Input required value={audienceTags} onChange={event => { setAudienceTags(event.target.value); setDraft({ ...draft, tags: split(event.target.value) }); }} placeholder="customers, event-attendees"/></Field>}
            {audienceMode === 'contacts' && (contacts.length ? <CheckboxGroup legend="Contacts to message" maxHeight="md" value={draft.contactIds} onValueChange={contactIds => setDraft({ ...draft, contactIds })} options={contacts.map(person => ({ value: person.id, label: contactName(person), description: `${person.email || person.phone || ''}${!person.consents?.[draft.channel] ? ' · No channel permission' : person.suppression?.[draft.channel] ? ' · Suppressed' : ''}` }))}/> : <Text tone="muted">Add contacts in the Contacts tab first.</Text>)}
          </Fieldset>
          <FormActions><Button variant="primary" type="submit" disabled={!!busy || readOnly || !editable}>Save draft</Button><Button variant="secondary" disabled={!!busy || readOnly || !editable} onClick={checkAudience}>Save and check audience</Button></FormActions>
        </Stack></Form>
        {!readOnly && current?.status === 'draft' && <Stack as="section" gap={3}><Heading level={4}>Test send</Heading>
          {testable ? <>
            <Text tone="muted" size="sm">{current.channel === 'email' ? 'Sends the last saved version of this draft to your own email address only.' : 'Sends the last saved version of this draft to one contact with recorded SMS permission. Your SMS provider may charge for it.'} The draft and its audience stay unchanged. A project can send 10 tests per hour.</Text>
            {current.channel === 'sms' && (testRecipients.length ? <Field label="Test recipient" required><Select required value={testRecipient ? testContactId : ''} onChange={event => setTestContactId(event.target.value)}><Option value="">Choose a contact</Option>{testRecipients.map(person => <Option key={person.id} value={person.id}>{contactName(person)} · {person.phone}</Option>)}</Select></Field> : <Text tone="muted" size="sm">Record SMS permission for a contact in the Contacts tab to send a test.</Text>)}
            {!testProviderReady && <Inline gap={2} align="center"><Text tone="muted" size="sm">{testProviderReason}</Text>{integrationsAction}</Inline>}
            <Inline><Button variant="secondary" disabled={!!busy || !testProviderReady || current.channel === 'sms' && !testRecipient} onClick={() => setConfirmingTest(true)}>{current.channel === 'sms' ? 'Send test SMS' : 'Send test email'}</Button></Inline>
            {shownTest?.error && <Alert tone="danger" variant="inline" actions={shownTest.error === emailProviderChoice || shownTest.error === testSendErrors.INTEGRATION_NOT_CONFIGURED ? integrationsAction : undefined}>{shownTest.error}</Alert>}
            {shownTest?.result && <StatusLine tone={deliveryStatus(shownTest.result.status) === 'error' ? 'danger' : 'success'}>Test to {shownTest.result.recipient || 'the test recipient'}: {statusLabel(shownTest.result.status)}{shownTest.result.providerId ? ` · Provider reference ${shownTest.result.providerId}` : ''}</StatusLine>}
            <ConfirmDialog open={confirmingTest} onOpenChange={setConfirmingTest} title={current.channel === 'sms' ? 'Send test SMS?' : 'Send test email?'} description={`Send the last saved version of “${current.name}” to ${current.channel === 'sms' ? `${contactName(testRecipient)} (${testRecipient?.phone || 'no phone number'})` : 'your own email address'}. The draft stays unchanged.`} confirmLabel={current.channel === 'sms' ? 'Send test SMS' : 'Send test email'} acknowledgement={current.channel === 'sms' ? 'I understand the SMS provider may charge for this test message.' : undefined} onConfirm={sendTest}/>
          </> : <Text tone="muted" size="sm">Test sends are available for email and SMS drafts.</Text>}
        </Stack>}
        {validPreview && <Stack as="section" gap={4}>
          <AudienceSummary title="Audience readiness" scope={audienceMode === 'contacts' ? 'Chosen contacts' : audienceMode === 'tags' ? 'Contacts matching tags' : 'All contacts in this project'} channel={labels[draft.channel]} purpose={draft.channel === 'email' ? 'Transactional email' : 'Direct campaign'} counts={{ total: validPreview.audience?.total ?? null, eligible: validPreview.audience?.eligible ?? null, excluded: validPreview.audience?.excluded ?? null, unverified: validPreview.audience?.unverified ?? null }}/>
          {validPreview.audience?.unverified > 0 && <Alert tone="warning" variant="inline">{validPreview.audience.unverified} eligible email address{validPreview.audience.unverified === 1 ? " has" : "es have"} an unchecked or unavailable domain result. Check email domains in Contacts before sending. Domain checks do not verify individual mailboxes.</Alert>}
          {validPreview.sms && <Text>{validPreview.sms.encoding} · {validPreview.sms.segments} segment{validPreview.sms.segments === 1 ? '' : 's'} in this sample · {validPreview.sms.totalSegments} estimated total segments · {validPreview.sms.units} encoding units in this sample</Text>}
          <ContentPreview label={`${labels[draft.channel]} preview`} destination={validPreview.sample?.subject || labels[draft.channel] + ' preview'} provider={draft.channel === 'email' ? 'Plain-text version' : labels[draft.channel]} chrome={draft.channel === 'email' ? 'card' : 'message'} text={draft.channel === 'whatsapp' ? templatePreviewText(selectedTemplate, draft.templateComponents) || 'Load the saved template to see its text.' : validPreview.sample?.text || 'No plain text was returned.'}/>
          {validPreview.sample?.html && <SandboxedPreview title="Email HTML preview" html={validPreview.sample.html} notice="External images, links and scripts are blocked in this preview."/>}
          {validPreview.audience?.exclusions?.length > 0 && <Disclosure summary="Why contacts were excluded"><List>{validPreview.audience.exclusions.map((item: any, index: number) => <ListItem key={item.id || index}>{item.name || item.id || 'Contact'}: {item.reason}</ListItem>)}</List></Disclosure>}
          {!readOnly && <FormActions><Button variant="primary" disabled={!!busy || !ready} onClick={() => setConfirmationMode('send')}>Prepare send</Button><Button variant="secondary" disabled={!!busy || !ready} onClick={() => setConfirmationMode('schedule')}>Schedule campaign</Button></FormActions>}
        </Stack>}
        {confirmationMode && ready && <ReviewConfirm title={confirmationMode === 'schedule' ? 'Schedule this campaign' : 'Confirm campaign send'} reviewKey={signature} acknowledgements={[]} confirmLabel={confirmationMode === 'schedule' ? 'Confirm schedule' : 'Send campaign now'} onConfirm={() => send({ preventDefault() {} } as React.FormEvent<HTMLFormElement>)} onCancel={() => setConfirmationMode('')} cancelLabel="Back to review" busy={!!busy} disabledReason={!confirmed || draft.channel === 'email' && !transactionalConfirmed ? 'Check the statements above to continue.' : confirmationMode === 'schedule' && !scheduledAt ? 'Choose a send time to continue.' : undefined}>
          <Stack gap={3}><Text>{labels[draft.channel]} to {validPreview.audience.eligible} eligible contact{validPreview.audience.eligible === 1 ? '' : 's'}. Your provider may charge for each message{validPreview.sms ? `; estimated SMS segments across this audience: ${validPreview.sms.totalSegments}` : ''}.</Text>
            {confirmationMode === 'schedule' && <DateTimeField label="Send at (your local timezone)" required value={scheduledAt} onValueChange={setScheduledAt} disabled={!!busy} timeZoneLabel={Intl.DateTimeFormat().resolvedOptions().timeZone}/>}
            <Checkbox label="I reviewed the audience and message and authorise this send." checked={confirmed} disabled={!!busy} onChange={event => setConfirmed(event.target.checked)}/>
            {draft.channel === 'email' && <Checkbox label="This is an expected transactional message, not a newsletter or promotion." checked={transactionalConfirmed} disabled={!!busy} onChange={event => setTransactionalConfirmed(event.target.checked)}/>}
          </Stack>
        </ReviewConfirm>}
        {current && current.status !== 'draft' && <Stack as="section" gap={4}><Heading level={4}>Delivery results</Heading>
          {(current.providerStatus || current.phase) && <Text tone="muted" size="sm">{current.providerStatus ? `Provider status: ${statusLabel(current.providerStatus)}. ` : ""}{current.phase ? ({ creating: "Creating provider broadcast.", created: "Provider broadcast created.", adding: "Adding recipients to the provider broadcast.", dispatching: "Requesting provider send.", dispatched: "Send accepted by provider." } as Record<string, string>)[current.phase] || "" : ""}</Text>}
          {current.stats && <><Text tone="muted" size="sm">Provider broadcast totals may include updates that have not yet appeared on individual recipients.</Text><DescriptionList columns={3} items={Object.entries({ recipientCount: "Provider recipients", sentCount: "Provider sent", deliveredCount: "Provider delivered", readCount: "Provider read", failedCount: "Provider failed" }).filter(([key]) => Number.isFinite(current.stats[key])).map(([key, label]) => ({ key, term: label, description: current.stats[key] }))}/></>}
          {current.lastError && <Alert tone="danger">{current.lastError}</Alert>}
          <DescriptionList columns={3} items={Object.entries(current.counts || {}).map(([key, value]) => ({ key, term: statusLabel(key), description: String(value) }))}/>
          <Text tone="muted" size="sm">Accepted means the provider received a message. It does not confirm delivery or a read. Uncertain outcomes require checking the provider before another attempt.</Text>
          <FormActions><Button variant="secondary" disabled={!!busy} onClick={() => campaignAction('refresh')}>Refresh delivery status</Button>{!readOnly && (['scheduled', 'sending', 'attention'].includes(current.status) || retryCancellation) && <Button variant="danger" disabled={!!busy} onClick={() => setConfirmingCancel(true)}>{retryCancellation ? 'Retry provider cancellation' : 'Cancel remaining messages'}</Button>}</FormActions>
          <ConfirmDialog open={confirmingCancel} onOpenChange={setConfirmingCancel} danger title={retryCancellation ? 'Retry provider cancellation?' : 'Cancel remaining messages?'} description="Cancel messages that have not been sent? Messages already accepted by the provider may still be delivered." confirmLabel={retryCancellation ? 'Retry provider cancellation' : 'Cancel remaining messages'} onConfirm={() => campaignAction('cancel')}/>
          {deliveries.length > 0 && <><OperationResults title="Recipients" description="Each recipient’s latest reported outcome." items={deliveries.slice(0, deliveriesShown).map((delivery: any, index: number) => ({ id: delivery.id || String(index), target: delivery.name || delivery.contactName || delivery.recipient || delivery.address || delivery.to || delivery.contactId, status: deliveryStatus(delivery.status), detail: `${statusLabel(delivery.status)} · ${delivery.updatedAt || delivery.sentAt || delivery.createdAt ? when(delivery.updatedAt || delivery.sentAt || delivery.createdAt) : 'No update time'}`, error: delivery.error || delivery.reason || undefined, actions: replies ? <Button variant="secondary" size="sm" disabled={!!busy || !delivery.recipient} onClick={() => openReplies(current, delivery.recipient)}>Open replies</Button> : undefined }))}/>
            <LoadMore itemLabel="recipients" shown={Math.min(deliveriesShown, deliveries.length)} total={deliveries.length} hasMore={deliveries.length > deliveriesShown} label="Show more recipients" endMessage="All recipients are shown." onLoadMore={() => setDeliveryLimit({ id: current.id, count: deliveriesShown + 50 })}/></>}
        </Stack>}
      </Stack></Card>}
    </Stack> }, { value: 'contacts', label: <>Contacts <Badge>{contacts.length}</Badge></>, content: <Stack gap={6}>
      <Card as="section" title="Project contacts" description="Duplicates, consent and suppressions are checked before messages are queued." actions={!readOnly && <Button variant="secondary" disabled={!!busy || !visibleContacts.some(item => item.email)} onClick={checkDns}>Check email domains</Button>}><Stack gap={4}>
        <Field label="Search contacts"><Input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, email, phone, company or tag"/></Field>
        <DataTable searchable={false} sortable={false} ariaLabel="Project contacts" rows={visibleContacts} rowKey={person => person.id} pageSize={50} responsive="stack" emptyState={<EmptyState title={search ? 'No matching contacts' : 'Add your first contact'} description="Import a CSV or add a contact below, with channel permissions recorded separately."/>} columns={[
          { key: 'contact', header: 'Contact', rowHeader: true, wrap: true, render: person => <Stack gap={0}><Text as="strong" weight="semibold">{contactName(person)}</Text><Text as="small" tone="muted">{person.company || (person.tags || []).join(', ')}</Text>{person.source === 'messenger' && <Text as="small" tone="muted">Created from Messenger</Text>}</Stack> },
          { key: 'address', header: 'Address', wrap: true, render: person => <Stack gap={0}><Text as="span">{person.email || '—'}</Text><Text as="span">{person.phone || '—'}</Text>{(person.identities || []).map((identity: Row) => <Text as="small" tone="muted" key={identity.accountId + ':' + identity.participantId}>Messenger: {identity.participantId}</Text>)}</Stack> },
          { key: 'permissions', header: 'Permissions', render: person => <Stack gap={1} align="start">{channels.map(channel => { const held = suppressed(person, channel); return <Badge key={channel} tone={held ? 'danger' : person.consents?.[channel] ? 'success' : 'neutral'}>{labels[channel]}: {held ? (held.expiresAt ? `Held until ${new Date(held.expiresAt).toLocaleString()}` : 'Suppressed') : person.consents?.[channel] ? 'Permission recorded' : 'No permission'}</Badge>; })}</Stack> },
          { key: 'hygiene', header: 'Hygiene', wrap: true, render: person => <Stack gap={0}>{person.hygiene?.disposable && <Text as="span">Disposable email domain</Text>}{person.hygiene?.roleAddress && <Text as="span">Role address</Text>}{person.hygiene?.typoSuggestion && <Text as="span">Check spelling: {person.hygiene.typoSuggestion}</Text>}<Text as="small" tone="muted">{person.email ? ({ mx: 'Mail server found; mailbox unverified', implicit_mx: 'Domain address fallback; mailbox unverified', nxdomain: 'Email domain does not exist', no_mx: 'No mail server found', null_mx: 'Domain does not accept email', unavailable: 'Domain check unavailable', unchecked: 'Domain not checked' } as Record<string, string>)[person.hygiene?.dnsStatus || 'unchecked'] : 'No email address provided'}</Text></Stack> },
        ]} rowActionsLabel="Actions" rowActions={person => !readOnly && <Inline gap={2}><Button variant="secondary" size="sm" disabled={!!busy} onClick={() => editContact(person)}>Edit</Button><Button variant="secondary" size="sm" disabled={!!busy} onClick={() => setSuppression({ id: person.id, channel: 'email', reason: '' })}>Suppress</Button></Inline>}/>
        <Text tone="muted" size="sm">Domain checks inspect up to 50 matching email contacts at a time. A mail server record does not prove a mailbox exists.</Text>
      </Stack></Card>
      {!readOnly && <Grid columns={2} gap={6}>
        <Card as="section" title={contactEditId ? 'Edit contact' : 'Add contact'}><Form onSubmit={(_, event) => saveContact(event)}><Stack as="fieldset" gap={4} disabled={!!busy}>
          <FormGrid><Field label="Name"><Input maxLength={200} value={contact.name} onChange={event => setContact({ ...contact, name: event.target.value })}/></Field><Field label="Company"><Input maxLength={200} value={contact.company} onChange={event => setContact({ ...contact, company: event.target.value })}/></Field></FormGrid>
          <Field label="Email"><Input type="email" value={contact.email} maxLength={254} onChange={event => setContact({ ...contact, email: event.target.value, consentSource: '', consents: { ...contact.consents, email: false } })}/></Field>
          <Field label="Phone (international format)"><Input type="tel" value={contact.phone} pattern="\+[1-9][0-9]{6,14}" placeholder="+971501234567" onChange={event => setContact({ ...contact, phone: event.target.value, consentSource: '', consents: { ...contact.consents, sms: false, whatsapp: false } })}/></Field>
          <Field label="Tags (comma separated)"><Input value={contact.tags} onChange={event => setContact({ ...contact, tags: event.target.value })}/></Field>
          <Fieldset legend="Recorded channel permissions">{channels.map(channel => <Checkbox key={channel} label={`${labels[channel]} permission is recorded for this contact.`} checked={contact.consents[channel]} onChange={event => setContact({ ...contact, consents: { ...contact.consents, [channel]: event.target.checked } })}/>)}<Field label="Permission source / evidence" required={Object.values(contact.consents).some(Boolean)}><Input required={Object.values(contact.consents).some(Boolean)} maxLength={1000} value={contact.consentSource} onChange={event => setContact({ ...contact, consentSource: event.target.value })} placeholder="Signup form, date, or consent record reference"/></Field></Fieldset>
          <Text tone="muted" size="sm">For an existing contact, save a changed address first, then record its permission on a second save. Suppressions remain in force after edits and imports.</Text>
          <FormActions><Button variant="primary" type="submit">{contactEditId ? 'Save contact changes' : 'Add contact'}</Button>{contactEditId && <Button variant="secondary" onClick={() => editContact()}>Cancel edit</Button>}</FormActions>
        </Stack></Form></Card>
        <Card as="section" title="Import contacts from CSV" description="Headers: name, email, phone, company, tags. Use international phone numbers and separate tags with | or ; within the tags field. Existing contacts are merged by matching email or phone; imports preserve suppressions."><Stack gap={4}><Form onSubmit={(_, event) => importContacts(event)}><Stack as="fieldset" gap={4} disabled={!!busy}>
          <Field label="Choose CSV file (up to 1 MB)"><Input type="file" accept=".csv,text/csv" onChange={readCsv}/></Field>
          <Field label="CSV content" required><Textarea required rows={7} maxLength={1024 * 1024} value={csv} onChange={event => { csvRead.current++; setCsv(event.target.value); setImportResult(null); }} placeholder={'name,email,phone,company,tags\nAlex,alex@example.com,+971501234567,Example,customer|launch'}/></Field>
          <Fieldset legend="Grant permissions only with existing evidence">{channels.map(channel => <Checkbox key={channel} label={`${labels[channel]} permission is recorded for all applicable imported contacts.`} checked={importConsent[channel]} onChange={event => setImportConsent({ ...importConsent, [channel]: event.target.checked })}/>)}<Field label="Import permission source / evidence" required={Object.values(importConsent).some(Boolean)}><Input required={Object.values(importConsent).some(Boolean)} maxLength={1000} value={importSource} onChange={event => setImportSource(event.target.value)}/></Field></Fieldset>
          <Text tone="muted" size="sm">Leaving a permission unchecked grants no new permission. Contact addresses and CSV columns never imply consent.</Text>
          <FormActions><Button variant="secondary" type="submit" value="preview">Preview import</Button><Button variant="primary" type="submit" value="import">Import contacts</Button></FormActions>
        </Stack></Form>
        {importResult && <Alert tone="info" title={importResult.dryRun ? 'Import preview · no records changed' : 'Import completed'}><Stack gap={2}><Text>{importResult.created || 0} {importResult.dryRun ? 'to create' : 'created'} · {importResult.updated || 0} {importResult.dryRun ? 'to merge' : 'merged'} · {importResult.skipped || 0} skipped</Text>{importResult.errors?.length > 0 && <List>{importResult.errors.map((item: any, index: number) => <ListItem key={index}>Row {item.row}: {item.error}</ListItem>)}</List>}</Stack></Alert>}</Stack></Card>
      </Grid>}
      {suppression && !readOnly && <Card as="section" title={`Suppress ${contactName(contacts.find(item => item.id === suppression.id))}`} description="This blocks future messages on the selected channel. Imports and contact edits cannot remove the suppression."><Form onSubmit={(_, event) => suppress(event)}><Stack as="fieldset" gap={4} disabled={!!busy}>
        <Field label="Channel"><Select value={suppression.channel} onChange={event => setSuppression({ ...suppression, channel: event.target.value as Channel })}>{channels.map(channel => <Option key={channel} value={channel}>{labels[channel]}</Option>)}</Select></Field>
        <Field label="Reason" required><Input required maxLength={1000} value={suppression.reason} onChange={event => setSuppression({ ...suppression, reason: event.target.value })} placeholder="Unsubscribed, delivery failure, or manual exclusion"/></Field>
        <FormActions><Button variant="danger" type="submit">Confirm suppression</Button><Button variant="secondary" onClick={() => setSuppression(null)}>Cancel</Button></FormActions>
      </Stack></Form></Card>}
    </Stack> }]}/>
  </Stack>;
}
