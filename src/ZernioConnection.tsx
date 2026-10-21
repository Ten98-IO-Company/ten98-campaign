import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Field, FormActions, InlineCode, Input, Link, List, ListItem, Option, OptionGroup, Select, Stack, StatusLine, Text } from '@ten98/ui';

type Props = { projectId: string; canManage: boolean; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>; onConnected: () => void; onCancel: () => void };
const social = [['instagram', 'Instagram'], ['facebook', 'Facebook'], ['linkedin', 'LinkedIn'], ['twitter', 'X'], ['tiktok', 'TikTok'], ['youtube', 'YouTube'], ['threads', 'Threads'], ['pinterest', 'Pinterest'], ['reddit', 'Reddit'], ['googlebusiness', 'Google Business Profile'], ['whatsapp', 'WhatsApp'], ['discord', 'Discord'], ['slack', 'Slack']];
const ads = [['facebook', 'Meta'], ['google', 'Google'], ['tiktok', 'TikTok'], ['linkedin', 'LinkedIn'], ['pinterest', 'Pinterest'], ['twitter', 'X'], ['reddit', 'Reddit']];
const settings: Record<string, { label: string; fields: [string, string, string][]; help: string }> = {
  bluesky: { label: 'Bluesky', fields: [['identifier', 'Handle or email', 'text'], ['appPassword', 'Bluesky app password', 'password']], help: 'Use an app password from Bluesky Settings. Credentials are sent to Zernio and are not stored by this app.' },
  wordpress: { label: 'Self-hosted WordPress', fields: [['siteUrl', 'HTTPS site URL', 'url'], ['username', 'WordPress username', 'text'], ['applicationPassword', 'WordPress application password', 'password']], help: 'Use an Application Password from your WordPress user profile. The site must allow publishing and media uploads. This connects the site for blog and supported store tools.' },
  shopify: { label: 'Shopify custom app', fields: [['shop', 'Store domain', 'text'], ['accessToken', 'Admin API access token', 'password']], help: 'Use your-store.myshopify.com and a merchant-created custom app token with read_content, write_content, read_products and write_products permissions.' },
  whop: { label: 'Whop pixel', fields: [['apiKey', 'Whop Account API key', 'password']], help: 'Whop supplies a tracking pixel. Zernio does not manage Whop advertising campaigns. Use an Account API key able to read its own account.' },
  telegram: { label: 'Telegram', fields: [['chatId', 'Chat ID or @channel', 'text']], help: 'Add the Zernio bot as an administrator of the channel or group. Connect its chat ID directly, or generate a temporary code and follow the bot instructions.' },
};

