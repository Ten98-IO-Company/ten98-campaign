import { useEffect, useState } from 'react';
import { Alert, Button, Card, Field, Input, PasswordChangeFlow, RadioGroup, Stack, StatusLine, Text, type AuthNotice } from '@ten98/ui';

type Props = { request: (path: string, method?: string, body?: unknown) => Promise<any>; onChanged: () => void };
type Section = 'profile' | 'password';
const appearanceOptions = [{ value: 'system', label: 'System' }, { value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }];

// AccountProfileFlow is not used yet: it requires locale and time-zone fields that Campaign does not store.
export default function AccountSettings({ request, onChanged }: Props) {
  const [account, setAccount] = useState<any>(null), [busy, setBusy] = useState<Section | 'sessions' | ''>(''), [error, setError] = useState(''), [feedback, setFeedback] = useState<{ section: Section | 'sessions'; error?: string; notice?: AuthNotice }>();
  const [passwordForm, setPasswordForm] = useState(0);
  const [appearance, setAppearance] = useState(() => ['light', 'dark'].includes(document.documentElement.dataset.theme || '') ? document.documentElement.dataset.theme! : 'system'), [appearanceNotice, setAppearanceNotice] = useState('');
  function changeAppearance(value: string) {
    if (!['system', 'light', 'dark'].includes(value)) return;
    document.documentElement.dataset.theme = value; setAppearance(value);
    try { localStorage.setItem('ten98-campaign-theme', value); setAppearanceNotice('Appearance saved for this browser.'); }
    catch { setAppearanceNotice('Appearance changed for this tab. Your browser could not save this preference.'); }
  }
  useEffect(() => { let active = true; request('/account').then(value => { if (active) setAccount(value); }).catch(err => { if (active) setError(err.message); }); return () => { active = false; }; }, [request]);
  async function action(section: Section | 'sessions', work: () => Promise<void>, message: string) {
    setBusy(section); setFeedback(undefined);
    try { await work(); setAccount(await request('/account')); setFeedback({ section, notice: { tone: 'success', text: message } }); }
    catch (err) { setFeedback({ section, error: (err as Error).message }); }
    finally { setBusy(''); }
  }
  const state = (section: Section) => ({ busy: busy === section, error: feedback?.section === section ? feedback.error : undefined, notice: feedback?.section === section ? feedback.notice : undefined });
  const profile = state('profile'), sessions = feedback?.section === 'sessions' ? feedback : undefined;
  return <Card as="section" title="Your account"><Stack gap={6}>
    <Stack gap={3}>
      <RadioGroup name="appearance" legend="Appearance" description="System follows your device’s light or dark preference. Your choice applies to this browser." orientation="horizontal" options={appearanceOptions} value={appearance} onValueChange={changeAppearance}/>
      {appearanceNotice && <StatusLine tone="success">{appearanceNotice}</StatusLine>}
      {error && <Alert tone="danger" title={error}/>}
      {account && <Stack as="form" gap={3} onSubmit={event => { event.preventDefault(); const name = String(new FormData(event.currentTarget as HTMLFormElement).get('name')); action('profile', async () => { await request('/account', 'PATCH', { name }); onChanged(); }, 'Display name saved.'); }}>
        <Text tone="muted">{account.user.email} · {account.activeSessions} active sessions</Text>
        <Field label="Display name"><Input name="name" defaultValue={account.user.name} required maxLength={120} autoComplete="name" disabled={profile.busy}/></Field>
        {profile.error && <Alert tone="danger" title={profile.error}/>}
        {profile.notice && <StatusLine tone="success">{profile.notice.text}</StatusLine>}
        <Button type="submit" variant="secondary" loading={profile.busy}>Save name</Button>
      </Stack>}
    </Stack>
    {account && <PasswordChangeFlow key={passwordForm} {...state('password')} hasPassword={account.localPassword} policy={{ minLength: 12, maxLength: 128 }} messages={{ noPassword: 'Your identity provider manages your password.' }} onSubmit={values => action('password', async () => { await request('/account/password', 'POST', values); setPasswordForm(value => value + 1); }, 'Password changed. Other sessions have been signed out.')}/>}
    {account && <Stack gap={2}>
      <Button variant="secondary" disabled={!!busy || account.activeSessions < 2} loading={busy === 'sessions'} onClick={() => action('sessions', async () => { await request('/account/sessions/revoke', 'POST', {}); }, 'Other sessions signed out.')}>Sign out other sessions</Button>
      {sessions?.error && <Alert tone="danger" title={sessions.error}/>}
      {sessions?.notice && <StatusLine tone="success">{sessions.notice.text}</StatusLine>}
    </Stack>}
  </Stack></Card>;
}
