import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, AppliedFilters, Avatar, Blockquote, Button, Card, Checkbox, Combobox, ConfirmDialog, ContentPreview, ConversationThread, DescriptionList, DetailWorkspace, Disclosure, EmptyState, FeatureControls, Field, FieldList, Form, FormActions, FormGrid, Heading, Image, Inline, Input, Link, LoadMore, MediaPlayer, Option, Popover, ReviewConfirm, SegmentedControl, Select, SelectableList, Stack, StatusLine, Tabs, Text, Textarea } from '@ten98/ui';
import type { ConversationMessage } from '@ten98/ui';
import WhatsAppTemplate, { templateRestriction } from './WhatsAppTemplate';
import { useFocusReturn } from './focus-return';
import { validPostInstant } from '../shared/social-posts.ts';

type Row = Record<string, any>;
type Tab = 'messages' | 'comments' | 'reviews' | 'mentions';
type Props = { projectId: string; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>; readOnly?: boolean; role?: string; initialChannel?: 'sms' | 'whatsapp'; initialAccountId?: string; initialSearch?: string; onDraftChange?: (dirty: boolean) => void; onOpenIntegrations?: () => void };
type SelectionProps = { onDraftChange: (snapshot: string, busy?: boolean) => void; onSwitch: (change: () => void | Promise<void>) => void | Promise<void> };
const tabs: Tab[] = ['messages', 'comments', 'reviews', 'mentions'];
const title = (value = '') => ({ linkedin: 'LinkedIn', googlebusiness: 'Google Business Profile', twitter: 'X', metaads: 'Meta ads', sms: 'SMS', rcs: 'RCS', whatsapp: 'WhatsApp', imessage: 'iMessage' } as Record<string, string>)[value] || (value ? value.charAt(0).toUpperCase() + value.slice(1) : '');
const accountLabel = (account: Row) => `${account.name || account.username || account.id} · ${account.platform === 'facebook' ? 'Facebook / Messenger' : title(account.platform)}`;
const when = (value?: string) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString() : 'Time unavailable';
const link = (value?: string, linkedin = false) => { try { const url = new URL(value || ''); return url.protocol === 'https:' && !url.username && !url.password && (!linkedin || ['linkedin.com', 'www.linkedin.com'].includes(url.hostname)) ? url.href : undefined; } catch { return undefined; } };
const merge = (before: Row[], after: Row[]) => [...new Map([...before, ...after].map(row => [row.id, row])).values()];
function conversationMatches(row: Row, search: string) {
  const query = search.toLowerCase();
  return !query || [row.participantName, row.participantUsername, row.participantId, row.lastMessage, row.content, row.text, row.authorName, row.authorUsername, row.reviewer?.name, row.locationName].some(value => String(value || '').toLowerCase().includes(query)) || /^\+?[1-9]\d{6,14}$/.test(search) && String(row.participantId || '').replace(/^\+/, '') === search.replace(/^\+/, '');
}

function SmsInbox({ projectId, request, readOnly = false, initialSearch, onDraftChange, onSwitch, onOpenIntegrations }: Omit<Props, 'onDraftChange'> & SelectionProps) {
  const path = `/projects/${encodeURIComponent(projectId)}/sms-inbox`, requester = useRef(request), version = useRef(0), pending = useRef(false), revision = useRef(0), keys = useRef(new Map<string, string>()); requester.current = request;
  const [status, setStatus] = useState<Row | null>(null), [rows, setRows] = useState<Row[]>([]), [pagination, setPagination] = useState<Row | null>(null), [selected, setSelected] = useState<Row | null>(null), [detail, setDetail] = useState<Row | null>(null);
  const [message, setMessage] = useState(''), [search, setSearch] = useState(initialSearch || ''), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const visible = rows.filter(item => conversationMatches(item, search)), conversation = detail?.conversation || selected, blocked = !!conversation?.blocked;
  useEffect(() => { onDraftChange(message ? JSON.stringify([projectId, selected?.id, message]) : '', !!busy); }, [projectId, selected?.id, message, busy]);
  useEffect(() => {
    const generation = ++version.current; pending.current = false; keys.current.clear(); setStatus(null); setRows([]); setPagination(null); setSelected(null); setDetail(null); setMessage(''); setSearch(initialSearch || ''); setError(''); setNotice(''); setBusy('Loading SMS replies');
    Promise.allSettled([requester.current(path + '/status'), requester.current(path + '/conversations')]).then(results => {
      if (generation !== version.current) return;
      if (results[0].status === 'fulfilled') setStatus(results[0].value); else setError(results[0].reason.message || 'SMS configuration could not be loaded.');
      if (results[1].status === 'fulfilled') { setRows(results[1].value.conversations || []); setPagination(results[1].value.pagination || null); } else setError(results[1].reason.message || 'SMS conversations could not be loaded.');
    }).finally(() => { if (generation === version.current) setBusy(''); });
    return () => { version.current++; };
  }, [projectId]);
  async function smsAction(label: string, run: (generation: number) => Promise<void>) {
    if (pending.current) return; const generation = version.current; pending.current = true; revision.current++; setBusy(label); setError(''); setNotice('');
    try { await run(generation); } catch (failure) { if (generation === version.current) setError((failure as Error).message || 'This SMS action could not be completed.'); }
    finally { if (generation === version.current) { pending.current = false; setBusy(''); } }
  }
  async function smsList(generation: number, cursor = '') {
    const result = await requester.current(path + '/conversations' + (cursor ? '?' + new URLSearchParams({ cursor }) : '')); if (generation !== version.current) return;
    setRows(previous => cursor ? merge(previous, result.conversations || []) : result.conversations || []); setPagination(result.pagination || null);
  }
  async function smsThread(item: Row, generation: number, cursor = '') {
    const result = await requester.current(path + '/conversations/' + encodeURIComponent(item.id) + '/messages' + (cursor ? '?' + new URLSearchParams({ cursor }) : '')); if (generation !== version.current) return;
    setSelected(result.conversation || item); setDetail((previous: Row | null) => cursor ? { ...result, messages: merge(previous?.messages || [], result.messages || []) } : result);
  }
  async function openSms(item: Row, cursor = '') {
    if (pending.current) return;
    const generation = version.current, open = () => generation === version.current ? smsAction('Loading SMS conversation', async active => { await smsThread(item, active, cursor); if (active === version.current && !cursor && selected?.id !== item.id) setMessage(''); }) : undefined;
    if (!cursor && selected?.id !== item.id) await onSwitch(open); else await open();
  }
  useEffect(() => {
    const generation = version.current; let closed = false, checking = false;
    const pollSms = async () => {
      if (checking || pending.current) return; checking = true; const started = revision.current;
      try {
        const [list, thread] = await Promise.all([requester.current(path + '/conversations'), selected ? requester.current(path + '/conversations/' + encodeURIComponent(selected.id) + '/messages') : Promise.resolve(null)]);
        if (closed || generation !== version.current || started !== revision.current) return;
        const knownRows = new Set(rows.map(item => item.id)), gap = list.pagination?.hasMore && (list.conversations || []).some((item: Row) => !knownRows.has(item.id));
        setRows(previous => merge(previous, list.conversations || []).sort((a, b) => (Date.parse(b.lastMessageAt) || 0) - (Date.parse(a.lastMessageAt) || 0))); setPagination(previous => gap ? list.pagination : previous || list.pagination || null);
        if (thread) { setSelected(thread.conversation); setDetail((previous: Row | null) => { const known = new Set((previous?.messages || []).map((item: Row) => item.id)), gap = thread.pagination?.hasMore && !(thread.messages || []).some((item: Row) => known.has(item.id)); return { ...thread, pagination: gap ? thread.pagination : previous?.pagination || thread.pagination, messages: merge(previous?.messages || [], thread.messages || []) }; }); }
      } catch { /* Manual refresh is available; polling reads local SMS records only. */ }
      finally { checking = false; }
    };
    const timer = window.setInterval(pollSms, 5000); return () => { closed = true; window.clearInterval(timer); };
  }, [projectId, selected?.id, rows]);
  const replyField = useRef<HTMLTextAreaElement>(null);
  function shortcut(key: InboxKey) {
    if (busy) return;
    if (key === 'r') { replyField.current?.focus(); return; }
    if (key === 'e') return;
    const index = visible.findIndex(item => item.id === selected?.id), next = index < 0 ? visible[0] : visible[index + (key === 'j' ? 1 : -1)];
    if (next) void openSms(next);
  }
  async function sendSms(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (readOnly || !selected || blocked || !status?.configured || !message.trim()) return;
    if (message.length > 1600) { setError('Keep the SMS reply within 1,600 characters.'); return; }
    const body = { message }, suffix = '/conversations/' + encodeURIComponent(selected.id) + '/reply', signature = JSON.stringify([path, suffix, body]);
    await smsAction('Sending SMS reply', async generation => {
      if (!keys.current.has(signature)) keys.current.set(signature, crypto.randomUUID());
      let result;
      try { result = await requester.current(path + suffix, 'POST', body, keys.current.get(signature)); keys.current.delete(signature); }
      catch (failure) { const failed = failure as Error & { status?: number; code?: string; operation?: Row }; if (failed.status && failed.status < 500 && failed.code !== 'OPERATION_UNCERTAIN' && !['pending', 'uncertain'].includes(failed.operation?.status)) keys.current.delete(signature); throw failure; }
      if (generation !== version.current) return;
      setMessage(''); setSelected(result.conversation || selected); if (result.message) setDetail((previous: Row | null) => ({ ...previous, conversation: result.conversation || selected, messages: merge(previous?.messages || [], [result.message]) }));
      setRows(previous => { const updated = result.conversation || selected; return previous.some(item => item.id === updated.id) ? previous.map(item => item.id === updated.id ? updated : item) : [updated, ...previous]; });
      setNotice('SMS reply accepted by Twilio. Delivery updates are shown separately.');
    });
  }
  return <Stack gap={4}>
    <InboxShortcuts onKey={shortcut}/>
    <Inline justify="between" align="center"><Stack gap={1}><Heading level={2} size="md">SMS replies</Heading><Text tone="muted">Receive and answer replies to SMS campaigns through the original Twilio sender.</Text></Stack><Button variant="secondary" disabled={!!busy} onClick={() => smsAction('Refreshing SMS replies', async generation => { const connection = await requester.current(path + '/status'); if (generation !== version.current) return; setStatus(connection); await smsList(generation); if (selected) await smsThread(selected, generation); })}>Refresh SMS replies</Button></Inline>
    {error && <Alert tone="danger">{error}</Alert>}{notice && <StatusLine>{notice}</StatusLine>}{busy && <StatusLine busy>{busy}…</StatusLine>}
    <Stack gap={2}><Field label="Search loaded SMS conversations"><Input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Phone number, contact name or message…"/></Field><Text tone="muted">Replies do not grant marketing permission. STOP opt-outs block further replies.</Text>{status && !status.configured && <Alert tone="warning">SMS sending is not configured. Previously received messages remain available.</Alert>}{onOpenIntegrations && <Inline><Button variant="secondary" onClick={onOpenIntegrations}>Open integrations</Button></Inline>}</Stack>
    <DetailWorkspace label="SMS conversations" listLabel="Conversations" detailLabel={conversation ? conversation.participantName || conversation.participantId : 'Conversation'} selected={!!selected} backLabel="Back to conversations" onBack={() => onSwitch(() => { setSelected(null); setDetail(null); setMessage(''); })} emptyMessage={<EmptyState title="Choose an SMS conversation" description="Open the recipient’s thread before sending a reply."/>}
      list={<SelectableList label="SMS conversations" selectedId={selected?.id} onSelect={id => { const item = visible.find(row => row.id === id); if (item) openSms(item); }} items={visible.map(item => ({ id: item.id, title: item.participantName || item.participantId, preview: item.lastMessage || 'Media message', meta: when(item.lastMessageAt), status: item.blocked ? 'Opted out · replies blocked' : undefined, disabled: !!busy }))} emptyMessage={<EmptyState title={search ? 'No matching SMS replies' : 'No SMS replies yet'} description={search ? 'Clear the search or load more conversations.' : 'Incoming messages appear here after Twilio delivers them to this app.'}/>} footer={pagination?.hasMore ? <LoadMore hasMore busy={busy === 'Loading more SMS replies'} shown={rows.length} itemLabel="conversations" label="Load more SMS conversations" unavailableReason={pagination.nextCursor ? undefined : 'Twilio has more conversations but supplied no next page.'} onLoadMore={() => smsAction('Loading more SMS replies', generation => smsList(generation, pagination.nextCursor))}/> : undefined}/>}
      detail={selected && <Stack gap={3}>
        <Text tone="muted">{conversation?.participantId} · Twilio sender {conversation?.sender}</Text>
        {blocked && <Alert tone="warning">Replies are blocked: {conversation?.blockedReason || 'This recipient has opted out of SMS.'} A reply cannot override their preference.</Alert>}
        <ConversationThread label="SMS message history" headingLevel={5} readOnly={readOnly} hasOlder={!!detail?.pagination?.hasMore} olderLoading={busy === 'Loading SMS conversation'} olderUnavailableReason={detail?.pagination?.nextCursor ? undefined : 'Twilio has older messages but supplied no earlier page.'} onLoadOlder={() => { if (detail?.pagination?.nextCursor) openSms(selected, detail.pagination.nextCursor); }} messages={[...(detail?.messages || [])].sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0)).map((item: Row): ConversationMessage => ({ id: item.id, author: item.direction === 'outgoing' ? 'Your SMS sender' : conversation?.participantName || conversation?.participantId || 'Contact', time: when(item.createdAt), dateTime: item.createdAt, visibility: 'private', direction: item.direction === 'outgoing' ? 'outbound' : 'inbound', content: <Text preserveWhitespace>{item.message || 'Media message'}</Text>, attachments: item.attachments?.length ? <Stack gap={2}>{item.attachments.map((attachment: Row, index: number) => <Attachment key={index} item={attachment} downloadUrl={`/api${path}/media/${encodeURIComponent(item.id)}/${index}`}/>)}</Stack> : undefined, status: item.deliveryStatus || item.status || undefined }))}/>
        {!readOnly && <Form aria-label="SMS reply" busy={!!busy} onSubmit={(_, event) => sendSms(event)}><Stack as="fieldset" gap={3} disabled={blocked || !status?.configured}><Field label="SMS reply" count={{ value: message, max: 1600, measure: value => value.length }}><Textarea ref={replyField} required rows={3} maxLength={1600} value={message} onChange={event => setMessage(event.target.value)}/></Field><Text tone="muted">The reply uses this conversation’s original sender. Twilio may charge for multiple SMS segments; encoding affects the segment count.</Text><FormActions><Button variant="primary" type="submit">Send SMS reply</Button></FormActions></Stack></Form>}
      </Stack>}/>
  </Stack>;
}

