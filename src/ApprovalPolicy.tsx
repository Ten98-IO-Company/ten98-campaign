import { useEffect, useState } from 'react';
import { Alert, Card, Stack, StatusLine, Switch, Text, useConfirmDialog } from '@ten98/ui';

type Props = { projectId: string; role: string; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>; onChanged?: () => void | Promise<void> };

function AdSpendPolicySwitch({ label, checked, disabled, onCheckedChange }: { label: string; checked: boolean; disabled: boolean; onCheckedChange: (checked: boolean) => void }) {
  const [confirm, dialog] = useConfirmDialog();
  return <>{dialog}<Switch label={label} checked={checked} disabled={disabled} onCheckedChange={async next => { if (await confirm({ title: next ? 'Require ad spend approval?' : 'Stop requiring ad spend approval?', description: 'Changing this setting voids every unused ad spend approval and pending ad spend request in this project. They stay listed as rejected.', confirmLabel: next ? 'Require approval' : 'Stop requiring approval' })) onCheckedChange(next); }}/></>;
}
// Settings › Approvals: the project's approval policy, apart from the review queue.
export default function ApprovalPolicy({ projectId, role, request, onChanged }: Props) {
  const [policy, setPolicy] = useState<any>(null), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const path = `/projects/${encodeURIComponent(projectId)}/approvals`, canReview = ['owner', 'admin'].includes(role);
  useEffect(() => { let active = true; request(path + '/policy').then(value => { if (active) setPolicy(value); }).catch(err => { if (active) setError((err as Error).message); }); return () => { active = false; }; }, [path, request]);
  async function action(name: string, run: () => Promise<void>) {
    if (busy) return; setBusy(name); setError(''); setNotice('');
    try { await run(); } catch (err) { setError((err as Error).message || 'This setting could not be saved.'); } finally { setBusy(''); }
  }
  return <Card as="section" title="Approvals" headingLevel={2}><Stack gap={3}><Text>Owners and administrators review the exact text, recipients, schedule, and creative. Changes to a post or its referenced asset require a new review.</Text>
    {!policy && !error && <StatusLine busy>Loading approval settings…</StatusLine>}
    {policy && <Text tone="muted" size="sm">Publishing approval is <Text as="strong">{policy.requireApproval ? 'required' : 'optional'}</Text> for this project. Approving a post never publishes it.</Text>}
    {canReview && policy && <Switch label="Require approval before publishing" disabled={Boolean(busy)} checked={policy.requireApproval} onCheckedChange={requireApproval => { action('policy', async () => { const result = await request(path + '/policy', 'POST', { requireApproval }); setPolicy((previous: any) => ({ ...previous, ...result })); setNotice(requireApproval ? 'Every post now needs current approval before publishing or retrying.' : 'Publishing approval is now optional.'); await onChanged?.(); }); }}/>}
    {policy && <Text tone="muted" size="sm">Ad spend approval is <Text as="strong">{policy.requireAdApproval ? 'required' : 'optional'}</Text> for this project. Approving a spend change never sends it to the ad network.</Text>}
    {canReview && policy && <AdSpendPolicySwitch label="Require approval before activating ads or raising budgets" disabled={Boolean(busy)} checked={Boolean(policy.requireAdApproval)} onCheckedChange={requireAdApproval => { action('ad-policy', async () => { const result = await request(path + '/policy', 'POST', { requireAdApproval }); setPolicy((previous: any) => ({ ...previous, ...result })); setNotice(requireAdApproval ? 'Activating ads and raising budgets now need an approved review first.' : 'Ad spend approval is now optional.'); await onChanged?.(); }); }}/>}
    {!canReview && <Text tone="muted" size="sm">Only owners and administrators can change these settings.</Text>}
    {error && <Alert tone="danger">{error}</Alert>}{notice && <StatusLine tone="success">{notice}</StatusLine>}
  </Stack></Card>;
}