export default function ZernioConnection({ projectId, canManage, request, onConnected, onCancel }: Props) {
  const [choice, setChoice] = useState('social:instagram'), [mode, setMode] = useState('code'), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [authUrl, setAuthUrl] = useState('');
  const [telegram, setTelegram] = useState<any>(null), [accounts, setAccounts] = useState<any[]>([]), [accountError, setAccountError] = useState(''), [accountRetry, setAccountRetry] = useState(0);
  const [authorizationRevision, setAuthorizationRevision] = useState(0), latestAuthorization = useRef(0);
  const keys = useRef(new Map<string, string>()), requester = useRef(request), mounted = useRef(true), busyRef = useRef(false);
  requester.current = request;
  const identity = useRef({ projectId, canManage, choice, mode });
  if (identity.current.projectId !== projectId || identity.current.canManage !== canManage || identity.current.choice !== choice || identity.current.mode !== mode) { identity.current = { projectId, canManage, choice, mode }; busyRef.current = false; }
  const view = identity.current, current = () => mounted.current && identity.current === view;
  const path = `/projects/${encodeURIComponent(projectId)}/integrations`, [kind, platform] = choice.split(':'), config = kind === 'credentials' ? settings[platform] : null;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { keys.current.clear(); setBusy(false); setError(''); setNotice(''); setAuthUrl(''); setTelegram(null); }, [projectId, canManage, choice, mode]);
  useEffect(() => { let active = true; setAccounts([]); setAccountError(''); requester.current(path + '/accounts').then(response => { if (active) { if (!Array.isArray(response.accounts)) throw new Error('Unreadable account list'); setAccounts(response.accounts); } }).catch(() => { if (active) setAccountError('The posting accounts could not be loaded. Refresh them before connecting X Ads.'); }); return () => { active = false; }; }, [path, accountRetry]);
  function clearAuthorization() {
    if (!current() || latestAuthorization.current !== authorizationRevision) return false;
    setAuthorizationRevision(++latestAuthorization.current); setAuthUrl(''); setNotice(''); return true;
  }
  async function act(run: () => Promise<void>) {
    if (!current() || !canManage || busyRef.current) return; busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try { await run(); } catch (failure) { if (current()) setError((failure as Error).message || 'The connection could not be confirmed.'); }
    finally { if (current()) { busyRef.current = false; setBusy(false); } }
  }
  async function write(target: string, body: unknown) {
    if (!current() || !canManage) throw new DOMException('The connection view changed.', 'AbortError');
    const signature = `${target}:${JSON.stringify(body)}`; let key = keys.current.get(signature); if (!key) { key = crypto.randomUUID(); keys.current.set(signature, key); }
    try {
      const result = await requester.current(target, 'POST', body, key);
      if (result.operation?.status !== 'complete' || !(target.endsWith('/code') ? typeof result.code === 'string' && typeof result.expiresAt === 'string' && typeof result.botUsername === 'string' && Array.isArray(result.instructions) : typeof result.account?.accountId === 'string' && typeof result.account?.platform === 'string')) throw new Error('The connection receipt could not be read. The action key has been retained.');
      keys.current.delete(signature); return result;
    } catch (failure) { const failed = failure as Error & { status?: number; code?: string; operation?: { status?: string } }; if (failed.status && failed.status < 500 && !['OPERATION_UNCERTAIN', 'OPERATION_PENDING', 'OPERATION_IN_PROGRESS'].includes(failed.code || '') && !['pending', 'uncertain'].includes(failed.operation?.status || '')) keys.current.delete(signature); throw failure; }
  }
  async function connect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!config && (!current() || latestAuthorization.current !== authorizationRevision)) return;
    const form = event.currentTarget, body = Object.fromEntries(new FormData(form)) as Record<string, string>;
    await act(async () => {
      if (config) {
        const code = platform === 'telegram' && mode === 'code', result = await write(`${path}/connections/${platform}/${code ? 'code' : 'credentials'}`, code ? {} : body);
        if (!current()) return;
        if (code) { setTelegram(result); setNotice('Add the bot and send this code before it expires.'); }
        else { form.reset(); setNotice(`${result.account.displayName || config.label} connected and confirmed in this project.`); onConnected(); }
      } else {
        if (!clearAuthorization()) return;
        const revision = latestAuthorization.current, fresh = () => current() && latestAuthorization.current === revision;
        const target = kind === 'store' ? `${path}/connections/${platform}/oauth` : path + '/connect', params = new URLSearchParams(kind === 'store' ? {} : { platform, kind });
        for (const [key, value] of Object.entries(body)) if (value) params.set(key, value);
        try {
          const result = await requester.current(target + '?' + params);
          if (!fresh()) return;
          if (result.alreadyConnected === true) { onConnected(); return; }
          let url; try { url = new URL(result.authUrl); } catch { throw new Error('The authorization URL could not be read.'); }
          if (url.protocol !== 'https:' || url.username || url.password) throw new Error('The authorization URL is invalid.');
          setAuthUrl(url.href); setNotice('Continue with the provider, then return here and refresh connections. The provider hosts any Page, organization or channel selection.');
        } catch (failure) { if (fresh()) throw failure; }
      }
    });
  }
  async function checkCode() {
    if (!telegram?.code) return;
    await act(async () => {
      const result = await requester.current(`${path}/connections/telegram/status`, 'POST', { code: telegram.code }); if (!current()) return;
      if (!['pending', 'connected', 'expired'].includes(result.status)) throw new Error('The Telegram status could not be read.');
      if (result.status === 'connected') { setTelegram(null); setNotice('Telegram connected and confirmed in this project.'); onConnected(); }
      else setNotice(result.status === 'expired' ? 'The access code expired. Generate a new code to continue.' : 'Waiting for the bot to confirm your channel or group.');
    });
  }
  return <Stack as="form" gap={4} onSubmit={connect} onChange={() => { if (!config) clearAuthorization(); }}>
    <Stack as="fieldset" gap={3} disabled={busy || !canManage} key={choice + ':' + mode}>
      <Field label="Channel or store"><Select value={choice} onChange={event => setChoice(event.target.value)}><OptionGroup label="Social channels">{social.map(([value, label]) => <Option key={value} value={'social:' + value}>{label}</Option>)}<Option value="credentials:bluesky">Bluesky</Option><Option value="credentials:telegram">Telegram</Option></OptionGroup><OptionGroup label="Advertising">{ads.map(([value, label]) => <Option key={value} value={'ads:' + value}>{label} Ads</Option>)}<Option value="credentials:whop">Whop pixel</Option></OptionGroup><OptionGroup label="Stores and blogs"><Option value="store:shopify">Shopify authorization</Option><Option value="credentials:shopify">Shopify custom app token</Option><Option value="store:wordpress">WordPress.com authorization</Option><Option value="credentials:wordpress">Self-hosted WordPress</Option></OptionGroup></Select></Field>
      {platform === 'telegram' && <Field label="Telegram connection method"><Select value={mode} onChange={event => setMode(event.target.value)}><Option value="code">Temporary bot access code</Option><Option value="direct">Known channel or group ID</Option></Select></Field>}
      {kind === 'social' && platform === 'instagram' && <><Field label="Instagram connection method"><Select name="loginMethod" defaultValue="instagram_login"><Option value="instagram_login">Instagram Login</Option><Option value="facebook_login">Facebook Login</Option></Select></Field><Text tone="muted">Instagram Login connects your professional Instagram account directly, without a Facebook Page. Facebook Login uses a Facebook Page linked to your professional Instagram account; choose that Page on the provider’s hosted page.</Text></>}
      {config ? <><Text tone="muted">{config.help}</Text>{!(platform === 'telegram' && mode === 'code') && config.fields.map(([name, label, type]) => <Field key={name} label={`${label} *`}><Input name={name} type={type} required maxLength={['appPassword', 'applicationPassword', 'accessToken', 'apiKey'].includes(name) ? 4096 : 500} autoComplete="off" spellCheck={false}/></Field>)}{platform !== 'telegram' && <Text tone="muted">Sensitive connection fields are sent to Zernio over HTTPS. They are cleared after a confirmed connection and are not stored in this app.</Text>}</> : <>
        {kind === 'store' && platform === 'shopify' && <Field label="Store domain *"><Input name="shop" required placeholder="your-store.myshopify.com" maxLength={100}/></Field>}
        {kind === 'ads' && platform === 'twitter' && <><Field label="X posting account *"><Select name="accountId" required><Option value="">Choose a posting account</Option>{accounts.filter(row => row.platform === 'twitter' && row.isActive !== false).map(row => <Option key={row._id} value={row._id}>{row.displayName || row.username || row._id}</Option>)}</Select></Field>{accountError && <Alert tone="danger">{accountError}</Alert>}<FormActions><Button variant="secondary" onClick={() => { if (clearAuthorization()) setAccountRetry(value => value + 1); }}>Refresh posting accounts</Button></FormActions></>}
        <Text tone="muted">Authorization and required account selections happen on the provider’s hosted pages. Provider approval, billing and permissions still apply.</Text>
      </>}
    </Stack>
    {error && <Alert tone="danger">{error}</Alert>}{notice && <StatusLine>{notice}</StatusLine>}
    {telegram && <Card as="section" headingLevel={3} title="Telegram access code"><Stack gap={3}><Text>Send <InlineCode>{telegram.code}</InlineCode> to <Text as="strong" weight="semibold">@{telegram.botUsername}</Text>. Expires {new Date(telegram.expiresAt).toLocaleString()}.</Text><List ordered>{telegram.instructions.map((line: string, index: number) => <ListItem key={index}>{line}</ListItem>)}</List><FormActions><Button variant="secondary" disabled={busy || !canManage} onClick={checkCode}>Check Telegram connection</Button></FormActions></Stack></Card>}
    {authUrl && <Link variant="standalone" href={authUrl} target="_blank" rel="noopener noreferrer">Continue with provider</Link>}
    <FormActions><Button variant="secondary" onClick={onCancel}>Cancel</Button><Button variant="primary" type="submit" disabled={busy || !canManage}>{busy ? 'Checking connection…' : config ? platform === 'telegram' && mode === 'code' ? 'Generate access code' : 'Connect and verify' : 'Get authorization link'}</Button></FormActions>
  </Stack>;
}
