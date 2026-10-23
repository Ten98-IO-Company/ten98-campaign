import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, CheckboxGroup, ConfirmDialog, CopyButton, DataTable, DateTimeField, Dialog, EmptyState, Field, FormGrid, Image, Inline, Input, Link, MetricCard, MetricGrid, Select, Stack, Text, Textarea } from '@ten98/ui';
import { ACTIVATION_TYPES, ACTIVATION_TYPE_LABELS, CONSENT_CHANNELS, CONSENT_LABELS, consentPrompt, type ActivationType, type ConsentChannel } from '../shared/offline-activations.ts';

type Row = { id: string; [key: string]: any };
type Material = { label: string; done: boolean };
type Props = { projectId: string; brand: string; campaigns: Row[]; activations: Row[]; request: (path: string, method?: string, body?: unknown) => Promise<any>; readOnly?: boolean; onChanged: () => Promise<void> | void };
type Draft = { name: string; type: ActivationType; campaignId: string; status: string; startAt: string; endAt: string; location: string; notes: string; ownerId: string; teamIds: string[]; materials: Material[]; budget: string; spent: string; reached: string; promoCode: string };

const STATUS_LABELS: Record<string, string> = { planned: 'Planned', completed: 'Completed', cancelled: 'Cancelled' };
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
// DateTimeField edits local wall time (2026-11-07T10:00); the server stores ISO instants.
const localInput = (iso?: string) => { if (!iso) return ''; const date = new Date(iso); return Number.isFinite(date.getTime()) ? new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16) : ''; };
const instant = (local: string) => local ? new Date(local).toISOString() : '';
const amount = (value: string, label: string, whole = false) => { const number = value.trim() === '' ? 0 : Number(value); if (!Number.isFinite(number) || number < 0 || whole && !Number.isInteger(number)) throw new Error(`${label} must be ${whole ? 'a whole number' : 'a number'} of zero or more.`); return number; };
export const money = (value: number, currency = 'AED') => new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: 0 }).format(value || 0);
export function when(activation: Row) {
  const start = new Date(activation.startAt), end = new Date(activation.endAt), day = { weekday: 'short', day: 'numeric', month: 'short' } as const, time = { hour: '2-digit', minute: '2-digit' } as const;
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return 'Not scheduled';
  const sameDay = start.toDateString() === end.toDateString();
  return `${start.toLocaleDateString(undefined, day)}, ${start.toLocaleTimeString(undefined, time)} – ${sameDay ? '' : end.toLocaleDateString(undefined, day) + ', '}${end.toLocaleTimeString(undefined, time)}`;
}
// The landing page with UTM tags naming the activation, so web analytics and the short link agree on the source.
export function trackingDestination(landing: string, activation: Row, campaignName = '') {
  let url: URL; try { url = new URL(landing.trim()); } catch { throw new Error('Enter the landing page as a full address that starts with https://.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Use a public HTTPS landing page without embedded credentials.');
  for (const [key, value] of [['utm_source', activation.type], ['utm_medium', 'offline'], ['utm_campaign', campaignName], ['utm_content', activation.name]]) if (value) url.searchParams.set(key, value);
  return url.href;
}
export function TrackingLink({ link }: { link: Row }) {
  return <Inline gap={3} align="start">
    <Image src={link.qrSvgUrl} alt={'QR code for ' + link.name} fit="contain" width={144} height={144}/>
    <Stack gap={1}>
      <Text as="strong" weight="semibold">{link.shortUrl}</Text>
      <Text tone="muted" size="sm">{`${(link.clicks || 0).toLocaleString()} link visits · ${(link.qrScans || 0).toLocaleString()} QR scans`}</Text>
      <Inline gap={2}><CopyButton value={link.shortUrl} label="Copy link" messages={{ copied: 'Short link copied.' }}/><Link href={link.qrSvgUrl} download={`${link.name} QR.svg`}>Download QR</Link></Inline>
    </Stack>
  </Inline>;
}
type Result = { leads: number; clicks: number; qrScans: number };
// Totals for the activations shown; spend only adds up within one currency.
export function rollUp(rows: Row[], results: Record<string, Result>) {
  const total = { reached: 0, leads: 0, visits: 0, budget: 0, spent: 0 };
  for (const row of rows) { const result = results[row.id]; total.reached += row.reached || 0; if (row.status !== 'cancelled') total.budget += row.budget || 0; total.spent += row.spent || 0; if (result) { total.leads += result.leads; total.visits += result.clicks + result.qrScans; } }
  return { ...total, costPerLead: total.leads ? total.spent / total.leads : null };
}
export function ResultsSummary({ rows, results, currency }: { rows: Row[]; results: Record<string, Result> | null; currency: string | null }) {
  const total = rollUp(rows, results || {}), pending = results === null;
  return <MetricGrid list label="Field results" minItemWidth="sm">
    <MetricCard label="People reached" value={total.reached.toLocaleString()} hint="Counted by the team"/>
    {pending ? <MetricCard label="Leads" unavailable="Loading…"/> : <MetricCard label="Leads" value={total.leads.toLocaleString()} hint="Contacts with consent"/>}
    {pending ? <MetricCard label="Link and QR visits" unavailable="Loading…"/> : <MetricCard label="Link and QR visits" value={total.visits.toLocaleString()}/>}
    {currency ? <MetricCard label="Spend" value={money(total.spent, currency)} hint={`of ${money(total.budget, currency)} planned`}/> : <MetricCard label="Spend" unavailable="Choose one campaign"/>}
    {currency && total.costPerLead !== null && !pending ? <MetricCard label="Cost per lead" value={money(total.costPerLead, currency)}/> : <MetricCard label="Cost per lead" unavailable={currency ? 'No leads yet' : 'Choose one campaign'}/>}
  </MetricGrid>;
}
type Lead = { name: string; email: string; phone: string; channels: ConsentChannel[] };
const blankLead = (): Lead => ({ name: '', email: '', phone: '', channels: [] });
export function leadBody(lead: Lead) {
  if (!lead.channels.length) throw new Error('Tick at least one channel the person agreed to. Without an opt-in nothing is saved.');
  return { ...Object.fromEntries((['name', 'email', 'phone'] as const).filter(key => lead[key].trim()).map(key => [key, lead[key].trim()])), consents: Object.fromEntries(CONSENT_CHANNELS.map(channel => [channel, lead.channels.includes(channel)])) };
}
const channelList = (channels: ConsentChannel[]) => channels.map(channel => CONSENT_LABELS[channel].toLowerCase());
// Phone-sized form staff use at the stop or door: consent wording first, every channel unticked, then only contact details.
export function LeadCapture({ brand, activation, request, path, onClose }: { brand: string; activation: Row; request: Props['request']; path: string; onClose: () => void }) {
  const [lead, setLead] = useState<Lead>(blankLead), [saved, setSaved] = useState(0), [message, setMessage] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null);
  async function save() {
    try {
      const result = await request(`${path}/${encodeURIComponent(activation.id)}/leads`, 'POST', leadBody(lead)), refused = channelList(result.refused || []);
      setSaved(count => count + 1); setLead(blankLead());
      setMessage({ tone: 'success', text: `Lead saved with ${channelList(result.recorded).join(' and ')} consent.${refused.length ? ` Not ${refused.join(' or ')}: this person opted out earlier.` : ''}` });
    } catch (failure) { setMessage({ tone: 'danger', text: (failure as Error).message || 'The lead could not be saved.' }); }
  }
  return <Dialog open onOpenChange={next => { if (!next) onClose(); }} eyebrow={activation.name} title="Capture a lead" description={saved ? `${saved} saved this session.` : undefined} onSubmit={save}
    footer={<Inline gap={2} justify="end"><Button variant="secondary" onClick={onClose}>Done</Button><Button type="submit">Save lead</Button></Inline>}>
    <Stack gap={3}>
      {message && <Alert tone={message.tone} variant="inline">{message.text}</Alert>}
      <CheckboxGroup legend={`Ask first: “${consentPrompt(brand)}…”`} description="Tick only what the person says yes to. Nothing is saved without at least one." value={lead.channels} onValueChange={channels => setLead(current => ({ ...current, channels: channels as ConsentChannel[] }))} options={CONSENT_CHANNELS.map(channel => ({ value: channel, label: CONSENT_LABELS[channel] }))}/>
      <Field label="Name"><Input autoComplete="off" maxLength={120} value={lead.name} onChange={event => setLead(current => ({ ...current, name: event.target.value }))}/></Field>
      <Field label="Email" description="Needed for email consent."><Input type="email" inputMode="email" autoComplete="off" maxLength={254} value={lead.email} onChange={event => setLead(current => ({ ...current, email: event.target.value }))}/></Field>
      <Field label="Mobile number" description="International format, for example +447700900123. Needed for text message or WhatsApp."><Input type="tel" inputMode="tel" autoComplete="off" maxLength={16} value={lead.phone} onChange={event => setLead(current => ({ ...current, phone: event.target.value }))}/></Field>
    </Stack>
  </Dialog>;
}
export function blankDraft(campaignId = ''): Draft { return { name: '', type: 'roadshow', campaignId, status: 'planned', startAt: '', endAt: '', location: '', notes: '', ownerId: '', teamIds: [], materials: [], budget: '', spent: '', reached: '', promoCode: '' }; }
export function draftFrom(activation: Row): Draft { return { ...blankDraft(), ...Object.fromEntries(Object.keys(blankDraft()).filter(key => activation[key] !== undefined).map(key => [key, ['budget', 'spent', 'reached'].includes(key) ? String(activation[key] || '') : activation[key]])), startAt: localInput(activation.startAt), endAt: localInput(activation.endAt) } as Draft; }
export function activationBody(draft: Draft) {
  if (!draft.startAt || !draft.endAt) throw new Error('Enter when the activation starts and ends.');
  return { name: draft.name, type: draft.type, campaignId: draft.campaignId, status: draft.status, startAt: instant(draft.startAt), endAt: instant(draft.endAt), location: draft.location, notes: draft.notes, ownerId: draft.ownerId, teamIds: draft.teamIds, materials: draft.materials, budget: amount(draft.budget, 'Planned budget'), spent: amount(draft.spent, 'Actual spend'), reached: amount(draft.reached, 'People reached', true), promoCode: draft.promoCode.trim() };
}

