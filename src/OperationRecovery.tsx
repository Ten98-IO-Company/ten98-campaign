import React, { useEffect, useRef, useState } from 'react';

type Receipt = { id: string; action: string; status: string; createdAt: string; canReview: boolean; reason: string; review: null | { resolution: string; note: string; reference: string; reviewedAt: string; reviewerId: string } };
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
  return <section className="panel settings-panel"><h2>Provider receipts & recovery</h2><p>Review requests whose outcome could not be confirmed. Check the provider dashboard before making another attempt. Unconfirmed requests appear first, followed by recent receipts, up to 100 at a time.</p>
    {!allowed ? <p className="helper-note">An instance operator who owns or administers this workspace can review uncertain outcomes.</p> : <>
      <button type="button" className="button" disabled={busy} onClick={refresh}>{busy ? 'Updating receipts…' : 'Refresh receipts'}</button><label className="checkbox-label"><input type="checkbox" checked={showAll} onChange={event => setShowAll(event.target.checked)}/>Show recent completed and reviewed receipts</label>
      {visible.length ? <div className="table-scroll"><table><thead><tr><th>Action</th><th>Created</th><th>Outcome</th><th>Review</th></tr></thead><tbody>{visible.map(receipt => <tr key={receipt.id}><td><strong>{receipt.action}</strong><br/><small>{receipt.id}</small></td><td>{new Date(receipt.createdAt).toLocaleString()}</td><td>{label(receipt.status)}</td><td>{receipt.canReview ? <button type="button" className="button" disabled={busy} onClick={() => { setSelected(receipt); setError(''); setNotice(''); }}>Review outcome</button> : receipt.review ? <details><summary>View audit note</summary><p>{receipt.review.note}</p>{receipt.review.reference && <p>Provider reference: {receipt.review.reference}</p>}<small>{new Date(receipt.review.reviewedAt).toLocaleString()} · {receipt.review.reviewerId}</small></details> : receipt.reason}</td></tr>)}</tbody></table></div> : <p className="helper-note">{showAll ? 'No provider actions have been recorded in this project.' : 'No uncertain provider outcomes in this project.'}</p>}
      {selected && <form key={selected.id} onSubmit={review}><h3>Record your provider review</h3><p><strong>{selected.action}</strong><br/><small>{selected.id}</small></p><p className="helper-note">This records your assessment. It does not verify provider success, change local campaign records, or run another request. Reviews are final.</p><fieldset disabled={busy}>
        <label className="field"><span>What did the provider show?</span><select name="resolution" required defaultValue=""><option value="" disabled>Choose the verified outcome</option><option value="applied">The provider applied this action — keep repeat requests blocked</option><option value="not_applied">The provider did not apply any part — allow a new manual attempt</option></select></label>
        <label className="field"><span>What you checked *</span><textarea name="note" required minLength={10} maxLength={2000} rows={3} placeholder="Describe the provider dashboard, receipt, and result you checked."/></label>
        <label className="field"><span>Provider reference (optional)</span><input name="reference" maxLength={500} placeholder="Provider receipt or campaign reference"/></label>
        <p className="helper-note">Include references needed for the audit. Keep API keys and customer information out of the note. If any part was applied or is still processing, keep repeat requests blocked.</p>
        <label className="checkbox-label"><input type="checkbox" name="confirmChecked" required/>I checked the provider directly and understand that an incorrect “not applied” review could cause duplicate publishing, bookings, or charges.</label>
        <button className="button primary">Record final review</button><button type="button" className="button" onClick={() => setSelected(null)}>Cancel</button>
      </fieldset></form>}
    </>}
    {error && <p className="alert" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
