import React, { useEffect, useRef, useState } from 'react';
import { AppField } from '@ten98/ui/app';
import { Alert, Button, Card, CodeBlock, ConfirmDialog, DataTable, Disclosure, Field as LabelledField, Fieldset, Form, FormActions, FormGrid, Heading, Image, Inline, Link, MetricCard, MetricGrid, Option, ReviewConfirm, Select, Stack, StatusLine, Text } from '@ten98/ui';
import { adCreativeView, adMetricCells, readHideAmounts } from './ads-view';

type Props = { request: (path: string, body?: any, validate?: (result: any) => void) => Promise<any>; campaign: any; canWrite: boolean; onChanged?: () => void; onClose?: () => void };
const lines = (value = '') => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
const copy = (value: any) => (Array.isArray(value) ? value : []).map((item: any) => typeof item === 'string' ? item : typeof item?.text === 'string' ? item.text : '').join('\n');
const count = (value: any) => typeof value === 'number' ? new Intl.NumberFormat().format(value) : '—';
const terminalStatus = (value: any) => ['rejected', 'completed', 'cancelled', 'archived', 'deleted'].includes(String(value || '').toLowerCase());
function checkedAdReview(result: any, ad: any, platform: string) {
  const object = (value: any) => !!value && typeof value === 'object' && !Array.isArray(value);
  const text = (value: any) => typeof value === 'string' && value.length <= 20000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), nullable = (value: any) => value === null || text(value);
  const list = (value: any, valid: (item: any) => boolean) => Array.isArray(value) && value.length <= 100 && value.every(valid);
  const map = (value: any, valid: (item: any) => boolean) => object(value) && Object.entries(value).length <= 100 && Object.entries(value).every(([key, item]) => text(key) && valid(item));
  const restricted = (value: any) => ['forbiddenPlacements', 'forbiddenAges', 'forbiddenLocations'].every(key => list(value[key], text));
  const review = result?.review;
  if (!object(result) || result.adId !== ad._id || result.platform !== platform || !nullable(result.platformAdId) || ad.platformAdId != null && result.platformAdId !== null && result.platformAdId !== ad.platformAdId || !object(review) || review.approved !== null && typeof review.approved !== 'boolean' || !nullable(review.reviewStatus) || !nullable(review.approvalStatus) || review.readAt !== null && (typeof review.readAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(review.readAt) || !Number.isFinite(Date.parse(review.readAt))) || !restricted(review) || !list(review.forbiddenOperatingSystems, text) || !list(review.rejections, row => object(row) && list(row.reasons, text) && nullable(row.suggestion) && restricted(row) && (row.content === null || object(row.content) && ['type', 'text', 'imageId', 'videoId', 'musicId'].every(key => nullable(row.content[key])))) || !list(review.policyTopics, row => object(row) && nullable(row.topic) && nullable(row.type) && list(row.evidences, object) && list(row.constraints, object)) || !object(review.reviewFeedback) || !map(review.reviewFeedback.global, text) || !map(review.reviewFeedback.placementSpecific, value => map(value, text)) || !list(review.issues, object)) throw new Error('The ad review response could not be verified. Load it again for the selected ad.');
  return review;
}
const campaignCopyPlatforms = ['facebook', 'instagram', 'tiktok', 'linkedin'];
function checkedCampaignCopy(value: any, sourceId: string, platform: string, metaAlias = false) {
  const id = (item: any) => typeof item === 'string' && !!item.trim() && item.length <= 500 && !/[\u0000-\u001f\u007f]/.test(item);
  if (!value || value.sourceCampaignId !== sourceId || value.platform !== platform && !(metaAlias && ['facebook', 'instagram'].includes(platform) && ['facebook', 'instagram'].includes(value.platform)) || value.copiedCampaignId !== null && (!id(value.copiedCampaignId) || value.copiedCampaignId === sourceId) || ![null, 'triggered', 'skipped', 'failed'].includes(value.discovery) || value.requestedStatus !== 'PAUSED' || !['pending', 'paused'].includes(value.verification) || value.statusReadAt !== null && (typeof value.statusReadAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value.statusReadAt) || !Number.isFinite(Date.parse(value.statusReadAt))) || value.verification === 'paused' && (!value.copiedCampaignId || !value.statusReadAt || value.platform === 'linkedin')) throw new Error('The campaign copy reference could not be verified. Review the existing provider outcome before continuing.');
  return value;
}
function checkedCopyReview(value: any, campaignId: string, platform: string) {
  const source = value?.source, text = (item: any) => typeof item === 'string' && item.length <= 20000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item), nullable = (item: any) => item === null || text(item);
  if (!source || source.sourceCampaignId !== campaignId || source.platform !== platform || !text(source.accountId) || !source.accountId || !text(source.adAccountId) || !source.adAccountId || !nullable(source.name) || !nullable(source.currency) || ![null, 'campaign', 'adset'].includes(source.budgetLevel) || source.campaignBudget !== null && (!source.campaignBudget || !Number.isFinite(source.campaignBudget.amount) || source.campaignBudget.amount < 0 || !['daily', 'lifetime'].includes(source.campaignBudget.type)) || ['adCount', 'adSetCount'].some(key => source[key] !== null && (!Number.isSafeInteger(source[key]) || source[key] < 0)) || !/^[a-f0-9]{64}$/.test(value.version || '') || typeof value.canCopy !== 'boolean' || typeof value.unresolved !== 'boolean' || value.previousCopy === undefined || value.canCopy && (value.unresolved || value.previousCopy !== null)) throw new Error('The campaign copy review could not be verified. Load a fresh review before continuing.');
  if (value.previousCopy !== null) checkedCampaignCopy(value.previousCopy, campaignId, platform, true);
  return value;
}
function checkedBudgetReview(result: any, campaignId: string, platform: string, adSetId: string | null, amount: number, currency: string) {
  const review = result?.budgetReview, id = (value: any) => typeof value === 'string' && value.length > 0 && value.length <= 500 && !/[\s\u0000-\u001f\u007f]/.test(value);
  const instant = (value: any) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  if (!review || review.campaignId !== campaignId || review.platform !== platform || review.adSetId !== adSetId || !id(review.accountId) || !id(review.adAccountId) || review.currency !== currency || !['AED', 'USD'].includes(currency) || review.proposedAmount !== amount || typeof review.currentAmount !== 'number' || !Number.isFinite(review.currentAmount) || review.currentAmount <= 0 || review.currentAmount === amount || review.type !== 'daily' || review.budgetLevel !== (adSetId === null ? 'campaign' : 'adset') || !instant(review.readAt) || Date.now() - Date.parse(review.readAt) > 60000 || Date.parse(review.readAt) > Date.now() + 30000 || !instant(review.expiresAt) || Date.parse(review.expiresAt) <= Date.now() || Date.parse(review.expiresAt) > Date.now() + 300000 || !/^[a-f0-9]{64}$/.test(review.version || '')) throw new Error('The daily budget review could not be verified. Load a fresh review before continuing.');
  return review;
}
const rsaValues = (values: Record<string, string>, key: string, maximum: number) => Array.from({ length: maximum }, (_, index) => ({ text: values[`rsa_${key}_${index}`]?.trim() || '', ...(values[`rsa_${key}_pin_${index}`] ? { pinnedField: values[`rsa_${key}_pin_${index}`] } : {}) })).filter(row => row.text);
function RsaAssets({ name, rows = [] }: { name: 'headlines' | 'descriptions'; rows?: any[] }) {
  const headline = name === 'headlines', minimum = headline ? 3 : 2, maximum = headline ? 15 : 4, limit = headline ? 30 : 90, label = headline ? 'Headline' : 'Description';
  const entries = Array.from({ length: maximum }, (_, index) => <FormGrid key={index}>
    <AppField label={`${label} ${index + 1}`} name={`rsa_${name}_${index}`} defaultValue={typeof rows[index]?.text === 'string' ? rows[index].text : ''} maxLength={limit}/>
    <LabelledField label={`Position for ${label.toLowerCase()} ${index + 1}`}><Select name={`rsa_${name}_pin_${index}`} defaultValue={rows[index]?.pinnedField || ''}><Option value="">Unpinned</Option>{Array.from({ length: headline ? 3 : 2 }, (_, pin) => <Option key={pin} value={`${headline ? 'HEADLINE' : 'DESCRIPTION'}_${pin + 1}`}>Position {pin + 1}</Option>)}</Select></LabelledField>
  </FormGrid>);
  const shown = Math.min(maximum, Math.max(minimum, rows.length));
  return <Fieldset legend={headline ? 'Headlines' : 'Descriptions'} description={`Keep ${minimum}–${maximum} entries, up to ${limit} characters each. Clear text to remove an entry.`}>{entries.slice(0, shown)}{shown < maximum && <Disclosure variant="plain" summary={`More ${name}`}><Stack gap={3}>{entries.slice(shown)}</Stack></Disclosure>}</Fieldset>;
}
function Field({ label, name, value, multiline = false, type = 'text', required = false }: { label: string; name: string; value?: any; multiline?: boolean; type?: string; required?: boolean }) {
  return <AppField label={label} name={name} multiline={multiline} type={type} defaultValue={multiline ? value || '' : value ?? ''} required={required} {...(!multiline && type === 'number' ? { step: 'any', min: 0 } : {})}/>;
}
// Ported from zernio-dev/ads-dashboard@4386edd components/dashboard/ad-detail-sheet.tsx (MIT): date-scoped list metrics win over the ad's stored ones.
function AdInsight({ ad, listed, currency }: { ad: any; listed?: any; currency?: string }) {
  const metrics = adMetricCells(listed && Object.keys(listed).length ? listed : ad.metrics, currency, readHideAmounts()), view = adCreativeView(ad.creative);
  return <Stack gap={3}>
    {metrics.length > 0 && <MetricGrid list label="Ad metrics" minItemWidth="sm">{metrics.map(cell => <MetricCard key={cell.label} label={cell.label} value={cell.value}/>)}</MetricGrid>}
    <Card title="Creative" headingLevel={4}>{view ? <Stack gap={2}>{view.image && <Image src={view.image} alt="Ad creative" fit="contain" rounded referrerPolicy="no-referrer"/>}{view.headline && <Text weight="semibold">{view.headline}</Text>}{view.body && <Text>{view.body}</Text>}{view.link && <Link href={view.link} target="_blank" rel="noopener noreferrer">{view.link}</Link>}</Stack> : <Text tone="muted">No creative data.</Text>}</Card>
  </Stack>;
}
export default function AdDetails({ request, campaign, canWrite, onChanged, onClose }: Props) {
  const requester = useRef(request); requester.current = request;
  const [data, setData] = useState<any>(null), [selected, setSelected] = useState<any>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [retry, setRetry] = useState(0);
  const [needsRefresh, setNeedsRefresh] = useState(false), [readVersion, setReadVersion] = useState(0);
  const [adSetAcceptance, setAdSetAcceptance] = useState<any>(null), statusLock = useRef<false | { pending: boolean }>(false);
  const [enableSetReview, setEnableSetReview] = useState<any>(null), currentEnableReview = useRef<any>(null);
  const [adReviewRead, setAdReviewRead] = useState<any>(null), pendingAdReview = useRef<object | null>(null);
  const [copyRead, setCopyRead] = useState<any>(null), currentCopyReview = useRef<any>(null), pendingCopyRead = useRef<object | null>(null), copyAttempt = useRef<any>(null);
  const latestCopyRead = useRef(copyRead); latestCopyRead.current = copyRead;
  const [budgetRead, setBudgetRead] = useState<any>(null), currentBudgetReview = useRef<any>(null);
  const [draftDirty, setDraftDirty] = useState(false), [pendingAction, setPendingAction] = useState<{ action: () => Promise<any>; message: string; forms: HTMLFormElement[]; current?: () => boolean } | null>(null);
  const [confirmingEnable, setConfirmingEnable] = useState(false);
  const detailsSection = useRef<HTMLElement>(null), editorForm = useRef<HTMLFormElement>(null), actionTrigger = useRef<HTMLElement | null>(null), pendingContinuation = useRef<typeof pendingAction>(null);
  const campaignId = campaign.platformCampaignId || campaign.campaignId || campaign.id, platform = campaign.platform;
  const identity = platform + ':' + campaignId, currentIdentity = useRef(identity), active = useRef(true); currentIdentity.current = identity;
  const isCurrent = () => active.current && currentIdentity.current === identity;
  const statusScope = useRef({ identity, canWrite, data });
  if (statusScope.current.identity !== identity || statusScope.current.canWrite !== canWrite || statusScope.current.data !== data) statusScope.current = { identity, canWrite, data };
  const statusView = statusScope.current;
  const copyState = copyRead?.view === statusView ? copyRead : null, budgetState = budgetRead?.view === statusView ? budgetRead : null;
  // Confirmation blocks share one lock: no confirm while a provider action, refresh or unsaved-change review is pending.
  const actionLocked = busy || needsRefresh || !!statusLock.current || !!pendingAction, lockedReason = actionLocked ? 'Wait for the current provider action or unsaved-change review to finish.' : undefined;
  const setAdStatus = (status: string) => act(async () => { await scopedRequest('ads/ad-status', { adId: live._id, status }); await readAd(live._id, true); }, `Ad switch ${status === 'active' ? 'enabled' : 'paused'}.`, true);
  async function scopedRequest(path: string, body?: any, validate?: (result: any) => void) {
    if (!isCurrent()) throw new DOMException('Ad selection changed.', 'AbortError');
    const result = await (validate ? requester.current(path, body, validate) : requester.current(path, body));
    if (!isCurrent()) throw new DOMException('Ad selection changed.', 'AbortError');
    return result;
  }
  const live = selected?.ad, creative = live?.creative || {}, channel = String(live?.advertisingChannelType || '').toLowerCase();
  const reviewScope = useRef({ statusView, selected });
  if (reviewScope.current.statusView !== statusView || reviewScope.current.selected !== selected) reviewScope.current = { statusView, selected };
  const reviewView = reviewScope.current, reviewState = adReviewRead?.view === reviewView ? adReviewRead : null, adReview = reviewState?.review;
  const rsaReviewCurrent = Boolean(selected?.creativeReview?.version && Date.parse(selected.creativeReview.expiresAt) > Date.now());
  const smartPlus = platform === 'tiktok' && (live?.isSmartPlus || data?.campaign?.isSmartPlus);
  useEffect(() => { active.current = true; let current = true; setBusy(true); setData(null); setSelected(null); setDraftDirty(false); pendingContinuation.current = null; setPendingAction(null); setNeedsRefresh(!!statusLock.current); setError(''); scopedRequest(`ads/items?campaignId=${encodeURIComponent(campaignId)}&platform=${encodeURIComponent(platform)}`).then(result => {
    if (!current || !isCurrent()) return;
    if (statusLock.current && (result?.campaign?.platform !== platform || String(result.campaign.platformCampaignId || result.campaign.campaignId || result.campaign.id || result.campaign._id) !== String(campaignId) || !Array.isArray(result.ads) || !Array.isArray(result.campaign.adSets) || result.campaign.adSets.some((row: any) => !row || typeof row.platformAdSetId !== 'string' || !row.platformAdSetId) || new Set(result.campaign.adSets.map((row: any) => row.platformAdSetId)).size !== result.campaign.adSets.length)) throw new Error('The refreshed ad sets could not be verified.');
    setData(result); statusLock.current = false; setNeedsRefresh(false);
  }).catch(err => { if (current && isCurrent() && err.name !== 'AbortError') setError((statusLock.current ? 'Refresh ad sets before making another change. ' : '') + err.message); }).finally(() => { if (current && isCurrent()) setBusy(false); }); return () => { current = false; active.current = false; }; }, [campaignId, platform, retry]);
  useEffect(() => { setAdSetAcceptance(null); currentBudgetReview.current = null; setBudgetRead(null); }, [campaignId, platform]);
  async function loadAdReview() {
    const fresh = () => isCurrent() && reviewScope.current === reviewView;
    if (!fresh() || !live?._id || !['facebook', 'instagram', 'google', 'tiktok'].includes(platform) || pendingAdReview.current === reviewView) return;
    pendingAdReview.current = reviewView; setAdReviewRead({ view: reviewView, busy: true });
    try {
      const result = await scopedRequest('ads/review?adId=' + encodeURIComponent(live._id));
      if (!fresh()) return;
      setAdReviewRead({ view: reviewView, busy: false, review: checkedAdReview(result, live, platform) });
    } catch (failure) { if (fresh() && (failure as Error).name !== 'AbortError') setAdReviewRead({ view: reviewView, busy: false, error: (failure as Error).message || 'The provider review could not be loaded.' }); }
    finally { if (pendingAdReview.current === reviewView) pendingAdReview.current = null; }
  }
  async function loadCopyReview() {
    const fresh = () => isCurrent() && statusScope.current === statusView;
    if (!fresh() || !data || !campaignCopyPlatforms.includes(platform) || busy || pendingAction || pendingCopyRead.current === statusView || copyAttempt.current?.pending) return;
    pendingCopyRead.current = statusView; currentCopyReview.current = null; setCopyRead({ view: statusView, busy: true });
    try {
      const response = await scopedRequest(`ads/copy-review?${new URLSearchParams({ campaignId, platform })}`);
      if (!fresh()) return;
      const review = checkedCopyReview(response, campaignId, platform), approval = review.canCopy && canWrite ? { view: statusView, review, phase: 'review' } : null;
      currentCopyReview.current = approval; setCopyRead({ view: statusView, busy: false, review, approval, campaignCopy: review.previousCopy });
    } catch (failure) { if (fresh() && (failure as Error).name !== 'AbortError') setCopyRead({ view: statusView, busy: false, error: (failure as Error).message }); }
    finally { if (pendingCopyRead.current === statusView) pendingCopyRead.current = null; }
  }
  async function confirmCampaignCopy(approval: any) {
    const fresh = () => isCurrent() && canWrite && statusScope.current === statusView && currentCopyReview.current === approval && approval?.view === statusView;
    if (!fresh() || approval.phase !== 'review' || !approval.review.canCopy || approval.review.unresolved || approval.review.previousCopy || busy || needsRefresh || statusLock.current || pendingAction || copyAttempt.current?.pending) return;
    approval.phase = 'approved'; setCopyRead((value: any) => ({ ...value, approval: null }));
    await act(async () => {
      if (!fresh() || approval.phase !== 'approved' || copyAttempt.current?.pending) return;
      approval.phase = 'sent'; const attempt = { pending: true }; copyAttempt.current = attempt;
      setCopyRead({ view: statusView, busy: true, review: approval.review });
      const validate = (result: any) => {
        if (!fresh()) throw new DOMException('Campaign selection changed.', 'AbortError');
        const receipt = checkedCampaignCopy(result?.campaignCopy, campaignId, platform);
        if (result?.operation?.status !== 'complete' || typeof result.operation.id !== 'string' || !result.operation.id || !receipt.copiedCampaignId || receipt.discovery === null || receipt.verification !== 'pending' || receipt.statusReadAt !== null) throw new Error('The copy acknowledgement could not be verified. The action key was retained; review the existing provider outcome before trying again.');
      };
      try {
        const response = await scopedRequest('ads/copy', { campaignId, platform, version: approval.review.version, confirmDuplicate: true }, validate);
        validate(response); setCopyRead({ view: statusView, busy: false, review: approval.review, campaignCopy: response.campaignCopy });
      } catch (failure) { if (fresh() && (failure as Error).name !== 'AbortError') setCopyRead({ view: statusView, busy: false, review: approval.review, error: `${(failure as Error).message} Review this action in Provider outcomes before requesting another copy.` }); }
      finally { if (copyAttempt.current === attempt) attempt.pending = false; }
    }, '', 'all', () => fresh() && ['approved', 'sent'].includes(approval.phase));
  }
  async function checkCampaignCopy(reference: any) {
    const fresh = () => isCurrent() && statusScope.current === statusView && latestCopyRead.current?.view === statusView && latestCopyRead.current.campaignCopy === reference;
    if (!fresh() || !reference?.copiedCampaignId || pendingCopyRead.current === statusView || copyAttempt.current?.pending) return;
    pendingCopyRead.current = statusView; setCopyRead({ ...copyState, busy: true, error: '' });
    try {
      const response = await scopedRequest(`ads/copy-status?${new URLSearchParams({ campaignId, platform: reference.platform, copiedCampaignId: reference.copiedCampaignId })}`);
      if (!fresh()) return;
      const receipt = checkedCampaignCopy(response?.campaignCopy, campaignId, reference.platform);
      if (receipt.copiedCampaignId !== reference.copiedCampaignId) throw new Error('The provider returned another campaign copy.');
      setCopyRead({ ...copyState, busy: false, campaignCopy: receipt, error: '' });
    } catch (failure) { if (fresh() && (failure as Error).name !== 'AbortError') setCopyRead({ ...copyState, busy: false, error: (failure as Error).message }); }
    finally { if (pendingCopyRead.current === statusView) pendingCopyRead.current = null; }
  }
  async function act(action: () => Promise<any>, message = '', reviewDraft: boolean | 'all' | HTMLFormElement = false, stillCurrent = isCurrent) {
    if (!stillCurrent()) return;
    const forms = reviewDraft === true ? draftDirty && editorForm.current ? [editorForm.current] : [] : reviewDraft ? Array.from(detailsSection.current?.querySelectorAll<HTMLFormElement>('form') || []).filter(form => (reviewDraft === 'all' || form !== reviewDraft) && hasDraft(form)) : [];
    if (forms.length) { const review = { action, message, forms, current: stillCurrent }; actionTrigger.current = document.activeElement as HTMLElement; pendingContinuation.current = review; setPendingAction(review); return; }
    setBusy(true); setError(''); setNotice(''); try { await action(); if (stillCurrent()) { setNotice(message); if (message) onChanged?.(); } } catch (err) { if (stillCurrent() && (err as Error).name !== 'AbortError') setError((err as Error).message); } finally { if (stillCurrent()) setBusy(false); }
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
      if (channel === 'search') {
        for (const [key, minimum, maximum, limit] of [['headlines', 3, 15, 30], ['descriptions', 2, 4, 90]] as const) if (`rsa_${key}_0` in values) {
          const rows = rsaValues(values, key, maximum);
          if (rows.length < minimum || rows.some(row => row.text.length > limit) || new Set(rows.map(row => row.text)).size !== rows.length) { setError(`Keep ${minimum}–${maximum} distinct ${key}, up to ${limit} characters each.`); return; }
          const previous = (Array.isArray(creative[key]) ? creative[key] : []).map((row: any) => ({ text: row.text, ...(row.pinnedField ? { pinnedField: row.pinnedField } : {}) }));
          if (JSON.stringify(rows) !== JSON.stringify(previous)) payload[key] = rows;
        }
      } else {
        if (values.headlines?.trim() && values.headlines !== copy(creative.headlines)) payload.headlines = lines(values.headlines);
        if (values.descriptions?.trim() && values.descriptions !== copy(creative.descriptions)) payload.descriptions = lines(values.descriptions);
      }
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
    const form = event.currentTarget;
    await act(async () => { await scopedRequest('ads/adset', payload); confirmForm(form); setRetry(value => value + 1); }, 'Ad set changes saved.', form);
  }
  async function loadBudgetReview(event: React.FormEvent<HTMLFormElement>, adSet: any = null) {
    event.preventDefault();
    const form = event.currentTarget, values = Object.fromEntries(new FormData(form)) as Record<string, string>, amount = Number(values.amount), currency = data?.campaign?.currency;
    const approval: any = { view: statusView, adSet, form, phase: 'loading' }, fresh = () => isCurrent() && canWrite && statusScope.current === statusView && currentBudgetReview.current === approval && !!data && (!adSet || data.campaign.adSets?.includes(adSet));
    if (!isCurrent() || !canWrite || statusScope.current !== statusView || !data || adSet && !data.campaign.adSets?.includes(adSet) || busy || needsRefresh || statusLock.current || pendingAction) return;
    if (!['facebook', 'instagram'].includes(platform) || !['AED', 'USD'].includes(currency) || !Number.isFinite(amount) || amount <= 0 || amount > 10000000 || Math.abs(amount * 100 - Math.round(amount * 100)) > 0.000001) { setError('Enter a daily budget above zero with at most two decimal places in AED or USD.'); return; }
    currentBudgetReview.current = approval; setBudgetRead({ view: statusView, adSet, busy: true });
    try {
      const result = await scopedRequest(`ads/${adSet ? 'adset' : 'campaign'}-budget-review?${new URLSearchParams({ campaignId, platform, ...(adSet ? { adSetId: adSet.platformAdSetId } : {}), amount: String(amount), currency })}`);
      if (!fresh()) return;
      approval.review = checkedBudgetReview(result, campaignId, platform, adSet?.platformAdSetId ?? null, amount, currency); approval.phase = 'review';
      setBudgetRead({ view: statusView, adSet, approval, busy: false });
    } catch (failure) { if (fresh() && (failure as Error).name !== 'AbortError') { currentBudgetReview.current = null; setBudgetRead({ view: statusView, adSet, busy: false, error: (failure as Error).message }); } }
  }
  async function confirmBudget(approval: any) {
    const fresh = () => isCurrent() && canWrite && statusScope.current === statusView && currentBudgetReview.current === approval && approval?.view === statusView && !!data && (!approval.adSet || data.campaign.adSets?.includes(approval.adSet));
    if (!fresh() || approval.phase !== 'review' || busy || needsRefresh || statusLock.current || pendingAction) return;
    if (Date.parse(approval.review.expiresAt) <= Date.now()) { currentBudgetReview.current = null; setBudgetRead({ view: statusView, adSet: approval.adSet, error: 'This budget review expired. Load a fresh review before confirming.' }); return; }
    approval.phase = 'approved'; setBudgetRead({ view: statusView, adSet: approval.adSet, busy: false });
    await act(async () => {
      if (!fresh() || approval.phase !== 'approved' || statusLock.current) return;
      approval.phase = 'sent'; const lock = { pending: true }; statusLock.current = lock; setNeedsRefresh(true);
      const review = approval.review;
      const validate = (result: any) => {
        if (!fresh()) throw new DOMException('Ad selection changed.', 'AbortError');
        const receipt = result?.budgetAcceptance;
        if (result?.operation?.status !== 'complete' || typeof result.operation.id !== 'string' || !result.operation.id || !receipt || ['campaignId', 'platform', 'adSetId', 'accountId', 'adAccountId', 'currency'].some(field => receipt[field] !== review[field]) || [receipt.requestedAmount, receipt.acknowledgedAmount, receipt.observedAmount].some(value => value !== review.proposedAmount) || typeof receipt.readAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(receipt.readAt) || !Number.isFinite(Date.parse(receipt.readAt)) || Date.now() - Date.parse(receipt.readAt) > 60000 || Date.parse(receipt.readAt) > Date.now() + 30000) throw new Error('The budget acknowledgement and live readback could not be verified. The action key was retained. Review Provider outcomes before another budget change.');
      };
      try {
        const result = await scopedRequest(approval.adSet ? 'ads/adset' : 'ads/campaign', { campaignId, platform, ...(approval.adSet ? { adSetId: review.adSetId } : {}), budget: { amount: review.proposedAmount, type: 'daily' }, currency: review.currency, version: review.version, reviewExpiresAt: review.expiresAt, confirmBudget: true }, validate);
        validate(result); setBudgetRead({ view: statusView, adSet: approval.adSet, receipt: result.budgetAcceptance }); confirmForm(approval.form); onChanged?.(); setRetry(value => value + 1);
      } finally { if (statusLock.current === lock) lock.pending = false; }
    }, '', approval.form, () => fresh() && ['approved', 'sent'].includes(approval.phase));
  }
  async function changeSetStatus(adSet: any, status: 'active' | 'paused', approval?: any) {
    const scopeCurrent = () => isCurrent() && statusScope.current === statusView && canWrite && data?.campaign?.adSets?.includes(adSet);
    if (!scopeCurrent() || busy || needsRefresh || statusLock.current || pendingAction || [data?.campaign?.status, data?.campaign?.platformCampaignStatus, adSet.status, adSet.adSetStatus, adSet.platformAdSetStatus].some(terminalStatus)) return;
    if (status === 'active') {
      if (!approval) { const review = { adSet, adSetId: adSet.platformAdSetId, view: statusView, phase: 'review' }; currentEnableReview.current = review; setEnableSetReview(review); return; }
      if (currentEnableReview.current !== approval || approval.adSet !== adSet || approval.adSetId !== adSet.platformAdSetId || approval.view !== statusView || approval.phase !== 'review') return;
      approval.phase = 'approved'; setEnableSetReview(null);
    } else { currentEnableReview.current = null; setEnableSetReview(null); }
    const fresh = () => scopeCurrent() && (status !== 'active' || currentEnableReview.current === approval && approval.phase === 'approved' && approval.adSetId === adSet.platformAdSetId);
    await act(async () => {
      if (!fresh() || statusLock.current) return;
      const lock = { pending: true }; statusLock.current = lock; setNeedsRefresh(true); setAdSetAcceptance(null);
      const validate = (result: any) => {
        if (!fresh()) throw new DOMException('Ad selection changed.', 'AbortError');
        const receipt = result?.statusAcceptance, plain = (value: any) => typeof value === 'string' && value.length > 0 && value.length <= 2000 && !/[\u0000-\u001f\u007f]/.test(value);
        if (result?.operation?.status !== 'complete' || !plain(result.operation.id) || !receipt || receipt.campaignId !== campaignId || receipt.platform !== platform || receipt.adSetId !== adSet.platformAdSetId || receipt.requestedStatus !== status || !['active', 'paused'].includes(receipt.deliveryStatus) || [receipt.platformAdSetStatus, receipt.platformCampaignStatus].some(value => value !== null && (!plain(value) || value.length > 200)) || receipt.statusReadAt !== null && (typeof receipt.statusReadAt !== 'string' || receipt.statusReadAt.length > 100 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(receipt.statusReadAt) || !Number.isFinite(Date.parse(receipt.statusReadAt))) || platform === 'twitter' && (receipt.statusReadAt !== null || receipt.platformAdSetStatus !== null) || ![0, 1].includes(receipt.updated) || ![0, 1].includes(receipt.skipped) || receipt.updated + receipt.skipped !== 1 || !Array.isArray(receipt.skippedReasons) || receipt.skippedReasons.length > 100 || receipt.skippedReasons.some((value: any) => typeof value !== 'string' || value.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))) throw new Error('The ad set status acknowledgement could not be verified. Refresh ad sets and review provider outcomes before trying again. The action key was retained.');
      };
      try {
        const result = await scopedRequest('ads/adset', { campaignId, platform, adSetId: adSet.platformAdSetId, status }, validate);
        validate(result); setAdSetAcceptance(result.statusAcceptance); onChanged?.(); setRetry(value => value + 1);
      } finally { if (statusLock.current === lock) lock.pending = false; }
    }, '', 'all', fresh);
  }
  async function editCampaign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>, payload: Record<string, any> = { campaignId, platform };
    if (values.name?.trim() && values.name.trim() !== (data.campaign.campaignName || data.campaign.name)) payload.name = values.name.trim();
    if (!['facebook', 'instagram'].includes(platform) && values.amount?.trim()) payload.budget = { amount: Number(values.amount), type: platform === 'openai' ? values.budgetType : 'daily' };
    const form = event.currentTarget;
    await act(async () => { await scopedRequest('ads/campaign', payload); confirmForm(form); setRetry(value => value + 1); }, 'Campaign changes saved.', form);
  }
  function confirmForm(form: HTMLFormElement | null, outcome = 'saved') {
    if (!isCurrent()) return;
    form?.dispatchEvent(new CustomEvent('campaign:editor-saved', { bubbles: true, detail: { form, outcome } }));
    if (form === editorForm.current) { setDraftDirty(false); pendingContinuation.current = null; setPendingAction(null); }
  }
  function discardDraft() {
    if (!pendingAction || pendingContinuation.current !== pendingAction || !isCurrent() || pendingAction.current && !pendingAction.current()) return;
    pendingContinuation.current = null;
    for (const form of pendingAction.forms) { form.reset(); confirmForm(form, 'discarded'); }
    setPendingAction(null); void act(pendingAction.action, pendingAction.message, false, pendingAction.current);
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
  const budgetPanel = budgetState && <Stack gap={3}>{budgetState.busy && <StatusLine busy>Reading the live daily budget…</StatusLine>}{budgetState.error && <Alert tone="danger" variant="inline">{budgetState.error}</Alert>}{budgetState.approval && currentBudgetReview.current === budgetState.approval && budgetState.approval.phase === 'review' && <Stack role="alert"><ReviewConfirm title={`Review ${budgetState.adSet ? 'daily budget' : 'daily campaign budget'}`} reviewKey={budgetState.approval.review.version} acknowledgements={[]} confirmLabel={budgetState.adSet ? 'Confirm daily budget' : 'Confirm daily campaign budget'} cancelLabel={budgetState.adSet ? 'Cancel daily budget' : 'Cancel daily campaign budget'} disabledReason={lockedReason} onCancel={() => { if (currentBudgetReview.current === budgetState.approval && statusScope.current === statusView && isCurrent()) { currentBudgetReview.current = null; setBudgetRead(null); } }} onConfirm={() => confirmBudget(budgetState.approval)}><Stack gap={2}><Text>{budgetState.adSet ? 'Ad set' : 'Campaign'}: {budgetState.adSet ? budgetState.adSet.adSetName || budgetState.adSet.platformAdSetId : data.campaign.campaignName || data.campaign.name || campaignId} ({budgetState.approval.review.adSetId ?? campaignId}) · Ad account: {budgetState.approval.review.adAccountId}</Text><Text>Current daily budget: {budgetState.approval.review.currentAmount} {budgetState.approval.review.currency} → Proposed daily budget: {budgetState.approval.review.proposedAmount} {budgetState.approval.review.currency}</Text><Text>Provider budget read time: {budgetState.approval.review.readAt}</Text><Text>{budgetState.adSet ? 'This changes the spending budget for every ad in this ad set. The campaign, sibling ad sets and all delivery switches stay unchanged.' : 'This changes the campaign spending budget shared by its ad sets and ads. Their delivery switches stay unchanged.'} Provider billing and delivery rules still apply; this amount is not a guarantee of actual spend.</Text></Stack></ReviewConfirm></Stack>}</Stack>;
  return <Stack as="section" gap={4} {...{ ref: detailsSection }}>
    <Inline justify="between" align="center"><Stack gap={1}><Heading level={2}>{campaign.campaignName || campaign.name || 'Campaign details'}</Heading><Text tone="muted" size="sm">Ads, delivery and conversions.</Text></Stack>{onClose && <Button variant="secondary" onClick={onClose}>Close</Button>}</Inline>
    {error && <Alert tone="danger">{error}</Alert>}{notice && <StatusLine tone="success">{notice}</StatusLine>}
    {enableSetReview && enableSetReview.view === statusView && currentEnableReview.current === enableSetReview && canWrite && data?.campaign?.adSets?.includes(enableSetReview.adSet) && <Stack role="alert"><ReviewConfirm title={`Enable ad set “${enableSetReview.adSet.adSetName || enableSetReview.adSetId}”?`} reviewKey={enableSetReview.adSetId} acknowledgements={[]} confirmLabel="Confirm enable ad set" cancelLabel="Cancel enable ad set" disabledReason={lockedReason} onCancel={() => { if (isCurrent() && currentEnableReview.current === enableSetReview && enableSetReview.view === statusView && enableSetReview.phase === 'review') { currentEnableReview.current = null; setEnableSetReview(null); } }} onConfirm={() => changeSetStatus(enableSetReview.adSet, 'active', enableSetReview)}><Text>This ad set can spend when its campaign and ads are enabled. Their own switches will stay unchanged.</Text></ReviewConfirm></Stack>}
    {budgetRead?.receipt && <StatusLine tone="success">{budgetRead.receipt.adSetId === null ? 'Daily campaign budget' : 'Daily budget'} request accepted: {budgetRead.receipt.acknowledgedAmount} {budgetRead.receipt.currency} for {budgetRead.receipt.adSetId ?? budgetRead.receipt.campaignId}. Independent live budget read: {budgetRead.receipt.observedAmount} {budgetRead.receipt.currency} at {budgetRead.receipt.readAt}. Delivery switches were not changed by this request.</StatusLine>}
    {adSetAcceptance && <Stack gap={1} role="status"><Text>{adSetAcceptance.requestedStatus === 'active' ? 'Enable' : 'Pause'} ad set request accepted for {adSetAcceptance.adSetId}.{adSetAcceptance.skipped === 1 && ' The provider reported the requested switch was already set; no write was needed.'}</Text><Text>Delivery reported: {adSetAcceptance.deliveryStatus} · Provider ad set status: {adSetAcceptance.platformAdSetStatus || 'Not reported'} · Parent campaign status: {adSetAcceptance.platformCampaignStatus || 'Not reported'}</Text><Text>{adSetAcceptance.statusReadAt ? `Status read ${new Date(adSetAcceptance.statusReadAt).toLocaleString()}.` : 'Live ad set switch read unavailable. Delivery is a provider fallback, not live switch verification.'}</Text>{adSetAcceptance.skippedReasons.map((reason: string, index: number) => <Text key={index}>{reason}</Text>)}</Stack>}
    {pendingAction && <Alert tone="warning" role="alert" title="Discard unsaved changes?"><Stack gap={2}>
      <Text>This action reloads the details below. Discard unsaved changes in the affected forms to continue.</Text>
      <Inline gap={2}>
        <Button variant="secondary" autoFocus onClick={() => { if (pendingContinuation.current !== pendingAction) return; pendingContinuation.current = null; currentEnableReview.current = null; currentCopyReview.current = null; currentBudgetReview.current = null; setBudgetRead(null); setCopyRead((value: any) => value ? { ...value, approval: null } : value); setEnableSetReview(null); setPendingAction(null); actionTrigger.current?.focus(); }}>Keep editing</Button>
        <Button variant="danger" onClick={discardDraft}>Discard changes and continue</Button>
      </Inline>
    </Stack></Alert>}
    {busy && <StatusLine busy>Loading provider details…</StatusLine>}
    {!data && !busy && <Inline><Button variant="secondary" onClick={() => setRetry(value => value + 1)}>Reload ads</Button></Inline>}
    {data?.backfillPending && <Text tone="muted" size="sm">Some historical results are still being backfilled. Refresh after the provider finishes.</Text>}
    {data && <>
      {campaignCopyPlatforms.includes(platform) && <Stack as="section" gap={3} aria-label="Paused campaign copy"><Heading level={3} size="sm">Paused campaign copy</Heading><Inline><Button variant="secondary" disabled={busy || !!pendingAction || !!copyState?.busy} onClick={loadCopyReview}>{copyState?.review ? 'Refresh copy review' : 'Load copy review'}</Button></Inline>{copyState?.busy && <StatusLine busy>Loading campaign copy information…</StatusLine>}{copyState?.error && <Alert tone="danger" variant="inline">{copyState.error}</Alert>}{copyState?.review && <>
        <Text>Source: {copyState.review.source.name ?? 'Unknown name'} ({copyState.review.source.sourceCampaignId}) · Connection: {copyState.review.source.accountId} · Ad account: {copyState.review.source.adAccountId}</Text><Text>Budget scope: {copyState.review.source.budgetLevel ?? 'Unknown'} · Campaign budget: {copyState.review.source.campaignBudget ? `${copyState.review.source.campaignBudget.amount} ${copyState.review.source.currency ?? '(currency unknown)'} ${copyState.review.source.campaignBudget.type}` : 'Unknown'}</Text><Text>Reported source ads: {copyState.review.source.adCount ?? 'Unknown'} · Reported source ad sets: {copyState.review.source.adSetCount ?? 'Unknown'}</Text><Text>Request one whole-campaign copy including child ad sets, ads, creatives and targeting, with PAUSED requested and discovery triggered. Check the copied campaign separately before treating its state as verified.</Text>
        {copyState.review.unresolved && <Alert tone="warning" role="alert" variant="inline">A previous provider outcome is unresolved. Review it in Provider outcomes before requesting another copy.</Alert>}
        {copyState.approval && currentCopyReview.current === copyState.approval && copyState.approval.phase === 'review' && canWrite && <Stack role="alert"><ReviewConfirm title="Confirm this whole-campaign copy with PAUSED requested?" reviewKey={copyState.approval.review.version} acknowledgements={[]} confirmLabel="Confirm paused campaign copy" cancelLabel="Cancel campaign copy" disabledReason={lockedReason} onCancel={() => { if (isCurrent() && statusScope.current === statusView && currentCopyReview.current === copyState.approval && copyState.approval.phase === 'review') { currentCopyReview.current = null; setCopyRead({ ...copyState, approval: null }); } }} onConfirm={() => confirmCampaignCopy(copyState.approval)}/></Stack>}
      </>}{copyState?.campaignCopy && <Stack gap={1} role="status"><Text>Provider-reported copied campaign: {copyState.campaignCopy.copiedCampaignId ?? 'Not reported'} · Discovery: {copyState.campaignCopy.discovery ?? 'Not reported'} · Requested status: PAUSED</Text><Text>{copyState.campaignCopy.verification === 'paused' ? 'Copied campaign paused state verified by an explicit provider check.' : 'Copied campaign ownership and paused state remain unverified.'} Child completeness is unknown.</Text><Text>Provider status read time: {copyState.campaignCopy.statusReadAt ?? 'Not reported'}</Text>{copyState.campaignCopy.copiedCampaignId && <Inline><Button variant="secondary" disabled={!!copyState.busy} onClick={() => checkCampaignCopy(copyState.campaignCopy)}>Check copy</Button></Inline>}</Stack>}</Stack>}
      <DataTable searchable={false} sortable={false} pagination={false} ariaLabel="Campaign ads" rows={data.ads} rowKey={(ad: any) => ad._id} emptyState={<Text tone="muted">No ads were returned for this campaign.</Text>} columns={[
        { key: 'name', header: 'Ad', rowHeader: true, render: (ad: any) => ad.name || 'Untitled ad' },
        { key: 'status', header: 'Delivery', render: (ad: any) => ad.status || 'Unknown' },
        { key: 'conversions', header: 'Conversions', numeric: true, render: (ad: any) => count(ad.metrics?.conversions) },
        { key: 'purchaseValue', header: 'Purchase value', numeric: true, render: (ad: any) => ad.metrics?.purchaseValue == null ? '—' : `${count(ad.metrics.purchaseValue)} ${data.campaign.currency || ''}` },
        { key: 'roas', header: 'Return on ad spend', numeric: true, render: (ad: any) => ad.metrics?.roas == null ? '—' : `${Number(ad.metrics.roas).toFixed(2)}×` },
      ]} rowActionsLabel="Actions" rowActions={(ad: any) => <Button variant="secondary" size="sm" disabled={busy || !!pendingAction} aria-label={`View details for ${ad.name || 'untitled ad'}`} onClick={() => act(() => readAd(ad._id), '', true)}>View details</Button>}/>
      {canWrite && (['google', 'openai', 'reddit', 'facebook', 'instagram'].includes(platform)) && <Disclosure summary="Campaign settings"><Stack gap={4}><Form onSubmit={(_, event) => editCampaign(event)}><Stack as="fieldset" gap={3} disabled={busy || !!pendingAction}>{['facebook', 'instagram', 'reddit'].includes(platform) && <Field label="Campaign name" name="name" value={data.campaign.campaignName || data.campaign.name}/>}<Text tone="muted" size="sm">Campaign budgets apply to every ad set and ad in this campaign. Shared Google budgets require changes in the provider dashboard.</Text>{platform === 'openai' && <><LabelledField label="Campaign budget type"><Select name="budgetType" defaultValue={data.campaign.campaignBudget?.type || data.campaign.budget?.type || 'daily'}><Option value="daily">Daily spend limit</Option>{(data.campaign.budget?.type === 'lifetime' || data.campaign.campaignBudget?.type === 'lifetime') && <Option value="lifetime">Lifetime spend limit</Option>}</Select></LabelledField><Field label={`New campaign budget (${data.campaign.currency || 'account currency'}) · optional`} name="amount" type="number"/><Text tone="muted" size="sm">A lifetime campaign can switch to daily. A daily campaign cannot switch back to lifetime; create a new campaign for that budget type.</Text></>}{(['google', 'reddit'].includes(platform) || data.campaign.budgetLevel === 'campaign') && !['facebook', 'instagram', 'openai'].includes(platform) && data.campaign.budget?.type !== 'lifetime' && data.campaign.campaignBudget?.type !== 'lifetime' && <Field label={`New daily campaign budget (${data.campaign.currency || 'account currency'}) · optional`} name="amount" type="number"/>}<FormActions><Button variant="primary" type="submit">Save campaign</Button></FormActions></Stack></Form>{['facebook', 'instagram'].includes(platform) && ['AED', 'USD'].includes(data.campaign.currency) && <Form onSubmit={(_, event) => loadBudgetReview(event)} onChange={() => { if (currentBudgetReview.current?.adSet === null) { currentBudgetReview.current = null; setBudgetRead(null); } }}><Stack as="fieldset" gap={3} disabled={busy || needsRefresh || !!statusLock.current || !!pendingAction || [data.campaign.status, data.campaign.platformCampaignStatus].some(terminalStatus)}><Field label={`New daily campaign budget (${data.campaign.currency})`} name="amount" type="number" required/><FormActions><Button variant="secondary" type="submit" disabled={!!budgetState?.busy}>Review daily campaign budget</Button></FormActions></Stack></Form>}{budgetState?.adSet === null && budgetPanel}</Stack></Disclosure>}
      {canWrite && data.campaign.adSets?.length > 0 && <Inline><Button variant="secondary" disabled={busy || !!pendingAction} onClick={() => { if (isCurrent() && statusScope.current === statusView && !busy && !pendingAction && !(statusLock.current && statusLock.current.pending)) void act(async () => { if (statusScope.current === statusView && !(statusLock.current && statusLock.current.pending)) setRetry(value => value + 1); }, '', 'all', () => isCurrent() && statusScope.current === statusView); }}>Refresh ad sets</Button></Inline>}
      {canWrite && data.campaign.adSets?.map((adSet: any) => <Disclosure key={adSet.platformAdSetId} summary={`Ad set · ${adSet.adSetName || adSet.platformAdSetId}`}><Stack gap={4}><Inline gap={2}>{(['paused', 'active'] as const).map(status => <Button variant="secondary" key={status} disabled={busy || needsRefresh || !!statusLock.current || !!pendingAction || [data.campaign.status, data.campaign.platformCampaignStatus, adSet.status, adSet.adSetStatus, adSet.platformAdSetStatus].some(terminalStatus)} onClick={() => changeSetStatus(adSet, status)}>{status === 'active' ? 'Enable ad set' : 'Pause ad set'}</Button>)}</Inline><Text tone="muted" size="sm">These actions change only this ad set’s switch. Its campaign, sibling ad sets and the ads’ own switches stay unchanged.</Text><Form onSubmit={(_, event) => editSet(event, adSet)}><Stack as="fieldset" gap={3} disabled={busy || !!pendingAction}><Field label="Ad set name" name="name" value={adSet.adSetName} required/><FormActions><Button variant="primary" type="submit">Save ad set</Button></FormActions></Stack></Form>{['facebook', 'instagram'].includes(platform) && ['AED', 'USD'].includes(data.campaign.currency) && data.campaign.budgetLevel === 'adset' && adSet.budget?.type !== 'lifetime' && adSet.adSetBudget?.type !== 'lifetime' && <Form onSubmit={(_, event) => loadBudgetReview(event, adSet)} onChange={() => { if (currentBudgetReview.current?.adSet === adSet) { currentBudgetReview.current = null; setBudgetRead(null); } }}><Stack as="fieldset" gap={3} disabled={busy || needsRefresh || !!statusLock.current || !!pendingAction || [data.campaign.status, adSet.status].some(terminalStatus)}><Field label={`New daily budget (${data.campaign.currency})`} name="amount" type="number" required/><FormActions><Button variant="secondary" type="submit" disabled={!!budgetState?.busy}>Review daily budget</Button></FormActions></Stack></Form>}{budgetState?.adSet === adSet && budgetPanel}</Stack></Disclosure>)}
    </>}
    {live && <Stack gap={4} key={live._id + ':' + readVersion}>
      <Stack gap={1}><Heading level={3}>{live.name || 'Ad details'}</Heading><Text tone="muted" size="sm">Delivery: {live.status || 'Unknown'} · Ad switch: {live.configuredStatus || 'Not reported'} · Review: {live.reviewStatus || 'Not reported'}</Text></Stack>
      {live.rejectionReason && <Alert tone="warning" variant="inline">{live.rejectionReason}</Alert>}
      {!selected.statusReadAt && <Text tone="muted" size="sm">The live status read was unavailable. These are the provider’s last stored values.</Text>}
      <AdInsight ad={live} listed={data?.ads?.find((ad: any) => ad._id === live._id)?.metrics} currency={data?.campaign?.currency}/>
      {['facebook', 'instagram', 'google', 'tiktok'].includes(platform) && <Stack as="section" gap={3} aria-label="Ad review diagnostics"><Heading level={4} size="sm">Ad review</Heading><Text tone="muted" size="sm">Provider review diagnostics are separate from delivery and the ad’s switches.</Text><Inline><Button variant="secondary" disabled={!!reviewState?.busy} onClick={loadAdReview}>{adReview ? 'Refresh ad review' : 'Load ad review'}</Button></Inline>{reviewState?.busy && <StatusLine busy>Loading ad review…</StatusLine>}{reviewState?.error && <Alert tone="danger" variant="inline">{reviewState.error}</Alert>}{adReview && <>
        <Text>Approval: {adReview.approved === null ? 'Not reported' : adReview.approved ? 'Approved' : 'Not approved'} · Review status: {adReview.reviewStatus ?? 'Not reported'} · Approval status: {adReview.approvalStatus ?? 'Not reported'}</Text><Text>Provider review read time: {adReview.readAt ?? 'Not reported'}</Text>
        {(['forbiddenPlacements', 'forbiddenAges', 'forbiddenLocations', 'forbiddenOperatingSystems'] as const).map((key, index) => adReview[key].length > 0 && <Text key={key}>{['Restricted placements', 'Restricted ages', 'Restricted locations', 'Restricted operating systems'][index]}: {adReview[key].join(', ')}</Text>)}
        {adReview.rejections.map((row: any, index: number) => <Stack key={index} gap={1}><Heading level={5} size="sm">Provider rejection {index + 1}</Heading>{row.reasons.map((reason: string, reasonIndex: number) => <Text key={reasonIndex} preserveWhitespace>{reason}</Text>)}{row.suggestion !== null && <Text preserveWhitespace>Provider advice: {row.suggestion}</Text>}{(['forbiddenPlacements', 'forbiddenAges', 'forbiddenLocations'] as const).map((key, field) => row[key].length > 0 && <Text key={key}>{['Restricted placements', 'Restricted ages', 'Restricted locations'][field]}: {row[key].join(', ')}</Text>)}{row.content && <Disclosure variant="plain" summary="Content reported by the provider"><Stack gap={1}>{(['type', 'text', 'imageId', 'videoId', 'musicId'] as const).map(key => row.content[key] !== null && <Text key={key} preserveWhitespace>{key}: {row.content[key]}</Text>)}</Stack></Disclosure>}</Stack>)}
        {adReview.policyTopics.map((row: any, index: number) => <Disclosure key={index} summary={`Policy topic: ${row.topic ?? 'Not reported'}`}><Stack gap={2}><Text>Type: {row.type ?? 'Not reported'}</Text><CodeBlock label="Provider evidence" code={JSON.stringify(row.evidences, null, 2)} wrap/><CodeBlock label="Provider constraints" code={JSON.stringify(row.constraints, null, 2)} wrap/></Stack></Disclosure>)}
        {(Object.keys(adReview.reviewFeedback.global).length > 0 || Object.keys(adReview.reviewFeedback.placementSpecific).length > 0) && <Disclosure summary="Provider review feedback"><Stack gap={2}><CodeBlock label="General feedback" code={JSON.stringify(adReview.reviewFeedback.global, null, 2)} wrap/><CodeBlock label="Placement feedback" code={JSON.stringify(adReview.reviewFeedback.placementSpecific, null, 2)} wrap/></Stack></Disclosure>}
        {adReview.issues.length > 0 && <Disclosure summary="Provider issues"><CodeBlock label="Provider issues" code={JSON.stringify(adReview.issues, null, 2)} wrap/></Disclosure>}
        {!adReview.rejections.length && !adReview.policyTopics.length && !adReview.issues.length && !Object.keys(adReview.reviewFeedback.global).length && !Object.keys(adReview.reviewFeedback.placementSpecific).length && <Text>No policy detail was returned for this read.</Text>}
      </>}</Stack>}
      <Inline><Button variant="secondary" disabled={busy || !!pendingAction} onClick={() => act(() => readAd(live._id), '', true)}>Refresh ad details</Button></Inline>
      {canWrite && !['rejected', 'completed', 'cancelled', 'archived', 'deleted'].includes(live.status) && platform !== 'twitter' && <Inline gap={2}>{['paused', 'active'].map(status => <Button variant="secondary" key={status} disabled={busy || needsRefresh || !!pendingAction} onClick={() => { if (status === 'active') { setConfirmingEnable(true); return; } setAdStatus(status); }}>{status === 'active' ? 'Enable ad' : 'Pause ad'}</Button>)}</Inline>}
      <ConfirmDialog open={confirmingEnable} onOpenChange={setConfirmingEnable} title="Enable this ad?" description="Enable this ad? It can spend when its campaign and ad set are also enabled." confirmLabel="Enable ad" onConfirm={() => setAdStatus('active')}/>
      {platform === 'openai' && <Text tone="muted" size="sm">ChatGPT creative and audience edits require a new campaign. Use Campaign settings for its budget and the delivery controls above for its ad switch.</Text>}
      {smartPlus && <Text tone="muted" size="sm">This TikTok Smart+ ad supports its delivery switch here. Change its creative and audience in TikTok Ads Manager.</Text>}
      {platform === 'google' && channel === 'search' && !rsaReviewCurrent && <Alert tone="warning" role="status" variant="inline">Current Google Search creative could not be verified. Refresh ad details before changing text or destinations. Delivery controls remain available.</Alert>}
      {canWrite && !smartPlus && platform !== 'openai' && !['rejected', 'completed', 'cancelled', 'archived', 'deleted'].includes(live.status) && <Form {...{ ref: editorForm }} onChange={trackDraft} onSubmit={(_, event) => edit(event)}><Stack as="fieldset" gap={3} disabled={busy || needsRefresh || !!pendingAction}>
        {['facebook', 'instagram'].includes(platform) && <Field label="Ad name" name="name" value={live.name}/>}
        {['facebook', 'instagram', 'tiktok', 'linkedin'].includes(platform) && <>{platform !== 'tiktok' && <Field label="Headline" name="headline" value={creative.headline || creative.googleHeadline}/>}<Field label="Ad text" name="body" multiline value={creative.body}/><Field label="Destination website" name="linkUrl" type="url" value={creative.linkUrl}/>{platform === 'linkedin' && <Text tone="muted" size="sm">LinkedIn creative changes need a new image or video. The provider creates a replacement creative and pauses the old one.</Text>}{platform !== 'tiktok' && <Field label="Replacement image URL (optional)" name="imageUrl" type="url"/>}<Field label="Replacement video URL (optional)" name="videoUrl" type="url"/></>}
        {platform === 'google' && ['search', 'display'].includes(channel) && <Stack as="fieldset" gap={3} disabled={channel === 'search' && !rsaReviewCurrent}>{channel === 'search' ? <><RsaAssets name="headlines" rows={Array.isArray(creative.headlines) ? creative.headlines : []}/><RsaAssets name="descriptions" rows={Array.isArray(creative.descriptions) ? creative.descriptions : []}/><Text tone="muted" size="sm">Pin text to a position when it must appear there. Choose Unpinned to let Google choose its position.</Text><Field label="Destination websites (one per line)" name="finalUrls" multiline value={copy(creative.finalUrls)}/></> : <><Field label="Headlines (one per line)" name="headlines" multiline value={copy(creative.headlines)}/><Field label="Descriptions (one per line)" name="descriptions" multiline value={copy(creative.descriptions)}/><Field label="Destination website" name="linkUrl" type="url" value={creative.finalUrls?.[0]}/></>}<Text tone="muted" size="sm">Each changed list replaces its complete contents. Keep every entry you want to retain.</Text>{channel === 'display' && <><Field label="Long headline" name="longHeadline" value={creative.longHeadline}/><Field label="Business name" name="businessName" value={creative.businessName}/><Field label="Replacement landscape image URL (optional)" name="imageUrl" type="url"/><Field label="Replacement square image URL (optional)" name="squareImageUrl" type="url"/></>}</Stack>}
        {['facebook', 'instagram', 'tiktok', 'linkedin', 'google'].includes(platform) && <><Field label="Replace target countries (optional, such as AE, SA)" name="countries"/><Text tone="muted" size="sm">Changing countries replaces the location audience for every ad sharing this ad set, or the Google campaign.</Text></>}
        {platform === 'google' && ['performance_max', 'demand_gen'].includes(channel) && <Disclosure summary="Replace Google creative assets"><Stack gap={3}><Text tone="muted" size="sm">Fill only the fields you want to change. Each supplied list replaces that entire asset role. Existing assets remain in the provider’s library. Carousel cards cannot be changed after creation.</Text><Field label={`Replacement headlines (one per line, ${channel === 'performance_max' ? '3–15, up to 30 characters' : '1–5, up to 40 characters'})`} name="assetHeadlines" multiline/><Field label={`Replacement descriptions (one per line, ${channel === 'performance_max' ? '2–5' : '1–5'}, up to 90 characters)`} name="assetDescriptions" multiline/><Field label="Replacement business name" name="assetBusinessName"/><Field label="Replacement destination website" name="assetFinalUrl" type="url"/>{channel === 'performance_max' ? <Field label="Replacement long headline" name="assetLongHeadline"/> : <Field label="Replacement long headlines (video ads only, one per line)" name="assetLongHeadlines" multiline/>}<Field label="Replacement landscape image URLs (one per line, image ads only)" name="asset_landscape" multiline/><Field label="Replacement square image URLs (one per line, image ads only)" name="asset_square" multiline/><Field label="Replacement logo image URLs (one per line)" name="asset_logo" multiline/><Field label="Replacement YouTube video IDs (one per line, video ads only)" name="assetYoutubeIds" multiline/></Stack></Disclosure>}
        {['pinterest', 'twitter', 'openai', 'reddit'].includes(platform) && <Text tone="muted" size="sm">Change this network’s creative and audience in its provider dashboard.</Text>}
        {['facebook', 'instagram', 'tiktok', 'linkedin', 'google'].includes(platform) && <FormActions><Button variant="primary" type="submit" disabled={busy}>Save ad changes</Button></FormActions>}
      </Stack></Form>}
    </Stack>}
  </Stack>;
}
