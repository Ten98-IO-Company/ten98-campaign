import React, { useEffect, useRef, useState } from 'react';

type Invite = { email: string; role: string; workspaceName: string; expiresAt: string };
type Props = { token: string; request: (path: string, method?: string, body?: unknown) => Promise<any>; onAccepted: (result: any) => void | Promise<void>; onSignIn: (email?: string) => void };
export default function AcceptInvitation({ token, request, onAccepted, onSignIn }: Props) {
  const [details, setDetails] = useState<{ invitation: Invite; accountExists: boolean; requiresSignIn: boolean } | null>(null), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const version = useRef(0), path = '/invitations/' + encodeURIComponent(token);
  useEffect(() => {
    const generation = ++version.current; setDetails(null); setLoading(true); setError('');
    request(path).then(result => { if (generation === version.current) setDetails(result); }).catch(err => { if (generation === version.current) setError((err as Error).message || 'This invitation could not be opened.'); }).finally(() => { if (generation === version.current) setLoading(false); });
    return () => { version.current++; };
  }, [token]);
  async function accept(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !details) return;
    const generation = version.current, body = details.accountExists ? {} : Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true); setError('');
    try { const result = await request(path, 'POST', body); if (generation === version.current) await onAccepted(result); }
    catch (err) { if (generation === version.current) { if ((err as Error & { status?: number }).status === 401) setDetails(previous => previous ? { ...previous, accountExists: true, requiresSignIn: true } : previous); setError((err as Error).message || 'The invitation could not be accepted.'); } }
    finally { if (generation === version.current) setBusy(false); }
  }
  return <main className="auth-shell"><section className="auth-form"><div className="auth-form-inner"><a className="brand" href="/"><span className="brand-mark">98</span><span><strong>ten98.</strong><small>CAMPAIGN</small></span></a>
    {loading ? <><h1>Opening invitation…</h1><p>Checking your workspace access.</p></> : details ? <><h1>Join {details.invitation.workspaceName}</h1><p>You’re invited as {details.invitation.role} using <strong>{details.invitation.email}</strong>.</p><p className="helper-note">This gives you access to every project in this workspace. The link expires {new Date(details.invitation.expiresAt).toLocaleDateString()}.</p>
      {details.requiresSignIn ? <><p>Sign in with the invited email to keep your existing account and password.</p><button type="button" className="button primary full" onClick={() => onSignIn(details.invitation.email)}>Sign in to accept invitation</button></> : <form onSubmit={accept}>
        {!details.accountExists && <><label className="field"><span>Your name *</span><input name="name" autoComplete="name" required maxLength={120}/></label><label className="field"><span>Create your password *</span><input name="password" type="password" autoComplete="new-password" required minLength={12} maxLength={128}/></label><p className="field-help">Use at least 12 characters.</p></>}
        <button className="button primary full" disabled={busy}>{busy ? 'Joining your team…' : details.accountExists ? 'Accept invitation' : 'Create account and join'}</button>
      </form>}
    </> : <><h1>Invitation unavailable</h1><p>Ask a workspace owner or administrator for a new invitation link.</p><a href="/" className="button">Go to sign in</a></>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div></section></main>;
}
