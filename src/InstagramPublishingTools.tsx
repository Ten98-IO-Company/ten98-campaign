import { useEffect, useRef, useState } from 'react';

export type InstagramPublishingToolsProps = {
  account: { id?: string; _id?: string; displayName?: string; username?: string; metadata?: { loginMethod?: string } } | null;
  mediaItems: { type: string; [key: string]: any }[];
  options: Record<string, any>;
  disabled?: boolean;
  lookup: (accountId: string, resource: 'instagram-publishing-limit' | 'instagram-audio' | 'instagram-audio-lookup', params?: Record<string, string>) => Promise<any>;
  onChange: (options: Record<string, any>) => void;
};
type Audio = { audioId: string; title: string | null; audioType: 'music' | 'original_sound' | null; durationInMs: number | null; displayArtist: string | null; igUsername: string | null; isAdsEligible: boolean | null; downloadUrl: string | null; onPlatformAudioPreviewLink: string | null };
const validAudio = (row: any): row is Audio => !!row && /^\d{1,30}$/.test(row.audioId) && typeof row.audioId === 'string'
  && ['title', 'displayArtist', 'igUsername', 'downloadUrl', 'onPlatformAudioPreviewLink'].every(key => row[key] === null || typeof row[key] === 'string')
  && [null, 'music', 'original_sound'].includes(row.audioType) && (row.durationInMs === null || Number.isSafeInteger(row.durationInMs) && row.durationInMs >= 0)
  && (row.isAdsEligible === null || typeof row.isAdsEligible === 'boolean');

