import { useEffect, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { Alert, Badge, Button, Card, Checkbox, ConfirmDialog, Disclosure, EmbedHost, Field, FormActions, Grid, Heading, Inline, Input, Select, Stack, StatusLine, Text, Textarea } from '@ten98/ui';
import { loadGoogleMaps } from './OohMap';
import ZernioWebhooks from './ZernioWebhooks';

type Project = { id: string; zernioProfileId?: string; driveFolderId?: string };
type Props = { project: Project; isOperator: boolean; canManageProject: boolean; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>; onChanged?: () => void | Promise<void>; sections?: Partial<Record<string, ReactNode>>; extraCards?: { id: string; title: string; description: string; body: ReactNode }[] };
type Provider = { id: string; label: string; configured: boolean; source: string; fields: Record<string, string | number>; secretFields: Record<string, { configured: boolean; source: string }>; options?: Record<string, string[]>; updatedAt?: string };
type Result = { ok: boolean; status: string; message: string; checkedAt?: string };
type Field = { name: string; label: string; secret?: boolean; multiline?: boolean; type?: string; placeholder?: string; min?: number; max?: number; help?: string; options?: { value: string; label: string }[]; serverOptions?: string };
// `options` is a fixed choice list. `serverOptions` takes the choices from the provider's `options[field]` (the app keeps no copy) and is the reason shown when the server lists none.
const definitions: Record<string, { label: string; description: string; note?: string; help: string; fields: Field[] }> = {
  googleAdsNative: { label: 'Google Shopping', description: 'Google Shopping campaigns and Video reporting.', help: 'Use an authorized Google Ads OAuth refresh token with the adwords scope and your approved developer token. Map a customer in the project connections below. Search Console and organic search stay in ten98 Discover. Standard Video creation is unavailable through the Google Ads API; use Zernio Demand Gen video or Google Ads itself.', fields: [{ name: 'clientId', label: 'OAuth client ID' }, { name: 'clientSecret', label: 'OAuth client secret', secret: true }, { name: 'refreshToken', label: 'OAuth refresh token', secret: true }, { name: 'developerToken', label: 'Google Ads developer token', secret: true }, { name: 'loginCustomerId', label: 'Manager customer ID (optional)', placeholder: '1234567890' }] },
  microsoftAds: { label: 'Microsoft Advertising', description: 'Microsoft Search campaigns, including eligible Copilot inventory.', help: 'Use an authorized Microsoft OAuth refresh token with msads.manage and offline_access, and your developer token. A client secret is optional for public clients. Map the customer/account in the project connections below. Inventory eligibility and placement are decided by Microsoft; the app cannot guarantee a Copilot placement.', fields: [{ name: 'clientId', label: 'OAuth client ID' }, { name: 'clientSecret', label: 'OAuth client secret (optional)', secret: true }, { name: 'refreshToken', label: 'OAuth refresh token', secret: true }, { name: 'developerToken', label: 'Microsoft Advertising developer token', secret: true }] },
  zernio: { label: 'Zernio', description: 'Social publishing, paid ads, analytics, messages, comments and reviews.', help: 'Register the webhook URL below in Zernio with this signing secret. Add message.received, comment.received, review.new and review.updated alongside your publishing events for live inbox updates and automatic Messenger contacts. Existing incoming Messenger history also creates contacts when opened.', fields: [{ name: 'apiKey', label: 'API key', secret: true }, { name: 'webhookSecret', label: 'Webhook signing secret', secret: true }] },
  openrouter: { label: 'OpenRouter', description: 'Content drafts using your selected OpenRouter model.', help: 'Choose a model that supports tool calling. Testing checks account access; it does not generate a paid completion.', fields: [{ name: 'apiKey', label: 'API key', secret: true }, { name: 'model', label: 'Model ID', placeholder: 'provider/model-id' }, { name: 'maxTokens', label: 'Maximum output tokens', type: 'number', min: 256, max: 8192 }, { name: 'maxSteps', label: 'Maximum agent steps', type: 'number', min: 1, max: 8 }] },
  googleDrive: { label: 'Google Drive', note: 'Shared Google credentials for Drive and Calendar.', description: 'The shared creative folder behind your asset library.', help: 'Share the project folder with this service account. Google Drive and Calendar use the same credentials.', fields: [{ name: 'serviceAccountEmail', label: 'Service account email', type: 'email', placeholder: 'campaign@project.iam.gserviceaccount.com' }, { name: 'privateKey', label: 'New private key (PEM)', secret: true, multiline: true, placeholder: '-----BEGIN PRIVATE KEY-----', help: 'Paste the full PEM key. Literal \\n line breaks are also accepted.' }] },
  googleCalendar: { label: 'Google Calendar', note: 'Google Drive and Calendar use one service account. Edit its credentials in Google Drive connection settings.', description: 'Shared campaign dates and project events in Google Calendar.', help: 'Share a dedicated calendar with the shared Google service account and grant event editing access. Manage its credentials in Google Drive connection settings.', fields: [] },
  googleMaps: { label: 'Google Maps', description: 'Map billboard locations and approved OOH inventory.', help: 'Enable Maps JavaScript API and billing. Restrict the browser key to this API and your app’s HTTP referrers. The key is browser-visible by design.', fields: [{ name: 'browserApiKey', label: 'Browser API key', secret: true }, { name: 'mapId', label: 'Map ID', placeholder: 'Your Google Cloud map ID', help: 'Use your own map ID in production. A demo map ID is used when this is empty.' }] },
  broadsign: { label: 'Broadsign', description: 'OOH inventory, proposals, bookings, and delivery reports.', help: 'Approve a domain, client, and screen list in the project connections below after configuring the account. The sandbox is the default.', fields: [{ name: 'apiKey', label: 'API key', secret: true }, { name: 'environment', label: 'Environment', options: [{ value: 'sandbox', label: 'Sandbox' }, { value: 'production', label: 'Production' }] }, { name: 'domainId', label: 'Allowed domain ID (optional)' }, { name: 'currency', label: 'Account currency', placeholder: 'USD', help: 'Needed when ad spend approval is required: bookings are approved in this currency.' }] },
  twilio: { label: 'Twilio SMS', description: 'SMS campaigns, incoming replies and delivery reports.', help: 'Use one approved sender for this app. A Messaging Service takes priority over the sender number. Testing reads account access and sends no SMS. Use a public HTTPS app address for delivery reports.', fields: [{ name: 'accountSid', label: 'Account SID', placeholder: 'AC…' }, { name: 'authToken', label: 'Auth token', secret: true }, { name: 'fromNumber', label: 'Sender number', placeholder: '+15551234567' }, { name: 'messagingServiceSid', label: 'Messaging Service SID (optional)', placeholder: 'MG…' }] },
  cloudflareEmail: { label: 'Cloudflare transactional email', description: 'Transactional email such as receipts, reminders, and service updates.', help: 'Cloudflare does not support marketing email. Enable Email Sending for the sender domain. The API token needs sending access; the read-only test also needs permission to read sending domains in this zone. No test email is sent.', fields: [{ name: 'accountId', label: 'Cloudflare account ID' }, { name: 'apiKey', label: 'Email Sending API token', secret: true }, { name: 'zoneId', label: 'Cloudflare zone ID (for connection test)' }, { name: 'fromAddress', label: 'Sender email address', type: 'email', placeholder: 'receipts@example.com' }, { name: 'fromName', label: 'Sender name (optional)' }, { name: 'replyToAddress', label: 'Reply-to email address (optional)', type: 'email', help: 'Route this address in Cloudflare to your Google Group or receiving inbox. Replies are handled there.' }] },
  amazonSes: { label: 'Amazon SES email', description: 'Direct email campaigns through your Amazon SES account, with bounce and complaint feedback.', help: 'Use an IAM user limited to ses:SendEmail, ses:GetAccount and ses:GetEmailIdentity. Verify the sender address or its domain in Amazon SES in the chosen region. For bounces and complaints, create a configuration set with SNS event publishing, then subscribe its SNS topic over HTTPS to the Amazon SES webhook URL shown in Direct campaigns. Testing reads the account and sender identity; it sends no email.', fields: [{ name: 'emailProvider', label: 'Send email campaigns with', options: [{ value: '', label: 'Automatic' }, { value: 'cloudflare', label: 'Cloudflare' }, { value: 'ses', label: 'Amazon SES' }], help: 'Automatic uses whichever of Cloudflare and Amazon SES is configured. When both are configured, choose one: email campaigns and tests cannot be sent until you do.' }, { name: 'region', label: 'AWS region', placeholder: 'Choose a region', serverOptions: 'This server does not list Amazon SES regions, so the region cannot be changed here.' }, { name: 'accessKeyId', label: 'Access key ID', placeholder: 'AKIA…' }, { name: 'secretAccessKey', label: 'Secret access key', secret: true }, { name: 'fromAddress', label: 'Sender email address', type: 'email', placeholder: 'receipts@example.com', help: 'A verified identity in Amazon SES.' }, { name: 'fromName', label: 'Sender name (optional)' }, { name: 'replyToAddress', label: 'Reply-to email address (optional)', type: 'email' }, { name: 'configurationSet', label: 'Configuration set', help: 'Needed to publish bounce and complaint events to SNS.' }, { name: 'snsTopicArn', label: 'SNS topic ARN', placeholder: 'arn:aws:sns:us-east-1:123456789012:ses-feedback', help: 'Use a topic in the same region. Only notifications from this topic are accepted.' }] },
};
const sourceLabel = (source: string) => ({ saved: 'Saved in this app', environment: 'Deployment settings', mixed: 'App + deployment settings', unconfigured: 'Not configured', disabled: 'Disabled in this app' }[source] || source);

export default function IntegrationSettings({ project, isOperator, canManageProject, request, onChanged, sections, extraCards }: Props) {
  const [providers, setProviders] = useState<Provider[]>([]), [drafts, setDrafts] = useState<Record<string, Record<string, string | null>>>({}), [results, setResults] = useState<Record<string, Result>>({});
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [loaded, setLoaded] = useState(false), [mapsReload, setMapsReload] = useState(false), [confirming, setConfirming] = useState<Provider>();
  const [mapping, setMapping] = useState({ zernioProfileId: project.zernioProfileId || '', driveFolderId: project.driveFolderId || '', calendarId: '' }), [calendarLoaded, setCalendarLoaded] = useState(false);
  const [smsWebhook, setSmsWebhook] = useState<{ projectId: string; url?: string; publicCallbacks?: boolean; error?: string } | null>(null);
  const active = useRef(true), mapContainer = useRef<HTMLDivElement>(null), mapsTested = useRef(false), cancelMapProbe = useRef<(() => void) | null>(null);
  const canMap = isOperator && canManageProject;
  const projectSmsWebhook = smsWebhook?.projectId === project.id ? smsWebhook : null;
  async function refresh() { const data = await request('/settings/integrations'); if (active.current) { setProviders(data.providers); setLoaded(true); } }
  useEffect(() => {
    active.current = true; let current = true;
    const mapFailure = (event: Event) => { if (!mapsTested.current) return; cancelMapProbe.current?.(); setResults(items => ({ ...items, googleMaps: { ok: false, status: 'failed', message: String((event as CustomEvent).detail || 'Google Maps rejected this site.'), checkedAt: new Date().toISOString() } })); };
    window.addEventListener('ten98-maps-error', mapFailure);
    if (isOperator) request('/settings/integrations').then(data => { if (current) { setProviders(data.providers); setLoaded(true); } }).catch(err => { if (current) setError(err.message); });
    request(`/projects/${project.id}/calendar/status`).then(data => { if (current) { setMapping(items => ({ ...items, calendarId: data.calendarId || '' })); setCalendarLoaded(true); } }).catch(err => { if (current) setError(err.message); });
    return () => { current = false; active.current = false; cancelMapProbe.current?.(); window.removeEventListener('ten98-maps-error', mapFailure); };
  }, [project.id, isOperator]);
  useEffect(() => {
    let current = true;
    setSmsWebhook(null);
    if (canMap) request(`/projects/${encodeURIComponent(project.id)}/sms-inbox/status`).then(data => {
      if (!current) return;
      if (typeof data?.callbackUrl !== 'string' || !data.callbackUrl || typeof data.publicCallbacks !== 'boolean') throw new Error('SMS webhook settings could not be read.');
      setSmsWebhook({ projectId: project.id, url: data.callbackUrl, publicCallbacks: data.publicCallbacks });
    }).catch(failure => { if (current) setSmsWebhook({ projectId: project.id, error: failure.message || 'SMS webhook settings could not be read.' }); });
    return () => { current = false; };
  }, [project.id, canMap, request]);
  function change(provider: string, field: string, value: string | null) { setDrafts(items => { const draft = { ...items[provider], [field]: value }; return { ...items, [provider]: draft, ...(['googleDrive', 'googleCalendar'].includes(provider) ? { googleDrive: draft, googleCalendar: draft } : {}) }; }); }
  function dirty(provider: Provider) { return Object.entries(drafts[provider.id] || {}).some(([name, value]) => value === null || (provider.secretFields?.[name] ? Boolean(value.trim()) : value !== String(provider.fields?.[name] ?? ''))); }
  async function action(name: string, run: () => Promise<void>) {
    if (busy) return; setBusy(name); setError(''); setNotice('');
    try { await run(); } catch (err) { if (active.current) setError((err as Error).message || 'This integration action could not be completed.'); }
    finally { if (active.current) setBusy(''); }
  }
  async function save(provider: Provider, event: React.FormEvent) {
    event.preventDefault();
    await action(provider.id, async () => {
      const fields = Object.fromEntries(Object.entries(drafts[provider.id] || {}).filter(([name, value]) => !provider.secretFields?.[name] || value === null || Boolean(value.trim())));
      await request(`/settings/integrations/${provider.id}`, 'PUT', { fields }); await refresh();
      if (!active.current) return;
      const shared = provider.id === 'googleDrive' || provider.id === 'googleCalendar';
      setDrafts(items => ({ ...items, [provider.id]: {}, ...(shared ? { googleDrive: {}, googleCalendar: {} } : {}) }));
      setResults(items => { const next = { ...items }; delete next[provider.id]; if (shared) { delete next.googleDrive; delete next.googleCalendar; } return next; });
      if (provider.id === 'googleMaps') { mapsTested.current = false; cancelMapProbe.current?.(); setMapsReload(true); }
      setNotice(shared ? 'Google credentials saved for Drive and Calendar. Test each project connection below.' : `${provider.label} settings saved. Test the connection when ready.`);
      await onChanged?.();
    });
  }
  async function reset(provider: Provider) {
    await action(provider.id, async () => {
      await request(`/settings/integrations/${provider.id}`, 'DELETE'); await refresh();
      if (!active.current) return;
      setDrafts(items => ({ ...items, [provider.id]: {}, ...(provider.id === 'googleDrive' || provider.id === 'googleCalendar' ? { googleDrive: {}, googleCalendar: {} } : {}) })); setResults({});
      if (provider.id === 'googleMaps') { mapsTested.current = false; cancelMapProbe.current?.(); setMapsReload(true); }
      setNotice(`${provider.label} now uses its deployment settings.`); await onChanged?.();
    });
  }
  async function test(provider: Provider) {
    await action(provider.id, async () => {
      setResults(items => { const next = { ...items }; delete next[provider.id]; return next; });
      const result: Result = await request(`/settings/integrations/${provider.id}/test`, 'POST', { projectId: project.id });
      if (!active.current) return; setResults(items => ({ ...items, [provider.id]: result }));
      if (provider.id !== 'googleMaps' || result.status !== 'browser_verification_required') return;
      const config = await request(`/projects/${project.id}/maps/config`); if (!active.current) return;
      if (!config.configured) throw new Error('Save a Google Maps browser key before testing this site.');
      mapsTested.current = true;
      const google = await loadGoogleMaps(config.browserKey); if (!active.current) return;
      // Rendered synchronously so the host shows its mount before the map attaches to it.
      flushSync(() => setResults(items => ({ ...items, googleMaps: { ok: false, status: 'browser_loading', message: 'Loading a map preview to check this browser’s access…' } })));
      if (!mapContainer.current) return;
      const map = new google.Map(mapContainer.current, { center: { lat: 25.2048, lng: 55.2708 }, zoom: 10, mapId: config.mapId || 'DEMO_MAP_ID', streetViewControl: false, mapTypeControl: false });
      await new Promise<void>(resolve => {
        let settled = false;
        const finish = (result?: Result) => { if (settled) return; settled = true; clearTimeout(timer); listener.remove(); cancelMapProbe.current = null; if (result && active.current) setResults(items => ({ ...items, googleMaps: result })); resolve(); };
        const timer = setTimeout(() => finish({ ok: false, status: 'failed', message: 'The map did not finish loading. Check the preview, network access, billing, and key restrictions.', checkedAt: new Date().toISOString() }), 20000);
        const listener = google.event.addListenerOnce(map, 'tilesloaded', () => finish({ ok: true, status: 'browser_loaded', message: 'Google Maps rendered successfully for this site. Your OOH locations can use this browser key.', checkedAt: new Date().toISOString() }));
        cancelMapProbe.current = () => finish();
      });
    });
  }
  async function saveProject(name: string, field: 'zernioProfileId' | 'driveFolderId', provider: string, message: string, event: React.FormEvent) {
    event.preventDefault(); await action(name, async () => {
      await request(`/projects/${project.id}`, 'PATCH', { [field]: mapping[field].trim() });
      setNotice(message); setResults(items => { const next = { ...items }; delete next[provider]; return next; }); await onChanged?.();
    });
  }
  async function saveCalendar(event: React.FormEvent) {
    event.preventDefault(); await action('calendar-mapping', async () => {
      await request(`/projects/${project.id}/calendar/connection`, 'POST', { calendarId: mapping.calendarId.trim() });
      setNotice('Project calendar mapping saved.'); setResults(items => { const next = { ...items }; delete next.googleCalendar; return next; }); await onChanged?.();
    });
  }
  function reloadMaps() { const url = new URL(window.location.href); url.searchParams.set('view', 'integrations'); url.searchParams.set('project', project.id); window.location.assign(url.href); }
  const mappingForm = (label: string, field: keyof typeof mapping, maxLength: number, placeholder: string, help: string, submit: string, onSubmit: (event: React.FormEvent) => void, locked = false) => <Stack as="form" gap={3} onSubmit={onSubmit}><Stack as="fieldset" gap={3} disabled={!canMap || Boolean(busy) || locked}>
    <Field label={label} description={help}><Input value={mapping[field]} maxLength={maxLength} placeholder={placeholder} onChange={event => setMapping({ ...mapping, [field]: event.target.value })}/></Field>
    {canMap && <FormActions><Button type="submit" variant="secondary">{submit}</Button></FormActions>}
  </Stack></Stack>;
  // Provider adapters: each provider's own project sections. The card shell below never branches on the provider.
  const adapters: Partial<Record<string, ReactNode>> = {
    zernio: <>{isOperator && <Field label="Webhook URL" description="Register this URL in Zernio with the signing secret from the connection settings."><Input readOnly value={`${window.location.origin}/api/webhooks/zernio`}/></Field>}
      {mappingForm('Zernio profile ID', 'zernioProfileId', 200, 'Brand profile in Zernio', 'Each Zernio profile can belong to one project. Leaving it empty disconnects the profile.', 'Save profile', event => saveProject('zernio-mapping', 'zernioProfileId', 'zernio', 'Zernio profile mapping saved.', event))}
      {canMap && <ZernioWebhooks key={project.id} projectId={project.id} request={request}/>}</>,
    googleDrive: mappingForm('Google Drive folder ID', 'driveFolderId', 200, 'Shared creative folder ID', 'Use the folder ID from its Google Drive URL. Leaving it empty disconnects the folder.', 'Save folder', event => saveProject('drive-mapping', 'driveFolderId', 'googleDrive', 'Drive folder mapping saved.', event)),
    googleCalendar: mappingForm('Google Calendar ID', 'calendarId', 500, 'calendar-id@group.calendar.google.com', 'Use a dedicated shared calendar with event editing access for the service account. Each calendar can belong to one project; leaving this empty disconnects it.', 'Save calendar', saveCalendar, !calendarLoaded),
    twilio: canMap && <Stack gap={2} aria-label="SMS incoming webhook"><Heading level={3} size="sm">Incoming SMS webhook</Heading><Text tone="muted">Set this project’s incoming-message webhook in Twilio to HTTP POST.</Text>
      {projectSmsWebhook?.error ? <Alert tone="danger" title={projectSmsWebhook.error}/> : projectSmsWebhook?.url ? <><Field label="Incoming-message webhook URL (HTTP POST)"><Input readOnly value={projectSmsWebhook.url}/></Field>{!projectSmsWebhook.publicCallbacks && <Alert tone="warning" title="Use a public HTTPS app address before configuring incoming SMS delivery."/>}</> : <StatusLine busy>Loading SMS webhook settings…</StatusLine>}</Stack>,
    googleMaps: <>{mapsReload && <Alert tone="info" title="Reload the app to apply the browser map settings before testing." actions={<Button variant="secondary" onClick={reloadMaps}>Reload app</Button>}/>}
      {['browser_loading', 'browser_loaded', 'failed'].includes(results.googleMaps?.status) && <EmbedHost ref={mapContainer} label="Google Maps connection preview" size="sm"/>}</>,
  };
  function credentials(provider: Provider, definition: typeof definitions[string]) {
    const edits = drafts[provider.id] || {}, changed = dirty(provider), testButton = <Button variant="secondary" loading={busy === provider.id} disabled={Boolean(busy) || !provider.configured || changed || (provider.id === 'googleMaps' && mapsReload)} onClick={() => test(provider)}>Test connection</Button>;
    const instructions = <Disclosure summary="Setup instructions"><Text>{definition.help}</Text></Disclosure>;
    return <Disclosure summary="Connection settings"><Stack gap={3}>
      <Text size="sm" tone="muted">{sourceLabel(provider.source)}{provider.updatedAt && ` · Updated ${new Date(provider.updatedAt).toLocaleString()}`}</Text>
      {definition.note && <Text tone="muted">{definition.note}</Text>}
      {!definition.fields.length ? <>{instructions}<FormActions>{testButton}</FormActions>{changed && <Text size="sm" tone="muted">Save the shared Google credentials before testing.</Text>}</> : <Stack as="form" gap={3} onSubmit={event => save(provider, event)}><Stack as="fieldset" gap={3} disabled={Boolean(busy)}>
        {definition.fields.map(field => {
          const secret = provider.secretFields?.[field.name], clear = edits[field.name] === null, value = clear ? '' : edits[field.name] ?? (field.secret ? '' : String(provider.fields?.[field.name] ?? ''));
          const choices = field.serverOptions ? provider.options?.[field.name]?.map(option => ({ value: option, label: option })) : field.options, unlisted = Boolean(field.serverOptions && !choices);
          const input = { name: `${provider.id}-${field.name}`, value, placeholder: field.secret && secret?.configured ? 'Configured — leave blank to keep' : field.placeholder, maxLength: field.multiline ? 16000 : 4000, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => change(provider.id, field.name, event.target.value), disabled: clear || unlisted || Boolean(busy) };
          return <Stack gap={2} key={field.name}>
            <Field label={field.secret ? `${field.label} · ${secret?.configured ? sourceLabel(secret.source) : 'Not configured'}` : field.label} description={unlisted ? field.serverOptions : field.help}>{field.multiline ? <Textarea {...input} rows={3} autoComplete="off" spellCheck={false}/> : choices || unlisted ? <Select {...input} options={field.serverOptions ? [{ value: '', label: field.placeholder || 'Not set' }, ...(choices || [])] : choices}/> : <Input {...input} type={field.secret ? 'password' : field.type || 'text'} autoComplete={field.secret ? 'new-password' : 'off'} min={field.min} max={field.max} spellCheck={false}/>}</Field>
            {field.secret && <Checkbox label="Clear this credential, including environment fallback" checked={clear} onChange={event => change(provider.id, field.name, event.target.checked ? null : '')}/>}
          </Stack>;
        })}
        {instructions}
        <FormActions><Button type="submit" disabled={!changed}>Save settings</Button>{testButton}<Button variant="ghost" onClick={() => setConfirming(provider)}>Use deployment settings</Button></FormActions>
        {changed && <Text size="sm" tone="muted">Save these changes before testing.</Text>}
      </Stack></Stack>}
    </Stack></Disclosure>;
  }
  const resultTitle = (status: string) => ({ connected: 'Connection verified', needs_mapping: 'Project mapping needed', browser_verification_required: 'Browser check required', browser_loaded: 'Map connection verified' } as Record<string, string>)[status] || 'Connection check';
  const card = (id: string, title: string, description: string, status: ReactNode, body: ReactNode) => <Card as="section" key={id} id={`integration-${id}`} title={title} description={description} actions={status}><Stack gap={3}>{body}</Stack></Card>;
  return <Stack gap={4}>
    <Inline gap={2}><Text tone="muted">Credentials apply to every workspace. Each provider’s card also holds this project’s connection to it.</Text><Badge>{isOperator ? 'App administrator' : 'Project access'}</Badge></Inline>
    {error && <Alert tone="danger" title={error}/>}{notice && <StatusLine tone="success">{notice}</StatusLine>}
    {!isOperator && <Alert tone="info" title="An app administrator can configure credentials and test provider connections. This project’s connections are shown in each card."/>}
    {!canMap && <Text size="sm" tone="muted">An app administrator who also manages this workspace can change project connections.</Text>}
    {isOperator && !loaded && !error && <StatusLine busy>Loading integration settings…</StatusLine>}
    <Grid gap={4} minItemWidth="lg">
      {Object.entries(definitions).map(([id, definition]) => {
        const provider = providers.find(item => item.id === id), result = results[id];
        return card(id, provider?.label || definition.label, definition.description, provider && <Badge tone={provider.configured ? 'success' : 'neutral'}>{provider.configured ? 'Configured' : 'Not configured'}</Badge>, <>
          {provider && credentials(provider, definition)}
          {result && <Alert tone={result.ok ? 'success' : 'warning'} title={resultTitle(result.status)}>{result.message}{result.checkedAt && <Text size="xs" tone="muted">Checked {new Date(result.checkedAt).toLocaleString()}</Text>}</Alert>}
          {adapters[id]}{sections?.[id]}
        </>);
      })}
      {extraCards?.map(extra => card(extra.id, extra.title, extra.description, null, extra.body))}
    </Grid>
    <ConfirmDialog open={!!confirming} onOpenChange={open => { if (!open) setConfirming(undefined); }} title={`Use deployment settings for ${confirming?.label || 'this provider'}?`} description={`Remove the saved ${confirming?.label || ''} settings and use the deployment settings.${confirming?.id === 'googleDrive' || confirming?.id === 'googleCalendar' ? ' This changes both Google Drive and Calendar.' : ''}`} confirmLabel="Use deployment settings" danger onConfirm={() => reset(confirming!)}/>
  </Stack>;
}
