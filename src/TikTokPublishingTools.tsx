import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Field, InlineCode, Inline, Input, Option, Select, StatusLine, Stack, Text } from '@ten98/ui';

export type TikTokPublishingToolsProps = {
  account: { id?: string; _id?: string; displayName?: string; username?: string; platform?: string; isActive?: boolean; needsReconnection?: boolean; [key: string]: any } | null;
  mediaItems: { type: string; [key: string]: any }[];
  options: Record<string, any>;
  disabled?: boolean;
  lookup: (accountId: string, resource: 'tiktok-commercial-music' | 'tiktok-locations', params?: Record<string, string>) => Promise<any>;
  onChange: (options: Record<string, any>) => void;
};
type Track = { id: string; commercialMusicId: string | null; name: string | null; artist: string | null; durationSec: number | null; genres: string[] | null; previewUrl: string | null; thumbnailUrl: string | null; rank: number | null; clip: { id: string; durationSec: number | null; previewUrl: string | null } | null };
type Place = { id: string; name: string; address: string | null };
const identifier = (value: any) => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\s\u0000-\u001f\u007f]/.test(value);
const nullableText = (value: any) => value === null || typeof value === 'string' && value.length <= 20000;
const duration = (value: any) => value === null || Number.isSafeInteger(value) && value >= 0;
const validTrack = (row: any): row is Track => !!row && identifier(row.id) && (row.commercialMusicId === null || identifier(row.commercialMusicId))
  && ['name', 'artist', 'previewUrl', 'thumbnailUrl'].every(key => nullableText(row[key])) && duration(row.durationSec)
  && (row.rank === null || Number.isSafeInteger(row.rank) && row.rank >= 1) && (row.genres === null || Array.isArray(row.genres) && row.genres.length <= 100 && row.genres.every((genre: any) => typeof genre === 'string' && nullableText(genre)))
  && (row.clip === null || !!row.clip && identifier(row.clip.id) && duration(row.clip.durationSec) && nullableText(row.clip.previewUrl));
const validPlace = (row: any): row is Place => !!row && identifier(row.id) && typeof row.name === 'string' && !!row.name.trim() && nullableText(row.name) && nullableText(row.address);