export default function InstagramPublishingTools({ account, mediaItems, options, disabled = false, lookup, onChange }: InstagramPublishingToolsProps) {
  const [query, setQuery] = useState(''), [audioType, setAudioType] = useState('music'), [audioId, setAudioId] = useState('');
  const [quota, setQuota] = useState<any>(null), [catalog, setCatalog] = useState<any>(null), [detail, setDetail] = useState<any>(null), [busy, setBusy] = useState<any>(null), [error, setError] = useState<any>(null), [notice, setNotice] = useState<any>(null);
  const id = account?._id || account?.id || '', label = account?.displayName || account?.username || id;
  const loginMethod = account?.metadata?.loginMethod === 'facebook_login' ? 'facebook_login' : 'instagram_login', facebookLogin = loginMethod === 'facebook_login';
  const accountScope = JSON.stringify([id, loginMethod]), scope = JSON.stringify([accountScope, mediaItems, options, query, audioType, audioId, disabled]);
  const current = useRef({ scope, lookup, onChange }), alive = useRef(true), pending = useRef<object | null>(null), selectionRevision = useRef(0);
  if (current.current.scope !== scope || current.current.lookup !== lookup || current.current.onChange !== onChange) current.current = { scope, lookup, onChange };
  const ticket = current.current, isCurrent = () => alive.current && current.current === ticket;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const loading = busy?.ticket === ticket, rows: Audio[] | null = catalog?.ticket === ticket ? catalog.rows : null, audio: Audio | null = detail?.ticket === ticket ? detail.audio : null;
  const eligible = mediaItems.length === 1 && mediaItems[0].type === 'video' && options.contentType !== 'story';
  const canUse = !!id && facebookLogin && eligible && !disabled && !loading && !!audio && audio.audioId === audioId && detail.revision === selectionRevision.current;

  async function read(resource: 'instagram-publishing-limit' | 'instagram-audio' | 'instagram-audio-lookup', trending = false) {
    if (!isCurrent() || disabled || !id || pending.current === ticket || resource !== 'instagram-publishing-limit' && !facebookLogin) return;
    if (resource === 'instagram-audio' && !trending && (!query.trim() || query.trim().length > 200)) { setError({ ticket, message: 'Enter a search query of 1–200 characters. Your draft is unchanged.' }); return; }
    if (resource === 'instagram-audio-lookup' && !/^\d{1,30}$/.test(audioId)) { setError({ ticket, message: 'Enter an audio ID of 1–30 digits. Your draft is unchanged.' }); return; }
    const revision = ++selectionRevision.current;
    pending.current = ticket; setBusy({ ticket, resource }); setError(null); setNotice(null);
    if (resource === 'instagram-audio') setCatalog(null);
    if (resource === 'instagram-audio-lookup') setDetail(null);
    try {
      const params: Record<string, string> | undefined = resource === 'instagram-audio' ? { audioType, ...(trending ? {} : { q: query.trim() }) } : resource === 'instagram-audio-lookup' ? { audioId } : undefined;
      const result = await lookup(id, resource, params);
      if (!isCurrent()) return;
      if (!result || result.accountId !== id || result.platform !== 'instagram' || result.loginMethod !== loginMethod) throw new Error('The Instagram account response could not be verified.');
      if (resource === 'instagram-publishing-limit') {
        if (!Number.isSafeInteger(result.quotaUsage) || result.quotaUsage < 0 || !Number.isSafeInteger(result.quotaTotal) || result.quotaTotal < 0 || !Number.isSafeInteger(result.quotaDurationSeconds) || result.quotaDurationSeconds <= 0) throw new Error('The Instagram publishing limit could not be verified.');
        setQuota({ accountScope, ...result });
      } else if (resource === 'instagram-audio') {
        if (!Array.isArray(result.audio) || result.audio.length > 100 || !result.audio.every(validAudio) || new Set(result.audio.map((row: Audio) => row.audioId)).size !== result.audio.length) throw new Error('The Instagram audio results could not be verified.');
        setCatalog({ ticket, rows: result.audio });
      } else {
        if (!validAudio(result.audio) || result.audio.audioId !== audioId) throw new Error('The requested Instagram audio could not be verified.');
        setDetail({ ticket, audio: result.audio, revision });
      }
    } catch (failure) {
      if (isCurrent()) setError({ ticket, message: `${(failure as Error).message || 'Instagram could not be read.'} Your draft is unchanged.` });
    } finally {
      if (pending.current === ticket) pending.current = null;
      if (isCurrent()) setBusy(null);
    }
  }
  function useAudio() {
    if (!isCurrent() || !canUse || !audio || pending.current === ticket || detail.revision !== selectionRevision.current) return;
    current.current = { ...ticket };
    onChange({ ...options, audioConfiguration: { ...options.audioConfiguration, audioId: audio.audioId } });
    setDetail(null); setNotice({ accountScope, message: `Audio ${audio.audioId} added to ${label} (${id}). Review and save the draft separately.` });
  }

  return <section className="post-tiktok-permissions" aria-label="Instagram publishing tools">
    <h4>Instagram publishing tools</h4>
    {!id ? <p className="field-help">Choose one Instagram account to read its publishing tools.</p> : <>
      <p className="field-help">Account: {label} · {id} · {facebookLogin ? 'Facebook Login' : 'Instagram Login'}</p>
      <button className="button" type="button" disabled={disabled || loading} onClick={() => read('instagram-publishing-limit')}>Read publishing limit</button>
      {quota?.accountScope === accountScope && <p role="status">Publishing quota: {quota.quotaUsage} / {quota.quotaTotal} used in the rolling {quota.quotaDurationSeconds}-second window. This is a snapshot; it does not reserve capacity or provide a reset time.</p>}
      {!facebookLogin ? <p className="field-help">Catalog audio requires a Facebook Login connection. This account uses Instagram Login; its publishing limit is still available.</p> : <>
        <h4>Find Instagram audio</h4>
        <label className="field"><span>Audio catalog type</span><select value={audioType} disabled={disabled} onChange={event => setAudioType(event.target.value)}><option value="music">Music</option><option value="original_sound">Original sound</option></select></label>
        <label className="field"><span>Audio search query</span><input value={query} maxLength={200} disabled={disabled} onChange={event => setQuery(event.target.value)}/></label>
        <button className="button" type="button" disabled={disabled || loading || !query.trim() || query.trim().length > 200} onClick={() => read('instagram-audio')}>Search audio</button>
        <button className="button" type="button" disabled={disabled || loading} onClick={() => read('instagram-audio', true)}>Read trending audio</button>
        {rows && (!rows.length ? <p>No audio returned for this request.</p> : <ul>{rows.map(row => <li key={row.audioId}><p>{row.title ?? 'Title not reported'} · {row.displayArtist ?? row.igUsername ?? 'Artist not reported'} · {row.audioId}</p><button className="button" type="button" disabled={disabled || loading} onClick={() => { if (isCurrent() && !disabled) setAudioId(row.audioId); }}>Choose audio ID {row.audioId}</button></li>)}</ul>)}
        <label className="field"><span>Instagram audio ID</span><input inputMode="numeric" maxLength={30} value={audioId} disabled={disabled} onChange={event => setAudioId(event.target.value)}/></label>
        <button className="button" type="button" disabled={disabled || loading || !/^\d{1,30}$/.test(audioId)} onClick={() => read('instagram-audio-lookup')}>Look up audio ID</button>
        {audio && <div>
          <p><strong>{audio.title ?? 'Title not reported'}</strong> · Audio ID: {audio.audioId}</p>
          <p>Type: {audio.audioType ?? 'Not reported'} · Artist: {audio.displayArtist ?? 'Not reported'} · Creator: {audio.igUsername ?? 'Not reported'}</p>
          <p>Duration: {audio.durationInMs === null ? 'Not reported' : `${audio.durationInMs} ms`} · Ad eligibility metadata: {audio.isAdsEligible === null ? 'Not reported' : audio.isAdsEligible ? 'Eligible' : 'Not eligible'}</p>
          <p style={{ overflowWrap: 'anywhere' }}>Download URL: {audio.downloadUrl ?? 'Not reported'}</p><p style={{ overflowWrap: 'anywhere' }}>Platform preview URL: {audio.onPlatformAudioPreviewLink ?? 'Not reported'}</p>
        </div>}
        {!eligible && <p className="field-help">Adding catalog audio requires a single video Reel. Choose one video and a format other than Story.</p>}
        <button className="button" type="button" disabled={!canUse} onClick={useAudio}>Use this audio for this account</button>
        <p className="field-help">Look up the current audio ID before choosing Use. Only Use changes this account’s draft audio ID and preserves its existing volume settings. Ad eligibility is provider metadata; it does not grant music rights or guarantee publishing. Preview and download URLs are shown as text.</p>
      </>}
    </>}
    {loading && <p className="field-help" role="status">Reading Instagram…</p>}
    {error?.ticket === ticket && <p className="post-validation-error" role="alert">{error.message}</p>}
    {notice?.accountScope === accountScope && <p className="field-help" role="status">{notice.message}</p>}
    <p className="field-help">Reads do not change your draft, account settings or published posts.</p>
  </section>;
}
