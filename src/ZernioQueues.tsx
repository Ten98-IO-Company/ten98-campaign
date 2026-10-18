import React, { useEffect, useRef, useState } from 'react';

type Slot = { dayOfWeek: number; time: string };
type Queue = { _id: string; name: string; timezone: string; slots: Slot[]; active: boolean; isDefault: boolean; version: string };
type Row = Record<string, any>;
type Props = { projectId: string; canManage: boolean; canWrite: boolean; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>; onChanged?: () => void | Promise<void>; onEditPost?: (postId: string) => void; onOpenApprovals?: () => void };
const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const blank = () => ({ name: '', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', slots: [{ dayOfWeek: 1, time: '09:00' }], active: true });

export default function ZernioQueues({ projectId, canManage, canWrite, request, onChanged, onEditPost, onOpenApprovals }: Props) {
  const path = `/projects/${encodeURIComponent(projectId)}/integrations/queues`, projectPath = `/projects/${encodeURIComponent(projectId)}`;
  const [queues, setQueues] = useState<Queue[]>([]), [listVersion, setListVersion] = useState(''), [selected, setSelected] = useState<Queue | null>(null), [draft, setDraft] = useState(blank);
  const [makeDefault, setMakeDefault] = useState(false), [reshuffle, setReshuffle] = useState(false), [preview, setPreview] = useState<{ queue: Queue; slots: string[] } | null>(null);
  const [posts, setPosts] = useState<Row[]>([]), [approvalRequired, setApprovalRequired] = useState(false), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [enqueueReviews, setEnqueueReviews] = useState<Record<string, string>>({});
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
    const [response, approvals] = await Promise.all([requester.current(path), requester.current(projectPath + '/approvals/posts')]); if (!current()) return;
    if (!Array.isArray(response.queues) || typeof response.version !== 'string' || !Array.isArray(approvals.posts)) throw new Error('The project queues or local post approvals could not be read.');
    setQueues(response.queues); setListVersion(response.version); setPosts(approvals.posts); setApprovalRequired(approvals.requireApproval === true); setLoaded(true); setEnqueueReviews({});
  }
  function choose(row: Queue | null) { setSelected(row); setDraft(row ? { name: row.name, timezone: row.timezone, slots: row.slots.map(slot => ({ ...slot })), active: row.active } : blank()); setMakeDefault(false); setReshuffle(false); setError(''); setNotice(''); }
  async function write(target: string, body: Row, expected: 'queue' | 'delete' | 'post') {
    if (!current()) throw new DOMException('The project or role changed.', 'AbortError');
    const fingerprint = JSON.stringify([target, body]); if (!keys.current.has(fingerprint)) keys.current.set(fingerprint, crypto.randomUUID());
    try {
      const response = await requester.current(target, 'POST', body, keys.current.get(fingerprint));
      const valid = expected === 'queue' ? response.queue && typeof response.queue._id === 'string' && typeof response.queue.version === 'string' : expected === 'delete' ? response.deleted === true && typeof response.queueId === 'string' : response.post?.externalId && response.provider?.queueId === body.queueId;
      if (response.operation?.status !== 'complete' || !valid) throw new Error('The queue action receipt could not be read. Your action key has been retained.');
      keys.current.delete(fingerprint); if (!current()) throw new DOMException('The project changed.', 'AbortError'); if (expected !== 'post') setEnqueueReviews({}); return response;
    } catch (failure) { const receipt = failure as Error & { status?: number; code?: string; operation?: { status?: string } }; if (receipt.status && receipt.status < 500 && !['OPERATION_UNCERTAIN', 'OPERATION_IN_PROGRESS', 'OPERATION_PENDING'].includes(receipt.code || '') && !['pending', 'uncertain'].includes(receipt.operation?.status || '')) keys.current.delete(fingerprint); throw failure; }
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!canManage || !loaded) return;
    const target = selected, values = { ...draft, slots: draft.slots.map(slot => ({ ...slot })) }, moveExisting = reshuffle;
    if (moveExisting && !window.confirm('Reschedule existing queued posts to the new weekly slots? Their provider publication times will change.')) return;
    await action(async () => {
      const response = await write(target ? `${path}/${encodeURIComponent(target._id)}/update` : `${path}/create`, { ...values, ...(target ? { expectedVersion: target.version, setAsDefault: target.isDefault || makeDefault, reshuffleExisting: moveExisting, ...(moveExisting ? { confirmReshuffle: true } : {}) } : { expectedListVersion: listVersion }) }, 'queue');
      if (!current()) return; setQueues(response.queues); setListVersion(response.version); choose(response.queue); setPreview(null); setNotice(`Publishing queue confirmed.${response.reshuffledCount ? ' ' + response.reshuffledCount + ' existing posts rescheduled.' : ''}${response.skippedDailyLimit ? ' ' + response.skippedDailyLimit + ' posts skipped due to provider daily limits.' : ''}`);
    });
  }
  async function remove(row: Queue) {
    if (!canManage || !window.confirm(`Delete the publishing queue “${row.name}”? If it is the default, Zernio chooses another default queue.`)) return;
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
      try { await onChanged?.(); await load(); } catch { if (current()) setError('The queue submission was confirmed, but the latest local list could not be refreshed. Refresh before another action.'); }
    });
  }
  const localPosts = posts.filter(row => row.post?.queueId && !row.post.sample && row.status !== 'submitted' && !row.post.providerFailed);
  return <section className="panel settings-panel"><div className="panel-heading"><div><h2>Publishing queues</h2><p>Schedule saved posts into recurring weekly slots using the queue’s timezone.</p></div><button className="button" type="button" disabled={busy} onClick={() => action(load)}>Refresh queues and posts</button></div>
    {error && <p className="alert" role="alert">{error}</p>}{notice && <p className="helper-note" role="status">{notice}</p>}{busy && <p role="status">Working with publishing queues…</p>}
    {loaded && !queues.length && <p>No queues exist for this project profile.</p>}
    {!!queues.length && <div className="table-scroll"><table><thead><tr><th>Queue</th><th>Timezone and weekly slots</th><th>Status</th><th>Actions</th></tr></thead><tbody>{queues.map(row => <tr key={row._id}><td>{row.name}{row.isDefault && ' · Default'}</td><td>{row.timezone}<p>{row.slots.map(slot => days[slot.dayOfWeek] + ' ' + slot.time).join(', ') || 'No slots'}</p></td><td>{row.active ? 'Active' : 'Paused'}</td><td><div className="button-wrap"><button className="button" disabled={busy || !row.active || !row.slots.length} onClick={() => inspect(row)}>Preview {row.name}</button>{canManage && <><button className="button" disabled={busy} onClick={() => choose(row)}>Edit {row.name}</button><button className="button danger" disabled={busy} onClick={() => remove(row)}>Delete {row.name}</button></>}</div></td></tr>)}</tbody></table></div>}
    {preview && <div className="helper-note"><h3>Upcoming slots · {preview.queue.name}</h3><p>{preview.queue.timezone}. These times are previews; a slot is reserved only when a post is submitted.</p><ol>{preview.slots.map(slot => <li key={slot}>{new Intl.DateTimeFormat(undefined, { timeZone: preview.queue.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(slot))}</li>)}</ol></div>}
    {canManage && loaded && <details open={!!selected || !queues.length}><summary>{selected ? 'Edit queue · ' + selected.name : 'Create a queue'}</summary><form onSubmit={save}><fieldset disabled={busy}><div className="form-grid"><label className="field"><span>Queue name</span><input required maxLength={200} value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })}/></label><label className="field"><span>IANA timezone</span><input required maxLength={100} placeholder="Asia/Dubai" value={draft.timezone} onChange={event => setDraft({ ...draft, timezone: event.target.value })}/></label></div><label className="checkbox-label"><input type="checkbox" checked={draft.active} onChange={event => setDraft({ ...draft, active: event.target.checked })}/>Queue active</label>
      <h4>Weekly posting slots</h4>{draft.slots.map((slot, index) => <div className="form-grid" key={index}><label className="field"><span>Day {index + 1}</span><select value={slot.dayOfWeek} onChange={event => setDraft({ ...draft, slots: draft.slots.map((row, position) => position === index ? { ...row, dayOfWeek: Number(event.target.value) } : row) })}>{days.map((day, value) => <option key={day} value={value}>{day}</option>)}</select></label><label className="field"><span>Time {index + 1} ({draft.timezone})</span><input required type="time" value={slot.time} onChange={event => setDraft({ ...draft, slots: draft.slots.map((row, position) => position === index ? { ...row, time: event.target.value } : row) })}/></label><button className="button" type="button" onClick={() => setDraft({ ...draft, slots: draft.slots.filter((_, position) => position !== index) })}>Remove slot {index + 1}</button></div>)}<button className="button" type="button" disabled={draft.slots.length >= 1000} onClick={() => setDraft({ ...draft, slots: [...draft.slots, { dayOfWeek: 1, time: '09:00' }] })}>Add weekly slot</button>
      {selected && <><label className="checkbox-label"><input type="checkbox" checked={selected.isDefault || makeDefault} disabled={selected.isDefault} onChange={event => setMakeDefault(event.target.checked)}/>Use as the profile’s default queue</label><label className="checkbox-label"><input type="checkbox" checked={reshuffle} onChange={event => setReshuffle(event.target.checked)}/>Reschedule existing queued posts to these slots</label><p className="helper-note">Without rescheduling, existing provider publication times are preserved. A changed queue requires local drafts to review their queue settings again before publication.</p></>}
      <div className="button-wrap"><button className="button primary">{selected ? 'Save queue' : 'Create queue'}</button>{selected && <button className="button" type="button" onClick={() => choose(null)}>Create another queue</button>}</div></fieldset></form></details>}
    <div className="settings-panel"><h3>Saved posts ready for queues</h3><p>Select a queue in a local post’s editor, save it, then obtain approval if the project requires it.</p>{onOpenApprovals && <button className="button" type="button" onClick={onOpenApprovals}>Open publishing approvals</button>}{!localPosts.length && <p>No unsent local posts have a publishing queue selected.</p>}{localPosts.map(item => { const queue = queues.find(row => row._id === item.post.queueId), changed = queue?.version !== item.post.queueVersion, ready = queue?.active && queue.slots.length && !changed && (!approvalRequired || item.status === 'approved'), reviewKey = enqueueReviewKey(item, queue), reviewed = enqueueReviews[item.post.id] === reviewKey; return <div className="helper-note" key={item.post.id}><strong>{String(item.post.content || 'Media post').slice(0, 140)}</strong><p>{queue?.name || 'Queue unavailable'} · {changed ? 'Queue settings need review' : approvalRequired ? item.status : 'Approval not required by project policy'}</p>{canWrite && <label className="checkbox-label"><input type="checkbox" checked={reviewed} disabled={busy || !ready} onChange={event => setEnqueueReviews(previous => ({ ...previous, [item.post.id]: event.target.checked ? reviewKey : '' }))}/>I reviewed this saved post and “{queue?.name || 'this queue'}”. Submitting reserves its next free slot and publishes the post at that time.</label>}<div className="button-wrap">{onEditPost && canWrite && <button className="button" type="button" disabled={busy} onClick={() => onEditPost(item.post.id)}>Review saved post</button>}{canWrite && <button className="button primary" type="button" disabled={busy || !ready || !reviewed} onClick={() => enqueue(item)}>Add saved post to queue</button>}</div></div>; })}</div>
  </section>;
}
