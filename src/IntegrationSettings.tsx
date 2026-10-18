import { useEffect, useRef, useState } from 'react';
import { loadGoogleMaps } from './OohMap';

type Project = { id: string; zernioProfileId?: string; driveFolderId?: string };
type Props = { project: Project; isOperator: boolean; canManageProject: boolean; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>; onChanged?: () => void | Promise<void> };
type Provider = { id: string; label: string; configured: boolean; source: string; fields: Record<string, string | number>; secretFields: Record<string, { configured: boolean; source: string }>; updatedAt?: string };
type Result = { ok: boolean; status: string; message: string; checkedAt?: string };
type Field = { name: string; label: string; secret?: boolean; multiline?: boolean; type?: string; placeholder?: string; min?: number; max?: number; help?: string };
const definitions: Record<string, { initial: string; description: string; help: string; fields: Field[] }> = {
  googleAdsNative: { initial: 'GA', description: 'Google Shopping campaigns and Video reporting.', help: 'Use an authorized Google Ads OAuth refresh token with the adwords scope and your approved developer token. Map a customer in Ads manager. Search Console and organic search stay in ten98 Discover. Standard Video creation is unavailable through the Google Ads API; use Zernio Demand Gen video or Google Ads itself.', fields: [{ name: 'clientId', label: 'OAuth client ID' }, { name: 'clientSecret', label: 'OAuth client secret', secret: true }, { name: 'refreshToken', label: 'OAuth refresh token', secret: true }, { name: 'developerToken', label: 'Google Ads developer token', secret: true }, { name: 'loginCustomerId', label: 'Manager customer ID (optional)', placeholder: '1234567890' }] },
  microsoftAds: { initial: 'MS', description: 'Microsoft Search campaigns, including eligible Copilot inventory.', help: 'Use an authorized Microsoft OAuth refresh token with msads.manage and offline_access, and your developer token. A client secret is optional for public clients. Map the customer/account in Ads manager. Inventory eligibility and placement are decided by Microsoft; the app cannot guarantee a Copilot placement.', fields: [{ name: 'clientId', label: 'OAuth client ID' }, { name: 'clientSecret', label: 'OAuth client secret (optional)', secret: true }, { name: 'refreshToken', label: 'OAuth refresh token', secret: true }, { name: 'developerToken', label: 'Microsoft Advertising developer token', secret: true }] },
  zernio: { initial: 'Z', description: 'Social publishing, paid ads, analytics, messages, comments and reviews.', help: 'Register the webhook URL below in Zernio with this signing secret. Add message.received, comment.received, review.new and review.updated alongside your publishing events for live inbox updates and automatic Messenger contacts. Existing incoming Messenger history also creates contacts when opened.', fields: [{ name: 'apiKey', label: 'API key', secret: true }, { name: 'webhookSecret', label: 'Webhook signing secret', secret: true }] },
  openrouter: { initial: 'OR', description: 'Content drafts using your selected OpenRouter model.', help: 'Choose a model that supports tool calling. Testing checks account access; it does not generate a paid completion.', fields: [{ name: 'apiKey', label: 'API key', secret: true }, { name: 'model', label: 'Model ID', placeholder: 'provider/model-id' }, { name: 'maxTokens', label: 'Maximum output tokens', type: 'number', min: 256, max: 8192 }, { name: 'maxSteps', label: 'Maximum agent steps', type: 'number', min: 1, max: 8 }] },
  googleDrive: { initial: 'D', description: 'The shared creative folder behind your asset library.', help: 'Share the project folder with this service account. Google Drive and Calendar use the same credentials.', fields: [{ name: 'serviceAccountEmail', label: 'Service account email', type: 'email', placeholder: 'campaign@project.iam.gserviceaccount.com' }, { name: 'privateKey', label: 'New private key (PEM)', secret: true, multiline: true, placeholder: '-----BEGIN PRIVATE KEY-----', help: 'Paste the full PEM key. Literal \\n line breaks are also accepted.' }] },
  googleCalendar: { initial: 'C', description: 'Shared campaign dates and project events in Google Calendar.', help: 'Share a dedicated calendar with this service account and grant event editing access. Saving credentials here also updates Google Drive.', fields: [{ name: 'serviceAccountEmail', label: 'Service account email', type: 'email', placeholder: 'campaign@project.iam.gserviceaccount.com' }, { name: 'privateKey', label: 'New private key (PEM)', secret: true, multiline: true, placeholder: '-----BEGIN PRIVATE KEY-----', help: 'Paste the full PEM key. Literal \\n line breaks are also accepted.' }] },
  googleMaps: { initial: 'M', description: 'Map billboard locations and approved OOH inventory.', help: 'Enable Maps JavaScript API and billing. Restrict the browser key to this API and your app’s HTTP referrers. The key is browser-visible by design.', fields: [{ name: 'browserApiKey', label: 'Browser API key', secret: true }, { name: 'mapId', label: 'Map ID', placeholder: 'Your Google Cloud map ID', help: 'Use your own map ID in production. A demo map ID is used when this is empty.' }] },
  broadsign: { initial: 'B', description: 'OOH inventory, proposals, bookings, and delivery reports.', help: 'Approve a domain, client, and screen list in OOH media after configuring the account. The sandbox is the default.', fields: [{ name: 'apiKey', label: 'API key', secret: true }, { name: 'environment', label: 'Environment' }, { name: 'domainId', label: 'Allowed domain ID (optional)' }] },
  twilio: { initial: 'SMS', description: 'SMS campaigns, incoming replies and delivery reports.', help: 'Use one approved sender for this app. A Messaging Service takes priority over the sender number. Testing reads account access and sends no SMS. Use a public HTTPS app address for delivery reports.', fields: [{ name: 'accountSid', label: 'Account SID', placeholder: 'AC…' }, { name: 'authToken', label: 'Auth token', secret: true }, { name: 'fromNumber', label: 'Sender number', placeholder: '+15551234567' }, { name: 'messagingServiceSid', label: 'Messaging Service SID (optional)', placeholder: 'MG…' }] },
  cloudflareEmail: { initial: 'CF', description: 'Transactional email such as receipts, reminders, and service updates.', help: 'Cloudflare does not support marketing email. Enable Email Sending for the sender domain. The API token needs sending access; the read-only test also needs permission to read sending domains in this zone. No test email is sent.', fields: [{ name: 'accountId', label: 'Cloudflare account ID' }, { name: 'apiKey', label: 'Email Sending API token', secret: true }, { name: 'zoneId', label: 'Cloudflare zone ID (for connection test)' }, { name: 'fromAddress', label: 'Sender email address', type: 'email', placeholder: 'receipts@example.com' }, { name: 'fromName', label: 'Sender name (optional)' }, { name: 'replyToAddress', label: 'Reply-to email address (optional)', type: 'email', help: 'Route this address in Cloudflare to your Google Group or receiving inbox. Replies are handled there.' }] },
};
const sourceLabel = (source: string) => ({ saved: 'Saved in this app', environment: 'Server environment', mixed: 'Saved + environment', unconfigured: 'Not configured', disabled: 'Disabled in this app' }[source] || source);

