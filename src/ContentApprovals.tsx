import { useEffect, useRef, useState } from 'react';

type Props = { projectId: string; role: string; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>; onChanged?: () => void | Promise<void> };
const label = (value: string) => ({ not_requested: 'Not requested', pending: 'Awaiting review', approved: 'Approved', rejected: 'Changes requested', stale: 'Changed since review', submitted: 'Submitted to provider' }[value] || value);
const when = (value: string) => new Date(value).toLocaleString();
function link(value?: string) { try { const url = new URL(value || ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; } }

export default function ContentApprovals({ projectId, role, request, onChanged }: Props) {
  const [data, setData] = useState<any>(null), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [filter, setFilter] = useState('all'), [notes, setNotes] = useState<Record<string, string>>({});
  const active = useRef(true), path = `/projects/${encodeURIComponent(projectId)}/approvals`, canReview = ['owner', 'admin'].includes(role), canRequest = ['owner', 'admin', 'editor'].includes(role);
  async function load() { const result = await request(path + '/posts'); if (active.current) setData(result); }
  useEffect(() => { active.current = true; load().catch(err => { if (active.current) setError(err.message); }); return () => { active.current = false; }; }, [projectId]);
  async function action(name: string, run: () => Promise<void>) {
    if (busy) return; setBusy(name); setError(''); setNotice('');
    try { await run(); } catch (err) { if (active.current) setError((err as Error).message || 'This review could not be saved.'); }
    finally { if (active.current) setBusy(''); }
  }
  async function review(item: any, decision: string) {
    await action(item.post.id, async () => { await request(`${path}/posts/${encodeURIComponent(item.post.id)}/review`, 'POST', { decision, note: notes[item.post.id] || '', reviewId: item.review.id }); await load(); if (active.current) { setNotes(previous => ({ ...previous, [item.post.id]: '' })); setNotice(decision === 'approved' ? 'Post approved. Publishing remains a separate action.' : 'Changes requested. The author can update this draft and request another review.'); } await onChanged?.(); });
  }
  const posts = (data?.posts || []).filter((item: any) => !item.post.sample && (filter === 'all' || item.status === filter));
  return <div>
    <section className="panel settings-panel"><h2>Review before publishing</h2><p>Owners and administrators review the exact text, recipients, schedule, and creative. Changes to a post or its referenced asset require a new review.</p>
      {data && <p className="helper-note">Publishing approval is <strong>{data.requireApproval ? 'required' : 'optional'}</strong> for this project. Approving a post never publishes it.</p>}
      {canReview && data && <label className="checkbox-label"><input type="checkbox" disabled={Boolean(busy)} checked={data.requireApproval} onChange={event => { const requireApproval = event.target.checked; action('policy', async () => { await request(path + '/policy', 'POST', { requireApproval }); await load(); if (active.current) setNotice(requireApproval ? 'Every post now needs current approval before publishing or retrying.' : 'Publishing approval is now optional.'); await onChanged?.(); }); }}/>Require approval before publishing</label>}
      <div className="button-wrap"><button className="button" type="button" disabled={Boolean(busy)} onClick={() => action('refresh', load)}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh review queue'}</button></div>
      {data?.requireApproval && <p className="field-help">While approval is required, an owner or administrator must make changes to posts already submitted to a provider. Editors can still cancel or remove copies using the publishing controls.</p>}
    </section>
    {error && <p className="alert error" role="alert">{error}</p>}{notice && <p className="helper-note" role="status">{notice}</p>}
    <div className="list-toolbar standalone"><div className="tabs">{['all', 'pending', 'stale', 'approved', 'rejected', 'not_requested'].map(value => <button type="button" key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{value === 'all' ? 'All posts' : label(value)}</button>)}</div></div>
    {!data && !error && <p role="status">Loading the review queue…</p>}
    {posts.map((item: any) => { const post = item.post, reviewData = item.review, creative = link(item.asset?.deliveryUrl || item.asset?.url), submitted = item.status === 'submitted'; return <section className="panel settings-panel" key={post.id}>
      <div className="panel-heading"><div><h2>{post.platforms?.length ? post.platforms.join(', ') : 'Social post draft'}</h2><p>{post.scheduledAt ? `Planned for ${when(post.scheduledAt)}` : 'No planned publishing time'}{post.accounts?.length ? ` · ${post.accounts.length} selected account${post.accounts.length === 1 ? '' : 's'}` : ''}</p></div><span className={`badge ${item.status === 'approved' ? 'approved' : item.status === 'rejected' ? 'rejected' : 'pending'}`}>{label(item.status)}</span></div>
      <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginBottom: 15 }}>{post.content}</p>
      {post.providerFailed && <p className="helper-note">Every provider copy failed. Review its latest text and creative here before retrying from Publishing. Refresh the provider status after making any changes in Zernio.</p>}
      {item.asset && <p className="helper-note">Referenced creative: {item.asset.missing ? 'Missing from this project' : item.asset.approval === 'approved' ? 'Approved asset' : 'Asset approval required'}{creative && <> · <a href={creative} target="_blank" rel="noopener noreferrer">Open creative</a></>}</p>}
      {!!post.mediaItems?.length && <div className="button-wrap">{post.mediaItems.map((media: any, index: number) => { const url = link(media.url); return url && <a key={index} className="text-link" href={url} target="_blank" rel="noopener noreferrer">View {media.type || 'media'} {index + 1}</a>; })}</div>}
      {reviewData && <div className="details"><p className="helper-note">Requested by {reviewData.requestedBy?.name || 'Team member'} · {when(reviewData.requestedAt)}{reviewData.reviewedAt && <> · {label(reviewData.status)} by {reviewData.reviewedBy?.name || 'Administrator'} · {when(reviewData.reviewedAt)}</>}</p>{reviewData.note && <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{reviewData.note}</p>}</div>}
      {item.status === 'stale' && <p className="helper-note">The current draft differs from the reviewed version. Request review again after your edits are ready.</p>}
      {!submitted && canRequest && !['pending', 'approved'].includes(item.status) && <button className="button" type="button" disabled={Boolean(busy)} onClick={() => action(post.id, async () => { await request(`${path}/posts/${encodeURIComponent(post.id)}/request`, 'POST', {}); await load(); if (active.current) setNotice('Review requested. An owner or administrator can approve or request changes.'); await onChanged?.(); })}>{busy === post.id ? 'Saving…' : 'Request review'}</button>}
      {canReview && item.status === 'pending' && <fieldset disabled={Boolean(busy)}><label className="field"><span>Review note (optional)</span><textarea rows={2} maxLength={2000} value={notes[post.id] || ''} onChange={event => setNotes(previous => ({ ...previous, [post.id]: event.target.value }))}/></label><div className="button-wrap"><button className="button primary" type="button" disabled={Boolean(item.asset && (item.asset.missing || item.asset.approval !== 'approved'))} onClick={() => review(item, 'approved')}>Approve post</button><button className="button" type="button" onClick={() => review(item, 'rejected')}>Request changes</button></div></fieldset>}
    </section>; })}
    {data && !posts.length && <section className="panel"><div className="empty"><h3>No posts in this review view.</h3><p>Create a post draft in Publishing, then request review here.</p></div></section>}
  </div>;
}
