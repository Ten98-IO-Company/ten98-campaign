import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, DataTable, Disclosure, Field, FormActions, Heading, Inline, Input, Option, Select, StatusLine, Stack, Text, Textarea } from '@ten98/ui';

type Receipt = { id: string; action: string; status: string; createdAt: string; canReview: boolean; reason: string; productCreation?: { accountId: string; productId: string | null }; campaignCopy?: { sourceCampaignId: string; platform: string; copiedCampaignId: string | null; discovery: string | null; requestedStatus: 'PAUSED'; verification: 'pending' | 'paused'; statusReadAt: string | null }; review: null | { resolution: string; note: string; reference: string; reviewedAt: string; reviewerId: string } };
type Props = { projectId: string; role: string; isOperator: boolean; request: (path: string, method?: string, body?: unknown) => Promise<any>; onReviewed?: (resolution: string) => void };
const label = (status: string) => ({ pending: 'Awaiting receipt', uncertain: 'Needs review', 'reviewed-applied': 'Operator reports applied', 'reviewed-not-applied': 'Operator reports not applied', complete: 'Request completed', failed: 'Failed' }[status] || status);
export default function OperationRecovery({ projectId, role, isOperator, request, onReviewed }: Props) {
  const [receipts, setReceipts] = useState<Receipt[]>([]), [selected, setSelected] = useState<Receipt | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [showAll, setShowAll] = useState(false);
  const version = useRef(0), readVersion = useRef(0), allowed = isOperator && ['owner', 'admin'].includes(role), path = '/projects/' + encodeURIComponent(projectId) + '/operations';
  async function load(generation = version.current) {
    const read = ++readVersion.current;
    try { const result = await request(path); if (!Array.isArray(result.operations)) throw new Error('The provider receipts could not be read.'); if (generation === version.current && read === readVersion.current) setReceipts(result.operations); }
    catch (err) { if (generation === version.current && read === readVersion.current) throw err; }
  }
  useEffect(() => {
    const generation = ++version.current; setReceipts([]); setSelected(null); setError(''); setNotice(''); setBusy(false);
    if (allowed) { const loading = load(generation), read = readVersion.current; loading.catch(err => { if (generation === version.current && read === readVersion.current) setError((err as Error).message); }); }
    return () => { version.current++; };
  }, [projectId, allowed]);
  async function refresh() {
    if (busy) return; const generation = version.current; setBusy(true); setError('');
    try { await load(generation); } catch (err) { if (generation === version.current) setError((err as Error).message); } finally { if (generation === version.current) setBusy(false); }
  }
  async function review(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !selected || !allowed) return;
    const values = Object.fromEntries(new FormData(event.currentTarget)), generation = version.current;
    readVersion.current++; setBusy(true); setError(''); setNotice('');
    try {
      const result = await request(path + '/' + encodeURIComponent(selected.id) + '/review', 'POST', { resolution: values.resolution, note: values.note, reference: values.reference, confirmChecked: values.confirmChecked === 'on' });
      if (generation !== version.current) return;
      setSelected(null); setNotice(result.message); onReviewed?.(String(values.resolution)); await load(generation);
    } catch (err) { if (generation === version.current) setError((err as Error).message || 'The review could not be recorded.'); }
    finally { if (generation === version.current) setBusy(false); }
  }
  const visible = receipts.filter(receipt => showAll || ['pending', 'uncertain'].includes(receipt.status));
  return <Card as="section" title="Provider receipts & recovery" headingLevel={2}><Stack gap={3}><Text>Review requests whose outcome could not be confirmed. Check the provider dashboard before making another attempt. Unconfirmed requests appear first, followed by recent receipts, up to 100 at a time.</Text>
    {!allowed ? <Text tone="muted" size="sm">An instance operator who owns or administers this workspace can review uncertain outcomes.</Text> : <>
      <Inline><Button variant="secondary" disabled={busy} onClick={refresh}>{busy ? 'Updating receipts…' : 'Refresh receipts'}</Button><Checkbox label="Show recent completed and reviewed receipts" checked={showAll} onChange={event => setShowAll(event.target.checked)}/></Inline>
      {visible.length ? <DataTable ariaLabel="Provider receipts" searchable={false} sortable={false} pagination={false} rows={visible} rowKey={receipt => receipt.id} columns={[
        { key: 'action', header: 'Action', wrap: true, render: receipt => <Stack gap={1}><Text as="strong">{receipt.action}</Text><Text as="small" tone="muted">{receipt.id}</Text>{receipt.productCreation && <Stack gap={0}><Text size="sm" tone="muted">Store account: {receipt.productCreation.accountId}</Text><Text size="sm" tone="muted">Native product ID: {receipt.productCreation.productId ?? 'Not established'}</Text><Text size="sm" tone="muted">This reference does not confirm that the draft was created.</Text></Stack>}{receipt.campaignCopy && <Stack gap={0}><Text size="sm" tone="muted">Campaign copy · {receipt.campaignCopy.platform}</Text><Text size="sm" tone="muted">Source campaign: {receipt.campaignCopy.sourceCampaignId}</Text><Text size="sm" tone="muted">Provider-reported copied campaign ID: {receipt.campaignCopy.copiedCampaignId ?? 'Not established'}</Text><Text size="sm" tone="muted">Discovery reported: {receipt.campaignCopy.discovery ?? 'Not established'}</Text><Text size="sm" tone="muted">Requested initial status: {receipt.campaignCopy.requestedStatus}</Text><Text size="sm" tone="muted">Recorded verification: {receipt.campaignCopy.verification === 'paused' ? 'Paused readback recorded' : 'Not verified'}{receipt.campaignCopy.statusReadAt && <> · {receipt.campaignCopy.statusReadAt}</>}</Text><Text size="sm" tone="muted">A reported ID alone does not establish successful copying, ownership or current delivery. Check the provider directly before recording the final review.</Text></Stack>}</Stack> },
        { key: 'created', header: 'Created', render: receipt => new Date(receipt.createdAt).toLocaleString() },
        { key: 'outcome', header: 'Outcome', render: receipt => label(receipt.status) },
        { key: 'review', header: 'Review', render: receipt => receipt.canReview ? <Button variant="secondary" size="sm" disabled={busy} onClick={() => { setSelected(receipt); setError(''); setNotice(''); }}>Review outcome</Button> : receipt.review ? <Disclosure summary="View audit note" variant="plain"><Text>{receipt.review.note}</Text>{receipt.review.reference && <Text>Provider reference: {receipt.review.reference}</Text>}<Text as="small" tone="muted">{new Date(receipt.review.reviewedAt).toLocaleString()} · {receipt.review.reviewerId}</Text></Disclosure> : receipt.reason }
      ]}/> : <Text tone="muted" size="sm">{showAll ? 'No provider actions have been recorded in this project.' : 'No uncertain provider outcomes in this project.'}</Text>}
      {selected && <Stack as="form" gap={3} key={selected.id} onSubmit={review}><Heading level={3}>Record your provider review</Heading><Stack gap={0}><Text as="strong">{selected.action}</Text><Text as="small" tone="muted">{selected.id}</Text></Stack><Text tone="muted" size="sm">This records your assessment. It does not verify provider success, change local campaign records, or run another request. Reviews are final.</Text><Stack as="fieldset" gap={3} disabled={busy}>
        <Field label="What did the provider show?"><Select name="resolution" required defaultValue=""><Option value="" disabled>Choose the verified outcome</Option><Option value="applied">The provider applied this action — keep repeat requests blocked</Option><Option value="not_applied">The provider did not apply any part — allow a new manual attempt</Option></Select></Field>
        <Field label="What you checked"><Textarea name="note" required minLength={10} maxLength={2000} rows={3} placeholder="Describe the provider dashboard, receipt, and result you checked."/></Field>
        <Field label="Provider reference (optional)"><Input name="reference" maxLength={500} placeholder="Provider receipt or campaign reference"/></Field>
        <Text tone="muted" size="sm">Include references needed for the audit. Keep API keys and customer information out of the note. If any part was applied or is still processing, keep repeat requests blocked.</Text>
        <Checkbox name="confirmChecked" required label="I checked the provider directly and understand that an incorrect “not applied” review could cause duplicate publishing, bookings, or charges."/>
        <FormActions><Button type="submit">Record final review</Button><Button variant="secondary" onClick={() => setSelected(null)}>Cancel</Button></FormActions>
      </Stack></Stack>}
    </>}
    {error && <Alert tone="danger">{error}</Alert>}{notice && <StatusLine>{notice}</StatusLine>}
  </Stack></Card>;
}
