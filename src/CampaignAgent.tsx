import { useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, ConfirmDialog, DescriptionList, Disclosure, EmptyState, Field, Inline, Link, Stack, Text, Textarea } from '@ten98/ui';

type Props = { projectId: string; canWrite: boolean; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>; onSaved: (collection: string) => void; onOpenAdDraft?: (draft: Record<string, any>) => void; onOpenIntegrations?: () => void };
const label: Record<string, string> = { campaigns: 'Campaign draft', posts: 'Social post draft', placements: 'OOH booking draft', ads: 'Ad creative draft' };
// Model and draft text keeps its line breaks without native pre-wrap markup.
const lines = (text: unknown) => <Text preserveWhitespace>{String(text)}</Text>;
export default function CampaignAgent({ projectId, canWrite, request, onSaved, onOpenAdDraft, onOpenIntegrations }: Props) {
  const [status, setStatus] = useState<any>(null), [runs, setRuns] = useState<any[]>([]), [message, setMessage] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirming, setConfirming] = useState<any>(null);
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
  return <Stack gap={4}><Card as="section" title="Write with AI" description="Prepare campaign plans, social posts and ads for review." headingLevel={2}><Stack gap={3}>
    <Stack as="form" gap={3} onSubmit={send}><Stack as="fieldset" gap={3} disabled={busy || !canWrite || !status?.configured}><Field label="Request"><Textarea required value={message} onChange={event => setMessage(event.target.value)} maxLength={12000} placeholder="Plan a two-week launch campaign using our approved assets. Suggest social drafts and a Google Search ad."/></Field><Text tone="muted" size="sm">Requests and selected project data are sent to OpenRouter. Review drafts before saving or opening the ad builder.</Text><Inline><Button type="submit" disabled={!message.trim()}>{busy ? 'Generating…' : 'Generate draft'}</Button></Inline></Stack></Stack>
    {!status?.configured && status && <Alert tone="warning" actions={onOpenIntegrations && <Button variant="secondary" size="sm" onClick={onOpenIntegrations}>Open Connections</Button>}>Writing with AI isn’t set up yet. Ask your admin to turn it on in Settings › Connections.</Alert>}{!canWrite && <Text tone="muted" size="sm">Your workspace role is view only.</Text>}
    <Text size="sm" tone="muted">Model: {status?.model || 'Not configured'}</Text>
  </Stack></Card>{error && <Alert tone="danger">{error}</Alert>}
  <Stack gap={4}>{runs.map(item => <Card as="section" key={item.id} title={item.message} description={`${new Date(item.createdAt).toLocaleString()} · ${item.model}`} headingLevel={2} actions={<Badge>{item.status}</Badge>}><Stack gap={3}>{item.content && <Stack gap={0}>{lines(item.content)}</Stack>}{item.error && <Alert tone="warning">{item.error}</Alert>}
    {item.actions?.map((action: any) => <Card as="article" key={action.id} title={action.data.name || 'Post suggestion'} description={label[action.collection]} headingLevel={3}><Stack gap={2}>{action.data.content && <Stack gap={0}>{lines(action.data.content)}</Stack>}{action.data.description && <Stack gap={0}>{lines(action.data.description)}</Stack>}<DescriptionList items={Object.entries(action.data).filter(([name]) => !['content', 'name', 'description', 'status'].includes(name)).map(([name, value]) => ({ key: name, term: name.replace(/([A-Z])/g, ' $1'), description: Array.isArray(value) ? value.join(', ') : String(value ?? '') }))}/><Inline><Button variant="secondary" disabled={busy || !canWrite || action.status === 'applied'} onClick={() => applyDraft(action)}>{action.collection === 'ads' ? 'Review in ad builder' : action.status === 'applied' ? 'Draft saved' : 'Save as draft'}</Button></Inline></Stack></Card>)}
    <Disclosure summary="Usage and cost" variant="plain"><Inline gap={3}><Text as="span">{item.usage.requests} model requests</Text><Text as="span">{item.usage.promptTokens ?? '—'} input / {item.usage.completionTokens ?? '—'} output tokens</Text><Text as="span">{typeof item.usage.cost === 'number' ? `$${item.usage.cost.toFixed(6)}` : 'Cost not reported'}</Text></Inline></Disclosure>
    {item.status === 'uncertain' && canWrite && <Inline><Link href="https://openrouter.ai/activity" target="_blank" rel="noreferrer">Review OpenRouter activity</Link><Button variant="secondary" disabled={busy} onClick={() => setConfirming(item)}>Mark usage reviewed</Button></Inline>}
  </Stack></Card>)}{!runs.length && <Card><EmptyState title="No drafts yet" description="Describe the content you need. Generated drafts appear here for review."/></Card>}</Stack>
  <ConfirmDialog open={!!confirming} onOpenChange={open => { if (!open) setConfirming(null); }} title="Have you reviewed this request and its charges in OpenRouter?" description="Confirming permits a new model request; it does not refund charges." confirmLabel="Mark usage reviewed" onConfirm={() => run(async () => { await request(`${path}/runs/${confirming.id}/resolve`, 'POST', { confirmedReviewed: true }); key.current = null; await history(); })}/></Stack>;
}
