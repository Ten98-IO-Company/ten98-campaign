import React, { useEffect, useRef, useState } from 'react';

type Connection = { _id: string; platform: string; displayName?: string; username?: string; isActive?: boolean };
type AdAccount = { id: string; name: string; currency?: string; selectable?: boolean; minimumDailyBudget?: number };
type Props = { request: (path: string, body?: any) => Promise<any>; posts?: any[]; onCreated: () => void; onCancel: () => void };
const networks: Record<string, string> = { facebook: 'facebook', instagram: 'facebook', metaads: 'facebook', googleads: 'google', pinterest: 'pinterest', pinterestads: 'pinterest', tiktokads: 'tiktok', tiktok: 'tiktok', linkedinads: 'linkedin', linkedin: 'linkedin', xads: 'twitter', twitter: 'twitter', openaiads: 'openai', redditads: 'reddit' };
const labels: Record<string, string> = { facebook: 'Meta', google: 'Google', pinterest: 'Pinterest', tiktok: 'TikTok', linkedin: 'LinkedIn', twitter: 'X', openai: 'ChatGPT', reddit: 'Reddit' };
const formats: Record<string, [string, string][]> = {
  facebook: [['image', 'Single image'], ['video', 'Video'], ['carousel', 'Carousel']],
  google: [['search', 'Search · Text'], ['display', 'Display · Images'], ['pmax', 'Performance Max'], ['demand_image', 'Demand Gen · Images'], ['demand_video', 'Demand Gen · YouTube video'], ['demand_carousel', 'Demand Gen · Carousel']],
  linkedin: [['image', 'Single image'], ['video', 'Video']], reddit: [['image', 'Single image'], ['video', 'Video'], ['carousel', 'Carousel'], ['text', 'Text post']],
  tiktok: [['video', 'Video']], pinterest: [['image', 'Single image']], twitter: [['image', 'Website card']], openai: [['image', 'Sponsored chat card']],
};
function Field({ label, multiline, ...props }: { label: string; multiline?: boolean } & React.InputHTMLAttributes<HTMLInputElement>) {
  return <label className="field"><span>{label}{props.required && <span className="required"> *</span>}</span>{multiline ? <textarea name={props.name} required={props.required} maxLength={props.maxLength} placeholder={props.placeholder} defaultValue={props.defaultValue as string}/> : <input {...props}/>}</label>;
}
const lines = (value = '') => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);

