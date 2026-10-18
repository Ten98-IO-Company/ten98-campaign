import React, { useMemo, useRef, useState } from 'react';
import { PLATFORM_RULES, captionLimitForVariant, countCaption, normalizePostVariants, publicMediaUrl, resolveVariant, validatePostForPlatforms } from '../shared/social-posts.mjs';
import './post-composer.css';

type Row = { id: string; [key: string]: any };
type MediaItem = { type: 'image' | 'video' | 'gif' | 'document'; url: string; [key: string]: any };
type Override = { content?: string; mediaItems?: MediaItem[]; assetId?: string; options?: Record<string, any> };
type Props = {
  post?: Row; assets?: Row[]; campaigns?: Row[]; accounts?: Row[]; canWrite: boolean;
  onSubmit: (values: Record<string, any>) => Promise<any>; onCancel?: () => void; onDelete?: () => void;
  onValidate?: (values: Record<string, any>) => Promise<any>;
  onLoadAccounts?: () => Promise<any>; onInspectMedia?: (item: MediaItem) => Promise<any>; providerPost?: boolean;
  onTikTokInfo?: (accountId: string, mediaType: 'video' | 'photo') => Promise<any>;
  busy?: boolean; readOnly?: boolean; initialScheduledAt?: string;
};
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const localTime = (value = '') => value && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value) - new Date(value).getTimezoneOffset() * 60000).toISOString().slice(0, 16) : '';
const accountId = (account: Row) => String(account._id || account.id);
const accountLabel = (account: Row) => account.displayName || account.username || account.name || accountId(account);
function previewUrl(value: string) {
  try { return publicMediaUrl(value); } catch { return ''; }
}
const bytesLabel = (size: number) => size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : `${Math.round(size / 1024)} KB`;

function MediaEditor({ items, onChange, label, disabled, onInspect }: { items: MediaItem[]; onChange: (items: MediaItem[]) => void; label: string; disabled?: boolean; onInspect?: (item: MediaItem) => Promise<any> }) {
  const [inspecting, setInspecting] = useState(-1), [notice, setNotice] = useState('');
  const current = useRef(items); current.current = items;
  function update(index: number, patch: Record<string, any>) { onChange(current.current.map((item, position) => position === index ? Object.fromEntries(Object.entries({ ...item, ...patch }).filter(([, value]) => value !== undefined)) as MediaItem : item)); }
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
  return <div className="post-media-editor">
    {items.map((item, index) => <section className="post-media-row" key={index} aria-label={`${label} media ${index + 1}`}>
      <div className="post-media-heading"><strong>Media {index + 1}</strong><div className="button-wrap">
        <button className="button" type="button" disabled={disabled || index === 0} aria-label={`Move ${label} media ${index + 1} earlier`} onClick={() => { const moved = [...items]; [moved[index - 1], moved[index]] = [moved[index], moved[index - 1]]; onChange(moved); }}>↑</button>
        <button className="button" type="button" disabled={disabled || index === items.length - 1} aria-label={`Move ${label} media ${index + 1} later`} onClick={() => { const moved = [...items]; [moved[index + 1], moved[index]] = [moved[index], moved[index + 1]]; onChange(moved); }}>↓</button>
        <button className="button" type="button" disabled={disabled} onClick={() => onChange(items.filter((_, position) => position !== index))} aria-label={`Remove ${label} media ${index + 1}`}>Remove</button>
      </div></div>
      <div className="form-grid"><label className="field"><span>{label} media {index + 1} type</span><select value={item.type} onChange={event => update(index, { type: event.target.value, width: undefined, height: undefined, duration: undefined })}><option value="image">Image</option><option value="video">Video</option><option value="gif">Animated GIF</option><option value="document">Document / PDF</option></select></label>
        <label className="field"><span>{label} media {index + 1} URL</span><input type="url" value={item.url} maxLength={4000} required placeholder="https://cdn.example.com/creative.jpg" onChange={event => { const { width, height, duration, size, mimeType, ...rest } = item; onChange(items.map((media, position) => position === index ? { ...rest, url: event.target.value } : media)); }}/></label></div>
      <label className="field"><span>{label} media {index + 1} alt text</span><input value={item.altText || ''} maxLength={1500} onChange={event => update(index, { altText: event.target.value || undefined })} placeholder="Describe the image for people using screen readers"/></label>
      <div className="post-media-facts">{item.width > 0 && item.height > 0 && <span>{item.width} × {item.height} px</span>}{item.duration > 0 && <span>{Number(item.duration.toFixed(2))} seconds</span>}{item.size > 0 && <span>{bytesLabel(item.size)}</span>}
        {['image', 'gif', 'video'].includes(item.type) && <button className="text-link" type="button" disabled={disabled || inspecting !== -1 || !previewUrl(item.url)} onClick={() => inspect(index)}>{inspecting === index ? 'Reading metadata…' : 'Check dimensions'}</button>}{onInspect && <button className="text-link" type="button" disabled={disabled || inspecting !== -1 || !previewUrl(item.url)} onClick={() => inspectWithProvider(index)}>Check file with Zernio</button>}</div>
      <details className="post-media-details"><summary>Media details and metadata</summary><p className="field-help">Use the file’s actual values. Unknown dimensions, duration, size and encoding cannot be fully checked until the provider reads the file.</p>
        <div className="form-grid">{[['width', 'Width (pixels)'], ['height', 'Height (pixels)'], ['duration', 'Duration (seconds)'], ['size', 'File size (bytes)']].map(([key, fieldLabel]) => <label className="field" key={key}><span>{label} media {index + 1} {fieldLabel}</span><input type="number" min={key === 'duration' ? 0.001 : 1} step={key === 'duration' ? 'any' : 1} value={item[key] ?? ''} onChange={event => update(index, { [key]: event.target.value === '' ? undefined : Number(event.target.value) })}/></label>)}</div>
        <div className="form-grid"><label className="field"><span>{label} media {index + 1} MIME type</span><input value={item.mimeType || ''} maxLength={100} placeholder={item.type === 'video' ? 'video/mp4' : item.type === 'document' ? 'application/pdf' : 'image/jpeg'} onChange={event => update(index, { mimeType: event.target.value || undefined })}/></label><label className="field"><span>{label} media {index + 1} title</span><input value={item.title || ''} maxLength={300} onChange={event => update(index, { title: event.target.value || undefined })}/></label></div>
        {item.type === 'video' && <label className="field"><span>{label} media {index + 1} thumbnail URL</span><input type="url" value={item.thumbnail || ''} maxLength={4000} onChange={event => update(index, { thumbnail: event.target.value || undefined })}/></label>}
      </details>
    </section>)}
    {notice && <p className="post-media-notice" role="status">{notice}</p>}
    <button className="button" type="button" disabled={disabled || items.length >= 35} onClick={() => onChange([...items, { type: 'image', url: '' }])}>Add {items.length ? 'another ' : ''}media URL</button>
    {!items.length && <p className="field-help post-inline-help">No media. Platforms that require an image or video will show a restriction below.</p>}
  </div>;
}

