import { useEffect, useRef, useState } from 'react';
import { Alert, Card, EmbedHost, EmptyState, SelectableList, Stack, Text } from '@ten98/ui';

type Location = { id: string; name: string; location?: string; latitude?: number | null; longitude?: number | null; status?: string; sample?: boolean; locationSource?: string };
type Props = { locations: Location[]; request: (path: string, method?: string, body?: unknown) => Promise<any>; projectId: string; onSelect: (item: Location) => void };
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
export default function OohMap({ locations, request, projectId, onSelect }: Props) {
  const container = useRef<HTMLDivElement>(null), mapRef = useRef<any>(null), markers = useRef<any[]>([]), select = useRef(onSelect);
  select.current = onSelect;
  const [config, setConfig] = useState<any>(null), [error, setError] = useState(''), [ready, setReady] = useState(false);
  const located = locations.filter(row => typeof row.latitude === 'number' && Number.isFinite(row.latitude) && Math.abs(row.latitude) <= 90 && typeof row.longitude === 'number' && Number.isFinite(row.longitude) && Math.abs(row.longitude) <= 180);
  useEffect(() => {
    let active = true; setConfig(null); setError(''); setReady(false);
    const authError = (event: Event) => { if (active) setError((event as CustomEvent<string>).detail); };
    window.addEventListener('ten98-maps-error', authError);
    request(`/projects/${projectId}/maps/config`).then(async value => {
      if (!active) return; setConfig(value); if (!value.configured) return;
      const google = await loadGoogleMaps(value.browserKey); if (!active || !container.current) return;
      mapRef.current = new google.Map(container.current, { center: { lat: 25.2048, lng: 55.2708 }, zoom: 10, mapId: value.mapId || 'DEMO_MAP_ID', streetViewControl: false, mapTypeControl: true, fullscreenControl: true });
      setReady(true);
    }).catch(err => { if (active) setError(err.message); });
    return () => { active = false; window.removeEventListener('ten98-maps-error', authError); markers.current.forEach(marker => { marker.map = null; }); markers.current = []; mapRef.current = null; };
  }, [projectId]);
  useEffect(() => {
    if (!ready || !mapRef.current) return;
    markers.current.forEach(marker => { marker.map = null; }); markers.current = [];
    const google = window.google!.maps, bounds = new google.LatLngBounds();
    for (const location of located) {
      const position = { lat: location.latitude, lng: location.longitude };
      const pin = new google.marker.PinElement({ background: location.status === 'live' ? '#258268' : '#5943ce', borderColor: '#fff', glyphColor: '#fff' });
      const marker = new google.marker.AdvancedMarkerElement({ map: mapRef.current, position, title: `${location.name}${location.sample ? ' (sample)' : ''}`, content: pin.element });
      marker.addListener('click', () => select.current(location)); markers.current.push(marker); bounds.extend(position);
    }
    if (located.length > 1) mapRef.current.fitBounds(bounds, 60);
    else if (located.length === 1) { mapRef.current.setCenter({ lat: located[0].latitude, lng: located[0].longitude }); mapRef.current.setZoom(14); }
  }, [locations, ready]);
  return <Card as="section" headingLevel={2} title="OOH locations" description={`${located.length} mapped locations · ${locations.length - located.length} still need coordinates`} actions={<Text tone="muted" size="sm">Google Maps</Text>}><Stack gap={3}>
    {error && <Alert tone="danger">{error}</Alert>}
    {/* Google Maps mounts into the host's ref; without a browser key the host shows the empty state instead. */}
    <EmbedHost ref={container} label="Google map of outdoor advertising locations" size="lg" narrowSize="md" busy={!ready && !error && config?.configured !== false} loadingLabel="Loading map…" fallback={config && !config.configured ? <EmptyState icon="pin" title="Put your placements on the map" description="Your instance administrator can enable Google Maps with a browser API key. Add coordinates to each booking to show its location."/> : undefined}/>
    {located.length > 0 && <SelectableList label="Mapped locations" onSelect={id => { const location = located.find(row => row.id === id); if (location) onSelect(location); }} items={located.map(location => ({ id: location.id, title: location.name, preview: (location.location || `${location.latitude}, ${location.longitude}`) + (location.sample ? ' · Sample' : location.locationSource === 'provider' ? ' · Provider coordinates' : ' · Team-entered location'), status: location.status === 'live' ? 'Live' : undefined }))}/>}
  </Stack></Card>;
}
