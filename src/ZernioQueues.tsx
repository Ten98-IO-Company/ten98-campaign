import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, Combobox, ConfirmDialog, DataTable, Disclosure, Field, FormActions, FormGrid, Heading, Inline, Input, List, ListItem, Option, ReviewConfirm, Select, Stack, StatusLine, Text } from '@ten98/ui';

type Slot = { dayOfWeek: number; time: string };
type Queue = { _id: string; name: string; timezone: string; slots: Slot[]; active: boolean; isDefault: boolean; version: string };
type Row = Record<string, any>;
type Props = { projectId: string; canManage: boolean; canWrite: boolean; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>; onChanged?: () => void | Promise<void>; onEditPost?: (postId: string) => void; onOpenApprovals?: () => void };
const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// IANA zones the browser knows, for the queue timezone picker; UTC is listed explicitly because some engines omit it.
const timeZones = (() => { try { return [...new Set(['UTC', ...Intl.supportedValuesOf('timeZone')])]; } catch { return ['UTC']; } })();
// The status endpoint's version and slot checks, restated as what to do next.
const statusProblem = (failure: Error & { code?: string }) => ['QUEUE_CHANGED', 'QUEUE_REVIEW_REQUIRED'].includes(failure.code || '') ? Object.assign(new Error('This queue changed since the list was loaded. Refresh queues, check its schedule, then pause or activate it again.'), { code: failure.code }) : failure.code === 'QUEUE_SLOTS_REQUIRED' ? Object.assign(new Error('Add at least one weekly slot to this queue in the editor before activating it.'), { code: failure.code }) : failure;
const blank = () => ({ name: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', slots: [{ dayOfWeek: 1, time: '09:00' }], active: true });

export default function ZernioQueues({ projectId, canManage, canWrite, request, onChanged, onEditPost, onOpenApprovals }: Props) {
  const path = `/projects/${encodeURIComponent(projectId)}/integrations/queues`, projectPath = `/projects/${encodeURIComponent(projectId)}`;
  const [queues, setQueues] = useState<Queue[]>([]), [listVersion, setListVersion] = useState(''), [selected, setSelected] = useState<Queue | null>(null), [draft, setDraft] = useState(blank);
  const [makeDefault, setMakeDefault] = useState(false), [reshuffle, setReshuffle] = useState(false), [preview, setPreview] = useState<{ queue: Queue; slots: string[] } | null>(null);
  const [posts, setPosts] = useState<Row[]>([]), [approvalRequired, setApprovalRequired] = useState(false), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [enqueueReviews, setEnqueueReviews] = useState<Record<string, string>>({}), [confirming, setConfirming] = useState<{ kind: 'reshuffle' } | { kind: 'delete'; row: Queue } | null>(null);
  const active = useRef(true), scope = useRef({ path, canManage, canWrite }), requester = useRef(request), busyRef = useRef(false), keys = useRef(new Map<string, string>()); requester.current = request;
  if (scope.current.path !== path || scope.current.canManage !== canManage || scope.current.canWrite !== canWrite) scope.current = { path, canManage, canWrite };
  const view = scope.current, current = () => active.current && scope.current === view;
  useEffect(() => {
    active.current = true; busyRef.current = false; keys.current.clear(); setBusy(false); setLoaded(false); setQueues([]); setPosts([]); setSelected(null); setDraft(blank()); setPreview(null); setNotice(''); setEnqueueReviews({});
    action(load); return () => { active.current = false; };
  }, [path, canManage, canWrite]);
  async function action(run: () => Promise<void>) {
    if (!current() || busyRef.current) return; busyRef.current = true; setBusy(true); setError('');
    try { await run(); } catch (failure) { if (current()) setError((failure as Error).message || 'The publishing queue action could not be completed.'); }
    finally { if (current()) { busyRef.current = false; setBusy(false); } }
  }
  async function load() {
    setLoaded(false);
    try {
      const [response, approvals] = await Promise.all([requester.current(path), requester.current(projectPath + '/approvals/posts')]); if (!current()) return;
      if (!Array.isArray(response.queues) || typeof response.version !== 'string' || !Array.isArray(approvals.posts)) throw new Error('The project queues or local post approvals could not be read.');
      setQueues(response.queues); setListVersion(response.version); setPosts(approvals.posts); setApprovalRequired(approvals.requireApproval === true); setLoaded(true); setEnqueueReviews({});
    } catch (failure) {
      const diagnostic = (failure as Error).message;
      throw new Error('Could not load publishing queues.' + (diagnostic ? ' ' + diagnostic : ''));
    }
  }
  function choose(row: Queue | null) { setSelected(row); setDraft(row ? { name: row.name, timezone: row.timezone, slots: row.slots.map(slot => ({ ...slot })), active: row.active } : blank()); setMakeDefault(false); setReshuffle(false); setError(''); setNotice(''); }
  async function write(target: string, body: Row, expected: 'queue' | 'status' | 'delete' | 'post') {
    if (!current()) throw new DOMException('The project or role changed.', 'AbortError');
    const fingerprint = JSON.stringify([target, body]); if (!keys.current.has(fingerprint)) keys.current.set(fingerprint, crypto.randomUUID());
    try {
      const response = await requester.current(target, 'POST', body, keys.current.get(fingerprint));
      const valid = expected === 'queue' ? response.queue && typeof response.queue._id === 'string' && typeof response.queue.version === 'string' : expected === 'status' ? typeof response.queue?._id === 'string' && target.endsWith(`/${encodeURIComponent(response.queue._id)}/status`) && response.queue.active === body.active && typeof response.queue.version === 'string' && Array.isArray(response.queues) && typeof response.version === 'string' && (response.changed === true || response.changed === false && response.queue.version === body.expectedVersion) : expected === 'delete' ? response.deleted === true && typeof response.queueId === 'string' : response.post?.externalId && response.provider?.queueId === body.queueId;
      if (response.operation?.status !== 'complete' || !valid) throw new Error('The queue action receipt could not be read. Your action key has been retained.');
      keys.current.delete(fingerprint); if (!current()) throw new DOMException('The project changed.', 'AbortError'); if (expected !== 'post') setEnqueueReviews({}); return response;
    } catch (failure) { const receipt = failure as Error & { status?: number; code?: string; operation?: { status?: string } }; if (receipt.status && receipt.status < 500 && !['OPERATION_UNCERTAIN', 'OPERATION_IN_PROGRESS', 'OPERATION_PENDING'].includes(receipt.code || '') && !['pending', 'uncertain'].includes(receipt.operation?.status || '')) keys.current.delete(fingerprint); throw failure; }
  }
  async function save(event?: React.FormEvent<HTMLElement>, reshuffleConfirmed = false) {
    event?.preventDefault(); if (!canManage || !loaded) return;
    const target = selected, values = { ...draft, slots: draft.slots.map(slot => ({ ...slot })) }, moveExisting = reshuffle;
    if (moveExisting && !reshuffleConfirmed) { setConfirming({ kind: 'reshuffle' }); return; }
    await action(async () => {
      const response = await write(target ? `${path}/${encodeURIComponent(target._id)}/update` : `${path}/create`, { ...values, ...(target ? { expectedVersion: target.version, setAsDefault: target.isDefault || makeDefault, reshuffleExisting: moveExisting, ...(moveExisting ? { confirmReshuffle: true } : {}) } : { expectedListVersion: listVersion }) }, 'queue');
      if (!current()) return; setQueues(response.queues); setListVersion(response.version); choose(response.queue); setPreview(null); setNotice(`Publishing queue confirmed.${response.reshuffledCount ? ' ' + response.reshuffledCount + ' existing posts rescheduled.' : ''}${response.skippedDailyLimit ? ' ' + response.skippedDailyLimit + ' posts skipped due to provider daily limits.' : ''}`);
    });
  }
  // Pause or reactivate from the list: the status endpoint changes only `active` on the reviewed queue version.
  async function setActive(row: Queue, active: boolean) {
    if (!canManage) return;
    await action(async () => {
      let response; try { response = await write(`${path}/${encodeURIComponent(row._id)}/status`, { active, expectedVersion: row.version }, 'status'); } catch (failure) { throw statusProblem(failure as Error & { code?: string }); }
      if (!current()) return; setQueues(response.queues); setListVersion(response.version); if (selected?._id === row._id) choose(response.queue); setPreview(null);
      setNotice(!response.changed ? `This queue was already ${active ? 'active' : 'paused'}. Nothing was sent.` : active ? 'Publishing queue active. New posts can use its slots.' : 'Publishing queue paused. New posts cannot be added to it until it is active again.');
    });
  }
  function remove(row: Queue) { if (canManage) setConfirming({ kind: 'delete', row }); }
  async function removeConfirmed(row: Queue) {
    if (!canManage) return;
    await action(async () => { const response = await write(`${path}/${encodeURIComponent(row._id)}/delete`, { expectedVersion: row.version, confirmDelete: row._id }, 'delete'); if (!current()) return; setQueues(response.queues); setListVersion(response.version); choose(null); setPreview(null); setNotice('Publishing queue deleted.'); });
  }
  async function inspect(row: Queue) { await action(async () => { const result = await requester.current(`${path}/${encodeURIComponent(row._id)}/preview?count=10`); if (current()) setPreview(result); }); }
  function enqueueReviewKey(item: Row, queue?: Queue) { return JSON.stringify([projectPath, item, queue?.version, approvalRequired]); }
  async function enqueue(item: Row) {
    const post = item.post, queue = queues.find(row => row._id === post.queueId);
    if (!canWrite || !queue?.active || !queue.slots.length || post.queueVersion !== queue.version || approvalRequired && item.status !== 'approved' || enqueueReviews[post.id] !== enqueueReviewKey(item, queue)) return;
    await action(async () => {
      const response = await write(`${projectPath}/integrations/social/publish`, { postId: post.id, queueId: post.queueId }, 'post'); if (!current()) return;
      setPosts(previous => previous.filter(row => row.post.id !== post.id)); setNotice('Post assigned to the provider queue for ' + new Date(response.post.scheduledAt).toLocaleString() + '.');
      try { await onChanged?.(); await load(); } catch (failure) { if (current()) setError('The queue submission was confirmed, but the latest local list could not be refreshed. Refresh before another action.' + ((failure as Error).message ? ' ' + (failure as Error).message : '')); }
    });
  }
  const localPosts = posts.filter(row => row.post?.queueId && !row.post.sample && row.status !== 'submitted' && !row.post.providerFailed);
  return <Card as="section" headingLevel={2} title="Publishing queues" description="Schedule saved posts into recurring weekly slots using the queue’s timezone." actions={<Button variant="secondary" disabled={busy} onClick={() => action(load)}>Refresh queues and posts</Button>}><Stack gap={4}>
    {error && <Alert tone="danger">{error}</Alert>}{notice && <StatusLine>{notice}</StatusLine>}{busy && <StatusLine busy>Working with publishing queues…</StatusLine>}
    {loaded && !queues.length && <Text>No queues exist for this project profile.</Text>}
    {!!queues.length && <DataTable ariaLabel="Publishing queues" searchable={false} sortable={false} pagination={false} rows={queues} rowKey={row => row._id} columns={[{ key: 'name', header: 'Queue', rowHeader: true, render: row => <>{row.name}{row.isDefault && ' · Default'}</> }, { key: 'slots', header: 'Timezone and weekly slots', wrap: true, render: row => <Stack gap={0}><Text>{row.timezone}</Text><Text tone="muted" size="sm">{row.slots.map(slot => days[slot.dayOfWeek] + ' ' + slot.time).join(', ') || 'No slots'}</Text></Stack> }, { key: 'status', header: 'Status', render: row => row.active ? 'Active' : 'Paused' }]} rowActionsLabel="Actions" rowActions={row => <Inline gap={2}><Button variant="secondary" size="sm" disabled={busy || !row.active || !row.slots.length} aria-label={`Preview ${row.name}`} onClick={() => inspect(row)}>Preview</Button>{canManage && <><Button variant="secondary" size="sm" disabled={busy || !row.active && !row.slots.length} aria-label={`${row.active ? 'Pause' : 'Activate'} ${row.name}`} onClick={() => setActive(row, !row.active)}>{row.active ? 'Pause' : 'Activate'}</Button><Button variant="secondary" size="sm" disabled={busy} aria-label={`Edit ${row.name}`} onClick={() => choose(row)}>Edit</Button><Button variant="danger" size="sm" disabled={busy} aria-label={`Delete ${row.name}`} onClick={() => remove(row)}>Delete</Button></>}</Inline>}/>}
    {preview && <Alert tone="info" title={'Upcoming slots · ' + preview.queue.name}><Stack gap={2}><Text>{preview.queue.timezone}. These times are previews; a slot is reserved only when a post is submitted.</Text><List ordered>{preview.slots.map(slot => <ListItem key={slot}>{new Intl.DateTimeFormat(undefined, { timeZone: preview.queue.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(slot))}</ListItem>)}</List></Stack></Alert>}
    {canManage && loaded && <Disclosure variant="boxed" defaultOpen={!!selected || !queues.length} key={selected?._id || 'new'} summary={selected ? 'Edit queue · ' + selected.name : 'Create a queue'}><Stack as="form" gap={3} onSubmit={event => save(event)}><Stack as="fieldset" gap={3} disabled={busy}><FormGrid><Field label="Queue name"><Input required maxLength={200} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })}/></Field><Combobox label="Timezone" required allowCustom={false} options={timeZones} value={draft.timezone} onValueChange={timezone => setDraft({ ...draft, timezone })} error={timeZones.includes(draft.timezone) ? undefined : 'Choose an IANA timezone from the list.'} emptyMessage="No timezone matches."/></FormGrid><Checkbox label="Queue active" checked={draft.active} onChange={event => setDraft({ ...draft, active: event.target.checked })}/>
      <Heading level={3} size="sm">Weekly posting slots</Heading>{draft.slots.map((slot, index) => <FormGrid key={index}><Field label={`Day ${index + 1}`}><Select value={slot.dayOfWeek} onChange={event => setDraft({ ...draft, slots: draft.slots.map((row, position) => position === index ? { ...row, dayOfWeek: Number(event.target.value) } : row) })}>{days.map((day, value) => <Option key={day} value={value}>{day}</Option>)}</Select></Field><Field label={`Time ${index + 1} (${draft.timezone})`}><Input required type="time" value={slot.time} onChange={event => setDraft({ ...draft, slots: draft.slots.map((row, position) => position === index ? { ...row, time: event.target.value } : row) })}/></Field><Inline align="end"><Button variant="secondary" onClick={() => setDraft({ ...draft, slots: draft.slots.filter((_, position) => position !== index) })}>Remove slot {index + 1}</Button></Inline></FormGrid>)}<Inline><Button variant="secondary" disabled={draft.slots.length >= 1000} onClick={() => setDraft({ ...draft, slots: [...draft.slots, { dayOfWeek: 1, time: '09:00' }] })}>Add weekly slot</Button></Inline>
      {selected && <><Checkbox label="Use as the profile’s default queue" checked={selected.isDefault || makeDefault} disabled={selected.isDefault} onChange={event => setMakeDefault(event.target.checked)}/><Checkbox label="Reschedule existing queued posts to these slots" checked={reshuffle} onChange={event => setReshuffle(event.target.checked)}/><Text tone="muted" size="sm">Without rescheduling, existing provider publication times are preserved. A changed queue requires local drafts to review their queue settings again before publication.</Text></>}
      <FormActions><Button type="submit" variant="primary" disabled={!timeZones.includes(draft.timezone)}>{selected ? 'Save queue' : 'Create queue'}</Button>{selected && <Button variant="secondary" onClick={() => choose(null)}>Create another queue</Button>}</FormActions></Stack></Stack></Disclosure>}
    <Stack as="section" gap={3}><Heading level={3} size="sm">Saved posts ready for queues</Heading><Text>Select a queue in a local post’s editor, save it, then obtain approval if the project requires it.</Text>{onOpenApprovals && <Inline><Button variant="secondary" onClick={onOpenApprovals}>Open publishing approvals</Button></Inline>}{loaded && !localPosts.length && <Text>No unsent local posts have a publishing queue selected.</Text>}{localPosts.map(item => { const queue = queues.find(row => row._id === item.post.queueId), changed = queue?.version !== item.post.queueVersion, ready = queue?.active && queue.slots.length && !changed && (!approvalRequired || item.status === 'approved'), reviewKey = enqueueReviewKey(item, queue), reviewed = enqueueReviews[item.post.id] === reviewKey; return <ReviewConfirm key={item.post.id} title={String(item.post.content || 'Media post').slice(0, 140)} reviewKey={reviewKey} acknowledgements={[]} confirmLabel="Add saved post to queue" onConfirm={() => enqueue(item)} busy={busy} disabledReason={!canWrite ? 'Your role cannot submit posts.' : !ready ? changed ? 'Queue settings changed: review the saved post first.' : !queue?.active || !queue?.slots.length ? 'This queue is paused or has no slots.' : 'Approval is required before submitting.' : !reviewed ? 'Check the statement above to continue.' : undefined} onCancel={onEditPost && canWrite ? () => onEditPost(item.post.id) : undefined} cancelLabel="Review saved post"><Stack gap={2}><Text tone="muted" size="sm">{queue?.name || 'Queue unavailable'} · {changed ? 'Queue settings need review' : approvalRequired ? item.status : 'Approval not required by project policy'}</Text>{canWrite && <Checkbox label={`I reviewed this saved post and “${queue?.name || 'this queue'}”. Submitting reserves its next free slot and publishes the post at that time.`} checked={reviewed} disabled={busy || !ready} onChange={event => setEnqueueReviews(previous => ({ ...previous, [item.post.id]: event.target.checked ? reviewKey : '' }))}/>}</Stack></ReviewConfirm>; })}</Stack>
    <ConfirmDialog open={confirming?.kind === 'reshuffle'} onOpenChange={open => { if (!open) setConfirming(null); }} title="Reschedule existing queued posts?" description="Existing queued posts move to the new weekly slots. Their provider publication times will change." confirmLabel="Save and reschedule" danger onConfirm={async () => { setConfirming(null); await save(undefined, true); }}/>
    <ConfirmDialog open={confirming?.kind === 'delete'} onOpenChange={open => { if (!open) setConfirming(null); }} title={confirming?.kind === 'delete' ? `Delete the publishing queue “${confirming.row.name}”?` : 'Delete this publishing queue?'} description="If it is the default, Zernio chooses another default queue." confirmLabel="Delete queue" danger onConfirm={async () => { const target = confirming?.kind === 'delete' ? confirming.row : null; setConfirming(null); if (target) await removeConfirmed(target); }}/>
  </Stack></Card>;
}
