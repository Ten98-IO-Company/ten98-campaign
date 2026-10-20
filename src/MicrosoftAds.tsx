import React, { useEffect, useRef, useState } from 'react';

type Row = Record<string, any>;
type Props = { projectId: string; role: string; isOperator: boolean; request: (path: string, method?: string, body?: any, key?: string) => Promise<any>; onChanged?: () => void | Promise<void>; mode?: 'workflow' | 'connection'; onOpenIntegrations?: () => void };
const lines = (value: FormDataEntryValue | null) => String(value || '').split('\n').map(row => row.trim()).filter(Boolean);
const today = () => new Date().toISOString().slice(0, 10);

export default function MicrosoftAds({ projectId, role, isOperator, request, onChanged, mode = 'workflow', onOpenIntegrations }: Props) {
  const path = `/projects/${encodeURIComponent(projectId)}/microsoft-ads`, active = useRef(true), readVersion = useRef(0), pending = useRef(false), keys = useRef(new Map<string, string>()), requester = useRef(request); requester.current = request;
  const [status, setStatus] = useState<Row | null>(null), [campaigns, setCampaigns] = useState<Row[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [report, setReport] = useState<Row | null>(null);
  const canWrite = ['owner', 'admin', 'editor'].includes(role), canMap = isOperator && ['owner', 'admin'].includes(role);
  async function load() {
    if (!active.current) return;
    const read = ++readVersion.current;
    try {
      const result = await requester.current(path + '/status'); if (!active.current || read !== readVersion.current) return; setStatus(result);
      if (mode === 'workflow') setReport(previous => previous || result.latestReport || null);
      if (mode === 'workflow' && result.configured && result.mapping) { const listed = await requester.current(path + '/campaigns'); if (active.current && read === readVersion.current) setCampaigns(listed.campaigns); }
    } catch (failure) { if (active.current && read === readVersion.current) throw failure; }
  }
  useEffect(() => { active.current = true; const loading = load(), read = readVersion.current; loading.catch(failure => { if (active.current && read === readVersion.current) setError(failure.message); }); return () => { active.current = false; }; }, [projectId, mode]);
  async function action(run: () => Promise<void>) {
    if (pending.current || !active.current) return; readVersion.current++; pending.current = true; setBusy(true); setError(''); setNotice('');
    try { await run(); } catch (failure) { if (active.current) setError((failure as Error).message || 'Microsoft Advertising could not complete this action.'); }
    finally { if (active.current) { pending.current = false; setBusy(false); } }
  }
  async function write(target: string, body: Row) {
    if (!active.current) throw new DOMException('This view closed.', 'AbortError');
    const signature = JSON.stringify([target, body]); if (!keys.current.has(signature)) keys.current.set(signature, crypto.randomUUID());
    let result;
    try { result = await requester.current(target, 'POST', body, keys.current.get(signature)); }
    catch (failure) { const err = failure as any; if (err.operation?.status === 'failed' || err.status && err.status < 500 && !['OPERATION_UNCERTAIN', 'OPERATION_REVIEWED'].includes(err.code) && !['pending', 'uncertain'].includes(err.operation?.status)) keys.current.delete(signature); throw failure; }
    keys.current.delete(signature); if (!active.current) throw new DOMException('This view closed.', 'AbortError'); return result;
  }
  async function mapAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    await action(async () => { const result = await requester.current(path + '/connection', 'POST', { customerId: values.get('customerId'), accountId: values.get('accountId'), confirmed: true }); if (!active.current) return; setStatus(previous => ({ ...previous, mapping: result.mapping })); await load(); if (active.current) setNotice('Account connected to this project.'); });
  }
  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, values = new FormData(form);
    const body = { name: values.get('name'), dailyBudget: Number(values.get('dailyBudget')), maxCpc: Number(values.get('maxCpc')), finalUrl: values.get('finalUrl'), headlines: lines(values.get('headlines')), descriptions: lines(values.get('descriptions')), keywords: lines(values.get('keywords')), matchType: values.get('matchType'), locationIds: String(values.get('locationIds') || '').split(/[\s,]+/).filter(Boolean), confirmed: true };
    await action(async () => {
      const result = await write(path + '/campaigns', body); if (!active.current) return;
      setCampaigns(previous => [result.providerCampaign, ...previous.filter(row => row.id !== result.providerCampaign.id)]); form.reset(); setNotice('Paused search campaign, location targets, responsive ad and keywords were created and read back. Review targeting and editorial approval before activation.');
      try { await onChanged?.(); } catch { if (active.current) setNotice('Microsoft confirmed the paused campaign. Refresh the shared campaign plan to see its local receipt.'); }
    });
  }
  async function change(event: React.FormEvent<HTMLFormElement>, campaign: Row) {
    event.preventDefault(); const values = new FormData(event.currentTarget), body: Row = { status: values.get('status'), confirmed: true };
    if (values.has('dailyBudget') && Number(values.get('dailyBudget')) !== campaign.dailyBudget) body.dailyBudget = Number(values.get('dailyBudget'));
    if (!window.confirm(`Apply this Microsoft campaign change? Active campaigns can incur charges. Confirm the targeting and creative approvals have been reviewed.`)) return;
    await action(async () => { const result = await write(path + '/campaigns/' + encodeURIComponent(campaign.id), body); if (!active.current) return; setCampaigns(previous => previous.map(row => row.id === result.campaign.id ? result.campaign : row)); setNotice('Microsoft confirmed the campaign change.'); try { await onChanged?.(); } catch { if (active.current) setNotice('Microsoft confirmed the change. Refresh the shared campaign plan to see its local receipt.'); } });
  }
  async function requestReport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    await action(async () => { const result = await requester.current(path + '/reports', 'POST', { fromDate: values.get('fromDate'), toDate: values.get('toDate') }); if (active.current) { setReport(result.report); setNotice('Microsoft is preparing the performance export. Check its status below.'); } });
  }
  async function refreshReport() { if (!report) return; await action(async () => { const result = await requester.current(path + '/reports/' + encodeURIComponent(report.id)); if (active.current) setReport(result.report); }); }
  return <section className="panel ad-tools-panel">
    <div className="panel-heading"><div><h2>{mode === 'connection' ? 'Microsoft Advertising connection' : 'Microsoft Advertising'}</h2><p>{mode === 'connection' ? 'Choose the advertising account used by this project.' : 'Search campaigns, budgets and performance exports.'}</p></div><button type="button" className="button" disabled={busy} onClick={() => action(load)}>Refresh Microsoft account</button></div>
    {mode === 'workflow' && <p className="helper-note">Campaigns start paused, in English, with a CPC cap. Copilot placement depends on Microsoft eligibility. Advanced targeting is available in <a href="https://ads.microsoft.com/" target="_blank" rel="noreferrer">Microsoft Advertising</a>.</p>}
    {error && <p className="alert" role="alert">{error}</p>}{notice && <p className="helper-note" role="status">{notice}</p>}{busy && <p role="status">Checking Microsoft Advertising…</p>}
    {status && <p className="helper-note">{status.configured ? 'Credentials configured.' : 'Microsoft Advertising credentials are not configured.'} {status.mapping ? `${status.mapping.name} · ${status.mapping.accountId} · ${status.mapping.currency}` : 'No advertising account is mapped to this project.'}</p>}
    {mode === 'workflow' && onOpenIntegrations && <button className="button" type="button" disabled={busy} onClick={onOpenIntegrations}>Open integrations</button>}
    {mode === 'connection' && canMap && status && !status.mapping && <details><summary>Approve Microsoft account mapping</summary><form onSubmit={mapAccount}><fieldset disabled={busy || !status.configured}>
      <label className="field"><span>Owning customer ID *</span><input name="customerId" inputMode="numeric" pattern="[1-9][0-9]{0,18}" required/></label><label className="field"><span>Advertising account ID *</span><input name="accountId" inputMode="numeric" pattern="[1-9][0-9]{0,18}" required/></label>
      <p className="helper-note">Use numeric IDs from Microsoft Advertising, not its alphanumeric account number. Microsoft must confirm the account’s owning customer. Each account belongs to one project and its mapping is fixed.</p><label className="checkbox-label"><input type="checkbox" required/>I approve assigning this Microsoft account to this project.</label><button className="button">Verify and approve account</button>
    </fieldset></form></details>}
    {mode === 'workflow' && status?.mapping && status.configured && <>
      {canWrite && <details><summary>Create paused Microsoft search campaign</summary><form onSubmit={create}><fieldset disabled={busy}>
        <div className="form-grid"><label className="field"><span>Campaign name *</span><input name="name" required maxLength={128}/></label><label className="field"><span>Daily budget ({status.mapping.currency}) *</span><input name="dailyBudget" type="number" required min="0.01" max="1000000" step="0.01"/></label><label className="field"><span>Maximum CPC ({status.mapping.currency}) *</span><input name="maxCpc" type="number" required min="0.01" max="1000000" step="0.01"/></label><label className="field"><span>Landing page URL *</span><input name="finalUrl" type="url" pattern="https://.+" required maxLength={2048}/></label></div>
        <label className="field"><span>Microsoft location target IDs *</span><input name="locationIds" required placeholder="Numeric IDs, separated by commas" pattern="[0-9,\s]+"/></label><p className="helper-note">Use Microsoft’s <a href="https://learn.microsoft.com/en-us/advertising/guides/geographical-location-codes" target="_blank" rel="noreferrer">location target IDs</a>. Standard Microsoft location-interest matching applies; review presence and other targeting in Microsoft before activation.</p>
        <label className="field"><span>Headlines · 3–15 distinct lines, 30 characters each *</span><textarea name="headlines" rows={5} required maxLength={500}/></label><label className="field"><span>Descriptions · 2–4 distinct lines, 90 characters each *</span><textarea name="descriptions" rows={4} required maxLength={400}/></label><p className="helper-note">Use literal Latin-script creative here. Dynamic substitutions and double-width creative require the native Microsoft editor.</p>
        <label className="field"><span>Keywords · one per line, up to 100 *</span><textarea name="keywords" rows={4} required maxLength={8100}/></label><label className="field"><span>Keyword matching</span><select name="matchType" defaultValue="Exact"><option value="Exact">Exact</option><option value="Phrase">Phrase</option><option value="Broad">Broad</option></select></label>
        <label className="checkbox-label"><input type="checkbox" required/>I reviewed the copy, location IDs, bid cap and daily budget. Create the campaign paused.</label><button className="button primary">Create paused Microsoft campaign</button>
      </fieldset></form></details>}
      <h3>Search campaigns</h3>{!campaigns.length && <p className="helper-note">No search campaigns were returned for this account.</p>}{campaigns.map(campaign => <article className="details" key={campaign.id}><h3>{campaign.name}</h3><p>Microsoft campaign {campaign.id} · {campaign.status} · {campaign.sharedBudget ? 'Shared budget' : ['DailyBudgetStandard', 'DailyBudgetAccelerated'].includes(campaign.budgetType) ? 'Daily budget' : 'Budget'} {campaign.dailyBudget ?? 'Not reported'} {status.mapping.currency}</p>
        {canWrite && ['Active', 'Paused'].includes(campaign.status) ? <form key={`${campaign.id}:${campaign.status}:${campaign.dailyBudget}`} onSubmit={event => change(event, campaign)}><fieldset disabled={busy}><div className="form-grid"><label className="field"><span>Status</span><select name="status" defaultValue={campaign.status}><option value="Paused">Paused</option><option value="Active">Active · may incur charges</option></select></label>{campaign.sharedBudget === false && ['DailyBudgetStandard', 'DailyBudgetAccelerated'].includes(campaign.budgetType) && <label className="field"><span>Daily budget ({status.mapping.currency})</span><input name="dailyBudget" type="number" required min="0.01" max="1000000" step="0.01" defaultValue={campaign.dailyBudget}/></label>}</div><button className="button">Review Microsoft campaign change</button></fieldset></form> : <p className="helper-note">Manage this campaign in Microsoft Advertising.</p>}
      </article>)}
      <h3>Performance export</h3><p className="helper-note">Export impressions, clicks, spend and conversions as a CSV in a ZIP file. Report dates use GMT; recent data may be incomplete.{!canWrite && ' Viewers can open the latest saved report; an editor must request a new export.'}</p>
      <form onSubmit={requestReport}><fieldset disabled={busy || !canWrite}><div className="form-grid"><label className="field"><span>From date *</span><input name="fromDate" type="date" required max={today()}/></label><label className="field"><span>To date *</span><input name="toDate" type="date" required max={today()} defaultValue={today()}/></label></div><button className="button">Request performance export</button></fieldset></form>
      {report && <div className="details"><p>Report {report.fromDate} to {report.toDate} · {report.status}</p>{report.status === 'Error' && <p role="alert">Microsoft could not prepare this report. Request another report or check the native dashboard.</p>}{report.empty && <p>No report rows were returned.</p>}{report.downloadUrl ? <a className="button" href={report.downloadUrl} target="_blank" rel="noreferrer">Download Microsoft report ZIP</a> : report.status === 'Pending' && <button className="button" type="button" disabled={busy} onClick={refreshReport}>Check report status</button>}<p className="helper-note">Microsoft report requests expire after one day. Request a fresh export if its download has expired.</p></div>}
    </>}
  </section>;
}