export default function IntegrationSettings({ project, isOperator, canManageProject, request, onChanged }: Props) {
  const [providers, setProviders] = useState<Provider[]>([]), [drafts, setDrafts] = useState<Record<string, Record<string, string | null>>>({}), [results, setResults] = useState<Record<string, Result>>({});
  const [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [loaded, setLoaded] = useState(false), [mapsReload, setMapsReload] = useState(false);
  const [mapping, setMapping] = useState({ zernioProfileId: project.zernioProfileId || '', driveFolderId: project.driveFolderId || '', calendarId: '' }), [calendarLoaded, setCalendarLoaded] = useState(false);
  const active = useRef(true), mapContainer = useRef<HTMLDivElement>(null), mapsTested = useRef(false), cancelMapProbe = useRef<(() => void) | null>(null);
  const canMap = isOperator && canManageProject;
  async function refresh() { const data = await request('/settings/integrations'); if (active.current) { setProviders(data.providers); setLoaded(true); } }
  useEffect(() => {
    active.current = true; let current = true;
    const mapFailure = (event: Event) => { if (!mapsTested.current) return; cancelMapProbe.current?.(); setResults(items => ({ ...items, googleMaps: { ok: false, status: 'failed', message: String((event as CustomEvent).detail || 'Google Maps rejected this site.'), checkedAt: new Date().toISOString() } })); };
    window.addEventListener('ten98-maps-error', mapFailure);
    if (isOperator) request('/settings/integrations').then(data => { if (current) { setProviders(data.providers); setLoaded(true); } }).catch(err => { if (current) setError(err.message); });
    request(`/projects/${project.id}/calendar/status`).then(data => { if (current) { setMapping(items => ({ ...items, calendarId: data.calendarId || '' })); setCalendarLoaded(true); } }).catch(err => { if (current) setError(err.message); });
    return () => { current = false; active.current = false; cancelMapProbe.current?.(); window.removeEventListener('ten98-maps-error', mapFailure); };
  }, [project.id, isOperator]);
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
    if (!window.confirm(`Remove the saved ${provider.label} settings and use the server environment?${provider.id === 'googleDrive' || provider.id === 'googleCalendar' ? ' This changes both Google Drive and Calendar.' : ''}`)) return;
    await action(provider.id, async () => {
      await request(`/settings/integrations/${provider.id}`, 'DELETE'); await refresh();
      if (!active.current) return;
      setDrafts(items => ({ ...items, [provider.id]: {}, ...(provider.id === 'googleDrive' || provider.id === 'googleCalendar' ? { googleDrive: {}, googleCalendar: {} } : {}) })); setResults({});
      if (provider.id === 'googleMaps') { mapsTested.current = false; cancelMapProbe.current?.(); setMapsReload(true); }
      setNotice(`${provider.label} now uses its server environment settings.`); await onChanged?.();
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
      const google = await loadGoogleMaps(config.browserKey); if (!active.current || !mapContainer.current) return;
      setResults(items => ({ ...items, googleMaps: { ok: false, status: 'browser_loading', message: 'Loading a map preview to check this browser’s access…' } }));
      mapContainer.current.style.display = 'block';
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
  async function saveMapping(event: React.FormEvent) {
    event.preventDefault(); await action('mappings', async () => {
      await request(`/projects/${project.id}`, 'PATCH', { zernioProfileId: mapping.zernioProfileId.trim(), driveFolderId: mapping.driveFolderId.trim() });
      setNotice('Zernio profile and Drive folder mappings saved.'); setResults({}); await onChanged?.();
    });
  }
  async function saveCalendar(event: React.FormEvent) {
    event.preventDefault(); await action('calendar-mapping', async () => {
      await request(`/projects/${project.id}/calendar/connection`, 'POST', { calendarId: mapping.calendarId.trim() });
      setNotice('Project calendar mapping saved.'); setResults(items => { const next = { ...items }; delete next.googleCalendar; return next; }); await onChanged?.();
    });
  }
  function reloadMaps() { const url = new URL(window.location.href); url.searchParams.set('view', 'integrations'); url.searchParams.set('project', project.id); window.location.assign(url.href); }
  return <div className="integration-settings">
    <section className="panel integration-settings-intro"><div><h2>Credentials and project connections</h2><p>Credentials apply across this installation. Project mappings choose the brand profile, creative folder, and calendar used here.</p></div><span className="subtle-tag">{isOperator ? 'Instance operator' : 'Project access'}</span></section>
    {error && <p className="alert error" role="alert">{error}</p>}{notice && <p className="integration-notice" role="status">{notice}</p>}
    {!isOperator && <p className="alert">An instance operator can configure credentials and test provider connections. Your project mappings are shown below.</p>}
    {isOperator && !loaded && !error && <p role="status">Loading integration settings…</p>}
    <div className="integration-settings-grid">{providers.map(provider => {
      const definition = definitions[provider.id]; if (!definition) return null;
      const edits = drafts[provider.id] || {}, changed = dirty(provider), result = results[provider.id];
      return <section className="panel integration-settings-card" key={provider.id} aria-labelledby={`integration-${provider.id}`}>
        <div className="integration-settings-heading"><span className={`integration-settings-icon ${provider.id}`}>{definition.initial}</span><div><h2 id={`integration-${provider.id}`}>{provider.label}</h2><p>{definition.description}</p></div><span className={`badge ${provider.configured ? 'configured' : 'not-connected'}`}>{provider.configured ? 'Configured' : 'Not configured'}</span></div>
        <details className="integration-config"><summary>Connection settings</summary><p className="integration-source">{sourceLabel(provider.source)}{provider.updatedAt && ` · Updated ${new Date(provider.updatedAt).toLocaleString()}`}</p>
        <form onSubmit={event => save(provider, event)}><fieldset disabled={Boolean(busy)}>
          {definition.fields.map(field => {
            const secret = provider.secretFields?.[field.name], clear = edits[field.name] === null, value = clear ? '' : edits[field.name] ?? (field.secret ? '' : String(provider.fields?.[field.name] ?? ''));
            const input = { name: `${provider.id}-${field.name}`, value, placeholder: field.secret && secret?.configured ? 'Configured — leave blank to keep' : field.placeholder, maxLength: field.multiline ? 16000 : 4000, onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => change(provider.id, field.name, event.target.value), disabled: clear || Boolean(busy) };
            return <div className="integration-setting-field" key={field.name}><label className="field"><span>{field.label}{field.secret && <small>{secret?.configured ? sourceLabel(secret.source) : 'Not configured'}</small>}</span>{field.multiline ? <textarea {...input} rows={3} autoComplete="off" spellCheck={false}/> : provider.id === 'broadsign' && field.name === 'environment' ? <select {...input}><option value="sandbox">Sandbox</option><option value="production">Production</option></select> : <input {...input} type={field.secret ? 'password' : field.type || 'text'} autoComplete={field.secret ? 'new-password' : 'off'} min={field.min} max={field.max} spellCheck={false}/>}</label>{field.help && <p className="field-help">{field.help}</p>}{field.secret && <label className="integration-clear"><input type="checkbox" checked={clear} onChange={event => change(provider.id, field.name, event.target.checked ? null : '')}/>Clear this credential, including environment fallback</label>}</div>;
          })}
          <details className="integration-help"><summary>Setup instructions</summary><p className="integration-settings-help">{definition.help}</p></details>
          {provider.id === 'zernio' && <p className="integration-webhook">Webhook URL <code>{window.location.origin}/api/webhooks/zernio</code></p>}
          <div className="button-wrap"><button className="button primary" disabled={!changed}>Save settings</button><button type="button" className="button" disabled={!provider.configured || changed || (provider.id === 'googleMaps' && mapsReload)} onClick={() => test(provider)}>{busy === provider.id ? 'Working…' : 'Test connection'}</button><button type="button" className="text-link" onClick={() => reset(provider)}>Use server environment</button></div>
          {changed && <p className="field-help">Save these changes before testing.</p>}
        </fieldset></form></details>
        {provider.id === 'googleMaps' && mapsReload && <div className="integration-test-result"><p>Reload the app to apply the browser map settings before testing.</p><button className="button" type="button" onClick={reloadMaps}>Reload app</button></div>}
        {result && <div className={`integration-test-result ${result.ok ? 'success' : 'warning'}`} role="status"><strong>{result.status === 'connected' ? 'Connection verified' : result.status === 'needs_mapping' ? 'Project mapping needed' : result.status === 'browser_verification_required' ? 'Browser check required' : result.status === 'browser_loaded' ? 'Map connection verified' : 'Connection check'}</strong><p>{result.message}</p>{result.checkedAt && <small>Checked {new Date(result.checkedAt).toLocaleString()}</small>}</div>}
        {provider.id === 'googleMaps' && <div ref={mapContainer} className="integration-map-preview" role="region" aria-label="Google Maps connection preview" style={{ display: ['browser_loading', 'browser_loaded', 'failed'].includes(results.googleMaps?.status) ? 'block' : 'none' }}/>}
      </section>;
    })}</div>
    <section className="panel integration-project-mappings"><div className="panel-heading"><div><h2>This project’s connections</h2><p>Each Zernio profile and shared calendar can belong to one project. Connection tests use saved mappings; save mapping edits first.</p></div><span className="subtle-tag">Project mappings</span></div><div className="integration-mapping-grid">
      <form onSubmit={saveMapping}><fieldset disabled={!canMap || Boolean(busy)}><label className="field"><span>Zernio profile ID</span><input value={mapping.zernioProfileId} maxLength={200} onChange={event => setMapping({ ...mapping, zernioProfileId: event.target.value })} placeholder="Brand profile in Zernio"/></label><label className="field"><span>Google Drive folder ID</span><input value={mapping.driveFolderId} maxLength={200} onChange={event => setMapping({ ...mapping, driveFolderId: event.target.value })} placeholder="Shared creative folder ID"/></label><p className="field-help">Use the folder ID from its Google Drive URL. Leaving a field empty disconnects that mapping.</p>{canMap && <button className="button" type="submit">Save profile and folder</button>}</fieldset></form>
      <form onSubmit={saveCalendar}><fieldset disabled={!canMap || Boolean(busy) || !calendarLoaded}><label className="field"><span>Google Calendar ID</span><input value={mapping.calendarId} maxLength={500} onChange={event => setMapping({ ...mapping, calendarId: event.target.value })} placeholder="calendar-id@group.calendar.google.com"/></label><p className="field-help">Use a dedicated shared calendar with event editing access for the service account. Leaving this empty disconnects the calendar.</p>{canMap && <button className="button" type="submit">Save calendar mapping</button>}</fieldset></form>
    </div>{!canMap && <p className="integration-mapping-permission">An instance operator with workspace administration access can change project mappings.</p>}</section>
  </div>;
}
