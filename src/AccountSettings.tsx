import { useEffect, useState } from 'react';
import { AccountProfileFlow, Alert, Button, Card, PasswordChangeFlow, Stack, StatusLine, Text, type AccountProfileValues, type AccountTheme, type AuthNotice } from '@ten98/ui';

type Props = { request: (path: string, method?: string, body?: unknown) => Promise<any>; onChanged: () => void };
type Section = 'profile' | 'password' | 'sessions';

export default function AccountSettings({ request, onChanged }: Props) {
  const [account, setAccount] = useState<any>(null), [busy, setBusy] = useState<Section | ''>(''), [error, setError] = useState(''), [feedback, setFeedback] = useState<{ section: Section; error?: string; notice?: AuthNotice }>();
  const [passwordForm, setPasswordForm] = useState(0);
  const [appearance, setAppearance] = useState<AccountTheme>(() => ['light', 'dark'].includes(document.documentElement.dataset.theme || '') ? document.documentElement.dataset.theme as AccountTheme : 'system');
  // The theme is a per-browser preference; only the display name is stored on the account.
  function changeAppearance(value: string) {
    if (!['system', 'light', 'dark'].includes(value)) return '';
    document.documentElement.dataset.theme = value; setAppearance(value as AccountTheme);
    try { localStorage.setItem('ten98-campaign-theme', value); return 'Appearance saved for this browser.'; }
    catch { return 'Appearance changed for this tab. Your browser could not save this preference.'; }
  }
  useEffect(() => { let active = true; request('/account').then(value => { if (active) setAccount(value); }).catch(err => { if (active) setError(err.message); }); return () => { active = false; }; }, [request]);
  async function action(section: Section, work: () => Promise<string | void>, message: string) {
    setBusy(section); setFeedback(undefined);
    try { const text = await work(); setAccount(await request('/account')); setFeedback({ section, notice: { tone: 'success', text: text || message } }); }
    catch (err) { setFeedback({ section, error: (err as Error).message }); }
    finally { setBusy(''); }
  }
  async function saveProfile({ name, theme }: AccountProfileValues) {
    const notes = [];
    if (name !== account.user.name) { await request('/account', 'PATCH', { name }); onChanged(); notes.push('Display name saved.'); }
    if (theme !== appearance) notes.push(changeAppearance(theme));
    return notes.join(' ');
  }
  const state = (section: Section) => ({ busy: busy === section, error: feedback?.section === section ? feedback.error : undefined, notice: feedback?.section === section ? feedback.notice : undefined });
  const sessions = state('sessions');
  return <Card as="section" title="Your account"><Stack gap={6}>
    {error && <Alert tone="danger" title={error}/>}
    {account && <AccountProfileFlow {...state('profile')} email={account.user.email} defaultValues={{ name: account.user.name, theme: appearance }} description="System follows your device’s light or dark preference. Appearance applies to this browser." onSubmit={values => action('profile', () => saveProfile(values), 'Profile saved.')}/>}
    {account && <PasswordChangeFlow key={passwordForm} {...state('password')} hasPassword={account.localPassword} policy={{ minLength: 12, maxLength: 128 }} messages={{ noPassword: 'Your identity provider manages your password.' }} onSubmit={values => action('password', async () => { await request('/account/password', 'POST', values); setPasswordForm(value => value + 1); }, 'Password changed. Other sessions have been signed out.')}/>}
    {account && <Stack gap={2}>
      <Text tone="muted">{account.activeSessions} active {account.activeSessions === 1 ? 'session' : 'sessions'}</Text>
      <Button variant="secondary" disabled={!!busy || account.activeSessions < 2} loading={sessions.busy} onClick={() => action('sessions', async () => { await request('/account/sessions/revoke', 'POST', {}); }, 'Other sessions signed out.')}>Sign out other sessions</Button>
      {sessions.error && <Alert tone="danger" title={sessions.error}/>}
      {sessions.notice && <StatusLine tone="success">{sessions.notice.text}</StatusLine>}
    </Stack>}
  </Stack></Card>;
}