export default function OfflineActivations({ projectId, brand, campaigns, activations, request, readOnly = false, onChanged }: Props) {
  const path = `/projects/${encodeURIComponent(projectId)}/activations`, requester = useRef(request); requester.current = request;
  const [filter, setFilter] = useState(''), [members, setMembers] = useState<Row[]>([]), [editing, setEditing] = useState<Row | 'new' | null>(null), [draft, setDraft] = useState<Draft>(blankDraft()), [dirty, setDirty] = useState(false);
  const [link, setLink] = useState<Row | null>(null), [landing, setLanding] = useState(''), [linkError, setLinkError] = useState(''), [linking, setLinking] = useState(false);
  const [material, setMaterial] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [removing, setRemoving] = useState<Row>(), [capturing, setCapturing] = useState<Row | null>(null), [results, setResults] = useState<Record<string, Result> | null>(null);
  useEffect(() => { if (readOnly) return; let current = true; requester.current(`/projects/${encodeURIComponent(projectId)}/assignees`).then(result => { if (current) setMembers(result.members || []); }, () => { if (current) setMembers([]); }); return () => { current = false; }; }, [projectId, readOnly]);
  useEffect(() => { let current = true; requester.current(`${path}/results`).then(result => { if (current) setResults(result.results || {}); }, () => { if (current) setResults({}); }); return () => { current = false; }; }, [path, activations]);
  const campaignOf = (id: string) => campaigns.find(campaign => campaign.id === id);
  const rows = activations.filter(activation => !filter || activation.campaignId === filter).sort((a, b) => String(a.startAt).localeCompare(String(b.startAt)));
  const change = (patch: Partial<Draft>) => { setDraft(current => ({ ...current, ...patch })); setDirty(true); };
  function open(activation: Row | 'new') { setDraft(activation === 'new' ? blankDraft(filter || campaigns[0]?.id || '') : draftFrom(activation)); setEditing(activation); setDirty(false); setMaterial(''); setError(''); setNotice(''); setLink(null); setLanding(''); setLinkError('');
    if (activation !== 'new' && activation.linkId) request(`/projects/${encodeURIComponent(projectId)}/links`).then(result => setLink((result.links || []).find((row: Row) => row.id === activation.linkId) || null), () => setLinkError('The tracking link could not be loaded.'));
  }
  // Creates (or reuses) the campaign short link for this activation's tagged landing page and keeps it on the activation.
  async function createLink(activation: Row) {
    setLinkError(''); setLinking(true);
    try {
      const destination = trackingDestination(landing, activation, campaignOf(activation.campaignId)?.name);
      const created = (await request(`/projects/${encodeURIComponent(projectId)}/links`, 'POST', { name: activation.name, destination, campaignId: activation.campaignId })).link;
      await request(`${path}/${encodeURIComponent(activation.id)}`, 'PATCH', { linkId: created.id });
      setLink(created); setEditing({ ...activation, linkId: created.id }); await onChanged();
    } catch (failure) { setLinkError((failure as Error).message || 'The tracking link could not be created.'); }
    finally { setLinking(false); }
  }
  async function save() {
    setError('');
    try {
      const existing = editing !== 'new' && editing ? editing : null;
      await request(existing ? `${path}/${encodeURIComponent(existing.id)}` : path, existing ? 'PATCH' : 'POST', activationBody(draft));
      setEditing(null); setNotice(existing ? 'Activation saved.' : 'Activation planned.'); await onChanged();
    } catch (failure) { setError((failure as Error).message || 'The activation could not be saved.'); }
  }
  async function remove(activation: Row) {
    try { await request(`${path}/${encodeURIComponent(activation.id)}`, 'DELETE'); setEditing(null); setNotice('Activation deleted.'); await onChanged(); }
    catch (failure) { setError((failure as Error).message || 'The activation could not be deleted.'); }
  }
  function addMaterial() { const label = material.trim(); if (!label || draft.materials.length >= 30) return; change({ materials: [...draft.materials, { label, done: false }] }); setMaterial(''); }
  const editable = !readOnly, current = editing && editing !== 'new' ? editing : null;
  const peopleOptions = members.map(member => ({ value: member.id, label: member.name }));
  return <Card as="section">
    <Stack gap={3}>
      <Text tone="muted" size="sm">Roadshow stops, door-to-door areas, events, street teams and sampling, planned against a campaign.</Text>
      {notice && <Alert tone="success" variant="inline" onDismiss={() => setNotice('')}>{notice}</Alert>}
      {error && !editing && <Alert tone="danger" variant="inline" onDismiss={() => setError('')}>{error}</Alert>}
      <Inline justify="between" align="center">
        <Select width="auto" aria-label="Campaign" value={filter} onChange={event => setFilter(event.target.value)} options={[{ value: '', label: 'All campaigns' }, ...campaigns.map(campaign => ({ value: campaign.id, label: campaign.name }))]}/>
        {editable && <Button disabled={!campaigns.length} onClick={() => open('new')}>New activation</Button>}
      </Inline>
      <DataTable searchable={false} sortable={false} pagination={false} responsive="stack" ariaLabel="Field activations" rows={rows} rowKey={activation => activation.id}
        emptyState={<EmptyState title={campaigns.length ? 'No field activity planned' : 'Create a campaign first'} description={campaigns.length ? 'Plan a roadshow stop, door-to-door area, event, street team or sampling shift.' : 'Activations belong to a campaign, so their spend and leads roll up into it.'}/>}
        columns={[
          { key: 'name', header: 'Activation', rowHeader: true, render: activation => <Stack gap={0}><Text as="strong" weight="semibold">{activation.name}</Text><Text tone="muted" size="sm">{ACTIVATION_TYPE_LABELS[activation.type as ActivationType] || activation.type}{filter ? '' : ' · ' + (campaignOf(activation.campaignId)?.name || 'Campaign removed')}</Text></Stack> },
          { key: 'startAt', header: 'When', render: when },
          { key: 'location', header: 'Where', wrap: true, minWidth: 'sm', render: activation => activation.location },
          { key: 'spent', header: 'Spend', numeric: true, render: activation => { const currency = campaignOf(activation.campaignId)?.currency || 'AED'; return `${money(activation.spent, currency)} of ${money(activation.budget, currency)}`; } },
          { key: 'results', header: 'Leads', numeric: true, render: activation => results?.[activation.id] ? results[activation.id].leads.toLocaleString() : '—' },
          { key: 'status', header: 'Status', render: activation => <Badge tone={activation.status === 'completed' ? 'success' : activation.status === 'cancelled' ? 'neutral' : 'info'}>{STATUS_LABELS[activation.status] || activation.status}</Badge> },
        ]}
        rowActionsLabel="Actions" rowActions={activation => <Inline gap={2}>{editable && activation.status !== 'cancelled' && <Button size="sm" onClick={() => setCapturing(activation)} aria-label={`Capture leads at ${activation.name}`}>Capture leads</Button>}<Button variant="secondary" size="sm" onClick={() => open(activation)} aria-label={`${editable ? 'Edit' : 'View'} ${activation.name}`}>{editable ? 'Edit' : 'View'}</Button></Inline>}/>
      {rows.length > 0 && <ResultsSummary rows={rows} results={results} currency={filter ? campaignOf(filter)?.currency || 'AED' : new Set(rows.map(row => campaignOf(row.campaignId)?.currency || 'AED')).size === 1 ? campaignOf(rows[0].campaignId)?.currency || 'AED' : null}/>}
    </Stack>
    <Dialog open={!!editing} onOpenChange={next => { if (!next) setEditing(null); }} dirty={dirty} size="wide" eyebrow={campaignOf(draft.campaignId)?.name} title={editing === 'new' ? 'New activation' : editable ? 'Edit activation' : 'Activation'} onSubmit={editable ? save : undefined}
      footer={editable ? <Inline gap={2} justify="end">{current && <Button variant="ghost" onClick={() => setRemoving(current)}>Delete</Button>}<Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button type="submit">{current ? 'Save activation' : 'Plan activation'}</Button></Inline> : undefined}>
      <Stack gap={3}>
        {error && <Alert tone="danger" variant="inline">{error}</Alert>}
        <FormGrid>
          <Field label="Name" required><Input required maxLength={120} disabled={!editable} value={draft.name} onChange={event => change({ name: event.target.value })}/></Field>
          <Field label="Type" required><Select disabled={!editable} value={draft.type} onChange={event => change({ type: event.target.value as ActivationType })} options={ACTIVATION_TYPES.map(type => ({ value: type, label: ACTIVATION_TYPE_LABELS[type] }))}/></Field>
          <Field label="Campaign" required><Select required disabled={!editable} value={draft.campaignId} placeholder="Choose a campaign" onChange={event => change({ campaignId: event.target.value })} options={campaigns.map(campaign => ({ value: campaign.id, label: campaign.name }))}/></Field>
          <Field label="Status"><Select disabled={!editable} value={draft.status} onChange={event => change({ status: event.target.value })} options={Object.entries(STATUS_LABELS).map(([value, label]) => ({ value, label }))}/></Field>
          <DateTimeField label="Starts" type="datetime-local" required disabled={!editable} value={draft.startAt} onValueChange={startAt => change({ startAt })} timeZoneLabel={timeZone}/>
          <DateTimeField label="Ends" type="datetime-local" required disabled={!editable} min={draft.startAt || undefined} value={draft.endAt} onValueChange={endAt => change({ endAt })} timeZoneLabel={timeZone}/>
        </FormGrid>
        <Field label="Where" required description="An address for a stop or booth, or the streets an area covers."><Input required maxLength={500} disabled={!editable} value={draft.location} onChange={event => change({ location: event.target.value })}/></Field>
        <Field label="Brief" description="What the team should know. For door-to-door, list no-knock streets and no-cold-calling zones here."><Textarea maxLength={2000} rows={3} disabled={!editable} value={draft.notes} onChange={event => change({ notes: event.target.value })}/></Field>
        <FormGrid>
          <Field label="Owner"><Select disabled={!editable} value={draft.ownerId} onChange={event => change({ ownerId: event.target.value })} options={[{ value: '', label: 'No owner' }, ...peopleOptions]}/></Field>
          <Field label="Promo code" description="Optional, for in-store or checkout attribution."><Input maxLength={40} pattern="[A-Za-z0-9_-]*" disabled={!editable} value={draft.promoCode} onChange={event => change({ promoCode: event.target.value })}/></Field>
        </FormGrid>
        {peopleOptions.length > 0 && <CheckboxGroup legend="Team" orientation="horizontal" disabled={!editable} value={draft.teamIds} onValueChange={teamIds => change({ teamIds })} options={peopleOptions}/>}
        <FormGrid>
          <Field label={`Planned budget (${campaignOf(draft.campaignId)?.currency || 'AED'})`}><Input inputMode="decimal" disabled={!editable} value={draft.budget} onChange={event => change({ budget: event.target.value })}/></Field>
          <Field label={`Actual spend (${campaignOf(draft.campaignId)?.currency || 'AED'})`}><Input inputMode="decimal" disabled={!editable} value={draft.spent} onChange={event => change({ spent: event.target.value })}/></Field>
          <Field label="People reached" description="Your own count, for example flyers handed out."><Input inputMode="numeric" disabled={!editable} value={draft.reached} onChange={event => change({ reached: event.target.value })}/></Field>
        </FormGrid>
        <Stack gap={2}>
          <Text as="strong" weight="semibold">Materials</Text>
          {draft.materials.length ? draft.materials.map((item, index) => <Inline key={index} justify="between" align="center"><Checkbox label={item.label} checked={item.done} disabled={!editable} onChange={event => change({ materials: draft.materials.map((entry, at) => at === index ? { ...entry, done: event.target.checked } : entry) })}/>{editable && <Button variant="ghost" size="sm" aria-label={`Remove ${item.label}`} onClick={() => change({ materials: draft.materials.filter((_, at) => at !== index) })}>Remove</Button>}</Inline>) : <Text tone="muted" size="sm">No materials listed.</Text>}
          {editable && <Inline gap={2} align="end"><Field label="Add material"><Input maxLength={80} value={material} onChange={event => setMaterial(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addMaterial(); } }}/></Field><Button variant="secondary" disabled={!material.trim() || draft.materials.length >= 30} onClick={addMaterial}>Add</Button></Inline>}
        </Stack>
        {current && <Stack gap={2}>
          <Text as="strong" weight="semibold">Tracking</Text>
          {linkError && <Alert tone="danger" variant="inline">{linkError}</Alert>}
          {link ? <TrackingLink link={link}/> : current.linkId ? <Text tone="muted" size="sm">Loading the tracking link…</Text> : editable ? <Inline gap={2} align="end"><Field label="Landing page" description="Visits from this activation's short link and QR code are counted here and tagged utm_medium=offline."><Input type="url" placeholder="https://" value={landing} disabled={linking} onChange={event => setLanding(event.target.value)}/></Field><Button variant="secondary" disabled={!landing.trim() || linking} onClick={() => createLink(current)}>Create link and QR</Button></Inline> : <Text tone="muted" size="sm">No tracking link yet.</Text>}
        </Stack>}
      </Stack>
    </Dialog>
    {capturing && <LeadCapture brand={brand} activation={capturing} request={request} path={path} onClose={() => { setCapturing(null); void onChanged(); }}/>}
    {removing && <ConfirmDialog open onOpenChange={next => { if (!next) setRemoving(undefined); }} title={`Delete “${removing.name}”?`} description="Its plan, checklist and spend are removed. Contacts captured there stay in Contacts." confirmLabel="Delete" danger onConfirm={() => remove(removing)}/>}
  </Card>;
}
