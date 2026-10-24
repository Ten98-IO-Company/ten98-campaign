import { useEffect, useRef, useState } from 'react';
import { InvitationAcceptFlow, type InvitationState } from '@ten98/ui';
import { AppBrand as Brand } from '@ten98/ui/app';
import { authStory } from './auth-story';
import { roleLabel } from './workspace-roles';

type Invite = { email: string; role: string; workspaceName: string; expiresAt: string };
type Props = { token: string; signedInEmail?: string; request: (path: string, method?: string, body?: unknown) => Promise<any>; onAccepted: (result: any) => void | Promise<void>; onSignIn: (email?: string) => void; onCancel: () => void };
// Campaign adapter: the token stays in memory and travels only in POST bodies, and the server decides whether the invited account must sign in first.
// The screen sits beside the shared story panel like every signed-out screen; roles show with Campaign's labels.
export default function AcceptInvitation({ token, signedInEmail, request, onAccepted, onSignIn, onCancel }: Props) {
  const [details, setDetails] = useState<{ invitation: Invite; accountExists: boolean; requiresSignIn: boolean } | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const version = useRef(0);
  useEffect(() => {
    const generation = ++version.current; setDetails(null); setLoading(true); setError('');
    request('/invitations/inspect', 'POST', { token }).then(result => { if (generation === version.current) setDetails(result); }).catch(err => { if (generation === version.current) setError((err as Error).message || 'This invitation could not be opened.'); }).finally(() => { if (generation === version.current) setLoading(false); });
    return () => { version.current++; };
  }, [token]);
  async function accept(values: { name?: string; password?: string }) {
    if (busy || !details || mismatch) return;
    const generation = version.current, body = details.accountExists ? {} : { name: values.name, password: values.password };
    setBusy(true); setError('');
    try { const result = await request('/invitations/accept', 'POST', { token, ...body }); if (generation === version.current) await onAccepted(result); }
    catch (err) { if (generation === version.current) { if ((err as Error & { status?: number }).status === 401) setDetails(previous => previous ? { ...previous, accountExists: true, requiresSignIn: true } : previous); setError((err as Error).message || 'The invitation could not be accepted.'); } }
    finally { if (generation === version.current) setBusy(false); }
  }
  // Signed in as someone other than the invited email: the screen says so and offers Switch account, as Discover does.
  const mismatch = !!details && !!signedInEmail && signedInEmail.toLowerCase() !== details.invitation.email.toLowerCase();
  const state: InvitationState = loading ? 'loading' : !details ? 'unavailable' : mismatch ? 'mismatch' : details.requiresSignIn ? 'signin-required' : 'details';
  const title = loading ? 'Opening invitation…' : details ? 'Join ' + details.invitation.workspaceName : 'Invitation unavailable';
  const description = loading ? 'Checking your workspace access.' : details ? 'This gives you access to every project in this workspace.' : 'Ask a workspace owner or administrator for a new invitation link.';
  return <InvitationAcceptFlow brand={<Brand product="Campaign" href="/"/>} aside={authStory} label="Workspace invitation" title={title} description={description} state={state} invitation={details?.invitation} roleLabel={roleLabel}
    signedInEmail={signedInEmail} accountExists={details?.accountExists}
    passwordPolicy={{ minLength: 12, maxLength: 128 }} busy={busy} busyLabel="Joining your team…" error={error || undefined}
    messages={{ signInRequired: 'Sign in with the invited email to keep your existing account and password.' }} onSignIn={() => onSignIn(details?.invitation.email)} onSwitchAccount={() => onSignIn(details?.invitation.email)} cancel={!loading && !details ? { label: 'Go to sign in', href: '/' } : { label: 'Cancel', onClick: onCancel }} onSubmit={accept}/>;
}
