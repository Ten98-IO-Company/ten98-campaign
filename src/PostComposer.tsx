import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Alert, Badge, Button, Checkbox, CheckboxGroup, ContentPreview, DateTimeField, DestinationPicker, Disclosure, Field, Fieldset, Form, FormActions, FormGrid, Grid, Heading, Image as MediaImage, Inline, Input, List, ListItem, MediaPlayer, MediaStrip, Option, ReviewConfirm, SegmentedControl, Select, Stack, StatusLine, Tabs, Text, Textarea, ValidationSummary, VisuallyHidden, type MediaItem as StripItem, type ValidationMessage } from '@ten98/ui';
import { PLATFORM_RULES, captionLimitForVariant, countCaption, normalizePostVariants, normalizePostTags, normalizeAccountVariants, publicMediaUrl, resolveVariant, validatePostForPlatforms, providerPostMediaUrls } from '../shared/social-posts.ts';
import InstagramPublishingTools from './InstagramPublishingTools';
import TikTokPublishingTools from './TikTokPublishingTools';

type Row = { id: string; [key: string]: any };
type MediaItem = { type: 'image' | 'video' | 'gif' | 'document'; url: string; [key: string]: any };
type Override = { content?: string; mediaItems?: MediaItem[]; assetId?: string; options?: Record<string, any> };
type AccountOverride = Override & { platform: string; scheduledAt?: string };
type Props = {
  post?: Row; assets?: Row[]; campaigns?: Row[]; accounts?: Row[]; canWrite: boolean;
  onSubmit: (values: Record<string, any>) => Promise<any>; onCancel?: () => void; onDelete?: () => void;
  onValidate?: (values: Record<string, any>) => Promise<any>;
  onLoadAccounts?: () => Promise<any>; onInspectMedia?: (item: MediaItem) => Promise<any>; providerPost?: boolean;
  onTikTokInfo?: (accountId: string, mediaType: 'video' | 'photo') => Promise<any>;
  onLookupDestinations?: (accountId: string, resource: string, params?: Record<string, string>) => Promise<any>;
  onLoadQueues?: () => Promise<any>;
  onLoadGroups?: () => Promise<any>;
  onShortenLinks?: (values: Record<string, any>) => Promise<{ content: string; platformOverrides: Record<string, any>; accountOverrides?: Record<string, any> }>;
  busy?: boolean; readOnly?: boolean; initialScheduledAt?: string;
  /** Element (the editor Dialog's footer) the actions render into; without it they follow the form. */
  actionsHost?: HTMLElement | null;
};
const own = Object.hasOwn;
const localTime = (value = '') => value && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
const accountId = (account: Row) => String(account._id || account.id);
export const accountLabel = (account: Row) => account.displayName || account.username || account.name || accountId(account);
const browserTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
// Quick schedule presets ported from zernio-dev/latewiz@28dd018063b955769de11f881acd03bb64c61cd4 src/app/dashboard/compose/_components/schedule-picker.tsx:91-137 (MIT).
// Like the datetime-local input, they are wall-clock times in the browser's time zone; next Monday is never today.
const schedulePresets = [{ key: 'tomorrow-9', label: 'Tomorrow 9 AM' }, { key: 'tomorrow-18', label: 'Tomorrow 6 PM' }, { key: 'monday-9', label: 'Next Monday 9 AM' }];
function presetTime(preset: string, now = new Date()) {
  const date = new Date(now);
  date.setDate(date.getDate() + (preset === 'monday-9' ? (8 - date.getDay()) % 7 || 7 : 1));
  date.setHours(preset === 'tomorrow-18' ? 18 : 9, 0, 0, 0);
  return localTime(date.toISOString());
}
// The "Next slot" hint follows zernio-dev/latewiz@28dd018063b955769de11f881acd03bb64c61cd4 src/app/dashboard/compose/_components/schedule-picker.tsx:39,55-61 (MIT).
// latewiz asks the provider; this reads only the loaded weekly slots, so it cannot know which slots other posts already hold.
function nextQueueSlot(slots: { dayOfWeek: number; time: string }[], timeZone: string, now = new Date()) {
  const week = 7 * 1440, base = new Date(Math.floor(now.getTime() / 60000) * 60000);
  let clock: Intl.DateTimeFormat;
  try { clock = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }); } catch { return null; }
  const wall = (date: Date) => { const parts = Object.fromEntries(clock.formatToParts(date).map(part => [part.type, part.value])); return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday) * 1440 + Number(parts.hour) * 60 + Number(parts.minute); };
  let best: Date | null = null;
  for (const slot of slots) {
    const [hour, minute] = String(slot.time).split(':').map(Number), target = slot.dayOfWeek * 1440 + hour * 60 + minute;
    if (!Number.isInteger(slot.dayOfWeek) || slot.dayOfWeek < 0 || slot.dayOfWeek > 6 || !Number.isInteger(hour) || !Number.isInteger(minute) || hour > 23 || minute > 59) continue;
    let candidate = new Date(base.getTime() + ((target - wall(base) + week) % week || week) * 60000);
    // A daylight-saving change inside the week moves the wall clock; shift back onto the slot's own time.
    const drift = (target - wall(candidate) + week * 1.5) % week - week / 2;
    if (drift) candidate = new Date(candidate.getTime() + drift * 60000);
    // A slot inside a spring-forward gap has no wall time; show the same offset after the gap after the gap (02:30 becomes 03:30).
    if (wall(candidate) !== target) candidate = new Date(candidate.getTime() + ((target - wall(candidate) + week) % week) * 60000);
    if (!best || candidate < best) best = candidate;
  }
  return best;
}
const issueMessages = (errors: { message: string }[], warnings: { message: string }[]): ValidationMessage[] => [...errors.map((item, index) => ({ id: 'error' + index, text: item.message })), ...warnings.map((item, index) => ({ id: 'warning' + index, text: 'To verify: ' + item.message }))];
function AccountGroupPicker({ load, onChoose, disabled }: { load: NonNullable<Props['onLoadGroups']>; onChoose: (members: Row[], directory: Row[]) => void; disabled: boolean }) {
  const [data, setData] = useState<any>(null), [selectedId, setSelectedId] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const active = useRef(true), generation = useRef(0), pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++; }; }, []);
  async function refresh() {
    if (disabled || pending.current) return; const read = ++generation.current; pending.current = true; setBusy(true); setError('');
    try {
      const response = await load(); if (!active.current || read !== generation.current) return;
      if (!Array.isArray(response.groups) || !Array.isArray(response.accounts) || response.groups.some((row: any) => typeof row._id !== 'string' || typeof row.name !== 'string' || !Array.isArray(row.accountIds) || row.accountIds.some((id: any) => typeof id !== 'string')) || response.accounts.some((row: any) => typeof row._id !== 'string' || typeof row.platform !== 'string')) throw new Error('The project account groups could not be read.');
      setData(response); setSelectedId(''); setNotice('');
    } catch (failure) { if (active.current && read === generation.current) setError((failure as Error).message || 'Account groups could not be loaded.'); }
    finally { pending.current = false; if (active.current && read === generation.current) setBusy(false); }
  }
  const group = data?.groups.find((row: any) => row._id === selectedId), members: Row[] = (group?.accountIds || []).map((id: string) => data.accounts.find((row: Row) => accountId(row) === id) || { id, unavailable: true }), problems = members.filter(row => row.unavailable || row.isActive === false || !PLATFORM_RULES[row.platform]?.supported);
  const oversized = members.length > 50, canChoose = !!group && members.length > 0 && !oversized && !problems.length;
  function choose() {
    if (disabled || busy || !canChoose) return;
    onChoose(members.map(row => ({ ...row })), data.accounts.map((row: Row) => ({ ...row })));
    setNotice(`Copied ${members.length} account${members.length === 1 ? '' : 's'} from ${group.name}. Later group changes will not change this draft’s recipients.`);
  }
  return <Stack as="section" gap={3}>
    <Heading level={4} size="sm">Choose recipients from an account group</Heading>
    <Inline><Button variant="secondary" disabled={disabled || busy} onClick={refresh}>{busy ? 'Loading account groups…' : 'Load account groups'}</Button></Inline>
    {data && <Field label="Project account group"><Select disabled={disabled || busy} value={selectedId} onChange={event => { setSelectedId(event.target.value); setNotice(''); }}><Option value="">Choose a group</Option>{data.groups.map((row: any) => <Option key={row._id} value={row._id}>{row.name} · {row.accountIds.length} accounts</Option>)}</Select></Field>}
    {data && !data.groups.length && <Text tone="muted">No account groups belong entirely to this project.</Text>}
    {group && <ReviewConfirm title={`Accounts in ${group.name}`} reviewKey={selectedId} acknowledgements={[]} confirmLabel="Replace destinations with these accounts" onConfirm={choose} busy={busy} disabledReason={!canChoose ? members.length ? 'Resolve the listed problems or choose individual accounts.' : 'This group has no accounts.' : disabled ? 'Destinations cannot be changed right now.' : undefined}>
      <List>{members.map(row => <ListItem key={accountId(row)}>{accountLabel(row)} · {accountId(row)} · {PLATFORM_RULES[row.platform]?.label || row.platform || 'Unknown platform'}{row.unavailable ? ' · Unavailable in this project' : row.isActive === false ? ' · Reconnection required' : !PLATFORM_RULES[row.platform]?.supported ? ' · Social publishing unavailable' : ''}</ListItem>)}</List>
      {oversized && <Alert tone="danger" variant="inline">A post can select up to 50 accounts. Edit this group or choose individual accounts.</Alert>}
      {!!problems.length && <Alert tone="danger" variant="inline">This group includes unavailable, disconnected or non-publishing accounts. Resolve every listed member or choose individual accounts; no members will be silently skipped.</Alert>}
    </ReviewConfirm>}
    {error && <Alert tone="danger">{error}</Alert>}{notice && <StatusLine tone="success">{notice}</StatusLine>}
    <Text tone="muted" size="sm">Review the accounts above before choosing. This copies their IDs into the draft; saving, review and publishing remain separate actions.</Text>
  </Stack>;
}
function previewUrl(value: string) {
  try { return publicMediaUrl(value); } catch { return ''; }
}