export default function TikTokPublishingTools({ account, mediaItems, options, disabled = false, lookup, onChange }: TikTokPublishingToolsProps) {
  const [country, setCountry] = useState(''), [query, setQuery] = useState(''), [musicId, setMusicId] = useState(''), [placeId, setPlaceId] = useState('');
  const [catalog, setCatalog] = useState<any>(null), [places, setPlaces] = useState<any>(null), [busy, setBusy] = useState<any>(null), [error, setError] = useState<any>(null), [notice, setNotice] = useState<any>(null);
  const id = account?._id || account?.id || '', label = account?.displayName || account?.username || id;
  const accountScope = JSON.stringify(account), scope = JSON.stringify([accountScope, mediaItems, options, country, query, disabled]);
  const current = useRef({ scope, lookup, onChange }), alive = useRef(true), pending = useRef<object | null>(null), reads = useRef(0), selection = useRef(0);
  if (current.current.scope !== scope || current.current.lookup !== lookup || current.current.onChange !== onChange) current.current = { scope, lookup, onChange };
  const ticket = current.current, isCurrent = () => alive.current && current.current === ticket, revision = selection.current;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const available = !!id && account?.isActive !== false && account?.needsReconnection !== true && (!account?.platform || account.platform === 'tiktok');
  const loading = busy?.ticket === ticket, tracks: Track[] | null = catalog?.ticket === ticket && catalog.revision === reads.current ? catalog.rows : null, locations: Place[] | null = places?.ticket === ticket && places.revision === reads.current ? places.rows : null;
  const music = tracks?.find(row => row.id === musicId), place = locations?.find(row => row.id === placeId);
  const eligible = mediaItems.length === 1 && mediaItems[0].type === 'video' && options.mediaType !== 'photo' && options.draft !== true;
  const canUse = available && eligible && !disabled && !loading && pending.current !== ticket;
  async function read(resource: 'tiktok-commercial-music' | 'tiktok-locations') {
    if (!isCurrent() || !available || disabled || pending.current === ticket) return;
    if (resource === 'tiktok-commercial-music' && country && !/^[A-Za-z]{2}$/.test(country) || resource === 'tiktok-locations' && (!query.trim() || query.trim().length > 100 || /[\u0000-\u001f\u007f]/.test(query))) { setError({ ticket, message: 'Use a two-letter country code or a place search of 1–100 characters. Your draft is unchanged.' }); return; }
    const readRevision = ++reads.current; selection.current++; pending.current = ticket; setBusy({ ticket }); setError(null); setNotice(null);
    if (resource === 'tiktok-commercial-music') { setCatalog(null); setMusicId(''); } else { setPlaces(null); setPlaceId(''); }
    try {
      const params: Record<string, string> | undefined = resource === 'tiktok-commercial-music' ? country ? { countryCode: country.toUpperCase() } : undefined : { query: query.trim() };
      const result = await lookup(id, resource, params);
      if (!isCurrent() || readRevision !== reads.current) return;
      if (!result || result.accountId !== id || result.platform !== 'tiktok') throw new Error('The TikTok account response could not be verified.');
      if (resource === 'tiktok-commercial-music') {
        if (!Array.isArray(result.tracks) || result.tracks.length > 100 || !result.tracks.every(validTrack) || new Set(result.tracks.map((row: Track) => row.id)).size !== result.tracks.length) throw new Error('The TikTok music results could not be verified.');
        setCatalog({ ticket, revision: readRevision, rows: result.tracks });
      } else {
        if (!Array.isArray(result.locations) || result.locations.length > 20 || !result.locations.every(validPlace) || new Set(result.locations.map((row: Place) => row.id)).size !== result.locations.length) throw new Error('The TikTok location results could not be verified.');
        setPlaces({ ticket, revision: readRevision, rows: result.locations });
      }
    } catch (failure) { if (isCurrent() && readRevision === reads.current) setError({ ticket, message: `${(failure as Error).message || 'TikTok could not be read.'} These tools require a connection through the TikTok for Business app. Your draft is unchanged.` }); }
    finally { if (pending.current === ticket) pending.current = null; if (isCurrent()) setBusy(null); }
  }
  function useChoice(kind: 'music' | 'location') {
    if (!isCurrent() || !canUse || revision !== selection.current || pending.current === ticket) return;
    if (kind === 'music' && (!music || catalog.revision !== reads.current) || kind === 'location' && (!place || places.revision !== reads.current)) return;
    current.current = { ...ticket };
    const next = kind === 'music' ? { ...options, musicSoundInfo: { ...options.musicSoundInfo, musicSoundId: music!.clip?.id || music!.id } } : { ...options, locationId: place!.id, locationName: place!.name };
    onChange(next); setNotice({ accountScope, message: `${kind === 'music' ? 'Music' : 'Location'} added to ${label} (${id}). Review and save the draft separately.` });
  }
  return <Card as="section" title="TikTok publishing tools" headingLevel={4} aria-label="TikTok publishing tools"><Stack gap={3}>
    {!id ? <Text tone="muted" size="sm">Choose one TikTok account to read its publishing tools.</Text> : <>
      <Text tone="muted" size="sm">Account: {label} · {id}</Text>
      {!available && <Text tone="muted" size="sm">Choose an active TikTok account and reconnect it if required.</Text>}
      <Text tone="muted" size="sm">These tools require a connection through the TikTok for Business app. An account’s business category does not confirm that connection. Read the provider results to check availability.</Text>
      <Field label="Music chart country code (optional)"><Input value={country} maxLength={2} disabled={disabled || !available} onChange={event => { if (isCurrent() && !disabled) setCountry(event.target.value); }}/></Field>
      <Inline><Button variant="secondary" disabled={disabled || !available || loading || !!country && !/^[A-Za-z]{2}$/.test(country)} onClick={() => read('tiktok-commercial-music')}>Read commercial music</Button></Inline>
      <Text tone="muted" size="sm">Leave the country empty for TikTok’s global chart. The chart has no next page.</Text>
      {tracks && (!tracks.length ? <Text>No commercial music returned for this chart.</Text> : <Field label="Commercial music track"><Select value={musicId} disabled={disabled || loading} onChange={event => { if (isCurrent() && !disabled && pending.current !== ticket) { selection.current++; setMusicId(event.target.value); } }}><Option value="">Choose a track</Option>{tracks.map(row => <Option key={row.id} value={row.id}>{row.name ?? row.id} · {row.artist ?? 'Artist not reported'}</Option>)}</Select></Field>)}
      {music && <Stack gap={1}><Text>{music.name ?? 'Name not reported'} · {music.artist ?? 'Artist not reported'} · Chart rank: {music.rank ?? 'Not reported'}</Text><Text>Track ID: {music.id} · Commercial music ID (reference only): {music.commercialMusicId ?? 'Not reported'}</Text><Text>Track duration: {music.durationSec === null ? 'Not reported' : `${music.durationSec} seconds`} · Genres: {music.genres?.join(', ') || 'Not reported'}</Text><Text>Selected sound ID: {music.clip?.id || music.id} · {music.clip ? 'Trending clip' : 'Full track fallback; viewers may find the sound unavailable in their country.'}</Text><Text>Clip duration: {music.clip?.durationSec == null ? 'Not reported' : `${music.clip.durationSec} seconds`}</Text><Text>Track preview URL: <InlineCode>{music.previewUrl ?? 'Not reported'}</InlineCode></Text><Text>Clip preview URL: <InlineCode>{music.clip?.previewUrl ?? 'Not reported'}</InlineCode></Text><Text>Thumbnail URL: <InlineCode>{music.thumbnailUrl ?? 'Not reported'}</InlineCode></Text></Stack>}
      <Inline><Button disabled={!canUse || !music} onClick={() => useChoice('music')}>Use this music for this account</Button></Inline>
      <Field label="TikTok place search"><Input value={query} maxLength={100} disabled={disabled || !available} onChange={event => { if (isCurrent() && !disabled) setQuery(event.target.value); }}/></Field>
      <Inline><Button variant="secondary" disabled={disabled || !available || loading || !query.trim() || query.trim().length > 100} onClick={() => read('tiktok-locations')}>Search TikTok locations</Button></Inline>
      {locations && (!locations.length ? <Text>No location tags returned for this search.</Text> : <Field label="TikTok location tag"><Select value={placeId} disabled={disabled || loading} onChange={event => { if (isCurrent() && !disabled && pending.current !== ticket) { selection.current++; setPlaceId(event.target.value); } }}><Option value="">Choose a location</Option>{locations.map(row => <Option key={row.id} value={row.id}>{row.name} · {row.address ?? 'Address not reported'} · {row.id}</Option>)}</Select></Field>)}
      {place && <Text>Location ID: {place.id} · Name: {place.name} · Address: {place.address ?? 'Not reported'}</Text>}
      <Inline><Button disabled={!canUse || !place} onClick={() => useChoice('location')}>Use this location for this account</Button></Inline>
      <Text tone="muted" size="sm">TikTok returns up to 20 closest or fuzzy matches. An unrelated or empty result does not establish that a place is missing. Review the exact name and address before Use.</Text>
      {!eligible && <Text tone="muted" size="sm">Using music or a location here requires one video, a video media type and direct posting. Creator Inbox drafts ignore these fields.</Text>}
    </>}
    {loading && <StatusLine busy>Reading TikTok…</StatusLine>}{error?.ticket === ticket && <Alert tone="danger">{error.message}</Alert>}{notice?.accountScope === accountScope && <StatusLine>{notice.message}</StatusLine>}
    <Text tone="muted" size="sm">Only Use changes this account’s draft. Music Use preserves existing volume and timing settings; location Use preserves other options. Discovery does not guarantee music rights, regional availability or publication. URLs are shown as text.</Text>
  </Stack></Card>;
}
