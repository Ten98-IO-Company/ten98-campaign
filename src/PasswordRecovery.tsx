import { useEffect, useRef, useState } from 'react';
import { PasswordRecoveryFlow } from '@ten98/ui';

// Self-service password recovery (#284), ported from Discover's PasswordRecoveryPanel (src/components/PasswordRecoveryPanel.tsx)
// so both apps word and behave the same. The reset token comes from the #password-reset= fragment and stays in memory.
export type PasswordRecoveryState = { kind: 'request' } | { kind: 'reset'; token: string | null };
type Props = { value: PasswordRecoveryState; initialEmail: string; request: (path: string, method?: string, body?: unknown) => Promise<any>; onRequest: () => void; onSignIn: (changed?: boolean) => void };
const incompleteLink = 'This reset link is invalid or incomplete. Reopen the original email or request a new link. Reloading this page clears the link from memory.';

export default function PasswordRecovery({ value, initialEmail, request, onRequest, onSignIn }: Props) {
  const [availability, setAvailability] = useState<'loading' | 'enabled' | 'disabled' | 'error'>('loading');
  const [busy, setBusy] = useState(false), [sent, setSent] = useState(false), [error, setError] = useState(''), [unconfirmed, setUnconfirmed] = useState('');
  // Non-null while a reset link is unusable; holds the explanation shown in place of the form.
  const [invalidText, setInvalidText] = useState<string | null>(value.kind === 'reset' && !value.token ? incompleteLink : null);
  const alive = useRef(false), locked = useRef(false);
  useEffect(() => {
    alive.current = true;
    if (value.kind === 'request') request('/auth/password-reset-status').then(result => {
      if (!alive.current) return;
      if (!result || typeof result !== 'object' || typeof result.configured !== 'boolean') throw new Error('Invalid recovery status');
      setAvailability(result.configured ? 'enabled' : 'disabled');
    }).catch(() => { if (alive.current) setAvailability('error'); });
    return () => { alive.current = false; };
  }, []);
  async function submit(values: { email?: string; password?: string; confirmation?: string }) {
    const email = values.email ?? '', password = values.password ?? '', confirmation = values.confirmation ?? '';
    if (locked.current || value.kind === 'reset' && (invalidText !== null || !value.token) || value.kind === 'request' && availability !== 'enabled') return;
    if (value.kind === 'reset' && (password.length < 12 || password.length > 128 || password !== confirmation)) { setError('Use 12–128 characters and enter the same password twice.'); return; }
    locked.current = true; setBusy(true); setError(''); setUnconfirmed('');
    try {
      const result = await request(value.kind === 'request' ? '/auth/request-password-reset' : '/auth/reset-password', 'POST', value.kind === 'request' ? { email: email.trim() } : { token: value.token, newPassword: password });
      if (!alive.current) return;
      if (result?.ok !== true) throw new Error('Unverified acknowledgement');
      if (value.kind === 'request') setSent(true); else onSignIn(true);
    } catch (cause) {
      if (!alive.current) return;
      const status = (cause as { status?: number }).status;
      if (value.kind === 'reset' && status === 400) setInvalidText('This link is invalid, expired or already used. Request a new link, or reopen the original email if the address was changed.');
      else if (status === 429) setError('Too many attempts. Wait a minute, then try again.');
      else if (value.kind === 'request' && status === 503) setAvailability('disabled');
      else if (value.kind === 'request') setUnconfirmed('The request could not be confirmed. Try again later, or ask your administrator.');
      else setUnconfirmed('The password change could not be confirmed. Try signing in with the new password, or request a new reset link. Do not assume the old password still works.');
    } finally {
      if (alive.current) { locked.current = false; setBusy(false); }
    }
  }
  const common = {
    label: 'Account access', title: value.kind === 'request' ? 'Reset your password' : 'Choose a new password',
    busy, error, unconfirmed,
    backToSignIn: { onClick: () => onSignIn() },
    messages: {
      loading: 'Checking email recovery…',
      disabled: 'Email recovery is not set up for this installation. Ask your administrator to reset your password.',
      error: 'Email recovery availability could not be checked. Return to sign-in and try again.',
      sent: 'If an account with a password matches this email, a reset link is on its way. Check your inbox and spam folder. The link expires after one hour.',
      invalid: invalidText ?? incompleteLink,
      resetIntro: 'The link works once. After the reset, every signed-in session of this account is signed out. The link is kept only in this open page; if you reload or close it, reopen the email.',
      mismatch: 'Use 12–128 characters and enter the same password twice.',
    },
  };
  return value.kind === 'request'
    ? <PasswordRecoveryFlow {...common} stage="request" availability={availability} sent={sent} defaultValues={{ email: initialEmail }} submitLabel="Send reset link" onSubmit={submit}/>
    : <PasswordRecoveryFlow {...common} stage="reset" token={value.token ?? undefined} invalid={invalidText !== null} onRequestNewLink={onRequest} submitLabel="Change password" onSubmit={submit}/>;
}