const destinationFields: Record<string, string[]> = { pinterest: ['boardId'], youtube: ['playlistId'], reddit: ['subreddit', 'flairId'], googlebusiness: ['locationId'] };
function PublishingDestinations({ platform, accounts, options, lookup, onChange, disabled = false }: { platform: string; accounts: Row[]; options: Record<string, any>; lookup: NonNullable<Props['onLookupDestinations']>; onChange: (options: Record<string, any>) => void; disabled?: boolean }) {
  const [sourceId, setSourceId] = useState(''), [data, setData] = useState<Record<string, any>>({}), [busy, setBusy] = useState(''), [error, setError] = useState(''), [search, setSearch] = useState('');
  const source = accounts.find(account => accountId(account) === sourceId) || (accounts.length === 1 ? accounts[0] : null), sourceAccount = source ? accountId(source) : '';
  const business = platform === 'googlebusiness', locationBlocked = business && accounts.length !== 1;
  const subreddit = String(options.subreddit || '').replace(/^r\//i, ''), scope = JSON.stringify([platform, sourceAccount, subreddit, business ? search : '', accounts.map(account => [accountId(account), account.isActive, account.needsReconnection]), disabled]), current = useRef(scope), generation = useRef(0), active = useRef(true), pending = useRef(false), requester = useRef(lookup);
  if (current.current !== scope) { current.current = scope; generation.current++; } requester.current = lookup;
  useEffect(() => { active.current = true; return () => { active.current = false; generation.current++; }; }, []);
  useEffect(() => { setData(previous => platform === 'reddit' && previous.account === sourceAccount ? { account: sourceAccount, subreddits: previous.subreddits, defaultSubreddit: previous.defaultSubreddit } : {}); setError(''); setBusy(''); pending.current = false; }, [scope]);
  async function load(resource: string) {
    if (disabled || !active.current || locationBlocked || !sourceAccount || source?.isActive === false || source?.needsReconnection || pending.current || resource === 'reddit-details' && !/^[A-Za-z0-9_]{1,21}$/.test(subreddit)) return;
    if (business && search.trim().length > 200) { setError('Search location names with at most 200 characters.'); return; }
    const read = generation.current, request = requester.current, fresh = () => active.current && read === generation.current; pending.current = true; setBusy(resource); setError('');
    try {
      const result = resource === 'reddit-details' ? await Promise.all(['reddit-rules', 'reddit-flairs'].map(kind => request(sourceAccount, kind, { subreddit }))) : [business ? await request(sourceAccount, resource, search.trim() ? { search: search.trim() } : {}) : await request(sourceAccount, resource)];
      if (!fresh()) return;
      if (business) {
        const page = result[0];
        if (page?.accountId !== sourceAccount || page.platform !== 'googlebusiness' || !Array.isArray(page.locations) || page.locations.length > 100 || page.locations.some((row: any) => !row || typeof row.id !== 'string' || !row.id || typeof row.name !== 'string' || ['accountId', 'accountName', 'address', 'category', 'storeCode'].some(key => row[key] !== null && typeof row[key] !== 'string')) || new Set(page.locations.map((row: Row) => row.id)).size !== page.locations.length || page.selectedLocationId !== null && typeof page.selectedLocationId !== 'string' || ['cached', 'hasMore'].some(key => page[key] !== null && typeof page[key] !== 'boolean')) throw new Error('The available locations could not be verified. Your location ID is unchanged.');
      }
      setData(previous => ({ ...previous, ...Object.assign({}, ...result), account: sourceAccount, generation: read, ...(business ? { locationScope: scope } : {}), ...(resource === 'reddit-details' ? { subredditScope: subreddit } : {}) }));
    } catch (failure) { if (fresh()) setError((failure as Error).message || 'Publishing destinations could not be loaded. Your draft is unchanged.'); }
    finally { if (fresh()) { pending.current = false; setBusy(''); } }
  }
  function change(key: string, value: string) { if (disabled || locationBlocked || !active.current) return; const next = { ...options }; value ? next[key] = value : delete next[key]; if (key === 'subreddit') { delete next.flairId; delete next.flairText; } onChange(next); }
  const loaded = data.account === sourceAccount && (!business || data.locationScope === scope && data.generation === generation.current) ? data : {}, details = loaded.subredditScope === subreddit ? loaded : {}, resource = platform === 'pinterest' ? 'pinterest-boards' : platform === 'youtube' ? 'youtube-playlists' : business ? 'gmb-locations' : 'reddit-subreddits';
  return <Stack as="section" gap={3} aria-label={`${PLATFORM_RULES[platform].label} destinations`}><Fieldset legend="Choose publishing destinations" disabled={disabled}>
    <Field label="Read choices from connected account"><Select value={sourceAccount} disabled={!!busy || locationBlocked} onChange={event => setSourceId(event.target.value)}><Option value="">Choose an account</Option>{accounts.map(account => <Option key={accountId(account)} value={accountId(account)}>{accountLabel(account)}</Option>)}</Select></Field>
    {!accounts.length && <Text tone="muted" size="sm">Select a connected {PLATFORM_RULES[platform].label} account above to load its destinations.</Text>}{accounts.length > 1 && <Text tone="muted" size="sm">{business ? 'Choose one account in Customise destination above before choosing or entering a location. A location cannot be copied to every selected Google Business Profile account.' : `These publishing options apply to every selected ${PLATFORM_RULES[platform].label} account. Choices below belong to the account shown; verify the destination is available to each account before publishing.`}</Text>}
    {business && <Field label="Search location names (optional)"><Input value={search} maxLength={200} disabled={locationBlocked} onChange={event => setSearch(event.target.value)}/></Field>}
    <Inline><Button variant="secondary" disabled={!!busy || !sourceAccount || locationBlocked || source?.isActive === false || !!source?.needsReconnection} onClick={() => load(resource)}>{busy === resource ? 'Loading destinations…' : platform === 'pinterest' ? 'Load boards' : platform === 'youtube' ? 'Load playlists' : business ? 'Load available locations' : 'Load subreddits'}</Button></Inline>
    {business && <><Field label="Google Business Profile location"><Select value={options.locationId || ''} disabled={locationBlocked} onChange={event => change('locationId', event.target.value)}><Option value="">Use account default location</Option>{options.locationId && !(loaded.locations || []).some((row: Row) => row.id === options.locationId) && <Option value={options.locationId}>Current location · {options.locationId} (not in loaded choices)</Option>}{(loaded.locations || []).map((row: Row) => <Option key={row.id} value={row.id}>{[row.name, row.accountName || row.accountId, row.address, row.category, row.storeCode && `Store ${row.storeCode}`, row.id].filter(Boolean).join(' · ')}</Option>)}</Select></Field><Disclosure variant="plain" summary="Enter a location ID manually"><Field label="Google Business Profile location ID"><Input value={options.locationId || ''} disabled={locationBlocked} onChange={event => change('locationId', event.target.value.trim())}/></Field></Disclosure>{loaded.locations && <><Text tone="muted" size="sm">{loaded.cached === true ? 'Cached choices returned. ' : loaded.cached === false ? 'Provider reports uncached choices. ' : 'Cache status not reported. '}{loaded.hasMore === true ? 'Partial list: more locations may be available. Narrow the name search.' : loaded.hasMore === false ? 'Provider reports no additional locations for this search.' : 'Completeness not reported; other locations may be available.'}</Text>{!loaded.locations.length && <Text tone="muted" size="sm">No locations returned for this account and search. Your current location ID is unchanged.</Text>}{loaded.selectedLocationId && <Text tone="muted" size="sm">Reported account default: {loaded.selectedLocationId}. Leaving the location empty uses the account default without changing it.</Text>}</>}<Text tone="muted" size="sm">Loads at most 100 available locations through this connected account. Verify the intended location before publishing. Manual entry remains available; an existing ID stays unchanged when a search excludes it or a lookup fails.</Text></>}
    {platform === 'pinterest' && <><Field label="Pinterest board"><Select value={options.boardId || ''} onChange={event => change('boardId', event.target.value)}><Option value="">Use account default board</Option>{options.boardId && !(loaded.boards || []).some((row: Row) => row.id === options.boardId) && <Option value={options.boardId}>Current board · {options.boardId} (not loaded)</Option>}{(loaded.boards || []).map((row: Row) => <Option key={row.id} value={row.id}>{row.name}{row.privacy ? ' · ' + row.privacy : ''}</Option>)}</Select></Field><Disclosure variant="plain" summary="Enter a board ID manually"><Field label="Pinterest board ID"><Input value={options.boardId || ''} onChange={event => change('boardId', event.target.value.trim())}/></Field></Disclosure>{loaded.boards && !loaded.boards.length && <Text tone="muted" size="sm">No boards returned for this account.</Text>}</>}
    {platform === 'youtube' && <><Field label="YouTube playlist"><Select value={options.playlistId || ''} onChange={event => change('playlistId', event.target.value)}><Option value="">No playlist</Option>{loaded.defaultPlaylistId && options.playlistId !== loaded.defaultPlaylistId && !(loaded.playlists || []).some((row: Row) => row.id === loaded.defaultPlaylistId) && <Option value={loaded.defaultPlaylistId}>Saved default playlist · {loaded.defaultPlaylistId} (not listed)</Option>}{options.playlistId && !(loaded.playlists || []).some((row: Row) => row.id === options.playlistId) && <Option value={options.playlistId}>Current playlist · {options.playlistId} (not loaded)</Option>}{(loaded.playlists || []).map((row: Row) => <Option key={row.id} value={row.id}>{row.title}{row.privacy ? ' · ' + row.privacy : ''}</Option>)}</Select></Field>{loaded.defaultPlaylistId && <Text tone="muted" size="sm">Saved account default: {loaded.playlists?.find((row: Row) => row.id === loaded.defaultPlaylistId)?.title || loaded.defaultPlaylistId}. Choose it explicitly to add this video; leaving the playlist empty adds none.</Text>}<Disclosure variant="plain" summary="Enter a playlist ID manually"><Field label="YouTube playlist ID"><Input value={options.playlistId || ''} onChange={event => change('playlistId', event.target.value.trim())}/></Field></Disclosure>{loaded.playlists && !loaded.playlists.length && <Text tone="muted" size="sm">No playlists returned for this account.</Text>}</>}
    {platform === 'reddit' && <><Field label="Subreddit name"><Input value={subreddit} maxLength={21} onChange={event => change('subreddit', event.target.value.replace(/^r\//i, '').trim())} placeholder="programming"/></Field>{loaded.subreddits && <Field label="Choose a connected subreddit"><Select value={subreddit} onChange={event => change('subreddit', event.target.value)}><Option value="">Use account default</Option>{subreddit && !loaded.subreddits.some((row: Row) => row.name === subreddit) && <Option value={subreddit}>Current subreddit · r/{subreddit}</Option>}{loaded.subreddits.map((row: Row) => <Option key={row.id} value={row.name}>r/{row.name}{row.title ? ' · ' + row.title : ''}{row.over18 === true ? ' · Adult content' : ''}</Option>)}</Select></Field>}{loaded.defaultSubreddit && <Text tone="muted" size="sm">Account default: r/{loaded.defaultSubreddit}. Enter or choose a subreddit to inspect its rules and flairs.</Text>}<Inline><Button variant="secondary" disabled={!!busy || !sourceAccount || !/^[A-Za-z0-9_]{1,21}$/.test(subreddit)} onClick={() => load('reddit-details')}>{busy === 'reddit-details' ? 'Loading rules and flairs…' : 'Load subreddit rules and flairs'}</Button></Inline><Field label="Post flair"><Select value={options.flairId || ''} onChange={event => change('flairId', event.target.value)}><Option value="">No explicit flair</Option>{options.flairId && !(details.flairs || []).some((row: Row) => row.id === options.flairId) && <Option value={options.flairId}>Current flair · {options.flairId} (not loaded)</Option>}{(details.flairs || []).map((row: Row) => <Option key={row.id} value={row.id}>{row.text || row.id}</Option>)}</Select></Field><Disclosure variant="plain" summary="Enter a flair ID manually"><Field label="Reddit flair ID"><Input value={options.flairId || ''} onChange={event => change('flairId', event.target.value.trim())}/></Field></Disclosure>{details.rules && <Stack gap={2}><Heading level={5} size="sm">Rules for r/{subreddit}</Heading>{!details.rules.length && <Text>No subreddit rules returned.</Text>}{details.rules.map((row: Row, index: number) => <Stack gap={1} key={index}><Text><Text as="strong" weight="semibold">{row.shortName || 'Rule ' + (index + 1)}</Text>{' · ' + row.kind}</Text><Text preserveWhitespace>{row.description || row.violationReason}</Text></Stack>)}<Heading level={5} size="sm">Reddit site rules</Heading><List>{(details.siteRules || []).map((rule: string, index: number) => <ListItem key={index}>{rule}</ListItem>)}</List></Stack>}</>}
    {error && <Alert tone="danger">{error}</Alert>}{busy && <StatusLine busy>Loading account destinations…</StatusLine>}<Text tone="muted" size="sm">Loading choices does not change account defaults or publish anything. Account permissions and platform checks still apply at publication.</Text>
  </Fieldset></Stack>;
}

function MediaEditor({ items, onChange, label, disabled, onInspect }: { items: MediaItem[]; onChange: (items: MediaItem[]) => void; label: string; disabled?: boolean; onInspect?: (item: MediaItem) => Promise<any> }) {
  const [inspecting, setInspecting] = useState(-1), [notice, setNotice] = useState('');
  const current = useRef(items), active = useRef(true); current.current = items;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  // The strip shows previews, facts, alt text and order; ids are positions so its changes map back onto these items.
  const strip: StripItem[] = items.map((item, index) => ({ id: String(index), name: `${label} media ${index + 1}`, preview: <PreviewMedia item={item}/>, status: inspecting === index ? 'pending' : 'unverified', statusLabel: inspecting === index ? 'Reading metadata…' : item.width > 0 || item.size > 0 ? 'Metadata entered' : 'Metadata not checked', altText: item.altText || '', type: item.mimeType, width: item.width, height: item.height, duration: item.duration > 0 ? item.duration : undefined, size: item.size > 0 ? item.size : undefined }));
  function update(index: number, patch: Record<string, any>) { if (!active.current) return; onChange(current.current.map((item, position) => position === index ? Object.fromEntries(Object.entries({ ...item, ...patch }).filter(([, value]) => value !== undefined)) as MediaItem : item)); }
  async function inspect(index: number) {
    const item = current.current[index], url = previewUrl(item.url);
    if (!url || !['image', 'gif', 'video'].includes(item.type)) { setNotice('Enter a public HTTPS image or video URL before checking its dimensions.'); return; }
    setInspecting(index); setNotice('');
    try {
      const metadata = await new Promise<Record<string, number>>((resolve, reject) => {
        const media = item.type !== 'video' ? new Image() : document.createElement('video');
        const finish = (result?: Record<string, number>) => {
          clearTimeout(timeout); media.onload = null; media.onerror = null;
          if (media instanceof HTMLVideoElement) { media.onloadedmetadata = null; media.removeAttribute('src'); media.load(); }
          result ? resolve(result) : reject(new Error('This browser could not read the media metadata. Check that the URL serves the file directly.'));
        };
        const timeout = window.setTimeout(() => finish(), 12000);
        media.onerror = () => finish();
        if (media instanceof HTMLImageElement) { media.referrerPolicy = 'no-referrer'; media.onload = () => finish({ width: media.naturalWidth, height: media.naturalHeight }); }
        else { media.preload = 'metadata'; media.onloadedmetadata = () => finish({ width: media.videoWidth, height: media.videoHeight, ...(Number.isFinite(media.duration) ? { duration: media.duration } : {}) }); }
        media.src = url;
      });
      if (current.current[index]?.url === item.url && current.current[index]?.type === item.type) {
        update(index, metadata); setNotice('Dimensions checked in your browser. File size and encoding still need provider verification.');
      }
    } catch (error) { setNotice((error as Error).message); } finally { setInspecting(-1); }
  }
  async function inspectWithProvider(index: number) {
    if (!onInspect || inspecting !== -1) return;
    const item = current.current[index]; setInspecting(index); setNotice('');
    try {
      const result = await onInspect(item), metadata = result?.mediaItem || result?.media || result?.metadata || result;
      if (result?.valid === false) throw new Error(result.error || 'Zernio could not read this media file.');
      if (current.current[index]?.url !== item.url || current.current[index]?.type !== item.type) return;
      const patch = Object.fromEntries(['width', 'height', 'duration', 'size', 'mimeType'].filter(key => key === 'mimeType' ? typeof (metadata?.mimeType || metadata?.contentType) === 'string' : Number.isFinite(metadata?.[key]) && metadata[key] > 0).map(key => [key, key === 'mimeType' ? metadata.mimeType || metadata.contentType : metadata[key]]));
      if (Object.keys(patch).length) update(index, patch);
      setNotice(result?.message || (Object.keys(patch).length ? 'Media metadata checked with Zernio. Captions, publishing options and each account still need the post check.' : 'Zernio media check completed. Check the full post before publishing.'));
    } catch (failure) { setNotice((failure as Error).message || 'Zernio could not inspect this media.'); } finally { setInspecting(-1); }
  }
  return <Stack gap={4}>
    <MediaStrip label={`${label} media`} altMaxLength={1500} items={strip} readOnly={disabled} emptyMessage="No media. Platforms that require an image or video will show a restriction below." onItemsChange={next => onChange(next.map(entry => { const item = items[Number(entry.id)], altText = entry.altText; return altText === (item.altText || '') ? item : Object.fromEntries(Object.entries({ ...item, altText: altText || undefined }).filter(([, value]) => value !== undefined)) as MediaItem; }))}/>
    {items.map((item, index) => <Fieldset key={index} legend={`${label} media ${index + 1} source`}>
      <FormGrid><Field label={`${label} media ${index + 1} type`}><Select value={item.type} onChange={event => update(index, { type: event.target.value, width: undefined, height: undefined, duration: undefined })}><Option value="image">Image</Option><Option value="video">Video</Option><Option value="gif">Animated GIF</Option><Option value="document">Document / PDF</Option></Select></Field>
        <Field label={`${label} media ${index + 1} URL`}><Input type="url" value={item.url} maxLength={4000} required placeholder="https://cdn.example.com/creative.jpg" onChange={event => { const { width, height, duration, size, mimeType, ...rest } = item; onChange(items.map((media, position) => position === index ? { ...rest, url: event.target.value } : media)); }}/></Field></FormGrid>
      {(['image', 'gif', 'video'].includes(item.type) || onInspect) && <Inline gap={2}>{['image', 'gif', 'video'].includes(item.type) && <Button variant="ghost" size="sm" disabled={disabled || inspecting !== -1 || !previewUrl(item.url)} onClick={() => inspect(index)}>{inspecting === index ? 'Reading metadata…' : 'Check dimensions'}</Button>}{onInspect && <Button variant="ghost" size="sm" disabled={disabled || inspecting !== -1 || !previewUrl(item.url)} onClick={() => inspectWithProvider(index)}>Check file with Zernio</Button>}</Inline>}
      <Disclosure variant="plain" summary="Media details and metadata"><Stack gap={3}><Text tone="muted" size="sm">Use the file’s actual values. Unknown dimensions, duration, size and encoding cannot be fully checked until the provider reads the file.</Text>
        <FormGrid>{[['width', 'Width (pixels)'], ['height', 'Height (pixels)'], ['duration', 'Duration (seconds)'], ['size', 'File size (bytes)']].map(([key, fieldLabel]) => <Field key={key} label={`${label} media ${index + 1} ${fieldLabel}`}><Input type="number" min={key === 'duration' ? 0.001 : 1} step={key === 'duration' ? 'any' : 1} value={item[key] ?? ''} onChange={event => update(index, { [key]: event.target.value === '' ? undefined : Number(event.target.value) })}/></Field>)}</FormGrid>
        <FormGrid><Field label={`${label} media ${index + 1} MIME type`}><Input value={item.mimeType || ''} maxLength={100} placeholder={item.type === 'video' ? 'video/mp4' : item.type === 'document' ? 'application/pdf' : 'image/jpeg'} onChange={event => update(index, { mimeType: event.target.value || undefined })}/></Field><Field label={`${label} media ${index + 1} title`}><Input value={item.title || ''} maxLength={300} onChange={event => update(index, { title: event.target.value || undefined })}/></Field></FormGrid>
        {item.type === 'video' && <Field label={`${label} media ${index + 1} thumbnail URL`}><Input type="url" value={item.thumbnail || ''} maxLength={4000} onChange={event => update(index, { thumbnail: event.target.value || undefined })}/></Field>}
      </Stack></Disclosure>
    </Fieldset>)}
    {notice && <StatusLine>{notice}</StatusLine>}
    <Inline><Button variant="secondary" disabled={disabled || items.length >= 35} onClick={() => onChange([...items, { type: 'image', url: '' }])}>Add {items.length ? 'another ' : ''}media URL</Button></Inline>
  </Stack>;
}

function PreviewMedia({ item }: { item: MediaItem }) {
  const url = previewUrl(item.url);
  if (!url || ['drive.google.com', 'docs.google.com'].includes(new URL(url).hostname)) return <Text tone="muted" size="sm">{item.type === 'video' ? 'Video' : item.type === 'document' ? 'Document' : 'Image'} preview unavailable. Use a direct public media URL.</Text>;
  return ['image', 'gif'].includes(item.type) ? <MediaImage src={url} alt={item.altText || 'Post image'} fit="contain" referrerPolicy="no-referrer" fallback="Image preview unavailable. Use a direct public media URL."/> : item.type === 'video' ? <MediaPlayer kind="video" label={item.title ? `Post video: ${item.title}` : 'Post video'} src={url} type={item.mimeType} poster={previewUrl(item.thumbnail || '') || undefined} width={item.width > 0 ? item.width : undefined} height={item.height > 0 ? item.height : undefined}/> : <Text tone="muted" size="sm">Document attachment: {item.title || item.filename || 'PDF / document'}</Text>;
}

const optionLabel = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, character => character.toUpperCase());
function StructuredOption({ schema, value, onChange, label, onInvalid, depth = 0 }: { schema: Record<string, any>; value: any; onChange: (value: any) => void; label: string; onInvalid: (message: string) => void; depth?: number }) {
  const [raw, setRaw] = useState(value === undefined ? '' : JSON.stringify(value, null, 2));
  if (schema.oneOf || depth > 5 || schema.type === 'object' && !schema.properties) return <Field label={`${label} (advanced format)`}><Textarea value={raw} onChange={event => { const input = event.target.value; setRaw(input); try { onChange(input.trim() ? JSON.parse(input) : undefined); onInvalid(''); } catch { onInvalid(`${label} must contain valid JSON.`); } }}/></Field>;
  if (schema.type === 'object' || schema.properties) return <Fieldset legend={label}><Checkbox label={`Enable ${label}`} checked={value !== undefined} onChange={event => { onChange(event.target.checked ? {} : undefined); onInvalid(''); }}/>{value !== undefined && Object.entries(schema.properties || {}).map(([key, field]: [string, any]) => <StructuredOption key={key} label={`${label} · ${optionLabel(key)}`} schema={field} value={value?.[key]} depth={depth + 1} onInvalid={onInvalid} onChange={next => { const updated = { ...value }; next === undefined ? delete updated[key] : updated[key] = next; onChange(updated); }}/>)}</Fieldset>;
  if (schema.type === 'array') return <Fieldset legend={label}>{(value || []).map((item: any, index: number) => <Stack key={index} gap={2}><StructuredOption label={`${label} ${index + 1}`} schema={schema.items || { type: 'string' }} value={item} depth={depth + 1} onInvalid={onInvalid} onChange={next => onChange(next === undefined ? value.filter((_: any, position: number) => position !== index) : value.map((previous: any, position: number) => index === position ? next : previous))}/><Inline><Button variant="secondary" size="sm" aria-label={`Remove ${label} ${index + 1}`} onClick={() => onChange(value.filter((_: any, position: number) => position !== index))}>Remove</Button></Inline></Stack>)}<Inline gap={2}><Button variant="secondary" size="sm" disabled={(value || []).length >= (schema.maxItems || 100)} onClick={() => onChange([...(value || []), schema.items?.type === 'object' ? {} : schema.items?.type === 'array' ? [] : schema.items?.enum?.[0] ?? ''])}>Add {label.toLowerCase()} item</Button>{value !== undefined && <Button variant="ghost" size="sm" onClick={() => { onChange(undefined); onInvalid(''); }}>Clear {label.toLowerCase()}</Button>}</Inline></Fieldset>;
  return <Field label={label}>{schema.type === 'boolean' ? <Select value={value === undefined ? '' : String(value)} onChange={event => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}><Option value="">Platform default</Option><Option value="true">On</Option><Option value="false">Off</Option></Select> : schema.enum ? <Select value={value ?? ''} onChange={event => onChange(event.target.value === '' ? undefined : schema.type === 'integer' ? Number(event.target.value) : event.target.value)}><Option value="">Choose an option</Option>{schema.enum.map((choice: any) => <Option value={choice} key={choice}>{String(choice)}</Option>)}</Select> : <Input value={value ?? ''} type={['number', 'integer'].includes(schema.type) ? 'number' : schema.format === 'uri' ? 'url' : 'text'} min={schema.minimum} max={schema.maximum} step={schema.type === 'integer' ? 1 : schema.type === 'number' ? 'any' : undefined} maxLength={schema.maxLength || 50000} onChange={event => onChange(event.target.value === '' ? undefined : ['number', 'integer'].includes(schema.type) ? Number(event.target.value) : event.target.value)}/>}</Field>;
}

const previewMedia = (items: MediaItem[] = []) => items.length ? <Grid columns="auto" minItemWidth="sm" gap={2}>{items.map((item, index) => <Stack key={item.url + ':' + index} gap={1}><PreviewMedia item={item}/>{items.length > 1 && <Text size="xs" tone="muted">{index + 1} / {items.length}</Text>}</Stack>)}</Grid> : undefined;
type PreviewSize = 'mobile' | 'desktop';
// The mobile/desktop preview toggle follows zernio-dev/latewiz@28dd018063b955769de11f881acd03bb64c61cd4 src/app/dashboard/compose/_components/platform-previews.tsx:34-50 (MIT).
// The size sets the previewed device width and where feeds cut a caption: phones show fewer characters.
const captionCutoff = (platform: string, size: PreviewSize) => ['instagram', 'tiktok', 'threads'].includes(platform) ? size === 'mobile' ? 125 : 180 : size === 'mobile' ? 140 : 300;
export function PostVariantPreview({ platform, variant, accountName = 'Your brand', scheduled = false, size }: { platform: string; variant: { content: string; mediaItems: MediaItem[]; options?: Record<string, any> }; accountName?: string; scheduled?: boolean; size?: PreviewSize }) {
  const options = variant.options || {}, rule = PLATFORM_RULES[platform];
  const entries: { content?: string; mediaItems?: MediaItem[] }[] = options.threadItems?.length ? options.threadItems : [variant];
  const pollAnswers = options.poll?.options || options.poll?.answers?.map((answer: any) => answer.poll_media?.text || 'Poll answer') || [];
  const [first, ...rest] = entries, caption = first.content || undefined;
  return <ContentPreview label={`${rule?.label || platform} post preview`} destination={accountName} provider={`${rule?.label || platform} · ${options.postType || options.mediaType || options.contentType || 'Post'}${scheduled ? ' · Planned' : ''}`} chrome={[options.contentType, options.postType].includes('story') ? 'story' : ['discord', 'telegram', 'whatsapp'].includes(platform) ? 'message' : 'post'} device={size} captionLimit={captionCutoff(platform, size || 'desktop')} emptyMessage="Your caption will appear here."
    text={options.title ? <Stack gap={1}><Text weight="semibold">{options.title}</Text>{caption && <Text preserveWhitespace>{caption}</Text>}</Stack> : caption} media={previewMedia(first.mediaItems)}
    thread={rest.map((entry, position) => ({ id: platform + ':' + (position + 1), text: entry.content || undefined, media: previewMedia(entry.mediaItems) }))}
    poll={options.poll ? { question: typeof options.poll.question === 'string' ? options.poll.question : options.poll.question?.text || 'Poll', options: pollAnswers, duration: 'Voting opens on the platform after publication.' } : undefined}
    firstComment={options.firstComment || undefined}/>;
}

export default function PostComposer({ post, assets = [], campaigns = [], accounts: connectedAccounts = [], canWrite, onSubmit, onCancel, onDelete, onValidate, onLoadAccounts, onInspectMedia, onTikTokInfo, onLookupDestinations, onLoadQueues, onLoadGroups, onShortenLinks, providerPost = false, busy = false, readOnly = false, initialScheduledAt, actionsHost }: Props) {
  const [content, setContent] = useState(post?.content || ''), [platforms, setPlatforms] = useState<string[]>(post?.platforms || []), [selectedAccounts, setAccounts] = useState<string[]>(post?.accounts || []);
  const [assetId, setAssetId] = useState(post?.assetId || ''), [campaignId, setCampaignId] = useState(post?.campaignId || ''), [scheduledAt, setScheduledAt] = useState(localTime(post?.scheduledAt) || initialScheduledAt || '');
  const [baseMode, setBaseMode] = useState(Array.isArray(post?.mediaItems) ? post.mediaItems.length ? 'custom' : 'none' : post?.assetId ? 'asset' : 'none'), [baseMedia, setBaseMedia] = useState<MediaItem[]>(post?.mediaItems || []);
  const [overrides, setOverrides] = useState<Record<string, Override>>(post?.platformOverrides || {}), [activePlatform, setActivePlatform] = useState(post?.platforms?.[0] || ''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [accountOverrides, setAccountOverrides] = useState<Record<string, AccountOverride>>(post?.accountOverrides || {}), [activeAccount, setActiveAccount] = useState('');
  const [optionInputs, setOptionInputs] = useState<Record<string, string>>({}), [optionErrors, setOptionErrors] = useState<Record<string, string>>({});
  const [platformMediaModes, setPlatformMediaModes] = useState<Record<string, string>>({}), [checking, setChecking] = useState(false), [providerCheck, setProviderCheck] = useState<{ signature: string; result: any } | null>(null);
  const [accountsTouched, setAccountsTouched] = useState(false), [loadingAccounts, setLoadingAccounts] = useState(false);
  const [queues, setQueues] = useState<any[]>([]), [queueId, setQueueId] = useState(providerPost ? '' : post?.queueId || ''), [queueVersion, setQueueVersion] = useState(providerPost ? '' : post?.queueVersion || ''), [loadingQueues, setLoadingQueues] = useState(false);
  const [tikTokPermissions, setTikTokPermissions] = useState<Record<string, { mediaType: string; result: any }>>({}), [loadingTikTok, setLoadingTikTok] = useState(false);
  const headingRef = useRef<HTMLElement>(null), formId = useId();
  const [shortening, setShortening] = useState(false), alive = useRef(true);
  const [groupAccounts, setGroupAccounts] = useState<Row[] | null>(null), accounts = groupAccounts || connectedAccounts;
  const [tagInput, setTagInput] = useState((post?.tags || []).join('\n')), [previewSize, setPreviewSize] = useState<PreviewSize>('desktop');
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Accounts load once when an editable composer opens without them, as latewiz's account picker loads on open
  // (zernio-dev/latewiz@28dd018063b955769de11f881acd03bb64c61cd4 src/app/dashboard/compose/_components/platform-selector.tsx:24, MIT).
  const autoLoaded = useRef(false);
  useEffect(() => { if (autoLoaded.current || readOnly || !canWrite || providerPost || !onLoadAccounts || connectedAccounts.length) return; autoLoaded.current = true; void loadAccounts(); }, []);
  const disabled = busy || saving || shortening || !canWrite || readOnly || post?.status === 'published' || !!post?.externalId && !providerPost;
  const selected = platforms.includes(activePlatform) ? activePlatform : platforms[0] || '', rule = PLATFORM_RULES[selected];
  const accountChoices = accounts.filter(account => account.platform === selected && selectedAccounts.includes(accountId(account))), editingAccount = accountChoices.find(account => accountId(account) === activeAccount), editingAccountId = editingAccount ? accountId(editingAccount) : '', editKey = selected + ':' + editingAccountId;
  const locationAccount = selected === 'googlebusiness' ? editingAccount || (accountChoices.length === 1 ? accountChoices[0] : null) : null;
  const instagramAccount = selected === 'instagram' ? editingAccount || (accountChoices.length === 1 ? accountChoices[0] : null) : null;
  const tiktokAccount = selected === 'tiktok' ? editingAccount || (accountChoices.length === 1 ? accountChoices[0] : null) : null;
  const override = editingAccountId ? accountOverrides[editingAccountId] || {} : overrides[selected] || {};
  const values = useMemo(() => ({ content, platforms, ...(platforms.includes('youtube') || post?.tags !== undefined ? { tags: tagInput.split(/\r?\n/) } : {}), ...(queueId ? { queueId, queueVersion } : post?.queueId ? { queueId: '', queueVersion: '' } : {}), ...(post?.accounts !== undefined || accountsTouched || accounts.some(account => platforms.includes(account.platform) && PLATFORM_RULES[account.platform] && account.isActive !== false) ? { accounts: selectedAccounts } : {}), assetId: baseMode === 'asset' ? assetId : '', campaignId, scheduledAt: scheduledAt && Number.isFinite(Date.parse(scheduledAt)) ? new Date(scheduledAt).toISOString() : '', status: scheduledAt ? 'scheduled' : 'draft', mediaItems: baseMode === 'asset' ? null : baseMode === 'custom' ? baseMedia : [], platformOverrides: Object.fromEntries(Object.entries(overrides).filter(([platform]) => platforms.includes(platform))), ...(Object.keys(accountOverrides).length || post?.accountOverrides ? { accountOverrides: Object.fromEntries(Object.entries(accountOverrides).filter(([id, copy]) => selectedAccounts.includes(id) && platforms.includes(copy.platform))) } : {}) }), [content, platforms, selectedAccounts, accountsTouched, accounts, post?.accounts, post?.accountOverrides, baseMode, assetId, campaignId, scheduledAt, queueId, queueVersion, baseMedia, overrides, accountOverrides, tagInput]);
  const providerOwnedMediaUrls = providerPost ? providerPostMediaUrls(post) : new Set<string>();
  const destinationChecks = platforms.flatMap(platform => { const ids = selectedAccounts.filter(id => accounts.find(account => accountId(account) === id)?.platform === platform || values.accountOverrides?.[id]?.platform === platform); return (ids.length ? ids : [undefined]).map(id => ({ ...validatePostForPlatforms(values, [platform], { assets, accountId: id, providerOwnedMediaUrls }), accountId: id, platform })); });
  const checks = { errors: destinationChecks.flatMap(check => check.errors.map((item: any) => ({ ...item, accountId: check.accountId }))), warnings: destinationChecks.flatMap(check => check.warnings.map((item: any) => ({ ...item, accountId: check.accountId }))) }, variant = selected ? resolveVariant(values, selected, assets, editingAccountId || undefined) : null;
  async function shortenLinks() {
    if (!onShortenLinks || disabled) return; setShortening(true); setError('');
    try { const result = await onShortenLinks(values); if (alive.current) { setContent(result.content); setOverrides(result.platformOverrides); if (result.accountOverrides) setAccountOverrides(result.accountOverrides); setProviderCheck(null); } }
    catch (failure) { if (alive.current && (failure as Error).name !== 'AbortError') setError((failure as Error).message); }
    finally { if (alive.current) setShortening(false); }
  }
  const selectedCheck = editingAccountId ? validatePostForPlatforms(values, [selected], { assets, accountId: editingAccountId, providerOwnedMediaUrls }) : validatePostForPlatforms(values, [selected], { assets, providerOwnedMediaUrls }), errors = selectedCheck.errors, warnings = selectedCheck.warnings;
  const socialAccounts = accounts.filter(account => PLATFORM_RULES[account.platform] && account.isActive !== false), activeAccounts = socialAccounts.filter(account => platforms.includes(account.platform));
  function changeOverride(patch: Override, remove: string[] = []) {
    if (own(patch, 'options') || remove.includes('options')) { const keep = (previous: Record<string, string>) => Object.fromEntries(Object.entries(previous).filter(([key]) => !key.startsWith(editKey + ':'))); setOptionInputs(keep); setOptionErrors(keep); }
    if (editingAccountId) { setAccountOverrides(previous => { const next: AccountOverride = { ...previous[editingAccountId], platform: selected, ...patch }; for (const key of remove) delete (next as any)[key]; return { ...previous, [editingAccountId]: next }; }); return; }
    setOverrides(previous => { const next: Record<string, any> = { ...previous[selected], ...patch }; for (const key of remove) delete next[key]; return { ...previous, [selected]: next }; });
  }
  function togglePlatform(platform: string) {
    if (platforms.includes(platform)) { setPlatforms(platforms.filter(value => value !== platform)); setAccounts(selectedAccounts.filter(id => socialAccounts.find(account => accountId(account) === id)?.platform !== platform)); }
    else { setPlatforms([...platforms, platform]); setActivePlatform(platform); }
  }
  function updateOption(key: string, value: any) {
    const options = { ...variant?.options }; value === undefined ? delete options[key] : options[key] = value;
    changeOverride({ options });
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled) return; setError('');
    try {
      if (!platforms.length) throw new Error('Choose at least one social platform.');
      const invalid = Object.entries(optionErrors).find(([key, value]) => value && platforms.includes(key.split(':')[0]));
      if (invalid) throw new Error(invalid[1]);
      normalizePostTags(values.tags); normalizePostVariants(values); normalizeAccountVariants(values);
      setSaving(true); await onSubmit(values);
    } catch (failure) { setError((failure as Error).message || 'Your draft could not be saved. Your entries are still here.'); headingRef.current?.focus(); } finally { setSaving(false); }
  }
  async function checkWithProvider() {
    if (!onValidate || checking || disabled) return;
    const signature = JSON.stringify(values); setChecking(true); setError('');
    try { normalizePostTags(values.tags); normalizePostVariants(values); normalizeAccountVariants(values); const result = await onValidate(values); setProviderCheck({ signature, result }); }
    catch (failure) { setProviderCheck({ signature, result: { valid: false, errors: [{ message: (failure as Error).message || 'Zernio could not check this post.' }] } }); }
    finally { setChecking(false); }
  }
  async function loadAccounts() {
    if (!onLoadAccounts || loadingAccounts) return; setLoadingAccounts(true); setError('');
    try { await onLoadAccounts(); if (alive.current) setGroupAccounts(null); } catch (failure) { setError((failure as Error).message || 'Connected channels could not be loaded.'); } finally { setLoadingAccounts(false); }
  }
  async function loadTikTokPermissions() {
    const destinations = socialAccounts.filter(account => account.platform === 'tiktok' && selectedAccounts.includes(accountId(account)));
    if (!onTikTokInfo || loadingTikTok || !destinations.length) return;
    setLoadingTikTok(true); setError('');
    try {
      const results = await Promise.all(destinations.map(async account => { const id = accountId(account), mediaType = resolveVariant(values, 'tiktok', assets, id).mediaItems.some((item: MediaItem) => item.type === 'video') ? 'video' : 'photo'; return { id, mediaType, result: await onTikTokInfo(id, mediaType) }; }));
      setTikTokPermissions(previous => ({ ...previous, ...Object.fromEntries(results.map(item => [item.id, { mediaType: item.mediaType, result: item.result }])) }));
    } catch (failure) { setError((failure as Error).message || 'TikTok publishing permissions could not be loaded.'); } finally { setLoadingTikTok(false); }
  }
  const providerErrors = providerCheck?.result?.errors || providerCheck?.result?.validation?.errors || [], providerWarnings = providerCheck?.result?.warnings || providerCheck?.result?.validation?.warnings || [];
  const mediaMode = platformMediaModes[editKey] || (own(override, 'mediaItems') ? override.mediaItems?.length ? 'custom' : 'none' : own(override, 'assetId') ? override.assetId ? 'asset' : 'none' : 'shared');
  const captionLimit = variant ? captionLimitForVariant(variant) : rule?.captionLimit || 0;
  const tikTokAccounts = socialAccounts.filter(account => account.platform === 'tiktok' && selectedAccounts.includes(accountId(account)));
  const tagErrors = checks.errors.filter((item: any) => item.field === 'tags'), providerStale = !!providerCheck && providerCheck.signature !== JSON.stringify(values), selectedQueue = queues.find(row => row._id === queueId), nextSlot = selectedQueue?.active && Array.isArray(selectedQueue.slots) ? nextQueueSlot(selectedQueue.slots, selectedQueue.timezone) : null;
  const providerPassed = providerCheck?.result?.valid === true || providerCheck?.result?.validation?.valid === true, providerFailed = providerCheck?.result?.valid === false || providerErrors.length > 0;
  const providerMessages: ValidationMessage[] = providerCheck ? [...(Array.isArray(providerErrors) ? providerErrors.map((item: any, index: number) => ({ id: 'error' + index, text: typeof item === 'string' ? item : item.message || item.error || 'A destination failed validation.' })) : []), ...(Array.isArray(providerWarnings) ? providerWarnings.map((item: any, index: number) => ({ id: 'warning' + index, text: typeof item === 'string' ? item : item.message || item.warning || 'The provider reported a restriction to review.' })) : []), ...(providerCheck.result?.message ? [{ id: 'message', text: providerCheck.result.message }] : [])] : [];
  const panel = rule && variant && <Stack gap={4}>
    {!!accountChoices.length && <Field label="Customise destination"><Select value={editingAccountId} onChange={event => setActiveAccount(event.target.value)}><Option value="">{rule.label} defaults · inherited by accounts</Option>{accountChoices.map(account => <Option key={accountId(account)} value={accountId(account)}>{accountLabel(account)} · {accountId(account)}</Option>)}</Select></Field>}
    {editingAccount && <Text tone="muted" size="sm">Editing {accountLabel(editingAccount)} ({editingAccountId}). Fields inherit the {rule.label} defaults until you customise them here.</Text>}
    <Checkbox label={`Separate ${editingAccount ? 'account' : rule.label} caption`} checked={own(override, 'content')} onChange={event => event.target.checked ? changeOverride({ content: variant.content }) : changeOverride({}, ['content'])}/>
    <Field label={`${rule.label} caption${!own(override, 'content') ? editingAccount ? ' (using platform caption)' : ' (using shared caption)' : ''}`} description={selected === 'twitter' ? 'Counted as weighted characters.' : selected === 'bluesky' ? 'Counted in graphemes.' : undefined} count={captionLimit > 0 ? { value: variant.content, max: captionLimit, measure: value => countCaption(value, selected) } : undefined}><Textarea value={variant.content} maxLength={100000} readOnly={!own(override, 'content')} onChange={event => changeOverride({ content: event.target.value })} aria-invalid={errors.some((item: any) => item.field === 'content')}/></Field>
    <Field label={`${rule.label} media source`}><Select value={mediaMode} onChange={event => { const mode = event.target.value; setPlatformMediaModes(previous => ({ ...previous, [editKey]: mode })); if (mode === 'shared') changeOverride({}, ['mediaItems', 'assetId']); else if (mode === 'none') changeOverride({ mediaItems: [] }, ['assetId']); else if (mode === 'asset') changeOverride({ assetId: '' }, ['mediaItems']); else changeOverride({ mediaItems: variant.mediaItems.map((item: MediaItem) => ({ ...item })) }, ['assetId']); }}><Option value="shared">Use {editingAccount ? 'platform' : 'shared'} media</Option><Option value="none">Text only / no media</Option><Option value="asset">Choose a different asset</Option><Option value="custom">Separate media URLs</Option></Select></Field>
    {mediaMode === 'asset' && <Field label={`${rule.label} creative asset`}><Select value={override.assetId || ''} onChange={event => changeOverride({ assetId: event.target.value })}><Option value="">Choose an asset</Option>{assets.map(asset => <Option key={asset.id} value={asset.id}>{asset.name} · {asset.kind}{asset.approval !== 'approved' ? ' · Approval required' : ''}</Option>)}</Select></Field>}
    {mediaMode === 'custom' && <MediaEditor key={editKey} items={override.mediaItems || []} onChange={mediaItems => changeOverride({ mediaItems })} label={editingAccount ? accountLabel(editingAccount) : rule.label} disabled={disabled} onInspect={onInspectMedia}/>}
    {selected === 'tiktok' && <Text tone="muted" size="sm">Privacy choices, creator permissions and your posting consent are checked against the connected TikTok creator before submission.</Text>}
    {selected === 'tiktok' && onTikTokInfo && <Stack gap={2}><Inline><Button variant="secondary" disabled={disabled || loadingTikTok || !tikTokAccounts.length} onClick={loadTikTokPermissions}>{loadingTikTok ? 'Loading TikTok permissions…' : 'Load TikTok publishing permissions'}</Button></Inline>{!tikTokAccounts.length && <Text tone="muted" size="sm">Select a connected TikTok account to load its allowed privacy settings.</Text>}{tikTokAccounts.map(account => {
      const saved = tikTokPermissions[accountId(account)], permissions = saved?.result;
      if (!permissions) return null;
      return <Stack key={accountId(account)} gap={1}><Text><Text as="strong" weight="semibold">{permissions.creator?.nickname || accountLabel(account)}</Text>{saved.mediaType !== (resolveVariant(values, 'tiktok', assets, accountId(account)).mediaItems.some((item: MediaItem) => item.type === 'video') ? 'video' : 'photo') ? ' · Media type changed; load permissions again.' : ''}</Text>{permissions.creator?.canPostMore === false && <Alert tone="danger" variant="inline">This creator has reached its posting limit.</Alert>}<Text>Allowed privacy: {(permissions.privacyLevels || []).map((level: any) => level.label || level.value).join(', ') || 'Not reported'}</Text>{permissions.postingLimits?.maxVideoDurationSec && <Text>Maximum video duration: {permissions.postingLimits.maxVideoDurationSec} seconds.</Text>}<List>{Object.entries(permissions.postingLimits?.interactionSettings || {}).map(([key, setting]: [string, any]) => setting && <ListItem key={key}>{setting.label || optionLabel(key)}: {setting.enabled === false ? 'Unavailable for this creator' : setting.required ? 'Choose explicitly' : 'Available'}</ListItem>)}</List></Stack>;
    })}</Stack>}
    <Text tone="muted" size="sm">{rule.mediaTypes.join(', ')} · {rule.maxMedia} media item{rule.maxMedia === 1 ? '' : 's'} maximum{rule.minMedia ? ` · At least ${rule.minMedia} required` : ''}. Restrictions can change with the format and account.</Text>
    {editingAccountId && <Stack gap={2}><Checkbox label="Separate account publishing options" checked={own(override, 'options')} onChange={event => event.target.checked ? changeOverride({ options: { ...variant.options } }) : changeOverride({}, ['options'])}/>{own(override, 'options') && <Inline><Button variant="secondary" size="sm" onClick={() => changeOverride({ options: {} })}>Clear account options</Button></Inline>}<Text tone="muted" size="sm">Changing any option creates a separate set for this account. Clear account options uses provider defaults; turn off separate options to inherit platform settings.</Text></Stack>}
    {onLookupDestinations && destinationFields[selected] && <PublishingDestinations key={editKey + ':' + selectedAccounts.join(',')} platform={selected} accounts={editingAccount ? [editingAccount] : selected === 'googlebusiness' ? accountChoices : socialAccounts.filter(account => account.platform === selected && selectedAccounts.includes(accountId(account)))} options={locationAccount ? resolveVariant(values, selected, assets, accountId(locationAccount)).options : variant.options} lookup={onLookupDestinations} disabled={disabled} onChange={options => { if (selected === 'googlebusiness') { if (disabled || !locationAccount) return; const id = accountId(locationAccount); setAccountOverrides(previous => ({ ...previous, [id]: { ...previous[id], platform: selected, options } })); } else changeOverride({ options }); }}/>}
    {onLookupDestinations && selected === 'instagram' && <InstagramPublishingTools key={editKey + ':' + selectedAccounts.join(',')} account={instagramAccount} mediaItems={instagramAccount ? resolveVariant(values, selected, assets, accountId(instagramAccount)).mediaItems : variant.mediaItems} options={instagramAccount ? resolveVariant(values, selected, assets, accountId(instagramAccount)).options : variant.options} disabled={disabled} lookup={onLookupDestinations} onChange={options => { if (disabled || !instagramAccount) return; const id = accountId(instagramAccount); setAccountOverrides(previous => ({ ...previous, [id]: { ...previous[id], platform: 'instagram', options } })); }}/>}
    {onLookupDestinations && selected === 'tiktok' && <TikTokPublishingTools key={editKey + ':' + selectedAccounts.join(',')} account={tiktokAccount} mediaItems={tiktokAccount ? resolveVariant(values, selected, assets, accountId(tiktokAccount)).mediaItems : variant.mediaItems} options={tiktokAccount ? resolveVariant(values, selected, assets, accountId(tiktokAccount)).options : variant.options} disabled={disabled} lookup={onLookupDestinations} onChange={options => { if (disabled || !tiktokAccount) return; const id = accountId(tiktokAccount); setAccountOverrides(previous => ({ ...previous, [id]: { ...previous[id], platform: 'tiktok', options } })); }}/>}
    {rule.options?.length > 0 && <Disclosure summary={`${rule.label} publishing options`} defaultOpen={rule.options.some((option: any) => option.required)}><Stack gap={3}>{rule.options.filter((option: any) => !onLookupDestinations || !destinationFields[selected]?.includes(option.key)).map((option: any) => {
      const key = `${editKey}:${option.key}`, value = variant.options[option.key], input = optionInputs[key] ?? (option.type === 'json' ? value === undefined ? '' : JSON.stringify(value, null, 2) : option.type === 'string-list' ? (value || []).join('\n') : value ?? '');
      if (option.type === 'json') return <Stack key={key} gap={1}><StructuredOption label={option.label} schema={option.schema} value={value} onChange={next => updateOption(option.key, next)} onInvalid={message => setOptionErrors(previous => ({ ...previous, [key]: message }))}/>{option.help && <Text tone="muted" size="sm">{option.help}</Text>}{optionErrors[key] && <Alert tone="danger" variant="inline">{optionErrors[key]}</Alert>}</Stack>;
      return <Field key={key} label={option.label} required={option.required} description={option.help} error={optionErrors[key] || undefined}>{option.type === 'boolean' ? <Select value={value === undefined ? '' : String(value)} onChange={event => updateOption(option.key, event.target.value === '' ? undefined : event.target.value === 'true')}><Option value="">Platform default</Option><Option value="true">On</Option><Option value="false">Off</Option></Select> : option.type === 'select' ? <Select value={value ?? ''} onChange={event => updateOption(option.key, event.target.value || undefined)}><Option value="">Platform default</Option>{option.values?.map((choice: any) => <Option key={typeof choice === 'object' ? choice.value : choice} value={typeof choice === 'object' ? choice.value : choice}>{typeof choice === 'object' ? choice.label : choice}</Option>)}</Select> : ['textarea', 'string-list', 'json'].includes(option.type) ? <Textarea value={input} maxLength={option.maxLength || 20000} onChange={event => { const raw = event.target.value; setOptionInputs(previous => ({ ...previous, [key]: raw })); if (option.type === 'json') { try { updateOption(option.key, raw.trim() ? JSON.parse(raw) : undefined); setOptionErrors(previous => ({ ...previous, [key]: '' })); } catch { setOptionErrors(previous => ({ ...previous, [key]: `${rule.label}: ${option.label} must contain valid JSON.` })); } } else updateOption(option.key, raw.trim() ? option.type === 'string-list' ? raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : raw : undefined); }}/> : <Input type={option.type === 'number' ? 'number' : 'text'} value={input} maxLength={option.maxLength} min={option.min} max={option.max} step={option.type === 'number' ? 'any' : undefined} onChange={event => updateOption(option.key, event.target.value === '' ? undefined : option.type === 'number' ? Number(event.target.value) : event.target.value)}/>}</Field>;
    })}</Stack></Disclosure>}
    <ValidationSummary title={`${rule.label} restriction checks`} items={[{ id: editKey, target: editingAccount ? `${accountLabel(editingAccount)} · ${rule.label}` : rule.label, status: errors.length ? 'error' : warnings.length ? 'warning' : 'ok', messages: errors.length || warnings.length ? issueMessages(errors, warnings) : [{ id: 'ok', text: 'No known caption or media restriction failed.' }] }]}/>
    {editingAccountId && <DateTimeField label="Separate account time (your local timezone, optional)" timeZoneLabel={browserTimeZone} disabled={!!queueId || !scheduledAt} value={localTime(accountOverrides[editingAccountId]?.scheduledAt)} onValueChange={value => { setAccountOverrides(previous => ({ ...previous, [editingAccountId]: { ...previous[editingAccountId], platform: selected, scheduledAt: value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : '' } })); }} description="Leave empty to use the planned post time. Choose a fixed post time first. Separate times are unavailable for immediate publishing and queues."/>}
    {editingAccountId && accountOverrides[editingAccountId]?.scheduledAt && <Text tone="muted" size="sm">This account: {new Date(accountOverrides[editingAccountId].scheduledAt!).toLocaleString()}</Text>}
    <SegmentedControl label="Preview size" value={previewSize} onValueChange={value => setPreviewSize(value === 'mobile' ? 'mobile' : 'desktop')} options={[{ value: 'mobile', label: 'Mobile' }, { value: 'desktop', label: 'Desktop' }]}/>
    <PostVariantPreview size={previewSize} platform={selected} variant={variant} accountName={editingAccount ? accountLabel(editingAccount) + ' · ' + editingAccountId : activeAccounts.filter(account => account.platform === selected && selectedAccounts.includes(accountId(account))).map(accountLabel).join(', ') || 'Your brand'} scheduled={!!scheduledAt || !!queueId}/>
  </Stack>;
  const actions = <>{onDelete && canWrite && !readOnly && !post?.externalId && post?.status !== 'published' && <Button variant="danger" disabled={busy || saving} onClick={onDelete}>Delete</Button>}<Button variant="secondary" disabled={saving} onClick={onCancel}>{readOnly || !canWrite ? 'Close' : 'Cancel'}</Button>{!disabled || busy || saving ? <Button variant="primary" type="submit" form={formId} disabled={disabled}>{saving || busy ? 'Saving…' : post ? 'Save changes' : 'Save draft'}</Button> : null}</>;
  return <Form id={formId} onSubmit={(_, event) => submit(event)}>
    <Input type="hidden" name="draftSnapshot" readOnly value={JSON.stringify(values)}/>
    <VisuallyHidden as="h3" tabIndex={-1} ref={headingRef}>Post composer</VisuallyHidden>
    {error && <Alert tone="danger">{error}</Alert>}
    <Text tone="muted">Start with shared content, then tailor captions, media, options and times for each platform or connected account. Save a draft at any stage; publishing checks every selected destination.</Text>
    <Stack as="fieldset" gap={8} disabled={disabled}>
      <Stack as="section" gap={3}><Heading level={3}>1. Choose destinations</Heading>
        <CheckboxGroup legend="Social platforms" orientation="horizontal" disabled={providerPost} value={platforms} onValueChange={next => { const changed = next.find(platform => !platforms.includes(platform)) || platforms.find(platform => !next.includes(platform)); if (changed) togglePlatform(changed); }} options={Object.entries(PLATFORM_RULES).filter(([platform, config]) => config.supported || platforms.includes(platform)).map(([platform, config]: [string, any]) => ({ value: platform, label: config.label + (config.supported ? '' : ' (posting unavailable)') }))}/>
        {onLoadGroups && !providerPost && <AccountGroupPicker load={onLoadGroups} disabled={disabled || loadingAccounts} onChoose={(members, directory) => { setGroupAccounts(directory); setAccountsTouched(true); setAccounts(members.map(accountId)); setPlatforms([...new Set(members.map(row => row.platform))]); setActivePlatform(members[0]?.platform || ''); setActiveAccount(''); setProviderCheck(null); }}/>}
        {onLoadAccounts && <Inline><Button variant="secondary" disabled={disabled || loadingAccounts || providerPost} onClick={loadAccounts}>{loadingAccounts ? 'Loading channels…' : 'Load connected channels'}</Button></Inline>}
        {activeAccounts.length > 0 ? <DestinationPicker label="Connected accounts" readOnly={providerPost} accounts={activeAccounts.map(account => ({ id: accountId(account), name: accountLabel(account), provider: PLATFORM_RULES[account.platform].label }))} selectedIds={selectedAccounts} onSelectionChange={ids => { setAccountsTouched(true); setAccounts(ids); }}/> : <Text tone="muted" size="sm">Load connected channels to choose accounts. You can save platform drafts before connecting.</Text>}
        {providerPost && <Text tone="muted" size="sm">Destinations are fixed for this provider post. Caption, media, options and timing changes update the existing unpublished post.</Text>}
        {platforms.some(platform => !selectedAccounts.some(id => socialAccounts.find(account => accountId(account) === id)?.platform === platform)) && <Alert tone="warning" variant="inline">Choose an account for every platform before publishing. If accounts have not been loaded, existing account IDs are retained.</Alert>}
      </Stack>
      <Stack as="section" gap={3}><Heading level={3}>2. Shared content</Heading>
        <Field label="Shared caption" description="Platforms inherit this caption until you enable a separate caption below."><Textarea value={content} maxLength={100000} onChange={event => setContent(event.target.value)} placeholder="Write your main message…"/></Field>
        {onShortenLinks && <Stack gap={1}><Inline><Button variant="secondary" disabled={disabled} onClick={shortenLinks}>{shortening ? 'Creating short links…' : 'Shorten caption links'}</Button></Inline><Text tone="muted" size="sm">Uses this project’s short domain for shared and separate captions. Review the result before saving; media delivery URLs stay intact.</Text></Stack>}
        {platforms.includes('youtube') && <Field label="YouTube keyword tags" description="One keyword per line or separated by commas. Shared by every selected YouTube channel. Maximum 100 characters per keyword and 500 combined. These keywords are separate from caption hashtags." error={tagErrors.length ? tagErrors.map((item: any) => item.message).join(' ') : undefined}><Textarea value={tagInput} maxLength={20000} onChange={event => setTagInput(event.target.value)}/></Field>}
        <Field label="Shared media source"><Select value={baseMode} onChange={event => setBaseMode(event.target.value)}><Option value="none">Text only / no shared media</Option><Option value="asset">Asset library</Option><Option value="custom">Custom media URLs</Option></Select></Field>
        {baseMode === 'asset' && <Field label="Shared creative asset"><Select value={assetId} onChange={event => setAssetId(event.target.value)}><Option value="">Choose an asset</Option>{assets.map(asset => <Option key={asset.id} value={asset.id}>{asset.name} · {asset.kind}{asset.approval !== 'approved' ? ' · Approval required' : ''}</Option>)}</Select></Field>}
        {baseMode === 'custom' && <MediaEditor items={baseMedia} onChange={setBaseMedia} label="Shared" disabled={disabled} onInspect={onInspectMedia}/>}
      </Stack>
      {!!platforms.length && <Stack as="section" gap={3}><Heading level={3}>3. Customise each platform</Heading>
        <Tabs label="Platform customisation" value={selected} onValueChange={setActivePlatform} keepMounted={false} items={platforms.map(platform => ({ value: platform, label: <>{PLATFORM_RULES[platform]?.label || platform}{checks.errors.some((item: any) => item.platform === platform) && <> <Badge tone="danger">Needs a fix</Badge></>}{Object.keys(overrides[platform] || {}).some(key => key !== 'options' || Object.keys(overrides[platform]?.options || {}).length) && <> <Badge>Custom</Badge></>}</>, content: platform === selected ? panel : undefined }))}/>
      </Stack>}
      <Stack as="section" gap={3}><Heading level={3}>4. Campaign and timing</Heading>
        <Field label="Campaign"><Select disabled={providerPost} value={campaignId} onChange={event => setCampaignId(event.target.value)}><Option value="">No campaign</Option>{campaigns.map(campaign => <Option value={campaign.id} key={campaign.id}>{campaign.name}</Option>)}</Select></Field>
        <DateTimeField label="Plan for (your local timezone, optional)" timeZoneLabel={browserTimeZone} disabled={!!queueId} value={scheduledAt} onValueChange={setScheduledAt} description={`${scheduledAt ? `Planned for ${new Date(scheduledAt).toLocaleString()}. ` : ''}${providerPost ? 'Accounts without a separate time use this planned time. Clear every separate account time before returning the provider post to an unpublished draft.' : 'Saving keeps the post local. Choose Publish or Schedule in Publishing to submit it to Zernio.'}`}/>
        <Inline gap={2} role="group" aria-label="Quick schedule times">{schedulePresets.map(preset => <Button key={preset.key} variant="secondary" size="sm" disabled={!!queueId} onClick={() => setScheduledAt(presetTime(preset.key))}>{preset.label}</Button>)}</Inline>
      </Stack>
      {!providerPost && (onLoadQueues || queueId) && <Stack as="section" gap={3}><Heading level={3}>Publishing queue</Heading>
        {onLoadQueues && <Inline><Button variant="secondary" disabled={disabled || loadingQueues} onClick={async () => { if (loadingQueues) return; setLoadingQueues(true); setError(''); try { const result = await onLoadQueues(); if (alive.current) setQueues(result.queues || []); } catch (failure) { if (alive.current) setError((failure as Error).message || 'Publishing queues could not be loaded.'); } finally { if (alive.current) setLoadingQueues(false); } }}>{loadingQueues ? 'Loading queues…' : 'Load publishing queues'}</Button></Inline>}
        <Field label="Queue for this post"><Select value={queueId} onChange={event => { const selected = queues.find(row => row._id === event.target.value); setQueueId(selected?._id || ''); setQueueVersion(selected?.version || ''); if (selected) setScheduledAt(''); setProviderCheck(null); }}><Option value="">No queue · use the planned time above</Option>{queueId && !queues.some(row => row._id === queueId) && <Option value={queueId}>Saved queue · {queueId} (load to verify)</Option>}{queues.map(row => <Option key={row._id} value={row._id} disabled={!row.active || !row.slots?.length}>{row.name} · {row.timezone}{row.isDefault ? ' · Default' : ''}{!row.active ? ' · Paused' : ''}</Option>)}</Select></Field>
        {queueId && queues.some(row => row._id === queueId && row.version !== queueVersion) && <ReviewConfirm title="This queue changed since you selected it" reviewKey={`${queueId}:${selectedQueue?.version}`} acknowledgements={[]} confirmLabel="Use reviewed queue settings" onConfirm={() => { setQueueVersion(queues.find(row => row._id === queueId)?.version || ''); setProviderCheck(null); }}><Text>Review its schedule, then save the new queue settings and obtain approval again if required.</Text></ReviewConfirm>}
        <Text tone="muted" size="sm">Saving keeps this post local. Submit it from Publishing or Queues after approval. Zernio reserves the next free slot when the post is submitted; preview times are not reservations. Choosing a queue clears a fixed planned time.</Text>
        {queueId && selectedQueue && <Text tone="muted" size="sm">Weekly slots ({selectedQueue.timezone}): {selectedQueue.slots.map((slot: any) => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][slot.dayOfWeek] + ' ' + slot.time).join(', ') || 'None'}</Text>}
        {queueId && selectedQueue && nextSlot && <StatusLine>Next weekly slot (preview): {new Intl.DateTimeFormat(undefined, { timeZone: selectedQueue.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(nextSlot)} ({selectedQueue.timezone}). Zernio reserves the next free slot only when the post is submitted, so this time may already be taken.</StatusLine>}
      </Stack>}
      <Stack as="section" gap={3}>
        <ValidationSummary title="Publishing checks" emptyMessage="Choose a platform to check your post." items={destinationChecks.map(check => { const account = check.accountId ? accounts.find(row => accountId(row) === check.accountId) : undefined; return { id: check.platform + ':' + (check.accountId || ''), target: (PLATFORM_RULES[check.platform]?.label || check.platform) + (check.accountId ? ' · ' + (account ? accountLabel(account) : check.accountId) : ''), status: check.errors.length ? 'error' : check.warnings.length ? 'warning' : 'ok', messages: issueMessages(check.errors, check.warnings) }; })}/>
        <Text tone="muted" size="sm">{checks.errors.length ? 'You can save this draft and finish it later.' : 'The provider verifies account permissions, media encoding and current platform rules when you submit.'}{checks.warnings.length ? ` ${checks.warnings.length} item${checks.warnings.length === 1 ? '' : 's'} still need verification.` : ''}</Text>
        {onValidate && <ValidationSummary title="Zernio check" emptyMessage="Not checked with Zernio yet." busy={checking} stale={providerStale} onRecheck={disabled || !platforms.length ? undefined : checkWithProvider} recheckLabel="Check with Zernio again" items={providerCheck ? [{ id: 'zernio', target: providerPassed ? 'Zernio checks passed' : providerFailed ? 'Zernio found restrictions' : 'Zernio check completed', status: providerPassed ? providerWarnings.length ? 'warning' : 'ok' : providerFailed ? 'error' : 'warning', messages: providerMessages }] : []}/>}
        {onValidate && !providerCheck && <Inline><Button variant="secondary" disabled={disabled || checking || !platforms.length} onClick={checkWithProvider}>{checking ? 'Checking with Zernio…' : 'Check with Zernio'}</Button></Inline>}
      </Stack>
    </Stack>
    {actionsHost ? createPortal(actions, actionsHost) : <FormActions>{actions}</FormActions>}
  </Form>;
}
