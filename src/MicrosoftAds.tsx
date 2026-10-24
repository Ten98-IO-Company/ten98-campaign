import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Checkbox, ConfirmDialog, Disclosure, Field, FormActions, FormGrid, Heading, Inline, Input, Link, Option, Select, Stack, StatusLine, Text, Textarea } from '@ten98/ui';
import { adSpendBlock, type AdSpendBlock } from './approval-status';
import AdSpendNotice from './AdSpendNotice';

type Row = Record<string, any>;
type Props = { projectId: string; role: string; isOperator: boolean; request: (path: string, method?: string, body?: any, key?: string) => Promise<any>; onChanged?: () => void | Promise<void>; mode?: 'workflow' | 'connection'; onOpenIntegrations?: () => void; onOpenApprovals?: () => void };
const lines = (value: FormDataEntryValue | null) => String(value || '').split('\n').map(row => row.trim()).filter(Boolean);
const today = () => new Date().toISOString().slice(0, 10);

export default function MicrosoftAds({ projectId, role, isOperator, request, onChanged, mode = 'workflow', onOpenIntegrations, onOpenApprovals }: Props) {
  const path = `/projects/${encodeURIComponent(projectId)}/microsoft-ads`, active = useRef(true), readVersion = useRef(0), pending = useRef(false), keys = useRef(new Map<string, string>()), requester = useRef(request); requester.current = request;
  const [status, setStatus] = useState<Row | null>(null), [campaigns, setCampaigns] = useState<Row[]>([]), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [report, setReport] = useState<Row | null>(null), [confirming, setConfirming] = useState<{ campaign: Row; body: Row }>(), [spendBlock, setSpendBlock] = useState<AdSpendBlock | null>(null);
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
    if (pending.current || !active.current) return; readVersion.current++; pending.current = true; setBusy(true); setError(''); setNotice(''); setSpendBlock(null);
    try { await run(); } catch (failure) { const block = adSpendBlock(failure); if (active.current && block) setSpendBlock(block); else if (active.current) setError((failure as Error).message || 'Microsoft Advertising could not complete this action.'); }
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
      try { await onChanged?.(); } catch { if (active.current) setNotice('Microsoft confirmed the paused campaign. Refresh the campaign plan to see it here.'); }
    });
  }
  function reviewChange(event: React.FormEvent<HTMLFormElement>, campaign: Row) {
    event.preventDefault(); const values = new FormData(event.currentTarget), body: Row = { status: values.get('status'), confirmed: true };
    if (values.has('dailyBudget') && Number(values.get('dailyBudget')) !== campaign.dailyBudget) body.dailyBudget = Number(values.get('dailyBudget'));
    setConfirming({ campaign, body });
  }
  async function change(campaign: Row, body: Row) {
    await action(async () => { const result = await write(path + '/campaigns/' + encodeURIComponent(campaign.id), body); if (!active.current) return; setCampaigns(previous => previous.map(row => row.id === result.campaign.id ? result.campaign : row)); setNotice('Microsoft confirmed the campaign change.'); try { await onChanged?.(); } catch { if (active.current) setNotice('Microsoft confirmed the change. Refresh the campaign plan to see it here.'); } });
  }
  async function requestReport(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    await action(async () => { const result = await requester.current(path + '/reports', 'POST', { fromDate: values.get('fromDate'), toDate: values.get('toDate') }); if (active.current) { setReport(result.report); setNotice('Microsoft is preparing the performance export. Check its status below.'); } });
  }
  async function refreshReport() { if (!report) return; await action(async () => { const result = await requester.current(path + '/reports/' + encodeURIComponent(report.id)); if (active.current) setReport(result.report); }); }
  return <Frame connection={mode === 'connection'} title="Microsoft Advertising" description={mode === 'connection' ? 'Choose the advertising account used by this project.' : 'Search campaigns, budgets and performance exports.'} actions={<Button type="button" variant="secondary" disabled={busy} onClick={() => action(load)}>Refresh Microsoft account</Button>}>
    {mode === 'workflow' && <Text tone="muted">Campaigns start paused, in English, with a CPC cap. Copilot placement depends on Microsoft eligibility. Advanced targeting is available in <Link href="https://ads.microsoft.com/" target="_blank" rel="noreferrer">Microsoft Advertising</Link>.</Text>}
    {error && <Alert tone="danger">{error}</Alert>}{spendBlock && <AdSpendNotice block={spendBlock} onOpenApprovals={onOpenApprovals}/>}{notice && <StatusLine>{notice}</StatusLine>}{busy && <StatusLine busy>Checking Microsoft Advertising…</StatusLine>}
    {status && <Text tone="muted">{status.configured ? 'Credentials configured.' : 'Microsoft Advertising credentials are not configured.'} {status.mapping ? `${status.mapping.name} · ${status.mapping.accountId} · ${status.mapping.currency}` : 'No advertising account is mapped to this project.'}</Text>}
    {mode === 'workflow' && onOpenIntegrations && <Inline><Button variant="secondary" type="button" disabled={busy} onClick={onOpenIntegrations}>Open Connections</Button></Inline>}
    {mode === 'connection' && canMap && status && !status.mapping && <Disclosure summary="Approve Microsoft account mapping"><Stack as="form" onSubmit={mapAccount}><Stack as="fieldset" gap={3} disabled={busy || !status.configured}>
      <Field label="Owning customer ID *"><Input name="customerId" inputMode="numeric" pattern="[1-9][0-9]{0,18}" required/></Field><Field label="Advertising account ID *"><Input name="accountId" inputMode="numeric" pattern="[1-9][0-9]{0,18}" required/></Field>
      <Text tone="muted">Use numeric IDs from Microsoft Advertising, not its alphanumeric account number. Microsoft must confirm the account’s owning customer. Each account belongs to one project and its mapping is fixed.</Text><Checkbox required label="I approve assigning this Microsoft account to this project."/><FormActions><Button variant="secondary" type="submit">Verify and approve account</Button></FormActions>
    </Stack></Stack></Disclosure>}
    {mode === 'workflow' && status?.mapping && status.configured && <>
      {canWrite && <Disclosure summary="Create paused Microsoft search campaign"><Stack as="form" onSubmit={create}><Stack as="fieldset" gap={3} disabled={busy}>
        <FormGrid><Field label="Campaign name *"><Input name="name" required maxLength={128}/></Field><Field label={`Daily budget (${status.mapping.currency}) *`}><Input name="dailyBudget" type="number" required min="0.01" max="1000000" step="0.01"/></Field><Field label={`Maximum CPC (${status.mapping.currency}) *`}><Input name="maxCpc" type="number" required min="0.01" max="1000000" step="0.01"/></Field><Field label="Landing page URL *"><Input name="finalUrl" type="url" pattern="https://.+" required maxLength={2048}/></Field></FormGrid>
        <Field label="Microsoft location target IDs *"><Input name="locationIds" required placeholder="Numeric IDs, separated by commas" pattern="[0-9,\s]+"/></Field><Text tone="muted">Use Microsoft’s <Link href="https://learn.microsoft.com/en-us/advertising/guides/geographical-location-codes" target="_blank" rel="noreferrer">location target IDs</Link>. Standard Microsoft location-interest matching applies; review presence and other targeting in Microsoft before activation.</Text>
        <Field label="Headlines · 3–15 distinct lines, 30 characters each *"><Textarea name="headlines" rows={5} required maxLength={500}/></Field><Field label="Descriptions · 2–4 distinct lines, 90 characters each *"><Textarea name="descriptions" rows={4} required maxLength={400}/></Field><Text tone="muted">Use literal Latin-script creative here. Dynamic substitutions and double-width creative require the native Microsoft editor.</Text>
        <Field label="Keywords · one per line, up to 100 *"><Textarea name="keywords" rows={4} required maxLength={8100}/></Field><Field label="Keyword matching"><Select name="matchType" defaultValue="Exact"><Option value="Exact">Exact</Option><Option value="Phrase">Phrase</Option><Option value="Broad">Broad</Option></Select></Field>
        <Checkbox required label="I reviewed the copy, location IDs, bid cap and daily budget. Create the campaign paused."/><FormActions><Button variant="primary" type="submit">Create paused Microsoft campaign</Button></FormActions>
      </Stack></Stack></Disclosure>}
      <Stack as="section" gap={3}><Heading level={3} size="sm">Search campaigns</Heading>{!campaigns.length && <Text tone="muted">No search campaigns were returned for this account.</Text>}{campaigns.map(campaign => <Card as="article" headingLevel={4} key={campaign.id} title={campaign.name}><Stack gap={3}><Text>Microsoft campaign {campaign.id} · {campaign.status} · {campaign.sharedBudget ? 'Shared budget' : ['DailyBudgetStandard', 'DailyBudgetAccelerated'].includes(campaign.budgetType) ? 'Daily budget' : 'Budget'} {campaign.dailyBudget ?? 'Not reported'} {status.mapping.currency}</Text>
        {canWrite && ['Active', 'Paused'].includes(campaign.status) ? <Stack as="form" key={`${campaign.id}:${campaign.status}:${campaign.dailyBudget}`} onSubmit={event => reviewChange(event as React.FormEvent<HTMLFormElement>, campaign)}><Stack as="fieldset" gap={3} disabled={busy}><FormGrid><Field label="Status"><Select name="status" defaultValue={campaign.status}><Option value="Paused">Paused</Option><Option value="Active">Active · may incur charges</Option></Select></Field>{campaign.sharedBudget === false && ['DailyBudgetStandard', 'DailyBudgetAccelerated'].includes(campaign.budgetType) && <Field label={`Daily budget (${status.mapping.currency})`}><Input name="dailyBudget" type="number" required min="0.01" max="1000000" step="0.01" defaultValue={campaign.dailyBudget}/></Field>}</FormGrid><FormActions><Button variant="secondary" type="submit">Review Microsoft campaign change</Button></FormActions></Stack></Stack> : <Text tone="muted">Manage this campaign in Microsoft Advertising.</Text>}
      </Stack></Card>)}</Stack>
      <ConfirmDialog open={!!confirming} onOpenChange={open => { if (!open) setConfirming(undefined); }} title="Apply this Microsoft campaign change?" description="Active campaigns can incur charges. Confirm the targeting and creative approvals have been reviewed." confirmLabel="Apply change" onConfirm={() => change(confirming!.campaign, confirming!.body)}/>
      <Stack as="section" gap={3}><Heading level={3} size="sm">Performance export</Heading><Text tone="muted">Export impressions, clicks, spend and conversions as a CSV in a ZIP file. Report dates use GMT; recent data may be incomplete.{!canWrite && ' Viewers can open the latest saved report; an editor must request a new export.'}</Text>
      <Stack as="form" onSubmit={requestReport}><Stack as="fieldset" gap={3} disabled={busy || !canWrite}><FormGrid><Field label="From date *"><Input name="fromDate" type="date" required max={today()}/></Field><Field label="To date *"><Input name="toDate" type="date" required max={today()} defaultValue={today()}/></Field></FormGrid><FormActions><Button variant="secondary" type="submit">Request performance export</Button></FormActions></Stack></Stack>
      {report && <Card><Stack gap={3}><Text>Report {report.fromDate} to {report.toDate} · {report.status}</Text>{report.status === 'Error' && <Alert tone="danger">Microsoft could not prepare this report. Request another report or check the native dashboard.</Alert>}{report.empty && <Text>No report rows were returned.</Text>}{report.downloadUrl ? <Link variant="standalone" href={report.downloadUrl} target="_blank" rel="noreferrer">Download Microsoft report ZIP</Link> : report.status === 'Pending' && <Inline><Button variant="secondary" type="button" disabled={busy} onClick={refreshReport}>Check report status</Button></Inline>}<Text tone="muted">Microsoft report requests expire after one day. Request a fresh export if its download has expired.</Text></Stack></Card>}</Stack>
    </>}
  </Frame>;
}

// Connection mode sits inside the Integrations provider card, which already names the provider.
function Frame({ connection, title, description, actions, children }: { connection: boolean; title: string; description: string; actions: React.ReactNode; children: React.ReactNode }) {
  return connection ? <Stack gap={3}><Inline justify="between" align="center"><Text tone="muted">{description}</Text>{actions}</Inline>{children}</Stack> : <Card as="section" headingLevel={2} title={title} description={description} actions={actions}><Stack gap={4}>{children}</Stack></Card>;
}
