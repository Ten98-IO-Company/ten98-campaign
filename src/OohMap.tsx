import { useEffect, useRef, useState } from 'react';
import { Badge, Button, DataTable, DateRangeField, Disclosure, EmbedHost, EmptyState, Field, Fieldset, FormGrid, Grid, Inline, Input, Link, MetricCard, MetricGrid, Option, Select, Stack, Text, Textarea, type Tone } from '@ten98/ui';

type Location = { id: string; name: string; location?: string; latitude?: number | null; longitude?: number | null; status?: string; sample?: boolean; locationSource?: string };
type Placement = { id: string; name?: string; location?: string; latitude?: number | null; longitude?: number | null; status?: string; type?: string; source?: string; providerId?: string; campaignId?: string; startDate?: string; endDate?: string; cost?: number | null; currency?: string | null; proofUrl?: string; notes?: string };
type Named = { id: string; name?: string };
type Props = {
  projectId: string; request: (path: string, method?: string, body?: unknown) => Promise<any>;
  /** Map pins: bookings plus synced provider screens. */
  locations: Location[];
  /** Every booking, for the stats; `visible` is the search-filtered list. */
  placements: Placement[]; visible: Placement[]; partners: Named[];
  canWrite: boolean; canManageMaps: boolean;
  formatCost: (value: unknown, currency?: string) => string; formatDate: (value: string) => string;
  onSelect: (item: Location) => void; onOpen: (placement: Placement) => void;
};
const formats = [['billboard', 'Billboard'], ['digital', 'Digital'], ['transit', 'Transit'], ['street', 'Street']];
const statuses: [string, string, Tone][] = [['draft', 'Draft', 'neutral'], ['requested', 'Requested', 'warning'], ['booked', 'Booked', 'info'], ['live', 'Live', 'success'], ['completed', 'Completed', 'neutral'], ['cancelled', 'Cancelled', 'danger']];
const currencies = ['AED', 'USD', 'EUR', 'GBP'];
function StatusBadge({ status = 'draft' }: { status?: string }) {
  const [, label, tone] = statuses.find(([value]) => value === status) || [status, status, 'neutral'];
  return <Badge tone={tone} dot>{label}</Badge>;
}
declare global { interface Window { google?: any; __ten98MapsReady?: () => void; gm_authFailure?: () => void } }
let loader: Promise<any> | undefined, loadedKey = '', authenticationError = '';
export function loadGoogleMaps(key: string) {
  if (authenticationError) return Promise.reject(new Error(authenticationError));
  if (loadedKey && loadedKey !== key) return Promise.reject(new Error('Reload this page to use the updated Google Maps key.'));
  if (loader) return loader;
  loadedKey = key;
  if (!loader) loader = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    const timer = setTimeout(() => reject(new Error('Google Maps did not load. Check the key restrictions and Maps JavaScript API configuration.')), 20000);
    window.__ten98MapsReady = () => { clearTimeout(timer); resolve(window.google.maps); };
    window.gm_authFailure = () => { const message = 'Google Maps could not authorize this site. Check billing and HTTP referrer restrictions, then reload the page.'; authenticationError = message; window.dispatchEvent(new CustomEvent('ten98-maps-error', { detail: message })); clearTimeout(timer); reject(new Error(message)); };
    script.onerror = () => { clearTimeout(timer); reject(new Error('The map could not load. Check your connection.')); };
    script.src = 'https://maps.googleapis.com/maps/api/js?' + new URLSearchParams({ key, v: 'quarterly', loading: 'async', libraries: 'marker', callback: '__ten98MapsReady', auth_referrer_policy: 'origin' });
    script.nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce || ''; script.async = true; script.referrerPolicy = 'strict-origin-when-cross-origin'; document.head.append(script);
  }).catch(error => { loader = undefined; throw error; });
  return loader;
}
export default function OohMap({ projectId, request, locations, placements, visible, partners, canWrite, canManageMaps, formatCost, formatDate, onSelect, onOpen }: Props) {
  const container = useRef<HTMLDivElement>(null), mapRef = useRef<any>(null), markers = useRef<any[]>([]), select = useRef(onSelect);
  select.current = onSelect;
  const [config, setConfig] = useState<any>(null), [error, setError] = useState(''), [ready, setReady] = useState(false);
  const [activeId, setActiveId] = useState('');
  const located = locations.filter(row => typeof row.latitude === 'number' && Number.isFinite(row.latitude) && Math.abs(row.latitude) <= 90 && typeof row.longitude === 'number' && Number.isFinite(row.longitude) && Math.abs(row.longitude) <= 180);
  // A missing or failing map is left out entirely; the list carries the page.
  const mapShown = Boolean(config?.configured) && !error;
  useEffect(() => {
    let active = true; setConfig(null); setError(''); setReady(false);
    const authError = (event: Event) => { if (active) setError((event as CustomEvent<string>).detail); };
    window.addEventListener('ten98-maps-error', authError);
    request(`/projects/${projectId}/maps/config`).then(value => { if (active) setConfig(value); }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; window.removeEventListener('ten98-maps-error', authError); markers.current.forEach(marker => { marker.map = null; }); markers.current = []; mapRef.current = null; };
  }, [projectId]);
  // The map host mounts only once Maps is configured, so the SDK starts in the effect after that render.
  useEffect(() => {
    if (!config?.configured) return;
    let active = true;
    loadGoogleMaps(config.browserKey).then(google => {
      if (!active || !container.current) return;
      mapRef.current = new google.Map(container.current, { center: { lat: 25.2048, lng: 55.2708 }, zoom: 10, mapId: config.mapId || 'DEMO_MAP_ID', streetViewControl: false, mapTypeControl: true, fullscreenControl: true });
      setReady(true);
    }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; };
  }, [config]);
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    markers.current.forEach(marker => { marker.map = null; }); markers.current = [];
    const google = window.google!.maps, bounds = new google.LatLngBounds();
    for (const location of located) {
      const position = { lat: location.latitude, lng: location.longitude };
      const pin = new google.marker.PinElement({ background: location.status === 'live' ? '#258268' : '#5943ce', borderColor: '#fff', glyphColor: '#fff' });
      const marker = new google.marker.AdvancedMarkerElement({ map: mapRef.current, position, title: `${location.name}${location.sample ? ' (sample)' : ''}`, content: pin.element });
      marker.addListener('click', () => { setActiveId(location.id); select.current(location); }); markers.current.push(marker); bounds.extend(position);
    }
    if (located.length > 1) mapRef.current.fitBounds(bounds, 60);
    else if (located.length === 1) { mapRef.current.setCenter({ lat: located[0].latitude, lng: located[0].longitude }); mapRef.current.setZoom(14); }
  }, [locations, ready]);
  const editable = (placement: Placement) => canWrite && placement.source !== 'broadsign';
  const partnerName = (id?: string) => partners.find(partner => partner.id === id)?.name;
  const list = <DataTable ariaLabel="OOH bookings" rows={visible} rowKey={placement => placement.id} searchable={false} sortable={false} pagination={false} responsive="stack"
    activeKey={activeId || undefined} onRowActivate={placement => onOpen(placement)} columns={[
      { key: 'placement', header: 'Placement', rowHeader: true, wrap: true, render: placement => <Stack gap={1}><Text weight="semibold">{placement.name}</Text><Text size="sm" tone="muted">{[formats.find(([value]) => value === placement.type)?.[1] || 'Billboard', partnerName(placement.providerId), placement.location || 'Location not set'].filter(Boolean).join(' · ')}</Text></Stack> },
      { key: 'dates', header: 'Dates', render: placement => `${formatDate(placement.startDate || '')} – ${formatDate(placement.endDate || '')}` },
      { key: 'status', header: 'Status', render: placement => <StatusBadge status={placement.status}/> },
      { key: 'cost', header: 'Cost', numeric: true, render: placement => placement.cost == null ? 'Not reported' : formatCost(placement.cost, placement.currency || 'AED') }]}
    rowActionsLabel="Actions" rowActions={placement => <Inline gap={2}>
      <Button variant="secondary" size="sm" aria-label={(editable(placement) ? 'Edit booking for ' : 'View booking for ') + placement.name} onClick={() => onOpen(placement)}>{editable(placement) ? 'Edit booking' : 'View booking'}</Button>
      {placement.proofUrl && <Link href={placement.proofUrl} target="_blank" rel="noreferrer" aria-label={'Proof of display for ' + placement.name}>Proof</Link>}
    </Inline>}
    emptyState={<EmptyState icon="billboard" title={placements.length ? 'No placements match this search' : 'No OOH placements'} description={placements.length ? 'Try another location, provider, or placement name.' : 'Add a billboard, digital screen, or transit booking to your campaign.'}/>}/>;
  return <Stack gap={5}>
    <MetricGrid list label="OOH summary">
      <MetricCard label="Live placements" value={String(placements.filter(placement => placement.status === 'live').length)} hint="Currently on display"/>
      <MetricCard label="Media partners" value={String(partners.length)} hint="In this project"/>
      <MetricCard label="Locations" value={String(new Set(placements.map(placement => placement.location)).size)} hint="Distinct booking locations"/>
    </MetricGrid>
    {mapShown ? <Grid columns={2} gap={4} align="start">{list}<Stack gap={2}>
      <EmbedHost ref={container} label="Google map of OOH bookings" size="lg" narrowSize="md" busy={!ready} loadingLabel="Loading map…"/>
      <Text size="sm" tone="muted">{`${located.length} on map · ${locations.length - located.length} not on map`}</Text>
    </Stack></Grid> : list}
    {/* Only whoever can configure Maps is told why it is missing; everyone else sees the list alone. */}
    {canManageMaps && (error || config?.configured === false) && <Text size="sm" tone="muted">{error || 'Google Maps is off. Add a browser API key under Integrations › Google Maps to show bookings on a map.'}</Text>}
  </Stack>;
}
/** Grouped booking editor fields. The host form submits them by name, so each name is the placement record field. */
// defaultCampaignId preselects the campaign for a new booking started from a campaign page.
export function BookingFields({ item, partners, campaigns, defaultCampaignId }: { item?: Placement | null; partners: Named[]; campaigns: Named[]; defaultCampaignId?: string }) {
  const [dates, setDates] = useState({ start: item?.startDate?.slice(0, 10) || '', end: item?.endDate?.slice(0, 10) || '' });
  return <Stack gap={4}>
    <Fieldset legend="Placement">
      <Field label="Placement name" required><Input name="name" defaultValue={item?.name} placeholder="Sheikh Zayed Road · Digital screen" required/></Field>
      <FormGrid>
        <Field label="Format"><Select name="type" defaultValue={item?.type || 'billboard'}>{formats.map(([value, label]) => <Option key={value} value={value}>{label}</Option>)}</Select></Field>
        <Field label="Media partner"><Select name="providerId" defaultValue={item?.providerId || ''}><Option value="">No partner</Option>{partners.map(partner => <Option key={partner.id} value={partner.id}>{partner.name}</Option>)}</Select></Field>
      </FormGrid>
    </Fieldset>
    <Fieldset legend="Where">
      <Field label="Location" required><Input name="location" defaultValue={item?.location} required/></Field>
      <Disclosure variant="plain" summary="Set exact position" defaultOpen={item?.latitude != null || item?.longitude != null}><Stack gap={2}>
        <FormGrid>
          <Field label="Latitude"><Input name="latitude" type="number" min="-90" max="90" step="any" defaultValue={item?.latitude ?? ''}/></Field>
          <Field label="Longitude"><Input name="longitude" type="number" min="-180" max="180" step="any" defaultValue={item?.longitude ?? ''}/></Field>
        </FormGrid>
        <Text tone="muted" size="sm">Add both coordinates to show this booking on the map. Provider inventory keeps its supplied coordinates.</Text>
      </Stack></Disclosure>
    </Fieldset>
    <Fieldset legend="When & cost">
      {/* The range field is controlled; the hidden inputs carry its value into the host form. */}
      <DateRangeField label="Booking dates" start={dates.start} end={dates.end} onChange={range => setDates(range)}/>
      <Input type="hidden" name="startDate" value={dates.start} readOnly/><Input type="hidden" name="endDate" value={dates.end} readOnly/>
      <FormGrid>
        <Field label="Cost" required><Input name="cost" type="number" min="0" step="0.01" required defaultValue={item?.source === 'broadsign' ? item?.cost ?? '' : item?.cost || 0}/></Field>
        <Field label="Currency"><Select name="currency" defaultValue={item?.currency || 'AED'}>{currencies.map(code => <Option key={code} value={code}>{code}</Option>)}</Select></Field>
      </FormGrid>
    </Fieldset>
    <Fieldset legend="Campaign & status">
      <FormGrid>
        <Field label="Campaign"><Select name="campaignId" defaultValue={item?.campaignId || defaultCampaignId || ''}><Option value="">No campaign</Option>{campaigns.map(campaign => <Option key={campaign.id} value={campaign.id}>{campaign.name}</Option>)}</Select></Field>
        {item && <Field label="Booking status"><Select name="status" defaultValue={item.status || 'draft'}>{statuses.map(([value, label]) => <Option key={value} value={value}>{label}</Option>)}</Select></Field>}
      </FormGrid>
      {!item && <><Input type="hidden" name="status" value="draft" readOnly/><Text tone="muted" size="sm">New bookings start as Draft. Change the status once the partner confirms.</Text></>}
    </Fieldset>
    <Disclosure summary="More" defaultOpen={Boolean(item?.proofUrl || item?.notes)}><Stack gap={3}>
      <Field label="Proof of display URL"><Input name="proofUrl" type="url" defaultValue={item?.proofUrl || ''} placeholder="https://drive.google.com/…"/></Field>
      <Field label="Booking notes"><Textarea name="notes" defaultValue={item?.notes}/></Field>
    </Stack></Disclosure>
  </Stack>;
}
