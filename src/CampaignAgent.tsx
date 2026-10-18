import { useEffect, useRef, useState } from 'react';

type Props = { projectId: string; canWrite: boolean; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>; onSaved: (collection: string) => void; onOpenAdDraft?: (draft: Record<string, any>) => void };
const label: Record<string, string> = { campaigns: 'Campaign draft', posts: 'Social post draft', placements: 'OOH booking draft', ads: 'Ad creative draft' };
export default function CampaignAgent({ projectId, canWrite, request, onSaved, onOpenAdDraft }: Props) {
  const [status, setStatus] = useState<any>(null), [runs, setRuns] = useState<any[]>([]), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const key = useRef<{ input: string; value: string } | null>(null), active = useRef(true), path = `/projects/${projectId}/agent`;
  async function history() { const data = await request(path + '/history'); if (active.current) setRuns(data.runs); }
  useEffect(() => { active.current = true; Promise.all([request(path + '/status'), request(path + '/history')]).then(([config, data]) => { if (active.current) { setStatus(config); setRuns(data.runs); } }).catch(err => { if (active.current) setError(err.message); }); return () => { active.current = false; }; }, [projectId]);
  async function run(action: () => Promise<void>) { if (busy) return; setBusy(true); setError(''); try { await action(); } catch (err) { if (active.current) setError((err as Error).message); } finally { if (active.current) setBusy(false); } }
  async function send(event: React.FormEvent) {
    event.preventDefault(); const input = JSON.stringify({ message });
    if (!key.current || key.current.input !== input) key.current = { input, value: crypto.randomUUID() };
    await run(async () => {
      try { const result = await request(path + '/run', 'POST', { message }, key.current!.value); if (active.current) { setRuns(rows => [result.run, ...rows.filter(r => r.id !== result.run.id)]); setMessage(''); key.current = null; } }
      catch (error) { const failure = error as any; if (failure.status && failure.run?.status !== 'uncertain') key.current = null; await history().catch(() => {}); throw error; }
    });
  }
  async function applyDraft(action: any) {
    await run(async () => {
      const result = await request(`${path}/actions/${action.id}/apply`, 'POST', {});
      if (!active.current) return;
      if (action.collection === 'ads') { onOpenAdDraft?.(result.adDraft); return; }
      await history(); onSaved(action.collection);
    });
  }
  return <div className="agent-layout"><section className="panel agent-compose"><div className="panel-heading"><div><h2>Draft content</h2><p>Prepare campaign plans, social posts and ads for review.</p></div></div>
    <form onSubmit={send}><fieldset disabled={busy || !canWrite || !status?.configured}><label className="field"><span>Request</span><textarea required value={message} onChange={event => setMessage(event.target.value)} maxLength={12000} placeholder="Plan a two-week launch campaign using our approved assets. Suggest social drafts and a Google Search ad."/></label><p className="field-help">Requests and selected project data are sent to OpenRouter. Review drafts before saving or opening the ad builder.</p><button className="button primary" disabled={!message.trim()}>{busy ? 'Generating…' : 'Generate draft'}</button></fieldset></form>
    {!status?.configured && status && <p className="alert">Your instance operator needs to configure the OpenRouter API key and a model with tool calling.</p>}{!canWrite && <p className="helper-note">Your workspace role is view only.</p>}
    <div className="agent-model"><span>Model: {status?.model || 'Not configured'}</span></div>
  </section>{error && <p className="alert error" role="alert">{error}</p>}
  <div className="agent-history">{runs.map(item => <section className="panel agent-run" key={item.id}><div className="panel-heading"><div><h2>{item.message}</h2><p>{new Date(item.createdAt).toLocaleString()} · {item.model}</p></div><span className="badge">{item.status}</span></div>{item.content && <p className="agent-answer">{item.content}</p>}{item.error && <p className="alert">{item.error}</p>}
    {item.actions?.map((action: any) => <article className="agent-proposal" key={action.id}><span className="eyebrow">{label[action.collection]}</span><h3>{action.data.name || 'Post suggestion'}</h3>{action.data.content && <p>{action.data.content}</p>}{action.data.description && <p>{action.data.description}</p>}<dl>{Object.entries(action.data).filter(([name]) => !['content', 'name', 'description', 'status'].includes(name)).map(([name, value]) => <div key={name}><dt>{name.replace(/([A-Z])/g, ' $1')}</dt><dd>{Array.isArray(value) ? value.join(', ') : String(value ?? '')}</dd></div>)}</dl><button className="button" disabled={busy || !canWrite || action.status === 'applied'} onClick={() => applyDraft(action)}>{action.collection === 'ads' ? 'Review in ad builder' : action.status === 'applied' ? 'Draft saved' : 'Save as draft'}</button></article>)}
    <details className="agent-usage"><summary>Usage and cost</summary><div className="agent-receipt"><span>{item.usage.requests} model requests</span><span>{item.usage.promptTokens ?? '—'} input / {item.usage.completionTokens ?? '—'} output tokens</span><span>{typeof item.usage.cost === 'number' ? `$${item.usage.cost.toFixed(6)}` : 'Cost not reported'}</span></div></details>
    {item.status === 'uncertain' && canWrite && <div className="agent-review"><a className="text-link" href="https://openrouter.ai/activity" target="_blank" rel="noreferrer">Review OpenRouter activity</a><button className="button" disabled={busy} onClick={() => { if (!window.confirm('Have you reviewed this request and its charges in OpenRouter? Confirming permits a new model request; it does not refund charges.')) return; run(async () => { await request(`${path}/runs/${item.id}/resolve`, 'POST', { confirmedReviewed: true }); key.current = null; await history(); }); }}>Mark usage reviewed</button></div>}
  </section>)}{!runs.length && <section className="panel"><div className="empty"><h3>No drafts yet</h3><p>Describe the content you need. Generated drafts appear here for review.</p></div></section>}</div></div>;
}