function CaptionPreview({ content, platform }: { content: string; platform: string }) {
  const [expanded, setExpanded] = useState(false), cutoff = ['instagram', 'tiktok', 'threads'].includes(platform) ? 180 : 300;
  const shown = !expanded && content.length > cutoff ? content.slice(0, cutoff) + '…' : content;
  return <><p className="post-preview-caption">{shown ? shown.split(/(https?:\/\/[^\s]+|#[\p{L}\p{N}_]+)/u).map((part, index) => /^https?:\/\//.test(part) || /^#/.test(part) ? <span className="post-preview-link" key={index}>{part}</span> : part) : 'Your caption will appear here.'}</p>{content.length > cutoff && <button className="text-link" type="button" onClick={() => setExpanded(!expanded)}>{expanded ? 'Show less' : 'Show full caption'}</button>}</>;
}

function PreviewMedia({ item }: { item: MediaItem }) {
  const [failed, setFailed] = useState(false), url = previewUrl(item.url);
  if (!url || failed || ['drive.google.com', 'docs.google.com'].includes(new URL(url).hostname)) return <div className="post-preview-placeholder">{item.type === 'video' ? 'Video' : item.type === 'document' ? 'Document' : 'Image'} preview unavailable<span>Use a direct public media URL.</span></div>;
  return ['image', 'gif'].includes(item.type) ? <img src={url} alt={item.altText || 'Post image'} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)}/> : item.type === 'video' ? <video src={url} controls preload="metadata" poster={previewUrl(item.thumbnail || '') || undefined} onError={() => setFailed(true)}/> : <div className="post-preview-placeholder">Document attachment<span>{item.title || item.filename || 'PDF / document'}</span></div>;
}

const optionLabel = (key: string) => key.replace(/([a-z])([A-Z])/g, '$1 $2').replaceAll('_', ' ').replace(/^./, character => character.toUpperCase());
function StructuredOption({ schema, value, onChange, label, onInvalid, depth = 0 }: { schema: Record<string, any>; value: any; onChange: (value: any) => void; label: string; onInvalid: (message: string) => void; depth?: number }) {
  const [raw, setRaw] = useState(value === undefined ? '' : JSON.stringify(value, null, 2));
  if (schema.oneOf || depth > 5 || schema.type === 'object' && !schema.properties) return <label className="field"><span>{label} (advanced format)</span><textarea value={raw} onChange={event => { const input = event.target.value; setRaw(input); try { onChange(input.trim() ? JSON.parse(input) : undefined); onInvalid(''); } catch { onInvalid(`${label} must contain valid JSON.`); } }}/></label>;
  if (schema.type === 'object' || schema.properties) return <fieldset className="post-nested-option"><legend>{label}</legend><label className="checkbox-label"><input type="checkbox" checked={value !== undefined} onChange={event => { onChange(event.target.checked ? {} : undefined); onInvalid(''); }}/>Enable {label}</label>{value !== undefined && Object.entries(schema.properties || {}).map(([key, field]: [string, any]) => <StructuredOption key={key} label={`${label} · ${optionLabel(key)}`} schema={field} value={value?.[key]} depth={depth + 1} onInvalid={onInvalid} onChange={next => { const updated = { ...value }; next === undefined ? delete updated[key] : updated[key] = next; onChange(updated); }}/>)}</fieldset>;
  if (schema.type === 'array') return <fieldset className="post-nested-option"><legend>{label}</legend>{(value || []).map((item: any, index: number) => <div key={index} className="post-option-array-item"><StructuredOption label={`${label} ${index + 1}`} schema={schema.items || { type: 'string' }} value={item} depth={depth + 1} onInvalid={onInvalid} onChange={next => onChange(next === undefined ? value.filter((_: any, position: number) => position !== index) : value.map((previous: any, position: number) => index === position ? next : previous))}/><button className="button" type="button" aria-label={`Remove ${label} ${index + 1}`} onClick={() => onChange(value.filter((_: any, position: number) => position !== index))}>Remove</button></div>)}<button className="button" type="button" disabled={(value || []).length >= (schema.maxItems || 100)} onClick={() => onChange([...(value || []), schema.items?.type === 'object' ? {} : schema.items?.type === 'array' ? [] : schema.items?.enum?.[0] ?? ''])}>Add {label.toLowerCase()} item</button>{value !== undefined && <button className="text-link post-clear-option" type="button" onClick={() => { onChange(undefined); onInvalid(''); }}>Clear {label.toLowerCase()}</button>}</fieldset>;
  return <label className="field"><span>{label}</span>{schema.type === 'boolean' ? <select value={value === undefined ? '' : String(value)} onChange={event => onChange(event.target.value === '' ? undefined : event.target.value === 'true')}><option value="">Platform default</option><option value="true">On</option><option value="false">Off</option></select> : schema.enum ? <select value={value ?? ''} onChange={event => onChange(event.target.value === '' ? undefined : schema.type === 'integer' ? Number(event.target.value) : event.target.value)}><option value="">Choose an option</option>{schema.enum.map((choice: any) => <option value={choice} key={choice}>{String(choice)}</option>)}</select> : <input value={value ?? ''} type={['number', 'integer'].includes(schema.type) ? 'number' : schema.format === 'uri' ? 'url' : 'text'} min={schema.minimum} max={schema.maximum} step={schema.type === 'integer' ? 1 : schema.type === 'number' ? 'any' : undefined} maxLength={schema.maxLength || 50000} onChange={event => onChange(event.target.value === '' ? undefined : ['number', 'integer'].includes(schema.type) ? Number(event.target.value) : event.target.value)}/>}</label>;
}

export function PostVariantPreview({ platform, variant, accountName = 'Your brand', scheduled = false }: { platform: string; variant: { content: string; mediaItems: MediaItem[]; options?: Record<string, any> }; accountName?: string; scheduled?: boolean }) {
  const options = variant.options || {}, rule = PLATFORM_RULES[platform];
  const entries: { content?: string; mediaItems?: MediaItem[] }[] = options.threadItems?.length ? options.threadItems : [variant];
  const pollAnswers = options.poll?.options || options.poll?.answers?.map((answer: any) => answer.poll_media?.text || 'Poll answer') || [];
  return <section className={`post-preview post-preview-${platform}`} aria-label={`${rule?.label || platform} post preview`}>
    <div className="post-preview-heading"><span className="post-preview-avatar">{accountName.slice(0, 1).toUpperCase()}</span><div><strong>{accountName}</strong><small>{rule?.label || platform} · {options.postType || options.mediaType || options.contentType || 'Post'}{scheduled ? ' · Planned' : ''}</small></div></div>
    {options.title && <h4>{options.title}</h4>}{entries.map((entry, position) => <article className={entries.length > 1 ? 'post-preview-thread-item' : undefined} key={platform + ':' + position}>
      {entries.length > 1 && <small>Thread · Post {position + 1} of {entries.length}</small>}
      {!['instagram', 'tiktok', 'pinterest'].includes(platform) && <CaptionPreview content={entry.content || ''} platform={platform}/>}
      {!!entry.mediaItems?.length && <div className="post-preview-media">{entry.mediaItems.map((item: MediaItem, index: number) => <figure key={item.url + ':' + index}><PreviewMedia item={item}/>{entry.mediaItems!.length > 1 && <figcaption>{index + 1} / {entry.mediaItems!.length}</figcaption>}</figure>)}</div>}
      {['instagram', 'tiktok', 'pinterest'].includes(platform) && <CaptionPreview content={entry.content || ''} platform={platform}/>}
    </article>)}
    {options.poll && <div className="post-preview-poll"><strong>{typeof options.poll.question === 'string' ? options.poll.question : options.poll.question?.text || 'Poll'}</strong>{pollAnswers.map((answer: string, index: number) => <p key={index}>{answer}</p>)}<small>Poll preview · Voting opens on the platform after publication.</small></div>}
    {options.firstComment && <p className="post-preview-comment"><strong>First comment</strong>{options.firstComment}</p>}
    <p className="post-preview-note">Content preview. Actual layout, cropping, links and controls depend on the platform and device.</p>
  </section>;
}

export default function PostComposer({ post, assets = [], campaigns = [], accounts = [], canWrite, onSubmit, onCancel, onDelete, onValidate, onLoadAccounts, onInspectMedia, onTikTokInfo, providerPost = false, busy = false, readOnly = false, initialScheduledAt }: Props) {
  const [content, setContent] = useState(post?.content || ''), [platforms, setPlatforms] = useState<string[]>(post?.platforms || []), [selectedAccounts, setAccounts] = useState<string[]>(post?.accounts || []);
  const [assetId, setAssetId] = useState(post?.assetId || ''), [campaignId, setCampaignId] = useState(post?.campaignId || ''), [scheduledAt, setScheduledAt] = useState(localTime(post?.scheduledAt) || initialScheduledAt || '');
  const [baseMode, setBaseMode] = useState(Array.isArray(post?.mediaItems) ? post.mediaItems.length ? 'custom' : 'none' : post?.assetId ? 'asset' : 'none'), [baseMedia, setBaseMedia] = useState<MediaItem[]>(post?.mediaItems || []);
  const [overrides, setOverrides] = useState<Record<string, Override>>(post?.platformOverrides || {}), [activePlatform, setActivePlatform] = useState(post?.platforms?.[0] || ''), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const [optionInputs, setOptionInputs] = useState<Record<string, string>>({}), [optionErrors, setOptionErrors] = useState<Record<string, string>>({});
  const [platformMediaModes, setPlatformMediaModes] = useState<Record<string, string>>({}), [checking, setChecking] = useState(false), [providerCheck, setProviderCheck] = useState<{ signature: string; result: any } | null>(null);
  const [accountsTouched, setAccountsTouched] = useState(false), [loadingAccounts, setLoadingAccounts] = useState(false);
  const [tikTokPermissions, setTikTokPermissions] = useState<Record<string, { mediaType: string; result: any }>>({}), [loadingTikTok, setLoadingTikTok] = useState(false);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({}), headingRef = useRef<HTMLHeadingElement>(null);
  const disabled = busy || saving || !canWrite || readOnly || post?.status === 'published' || !!post?.externalId && !providerPost;
  const selected = platforms.includes(activePlatform) ? activePlatform : platforms[0] || '', rule = PLATFORM_RULES[selected], override = overrides[selected] || {};
  const values = useMemo(() => ({ content, platforms, ...(post?.accounts !== undefined || accountsTouched || accounts.some(account => platforms.includes(account.platform) && PLATFORM_RULES[account.platform] && account.isActive !== false) ? { accounts: selectedAccounts } : {}), assetId: baseMode === 'asset' ? assetId : '', campaignId, scheduledAt: scheduledAt && Number.isFinite(Date.parse(scheduledAt)) ? new Date(scheduledAt).toISOString() : '', status: scheduledAt ? 'scheduled' : 'draft', mediaItems: baseMode === 'asset' ? null : baseMode === 'custom' ? baseMedia : [], platformOverrides: Object.fromEntries(Object.entries(overrides).filter(([platform]) => platforms.includes(platform))) }), [content, platforms, selectedAccounts, accountsTouched, accounts, post?.accounts, baseMode, assetId, campaignId, scheduledAt, baseMedia, overrides]);
  const checks = validatePostForPlatforms(values, platforms, { assets }), variant = selected ? resolveVariant(values, selected, assets) : null;
  const errors = checks.errors.filter((item: any) => item.platform === selected), warnings = checks.warnings.filter((item: any) => item.platform === selected);
  const socialAccounts = accounts.filter(account => PLATFORM_RULES[account.platform] && account.isActive !== false), activeAccounts = socialAccounts.filter(account => platforms.includes(account.platform));
  function changeOverride(patch: Override, remove: string[] = []) {
    setOverrides(previous => { const next: Record<string, any> = { ...previous[selected], ...patch }; for (const key of remove) delete next[key]; return { ...previous, [selected]: next }; });
  }
  function togglePlatform(platform: string) {
    if (platforms.includes(platform)) { setPlatforms(platforms.filter(value => value !== platform)); setAccounts(selectedAccounts.filter(id => socialAccounts.find(account => accountId(account) === id)?.platform !== platform)); }
    else { setPlatforms([...platforms, platform]); setActivePlatform(platform); }
  }
  function updateOption(key: string, value: any) {
    const options = { ...override.options }; value === undefined ? delete options[key] : options[key] = value;
    changeOverride({ options });
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (disabled) return; setError('');
    try {
      if (!platforms.length) throw new Error('Choose at least one social platform.');
      const invalid = Object.entries(optionErrors).find(([key, value]) => value && platforms.includes(key.split(':')[0]));
      if (invalid) throw new Error(invalid[1]);
      normalizePostVariants(values);
      setSaving(true); await onSubmit(values);
    } catch (failure) { setError((failure as Error).message || 'Your draft could not be saved. Your entries are still here.'); headingRef.current?.focus(); } finally { setSaving(false); }
  }
  async function checkWithProvider() {
    if (!onValidate || checking || disabled) return;
    const signature = JSON.stringify(values); setChecking(true); setError('');
    try { normalizePostVariants(values); const result = await onValidate(values); setProviderCheck({ signature, result }); }
    catch (failure) { setProviderCheck({ signature, result: { valid: false, errors: [{ message: (failure as Error).message || 'Zernio could not check this post.' }] } }); }
    finally { setChecking(false); }
  }
  async function loadAccounts() {
    if (!onLoadAccounts || loadingAccounts) return; setLoadingAccounts(true); setError('');
    try { await onLoadAccounts(); } catch (failure) { setError((failure as Error).message || 'Connected channels could not be loaded.'); } finally { setLoadingAccounts(false); }
  }
  async function loadTikTokPermissions() {
    const destinations = socialAccounts.filter(account => account.platform === 'tiktok' && selectedAccounts.includes(accountId(account)));
    if (!onTikTokInfo || loadingTikTok || !destinations.length) return;
    const mediaType = variant?.mediaItems.some(item => item.type === 'video') ? 'video' : 'photo'; setLoadingTikTok(true); setError('');
    try {
      const results = await Promise.all(destinations.map(async account => ({ id: accountId(account), result: await onTikTokInfo(accountId(account), mediaType) })));
      setTikTokPermissions(previous => ({ ...previous, ...Object.fromEntries(results.map(item => [item.id, { mediaType, result: item.result }])) }));
    } catch (failure) { setError((failure as Error).message || 'TikTok publishing permissions could not be loaded.'); } finally { setLoadingTikTok(false); }
  }
  const providerErrors = providerCheck?.result?.errors || providerCheck?.result?.validation?.errors || [], providerWarnings = providerCheck?.result?.warnings || providerCheck?.result?.validation?.warnings || [];
  const mediaMode = platformMediaModes[selected] || (own(override, 'mediaItems') ? override.mediaItems?.length ? 'custom' : 'none' : own(override, 'assetId') ? override.assetId ? 'asset' : 'none' : 'shared');
  const characterCount = variant ? countCaption(variant.content, selected) : 0;
  const captionLimit = variant ? captionLimitForVariant(variant) : rule?.captionLimit || 0;
  const tikTokAccounts = socialAccounts.filter(account => account.platform === 'tiktok' && selectedAccounts.includes(accountId(account))), tikTokMediaType = variant?.mediaItems.some(item => item.type === 'video') ? 'video' : 'photo';
  return <form className="post-composer" onSubmit={submit}>
    <h3 className="sr-only" ref={headingRef} tabIndex={-1}>Post composer</h3>
    {error && <div className="alert error" role="alert">{error}</div>}
    <p className="field-help">Start with shared content, then tailor each platform’s caption, media and publishing options. Save a draft at any stage; publishing checks every selected destination.</p>
    <fieldset disabled={disabled}>
      <section className="post-compose-section"><h3>1. Choose destinations</h3><div className="platform-options" aria-label="Social platforms">{Object.entries(PLATFORM_RULES).filter(([platform, config]) => config.supported || platforms.includes(platform)).map(([platform, config]: [string, any]) => <label key={platform}><input type="checkbox" disabled={providerPost} checked={platforms.includes(platform)} onChange={() => togglePlatform(platform)}/>{config.label}{!config.supported && ' (posting unavailable)'}</label>)}</div>
        {onLoadAccounts && <button className="button" type="button" disabled={disabled || loadingAccounts || providerPost} onClick={loadAccounts}>{loadingAccounts ? 'Loading channels…' : 'Load connected channels'}</button>}
        {activeAccounts.length > 0 ? <fieldset className="post-account-choices" disabled={providerPost}><legend>Connected accounts</legend>{activeAccounts.map(account => <label key={accountId(account)}><input type="checkbox" checked={selectedAccounts.includes(accountId(account))} onChange={event => { setAccountsTouched(true); setAccounts(event.target.checked ? [...selectedAccounts, accountId(account)] : selectedAccounts.filter(id => id !== accountId(account))); }}/><span>{accountLabel(account)} <small>{PLATFORM_RULES[account.platform].label}</small></span></label>)}</fieldset> : <p className="field-help post-inline-help">Load connected channels to choose accounts. You can save platform drafts before connecting.</p>}
        {providerPost && <p className="field-help post-inline-help">Destinations are fixed for this provider post. Caption, media, options and timing changes update the existing unpublished post.</p>}
        {platforms.some(platform => !selectedAccounts.some(id => socialAccounts.find(account => accountId(account) === id)?.platform === platform)) && <p className="post-validation-warning">Choose an account for every platform before publishing. If accounts have not been loaded, existing account IDs are retained.</p>}
      </section>
      <section className="post-compose-section"><h3>2. Shared content</h3><label className="field"><span>Shared caption</span><textarea value={content} maxLength={100000} onChange={event => setContent(event.target.value)} placeholder="Write your main message…"/></label><p className="field-help post-inline-help">Platforms inherit this caption until you enable a separate caption below.</p>
        <label className="field"><span>Shared media source</span><select value={baseMode} onChange={event => setBaseMode(event.target.value)}><option value="none">Text only / no shared media</option><option value="asset">Asset library</option><option value="custom">Custom media URLs</option></select></label>
        {baseMode === 'asset' && <label className="field"><span>Shared creative asset</span><select value={assetId} onChange={event => setAssetId(event.target.value)}><option value="">Choose an asset</option>{assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name} · {asset.kind}{asset.approval !== 'approved' ? ' · Approval required' : ''}</option>)}</select></label>}
        {baseMode === 'custom' && <MediaEditor items={baseMedia} onChange={setBaseMedia} label="Shared" disabled={disabled} onInspect={onInspectMedia}/>}
      </section>
      {!!platforms.length && <section className="post-compose-section"><h3>3. Customise each platform</h3><div className="post-platform-tabs" role="tablist" aria-label="Platform customisation">{platforms.map(platform => <button key={platform} type="button" role="tab" id={`post-tab-${platform}`} aria-controls={`post-panel-${platform}`} aria-selected={selected === platform} tabIndex={selected === platform ? 0 : -1} ref={element => { tabRefs.current[platform] = element; }} onClick={() => setActivePlatform(platform)} onKeyDown={event => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const index = event.key === 'Home' ? 0 : event.key === 'End' ? platforms.length - 1 : (platforms.indexOf(platform) + (event.key === 'ArrowRight' ? 1 : -1) + platforms.length) % platforms.length; setActivePlatform(platforms[index]); tabRefs.current[platforms[index]]?.focus(); }}><span>{PLATFORM_RULES[platform]?.label || platform}</span>{checks.errors.some((item: any) => item.platform === platform) && <span className="post-tab-error" aria-label="has publishing restrictions">!</span>}{Object.keys(overrides[platform] || {}).some(key => key !== 'options' || Object.keys(overrides[platform]?.options || {}).length) && <small>Custom</small>}</button>)}</div>
        {rule && variant && <div className="post-platform-panel" id={`post-panel-${selected}`} role="tabpanel" aria-labelledby={`post-tab-${selected}`}>
          <div className="post-caption-heading"><label className="checkbox-label"><input type="checkbox" checked={own(override, 'content')} onChange={event => event.target.checked ? changeOverride({ content }) : changeOverride({}, ['content'])}/>Separate {rule.label} caption</label><span className={characterCount > captionLimit ? 'post-counter over' : 'post-counter'}>{characterCount.toLocaleString()} / {captionLimit.toLocaleString()}{selected === 'twitter' ? ' weighted' : selected === 'bluesky' ? ' graphemes' : ''}</span></div>
          <label className="field"><span>{rule.label} caption{!own(override, 'content') && ' (using shared caption)'}</span><textarea value={variant.content} maxLength={100000} readOnly={!own(override, 'content')} onChange={event => changeOverride({ content: event.target.value })} aria-invalid={errors.some((item: any) => item.field === 'content')}/></label>
          <label className="field"><span>{rule.label} media source</span><select value={mediaMode} onChange={event => { const mode = event.target.value; setPlatformMediaModes(previous => ({ ...previous, [selected]: mode })); if (mode === 'shared') changeOverride({}, ['mediaItems', 'assetId']); else if (mode === 'none') changeOverride({ mediaItems: [] }, ['assetId']); else if (mode === 'asset') changeOverride({ assetId: '' }, ['mediaItems']); else changeOverride({ mediaItems: variant.mediaItems.map((item: MediaItem) => ({ ...item })) }, ['assetId']); }}><option value="shared">Use shared media</option><option value="none">Text only / no media</option><option value="asset">Choose a different asset</option><option value="custom">Separate media URLs</option></select></label>
          {mediaMode === 'asset' && <label className="field"><span>{rule.label} creative asset</span><select value={override.assetId || ''} onChange={event => changeOverride({ assetId: event.target.value })}><option value="">Choose an asset</option>{assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name} · {asset.kind}{asset.approval !== 'approved' ? ' · Approval required' : ''}</option>)}</select></label>}
          {mediaMode === 'custom' && <MediaEditor items={override.mediaItems || []} onChange={mediaItems => changeOverride({ mediaItems })} label={rule.label} disabled={disabled} onInspect={onInspectMedia}/>}
          {selected === 'tiktok' && <p className="field-help post-inline-help">Privacy choices, creator permissions and your posting consent are checked against the connected TikTok creator before submission.</p>}
          {selected === 'tiktok' && onTikTokInfo && <div className="post-tiktok-permissions"><button className="button" type="button" disabled={disabled || loadingTikTok || !tikTokAccounts.length} onClick={loadTikTokPermissions}>{loadingTikTok ? 'Loading TikTok permissions…' : 'Load TikTok publishing permissions'}</button>{!tikTokAccounts.length && <p>Select a connected TikTok account to load its allowed privacy settings.</p>}{tikTokAccounts.map(account => {
            const saved = tikTokPermissions[accountId(account)], permissions = saved?.result;
            if (!permissions) return null;
            return <div key={accountId(account)}><p><strong>{permissions.creator?.nickname || accountLabel(account)}</strong>{saved.mediaType !== tikTokMediaType ? ' · Media type changed; load permissions again.' : ''}</p>{permissions.creator?.canPostMore === false && <p className="post-validation-error">This creator has reached its posting limit.</p>}<p>Allowed privacy: {(permissions.privacyLevels || []).map((level: any) => level.label || level.value).join(', ') || 'Not reported'}</p>{permissions.postingLimits?.maxVideoDurationSec && <p>Maximum video duration: {permissions.postingLimits.maxVideoDurationSec} seconds.</p>}<ul>{Object.entries(permissions.postingLimits?.interactionSettings || {}).map(([key, setting]: [string, any]) => setting && <li key={key}>{setting.label || optionLabel(key)}: {setting.enabled === false ? 'Unavailable for this creator' : setting.required ? 'Choose explicitly' : 'Available'}</li>)}</ul></div>;
          })}</div>}
          <p className="field-help post-inline-help">{rule.mediaTypes.join(', ')} · {rule.maxMedia} media item{rule.maxMedia === 1 ? '' : 's'} maximum{rule.minMedia ? ` · At least ${rule.minMedia} required` : ''}. Restrictions can change with the format and account.</p>
          {rule.options?.length > 0 && <details className="post-platform-options" open><summary>{rule.label} publishing options</summary>{rule.options.map((option: any) => {
            const key = `${selected}:${option.key}`, value = variant.options[option.key], input = optionInputs[key] ?? (option.type === 'json' ? value === undefined ? '' : JSON.stringify(value, null, 2) : option.type === 'string-list' ? (value || []).join('\n') : value ?? '');
            if (option.type === 'json') return <div key={key}><StructuredOption label={option.label} schema={option.schema} value={value} onChange={next => updateOption(option.key, next)} onInvalid={message => setOptionErrors(previous => ({ ...previous, [key]: message }))}/>{option.help && <p className="field-help">{option.help}</p>}{optionErrors[key] && <p className="post-validation-error" role="alert">{optionErrors[key]}</p>}</div>;
            return <div key={key}><label className="field"><span>{option.label}{option.required ? ' *' : ''}</span>{option.type === 'boolean' ? <select value={value === undefined ? '' : String(value)} onChange={event => updateOption(option.key, event.target.value === '' ? undefined : event.target.value === 'true')}><option value="">Platform default</option><option value="true">On</option><option value="false">Off</option></select> : option.type === 'select' ? <select value={value ?? ''} onChange={event => updateOption(option.key, event.target.value || undefined)}><option value="">Platform default</option>{option.values?.map((choice: any) => <option key={typeof choice === 'object' ? choice.value : choice} value={typeof choice === 'object' ? choice.value : choice}>{typeof choice === 'object' ? choice.label : choice}</option>)}</select> : ['textarea', 'string-list', 'json'].includes(option.type) ? <textarea value={input} maxLength={option.maxLength || 20000} aria-invalid={!!optionErrors[key]} onChange={event => { const raw = event.target.value; setOptionInputs(previous => ({ ...previous, [key]: raw })); if (option.type === 'json') { try { updateOption(option.key, raw.trim() ? JSON.parse(raw) : undefined); setOptionErrors(previous => ({ ...previous, [key]: '' })); } catch { setOptionErrors(previous => ({ ...previous, [key]: `${rule.label}: ${option.label} must contain valid JSON.` })); } } else updateOption(option.key, raw.trim() ? option.type === 'string-list' ? raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : raw : undefined); }}/> : <input type={option.type === 'number' ? 'number' : 'text'} value={input} maxLength={option.maxLength} min={option.min} max={option.max} step={option.type === 'number' ? 'any' : undefined} onChange={event => updateOption(option.key, event.target.value === '' ? undefined : option.type === 'number' ? Number(event.target.value) : event.target.value)}/>}</label>{option.help && <p className="field-help">{option.help}</p>}{optionErrors[key] && <p className="post-validation-error" role="alert">{optionErrors[key]}</p>}</div>;
          })}</details>}
          <div className="post-platform-checks" aria-live="polite"><h4>{rule.label} restriction checks</h4>{!errors.length && <p className="post-validation-ok">No known caption or media restriction failed.</p>}{errors.map((item: any, index: number) => <p className="post-validation-error" key={'error' + index}>{item.message}</p>)}{warnings.map((item: any, index: number) => <p className="post-validation-warning" key={'warning' + index}>{item.message}</p>)}</div>
          <PostVariantPreview platform={selected} variant={variant} accountName={activeAccounts.filter(account => account.platform === selected && selectedAccounts.includes(accountId(account))).map(accountLabel).join(', ') || 'Your brand'} scheduled={!!scheduledAt}/>
        </div>}
      </section>}
      <section className="post-compose-section"><h3>4. Campaign and timing</h3><label className="field"><span>Campaign</span><select disabled={providerPost} value={campaignId} onChange={event => setCampaignId(event.target.value)}><option value="">No campaign</option>{campaigns.map(campaign => <option value={campaign.id} key={campaign.id}>{campaign.name}</option>)}</select></label><label className="field"><span>Plan for (your local timezone, optional)</span><input type="datetime-local" value={scheduledAt} onChange={event => setScheduledAt(event.target.value)}/></label><p className="field-help post-inline-help">{scheduledAt ? `Planned for ${new Date(scheduledAt).toLocaleString()}. ` : ''}{providerPost ? 'Saving updates this existing provider post. Clear the time to return it to an unpublished provider draft.' : 'Saving keeps the post local. Choose Publish or Schedule in Publishing to submit it to Zernio.'}</p></section>
      <div className="post-preflight-summary" aria-live="polite"><strong>{checks.errors.length ? `${checks.errors.length} restriction${checks.errors.length === 1 ? '' : 's'} to fix before publishing` : platforms.length ? 'Draft checks complete' : 'Choose a platform to check your post'}</strong><p>{checks.errors.length ? 'You can save this draft and finish it later.' : 'The provider verifies account permissions, media encoding and current platform rules when you submit.'}{checks.warnings.length ? ` ${checks.warnings.length} item${checks.warnings.length === 1 ? '' : 's'} still need verification.` : ''}</p>
        {onValidate && <button className="button" type="button" disabled={disabled || checking || !platforms.length} onClick={checkWithProvider}>{checking ? 'Checking with Zernio…' : 'Check with Zernio'}</button>}
        {providerCheck && <div className="post-provider-check"><strong>{providerCheck.signature !== JSON.stringify(values) ? 'Post changed since the last Zernio check' : providerCheck.result?.valid === true || providerCheck.result?.validation?.valid === true ? 'Zernio checks passed' : providerCheck.result?.valid === false || providerErrors.length ? 'Zernio found restrictions' : 'Zernio check completed'}</strong>{providerCheck.signature !== JSON.stringify(values) && <p>Run the check again for your current captions, media, options and schedule.</p>}{Array.isArray(providerErrors) && providerErrors.map((item: any, index: number) => <p className="post-validation-error" key={index}>{typeof item === 'string' ? item : item.message || item.error || 'A destination failed validation.'}</p>)}{Array.isArray(providerWarnings) && providerWarnings.map((item: any, index: number) => <p className="post-validation-warning" key={index}>{typeof item === 'string' ? item : item.message || item.warning || 'The provider reported a restriction to review.'}</p>)}{providerCheck.result?.message && <p>{providerCheck.result.message}</p>}</div>}
      </div>
    </fieldset>
    <div className="modal-actions">{onDelete && canWrite && !readOnly && !post?.externalId && post?.status !== 'published' && <button className="button danger" type="button" disabled={busy || saving} onClick={onDelete}>Delete</button>}<button className="button" type="button" onClick={onCancel}>{readOnly || !canWrite ? 'Close' : 'Cancel'}</button>{!disabled || busy || saving ? <button className="button primary" disabled={disabled}>{saving || busy ? 'Saving…' : post ? 'Save changes' : 'Save draft'}</button> : null}</div>
  </form>;
}
