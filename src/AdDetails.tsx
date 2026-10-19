import React, { useEffect, useRef, useState } from 'react';

type Props = { request: (path: string, body?: any) => Promise<any>; campaign: any; canWrite: boolean; onChanged?: () => void; onClose?: () => void };
const lines = (value = '') => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
const copy = (value: any) => (Array.isArray(value) ? value : []).map((item: any) => typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : '').join('\n');
const count = (value: any) => typeof value === 'number' ? new Intl.NumberFormat().format(value) : '—';
function Field({ label, name, value, multiline = false, type = 'text', required = false }: { label: string; name: string; value?: any; multiline?: boolean; type?: string; required?: boolean }) {
  return <label className="field"><span>{label}</span>{multiline ? <textarea name={name} defaultValue={value || ''} required={required}/> : <input type={type} name={name} defaultValue={value ?? ''} required={required} {...(type === 'number' ? { step: 'any', min: 0 } : {})}/>}</label>;
}
export default function AdDetails({ request, campaign, canWrite, onChanged, onClose }: Props) {
  const requester = useRef(request); requester.current = request;
  const [data, setData] = useState<any>(null), [selected, setSelected] = useState<any>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [retry, setRetry] = useState(0);
  const [needsRefresh, setNeedsRefresh] = useState(false), [readVersion, setReadVersion] = useState(0);
  const [draftDirty, setDraftDirty] = useState(false), [pendingAction, setPendingAction] = useState<{ action: () => Promise<any>; message: string; forms: HTMLFormElement[] } | null>(null);
  const detailsSection = useRef<HTMLElement>(null), editorForm = useRef<HTMLFormElement>(null), actionTrigger = useRef<HTMLElement | null>(null);
  const campaignId = campaign.platformCampaignId || campaign.campaignId || campaign.id, platform = campaign.platform;
  const identity = platform + ':' + campaignId, currentIdentity = useRef(identity), active = useRef(true); currentIdentity.current = identity;
  const isCurrent = () => active.current && currentIdentity.current === identity;
  async function scopedRequest(path: string, body?: any) {
    if (!isCurrent()) throw new DOMException('Ad selection changed.', 'AbortError');
    const result = await requester.current(path, body);
    if (!isCurrent()) throw new DOMException('Ad selection changed.', 'AbortError');
    return result;
  }
  const live = selected?.ad, creative = live?.creative || {}, channel = String(live?.advertisingChannelType || '').toLowerCase();
  const rsaReviewCurrent = Boolean(selected?.creativeReview?.version && Date.parse(selected.creativeReview.expiresAt) > Date.now());
  const pinnedText = [...(Array.isArray(creative.headlines) ? creative.headlines : []), ...(Array.isArray(creative.descriptions) ? creative.descriptions : [])].filter((row: any) => typeof row?.text === 'string' && typeof row?.pinnedField === 'string');
  const smartPlus = platform === 'tiktok' && (live?.isSmartPlus || data?.campaign?.isSmartPlus);
  useEffect(() => { active.current = true; let current = true; setBusy(true); setData(null); setSelected(null); setDraftDirty(false); setPendingAction(null); setNeedsRefresh(false); setError(''); scopedRequest(`ads/items?campaignId=${encodeURIComponent(campaignId)}&platform=${encodeURIComponent(platform)}`).then(result => { if (current && isCurrent()) setData(result); }).catch(err => { if (current && isCurrent() && err.name !== 'AbortError') setError(err.message); }).finally(() => { if (current && isCurrent()) setBusy(false); }); return () => { current = false; active.current = false; }; }, [campaignId, platform, retry]);
  async function act(action: () => Promise<any>, message = '', reviewDraft: boolean | HTMLFormElement = false) {
    if (!isCurrent()) return;
    const forms = reviewDraft === true ? draftDirty && editorForm.current ? [editorForm.current] : [] : reviewDraft ? Array.from(detailsSection.current?.querySelectorAll<HTMLFormElement>('form') || []).filter(form => form !== reviewDraft && hasDraft(form)) : [];
    if (forms.length) { actionTrigger.current = document.activeElement as HTMLElement; setPendingAction({ action, message, forms }); return; }
    setBusy(true); setError(''); setNotice(''); try { await action(); if (isCurrent()) { setNotice(message); if (message) onChanged?.(); } } catch (err) { if (isCurrent() && (err as Error).name !== 'AbortError') setError((err as Error).message); } finally { if (isCurrent()) setBusy(false); }
  }
  async function readAd(adId: string, afterWrite = false) {
    if (afterWrite) setNeedsRefresh(true);
    try { setSelected(await scopedRequest('ads/details?adId=' + encodeURIComponent(adId))); setReadVersion(value => value + 1); setDraftDirty(false); setNeedsRefresh(false); }
    catch (failure) { if (!afterWrite || (failure as Error).name === 'AbortError' || !isCurrent()) throw failure; setError('The provider confirmed the change, but its latest details could not be loaded. Refresh ad details before making another change. ' + (failure as Error).message); }
  }
  async function edit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || needsRefresh) return; const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>, payload: Record<string, any> = { adId: live._id };
    if (['facebook', 'instagram'].includes(platform) && values.name?.trim() && values.name.trim() !== live.name) payload.name = values.name.trim();
    if (values.countries?.trim()) payload.targeting = { countries: values.countries.toUpperCase().split(/[,\s]+/).filter(Boolean) };
    if (platform === 'google' && ['performance_max', 'demand_gen'].includes(channel)) {
      const group: Record<string, any> = {};
      for (const [field, key] of [['assetHeadlines', 'headlines'], ['assetDescriptions', 'descriptions'], ['assetYoutubeIds', 'youtubeVideoIds'], ['assetLongHeadlines', 'longHeadlines']]) if (values[field]?.trim()) group[key] = lines(values[field]);
      for (const [field, key] of [['assetBusinessName', 'businessName'], ['assetLongHeadline', 'longHeadline'], ['assetFinalUrl', 'finalUrl']]) if (values[field]?.trim()) group[key] = values[field].trim();
      const images: Record<string, string[]> = {};
      for (const role of ['landscape', 'square', 'logo']) if (values['asset_' + role]?.trim()) images[role] = lines(values['asset_' + role]);
      if (Object.keys(images).length) group.images = images;
      if (Object.keys(group).length) payload[channel === 'performance_max' ? 'assetGroup' : 'demandGen'] = group;
    } else if (platform === 'google' && ['search', 'display'].includes(channel)) {
      if (values.headlines?.trim() && values.headlines !== copy(creative.headlines)) payload.headlines = lines(values.headlines);
      if (values.descriptions?.trim() && values.descriptions !== copy(creative.descriptions)) payload.descriptions = lines(values.descriptions);
      if (channel === 'search' && values.finalUrls?.trim() && values.finalUrls !== copy(creative.finalUrls)) payload.finalUrls = lines(values.finalUrls);
      if (channel === 'display' && values.linkUrl?.trim() && values.linkUrl.trim() !== creative.finalUrls?.[0]) payload.finalUrls = [values.linkUrl.trim()];
      if (channel === 'search' && ['headlines', 'descriptions', 'finalUrls'].some(key => payload[key] !== undefined)) {
        if (!selected?.creativeReview?.version || !(Date.parse(selected.creativeReview.expiresAt) > Date.now())) { setError('Refresh ad details to verify the current Google Search text before editing.'); return; }
        payload.expectedCreativeVersion = selected.creativeReview.version;
      }
      if (channel === 'display') {
        const updates: Record<string, string> = {};
        for (const key of ['longHeadline', 'businessName', 'imageUrl', 'squareImageUrl']) if (values[key]?.trim() && values[key].trim() !== (creative[key] || '')) updates[key] = values[key].trim();
        if (Object.keys(updates).length) payload.creative = updates;
      }
    } else if (['facebook', 'instagram', 'tiktok', 'linkedin'].includes(platform)) {
      const updates: Record<string, string> = {};
      for (const key of ['headline', 'body', 'linkUrl', 'imageUrl', 'videoUrl']) if (values[key]?.trim() && values[key].trim() !== (creative[key] || '')) updates[key] = values[key].trim();
      if (Object.keys(updates).length) payload.creative = updates;
    }
    if (Object.keys(payload).length === 1) { setError('Choose at least one field to change.'); return; }
    const form = event.currentTarget;
    await act(async () => { await scopedRequest('ads/edit', payload); confirmForm(form); await readAd(live._id, true); }, 'Changes saved with the advertising provider.');
  }
  async function editSet(event: React.FormEvent<HTMLFormElement>, adSet: any) {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>, payload: Record<string, any> = { campaignId, platform, adSetId: adSet.platformAdSetId };
    if (values.name.trim() !== (adSet.adSetName || '')) payload.name = values.name.trim();
    if (values.amount?.trim()) payload.budget = { amount: Number(values.amount), type: 'daily' };
    const form = event.currentTarget;
    await act(async () => { await scopedRequest('ads/adset', payload); confirmForm(form); setRetry(value => value + 1); }, 'Ad set changes saved.', form);
  }
  async function editCampaign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>, payload: Record<string, any> = { campaignId, platform };
    if (values.name?.trim() && values.name.trim() !== (data.campaign.campaignName || data.campaign.name)) payload.name = values.name.trim();
    if (values.amount?.trim()) payload.budget = { amount: Number(values.amount), type: platform === 'openai' ? values.budgetType : 'daily' };
    const form = event.currentTarget;
    await act(async () => { await scopedRequest('ads/campaign', payload); confirmForm(form); setRetry(value => value + 1); }, 'Campaign changes saved.', form);
  }
  function confirmForm(form: HTMLFormElement | null, outcome = 'saved') {
    if (!isCurrent()) return;
    form?.dispatchEvent(new CustomEvent('campaign:editor-saved', { bubbles: true, detail: { form, outcome } }));
    if (form === editorForm.current) { setDraftDirty(false); setPendingAction(null); }
  }
  function discardDraft() {
    if (!pendingAction || !isCurrent()) return;
    for (const form of pendingAction.forms) { form.reset(); confirmForm(form, 'discarded'); }
    setPendingAction(null); void act(pendingAction.action, pendingAction.message);
  }
  function hasDraft(form: HTMLFormElement) {
    return Array.from(form.elements).some(field => {
      if (field instanceof HTMLInputElement) return ['checkbox', 'radio'].includes(field.type) ? field.checked !== field.defaultChecked : field.value !== field.defaultValue;
      if (field instanceof HTMLTextAreaElement) return field.value !== field.defaultValue;
      if (field instanceof HTMLSelectElement) return field.value !== (Array.from(field.options).find(option => option.defaultSelected)?.value ?? field.options[0]?.value ?? '');
      return false;
    });
  }
  function trackDraft(event: React.FormEvent<HTMLFormElement>) {
    if (hasDraft(event.currentTarget)) setDraftDirty(true); else confirmForm(event.currentTarget, 'restored');
  }
  return <section className="ad-details" ref={detailsSection}>
    <div className="panel-heading"><div><h2>{campaign.campaignName || campaign.name || 'Campaign details'}</h2><p className="field-help">Ads, delivery and conversions.</p></div>{onClose && <button className="button" onClick={onClose}>Close</button>}</div>
    {error && <div className="alert" role="alert">{error}</div>}{notice && <p role="status">{notice}</p>}
    {pendingAction && <div className="ad-details-discard" role="alert">
      <p><strong>Discard unsaved changes?</strong></p>
      <p>This action reloads the details below. Discard unsaved changes in the affected forms to continue.</p>
      <div className="button-wrap">
        <button type="button" className="button" autoFocus onClick={() => { setPendingAction(null); actionTrigger.current?.focus(); }}>Keep editing</button>
        <button type="button" className="button" onClick={discardDraft}>Discard changes and continue</button>
      </div>
    </div>}
    {busy && <p role="status">Loading provider details…</p>}
    {!data && !busy && <button className="button" onClick={() => setRetry(value => value + 1)}>Reload ads</button>}
    {data?.backfillPending && <p className="field-help">Some historical results are still being backfilled. Refresh after the provider finishes.</p>}
    {data && <>
      <div className="table-scroll" role="region" aria-label="Campaign ads" tabIndex={0}>
        <table>
          <thead><tr>
            <th scope="col">Ad</th><th scope="col">Delivery</th><th scope="col">Conversions</th>
            <th scope="col">Purchase value</th><th scope="col">Return on ad spend</th>
            <th scope="col"><span className="sr-only">Actions</span></th>
          </tr></thead>
          <tbody>{data.ads.map((ad: any) => <tr key={ad._id}>
            <td>{ad.name || 'Untitled ad'}</td><td>{ad.status || 'Unknown'}</td>
            <td>{count(ad.metrics?.conversions)}</td>
            <td>{ad.metrics?.purchaseValue == null ? '—' : `${count(ad.metrics.purchaseValue)} ${data.campaign.currency || ''}`}</td>
            <td>{ad.metrics?.roas == null ? '—' : `${Number(ad.metrics.roas).toFixed(2)}×`}</td>
            <td><button className="button" disabled={busy || !!pendingAction} aria-label={`View details for ${ad.name || 'untitled ad'}`} onClick={() => act(() => readAd(ad._id), '', true)}>View details</button></td>
          </tr>)}</tbody>
        </table>
      </div>
      {!data.ads.length && <p className="field-help">No ads were returned for this campaign.</p>}
      {canWrite && (['google', 'openai', 'reddit', 'facebook', 'instagram'].includes(platform)) && <details><summary>Campaign settings</summary><form onSubmit={editCampaign}><fieldset disabled={busy || !!pendingAction}>{['facebook', 'instagram', 'reddit'].includes(platform) && <Field label="Campaign name" name="name" value={data.campaign.campaignName || data.campaign.name}/>}<p className="field-help">Campaign budgets apply to every ad set and ad in this campaign. Shared Google budgets require changes in the provider dashboard.</p>{platform === 'openai' && <><label className="field"><span>Campaign budget type</span><select name="budgetType" defaultValue={data.campaign.campaignBudget?.type || data.campaign.budget?.type || 'daily'}><option value="daily">Daily spend limit</option>{(data.campaign.budget?.type === 'lifetime' || data.campaign.campaignBudget?.type === 'lifetime') && <option value="lifetime">Lifetime spend limit</option>}</select></label><Field label={`New campaign budget (${data.campaign.currency || 'account currency'}) · optional`} name="amount" type="number"/><p className="field-help">A lifetime campaign can switch to daily. A daily campaign cannot switch back to lifetime; create a new campaign for that budget type.</p></>}{(['google', 'reddit'].includes(platform) || data.campaign.budgetLevel === 'campaign') && platform !== 'openai' && data.campaign.budget?.type !== 'lifetime' && data.campaign.campaignBudget?.type !== 'lifetime' && <Field label={`New daily campaign budget (${data.campaign.currency || 'account currency'}) · optional`} name="amount" type="number"/>}<button className="button">Save campaign</button></fieldset></form></details>}
      {canWrite && data.campaign.adSets?.map((adSet: any) => <details key={adSet.platformAdSetId}><summary>Ad set · {adSet.adSetName || adSet.platformAdSetId}</summary><form onSubmit={event => editSet(event, adSet)}><fieldset disabled={busy || !!pendingAction}><Field label="Ad set name" name="name" value={adSet.adSetName} required/>{!['google', 'openai'].includes(platform) && data.campaign.budgetLevel !== 'campaign' && adSet.budget?.type !== 'lifetime' && adSet.adSetBudget?.type !== 'lifetime' && <Field label={`New daily budget (${data.campaign.currency || 'account currency'}) · optional`} name="amount" type="number"/>}<p className="field-help">Budget changes apply to every ad in this ad set.</p><button className="button">Save ad set</button></fieldset></form></details>)}
    </>}
    {live && <div className="ad-details-selected" key={live._id + ':' + readVersion}>
      <h3>{live.name || 'Ad details'}</h3><p className="field-help">Delivery: {live.status || 'Unknown'} · Ad switch: {live.configuredStatus || 'Not reported'} · Review: {live.reviewStatus || 'Not reported'}</p>
      {live.rejectionReason && <div className="alert">{live.rejectionReason}</div>}
      {!selected.statusReadAt && <p className="field-help">The live status read was unavailable. These are the provider’s last stored values.</p>}
      <button type="button" className="button" disabled={busy || !!pendingAction} onClick={() => act(() => readAd(live._id), '', true)}>Refresh ad details</button>
      {canWrite && !['rejected', 'completed', 'cancelled', 'archived', 'deleted'].includes(live.status) && platform !== 'twitter' && <div className="modal-actions">{['paused', 'active'].map(status => <button key={status} className="button" disabled={busy || needsRefresh || !!pendingAction} onClick={() => { if (status === 'active' && !window.confirm('Enable this ad? It can spend when its campaign and ad set are also enabled.')) return; act(async () => { await scopedRequest('ads/ad-status', { adId: live._id, status }); await readAd(live._id, true); }, `Ad switch ${status === 'active' ? 'enabled' : 'paused'}.`, true); }}>{status === 'active' ? 'Enable ad' : 'Pause ad'}</button>)}</div>}
      {platform === 'openai' && <p className="field-help">ChatGPT creative and audience edits require a new campaign. Use Campaign settings for its budget and the delivery controls above for its ad switch.</p>}
      {smartPlus && <p className="field-help">This TikTok Smart+ ad supports its delivery switch here. Change its creative and audience in TikTok Ads Manager.</p>}
      {platform === 'google' && channel === 'search' && !rsaReviewCurrent && <p className="alert" role="status">Current Google Search creative could not be verified. Refresh ad details before changing text or destinations. Delivery controls remain available.</p>}
      {canWrite && !smartPlus && platform !== 'openai' && !['rejected', 'completed', 'cancelled', 'archived', 'deleted'].includes(live.status) && <form ref={editorForm} onChange={trackDraft} onSubmit={edit}><fieldset disabled={busy || needsRefresh || !!pendingAction}>
        {['facebook', 'instagram'].includes(platform) && <Field label="Ad name" name="name" value={live.name}/>}
        {['facebook', 'instagram', 'tiktok', 'linkedin'].includes(platform) && <>{platform !== 'tiktok' && <Field label="Headline" name="headline" value={creative.headline || creative.googleHeadline}/>}<Field label="Ad text" name="body" multiline value={creative.body}/><Field label="Destination website" name="linkUrl" type="url" value={creative.linkUrl}/>{platform === 'linkedin' && <p className="field-help">LinkedIn creative changes need a new image or video. The provider creates a replacement creative and pauses the old one.</p>}{platform !== 'tiktok' && <Field label="Replacement image URL (optional)" name="imageUrl" type="url"/>}<Field label="Replacement video URL (optional)" name="videoUrl" type="url"/></>}
        {platform === 'google' && ['search', 'display'].includes(channel) && <fieldset disabled={channel === 'search' && !rsaReviewCurrent}><Field label="Headlines (one per line)" name="headlines" multiline value={copy(creative.headlines)}/><Field label="Descriptions (one per line)" name="descriptions" multiline value={copy(creative.descriptions)}/>{channel === 'search' ? <Field label="Destination websites (one per line)" name="finalUrls" multiline value={copy(creative.finalUrls)}/> : <Field label="Destination website" name="linkUrl" type="url" value={creative.finalUrls?.[0]}/>}<p className="field-help">Each changed list replaces its complete contents. Keep every entry you want to retain.</p>{channel === 'search' && <><p className="field-help">Existing pinned positions stay with unchanged text, including after reordering. Replace or remove pinned text in Google Ads, then refresh here.</p>{pinnedText.length > 0 && <ul aria-label="Pinned ad text">{pinnedText.map((row: any) => <li key={row.pinnedField + ':' + row.text}>{row.text} · {row.pinnedField.toLowerCase().replace('_', ' ')}</li>)}</ul>}</>}{channel === 'display' && <><Field label="Long headline" name="longHeadline" value={creative.longHeadline}/><Field label="Business name" name="businessName" value={creative.businessName}/><Field label="Replacement landscape image URL (optional)" name="imageUrl" type="url"/><Field label="Replacement square image URL (optional)" name="squareImageUrl" type="url"/></>}</fieldset>}
        {['facebook', 'instagram', 'tiktok', 'linkedin', 'google'].includes(platform) && <><Field label="Replace target countries (optional, such as AE, SA)" name="countries"/><p className="field-help">Changing countries replaces the location audience for every ad sharing this ad set, or the Google campaign.</p></>}
        {platform === 'google' && ['performance_max', 'demand_gen'].includes(channel) && <details><summary>Replace Google creative assets</summary><p className="field-help">Fill only the fields you want to change. Each supplied list replaces that entire asset role. Existing assets remain in the provider’s library. Carousel cards cannot be changed after creation.</p><Field label={`Replacement headlines (one per line, ${channel === 'performance_max' ? '3–15, up to 30 characters' : '1–5, up to 40 characters'})`} name="assetHeadlines" multiline/><Field label={`Replacement descriptions (one per line, ${channel === 'performance_max' ? '2–5' : '1–5'}, up to 90 characters)`} name="assetDescriptions" multiline/><Field label="Replacement business name" name="assetBusinessName"/><Field label="Replacement destination website" name="assetFinalUrl" type="url"/>{channel === 'performance_max' ? <Field label="Replacement long headline" name="assetLongHeadline"/> : <Field label="Replacement long headlines (video ads only, one per line)" name="assetLongHeadlines" multiline/>}<Field label="Replacement landscape image URLs (one per line, image ads only)" name="asset_landscape" multiline/><Field label="Replacement square image URLs (one per line, image ads only)" name="asset_square" multiline/><Field label="Replacement logo image URLs (one per line)" name="asset_logo" multiline/><Field label="Replacement YouTube video IDs (one per line, video ads only)" name="assetYoutubeIds" multiline/></details>}
        {['pinterest', 'twitter', 'openai', 'reddit'].includes(platform) && <p className="field-help">Change this network’s creative and audience in its provider dashboard.</p>}
        {['facebook', 'instagram', 'tiktok', 'linkedin', 'google'].includes(platform) && <div className="modal-actions"><button className="button primary" disabled={busy}>Save ad changes</button></div>}
      </fieldset></form>}
    </div>}
  </section>;
}