export default function AdComposer({ request, posts = [], onCreated, onCancel }: Props) {
  const requester = useRef(request); requester.current = request;
  const [connections, setConnections] = useState<Connection[]>([]), [adAccounts, setAdAccounts] = useState<AdAccount[]>([]);
  const [accountId, setAccountId] = useState(''), [adAccountId, setAdAccountId] = useState(''), [format, setFormat] = useState('image'), [mode, setMode] = useState('create'), [goal, setGoal] = useState('traffic'), [cards, setCards] = useState(2);
  const identity = JSON.stringify([accountId, adAccountId, format, mode]), currentIdentity = useRef(identity), mounted = useRef(true); currentIdentity.current = identity;
  const isCurrent = () => mounted.current && currentIdentity.current === identity;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [loading, setLoading] = useState(true), [loadingAds, setLoadingAds] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const connection = connections.find(item => item._id === accountId), platform = networks[connection?.platform || ''];
  const adAccount = adAccounts.find(item => item.id === adAccountId), currency = adAccount?.currency;
  const digits = currency && /^[A-Z]{3}$/.test(currency) ? new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2 : 2;
  const step = 10 ** -digits, minimum = Math.max(step, platform === 'pinterest' ? 5 : platform === 'tiktok' ? 20 : platform === 'openai' ? 1 : 0, Number(adAccount?.minimumDailyBudget) || 0);
  const assets = platform === 'google' && !['search', 'display'].includes(format), carousel = ['carousel', 'demand_carousel'].includes(format), video = ['video', 'demand_video'].includes(format), boosting = mode === 'boost';
  const canBoost = connection && ['facebook', 'instagram', 'twitter', 'linkedin', 'tiktok', 'pinterest'].includes(connection.platform);
  const publishedPosts = posts.filter(post => post.externalId && !post.sample && ['published', 'partial'].includes(post.status) && (!post.providerResults?.length ? post.status === 'published' : post.providerResults.some((copy: any) => String(copy.accountId?._id || copy.accountId) === accountId && copy.status === 'published' && !(copy.platform === 'tiktok' && (copy.platformSpecificData?.isDraft || copy.platformSpecificData?.draft)))));
  const goals = ['traffic', 'awareness', ...(!['openai', 'reddit'].includes(platform) ? ['engagement'] : []), ...(['facebook', 'tiktok', 'linkedin', 'reddit'].includes(platform) && video && !boosting ? ['video_views'] : []), ...(['facebook', 'tiktok', 'openai', 'reddit'].includes(platform) && !boosting ? ['conversions'] : []), ...(['facebook', 'linkedin'].includes(platform) && !boosting ? ['lead_generation'] : [])];
  useEffect(() => {
    let active = true; setLoading(true); setError('');
    requester.current('accounts').then(result => { if (active) setConnections((result.accounts || []).filter((item: Connection) => networks[item.platform] && item.isActive !== false)); }).catch(err => { if (active) setError(err.message || 'Accounts could not be loaded.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [retry]);
  useEffect(() => {
    let active = true; setAdAccounts([]); setAdAccountId(''); setError('');
    if (!accountId) { setLoadingAds(false); return; }
    setLoadingAds(true);
    requester.current('ads/accounts?accountId=' + encodeURIComponent(accountId)).then(result => { if (active) setAdAccounts(result.accounts || []); }).catch(err => { if (active) setError(err.message || 'Advertising accounts could not be loaded.'); }).finally(() => { if (active) setLoadingAds(false); });
    return () => { active = false; };
  }, [accountId, retry]);
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (busy || !isCurrent()) return;
    const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>; setError('');
    try {
      if (!connection || !adAccount || adAccount.selectable === false || !currency) throw new Error('Choose an available advertising account with a reported currency.');
      const countries = [...new Set(values.countries.toUpperCase().split(/[,\s]+/).filter(Boolean))];
      if (!countries.length || countries.length > 50 || countries.some(value => !/^[A-Z]{2}$/.test(value))) throw new Error('Enter two-letter country codes, separated by commas, such as AE, SA.');
      const payload: Record<string, any> = { platform, accountId, adAccountId, name: values.name.trim(), goal, budgetAmount: Number(values.budgetAmount), budgetType: 'daily', countries, status: 'PAUSED', currency };
      for (const key of ['startDate', 'endDate']) if (values[key]) payload[key] = platform === 'google' ? values[key] + 'T00:00:00Z' : new Date(values[key]).toISOString();
      if (boosting) payload.postId = values.postId;
      else {
        const targeting: Record<string, any> = {};
        for (const key of ['ageMin', 'ageMax']) if (values[key]) targeting[key] = Number(values[key]);
        if (values.gender && values.gender !== 'all') targeting.gender = values.gender;
        if (values.languages?.trim()) targeting.languages = values.languages.trim().split(/[,\s]+/).filter(Boolean);
        if (Object.keys(targeting).length) payload.targeting = targeting;
        if (!assets) { if (platform !== 'tiktok') payload.headline = values.headline.trim(); payload.body = values.body.trim(); if (values.linkUrl?.trim()) payload.linkUrl = values.linkUrl.trim(); }
        const cardValues = () => Array.from({ length: cards }, (_, index) => ({ imageUrl: values[`cardImage${index}`].trim(), headline: values[`cardHeadline${index}`].trim(), ...(values[`cardLink${index}`]?.trim() ? { linkUrl: values[`cardLink${index}`].trim() } : {}) }));
        if (platform === 'google') {
          payload.campaignType = format.startsWith('demand_') ? 'demand_gen' : format;
          if (format === 'search') { payload.additionalHeadlines = lines(values.additionalHeadlines); payload.additionalDescriptions = lines(values.additionalDescriptions); payload.keywords = lines(values.keywords); }
          else if (format === 'display') { payload.businessName = values.businessName.trim(); payload.images = { landscape: values.landscape.trim(), square: values.square.trim() }; }
          else {
            delete payload.goal;
            const group: Record<string, any> = { finalUrl: values.linkUrl.trim(), businessName: values.businessName.trim(), headlines: lines(values.headlines), descriptions: lines(values.descriptions), images: { logo: lines(values.logo) } };
            if (!video && !carousel) { group.images.landscape = lines(values.landscape); group.images.square = lines(values.square); }
            if (format === 'pmax') { group.longHeadline = values.longHeadline.trim(); if (values.youtubeVideoIds?.trim()) group.youtubeVideoId = values.youtubeVideoIds.trim(); }
            if (format === 'demand_video') { group.youtubeVideoIds = lines(values.youtubeVideoIds); group.longHeadlines = lines(values.longHeadlines); group.channels = ['youtube_in_stream', 'youtube_in_feed', 'youtube_shorts']; }
            if (format === 'demand_carousel') group.carouselCards = cardValues().map(card => ({ headline: card.headline, images: { landscape: card.imageUrl }, ...(card.linkUrl ? { finalUrl: card.linkUrl } : {}) }));
            payload[format === 'pmax' ? 'assetGroup' : 'demandGen'] = group;
          }
        } else {
          if (format === 'text') payload.creativeFormat = 'text';
          else if (carousel) payload.carouselCards = cardValues();
          else if (video && platform !== 'tiktok') payload.video = { url: values.videoUrl.trim(), ...(values.thumbnailUrl?.trim() ? { thumbnailUrl: values.thumbnailUrl.trim() } : {}) };
          else payload.imageUrl = (platform === 'tiktok' ? values.videoUrl : values.imageUrl).trim();
          if (['facebook', 'linkedin', 'reddit'].includes(platform) && format !== 'text') payload.callToAction = values.callToAction;
          if (platform === 'facebook') payload.advantageAudience = values.advantageAudience === 'on' ? 1 : 0;
          if (platform === 'pinterest' && values.boardId?.trim()) payload.boardId = values.boardId.trim();
          if (platform === 'linkedin' && values.organizationId?.trim()) payload.organizationId = values.organizationId.trim();
          if (goal === 'lead_generation') payload.leadGenFormId = values.leadGenFormId.trim();
          if (goal === 'conversions' && (values.pixelId?.trim() || values.customEventType?.trim())) payload.promotedObject = { ...(values.pixelId?.trim() ? { pixelId: values.pixelId.trim() } : {}), ...(values.customEventType?.trim() ? { customEventType: values.customEventType.trim() } : {}) };
          if (platform === 'openai' && goal === 'awareness') { payload.bidStrategy = 'LOWEST_COST_WITH_BID_CAP'; payload.bidAmount = Number(values.bidAmount); }
        }
      }
      setBusy(true); await requester.current(boosting ? 'ads/boost' : 'ads/create', payload); if (isCurrent()) onCreated();
    } catch (err) { if (isCurrent() && (err as Error).name !== 'AbortError') setError((err as Error).message || 'The ad could not be created. Your entries are still here.'); } finally { if (isCurrent()) setBusy(false); }
  }
  return <form onSubmit={submit}>
    <p className="field-help">Ads and boosts start with their campaign paused. Review them before activation.</p>
    <fieldset disabled={busy || loading}>
      <label className="field"><span>Connected channel *</span><select required value={accountId} onChange={event => { const selected = connections.find(item => item._id === event.target.value); setAccountId(event.target.value); setFormat(formats[networks[selected?.platform || '']]?.[0][0] || 'image'); setGoal('traffic'); setMode('create'); }}><option value="">{loading ? 'Loading connected channels…' : 'Choose a connected channel'}</option>{connections.map(item => <option key={item._id} value={item._id}>{labels[networks[item.platform]]} · {item.displayName || item.username || item._id}</option>)}</select></label>
      {!loading && !connections.length && <p className="field-help">Connect an advertising account in project settings to create ads.</p>}
      {accountId && <>
        <label className="field"><span>Advertising account *</span><select required value={adAccountId} disabled={loadingAds} onChange={event => setAdAccountId(event.target.value)}><option value="">{loadingAds ? 'Loading advertising accounts…' : 'Choose an advertising account'}</option>{adAccounts.map(item => <option key={item.id} value={item.id} disabled={item.selectable === false}>{item.name || item.id}{item.currency ? ` · ${item.currency}` : ''}{item.selectable === false ? ' · Unavailable' : ''}</option>)}</select></label>
        {!loadingAds && !adAccounts.length && <p className="field-help">No advertising accounts are available. Check the connection’s permissions in its provider dashboard.</p>}
        {canBoost && <label className="field"><span>Campaign source</span><select value={mode} onChange={event => { setMode(event.target.value); setGoal('traffic'); }}><option value="create">Create a new ad</option><option value="boost">Boost a published social post</option></select></label>}
        {boosting ? <><label className="field"><span>Published post *</span><select name="postId" required defaultValue=""><option value="">Choose a published project post</option>{publishedPosts.map(post => <option key={post.id} value={post.id}>{post.content?.slice(0, 100) || post.id}</option>)}</select></label>{!publishedPosts.length && <p className="field-help">No published copies are available for this connected account. Publish a post to this account, then refresh its delivery status in Publishing.</p>}</> : <label className="field"><span>Ad format</span><select value={format} onChange={event => { setFormat(event.target.value); setGoal('traffic'); }}>{formats[platform]?.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
        <Field label="Campaign name" name="name" required maxLength={255}/>
        <div className="form-grid">{!assets || boosting ? <label className="field"><span>Campaign goal</span><select value={goal} onChange={event => setGoal(event.target.value)}>{goals.map(value => <option key={value} value={value}>{{ traffic: 'Website visits', awareness: 'Brand awareness', engagement: 'Engagement', video_views: 'Video views', conversions: 'Website conversions', lead_generation: 'Lead form submissions' }[value]}</option>)}</select></label> : <p className="field-help">Google optimizes this campaign for conversions. Configure conversion tracking in Google Ads before activation.</p>}<Field label={`Daily budget${currency ? ` (${currency})` : ''}`} name="budgetAmount" type="number" required min={minimum} max={10000000} step={step}/></div>
        <Field label="Target countries" name="countries" required defaultValue="AE" placeholder="AE, SA"/>
        <p className="field-help">Two-letter country codes, separated by commas. AE is the United Arab Emirates; SA is Saudi Arabia. Budgets use your account’s currency.{minimum > step ? ` Minimum: ${minimum} ${currency || ''}.` : ''}</p>
        <details><summary>Schedule{!boosting ? ' and audience' : ''}</summary><div className="form-grid"><Field label={platform === 'google' ? 'Start date (advertiser account timezone, optional)' : 'Start time (your timezone, optional)'} name="startDate" type={platform === 'google' ? 'date' : 'datetime-local'}/><Field label={platform === 'google' ? 'End date, inclusive (advertiser account timezone, optional)' : 'End time (your timezone, optional)'} name="endDate" type={platform === 'google' ? 'date' : 'datetime-local'}/></div>{!boosting && ['facebook', 'tiktok', 'pinterest'].includes(platform) && <><div className="form-grid"><Field label="Minimum age (optional)" name="ageMin" type="number" min={13} max={65}/><Field label="Maximum age (optional)" name="ageMax" type="number" min={13} max={65}/></div><label className="field"><span>Audience gender</span><select name="gender" defaultValue="all"><option value="all">Everyone</option><option value="male">Men</option><option value="female">Women</option></select></label></>}{!boosting && ['facebook', 'tiktok', 'google', 'reddit'].includes(platform) && <Field label="Audience languages (optional)" name="languages" placeholder="en, ar"/>}</details>
        {!boosting && <div key={platform + format}>
          {!assets && <>{platform !== 'tiktok' && <Field label="Headline" name="headline" required maxLength={platform === 'google' ? 30 : ({ pinterest: 100, linkedin: 400, twitter: 70, openai: 50, reddit: 300 }[platform] || 255)}/>}<Field label={platform === 'google' ? 'Description' : 'Ad text'} name="body" multiline required maxLength={platform === 'google' ? 90 : ({ pinterest: 500, twitter: 280, openai: 100, tiktok: 100, linkedin: 3000 }[platform] || 10000)}/></>}
          {format !== 'text' && goal !== 'lead_generation' && <Field label="Destination website" name="linkUrl" type="url" pattern="https://.+" required placeholder="https://yourbrand.com/collection"/>}
          {format === 'search' && <><Field label="Additional headlines (2–14, one per line, up to 30 characters)" name="additionalHeadlines" multiline required/><Field label="Additional descriptions (1–3, one per line, up to 90 characters)" name="additionalDescriptions" multiline required/><Field label="Search keywords (one per line)" name="keywords" multiline required/></>}
          {(format === 'display' || assets) && <><Field label="Business name" name="businessName" required maxLength={25}/>{!video && !carousel && <><Field label={assets ? 'Landscape image URLs (one per line)' : 'Landscape image URL'} name="landscape" multiline={assets} type="url" required/><Field label={assets ? 'Square image URLs (one per line)' : 'Square image URL'} name="square" multiline={assets} type="url" required/></>}{assets && <><Field label="Logo image URL" name="logo" type="url" required/><Field label={`Headlines (${format === 'pmax' ? '3–15, up to 30 characters' : carousel ? 'exactly 1, up to 40 characters' : '1–5, up to 40 characters'}, one per line)`} name="headlines" multiline required/><Field label={`Descriptions (${format === 'pmax' ? '2–5' : carousel ? 'exactly 1' : '1–5'}, one per line, up to 90 characters)`} name="descriptions" multiline required/>{format === 'pmax' && <><Field label="Long headline" name="longHeadline" required maxLength={90}/><Field label="YouTube video ID (optional)" name="youtubeVideoIds" maxLength={11}/><p className="field-help">Include a description of at most 60 characters. Use a landscape image of at least 600 × 314, square image of at least 300 × 300, and square logo of at least 128 × 128 pixels.</p></>}{format === 'demand_video' && <><Field label="YouTube video IDs (one per line, up to 5)" name="youtubeVideoIds" multiline required/><Field label="Long headlines (1–5, one per line)" name="longHeadlines" multiline required/><p className="field-help">Runs on YouTube in-stream, in-feed and Shorts. Enter each video’s 11-character ID.</p></>}</>}</>}
          {video && platform !== 'google' && <><Field label="Public MP4 video URL" name="videoUrl" type="url" pattern="https://.+" required/>{!['linkedin', 'tiktok'].includes(platform) && <Field label={platform === 'reddit' ? 'Video thumbnail image URL' : 'Video thumbnail image URL (optional)'} name="thumbnailUrl" type="url" required={platform === 'reddit'}/>}</>}
          {carousel && <><label className="field"><span>Number of carousel cards</span><select value={cards} onChange={event => setCards(Number(event.target.value))}>{Array.from({ length: 9 }, (_, index) => <option key={index} value={index + 2}>{index + 2} cards</option>)}</select></label>{Array.from({ length: cards }, (_, index) => <div key={index}><p>Card {index + 1}</p><Field label="Card headline" name={`cardHeadline${index}`} required maxLength={platform === 'google' ? 40 : 255}/><Field label={platform === 'google' ? 'Landscape image URL (1.91:1)' : 'Image URL'} name={`cardImage${index}`} type="url" required/><Field label="Card destination website (optional)" name={`cardLink${index}`} type="url"/></div>)}</>}
          {!video && !carousel && !['text', 'search', 'display', 'pmax'].includes(format) && !assets && <Field label="Public ad image URL" name="imageUrl" type="url" pattern="https://.+" required/>}
          {['facebook', 'linkedin', 'reddit'].includes(platform) && format !== 'text' && <label className="field"><span>Button text</span><select name="callToAction" defaultValue="LEARN_MORE"><option value="LEARN_MORE">Learn more</option><option value="SHOP_NOW">Shop now</option><option value="SIGN_UP">Sign up</option><option value="DOWNLOAD">Download</option>{platform !== 'linkedin' && <option value="CONTACT_US">Contact us</option>}</select></label>}
          {platform === 'facebook' && <label className="checkbox-label"><input type="checkbox" name="advantageAudience"/>Allow Meta to expand your audience with Advantage</label>}
          {platform === 'linkedin' && <Field label="LinkedIn Company Page ID (optional if owned by the ad account)" name="organizationId" placeholder="123456"/>}
          {platform === 'pinterest' && <Field label="Pinterest board ID (optional)" name="boardId" maxLength={200}/>}
          {goal === 'lead_generation' && <Field label="Existing lead form ID" name="leadGenFormId" required/>}
          {goal === 'conversions' && <>{platform !== 'openai' && <Field label="Tracking pixel ID" name="pixelId" required/>}<Field label={platform === 'openai' ? 'Conversion event ID or name (optional)' : 'Conversion event'} name="customEventType" required={platform !== 'openai'} placeholder={platform === 'tiktok' ? 'SHOPPING' : 'PURCHASE'}/><p className="field-help">Use a conversion event configured for this advertising account.</p></>}
          {platform === 'openai' && goal === 'awareness' && <Field label={`Fixed bid (${currency || 'account currency'})`} name="bidAmount" type="number" min={step} step={step} required/>}
          <p className="field-help">Media links must deliver public files over HTTPS. Google Drive preview links cannot be used as ad media. Video processing may take a few minutes; keep this dialog open.</p>
        </div>}
      </>}
    </fieldset>
    {error && <div className="alert" role="alert">{error}</div>}
    {error && !busy && (!connections.length || (accountId && !adAccounts.length)) && <button type="button" className="button" onClick={() => setRetry(value => value + 1)}>Reload accounts</button>}
    <div className="modal-actions"><button type="button" className="button" disabled={busy} onClick={onCancel}>Cancel</button><button className="button primary" disabled={busy || loading || loadingAds || !adAccount || adAccount.selectable === false || !currency}>{busy ? 'Creating paused campaign…' : boosting ? 'Create paused boost' : 'Create paused ad'}</button></div>
  </form>;
}