// Team triage overlay (server/inbox.ts item-states): Campaign's own status, waiting time and assignee per conversation.
// Neither call reaches the provider; reads take at most 100 IDs each.
// Views by state, as in Front and Intercom: Open covers open and pending; Mine and Unassigned narrow Open by assignee.
const triageFilters = [['active', 'Open'], ['mine', 'Mine'], ['unassigned', 'Unassigned'], ['snoozed', 'Snoozed'], ['resolved', 'Done']];
const triageNames: Record<string, string> = { open: 'Open', pending: 'Pending', snoozed: 'Snoozed', resolved: 'Resolved' };
// Each tab triages one item kind; comments are triaged per comment, not per post.
const triageKinds: Record<Tab, string> = { messages: 'conversation', comments: 'comment', reviews: 'review', mentions: 'mention' };
// The webhook drain's key (server/webhooks.ts): the platform thread ID when the provider reports one for a conversation,
// otherwise the provider's comment, review or mention ID.
const triageKey = (item: Row, kind = 'conversation') => String(kind === 'conversation' && item.platformConversationId || item.id);
// An item whose state has not loaded stays visible, so a failed read never hides it.
const triageVisible = (state: Row | undefined, filter: string, userId = '') => {
  if (!state || filter === 'all') return true;
  const active = state.status === 'open' || state.status === 'pending';
  return filter === 'active' ? active : filter === 'mine' ? active && !!userId && state.assigneeId === userId : filter === 'unassigned' ? active && !state.assigneeId : state.status === filter;
};
// A comment outside the filter stays when one of its replies matches, so a shown reply keeps its context.
function triageComments(rows: Row[], keep: (row: Row) => boolean, depth = 0): Row[] {
  return depth > 12 ? [] : rows.flatMap(row => { const replies = triageComments(Array.isArray(row.replies) ? row.replies : [], keep, depth + 1); return keep(row) || replies.length ? [{ ...row, replies }] : []; });
}
function waitingFor(since?: string | null, now = Date.now()) {
  const at = Date.parse(since || ''); if (!Number.isFinite(at)) return '';
  const minutes = Math.max(0, Math.floor((now - at) / 60000));
  return 'waiting ' + (minutes < 1 ? 'under 1m' : minutes < 60 ? minutes + 'm' : minutes < 2880 ? Math.floor(minutes / 60) + 'h' : Math.floor(minutes / 1440) + 'd');
}
const triageLabel = (state: Row | undefined, userId = '') => state ? [triageNames[state.status] || 'Open', state.assigneeId ? state.assigneeId === userId ? 'Assigned to you' : 'Assigned' : ''].filter(Boolean).join(' · ') : '';
// Local wall-clock time with its UTC offset, so the server stores the instant the user chose.
function localInstant(date: Date) {
  const pad = (value: number) => String(Math.abs(value)).padStart(2, '0'), offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset < 0 ? '-' : '+'}${pad(Math.trunc(offset / 60))}:${pad(offset % 60)}`;
}
function snoozeUntil(preset: string, now = new Date()) {
  const day = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 9, 0, 0);
  return localInstant(preset === 'tomorrow' ? day(1) : preset === 'week' ? day((8 - now.getDay()) % 7 || 7) : new Date(Math.floor(now.getTime() / 1000) * 1000 + 3600000));
}
// The server's rule: a time with a zone, in the future and at most 366 days ahead.
const validSnooze = (value: unknown, now = Date.now()) => validPostInstant(value) && Date.parse(value as string) > now && Date.parse(value as string) <= now + 366 * 86400000;
// A read that started before a change must not replace the newer state that change returned.
const mergeTriage = (states: Record<string, Row>, incoming: Record<string, Row>) => ({ ...states, ...Object.fromEntries(Object.entries(incoming).filter(([id, state]) => !(states[id]?.updatedAt && (!state.updatedAt || states[id].updatedAt > state.updatedAt)))) });
async function loadItemStates(request: Props['request'], path: string, accountId: string, kind: string, ids: string[]) {
  const unique = [...new Set(ids)], batches: string[][] = [];
  for (let index = 0; index < unique.length; index += 100) batches.push(unique.slice(index, index + 100));
  const results = await Promise.all(batches.map(batch => request(path + '/item-states?' + new URLSearchParams([['accountId', accountId], ['kind', kind], ...batch.map(id => ['id', id])]))));
  const states: Record<string, Row> = {};
  for (const result of results) for (const state of result?.states || []) if (state?.accountId === accountId && state.kind === kind && unique.includes(state.resourceId)) states[state.resourceId] = state;
  return states;
}

const snoozePresets = [['hour', '1 hour from now'], ['tomorrow', 'Tomorrow, 9 AM'], ['week', 'Next week, Monday 9 AM']];
// Members are the project's assignable people (editors and above); without them only Assign to me and Unassign are offered.
// Mentions have no inbound webhook, so they never show a waiting time.
function TriageControls({ state, error, readOnly, busy, userId, members = [], kind = 'conversation', onChange }: { state?: Row; error?: string; readOnly: boolean; busy: boolean; userId: string; members?: Row[]; kind?: string; onChange: (change: Row) => void }) {
  const [preset, setPreset] = useState('hour'), [assignTo, setAssignTo] = useState(''), status = state?.status;
  const assignee = !state?.assigneeId ? 'Unassigned' : state.assigneeId === userId ? 'Assigned to you' : 'Assigned to ' + (members.find(member => member.id === state.assigneeId)?.name || 'a teammate');
  const others = members.filter(member => member.id !== state?.assigneeId);
  return <Stack as="section" aria-label="Team triage" gap={2}>
    <Text>{state ? [`Triage: ${triageNames[status] || 'Open'}${status === 'snoozed' && state.snoozedUntil ? ' until ' + when(state.snoozedUntil) : ''}`, kind === 'mention' ? '' : waitingFor(state.waitingSince), assignee].filter(Boolean).join(' · ') : error ? `Triage status is unavailable. Refresh the ${kind}s to try again.` : 'Loading triage status…'}</Text>
    {state && !readOnly && <Inline gap={2} align="end">
      {status !== 'open' && <Button variant="secondary" size="sm" disabled={busy} onClick={() => onChange({ status: 'open' })}>{status === 'pending' ? 'Mark open' : 'Reopen'}</Button>}
      {status !== 'pending' && <Button variant="secondary" size="sm" disabled={busy} onClick={() => onChange({ status: 'pending' })}>Mark pending</Button>}
      {status !== 'resolved' && <Button variant="secondary" size="sm" disabled={busy} onClick={() => onChange({ status: 'resolved' })}>Resolve</Button>}
      <Field label="Snooze until"><Select disabled={busy} value={preset} onChange={event => setPreset(event.target.value)}>{snoozePresets.map(([value, label]) => <Option key={value} value={value}>{label}</Option>)}</Select></Field>
      <Button variant="secondary" size="sm" disabled={busy} onClick={() => onChange({ status: 'snoozed', snoozedUntil: snoozeUntil(preset) })}>Snooze</Button>
      {userId && state.assigneeId !== userId && <Button variant="secondary" size="sm" disabled={busy} onClick={() => onChange({ assigneeId: userId })}>Assign to me</Button>}
      {state.assigneeId && <Button variant="secondary" size="sm" disabled={busy} onClick={() => onChange({ assigneeId: null })}>Unassign</Button>}
      {others.length > 0 && <><Field label="Assign to"><Select disabled={busy} value={others.some(member => member.id === assignTo) ? assignTo : ''} onChange={event => setAssignTo(event.target.value)}><Option value="">Choose a teammate</Option>{others.map(member => <Option key={member.id} value={member.id}>{member.id === userId ? member.name + ' (you)' : member.name}</Option>)}</Select></Field>
      <Button variant="secondary" size="sm" disabled={busy || !others.some(member => member.id === assignTo)} onClick={() => onChange({ assigneeId: assignTo })}>Assign</Button></>}
    </Inline>}
  </Stack>;
}

// Internal team notes (server/inbox.ts item-notes): kept in Campaign and never sent to the provider. Viewers read them,
// editors add them, and the author or an owner or administrator deletes one. An item's notes load only when its section opens.
const noteManagers = ['owner', 'admin'];
const validNote = (note: unknown): note is Row => typeof (note as Row)?.id === 'string' && typeof (note as Row).body === 'string';
async function loadItemNotes(request: Props['request'], path: string, accountId: string, kind: string, resourceId: string) {
  const result = await request(path + '/item-notes?' + new URLSearchParams({ accountId, kind, resourceId }));
  if (!Array.isArray(result?.notes)) throw new Error('The notes response could not be read. Try again.');
  return { notes: result.notes.filter(validNote) as Row[], truncated: result.truncated === true };
}
type NoteProps = { path: string; request: Props['request']; accountId: string; kind: string; resourceId: string; readOnly: boolean; role?: string; userId: string; busy: boolean; defaultOpen?: boolean; run: (label: string, change: (generation: number) => Promise<void>) => Promise<void>; onNotice: (notice: string) => void; onDraftChange?: (text: string) => void };
function ItemNotes({ path, request, accountId, kind, resourceId, readOnly, role, userId, busy, defaultOpen = false, run, onNotice, onDraftChange }: NoteProps) {
  const [open, setOpen] = useState(defaultOpen), [notes, setNotes] = useState<Row[] | null>(null), [loadError, setLoadError] = useState(''), [text, setText] = useState(''), [removing, setRemoving] = useState<Row | null>(null), [truncated, setTruncated] = useState(false);
  // `scope` changes with the item and on unmount; `reads` orders reads so an older read never replaces a newer list;
  // `loaded` is the item last read, so each item is read once when opened and a failed read waits for the user.
  const scope = useRef(0), reads = useRef(0), loaded = useRef(''), noteId = useRef(''), manager = noteManagers.includes(role || '');
  useEffect(() => { scope.current++; setNotes(null); setLoadError(''); setText(''); setRemoving(null); return () => { scope.current++; }; }, [accountId, kind, resourceId]);
  // An unsent note counts as a draft, so leaving the item asks first like an unsent reply.
  useEffect(() => { onDraftChange?.(text); noteId.current = ''; }, [text]);
  useEffect(() => () => onDraftChange?.(''), []);
  useEffect(() => { const item = JSON.stringify([accountId, kind, resourceId]); if (open && loaded.current !== item) { loaded.current = item; void load(); } }, [open, accountId, kind, resourceId]);
  async function load() {
    const current = scope.current, read = ++reads.current; setLoadError('');
    try { const found = await loadItemNotes(request, path, accountId, kind, resourceId); if (current === scope.current && read === reads.current) { setNotes(found.notes); setTruncated(found.truncated); } }
    catch (failure) { if (current === scope.current && read === reads.current) setLoadError((failure as Error).message || 'Notes could not be loaded.'); }
  }
  // The shared action lock allows one add at a time. The note id is chosen here and kept until the text changes or the add
  // succeeds, so adding the same note again after a lost response returns the saved note instead of a second copy.
  async function add(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (readOnly || notes === null || !text.trim() || text.trim().length > 4000) return;
    noteId.current ||= crypto.randomUUID();
    const current = scope.current, body = { id: noteId.current, accountId, kind, resourceId, body: text };
    await run('Adding note', async () => {
      const result = await request(path + '/item-notes', 'POST', body);
      if (current !== scope.current) return;
      if (!validNote(result?.note)) { void load(); throw new Error('The note response could not be read. The notes are being reloaded; check them before adding it again.'); }
      reads.current++; noteId.current = ''; setText(''); setNotes(previous => merge(previous || [], [result.note])); onNotice('Note added.');
    });
  }
  async function remove(note: Row) {
    const current = scope.current;
    await run('Deleting note', async () => {
      try { const result = await request(path + '/item-notes/' + encodeURIComponent(note.id), 'DELETE'); if (result?.deleted !== true) throw new Error('The delete response could not be read. Reload the notes to check.'); }
      catch (failure) { if ((failure as Row).code === 'INBOX_NOTE_NOT_FOUND' && current === scope.current) await load(); throw failure; }
      if (current !== scope.current) return;
      reads.current++; setNotes(previous => (previous || []).filter(row => row.id !== note.id)); onNotice('Note deleted.');
    });
  }
  return <Disclosure variant="plain" open={open} onOpenChange={setOpen} summary={'Internal notes, visible only to your team' + (notes?.length ? ` (${notes.length})` : '')}><Stack as="section" aria-label="Internal notes" gap={3}>
    {!loadError && truncated && !!notes?.length && <Text tone="muted" size="sm">Only the newest {notes.length} notes are shown.</Text>}
    {loadError ? <Alert tone="danger" variant="inline"><Stack gap={2}><Text>{loadError}</Text><Inline><Button variant="secondary" size="sm" onClick={() => { void load(); }}>Load notes again</Button></Inline></Stack></Alert> : notes === null ? <StatusLine busy>Loading notes…</StatusLine> : notes.length ? <Stack as="ol" gap={3}>{notes.map(note => <Stack as="li" key={note.id} gap={1}>
      <Inline gap={2}><Text size="sm">{note.authorName || 'Former team member'}</Text><Text as="time" size="sm" tone="muted" dateTime={note.createdAt}>{when(note.createdAt)}</Text></Inline>
      <Text preserveWhitespace>{note.body}</Text>
      {!readOnly && (manager || !!userId && note.authorId === userId) && <Inline><Button variant="danger" size="sm" disabled={busy} onClick={() => setRemoving(note)}>Delete note</Button></Inline>}
    </Stack>)}</Stack> : <EmptyState title="No internal notes yet" description={readOnly ? `Your team has not added notes to this ${kind}.` : `Add context for your team. Notes stay in Campaign and are never sent to the ${kind}’s platform.`}/>}
    {!readOnly && notes !== null && <Form aria-label="Add an internal note" busy={busy} onSubmit={(_, event) => add(event)}><Field label="New internal note" count={{ value: text, max: 4000, measure: value => value.length }}><Textarea required rows={3} maxLength={4000} value={text} onChange={event => setText(event.target.value)}/></Field><FormActions><Button variant="primary" type="submit" disabled={busy || !text.trim()}>Add note</Button></FormActions></Form>}
    {!readOnly && <ConfirmDialog open={!!removing} onOpenChange={next => { if (!next) setRemoving(null); }} title="Delete this internal note?" description="The note is removed for your whole team. This cannot be undone." confirmLabel="Delete note" danger onConfirm={() => removing ? remove(removing) : undefined}/>}
  </Stack></Disclosure>;
}

export default function UnifiedInbox(props: Props) {
  const [tab, setTab] = useState<Tab | 'sms'>(props.initialChannel === 'sms' ? 'sms' : 'messages');
  const draft = useRef(''), switching = useRef(false), [switchBusy, setSwitchBusy] = useState(false), [pendingSwitch, setPendingSwitch] = useState<{ snapshot: string; change: () => void | Promise<void> } | null>(null);
  function reportDraft(snapshot: string, busy = false) { if (draft.current !== snapshot || busy) setPendingSwitch(null); draft.current = snapshot; switching.current = busy; setSwitchBusy(busy); props.onDraftChange?.(!!snapshot); }
  function requestSwitch(change: () => void | Promise<void>) { if (switching.current) return; if (draft.current) setPendingSwitch({ snapshot: draft.current, change }); else return change(); }
  function keepEditing() { setPendingSwitch(null); }
  function discardAndSwitch() { const target = pendingSwitch; setPendingSwitch(null); if (!switching.current && target?.snapshot === draft.current) return target.change(); }
  const draftChanged = useRef(props.onDraftChange); draftChanged.current = props.onDraftChange;
  useEffect(() => () => draftChanged.current?.(false), []);
  return <Stack gap={4}>{pendingSwitch && <Alert tone="warning" role="alert" aria-label="Unsaved inbox reply" title="Discard your unsent reply and switch?"><Stack gap={2}><Text>Your text, attachments and reply options will be lost.</Text><FormActions><Button variant="secondary" autoFocus onClick={keepEditing}>Keep editing</Button><Button variant="danger" onClick={discardAndSwitch}>Discard and switch</Button></FormActions></Stack></Alert>}<Tabs label="Inbox channels" keepMounted={false} value={tab} onValueChange={item => { if (tab !== item) requestSwitch(() => { reportDraft(''); setTab(item as Tab | 'sms'); }); }} items={[...tabs, 'sms' as const].map(item => ({ value: item, label: item === 'sms' ? 'SMS' : title(item), disabled: switchBusy, content: tab !== item ? undefined : item === 'sms' ? <SmsInbox {...props} onDraftChange={reportDraft} onSwitch={requestSwitch} key={props.projectId + ':sms'}/> : <ZernioInbox {...props} onDraftChange={reportDraft} onSwitch={requestSwitch} tab={item} key={props.projectId + ':' + item}/> }))}/></Stack>;
}
function commentsWithDepth(rows: Row[], depth = 0): Row[] { return depth > 12 ? [] : rows.flatMap(row => [{ ...row, depth }, ...commentsWithDepth(Array.isArray(row.replies) ? row.replies : [], depth + 1)]); }
type InboxKey = 'j' | 'k' | 'e' | 'r';
// Front-style keys: j and k open the next and previous item, e marks it done and r moves to the reply. Keys typed into a
// field or a dialog, composed text and modified keys are left alone; the page owns any guard each key needs.
function InboxShortcuts({ onKey }: { onKey: (key: InboxKey) => void }) {
  const latest = useRef(onKey); latest.current = onKey;
  useEffect(() => {
    const listen = (event: KeyboardEvent) => {
      const target = event.target as Element | null;
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || !['j', 'k', 'e', 'r'].includes(event.key) || target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], dialog')) return;
      event.preventDefault(); latest.current(event.key as InboxKey);
    };
    document.addEventListener('keydown', listen); return () => document.removeEventListener('keydown', listen);
  }, []);
  return null;
}
function privateMessageLimit(capabilities: Row, platform: string, attachmentUrl: string) {
  const maximum = Number.isSafeInteger(capabilities.messageLimit) && capabilities.messageLimit > 0 ? capabilities.messageLimit : 10000;
  return attachmentUrl && platform === 'tiktok' ? 0 : attachmentUrl && ['telegram', 'whatsapp'].includes(platform) ? Math.min(maximum, 1024) : maximum;
}
function Attachment({ item, downloadUrl }: { item: Row; downloadUrl?: string }) {
  const url = downloadUrl || link(item.url || item.downloadUrl || item.mediaUrl);
  if (!url) return <Text tone="muted">{item.type || 'Attachment'}: no public preview is available.</Text>;
  const providerLogin = !downloadUrl && new URL(url).hostname === 'api.twilio.com', name = item.name || item.filename || item.type || 'attachment';
  return <Stack gap={1}>{!downloadUrl && !providerLogin && (['image', 'sticker'].includes(item.type) ? <Image src={url} alt={item.name || item.filename || 'Message attachment'} referrerPolicy="no-referrer" fallback="This image could not be shown. Open it from the link below."/> : item.type === 'video' ? <MediaPlayer kind="video" label={item.name || item.filename || 'Video attachment'} src={url}/> : item.type === 'audio' ? <MediaPlayer kind="audio" label={item.name || item.filename || 'Audio attachment'} src={url} preload="none"/> : null)}<Link href={url} target="_blank" rel="noreferrer">{downloadUrl ? 'Download' : 'Open'} {name}</Link>{providerLogin && <Text tone="muted">This provider file may require Twilio account access.</Text>}</Stack>;
}

function InboxAttachment({ item, target, accountId, request, busy }: { item: Row; target: string; accountId: string; request: Props['request']; busy: boolean }) {
  const [resolved, setResolved] = useState<Row | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), generation = useRef(0);
  useEffect(() => { generation.current++; setResolved(null); setError(''); setLoading(false); return () => { generation.current++; }; }, [target, accountId]);
  async function load() {
    if (loading || busy) return;
    const current = generation.current; setLoading(true); setError('');
    try {
      const result = await request(target + '?' + new URLSearchParams({ accountId })), media = result.attachment, expectedDownload = `/api${target}?${new URLSearchParams({ accountId, download: '1' })}`;
      if (!media || media.type !== item.type || typeof media.refreshed !== 'boolean' || Boolean(media.url) === Boolean(media.downloadUrl) || media.url && !link(media.url) || media.downloadUrl && media.downloadUrl !== expectedDownload) throw new Error('The attachment response could not be verified.');
      if (current === generation.current) setResolved(media);
    } catch (failure) { if (current === generation.current) setError((failure as Error).message || 'This attachment is unavailable.'); }
    finally { if (current === generation.current) setLoading(false); }
  }
  return <Stack gap={1}><Inline><Button variant="secondary" size="sm" disabled={loading || busy} onClick={load}>{loading ? 'Loading attachment…' : resolved ? 'Refresh attachment link' : 'Load ' + (item.filename || item.name || item.type || 'attachment')}</Button></Inline>{error && <Alert tone="danger" variant="inline">{error}</Alert>}{resolved && <Attachment key={resolved.url || resolved.downloadUrl} item={{ ...item, url: resolved.url }} downloadUrl={resolved.downloadUrl}/>}<Text size="sm" tone="muted">Provider files can expire or become unavailable. Loading a file does not mark the conversation read.</Text></Stack>;
}

function MessageActions({ item, readOnly, busy, platform, onAction }: { item: Row; readOnly: boolean; busy: boolean; platform: string; onAction: (kind: string, item: Row) => void }) {
  const actions = item.actions || {};
  return <Stack gap={2}>
    {!item.isDeleted && (item.reactions || []).length > 0 && <Text size="sm" tone="muted">{item.reactions.map((reaction: Row) => `${reaction.emoji}${reaction.fromMe === true ? ' · Your reaction' : reaction.fromMe === false ? ' · Contact reaction' : ' · Sender not reported'}`).join(' / ')}</Text>}
    {!item.isDeleted && item.editHistory?.length > 0 && <Disclosure variant="plain" summary={`Previous message versions (${item.editHistory.length})`}><Stack gap={2}>{item.editHistory.map((entry: Row, index: number) => <Blockquote key={index} source={when(entry.editedAt)}><Text preserveWhitespace>{entry.text || 'No previous text'}</Text></Blockquote>)}</Stack></Disclosure>}
    {!readOnly && (actions.canEdit || actions.canDelete || actions.canReact || actions.canUnreact) && <Inline gap={2}>
      {actions.canEdit && <Button variant="secondary" size="sm" disabled={busy} onClick={() => onAction('edit', item)}>Edit text</Button>}
      {actions.canDelete && <Button variant="danger" size="sm" disabled={busy} onClick={() => onAction('delete', item)}>{actions.deleteScope === 'self' ? 'Remove from my view' : actions.deleteScope === 'unsend' ? 'Unsend message' : 'Delete message'}</Button>}
      {actions.canReact && <Button variant="secondary" size="sm" disabled={busy} onClick={() => onAction('react', item)}>React</Button>}
      {actions.canUnreact && <Button variant="secondary" size="sm" disabled={busy} onClick={() => onAction('unreact', item)}>Remove my reaction</Button>}
    </Inline>}
    {!readOnly && platform === 'imessage' && item.direction === 'outgoing' && !item.isDeleted && <Text size="sm" tone="muted">iMessage: edit within 15 minutes; unsend within 2 minutes. Refresh to check the remaining window.</Text>}
  </Stack>;
}

function PrivateCommentReply({ target, current, busy, onSend, onCancel, onDraftChange }: { target: Row; current?: Row; busy: boolean; onSend: (body: Row) => Promise<void>; onCancel: () => void; onDraftChange?: (snapshot: string) => void }) {
  const [message, setMessage] = useState(''), [mode, setMode] = useState('text'), [elements, setElements] = useState<Row[]>([]), [confirmed, setConfirmed] = useState('');
  const review = JSON.stringify([target.accountId, target.postId, target.id, target.privateReplyVersion, message, mode, elements]), eligible = current?.privateReplyEligible === true && current.privateReplyVersion === target.privateReplyVersion;
  const limit = target.platform === 'instagram' ? 1000 : 2000;
  useEffect(() => { onDraftChange?.(JSON.stringify([message, mode, elements, confirmed])); }, [message, mode, elements, confirmed]);
  function update(index: number, values: Row) { setElements(previous => previous.map((row, position) => position === index ? { ...row, ...values } : row)); }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !eligible || confirmed !== review || !message.trim() || message.length > limit || mode !== 'text' && !elements.length) return;
    await onSend({ accountId: target.accountId, postId: target.postId, commentId: target.id, expectedCommentVersion: target.privateReplyVersion, message, confirmSend: true, ...(mode === 'text' ? {} : { [mode]: elements }) });
  }
  const optionNoun = mode === 'buttons' ? 'button' : 'quick reply', valueField = (row: Row) => row.type === 'url' ? 'url' : row.type === 'phone' ? 'phone' : 'payload';
  return <Card as="section" headingLevel={5} title="Private reply to a comment" description={`To ${target.from?.name || target.from?.username || 'this commenter'} on ${title(target.platform)}.`}><Form aria-label="Private reply to a comment" busy={busy} onSubmit={(_, event) => submit(event)}>
    <Blockquote source="Comment"><Text preserveWhitespace>{target.message || 'Comment without text'}</Text></Blockquote>
    <Text tone="muted">One private reply per comment, within seven days. This opens a private conversation; a comment does not grant marketing permission. Delivery is subject to Meta permissions and Inbox access.</Text>
    {!eligible && <Alert tone="danger">This comment changed, is no longer eligible or already has a private reply recorded. Cancel and review the refreshed thread.</Alert>}
    <Field label="Your private message" count={{ value: message, max: limit, measure: value => value.length }}><Textarea required rows={4} maxLength={limit} value={message} onChange={event => setMessage(event.target.value)}/></Field>
    <Field label="Message options"><Select value={mode} onChange={event => { setMode(event.target.value); setElements([]); }}><Option value="text">Text only</Option><Option value="buttons">Inline buttons</Option><Option value="quickReplies">Quick replies</Option></Select></Field>
    {mode !== 'text' && <FieldList legend={mode === 'buttons' ? 'Inline buttons' : 'Quick replies'} description={`${mode === 'buttons' ? 'Up to three inline buttons.' : 'Up to thirteen quick replies; these do not display in Instagram Message Requests.'} Instagram may refuse interactive content to non-followers and still consume the comment’s single private reply. Use text only when the follow relationship is unknown.`} name={mode} items={elements} getKey={row => String(elements.indexOf(row))} max={mode === 'buttons' ? 3 : 13} addLabel={`Add ${optionNoun}`} removeLabel={index => `Remove ${optionNoun} ${index + 1}`} onAdd={() => setElements(previous => [...previous, mode === 'buttons' ? { type: 'url', title: '', url: '' } : { title: '', payload: '' }])} onRemove={index => setElements(previous => previous.filter((_, position) => position !== index))} renderItem={(row, index) => <FormGrid>
      {mode === 'buttons' && <Field label={`Button ${index + 1} action`}><Select value={row.type} onChange={event => setElements(previous => previous.map((item, position) => position === index ? { title: item.title, type: event.target.value, [event.target.value === 'url' ? 'url' : event.target.value === 'phone' ? 'phone' : 'payload']: '' } : item))}><Option value="url">Open a link</Option><Option value="postback">Send a response</Option>{target.platform === 'facebook' && <Option value="phone">Call a phone number</Option>}</Select></Field>}
      <Field label={`${mode === 'buttons' ? 'Button' : 'Quick reply'} ${index + 1} label`}><Input required maxLength={20} value={row.title} onChange={event => update(index, { title: event.target.value })}/></Field>
      <Field label={row.type === 'url' ? 'Public HTTPS link' : row.type === 'phone' ? 'International phone number' : 'Response value'}><Input required type={row.type === 'url' ? 'url' : row.type === 'phone' ? 'tel' : 'text'} maxLength={row.type === 'phone' ? 16 : 1000} pattern={row.type === 'url' ? 'https://.+' : row.type === 'phone' ? '\\+[1-9][0-9]{6,14}' : undefined} value={row[valueField(row)] || ''} onChange={event => update(index, { [valueField(row)]: event.target.value })}/></Field>
      {mode === 'quickReplies' && <Field label="Thumbnail HTTPS link (optional)"><Input type="url" pattern="https://.+" value={row.imageUrl || ''} onChange={event => { const value = event.target.value; setElements(previous => previous.map((item, position) => { if (position !== index) return item; const { imageUrl: _old, ...rest } = item; return value ? { ...rest, imageUrl: value } : rest; })); }}/></Field>}
    </FormGrid>}/>}
    <ContentPreview chrome="message" label="Private message preview" destination={target.from?.name || target.from?.username || 'Commenter'} provider={title(target.platform)} text={<Text preserveWhitespace>{message || 'Write a message to preview it.'}</Text>} footer={elements.length > 0 && <Stack gap={1}>{elements.map((row, index) => <Text key={index}>{row.title || 'Unlabelled option'}{row.type === 'url' ? ` · ${row.url || 'Link required'}` : row.type === 'phone' ? ` · ${row.phone || 'Phone number required'}` : ''}</Text>)}</Stack>}/>
    <Checkbox required checked={confirmed === review} onChange={event => setConfirmed(event.target.checked ? review : '')} label="I reviewed this commenter, account and private message and want to send it now."/>
    <FormActions><Button variant="primary" type="submit" disabled={!eligible || confirmed !== review || mode !== 'text' && !elements.length}>Send private reply</Button><Button variant="secondary" onClick={onCancel}>Cancel</Button></FormActions>
  </Form></Card>;
}

const linkedInReactions: Record<string, string> = { LIKE: 'Like', PRAISE: 'Celebrate', EMPATHY: 'Love', INTEREST: 'Insightful', APPRECIATION: 'Support', ENTERTAINMENT: 'Funny' };
function LinkedInCommentReaction({ comment, busy, onChange }: { comment: Row; busy: boolean; onChange: (kind: string, comment: Row, reactionType?: string) => Promise<void> }) {
  const [reactionType, setReactionType] = useState('');
  return <Form aria-label="LinkedIn reaction" busy={busy} gap={2} onSubmit={() => { if (reactionType) return onChange('like', comment, reactionType); }}><Inline align="end" gap={2}><Field label="LinkedIn reaction"><Select required disabled={busy} value={reactionType} onChange={event => setReactionType(event.target.value)}><Option value="">Choose a reaction</Option>{Object.entries(linkedInReactions).map(([value, label]) => <Option key={value} value={value}>{label}</Option>)}</Select></Field><Button variant="secondary" size="sm" type="submit" disabled={busy || !reactionType}>Add reaction</Button>{comment.isLiked && <Button variant="secondary" size="sm" disabled={busy} onClick={() => onChange('unlike', comment)}>Remove reaction</Button>}</Inline><Text size="sm" tone="muted">{comment.isLiked ? 'Current reaction type is unknown. A different existing reaction must be removed explicitly first.' : 'Live comments do not report the current reaction type.'}</Text></Form>;
}
function ZernioInbox({ projectId, request, readOnly = false, role, initialChannel, initialAccountId, initialSearch, tab = 'messages', onDraftChange, onSwitch, onOpenIntegrations }: Omit<Props, 'onDraftChange'> & SelectionProps & { tab?: Tab }) {
  const path = `/projects/${encodeURIComponent(projectId)}/integrations/inbox`, requester = useRef(request), version = useRef(0), pending = useRef(false), revision = useRef(0), keys = useRef(new Map<string, string>());
  requester.current = request;
  const [status, setStatus] = useState<Row | null>(null), [accounts, setAccounts] = useState<Row[]>([]), [accountId, setAccountId] = useState(''), [platform, setPlatform] = useState(''), [conversationStatus, setConversationStatus] = useState('active');
  const [rows, setRows] = useState<Row[]>([]), [pagination, setPagination] = useState<Row | null>(null), [meta, setMeta] = useState<Row | null>(null), [loaded, setLoaded] = useState(false), [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Row | null>(null), [detail, setDetail] = useState<Row | null>(null), [focusedComment, setFocusedComment] = useState(''), [replyTarget, setReplyTarget] = useState<Row | null>(null), [message, setMessage] = useState(''), [confirmReplace, setConfirmReplace] = useState(false);
  const [messageTag, setMessageTag] = useState(''), [attachmentUrl, setAttachmentUrl] = useState(''), [attachmentType, setAttachmentType] = useState('image'), [attachmentName, setAttachmentName] = useState(''), [attachmentPreview, setAttachmentPreview] = useState('');
  const [replyButtons, setReplyButtons] = useState<string[]>([]), [buttonReview, setButtonReview] = useState('');
  const [templateMode, setTemplateMode] = useState(false), [templates, setTemplates] = useState<Row[]>([]), [templateKey, setTemplateKey] = useState(''), [templateComponents, setTemplateComponents] = useState<any[]>([]);
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const account = accounts.find(item => item.id === accountId), capabilities = account?.capabilities || {}, connected = status?.configured && status?.mapped;
  const [historyQuery, setHistoryQuery] = useState(''), [historyDirection, setHistoryDirection] = useState(''), [historyFilter, setHistoryFilter] = useState<Row | null>(null);
  const [reviewFilters, setReviewFilters] = useState<Record<string, string>>({});
  const [starting, setStarting] = useState(false), [recipients, setRecipients] = useState<Row[]>([]), [recipient, setRecipient] = useState(''), [openingMessage, setOpeningMessage] = useState('');
  const [openingTemplates, setOpeningTemplates] = useState<Row[]>([]), [openingTemplateKey, setOpeningTemplateKey] = useState(''), [openingTemplateComponents, setOpeningTemplateComponents] = useState<any[]>([]);
  const [folder, setFolder] = useState('inbox'), [messageActionTarget, setMessageActionTarget] = useState<Row | null>(null), [actionText, setActionText] = useState(''), [actionEmoji, setActionEmoji] = useState('👍');
  const [controlAction, setControlAction] = useState(''), [targetAppId, setTargetAppId] = useState('263902037430900'), [controlNote, setControlNote] = useState('');
  const [typingReview, setTypingReview] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Row | null>(null), [confirming, setConfirming] = useState<Row | null>(null);
  const [privateReplyTarget, setPrivateReplyTarget] = useState<Row | null>(null), [privateDraft, setPrivateDraft] = useState('');
  const [commentEdit, setCommentEdit] = useState<Row | null>(null);
  const [triage, setTriage] = useState<{ accountId: string; kind: string; states: Record<string, Row>; error: string }>({ accountId: '', kind: '', states: {}, error: '' }), [triageFilter, setTriageFilter] = useState('active'), [userId, setUserId] = useState(''), [assignees, setAssignees] = useState<Row[]>([]);
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const triageKind = triageKinds[tab], triageScoped = triage.accountId === accountId && triage.kind === triageKind, states = triageScoped ? triage.states : {}, triageError = triageScoped ? triage.error : '';
  const access = useRef(readOnly);
  // One item's internal notes, scoped by account, kind and resource so another item's notes are never shown.
  const notesFor = (kind: string, resourceId: string, defaultOpen = false) => <ItemNotes key={JSON.stringify([accountId, kind, resourceId])} path={path} request={requester.current} accountId={accountId} kind={kind} resourceId={resourceId} readOnly={readOnly} role={role} userId={userId} busy={!!busy} defaultOpen={defaultOpen} run={action} onNotice={setNotice} onDraftChange={text => setNoteDrafts(previous => { const key = JSON.stringify([accountId, kind, resourceId]); if ((previous[key] || '') === text) return previous; const { [key]: _previous, ...rest } = previous; return text ? { ...rest, [key]: text } : rest; })}/>;
  const openingTemplate = openingTemplates.find(item => JSON.stringify([item.name, item.language || item.languageCode]) === openingTemplateKey);
  const canReply = tab === 'mentions' ? false : tab === 'messages' ? capabilities.reply : tab === 'comments' ? capabilities.commentReply : capabilities.reviewReply;
  const messageLimit = privateMessageLimit(capabilities, account?.platform || '', attachmentUrl);
  const selectedTemplate = templates.find(item => JSON.stringify([item.name, item.language || item.languageCode]) === templateKey);
  const supported = accounts.filter(item => !!item.capabilities?.[tab] && (!platform || item.platform === platform));
  // Comments tab rows are posts; its comments are filtered inside the open thread instead.
  const visibleRows = historyFilter ? rows : rows.filter(row => conversationMatches(row, search) && (tab === 'comments' || triageVisible(states[triageKey(row, triageKind)], triageFilter, userId)));
  const threadRows = detail?.parent && focusedComment ? [{ ...detail.parent, depth: 0 }, ...commentsWithDepth(detail.comments || [], 1)] : commentsWithDepth(detail?.comments || []);
  const retainedButtonReply = account?.platform === 'whatsapp' && selected ? [...keys.current.keys()].map(signature => JSON.parse(signature)).find(([scope, suffix, body]) => scope === path && suffix === 'conversations/' + encodeURIComponent(selected.id) + '/reply' && body.accountId === accountId && Array.isArray(body.buttons))?.[2] : undefined;
  const buttonScope = useRef({ key: '', generation: 0 });
  const buttonScopeKey = JSON.stringify([projectId, accountId, account?.platform, tab, selected?.id, readOnly, version.current, message, replyButtons, templateMode, attachmentUrl, messageTag]);
  const buttonGeneration = buttonScope.current.generation + (buttonScope.current.key === buttonScopeKey ? 0 : 1);
  const buttonReviewKey = JSON.stringify([buttonScopeKey, buttonGeneration]);
  useLayoutEffect(() => { Object.assign(buttonScope.current, { key: buttonScopeKey, generation: buttonGeneration }); return () => { buttonScope.current.generation++; }; }, [buttonScopeKey, buttonGeneration]);
  const commentScope = useRef({ key: '', generation: 0, rows: threadRows, readOnly, edit: commentEdit });
  const commentScopeKey = JSON.stringify([projectId, accountId, account?.platform, tab, selected?.id, focusedComment, readOnly, version.current]);
  const commentGeneration = commentScope.current.generation + (commentScope.current.key === commentScopeKey ? 0 : 1);
  useLayoutEffect(() => { Object.assign(commentScope.current, { key: commentScopeKey, generation: commentGeneration, rows: threadRows, readOnly, edit: commentEdit }); });
  const appliedReviewFilters = [
    ...(reviewFilters.minRating ? [{ id: 'minRating', label: 'Minimum rating', value: reviewFilters.minRating + '/5' }] : []),
    ...(reviewFilters.maxRating ? [{ id: 'maxRating', label: 'Maximum rating', value: reviewFilters.maxRating + '/5' }] : []),
    ...(['true', 'false'].includes(reviewFilters.hasReply) ? [{ id: 'hasReply', label: 'Reply status', value: reviewFilters.hasReply === 'false' ? 'Without a reply' : 'With a reply' }] : []),
    ...(reviewFilters.sortBy === 'rating' ? [{ id: 'sortBy', label: 'Review sort', value: 'Rating' }] : []),
    ...(reviewFilters.sortOrder === 'asc' ? [{ id: 'sortOrder', label: 'Sort direction', value: 'Ascending' }] : []),
  ];

  const replyDraft = !!(message || replyButtons.length || buttonReview || retainedButtonReply || attachmentUrl || attachmentName || attachmentType !== 'image' || messageTag || templateMode || templateKey || templateComponents.length || replyTarget || privateReplyTarget || commentEdit || messageActionTarget || controlAction || controlNote);
  const draftSnapshot = Object.keys(noteDrafts).length || replyDraft || openingMessage || recipient || openingTemplateKey || openingTemplateComponents.length
    ? JSON.stringify([projectId, accountId, tab, selected?.id, focusedComment, message, replyButtons, buttonReview, retainedButtonReply, attachmentUrl, attachmentType, attachmentName, attachmentPreview, messageTag, templateMode, templateKey, templateComponents, replyTarget, privateReplyTarget, privateReplyTarget ? privateDraft : '', commentEdit, messageActionTarget, actionText, actionEmoji, controlAction, controlNote, targetAppId, openingMessage, recipient, openingTemplateKey, openingTemplateComponents, confirmReplace, readOnly, historyQuery, historyDirection, noteDrafts]) : '';
  useEffect(() => { onDraftChange(draftSnapshot, !!busy); }, [draftSnapshot, busy]);
  function switchSelection(change: () => void | Promise<void>) { if (pending.current) return; const generation = version.current; return onSwitch(() => { if (generation === version.current && !pending.current) return change(); }); }
  function resetTemplate() { setTemplateMode(false); setTemplateKey(''); setTemplateComponents([]); }
  function resetSelection() { setReplyButtons([]); setButtonReview(''); setSelected(null); setDetail(null); setFocusedComment(''); setReplyTarget(null); setPrivateReplyTarget(null); setCommentEdit(null); setMessage(''); setConfirmReplace(false); setMessageTag(''); setAttachmentUrl(''); setAttachmentName(''); setAttachmentType('image'); setAttachmentPreview(''); setTemplates([]); resetTemplate(); setMessageActionTarget(null); setControlAction(''); setTargetAppId('263902037430900'); setControlNote(''); setDeleteTarget(null); setTypingReview(''); }
  function resetList() { version.current++; pending.current = false; setBusy(''); setRows([]); setPagination(null); setMeta(null); setLoaded(false); resetSelection(); setFolder('inbox'); setSearch(''); setHistoryFilter(null); setHistoryQuery(''); setHistoryDirection(''); setOpeningTemplates([]); setOpeningTemplateKey(''); setOpeningTemplateComponents([]); setStarting(false); setRecipients([]); setRecipient(''); setOpeningMessage(''); setError(''); setNotice(''); }
  function changeReviewFilter(name: string, value: string) {
    if ((reviewFilters[name] || '') === value) return;
    const filters = { ...reviewFilters, [name]: value }; if (!value) delete filters[name];
    return switchSelection(() => { resetList(); setReviewFilters(filters); });
  }
  useEffect(() => {
    const generation = ++version.current; pending.current = false; keys.current.clear(); setStatus(null); setAccounts([]); setAccountId(''); setPlatform(''); setFolder('inbox'); setReviewFilters({}); setRows([]); setPagination(null); setLoaded(false); setMeta(null); resetSelection(); setSearch(''); setError(''); setNotice(''); setBusy('Loading connections');
    requester.current(path + '/status').then(async result => {
      if (generation !== version.current) return; setStatus(result); setAccounts(result.accounts || []);
      if (tab === 'messages' && initialChannel === 'whatsapp') {
        setPlatform('whatsapp'); setSearch(initialSearch || '');
        const account = (result.accounts || []).find((item: Row) => item.id === initialAccountId && item.platform === 'whatsapp' && item.capabilities?.messages);
        if (!account) { if (initialAccountId) setError('This campaign’s WhatsApp account is unavailable. Choose a connected WhatsApp account before loading replies.'); return; }
        setAccountId(account.id);
        const list = await requester.current(path + '/conversations?' + new URLSearchParams({ accountId: account.id, status: 'active' }));
        if (generation !== version.current) return; setRows(list.conversations || []); setPagination(list.pagination || null); setMeta(list.meta || null); setLoaded(true);
      }
    }).catch(failure => { if (generation === version.current) setError(failure.message); }).finally(() => { if (generation === version.current) setBusy(''); });
    return () => { version.current++; };
  }, [projectId]);
  useEffect(() => { if (access.current === readOnly) return; access.current = readOnly; version.current++; pending.current = false; setBusy(''); setMessageActionTarget(null); setDeleteTarget(null); }, [readOnly]);
  useEffect(() => { setDeleteTarget(null); }, [selected?.id, accountId]);
  // The signed-in user, for Assign to me. Without it only Unassign is offered.
  // Teammates a conversation can be assigned to; the directory is for editors and above, so viewers skip it.
  useEffect(() => { setAssignees([]); if (readOnly) return; let closed = false; requester.current(`/projects/${encodeURIComponent(projectId)}/assignees`).then(result => { if (!closed && Array.isArray(result?.members)) setAssignees(result.members.filter((member: Row) => typeof member?.id === 'string' && typeof member.name === 'string')); }, () => {}); return () => { closed = true; }; }, [projectId, readOnly]);
  useEffect(() => { let closed = false; requester.current('/session').then(session => { if (!closed && typeof session?.user?.id === 'string') setUserId(session.user.id); }, () => {}); return () => { closed = true; }; }, []);
  // States for the loaded items of this tab's kind: listed conversations, reviews and mentions, or the open post's comments.
  useEffect(() => {
    const kind = triageKind, ids = tab === 'comments' ? threadRows.filter(row => typeof row.id === 'string' && row.id).map(row => row.id) : rows.map(row => triageKey(row, kind));
    if (!accountId || !ids.length) return;
    const generation = version.current, scope = accountId; let closed = false;
    const store = (change: (previous: Record<string, Row>) => Record<string, Row>, error = '') => setTriage(previous => ({ accountId: scope, kind, states: change(previous.accountId === scope && previous.kind === kind ? previous.states : {}), error }));
    loadItemStates(requester.current, path, scope, kind, ids).then(found => { if (!closed && generation === version.current) store(previous => mergeTriage(previous, found)); }, failure => { if (!closed && generation === version.current) store(previous => previous, failure.message || 'The local triage service did not respond.'); });
    return () => { closed = true; };
  }, [tab === 'comments' ? detail : rows, accountId, tab]);
  useEffect(() => {
    if (!accountId || tab === 'mentions') return;
    const generation = version.current; let closed = false, checking = false, cursor: number | undefined;
    const poll = async () => {
      if (checking || pending.current) return; checking = true; const started = revision.current;
      try {
        const result = await requester.current(path + '/updates?' + new URLSearchParams({ accountId, ...(cursor === undefined ? {} : { after: String(cursor) }) }));
        if (closed || generation !== version.current || started !== revision.current) return;
        cursor = result.cursor;
        const relevant = (result.updates || []).some((item: Row) => tab === 'messages' ? /^(message|conversation)\./.test(item.event) : tab === 'comments' ? /^comment\./.test(item.event) : /^review\./.test(item.event));
        if (relevant && loaded && !pending.current) await action('Refreshing new ' + tab, async activeGeneration => {
          if (closed || generation !== activeGeneration) return;
          await fetchList(activeGeneration);
          if (!closed && selected && tab !== 'reviews') await fetchThread(selected, activeGeneration, '', focusedComment);
          if (!closed && activeGeneration === version.current) setNotice('New activity received. The provider view has been refreshed.');
        });
      } catch { /* Manual refresh remains available when a local update check fails. */ }
      finally { checking = false; }
    };
    void poll(); const timer = window.setInterval(poll, 5000); return () => { closed = true; window.clearInterval(timer); };
  }, [projectId, accountId, tab, selected?.id, focusedComment, loaded, historyFilter, reviewFilters, readOnly]);
  const rememberFocus = useFocusReturn(busy);
  // Opening the inbox chooses the linked or first connected account and loads its list, so items show without a click.
  // Each account and filter scope loads once; Refresh reads it again. These are the reads the Load button made, and the
  // only polling stays the local update check above. A WhatsApp campaign link keeps its own account rule and never guesses.
  const replyField = useRef<HTMLTextAreaElement>(null), autoAccount = useRef(''), autoList = useRef('');
  useEffect(() => {
    const scope = JSON.stringify([tab, platform]), first = supported.find(item => item.id === initialAccountId) || supported[0];
    if (!connected || accountId || busy || !first || autoAccount.current === scope || tab === 'messages' && initialChannel === 'whatsapp') return;
    autoAccount.current = scope; setAccountId(first.id);
  }, [connected, accountId, busy, tab, platform, accounts]);
  useEffect(() => {
    const scope = JSON.stringify([accountId, tab, platform, folder, conversationStatus, reviewFilters]);
    if (!accountId || !connected || loaded || busy || historyFilter || autoList.current === scope) return;
    autoList.current = scope; void loadList();
  }, [accountId, connected, loaded, busy, historyFilter, tab, platform, folder, conversationStatus, reviewFilters]);
  function shortcut(key: InboxKey) {
    if (busy || tab !== 'messages' && tab !== 'comments') return;
    if (key === 'j' || key === 'k') {
      const index = visibleRows.findIndex(row => row.id === selected?.id), next = index < 0 ? visibleRows[0] : visibleRows[index + (key === 'j' ? 1 : -1)];
      if (next) void openItem(next);
    } else if (tab === 'messages' && key === 'e') { if (selected && !readOnly && states[triageKey(selected)] && states[triageKey(selected)].status !== 'resolved') void changeTriage(selected, { status: 'resolved' }); }
    else if (tab === 'messages') replyField.current?.focus();
  }
  // Search filters the loaded page; platform, folder and status are list scopes, so removing one reloads the list.
  function removeInboxFilter(id: string) {
    if (id === 'search') { setSearch(''); return; }
    return switchSelection(() => { resetList(); if (id === 'platform') setPlatform(''); else if (id === 'status') setConversationStatus('active'); });
  }
  function clearInboxFilters() {
    if (historyFilter) return loadList('', true);
    if (!platform && folder === 'inbox' && conversationStatus === 'active' && !Object.keys(reviewFilters).length) { setSearch(''); return; }
    return switchSelection(() => { resetList(); setPlatform(''); setConversationStatus('active'); setReviewFilters({}); });
  }
  async function action(label: string, run: (generation: number) => Promise<void>) {
    if (pending.current) return; rememberFocus(); const generation = version.current; pending.current = true; revision.current++; setBusy(label); setError(''); setNotice('');
    try { await run(generation); } catch (failure) { if (generation === version.current) setError((failure as Error).message || 'This inbox action could not be completed.'); }
    finally { if (generation === version.current) { pending.current = false; setBusy(''); } }
  }
  async function write(suffix: string, body: Row, checking = false) {
    if (readOnly) throw new Error('Your role can view this inbox but cannot send or change messages.');
    const signature = JSON.stringify([path, suffix, body]); if (!keys.current.has(signature)) keys.current.set(signature, crypto.randomUUID());
    try {
      const result = await requester.current(path + '/' + suffix + (checking ? '?check=1' : ''), 'POST', body, keys.current.get(signature));
      if (/^conversations\/[^/]+\/reply$/.test(suffix)) {
        const validId = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 2000 && !/[\s\u0000-\u001f\u007f]/.test(value);
        const partial = result?.partialFailure, combined = ['facebook', 'instagram'].includes(result?.platform) && body.attachmentUrl && body.message;
        if (result?.operation?.status !== 'complete' || result.sent !== true || result.accountId !== body.accountId || result.platform !== account?.platform || typeof result.platform !== 'string' || result.platform !== 'reddit' && !validId(result.messageId) || combined && partial === undefined && result.messageIds === undefined || partial !== undefined && (!combined || typeof partial !== 'object' || partial === null || partial.part !== 'text' || typeof partial.error !== 'string' || !partial.error.trim()) || result.messageIds !== undefined && (!combined || !Array.isArray(result.messageIds) || result.messageIds.length !== (partial ? 1 : 2) || result.messageIds.some((value: unknown) => !validId(value)) || new Set(result.messageIds).size !== result.messageIds.length || result.messageIds[0] !== result.messageId)) throw new Error('The reply receipt could not be read. Your draft and action key have been retained; check the thread before sending again.');
      }
      const messageAction = suffix.match(/\/messages\/([^/]+)\/(edit|delete|react|unreact)$/);
      if ((messageAction || suffix.endsWith('/thread-control') || suffix.endsWith('/accept')) && (result.operation?.status !== 'complete' || result.accepted !== true || messageAction && (result.messageId !== decodeURIComponent(messageAction[1]) || result.action !== messageAction[2]) || suffix.endsWith('/thread-control') && (!result.conversation?.version || !result.control?.owner) || suffix.endsWith('/accept') && (result.sent !== true || typeof result.messageId !== 'string'))) throw new Error('The inbox action receipt could not be read. Your action key has been retained; refresh before trying again.');
      const conversationAction = !messageAction && suffix.match(/^conversations\/([^/]+)\/(delete|typing)$/);
      if (conversationAction && (result.operation?.status !== 'complete' || result.accepted !== true || result.conversationId !== decodeURIComponent(conversationAction[1]) || conversationAction[2] === 'typing' && typeof result.delivered !== 'boolean' || conversationAction[2] === 'delete' && (result.deleted !== true || result.scope !== 'zernio_copy' || !Number.isSafeInteger(result.deletedMessages) || result.deletedMessages < 0))) throw new Error('The inbox action receipt could not be read. Your action key has been retained; refresh before trying again.');
      if (suffix === 'comments/edit' && (result.operation?.status !== 'complete' || result.edited !== true || result.accountId !== body.accountId || result.postId !== body.postId || result.commentId !== body.commentId || result.platform !== 'reddit' || account?.platform !== 'reddit' || result.content !== body.content || result.comment?.id !== body.commentId || result.comment?.message !== body.content || result.comment?.platform !== 'reddit' || result.comment?.from?.isOwner !== true || typeof result.comment?.editVersion !== 'string' || !/^[a-f0-9]{64}$/.test(result.comment.editVersion))) throw new Error('The comment edit receipt could not be read. Your draft and action key have been retained; check the comment before another edit.');
      if (suffix === 'comments/private-reply' && (result.operation?.status !== 'complete' || result.sent !== true || result.accountId !== body.accountId || result.postId !== body.postId || result.commentId !== body.commentId || !['facebook', 'instagram'].includes(result.platform) || result.platform !== privateReplyTarget?.platform || typeof result.messageId !== 'string' || !result.messageId || result.messageId.length > 2000 || /[\s\u0000-\u001f\u007f]/.test(result.messageId))) throw new Error('The private reply receipt could not be read. Your draft and action key have been retained; check the conversation before another send.');
      if (/^comments\/(like|unlike)$/.test(suffix) && (result.operation?.status !== 'complete' || result.accountId !== body.accountId || result.postId !== body.postId || result.commentId !== body.commentId || result.platform !== account?.platform || result.liked !== (suffix === 'comments/like') || result.alreadyReacted !== undefined && (result.platform !== 'linkedin' || suffix !== 'comments/like' || typeof result.alreadyReacted !== 'boolean') || result.platform === 'linkedin' && suffix === 'comments/like' && result.reactionType !== (body.reactionType || 'LIKE') || result.reactionType !== undefined && (result.platform !== 'linkedin' || suffix !== 'comments/like' || !Object.hasOwn(linkedInReactions, result.reactionType)))) throw new Error('The comment reaction receipt could not be read. Your action key has been retained; check the comment before trying again.');
      keys.current.delete(signature); return result;
    }
    catch (failure) { const response = failure as Error & { status?: number; code?: string; operation?: Row }; if ((!checking || response.operation?.status === 'failed') && response.status && (response.status < 500 || response.operation?.status === 'failed') && !['OPERATION_UNCERTAIN', 'OPERATION_IN_PROGRESS', 'OPERATION_PENDING'].includes(response.code || '') && (!response.operation || ['failed', 'reviewed-not-applied', 'reviewed-applied'].includes(response.operation.status))) keys.current.delete(signature); throw failure; }
  }
  async function loadAccounts() {
    // The status read reports a missing Zernio key or profile as data, which the setup warning already shows; /accounts fails with the same advice.
    await switchSelection(() => action('Loading connections', async generation => { const result = await requester.current(path + '/status'); if (generation !== version.current) return; setStatus(result); setAccounts(result.accounts || []); if (accountId && !result.accounts?.some((item: Row) => item.id === accountId && item.capabilities?.[tab])) { setAccountId(''); setRows([]); resetSelection(); } }));
  }
  async function changeTriage(item: Row, change: Row) {
    const kind = triageKind, resourceId = triageKey(item, kind), current = states[resourceId], scope = accountId, noun = kind.charAt(0).toUpperCase() + kind.slice(1);
    if (readOnly || !scope || current?.kind !== kind) return;
    if (change.status === 'snoozed' && !validSnooze(change.snoozedUntil)) { setError('Choose a snooze time in the future and within the next year.'); return; }
    const store = (found: Record<string, Row>) => setTriage(previous => ({ accountId: scope, kind, states: { ...(previous.accountId === scope && previous.kind === kind ? previous.states : {}), ...found }, error: '' }));
    await action('Updating triage status', async generation => {
      let result;
      try { result = await requester.current(path + '/item-states', 'PATCH', { accountId: scope, kind, resourceId, expectedUpdatedAt: current.updatedAt ?? null, ...change }); }
      catch (failure) {
        if ((failure as Row).code !== 'INBOX_STATE_CHANGED') throw failure;
        const fresh = await loadItemStates(requester.current, path, scope, kind, [resourceId]); if (generation === version.current) store(fresh);
        throw new Error(`This ${kind}’s triage changed elsewhere. Its latest status is shown; choose again to apply your change.`);
      }
      if (generation !== version.current) return;
      const state = result?.state;
      if (state?.accountId !== scope || state.kind !== kind || state.resourceId !== resourceId) throw new Error(`The triage response could not be read. Refresh the ${kind}s before changing it again.`);
      store({ [resourceId]: state });
      setNotice(change.assigneeId !== undefined ? change.assigneeId ? change.assigneeId === userId ? `${noun} assigned to you.` : `${noun} assigned to ${assignees.find(member => member.id === change.assigneeId)?.name || 'a teammate'}.` : `${noun} unassigned.` : change.status === 'snoozed' ? `${noun} snoozed until ${when(state.snoozedUntil)}.` : ({ open: `${noun} marked open.`, pending: `${noun} marked pending.`, resolved: `${noun} resolved.` } as Record<string, string>)[change.status] || 'Triage status updated.');
    });
  }
  async function searchHistory(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!accountId || tab !== 'messages' || pending.current) return;
    const term = historyQuery.trim(); if (term.length < 2 || term.length > 200) { setError('Enter between 2 and 200 characters to search message history.'); return; }
    const filter = { query: term, ...(historyDirection ? { direction: historyDirection } : {}) };
    await switchSelection(() => action('Searching message history', async generation => { await fetchList(generation, '', filter); if (generation === version.current) { setHistoryFilter(filter); resetSelection(); } }));
  }
  async function prepareConversation() {
    if (readOnly || !capabilities.start || !accountId) return;
    await action('Loading recipients', async generation => {
      const [result, approved] = await Promise.all([requester.current(path + '/conversations/recipients?' + new URLSearchParams({ accountId })), account?.platform === 'whatsapp' ? requester.current(`/projects/${encodeURIComponent(projectId)}/direct/templates?accountId=${encodeURIComponent(accountId)}`) : Promise.resolve(null)]);
      if (generation !== version.current) return;
      setRecipients(result.recipients || []); if (approved) setOpeningTemplates((approved.templates || []).filter((item: Row) => item.status === 'APPROVED'));
      setStarting(true);
    });
  }
  async function startConversation(confirmSend: boolean) {
    if (readOnly || !capabilities.start || !accountId || !recipient || !confirmSend) return;
    const whatsapp = account?.platform === 'whatsapp';
    if (whatsapp && (!openingTemplate || templateRestriction(openingTemplate))) { setError('Choose a supported approved template and fill its values.'); return; }
    if (!whatsapp && (!openingMessage.trim() || openingMessage.length > (capabilities.messageLimit || 10000))) { setError('Enter an opening message within this platform’s limit.'); return; }
    const body = { accountId, ...(['whatsapp', 'sms'].includes(account?.platform) ? { contactId: recipient } : account?.platform === 'slack' ? { participantId: recipient } : { participantUsername: recipient }), ...(whatsapp ? { templateName: openingTemplate!.name, templateLanguage: openingTemplate!.language || openingTemplate!.languageCode, templateComponents: openingTemplateComponents } : { message: openingMessage }), confirmSend: true };
    await action('Sending opening message', async generation => {
      const result = await write('conversations/start', body); if (generation !== version.current) return;
      setStarting(false); setRecipient(''); setOpeningMessage(''); setOpeningTemplateKey(''); setOpeningTemplateComponents([]);
      setNotice('Opening message accepted by the provider. Delivery is shown separately.');
      if (replyDraft) { setNotice('Opening message accepted by the provider. Your unfinished reply stays with its original conversation; choose the recipient’s thread to review delivery.'); return; }
      try { const conversation = await fetchThread({ id: result.conversationId, participantName: result.participantName, participantId: result.participantId, platform: result.platform }, generation); if (conversation && generation === version.current && !historyFilter && (conversation.status || 'active') === conversationStatus) setRows(previous => merge(previous, [conversation]).sort((a, b) => (Date.parse(b.lastMessageAt || b.updatedTime) || 0) - (Date.parse(a.lastMessageAt || a.updatedTime) || 0))); }
      catch { if (generation === version.current) setError('The opening message was accepted, but its thread could not be loaded. Refresh before sending anything else.'); }
    });
  }
  async function fetchList(generation: number, cursor = '', filter: Row | null = historyFilter) {
    const kind = tab === 'messages' ? filter ? 'conversations/search' : 'conversations' : tab, query = new URLSearchParams({ accountId, ...(tab === 'messages' ? filter || { status: conversationStatus, ...(folder === 'requests' ? { folder } : {}) } : tab === 'reviews' ? reviewFilters : tab === 'mentions' ? { sortOrder: 'desc' } : {}), ...(cursor ? { cursor } : {}) });
    const result = await requester.current(path + '/' + kind + '?' + query); if (generation !== version.current) return;
    const items = result[tab === 'messages' ? 'conversations' : tab === 'comments' ? 'posts' : tab === 'mentions' ? 'mentions' : 'reviews'];
    setRows(previous => cursor ? merge(previous, items || []) : items || []); setPagination(result.pagination || null); setMeta(result.meta || null); setLoaded(true);
  }
  async function loadList(cursor = '', browse = false) { if (!accountId || pending.current) return; const load = () => action('Loading ' + tab, async generation => { await fetchList(generation, cursor, browse ? null : historyFilter); if (browse && generation === version.current) { setHistoryFilter(null); resetSelection(); } }); if (browse) await switchSelection(load); else await load(); }
  async function fetchThread(item: Row, generation: number, cursor = '', commentId = '') {
    const query = new URLSearchParams({ accountId, ...(cursor ? { cursor } : {}), ...(tab === 'messages' ? { sortOrder: 'desc' } : { postId: item.id, ...(commentId ? { commentId } : {}) }) });
    const suffix = tab === 'messages' ? 'conversations/' + encodeURIComponent(item.id) + '/messages' : 'comments/thread';
    const result = await requester.current(path + '/' + suffix + '?' + query); if (generation !== version.current) return;
    setSelected(tab === 'messages' ? { ...item, ...result.conversation, id: item.id } : item); setFocusedComment(commentId); setDetail((previous: Row | null) => cursor ? { ...result, [tab === 'messages' ? 'messages' : 'comments']: merge(previous?.[tab === 'messages' ? 'messages' : 'comments'] || [], result[tab === 'messages' ? 'messages' : 'comments'] || []) } : result);
    if (tab === 'comments' && !cursor) setCommentEdit(previous => { if (!previous?.needsRefresh) return previous; const fresh = [result.parent, ...commentsWithDepth(result.comments || [])].find(row => row?.id === previous.id); return fresh?.from?.isOwner === true && fresh.editVersion ? { ...previous, ...fresh, content: previous.content, confirmed: '', needsRefresh: false } : previous; });
    return result.conversation;
  }
  async function openItem(item: Row, cursor = '', commentId = '') {
    const changing = selected?.id !== item.id || focusedComment !== commentId;
    const open = () => action('Loading ' + (tab === 'messages' ? 'conversation' : 'comments'), async generation => { await fetchThread(item, generation, cursor, commentId); if (generation === version.current && !cursor && changing) { setReplyTarget(null); setPrivateReplyTarget(null); setCommentEdit(null); setReplyButtons([]); setButtonReview(''); setMessage(''); setConfirmReplace(false); setMessageTag(''); setAttachmentUrl(''); setAttachmentName(''); setAttachmentType('image'); setAttachmentPreview(''); resetTemplate(); setMessageActionTarget(null); setControlAction(''); setTargetAppId('263902037430900'); setControlNote(''); } });
    if (!cursor && changing) await switchSelection(open); else await open();
  }
  async function refreshAfterWrite(generation: number) {
    try { if (tab === 'reviews') await fetchList(generation); else if (selected) await fetchThread(selected, generation, '', focusedComment); }
    catch { if (generation === version.current) setError('The change was confirmed, but the latest provider view could not be loaded. Refresh before another action.'); }
  }
  function prepareReply(target: Row) { if (!privateReplyTarget && !commentEdit && replyTarget?.id === target.id) return; return switchSelection(() => { setPrivateReplyTarget(null); setCommentEdit(null); setReplyTarget(target); setMessage(tab === 'reviews' ? target.reply?.text || '' : ''); setConfirmReplace(false); setError(''); setNotice(''); }); }
  async function sendPrivateCommentReply(body: Row) {
    if (readOnly || !privateReplyTarget || !selected || body.confirmSend !== true || body.accountId !== accountId || body.postId !== selected.id || body.commentId !== privateReplyTarget.id || body.expectedCommentVersion !== privateReplyTarget.privateReplyVersion) return;
    await action('Sending private comment reply', async generation => {
      try { await write('comments/private-reply', body); }
      catch (error) {
        const failure = error as Error & { status?: number; code?: string; operation?: Row }, status = failure.code === 'PRIVATE_REPLY_CONSUMED' ? 'consumed' : ['PRIVATE_REPLY_RECORDED', 'OPERATION_UNCERTAIN', 'OPERATION_IN_PROGRESS', 'OPERATION_PENDING', 'OPERATION_REVIEWED'].includes(failure.code || '') || ['pending', 'uncertain', 'reviewed-applied'].includes(failure.operation?.status) || !failure.status || failure.status >= 500 && failure.operation?.status !== 'failed' ? 'uncertain' : '';
        if (status && generation === version.current) setDetail((previous: Row | null) => {
          if (!previous) return previous;
          const mark = (row: Row): Row => ({ ...row, ...(row.id === body.commentId ? { privateReplyEligible: false, privateReplyStatus: status } : {}), ...(row.replies ? { replies: row.replies.map(mark) } : {}) });
          return { ...previous, comments: (previous.comments || []).map(mark), ...(previous.parent ? { parent: mark(previous.parent) } : {}) };
        });
        throw error;
      }
      if (generation !== version.current) return;
      setPrivateReplyTarget(null); setNotice('Private reply accepted by the provider. Check Messages for the conversation and delivery status. Marketing permission has not changed.'); await refreshAfterWrite(generation);
    });
  }
  async function loadReplyTemplates() {
    if (readOnly || account?.platform !== 'whatsapp' || !accountId || !selected) return;
    await action('Loading approved templates', async generation => {
      const result = await requester.current(`/projects/${encodeURIComponent(projectId)}/direct/templates?accountId=${encodeURIComponent(accountId)}`); if (generation !== version.current) return;
      const approved = (result.templates || []).filter((item: Row) => String(item.status || '').toLowerCase() === 'approved'); setTemplates(approved); setTemplateKey(''); setTemplateComponents([]); setNotice(approved.length ? 'Choose an approved template and language, then fill its required values.' : 'No approved templates were returned for this account.');
    });
  }
  async function reply(event: React.SyntheticEvent, checking = false) {
    event.preventDefault(); const whatsapp = tab === 'messages' && account?.platform === 'whatsapp', useTemplate = whatsapp && templateMode, useButtons = whatsapp && replyButtons.length > 0;
    if (readOnly || !canReply || !accountId || tab !== 'messages' && !replyTarget || tab === 'messages' && !selected || checking && !retainedButtonReply) return;
    if (!checking && replyButtons.length && !whatsapp) { setError('Reply buttons are only available for a WhatsApp conversation. Keep or discard this draft before changing accounts.'); return; }
    if (whatsapp && (buttonScope.current.key !== buttonScopeKey || buttonScope.current.generation !== buttonGeneration)) return;
    if (whatsapp && !checking && retainedButtonReply) { setError('An earlier reply outcome is unknown. Check that exact reply or review Provider outcomes before sending another.'); return; }
    if (!checking && !useTemplate && !message.trim() && !(tab === 'messages' && attachmentUrl)) return;
    if (!checking && useTemplate && (!selectedTemplate || templateRestriction(selectedTemplate))) { setError('Choose a supported approved template and fill its required values.'); return; }
    if (!checking && tab === 'messages' && !useTemplate && message.length > messageLimit) { setError(messageLimit === 0 ? 'TikTok image replies must be sent without text. Remove the text or send it as a separate reply.' : `Keep this private reply to ${messageLimit} characters${attachmentUrl ? ' including its attachment caption' : ''}.`); return; }
    if (!checking && useButtons && (!capabilities.replyButtons || useTemplate || attachmentUrl || messageTag || new TextEncoder().encode(message).length > 1024 || replyButtons.length > 3 || new Set(replyButtons).size !== replyButtons.length || replyButtons.some(label => !label.trim() || label !== label.trim() || label.length > 20 || /[\u0000-\u001f\u007f]/.test(label)))) { setError('Use a shorter text-only WhatsApp reply and one to three different, short button labels without surrounding spaces.'); return; }
    if (!checking && useButtons && buttonReview !== buttonReviewKey) { setError('Review this account, conversation, message and button labels before sending.'); return; }
    if (tab === 'reviews' && (replyTarget?.hasReply || replyTarget?.reply) && !confirmReplace) return;
    const draftBody = tab === 'messages' ? useTemplate ? { accountId, templateName: selectedTemplate!.name, templateLanguage: selectedTemplate!.language || selectedTemplate!.languageCode, templateComponents } : { accountId, message, ...(useButtons ? { buttons: replyButtons.map((title, index) => ({ type: 'postback', title, payload: `reply_${index + 1}` })) } : {}), ...(messageTag ? { messageTag } : {}), ...(attachmentUrl ? { attachmentUrl, attachmentType, ...(attachmentName && whatsapp && attachmentType === 'file' ? { attachmentName } : {}) } : {}) } : tab === 'comments' ? { accountId, postId: selected!.id, message, ...(replyTarget?.id ? { commentId: replyTarget.id } : {}) } : { accountId, reviewId: replyTarget!.id, message, expectedReplyVersion: replyTarget!.replyVersion, confirmReplace };
    const body = checking ? retainedButtonReply : draftBody, suffix = tab === 'messages' ? 'conversations/' + encodeURIComponent(selected!.id) + '/reply' : tab + '/reply';
    await action(checking ? 'Checking reply outcome' : 'Sending reply', async generation => {
      if (whatsapp && (buttonScope.current.key !== buttonScopeKey || buttonScope.current.generation !== buttonGeneration)) return;
      let result;
      try { result = checking ? await write(suffix, body, true) : await write(suffix, body); }
      catch (error) { if (body.buttons && buttonScope.current.generation === buttonGeneration) setButtonReview(''); throw error; }
      if (generation !== version.current || whatsapp && (buttonScope.current.key !== buttonScopeKey || buttonScope.current.generation !== buttonGeneration)) return;
      if (!checking || JSON.stringify(draftBody) === JSON.stringify(body)) {
        if (!result?.partialFailure) { setMessage(''); setMessageTag(''); if (useButtons) { setReplyButtons([]); setButtonReview(''); } }
        setAttachmentUrl(''); setAttachmentName(''); setAttachmentType('image'); setAttachmentPreview(''); setReplyTarget(null); setConfirmReplace(false); if (useTemplate) resetTemplate();
      }
      setNotice(result?.partialFailure ? 'The attachment was accepted, but the text was not sent. Your text is retained without the attachment. Review the thread, then send the text separately.' : tab === 'messages' ? 'Reply accepted by the provider. Delivery and read status are shown separately.' : 'Public reply confirmed by the provider.');
      if (result?.warnings?.length) setError(result.warnings.map((item: any) => typeof item === 'string' ? item : item.message || item.code || 'The provider reported a warning.').join(' '));
      await refreshAfterWrite(generation);
    });
  }
  async function conversationAction(kind: 'read' | 'status') {
    if (!selected || readOnly) return;
    const nextStatus = selected.status === 'archived' ? 'active' : 'archived';
    await action(kind === 'read' ? 'Marking conversation read' : 'Updating conversation', async generation => {
      await write('conversations/' + encodeURIComponent(selected.id) + '/' + kind, { accountId, ...(kind === 'status' ? { status: nextStatus } : {}) }); if (generation !== version.current) return;
      const updated: Row = { ...selected, ...(kind === 'read' ? { unreadCount: 0 } : { status: nextStatus }) }; setSelected(updated); setRows(previous => !historyFilter && (updated.status || 'active') !== conversationStatus ? previous.filter(item => item.id !== selected.id) : previous.some(item => item.id === selected.id) ? previous.map(item => item.id === selected.id ? updated : item) : [updated, ...previous]); setNotice(kind === 'read' ? 'Conversation marked read.' : nextStatus === 'archived' ? 'Conversation archived.' : 'Conversation reopened.');
    });
  }
  async function sendTyping(confirmed = false) {
    if (readOnly || !selected || !capabilities.typing) return;
    if (account?.platform === 'whatsapp') {
      const target = JSON.stringify([accountId, selected.id, selected.deleteVersion]);
      if (confirmed !== true) { setTypingReview(target); return; }
      if (typingReview !== target) { setTypingReview(''); setError('This conversation changed. Review the current thread before requesting typing.'); return; }
    }
    setTypingReview('');
    const targetId = selected.id;
    await action('Sending typing indicator', async generation => {
      const result = await write(`conversations/${encodeURIComponent(targetId)}/typing`, { accountId, confirmTyping: true });
      if (generation !== version.current) return;
      setNotice(result.delivered ? 'Typing indicator sent to the platform. Its display is temporary and best-effort.' : 'No typing indicator was sent. The platform may not support it or its requirements were not met.');
    });
  }
  function prepareStoredDelete() {
    if (readOnly || !selected?.deleteVersion || !capabilities.deleteStoredConversation) return;
    setDeleteTarget({ id: selected.id, accountId, deleteVersion: selected.deleteVersion }); setError(''); setNotice('');
  }
  async function submitStoredDelete(confirmStoredDelete: boolean) {
    const target = deleteTarget;
    if (readOnly || !selected || !target || !confirmStoredDelete || target.id !== selected.id || target.accountId !== accountId || target.deleteVersion !== selected.deleteVersion) return;
    await action('Deleting stored conversation copy', async generation => {
      const result = await write(`conversations/${encodeURIComponent(target.id)}/delete`, { accountId, expectedDeleteVersion: target.deleteVersion, confirmConversationId: target.id });
      if (generation !== version.current) return;
      setRows(previous => previous.filter(item => item.id !== target.id)); resetSelection();
      setNotice(`Zernio confirmed deletion of its stored conversation and ${result.deletedMessages} messages. The platform thread and local contact remain. A provider sync may import it again.`);
    });
  }
  function prepareMessageAction(kind: string, item: Row) {
    if (readOnly || !selected || !item.version || !item.actions?.[{ edit: 'canEdit', delete: 'canDelete', react: 'canReact', unreact: 'canUnreact' }[kind] || '']) return;
    setMessageActionTarget({ kind, item, conversationId: selected.id, accountId }); setActionText(item.message || ''); setActionEmoji(account?.platform === 'slack' ? ':thumbsup:' : '👍'); setError(''); setNotice('');
  }
  async function submitMessageAction(confirmMessageAction: boolean) {
    const target = messageActionTarget;
    if (readOnly || !selected || !target || target.accountId !== accountId || target.conversationId !== selected.id || target.kind === 'delete' && !confirmMessageAction) return;
    const body = { accountId, expectedMessageVersion: target.item.version, ...(target.kind === 'edit' ? { text: actionText } : target.kind === 'delete' ? { confirmMessageId: target.item.id } : target.kind === 'react' ? { emoji: actionEmoji } : {}) };
    await action('Updating message', async generation => {
      const result = await write(`conversations/${encodeURIComponent(target.conversationId)}/messages/${encodeURIComponent(target.item.id)}/${target.kind}`, body);
      if (generation !== version.current) return;
      setMessageActionTarget(null);
      setNotice(target.kind === 'edit' ? 'Edited text confirmed in message history.' : target.kind === 'delete' ? result.deleteScope === 'self' ? 'Message removed from your view. The recipient can still see it.' : 'Message deletion confirmed in the provider history.' : result.observed ? 'Your reaction change is visible in the latest message history.' : 'The provider accepted the reaction request. Its placement is not yet confirmed in history; refresh before changing it again.');
      await refreshAfterWrite(generation);
    });
  }
  async function submitControl(confirmControl: string | false) {
    if (readOnly || !selected?.version || !selected.controlActions?.includes(controlAction) || confirmControl !== selected.version) return;
    const body = { accountId, action: controlAction, expectedConversationVersion: confirmControl, confirmControl: true, ...(controlAction === 'pass' ? { targetAppId } : {}), ...(controlNote ? { metadata: controlNote } : {}) }, targetId = selected.id;
    await action('Changing conversation control', async generation => {
      const result = await write(`conversations/${encodeURIComponent(targetId)}/thread-control`, body); if (generation !== version.current) return;
      setSelected(previous => previous?.id === targetId ? { ...previous, ...result.conversation, id: targetId } : previous); setControlAction('');
      setNotice(result.requested ? 'Control requested. The current owner must still transfer it; sending permission has not changed.' : 'Conversation owner confirmed in the latest provider view.'); await refreshAfterWrite(generation);
    });
  }
  async function submitAccept(confirmAccept: string | false) {
    if (readOnly || !selected?.version || !capabilities.acceptRequest || selected.folder !== 'requests' || confirmAccept !== selected.version || !message.trim()) return;
    const body = { accountId, message, expectedConversationVersion: confirmAccept, confirmSend: true }, targetId = selected.id;
    await action('Accepting request and sending reply', async generation => {
      await write(`conversations/${encodeURIComponent(targetId)}/accept`, body); if (generation !== version.current) return;
      setMessage(''); setSelected(previous => previous?.id === targetId ? { ...previous, folder: undefined } : previous); setRows(previous => previous.filter(item => item.id !== targetId));
      setNotice('Acceptance reply confirmed in message history. Delivery remains separate.');
      try { await fetchThread({ ...selected, folder: undefined }, generation); } catch { if (generation === version.current) setError('The acceptance reply was confirmed, but the latest thread could not be loaded. Refresh before another send.'); }
    });
  }
  async function editComment(body: Row, checking = false) {
    const reviewed = commentEdit, live = commentScope.current;
    if (!reviewed || readOnly || !selected || live.readOnly || commentGeneration !== live.generation || live.edit !== reviewed || account?.platform !== 'reddit' || body.confirmEdit !== true || body.accountId !== accountId || body.postId !== selected.id || body.commentId !== reviewed.id) return;
    const signature = JSON.stringify([path, 'comments/edit', body]);
    if (reviewed.needsRefresh || (checking ? !reviewed.blocked || reviewed.pendingBody !== body || !keys.current.has(signature) : reviewed.blocked || reviewed.confirmed !== JSON.stringify([accountId, selected.id, reviewed.id, reviewed.editVersion, reviewed.message, reviewed.content]) || body.content !== reviewed.content || !body.content?.trim() || body.expectedCommentVersion !== reviewed.editVersion || !live.rows.some(row => row.id === reviewed.id && row.from?.isOwner === true && row.editVersion === reviewed.editVersion))) return;
    await action(checking ? 'Checking Reddit edit' : 'Editing Reddit comment', async generation => {
      if (commentScope.current.readOnly || commentScope.current.edit !== reviewed || commentScope.current.generation !== commentGeneration) return;
      let result;
      try { result = await write('comments/edit', body); }
      catch (error) {
        const failure = error as Error & { status?: number; code?: string; operation?: Row };
        const unknown = !failure.status || ['pending', 'uncertain', 'reviewed-applied'].includes(failure.operation?.status) || ['OPERATION_UNCERTAIN', 'OPERATION_IN_PROGRESS', 'OPERATION_PENDING', 'COMMENT_REACTION_UNCERTAIN'].includes(failure.code || '') || failure.status >= 500 && failure.operation?.status !== 'failed';
        if (failure.code === 'OPERATION_NOT_SENT' || failure.operation?.status === 'failed') { setCommentEdit(current => current === reviewed ? { ...current, blocked: false, pendingBody: undefined, confirmed: '', needsRefresh: true } : current); setNotice('This edit was not sent. Your text is kept. Refresh comments, review the current text and acknowledge a new edit.'); } else if (unknown || checking) setCommentEdit(current => current === reviewed ? { ...current, blocked: unknown, pendingBody: unknown ? reviewed.pendingBody || { ...body } : undefined, ...(unknown ? {} : { confirmed: '' }) } : current);
        throw error;
      }
      if (generation !== version.current || commentGeneration !== commentScope.current.generation) return;
      if (checking) setCommentEdit(current => current?.pendingBody !== body ? current : current.content === body.content ? null : { ...current, ...result.comment, content: current.content, confirmed: '', blocked: false, pendingBody: undefined });
      else if (commentScope.current.edit === reviewed) setCommentEdit(null);
      setNotice('Reddit confirmed the edit and the latest comment contains your exact text.'); await refreshAfterWrite(generation);
    });
  }
  async function commentAction(kind: string, comment: Row, reactionType?: string) {
    if (!selected || readOnly || commentScope.current.readOnly || commentGeneration !== commentScope.current.generation || !commentScope.current.rows.some(row => row.id === comment.id)) return;
    if (['like', 'unlike'].includes(kind) && commentScope.current.rows.find(row => row.id === comment.id)?.canLike === false) return;
    if (reactionType !== undefined && (account?.platform !== 'linkedin' || kind !== 'like' || !Object.hasOwn(linkedInReactions, reactionType))) return;
    await action('Updating comment', async generation => { if (commentScope.current.readOnly || commentGeneration !== commentScope.current.generation) return; const result = await write('comments/' + kind, { accountId, postId: selected.id, commentId: comment.id, ...(reactionType ? { reactionType } : {}) }); if (generation !== version.current || commentGeneration !== commentScope.current.generation) return; setNotice(result?.reactionType ? `${linkedInReactions[result.reactionType]} reaction ${result.alreadyReacted ? 'already present' : 'confirmed'} by the provider. Live comments do not report its type.` : 'Comment change confirmed by the provider.'); await refreshAfterWrite(generation); });
  }
  async function deleteReviewReply(review: Row) {
    if (readOnly) return;
    await action('Removing review reply', async generation => { await write('reviews/delete-reply', { accountId, reviewId: review.id, expectedReplyVersion: review.replyVersion, confirmReplace: true }); if (generation !== version.current) return; setReplyTarget(null); setMessage(''); setNotice('Review reply removed.'); await refreshAfterWrite(generation); });
  }

  function commentMessage(item: Row, selected: Row, depth = 0): ConversationMessage {
    const edit = commentEdit;
    return { id: item.id, author: (item.from?.name || item.from?.username || 'Social account') + (item.from?.isOwner ? ' · Your account' : ''), time: when(item.createdTime), dateTime: item.createdTime, visibility: 'public', content: <Text preserveWhitespace>{item.message || 'Comment without text'}</Text>,
      status: [`${item.isHidden ? 'Hidden · ' : ''}${item.likeCount ?? 'Unknown'} likes${item.privateReplyStatus ? ` · Private reply: ${item.privateReplyStatus === 'sent' ? 'accepted' : item.privateReplyStatus === 'consumed' ? 'already used' : 'needs reconciliation'}` : ''}`, triageLabel(states[item.id], userId), waitingFor(states[item.id]?.waitingSince)].filter(Boolean).join(' · '),
      actions: <Stack gap={2}><Inline gap={2}>
        {!readOnly && canReply && item.canReply !== false && <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => prepareReply(item)}>Reply</Button>}
        {!readOnly && capabilities.commentEdit && account?.platform === 'reddit' && item.from?.isOwner === true && item.editVersion && <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => { if (edit?.id !== item.id) switchSelection(() => { setReplyTarget(null); setPrivateReplyTarget(null); setMessage(''); setCommentEdit({ ...item, accountId, postId: selected.id, content: item.message || '', confirmed: '' }); setError(''); setNotice(''); }); }}>Edit comment</Button>}
        {!readOnly && capabilities.commentPrivateReply && item.privateReplyEligible && <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => { if (privateReplyTarget?.id !== item.id) switchSelection(() => { setReplyTarget(null); setMessage(''); setCommentEdit(null); setPrivateReplyTarget({ ...item, accountId, postId: selected.id }); setError(''); setNotice(''); }); }}>Reply privately</Button>}
        {(item.repliesHasMore || item.replyCount > 0) && <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => openItem(selected, '', item.id)}>Open replies</Button>}
        {!readOnly && capabilities.commentHide && item.canHide && <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => item.isHidden ? commentAction('unhide', item) : setConfirming({ kind: 'hide', comment: item })}>{item.isHidden ? 'Unhide' : 'Hide'}</Button>}
        {!readOnly && capabilities.commentLike && item.canLike && (account?.platform === 'linkedin' ? <LinkedInCommentReaction key={JSON.stringify([projectId, accountId, selected.id, item.id])} comment={item} busy={!!busy} onChange={commentAction}/> : <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => commentAction(item.isLiked ? 'unlike' : 'like', item)}>{item.isLiked ? 'Unlike' : 'Like'}</Button>)}
        {!readOnly && capabilities.commentDelete && item.canDelete && <Button variant="danger" size="sm" disabled={!!busy} onClick={() => setConfirming({ kind: 'delete', comment: item })}>Delete</Button>}
        {link(item.url) && <Link href={link(item.url)!} target="_blank" variant="standalone">Open comment</Link>}
      </Inline><Disclosure variant="plain" summary="Comment triage"><TriageControls key={accountId + ':' + item.id} kind="comment" state={states[item.id]} error={triageError} readOnly={readOnly} busy={!!busy} userId={userId} members={assignees} onChange={change => changeTriage(item, change)}/></Disclosure>{notesFor('comment', item.id)}{edit && edit.id === item.id && edit.accountId === accountId && edit.postId === selected.id && !readOnly && <Form aria-label="Edit your Reddit comment" busy={!!busy} onSubmit={() => { const review = JSON.stringify([accountId, selected.id, edit.id, edit.editVersion, edit.message, edit.content]); if (edit.confirmed === review) return editComment({ accountId, postId: selected.id, commentId: edit.id, content: edit.content, expectedCommentVersion: edit.editVersion, confirmEdit: true }); }}>
        <Heading level={6} size="sm">Edit your Reddit comment</Heading><Text>Posting as {account?.name || accountId}. Review the original and replacement text.</Text>
        <Blockquote source="Before"><Text preserveWhitespace>{edit.message || 'Comment without text'}</Text></Blockquote>
        <Field label="After"><Textarea required maxLength={10000} rows={4} value={edit.content} onChange={event => setCommentEdit({ ...edit, content: event.target.value, confirmed: '' })}/></Field>
        {(edit.blocked || edit.needsRefresh || item.editVersion !== edit.editVersion || item.from?.isOwner !== true) && <Alert tone="danger">This edit needs reconciliation or the comment changed. Your text is retained. Refresh and check Reddit before another edit.</Alert>}
        <Text tone="muted">Reddit has no conditional edit. A change made elsewhere after this review can be overwritten.</Text>
        <Checkbox required checked={edit.confirmed === JSON.stringify([accountId, selected.id, edit.id, edit.editVersion, edit.message, edit.content])} onChange={event => setCommentEdit({ ...edit, confirmed: event.target.checked ? JSON.stringify([accountId, selected.id, edit.id, edit.editVersion, edit.message, edit.content]) : '' })} label="I reviewed this account and the before and after text and want to edit this comment now."/>
        <FormActions>{edit.blocked && edit.pendingBody && <Button variant="secondary" onClick={() => editComment(edit.pendingBody, true)}>Check this edit</Button>}<Button variant="primary" type="submit" disabled={edit.blocked || edit.needsRefresh || item.editVersion !== edit.editVersion || item.from?.isOwner !== true || !edit.content.trim() || edit.confirmed !== JSON.stringify([accountId, selected.id, edit.id, edit.editVersion, edit.message, edit.content])}>Save comment edit</Button><Button variant="secondary" onClick={() => switchSelection(() => setCommentEdit(null))}>Cancel edit</Button></FormActions>
      </Form>}</Stack>,
      replies: depth < 12 && Array.isArray(item.replies) && item.replies.length ? item.replies.map((reply: Row) => commentMessage(reply, selected, depth + 1)) : undefined };
  }
  const noun = tab === 'comments' ? 'posts' : tab, lastInbound = (detail?.messages || []).reduce((latest: number, item: Row) => item.direction === 'incoming' ? Math.max(latest, Date.parse(item.createdAt) || 0) : latest, 0);
  const shownComments = triageComments(detail?.comments || [], row => triageVisible(states[row.id], triageFilter, userId));
  const appliedInboxFilters = [
    ...(platform ? [{ id: 'platform', label: 'Platform', value: platform === 'facebook' ? 'Facebook / Messenger' : title(platform) }] : []),
    ...(tab === 'messages' && folder === 'requests' ? [{ id: 'folder', label: 'Folder', value: 'Message requests' }] : []),
    ...(tab === 'messages' && conversationStatus !== 'active' ? [{ id: 'status', label: 'Conversation status', value: 'Archived' }] : []),
    ...(search && !historyFilter ? [{ id: 'search', label: 'Search', value: search }] : []),
  ];
  // "All caught up" means the view is empty; "No matches" means a search or filter hides items and offers to clear it.
  const viewName = triageFilters.find(([value]) => value === triageFilter)?.[1] || 'this view';
  const listEmpty = !loaded ? <EmptyState title={accountId ? `${noun.charAt(0).toUpperCase() + noun.slice(1)} not loaded` : 'No account chosen'} description={accountId ? 'Refresh to try again.' : supported.length ? `Choose an account to see its ${noun}.` : `Connect an account that supports ${tab} in Integrations.`}/>
    : historyFilter || appliedInboxFilters.length || Object.keys(reviewFilters).length ? <EmptyState title="No matches" description={pagination?.hasMore ? 'Nothing on the loaded pages matches. Load more, or clear the filters.' : 'Nothing matches these filters.'} action={<Button variant="secondary" size="sm" disabled={!!busy} onClick={clearInboxFilters}>Clear filters</Button>}/>
    : <EmptyState title={tab === 'comments' ? 'No commented posts' : triageFilter === 'active' ? 'All caught up' : `Nothing in ${viewName}`} description={pagination?.hasMore ? 'More results are available below.' : tab === 'comments' ? 'Posts with comments appear here.' : triageFilter === 'active' ? `No open ${noun} need attention.` : `No ${noun} in this view.`}/>;
  const loadMore = pagination?.hasMore ? <LoadMore hasMore busy={busy === 'Loading ' + tab} shown={rows.length} itemLabel={noun} label={`Load more ${noun}`} unavailableReason={pagination.nextCursor ? undefined : 'The provider has more results but supplied no next page. Narrow the account or platform filter.'} onLoadMore={() => loadList(pagination.nextCursor)}/> : undefined;
  const publicReply = replyTarget && !readOnly && <Card as="section" headingLevel={tab === 'reviews' ? 3 : 4} title={tab === 'reviews' ? 'Public review reply' : 'Public comment reply'}><Form aria-label={tab === 'reviews' ? 'Public review reply' : 'Public comment reply'} busy={!!busy} onSubmit={(_, event) => reply(event)}><Blockquote><Text preserveWhitespace>{replyTarget.text || replyTarget.message || 'Reply to the selected post'}</Text></Blockquote><Field label="Your public reply"><Textarea required rows={4} maxLength={10000} value={message} onChange={event => setMessage(event.target.value)}/></Field>{tab === 'reviews' && (replyTarget.hasReply || replyTarget.reply) && <Checkbox required checked={confirmReplace} onChange={event => setConfirmReplace(event.target.checked)} label="I approve updating or adding this review’s provider reply. Google replaces the existing owner reply."/>}<FormActions><Button variant="primary" type="submit">Send public reply</Button><Button variant="secondary" onClick={() => { setReplyTarget(null); setMessage(''); }}>Cancel</Button></FormActions></Form></Card>;
  const integrationsAction = onOpenIntegrations ? <Button variant="secondary" size="sm" onClick={onOpenIntegrations}>Open integrations</Button> : undefined;

  return <Stack gap={4}>
    {(tab === 'messages' || tab === 'comments') && <InboxShortcuts onKey={shortcut}/>}
    <Inline justify="between" align="center"><Heading level={2} size="md">Unified inbox</Heading><Button variant="secondary" disabled={!!busy} onClick={loadAccounts}>Refresh connections</Button></Inline>
    {error && <Alert tone="danger">{error}</Alert>}{notice && <StatusLine>{notice}</StatusLine>}{busy && <StatusLine busy>{busy}…</StatusLine>}
    {triageError && <Alert tone="warning" title="Triage status could not be loaded.">{triageError} {triageKind.charAt(0).toUpperCase() + triageKind.slice(1)}s are listed without a triage status, and the triage filter does not hide them.</Alert>}
    {status && !connected && <Alert tone="warning" actions={integrationsAction}>Configure Zernio and map this project’s profile in Integrations settings to load its inbox.</Alert>}
    {connected && tab !== 'mentions' && status?.webhookConfigured === false && <Alert tone="info" actions={integrationsAction}>Configure inbox webhooks in Integrations settings to receive activity updates. You can refresh provider lists manually now.</Alert>}
    {tab === 'reviews' && <Stack as="section" aria-label="Review filters" gap={2}><FeatureControls>
      <Field label="Minimum rating"><Select value={reviewFilters.minRating || ''} disabled={!!busy} onChange={event => changeReviewFilter('minRating', event.target.value)}><Option value="">Any rating</Option>{[1, 2, 3, 4, 5].map(rating => <Option key={rating} value={rating} disabled={!!reviewFilters.maxRating && rating > Number(reviewFilters.maxRating)}>{rating} star{rating === 1 ? '' : 's'}</Option>)}</Select></Field>
      <Field label="Maximum rating"><Select value={reviewFilters.maxRating || ''} disabled={!!busy} onChange={event => changeReviewFilter('maxRating', event.target.value)}><Option value="">Any rating</Option>{[1, 2, 3, 4, 5].map(rating => <Option key={rating} value={rating} disabled={!!reviewFilters.minRating && rating < Number(reviewFilters.minRating)}>{rating} star{rating === 1 ? '' : 's'}</Option>)}</Select></Field>
      <Field label="Reply status"><Select value={reviewFilters.hasReply || ''} disabled={!!busy} onChange={event => changeReviewFilter('hasReply', event.target.value)}><Option value="">All reviews</Option><Option value="false">Without a reply</Option><Option value="true">With a reply</Option></Select></Field>
      <Field label="Review sort"><Select value={reviewFilters.sortBy || 'date'} disabled={!!busy} onChange={event => changeReviewFilter('sortBy', event.target.value)}><Option value="date">Date</Option><Option value="rating">Rating</Option></Select></Field>
      <Field label="Sort direction"><Select value={reviewFilters.sortOrder || 'desc'} disabled={!!busy} onChange={event => changeReviewFilter('sortOrder', event.target.value)}><Option value="desc">Highest or newest first</Option><Option value="asc">Lowest or oldest first</Option></Select></Field>
    </FeatureControls></Stack>}
    <Stack as="section" aria-label="Inbox scope" gap={3}>
      <SegmentedControl label="View" value={triageFilter} onValueChange={setTriageFilter} options={triageFilters.map(([value, label]) => ({ value, label, disabled: !!historyFilter }))}/>
      {historyFilter && <Text size="sm" tone="muted">History results show every triage status.</Text>}
      <FeatureControls>
      <Field label="Connected account"><Select value={accountId} disabled={!!busy || !connected} onChange={event => { const value = event.target.value; if (value !== accountId) switchSelection(() => { resetList(); setAccountId(value); }); }}><Option value="">Choose an account</Option>{supported.map(item => <Option key={item.id} value={item.id}>{accountLabel(item)}</Option>)}</Select></Field>
      <Field label={`Search loaded ${noun}`}><Input type="search" disabled={!!historyFilter} value={search} onChange={event => setSearch(event.target.value)} placeholder={tab === 'messages' ? 'Name, identity or recent message…' : 'Text, author or location…'}/></Field>
    </FeatureControls>
      <Inline gap={2}><Popover label="Inbox filters" triggerLabel="Filters" triggerVariant="secondary" disabled={!!busy}><Stack gap={3}>
      <Field label="Platform"><Select value={platform} disabled={!!busy} onChange={event => { const value = event.target.value; if (value !== platform) switchSelection(() => { resetList(); setPlatform(value); setAccountId(''); }); }}><Option value="">All connected platforms</Option>{[...new Set(accounts.filter(item => item.capabilities?.[tab]).map(item => item.platform))].map(item => <Option value={item} key={item}>{item === 'facebook' ? 'Facebook / Messenger' : title(item)}</Option>)}</Select></Field>
      {tab === 'messages' && capabilities.acceptRequest && <Field label="Conversation folder"><Select value={folder} disabled={!!busy} onChange={event => { const value = event.target.value; if (value !== folder) switchSelection(() => { resetList(); setFolder(value); }); }}><Option value="inbox">Inbox</Option><Option value="requests">Message requests</Option></Select></Field>}
      {tab === 'messages' && <Field label="Conversation status"><Select value={conversationStatus} disabled={!!busy} onChange={event => { const value = event.target.value; if (value !== conversationStatus) switchSelection(() => { resetList(); setConversationStatus(value); }); }}><Option value="active">Active</Option><Option value="archived">Archived</Option></Select></Field>}
      </Stack></Popover><Button variant="secondary" disabled={!!busy || !accountId || !connected} onClick={() => loadList('', true)}>Refresh {noun}</Button></Inline>
      {appliedInboxFilters.length > 0 && <AppliedFilters label="Applied filters" filters={appliedInboxFilters} disabled={!!busy} onRemove={removeInboxFilter} onClear={clearInboxFilters}/>}
      {connected && accounts.length > 0 && !supported.length && <Text tone="muted">{tab === 'mentions' ? 'No active LinkedIn account is available in this filter. Connect or reconnect a LinkedIn account.' : <>No account in this filter supports {tab}. Choose another platform or connect a supported account.</>}</Text>}
      {tab === 'mentions' && <Text tone="muted">LinkedIn organization mentions only; requires the Zernio Inbox add-on. Choose a connected LinkedIn account to filter mentions stored by Zernio. An account listed here is not confirmation that it is an organization. Newest published mentions appear first. Expand a mention to read it, or refresh to check for new ones.</Text>}
      {tab === 'comments' && <Text tone="muted">Choose a published post, then open its comments. Provider caching, permissions and moderation capabilities vary by platform.</Text>}
      {tab === 'messages' && <Text tone="muted">Provider reply windows and account permissions apply. Messages from encrypted X Chat are unavailable through the provider API.</Text>}
    </Stack>
    {tab === 'messages' && <Stack as="section" aria-label="Message history search" gap={3}><Disclosure summary="Search message history"><Form aria-label="Search message history" onSubmit={(_, event) => searchHistory(event)}><FormGrid><Field label="Search full message history"><Input type="search" minLength={2} maxLength={200} required value={historyQuery} disabled={!!busy} onChange={event => setHistoryQuery(event.target.value)} placeholder="Message words, name, handle or phone…"/></Field><Field label="Message direction"><Select value={historyDirection} disabled={!!busy} onChange={event => setHistoryDirection(event.target.value)}><Option value="">Messages and contact identity</Option><Option value="incoming">Received messages only</Option><Option value="outgoing">Sent messages only</Option></Select></Field></FormGrid><FormActions><Button variant="secondary" type="submit" disabled={!!busy || !accountId || !connected}>Search history</Button></FormActions><Text tone="muted">Message words match whole tokens; names and identities match partial text.</Text></Form></Disclosure><Inline gap={2}>{historyFilter && <Button variant="secondary" disabled={!!busy} onClick={() => loadList('', true)}>Return to conversations</Button>}{!readOnly && capabilities.start && <Button variant="secondary" disabled={!!busy || starting} onClick={prepareConversation}>New conversation</Button>}</Inline><Text tone="muted">Searches history stored by Zernio, including archived conversations. Results include up to three recent matching messages per conversation. Live-only accounts may be skipped.</Text>{historyFilter && <StatusLine>History results for “{historyFilter.query}”{historyFilter.direction ? ' · ' + historyFilter.direction : ''}. Load more to continue this search.</StatusLine>}</Stack>}
    {starting && tab === 'messages' && <Card as="section" title="New conversation" description={`From ${accountLabel(account || {})}. Sending to a recipient with an existing conversation adds this message to that thread.`}><Stack gap={3}>
      {['slack', 'whatsapp', 'sms'].includes(account?.platform) ? <Field label={account?.platform === 'slack' ? 'Workspace member' : 'Contact with channel permission'} required description={recipients.length ? undefined : `No eligible recipients found. ${account?.platform === 'slack' ? 'Refresh workspace members or check Slack permissions.' : 'Record explicit channel permission in Contacts; suppressed contacts cannot be selected.'}`}><Select required disabled={!!busy} value={recipient} onChange={event => setRecipient(event.target.value)}><Option value="">Choose a recipient</Option>{recipients.map(item => <Option key={item.id} value={item.id}>{item.name}{item.phone ? ' · ' + item.phone : item.username ? ' · @' + item.username : ''}</Option>)}</Select></Field> : <Field label="Recipient handle" required><Input required disabled={!!busy} maxLength={253} value={recipient} onChange={event => setRecipient(event.target.value)} placeholder={account?.platform === 'bluesky' ? 'person.bsky.social' : account?.platform === 'reddit' ? 'u/username' : '@username'}/></Field>}
      {account?.platform === 'whatsapp' ? <><Field label="Approved opening template and language" required><Select required disabled={!!busy} value={openingTemplateKey} onChange={event => { setOpeningTemplateKey(event.target.value); setOpeningTemplateComponents([]); }}><Option value="">Choose a template</Option>{openingTemplates.map(item => <Option key={JSON.stringify([item.name, item.language || item.languageCode])} value={JSON.stringify([item.name, item.language || item.languageCode])}>{item.name} · {item.language || item.languageCode}</Option>)}</Select></Field>{openingTemplate && <WhatsAppTemplate template={openingTemplate} components={openingTemplateComponents} onChange={setOpeningTemplateComponents}/>}</> : <Field label="Opening message" required count={{ value: openingMessage, max: capabilities.messageLimit || 10000, measure: value => value.length }}><Textarea required disabled={!!busy} rows={4} maxLength={capabilities.messageLimit || 10000} value={openingMessage} onChange={event => setOpeningMessage(event.target.value)}/></Field>}
      {account?.platform === 'twitter' && <Text tone="muted">Zernio checks whether this recipient accepts messages from this account. The required X API access and encrypted-chat limitations still apply.</Text>}
      <ReviewConfirm title="Review and send" reviewKey={JSON.stringify([accountId, recipient, openingMessage, openingTemplateKey, openingTemplateComponents])} acknowledgements={[{ id: 'send', label: 'I reviewed this recipient, account and message and want to send it now.' }]} confirmLabel="Send opening message" busy={!!busy} disabledReason={recipient ? undefined : 'Choose a recipient first.'} onConfirm={() => startConversation(true)} onCancel={() => setStarting(false)}><Stack gap={2}>{account?.platform !== 'whatsapp' && <ContentPreview chrome="message" label="Message preview" destination={recipient || 'Recipient'} provider={accountLabel(account || {})} text={<Text preserveWhitespace>{openingMessage || 'Enter a message to preview it.'}</Text>}/>}<Text tone="muted">A message does not grant marketing permission. Delivery, recipient eligibility and provider charges apply.</Text></Stack></ReviewConfirm>
    </Stack></Card>}
    {meta?.accountsSkipped?.length > 0 && <Alert tone="warning" title="Some connected accounts cannot be searched."><Stack gap={1}>{meta?.accountsSkipped?.map((item: Row) => <Text key={item.accountId}>{title(item.platform)} · {item.accountId}: message history is fetched live or is unavailable for search.</Text>)}</Stack></Alert>}
    {meta?.failedAccounts?.map((item: Row, index: number) => { const failed = accounts.find(row => row.id === item.accountId); return <Alert key={item.accountId || index} tone="warning" title={`${failed ? accountLabel(failed) : title(item.platform) || 'An account'} could not be loaded`} actions={onOpenIntegrations ? <Button variant="secondary" size="sm" onClick={onOpenIntegrations}>Reconnect</Button> : undefined}>{item.error || item.message || 'Provider unavailable'}{item.retryAfter ? ` · Retry after ${item.retryAfter} seconds` : ''}</Alert>; })}
    {initialChannel === 'whatsapp' && initialSearch && tab === 'messages' && <Text tone="muted">Select the conversation you recognise before replying. Some WhatsApp participants use a business-specific identity instead of their phone number. Clear the search to inspect other conversations.</Text>}
    {loaded && accountId && tab === 'reviews' && appliedReviewFilters.length > 0 && <AppliedFilters filters={appliedReviewFilters} label="Loaded review filters"/>}
    {tab === 'messages' ? <DetailWorkspace label="Private messages" listLabel={historyFilter ? 'History results' : 'Conversations'} detailLabel={selected ? selected.participantName || selected.participantId || 'Conversation' : 'Conversation'} selected={!!selected} backLabel="Back to conversations" onBack={() => switchSelection(resetSelection)} emptyMessage={<EmptyState title="Choose a conversation" description="Load an account’s messages, then open a conversation."/>}
      list={<SelectableList label="Conversations" selectedId={selected?.id} onSelect={id => { const item = visibleRows.find(row => row.id === id); if (item) openItem(item); }} loading={!loaded && !!busy} emptyMessage={listEmpty} footer={loadMore} items={visibleRows.map(item => ({ id: item.id, leading: <Avatar size="sm" name={String(item.participantName || item.participantId || '?')}/>, title: item.participantName || item.participantUsername || item.participantId || 'Participant', preview: historyFilter && item.matches?.length ? item.matches.map((match: Row) => `${match.direction === 'outgoing' ? 'Sent' : 'Received'}: ${match.text || 'No text'} · ${when(match.timestamp)}`).join(' / ') : item.lastMessage || 'No text preview', meta: [when(item.lastMessageAt || item.updatedTime), waitingFor(states[triageKey(item)]?.waitingSince)].filter(Boolean).join(' · '), status: [historyFilter ? item.matchCount ? `${item.matchCount} matching messages` : 'Contact identity match' : '', triageLabel(states[triageKey(item)], userId)].filter(Boolean).join(' · ') || undefined, unread: item.unreadCount, disabled: !!busy }))}/>}
      detail={selected && <Stack gap={4}>
        <Stack gap={2}><Text tone="muted">{title(selected.platform || account?.platform)} · {selected.participantId} · {selected.status || 'active'}</Text><Inline gap={2}><Button variant="secondary" size="sm" disabled={!!busy} onClick={() => openItem(selected)}>Refresh thread</Button>{link(selected.url) && <Link href={link(selected.url)!} target="_blank" variant="standalone">Open in platform</Link>}{!readOnly && capabilities.read && <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => conversationAction('read')}>Mark read</Button>}{!readOnly && capabilities.archive && <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => conversationAction('status')}>{selected.status === 'archived' ? 'Reopen' : 'Archive'}</Button>}{!readOnly && capabilities.typing && <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => sendTyping()}>Send typing indicator</Button>}{!readOnly && capabilities.deleteStoredConversation && <Button variant="danger" size="sm" disabled={!!busy || !selected.deleteVersion} onClick={prepareStoredDelete}>Delete stored copy</Button>}</Inline></Stack>
        <TriageControls key={accountId + ':' + triageKey(selected)} state={states[triageKey(selected)]} error={triageError} readOnly={readOnly} busy={!!busy} userId={userId} members={assignees} onChange={change => changeTriage(selected, change)}/>
        {notesFor('conversation', triageKey(selected), true)}
        {typingReview && account?.platform === 'whatsapp' && <ReviewConfirm title="Request a typing indicator" reviewKey={typingReview} acknowledgements={[]} confirmLabel="Confirm typing request" cancelLabel="Cancel typing request" busy={!!busy} disabledReason={readOnly ? 'Your role can view this inbox but cannot send.' : undefined} onConfirm={() => sendTyping(true)} onCancel={() => setTypingReview('')}><Text>WhatsApp may also mark the latest inbound message as read. This request is for the currently reviewed conversation; the indicator is temporary and may not be displayed.</Text></ReviewConfirm>}
        {deleteTarget && !readOnly && deleteTarget.id === selected.id && deleteTarget.accountId === accountId && <ReviewConfirm tone="danger" title="Delete Zernio’s stored conversation copy" reviewKey={JSON.stringify([deleteTarget.id, deleteTarget.accountId, deleteTarget.deleteVersion])} acknowledgements={[{ id: 'delete', label: 'I reviewed this account, participant and latest messages and want to delete Zernio’s stored copy.' }]} confirmLabel="Confirm stored-copy deletion" busy={!!busy} disabledReason={deleteTarget.deleteVersion !== selected.deleteVersion ? 'The latest messages changed. Cancel and review the refreshed conversation again.' : undefined} onConfirm={() => submitStoredDelete(true)} onCancel={() => setDeleteTarget(null)}><Stack gap={2}><Text>This permanently deletes Zernio’s stored messages and unlinks its provider contact channel. The native platform thread, provider contact record and this app’s local contact remain. Synchronization can import the thread again.</Text><Text>New messages may arrive after this review and before the provider deletes the stored conversation; those messages may also be removed.</Text></Stack></ReviewConfirm>}
        {!readOnly && selected.controlActions?.length > 0 && <Disclosure summary={`Change who answers · ${selected.threadControl === 'app' ? 'This app' : selected.threadControl === 'ai_agent' ? 'Business agent' : selected.threadControl === 'other' ? 'Another app' : 'Owner not reported'}`}><Stack gap={3}>
          <Field label="Conversation control" required><Select required disabled={!!busy} value={controlAction} onChange={event => setControlAction(event.target.value)}><Option value="">Choose an action</Option>{selected.controlActions.map((value: string) => <Option value={value} key={value}>{value === 'take' ? 'Take control for this app' : value === 'request' ? 'Request control from the current owner' : value === 'pass' ? 'Transfer control to another Meta app' : account?.platform === 'whatsapp' ? 'Release to the business agent' : 'Release to the primary receiver'}</Option>)}</Select></Field>
          {controlAction === 'pass' && <Field label="Receiving Meta app ID" required description="Page Inbox is 263902037430900. Confirm which app should answer this customer."><Input required disabled={!!busy} inputMode="numeric" pattern="[0-9]+" maxLength={32} value={targetAppId} onChange={event => setTargetAppId(event.target.value)}/></Field>}
          <Field label="Handover note (optional)" description="This note is forwarded to the receiving app."><Textarea rows={2} disabled={!!busy} maxLength={2000} value={controlNote} onChange={event => setControlNote(event.target.value)}/></Field>
          <ReviewConfirm title="Confirm control change" reviewKey={JSON.stringify([selected.id, selected.version, controlAction, targetAppId, controlNote])} acknowledgements={[{ id: 'control', label: 'I reviewed which app will answer this conversation.' }]} confirmLabel="Confirm control change" busy={!!busy} disabledReason={!controlAction ? 'Choose a control action first.' : controlAction === 'pass' && !/^[0-9]+$/.test(targetAppId) ? 'Enter the receiving Meta app ID using digits only.' : undefined} onConfirm={() => submitControl(selected.version)}><Text tone="muted">{controlAction === 'request' ? 'A request does not transfer ownership. The current owner must grant it.' : 'Changing control can stop this app from sending and can resume another app’s automatic replies.'}{account?.platform === 'whatsapp' ? ' WhatsApp requires an enabled Meta Business Agent; taking control also requires the configured escalation partner. Passing control is unavailable.' : account?.platform === 'instagram' && !selected.controlActions.includes('take') ? ' This Instagram Login connection cannot take or request control.' : ' Taking control requires this app to be the Page’s primary receiver.'}</Text></ReviewConfirm>
        </Stack></Disclosure>}
        {!readOnly && capabilities.acceptRequest && selected.folder === 'requests' && <Card as="section" headingLevel={5} title="Accept message request by replying" description="This sends a private reply and moves the request into your inbox. Standard provider reply windows still apply."><Stack gap={3}><Field label="Acceptance reply" count={{ value: message, max: capabilities.messageLimit || 10000, measure: value => value.length }}><Textarea required rows={3} disabled={!!busy} maxLength={capabilities.messageLimit || 10000} value={message} onChange={event => setMessage(event.target.value)}/></Field><ReviewConfirm title="Review the acceptance reply" reviewKey={JSON.stringify([selected.id, selected.version, message])} acknowledgements={[{ id: 'accept', label: 'I reviewed this reply and want to accept this request.' }]} confirmLabel="Accept request and send reply" busy={!!busy} disabledReason={message.trim() ? undefined : 'Write the acceptance reply first.'} onConfirm={() => submitAccept(selected.version)}/></Stack></Card>}
        {messageActionTarget && !readOnly && messageActionTarget.conversationId === selected.id && messageActionTarget.accountId === accountId && <ReviewConfirm tone={messageActionTarget.kind === 'delete' ? 'danger' : 'default'} title={messageActionTarget.kind === 'edit' ? 'Edit sent text' : messageActionTarget.kind === 'delete' ? messageActionTarget.item.actions?.deleteScope === 'self' ? 'Remove from my view' : messageActionTarget.item.actions?.deleteScope === 'unsend' ? 'Unsend message' : 'Delete message' : messageActionTarget.kind === 'react' ? 'Add a reaction' : 'Remove your reaction'} reviewKey={JSON.stringify([messageActionTarget.kind, messageActionTarget.conversationId, messageActionTarget.accountId, messageActionTarget.item.id, messageActionTarget.item.version])} acknowledgements={messageActionTarget.kind === 'delete' ? [{ id: 'delete', label: 'I reviewed this message and its deletion scope.' }] : []} confirmLabel={messageActionTarget.kind === 'edit' ? 'Save edited text' : messageActionTarget.kind === 'delete' ? 'Confirm message deletion' : messageActionTarget.kind === 'react' ? 'Send reaction' : 'Remove my reaction'} busy={!!busy} disabledReason={messageActionTarget.kind === 'edit' && !actionText ? 'Enter the new message text.' : messageActionTarget.kind === 'react' && !actionEmoji ? 'Enter an emoji reaction.' : messageActionTarget.kind === 'react' && actionEmoji.length > 64 ? 'Keep the reaction within 64 characters.' : undefined} onConfirm={() => submitMessageAction(true)} onCancel={() => setMessageActionTarget(null)}><Stack gap={3}>
          <Blockquote source={when(messageActionTarget.item.createdAt)}><Text preserveWhitespace>{messageActionTarget.item.message || 'Message without text'}</Text></Blockquote>
          {messageActionTarget.kind === 'edit' && <><Field label="New message text" count={{ value: actionText, max: capabilities.messageLimit || 10000, measure: value => value.length }}><Textarea rows={3} required disabled={!!busy} maxLength={capabilities.messageLimit || 10000} value={actionText} onChange={event => setActionText(event.target.value)}/></Field><Blockquote source="Edited text preview"><Text preserveWhitespace>{actionText}</Text></Blockquote><Text tone="muted">Only the text of your own message changes. iMessage edits must reach the provider within 15 minutes of sending.</Text></>}
          {messageActionTarget.kind === 'delete' && <Text>{messageActionTarget.item.actions?.deleteScope === 'self' ? 'This removes the message from your own view. The recipient keeps their copy.' : messageActionTarget.item.actions?.deleteScope === 'unsend' ? 'iMessage unsend is available only within 2 minutes of sending. Recipient software and provider rules can affect what they have already seen.' : 'This requests deletion through the platform. Content already seen or copied by recipients cannot be recalled.'} This cannot be undone here.</Text>}
          {messageActionTarget.kind === 'react' && <><Combobox label={account?.platform === 'slack' ? 'Slack emoji name' : 'Emoji reaction'} required allowCustom disabled={!!busy} options={account?.platform === 'slack' ? [':thumbsup:', ':heart:', ':tada:', ':laughing:'] : ['👍', '❤️', '😂', '🎉', '👏', '🔥']} value={actionEmoji} onValueChange={setActionEmoji}/><Text>Reaction preview: <Text as="strong">{actionEmoji}</Text></Text><Text tone="muted">{account?.platform === 'telegram' ? 'Telegram accepts a limited set of standard emoji.' : account?.platform === 'slack' ? 'Slack requires a named workspace emoji such as :thumbsup:.' : account?.platform === 'imessage' ? 'Standard Apple tapbacks display natively; other emoji require iOS 18 or later.' : 'Platform reaction rules and the Meta reply window apply.'} Acceptance does not guarantee immediate placement; the history is refreshed after sending.</Text></>}
          {messageActionTarget.kind === 'unreact' && <Text>Only this connected account’s reaction will be removed. The contact’s reactions stay.</Text>}
        </Stack></ReviewConfirm>}
        {detail?.contact && <Disclosure summary={`Linked contact: ${detail.contact.name || detail.contact.id}`}><Stack gap={2}><DescriptionList items={[{ term: 'Email', description: detail.contact.email || 'No email recorded' }, { term: 'Phone', description: detail.contact.phone || 'No phone recorded' }, { term: 'Identity', description: selected.participantId }, ...(['email', 'sms', 'whatsapp'] as const).map(channel => ({ term: title(channel), description: detail.contact.suppression?.[channel] ? 'Suppressed' : detail.contact.consents?.[channel] ? 'Permission recorded' : 'No permission' }))]}/><Text tone="muted">A conversation does not grant marketing permission.</Text></Stack></Disclosure>}
        <ConversationThread label="Message history" headingLevel={5} readOnly={readOnly} emptyMessage="No messages returned on this page." hasOlder={!!detail?.pagination?.hasMore} olderLoading={busy === 'Loading conversation'} olderUnavailableReason={detail?.pagination?.nextCursor ? undefined : 'The provider has older messages but supplied no earlier page.'} onLoadOlder={() => { if (detail?.pagination?.nextCursor) openItem(selected, detail.pagination.nextCursor); }} messages={[...(detail?.messages || [])].sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0)).map((item: Row): ConversationMessage => { const deleted = item.isDeleted || item.metadata?.isDeleted || item.deliveryStatus === 'deleted'; return { id: item.id, author: item.direction === 'outgoing' ? 'Your account' : item.senderName || selected.participantName || 'Participant', time: when(item.createdAt), dateTime: item.createdAt, visibility: 'private', direction: item.direction === 'outgoing' ? 'outbound' : 'inbound', removed: !!deleted, removedReason: 'This message was deleted.', content: <Stack gap={1}><Text preserveWhitespace>{item.message || item.text || ''}</Text>{!deleted && account?.platform === 'whatsapp' && item.direction === 'incoming' && item.metadata?.interactiveType === 'button_reply' && typeof item.metadata.interactiveId === 'string' && <Text size="sm" tone="muted">Reply button selected · ID: {item.metadata.interactiveId}</Text>}</Stack>, attachments: item.attachments?.length ? <Stack gap={2}>{item.attachments.map((attachment: Row, index: number) => <InboxAttachment key={selected.id + ':' + item.id + ':' + (item.version || JSON.stringify(attachment)) + ':' + index} item={attachment} target={`${path}/conversations/${encodeURIComponent(selected.id)}/messages/${encodeURIComponent(item.id)}/attachments/${index}`} accountId={accountId} request={requester.current} busy={!!busy}/>)}</Stack> : undefined, status: [item.deliveryStatus || item.status, item.isEdited && 'Edited', item.error && (item.error.message || item.error)].filter(Boolean).join(' · ') || undefined, actions: <MessageActions item={item} readOnly={readOnly} busy={!!busy} platform={account?.platform || ''} onAction={prepareMessageAction}/> }; })}/>
        {!readOnly && canReply && selected.folder !== 'requests' && <Form aria-label="Private reply" busy={!!busy} onSubmit={(_, event) => reply(event)}>{retainedButtonReply && <Alert tone="warning" title="An earlier reply outcome is unknown" actions={<Button variant="secondary" size="sm" onClick={event => reply(event, true)}>Check reply outcome</Button>}>Its exact message, buttons and action key are kept. Check it here or use Provider outcomes in Settings before another send.</Alert>}{account?.platform === 'whatsapp' && capabilities.replyButtons && <Disclosure summary="Reply buttons (optional)"><FieldList legend="Reply buttons" description="Send text with one to three reply buttons inside the customer’s 24-hour reply window. This does not grant marketing permission. Templates and attachments are separate reply types." name="replyButtons" emptyMessage="No reply buttons." items={replyButtons.map((label, index) => ({ label, index }))} getKey={row => String(row.index)} max={templateMode || attachmentUrl || retainedButtonReply ? replyButtons.length : 3} labels={{ maxReached: () => templateMode || attachmentUrl || retainedButtonReply ? 'Reply buttons cannot be added to a template, an attachment or while an earlier reply outcome is unknown.' : 'Up to three reply buttons.' }} addLabel="Add reply button" removeLabel={index => `Remove reply button ${index + 1}`} onAdd={() => setReplyButtons(previous => [...previous, ''])} onRemove={index => { setReplyButtons(previous => previous.filter((_, position) => position !== index)); setButtonReview(''); }} renderItem={({ label, index }) => <Field label={`Reply button ${index + 1} label`}><Input required maxLength={20} value={label} onChange={event => setReplyButtons(previous => previous.map((value, position) => position === index ? event.target.value : value))}/></Field>}/></Disclosure>}{replyButtons.length > 0 && <><ContentPreview chrome="message" label="WhatsApp reply button preview" destination={selected.participantName || selected.participantId || selected.id} provider={`From ${accountLabel(account || {})}`} text={<Text preserveWhitespace>{message || 'Write a reply to preview it.'}</Text>} footer={<Stack gap={1}>{replyButtons.map((label, index) => <Text key={index} weight="medium">{label || 'Button label required'}</Text>)}</Stack>}/>{(templateMode || attachmentUrl) && <Alert tone="danger">Remove reply buttons before sending an attachment or approved template.</Alert>}<Checkbox checked={buttonReview === buttonReviewKey} onChange={event => setButtonReview(event.target.checked ? buttonReviewKey : '')} label="I reviewed this account, conversation, message and button labels and want to send it now."/></>}{account?.platform === 'whatsapp' && <Field label="Reply type"><Select value={templateMode ? 'template' : 'message'} onChange={event => { setTemplateMode(event.target.value === 'template'); setError(''); }}><Option value="message">Text or attachment within the reply window</Option><Option value="template">Approved WhatsApp template</Option></Select></Field>}{account?.platform === 'whatsapp' && !templateMode && lastInbound > 0 && Date.now() - lastInbound > 86400000 && <Alert tone="info">It has been more than 24 hours since this contact last messaged you in the loaded history. WhatsApp delivers only approved templates now: choose Approved WhatsApp template as the reply type.</Alert>}{account?.platform === 'whatsapp' && templateMode ? <><Inline><Button variant="secondary" onClick={loadReplyTemplates}>Load approved reply templates</Button></Inline><Field label="Approved reply template and language" required><Select required value={templateKey} onChange={event => { setTemplateKey(event.target.value); setTemplateComponents([]); }}><Option value="">Choose a template and language</Option>{templates.map(item => <Option key={JSON.stringify([item.name, item.language || item.languageCode])} value={JSON.stringify([item.name, item.language || item.languageCode])}>{item.name} · {item.language || item.languageCode}</Option>)}</Select></Field>{selectedTemplate && <WhatsAppTemplate template={selectedTemplate} components={templateComponents} onChange={setTemplateComponents}/>}</> : <><Field label="Private reply" count={{ value: message, max: messageLimit, measure: value => value.length }} description={attachmentUrl && messageLimit === 0 ? 'Send the image without text.' : attachmentUrl && ['telegram', 'whatsapp'].includes(account?.platform) ? 'Attachment caption limit.' : undefined}><Textarea ref={replyField} required={!attachmentUrl} rows={3} maxLength={messageLimit} value={message} onChange={event => setMessage(event.target.value)} placeholder="Write a reply to this conversation…"/></Field>{['facebook', 'instagram'].includes(account?.platform) && <Field label="Reply context (optional)" description="Choose a tag only when this reply meets its purpose. Tags cannot be used for promotions or automated outreach."><Select value={messageTag} onChange={event => setMessageTag(event.target.value)}><Option value="">Standard reply within provider window</Option><Option value="HUMAN_AGENT">Human support reply (up to 7 days)</Option>{account?.platform === 'facebook' && <><Option value="CONFIRMED_EVENT_UPDATE">Confirmed event update</Option><Option value="POST_PURCHASE_UPDATE">Post-purchase update</Option><Option value="ACCOUNT_UPDATE">Account update</Option></>}</Select></Field>}{capabilities.attachments && <Disclosure summary="Attach a public file"><Stack gap={3}><FormGrid><Field label="File type"><Select value={attachmentType} onChange={event => { setAttachmentType(event.target.value); setAttachmentName(''); setAttachmentPreview(''); }}>{["image", "video", "audio", "file"].filter(type => !capabilities.attachmentTypes || capabilities.attachmentTypes.includes(type)).map(type => <Option value={type} key={type}>{type === "file" ? "Document / file" : title(type)}</Option>)}</Select></Field><Field label="Public HTTPS file URL"><Input type="url" pattern="https://.+" value={attachmentUrl} onChange={event => { setAttachmentUrl(event.target.value); setAttachmentPreview(''); }}/></Field></FormGrid>{account?.platform === 'whatsapp' && attachmentType === 'file' && <Field label="Document filename (optional)"><Input value={attachmentName} maxLength={200} onChange={event => setAttachmentName(event.target.value)}/></Field>}<Text tone="muted">{capabilities.attachmentRules?.[attachmentType] ? `${capabilities.attachmentRules[attachmentType].formats}. Maximum ${capabilities.attachmentRules[attachmentType].maxMB} MB. ` : 'Provider file types and size limits apply. '}Use a direct public HTTPS file URL. A preview does not confirm platform acceptance.</Text>{['facebook', 'instagram'].includes(account?.platform) && attachmentUrl && message.trim() && <Text tone="muted">The attachment and text are sent as two separate messages. If only the attachment succeeds, your unsent text stays here.</Text>}<Inline><Button variant="secondary" disabled={!link(attachmentUrl)} onClick={() => setAttachmentPreview(attachmentUrl)}>Preview attachment</Button></Inline>{attachmentPreview && attachmentPreview === attachmentUrl && <Attachment key={attachmentType + attachmentUrl} item={{ type: attachmentType, url: attachmentUrl, ...(account?.platform === 'whatsapp' && attachmentType === 'file' ? { name: attachmentName } : {}) }}/>}</Stack></Disclosure>}</>}{account?.platform === 'whatsapp' && <Text tone="muted">Outside WhatsApp’s customer-service window, choose an approved template above. Fill its values and review the preview before sending.</Text>}<Text tone="muted">Sending is explicit. If the provider rejects a reply window or permission, your text stays here.</Text><FormActions><Button variant="primary" type="submit" disabled={!!retainedButtonReply || replyButtons.length > 0 && (account?.platform !== 'whatsapp' || buttonReview !== buttonReviewKey || templateMode || !!attachmentUrl) || templateMode && (!selectedTemplate || !!templateRestriction(selectedTemplate))}>{templateMode ? 'Send template reply' : replyButtons.length ? 'Send reply with buttons' : 'Send private reply'}</Button></FormActions></Form>}
      </Stack>}/> : tab === 'comments' ? <DetailWorkspace label="Commented posts" listLabel="Posts" detailLabel={focusedComment ? 'Comment replies' : 'Post comments'} selected={!!selected} backLabel="Back to posts" onBack={() => switchSelection(resetSelection)} emptyMessage={<EmptyState title="Choose a post" description="Load an account’s posts, then open a post’s comments."/>}
      list={<SelectableList label="Commented posts" selectedId={selected?.id} onSelect={id => { const item = visibleRows.find(row => row.id === id); if (item) openItem(item); }} loading={!loaded && !!busy} emptyMessage={listEmpty} footer={loadMore} items={visibleRows.map(item => ({ id: item.id, title: item.content || item.text || 'Post without a text caption', preview: `${title(item.platform || account?.platform)}${item.createdTime ? ` · ${when(item.createdTime)}` : ''}`, meta: `${item.commentCount ?? 'Unknown'} comments`, disabled: !!busy }))}/>}
      detail={selected && <Stack gap={4}>
        <Stack gap={2}><Text preserveWhitespace>{selected.content || selected.text || selected.id}</Text><Inline gap={2}><Button variant="secondary" size="sm" disabled={!!busy} onClick={() => openItem(selected, '', focusedComment)}>Refresh comments</Button>{focusedComment && <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => openItem(selected)}>Back to post</Button>}{!readOnly && canReply && <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => prepareReply({ id: '', message: selected.content })}>Reply to post</Button>}{link(selected.permalink || selected.url) && <Link href={link(selected.permalink || selected.url)!} target="_blank" variant="standalone">Open post</Link>}</Inline></Stack>
        <ConversationThread label={focusedComment ? 'Comment replies' : 'Post comments'} headingLevel={5} readOnly={readOnly} emptyMessage={detail?.comments?.length ? 'No comments with this triage status on this page.' : 'No comments returned on this page.'} messages={(detail?.parent && focusedComment ? [{ ...detail.parent, replies: shownComments }] : shownComments).map((item: Row) => commentMessage(item, selected))}/>
        {detail?.pagination?.hasMore && <LoadMore hasMore busy={busy === 'Loading comments'} itemLabel="comments" label="Load more comments" unavailableReason={detail.pagination.nextCursor ? undefined : 'The provider has more comments but supplied no next page.'} onLoadMore={() => openItem(selected, detail.pagination.nextCursor, focusedComment)}/>}
        {privateReplyTarget && !readOnly && privateReplyTarget.accountId === accountId && privateReplyTarget.postId === selected?.id && <PrivateCommentReply key={accountId + ':' + privateReplyTarget.postId + ':' + privateReplyTarget.id + ':' + privateReplyTarget.privateReplyVersion} target={privateReplyTarget} current={threadRows.find(item => item.id === privateReplyTarget.id)} busy={!!busy} onSend={sendPrivateCommentReply} onDraftChange={setPrivateDraft} onCancel={() => setPrivateReplyTarget(null)}/>}
        {publicReply}
      </Stack>}/> : <>
      <Stack as="section" gap={3} aria-label={tab === 'mentions' ? 'LinkedIn mentions' : 'Reviews'}>{visibleRows.map(item => tab === 'mentions' ? <Disclosure key={item.id} summary={[`Read mention · ${item.authorName || item.authorUsername || 'LinkedIn author'} · ${when(item.publishedAt)}`, triageLabel(states[item.id], userId)].filter(Boolean).join(' · ')}><Stack gap={2}><Text preserveWhitespace>{item.content || 'Mention without text'}</Text><Text size="sm" tone="muted">{item.accountUsername || account?.name || 'Connected LinkedIn account'}</Text>{link(item.permalink, true) ? <Inline><Link href={link(item.permalink, true)!} target="_blank" variant="standalone">Open post on LinkedIn</Link></Inline> : <Text tone="muted">Post link unavailable</Text>}<TriageControls key={accountId + ':' + item.id} kind="mention" state={states[item.id]} error={triageError} readOnly={readOnly} busy={!!busy} userId={userId} members={assignees} onChange={change => changeTriage(item, change)}/>{notesFor('mention', item.id)}</Stack></Disclosure> : <Card as="article" key={item.id} title={`${item.reviewer?.name || 'Reviewer'} · ${item.rating ? `${item.rating}/5` : item.recommendationType || 'Review'}`} description={[`${item.locationName || item.accountUsername || title(item.platform)} · ${when(item.created)}`, triageLabel(states[item.id], userId), waitingFor(states[item.id]?.waitingSince)].filter(Boolean).join(' · ')}><Stack gap={3}><Text preserveWhitespace>{item.text || 'Review without text'}</Text>{item.reply && <Blockquote source="Your public reply"><Text preserveWhitespace>{item.reply.text}</Text></Blockquote>}<Inline gap={2}>{!readOnly && canReply && <Button variant="secondary" size="sm" disabled={!!busy} onClick={() => prepareReply(item)}>{item.hasReply || item.reply ? 'Manage reply' : 'Reply'}</Button>}{!readOnly && capabilities.reviewDeleteReply && item.reply && <Button variant="danger" size="sm" disabled={!!busy} onClick={() => setConfirming({ kind: 'review', review: item })}>Remove reply</Button>}{link(item.reviewUrl) && <Link href={link(item.reviewUrl)!} target="_blank" variant="standalone">Open review</Link>}</Inline><TriageControls key={accountId + ':' + item.id} kind="review" state={states[item.id]} error={triageError} readOnly={readOnly} busy={!!busy} userId={userId} members={assignees} onChange={change => changeTriage(item, change)}/>{notesFor('review', item.id)}</Stack></Card>)}</Stack>
      {loaded && !visibleRows.length && listEmpty}{loadMore}{publicReply}
    </>}
    <ConfirmDialog open={!!confirming} onOpenChange={open => { if (!open) setConfirming(null); }} danger={confirming?.kind !== 'hide'} title={confirming?.kind === 'review' ? 'Remove your public reply to this review?' : confirming?.kind === 'hide' ? 'Hide this public comment from other people?' : 'Delete this public comment?'} description={confirming?.kind === 'review' ? 'The review itself remains.' : confirming?.kind === 'hide' ? 'You can unhide it later from this thread.' : 'This cannot be undone.'} confirmLabel={confirming?.kind === 'review' ? 'Remove reply' : confirming?.kind === 'hide' ? 'Hide comment' : 'Delete comment'} onConfirm={() => confirming?.kind === 'review' ? deleteReviewReply(confirming.review) : confirming ? commentAction(confirming.kind, confirming.comment) : undefined}/>
  </Stack>;
}
