import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import { Alert, Badge, Button, Card, Checkbox, CodeBlock, DescriptionList, DetailWorkspace, Disclosure, EmptyState, FeatureControls, Field, FormActions, Grid, Heading, Inline, Link, List, ListItem, Option, Progress, ReviewSummary, SegmentedControl, Select, SelectableList, StatusLine, Stack, Text, Textarea, ValidationSummary, type ReviewChange, type SelectableListItem, type ValidationTarget } from '@ten98/ui';
import { PostVariantPreview } from './PostComposer';
import { PLATFORM_RULES } from '../shared/social-posts.ts';
import { reviewKeyAction } from './review-keys';
import { useFocusReturn } from './focus-return';
import { adSpendActionLabel, adSpendPlatformLabel, formatMinorUnits } from './approval-status';

type Props = { projectId: string; role: string; currentUserId?: string; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>; onChanged?: () => void | Promise<void>; onOpenSettings?: () => void };
const label = (value: string) => ({ not_requested: 'Not requested', pending: 'Awaiting review', approved: 'Approved', rejected: 'Changes requested', stale: 'Changed since review', submitted: 'Submitted to provider' }[value] || value);
const when = (value: string) => new Date(value).toLocaleString();
const short = (value: string) => new Date(value).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
// A post edited after its approval needs review again; any other drift from the reviewed version reads as changed.
const statusLabel = (item: any) => item.status === 'stale' && item.review?.status === 'approved' ? 'Edited after approval' : label(item.status);
const statusTone = (status: string): 'success' | 'danger' | 'neutral' | 'warning' => status === 'approved' ? 'success' : status === 'rejected' ? 'danger' : status === 'not_requested' || status === 'submitted' ? 'neutral' : 'warning';
const viewLabels: Record<string, string> = { waiting: 'Waiting on me', pending: 'All pending', rejected: 'Changes requested', approved: 'Approved', all: 'All' };
const missingNote = 'Add a comment so the author knows what to change.';
const platformNames = (platforms: string[] = []) => platforms.map(name => PLATFORM_RULES[name]?.label || name).join(', ');
const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function link(value?: string) { try { const url = new URL(value || ''); return url.protocol === 'https:' && !url.username && !url.password ? url.href : ''; } catch { return ''; } }
// Reviewed text keeps its line breaks without native pre-wrap markup.
const lines = (text: unknown) => <Text preserveWhitespace>{String(text ?? '')}</Text>;
// The Approve button and the A key share one block: an unverified queue or any creative not yet approved.
// A submitted post has no queue to verify, and a proposed update is checked against the creative it would send.
const approveBlocked = (item: any) => Boolean(item.post.queueId && !item.queue?.ready && !item.publishedEdit && !item.proposedUpdate) || (item.proposedUpdate?.assets || item.assets || (item.asset ? [item.asset] : [])).some((asset: any) => asset.missing || asset.approval !== 'approved');
type Restriction = { platform?: string; field?: string; message: string; accountId?: string };
// One validation target per platform and account, as the server reports the restrictions that refused an approval.
const restrictionTargets = (rows: Restriction[]): ValidationTarget[] => Object.values(rows.reduce<Record<string, ValidationTarget>>((targets, row, index) => { const key = (row.platform || '') + ':' + (row.accountId || ''), target = targets[key] ||= { id: key, target: [row.platform ? PLATFORM_RULES[row.platform]?.label || row.platform : 'Post', row.accountId && 'Account ' + row.accountId].filter(Boolean).join(' · '), status: 'error', messages: [] }; target.messages = [...(target.messages || []), { id: String(index), text: row.message }]; return targets; }, {}));
const postName = (item: any) => String(item.post.content || '').trim().slice(0, 60) || item.post.id;
const options = (platform: string, values: Record<string, unknown>) => Object.entries(values).map(([key, value]) => ({ key, term: PLATFORM_RULES[platform]?.options.find((option: any) => option.key === key)?.label || key, description: value && typeof value === 'object' ? <CodeBlock code={JSON.stringify(value, null, 2)} label={key} wrap/> : <Stack gap={0}>{lines(typeof value === 'boolean' ? value ? 'On' : 'Off' : String(value))}</Stack> }));
// A pending review of a change to a submitted post: the post is already with the provider, yet the change awaits review.
// A published-copy edit carries `publishedEdit`; a social/update (council ten98-code-system#30 Q2) carries only `proposal`,
// the request body, and its snapshot is the whole post after the update.
const reviewItem = (item: any) => { const snapshot = item.status === 'submitted' && item.review?.status === 'pending' ? item.review.snapshot : null, edit = snapshot?.publishedEdit; return edit ? { ...item, status: 'pending', publishedEdit: edit } : snapshot?.proposal && typeof snapshot.proposal === 'object' ? { ...item, status: 'pending', proposedUpdate: snapshot } : item; };
// The account and the proposed text or YouTube metadata beside the post's current copy of that account.
function PublishedEditComparison({ post, edit }: { post: any; edit: any }) {
  const metadata = edit.path === 'social/update-metadata', tags = (values: string[]) => values.length ? values.join(', ') : 'Remove all keyword tags';
  const current = post.providerVariants?.find((target: any) => target.accountId === edit.accountId && typeof target.customContent === 'string')?.customContent ?? post.accountOverrides?.[edit.accountId]?.content ?? post.platformOverrides?.[edit.platform]?.content ?? post.content;
  return <Stack as="section" gap={2} aria-label="Proposed change to a published copy">
    <Text><Text as="strong">Account:</Text> {PLATFORM_RULES[edit.platform]?.label || edit.platform} · {edit.accountId}{metadata ? ` · Video ${edit.videoId}` : ''}</Text>
    <Grid columns={2}>
      <Stack gap={1}><Heading level={5}>Current copy</Heading>{metadata ? <>{Object.hasOwn(edit, 'title') && <Text><Text as="strong">Title:</Text> Not available in Campaign; check YouTube Studio.</Text>}{Object.hasOwn(edit, 'tags') && <Text><Text as="strong">Keyword tags:</Text> {post.tags?.length ? post.tags.join(', ') : 'None stored'}</Text>}</> : lines(current)}</Stack>
      <Stack gap={1}><Heading level={5}>Proposed change</Heading>{metadata ? <>{Object.hasOwn(edit, 'title') && <Text preserveWhitespace><Text as="strong">Title:</Text> {edit.title}</Text>}{Object.hasOwn(edit, 'tags') && <Text preserveWhitespace><Text as="strong">Keyword tags:</Text> {tags(edit.tags || [])}</Text>}</> : lines(edit.content)}</Stack>
    </Grid>
  </Stack>;
}
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const creativeState = (asset: any) => asset?.missing ? 'Missing from this project' : asset?.approval === 'approved' ? 'Approved asset' : 'Asset approval required';
// Each field a pending social/update proposes, beside the post's current local copy. Versions and media are summarised;
// a changed or added version opens as a preview.
function ProposedUpdateComparison({ item }: { item: any }) {
  const post = item.post, next = item.proposedUpdate, proposal = next.proposal, has = (key: string) => Object.hasOwn(proposal, key), plain = (text: string) => <Text>{text}</Text>;
  const schedule = (value: string) => plain(value ? when(value) : 'No planned time');
  const tags = (values: unknown) => Array.isArray(values) && values.length ? <List>{values.map((tag, index) => <ListItem key={index}>{String(tag)}</ListItem>)}</List> : plain('No keyword tags');
  const media = (items: unknown, changed = false) => plain(Array.isArray(items) && items.length ? plural(items.length, 'media item') + (changed ? ' · changed' : '') : 'No media');
  const creative = (id: string, asset: any) => plain(id ? `${creativeState(asset)} · ${id}` : 'No referenced creative');
  const versions = (id: string, label: string, current: Record<string, any> = {}, proposed: Record<string, any> = {}, account = false): ReviewChange => {
    const platformOf = (key: string, variant: any) => account ? variant.platform : key, name = (key: string, variant: any) => (PLATFORM_RULES[platformOf(key, variant)]?.label || platformOf(key, variant)) + (account ? ` · Account ${key}` : '');
    const state = (key: string) => !Object.hasOwn(current, key) ? 'added' : !Object.hasOwn(proposed, key) ? 'removed' : JSON.stringify(current[key]) === JSON.stringify(proposed[key]) ? 'unchanged' : 'changed';
    const keys = [...new Set([...Object.keys(current), ...Object.keys(proposed)])], shown = keys.filter(key => ['added', 'changed'].includes(state(key)));
    return { id, label, before: plain(Object.keys(current).length ? plural(Object.keys(current).length, 'version') : 'No versions'), after: keys.length ? <Stack gap={2}><List>{keys.map(key => <ListItem key={key}>{name(key, current[key] || proposed[key])}: {state(key)}</ListItem>)}</List>{shown.map(key => <Disclosure key={key} summary={`Preview the proposed ${name(key, proposed[key])} version`}><PostVariantPreview platform={platformOf(key, proposed[key])} accountName={account ? key : undefined} variant={proposed[key]} scheduled={Boolean(next.scheduledAt)}/></Disclosure>)}</Stack> : plain('No versions') };
  };
  const changes = [
    has('content') && { id: 'content', label: 'Text', before: lines(post.content), after: lines(next.content) },
    (has('mode') || has('scheduledAt')) && { id: 'schedule', label: 'Schedule', before: schedule(post.scheduledAt), after: proposal.mode === 'draft' ? plain('Draft at the provider · no planned time') : schedule(next.scheduledAt) },
    has('tags') && { id: 'tags', label: 'Keyword tags', before: tags(post.tags), after: tags(next.tags) },
    has('mediaItems') && { id: 'media', label: 'Media', before: media(post.mediaItems), after: media(next.mediaItems, post.mediaItems?.length === next.mediaItems?.length && JSON.stringify(post.mediaItems) !== JSON.stringify(next.mediaItems)) },
    has('assetId') && { id: 'creative', label: 'Creative', before: creative(post.assetId, item.asset), after: creative(next.assetId, next.asset) },
    has('platformOverrides') && versions('platforms', 'Platform versions', post.platformOverrides, next.platformOverrides),
    (has('accountOverrides') || has('platformOverrides') && Object.keys(post.accountOverrides || {}).length > 0) && versions('accounts', 'Account versions', post.accountOverrides, next.accountOverrides, true),
  ].filter(Boolean) as ReviewChange[];
  return <ReviewSummary title="Review the update" description="Current values are the post as stored in Campaign. Proposed values are the post after this update." scope={(post.platforms || []).map((platform: string) => PLATFORM_RULES[platform]?.label || platform).join(', ') || 'No platforms'} resource={`Post ${post.id}`} changes={changes}
    consequences={<Text>{proposal.confirmReplaceVariants ? 'The update replaces the saved platform and account versions. ' : ''}Approving does not send the update to the provider.</Text>}/>;
}

// What changed since the version last sent for review (ten98-campaign#125). Each field a stale post differs in, the
// reviewed value beside the saved one; a drift outside these fields (a queue or an asset approval) only names the state.
function ReviewedChanges({ item }: { item: any }) {
  const before = item.review?.snapshot, post = item.post, plain = (text: string) => <Text>{text}</Text>;
  if (!before || typeof before !== 'object') return <Text tone="muted" size="sm">The current draft differs from the reviewed version. Request review again after your edits are ready.</Text>;
  const differs = (...keys: string[]) => keys.some(key => JSON.stringify(before[key] ?? null) !== JSON.stringify(post[key] ?? null));
  const schedule = (value: string) => plain(value ? when(value) : 'No planned time'), names = (values: string[] = []) => plain(values.join(', ') || 'None');
  const media = (items: unknown) => plain(Array.isArray(items) && items.length ? plural(items.length, 'media item') : 'No media');
  const changes = [
    differs('content') && { id: 'content', label: 'Text', before: lines(before.content), after: lines(post.content) },
    differs('scheduledAt') && { id: 'schedule', label: 'Schedule', before: schedule(before.scheduledAt), after: schedule(post.scheduledAt) },
    differs('platforms') && { id: 'platforms', label: 'Platforms', before: names(before.platforms), after: names(post.platforms) },
    differs('accounts') && { id: 'recipients', label: 'Recipients', before: names(before.accounts), after: names(post.accounts) },
    differs('mediaItems', 'assetId') && { id: 'media', label: 'Media', before: media(before.mediaItems), after: <Stack gap={1}>{media(post.mediaItems)}<Inline><Badge tone="warning">Media replaced</Badge></Inline></Stack> },
    differs('platformOverrides', 'accountOverrides') && { id: 'versions', label: 'Platform and account versions', before: plain('As reviewed'), after: plain('Changed') },
  ].filter(Boolean) as ReviewChange[];
  return <ReviewSummary title={statusLabel(item) === 'Edited after approval' ? 'Edited after approval: needs review again' : 'Changed since the last review'} description="Reviewed values are the version last sent for review. Current values are the saved post." scope={platformNames(post.platforms) || 'No platforms'} resource={`Post ${post.id}`} changes={changes}
    consequences={<Text>{changes.length ? '' : 'A queue or creative changed since the review. '}Request review again when your edits are ready.</Text>}/>;
}

// Ad spend reviews (council decision ten98-code-system#35, Q1). Each review is one exact change: subject, platform, action,
// amount in minor units and currency. A blocked activation or budget increase opens its review on the server; approving
// allows one matching provider write and never sends it.
const spendSubject = (action: string) => action === 'ooh/booking' ? 'OOH booking' : action.includes('ad-status') ? 'Ad' : action.includes('adset') ? 'Ad set' : 'Campaign';
// The server supplies when an approval stops being usable; an unused one past it needs re-approval.
const spendExpired = (review: any) => review.status === 'approved' && !review.consumed && typeof review.expiresAt === 'string' && Date.parse(review.expiresAt) <= Date.now();
const spendStatus = (review: any) => spendExpired(review) ? 'Expired' : label(review.status);
const spendTone = (review: any) => spendExpired(review) ? 'warning' : statusTone(review.status);
// The requested change as an amount and a share of the current budget; nothing when either amount cannot be read.
function spendDelta(change: any) {
  const { amount, currentAmount, currency } = change;
  if (!Number.isSafeInteger(amount) || !Number.isSafeInteger(currentAmount)) return '';
  const difference = amount - currentAmount, sign = difference > 0 ? '+' : difference < 0 ? '-' : '';
  return [sign + formatMinorUnits(Math.abs(difference), currency), currentAmount > 0 ? `${sign}${Math.round(Math.abs(difference) / currentAmount * 1000) / 10}%` : ''].filter(Boolean).join(' · ');
}
type SpendReviewProps = { review: any; canReview: boolean; busy: boolean; note: string; noteError: boolean; onNote: (note: string) => void; onDecide: (decision: string) => void; onKeyDown: (event: KeyboardEvent<HTMLElement>) => void };
function SpendReview({ review, canReview, busy, note, noteError, onNote, onDecide, onKeyDown }: SpendReviewProps) {
  const change = review.snapshot || {}, platform = adSpendPlatformLabel(String(change.platform || '')), subject = `${spendSubject(String(change.action || ''))} ${change.subjectId}`, expired = spendExpired(review), delta = spendDelta(change), noteId = 'review-note-spend:' + review.id;
  const requested = formatMinorUnits(change.amount, change.currency);
  return <Card as="article" id={'review-spend:' + review.id} tabIndex={0} onKeyDown={onKeyDown} headingLevel={4} title={`${adSpendActionLabel(String(change.action || ''))} · ${platform}`} description={subject} actions={<Inline gap={1}><Badge tone="info">Spend</Badge><Badge tone={spendTone(review)} dot>{spendStatus(review)}</Badge></Inline>}><Stack gap={3}>
    <ReviewSummary title="Spend change" scope={platform} resource={subject} changes={[
      { id: 'budget', label: change.activates ? 'Budget that starts spending' : 'Budget', before: formatMinorUnits(change.currentAmount, change.currency), after: delta ? <Stack gap={0}><Text>{requested}</Text><Text tone="muted" size="sm">{delta}</Text></Stack> : requested },
      ...(change.activates ? [{ id: 'delivery', label: 'Delivery', before: 'Not running', after: 'Starts when the change is sent' }] : []),
    ]} consequences={<Text>{change.activates ? 'This change starts ad delivery.' : 'This change raises the budget; it does not start delivery on its own.'} Approving allows one matching change and never sends it to the provider.</Text>}/>
    <Text tone="muted" size="sm">Requested by {review.requestedBy?.name || 'Team member'} · {when(review.requestedAt)}{review.reviewedAt && <> · {label(review.status)}{review.reviewedBy ? ` by ${review.reviewedBy.name || 'Administrator'}` : ''}{review.selfApproved ? ' (only administrator)' : ''} · {when(review.reviewedAt)}</>}</Text>
    {review.note && <Stack gap={0}>{lines(review.note)}</Stack>}
    {review.status === 'approved' && <Text tone="muted" size="sm">{review.consumed ? 'This approval was used by a provider change.' : expired ? 'This approval expired before it was used. Make the same change again to request re-approval.' : 'Approved and not yet used. Make the same change again to send it.'}</Text>}
    {canReview && review.status === 'pending' && <Stack as="fieldset" gap={3} disabled={busy}><Field label="Comment" description="Required when you request changes." htmlFor={noteId} error={noteError ? missingNote : undefined}><Textarea id={noteId} rows={2} maxLength={2000} value={note} onChange={event => onNote(event.target.value)}/></Field><FormActions><Button onClick={() => onDecide('approved')}>Approve spend change</Button><Button variant="secondary" onClick={() => onDecide('rejected')}>Request changes</Button></FormActions></Stack>}
    <Text tone="muted" size="sm">While ad spend approval is required, activating a campaign, ad set or ad and raising a budget wait for an owner or administrator. Pausing, ending and lowering budgets never need approval.</Text>
  </Stack></Card>;
}

// One row of the review list: a post or a spend change, its status as a dot badge, and its planned or requested time.
const queueRow = (entry: any): SelectableListItem => entry.kind === 'spend'
  ? { id: entry.key, title: adSpendActionLabel(String(entry.review.snapshot?.action || '')), preview: `${spendSubject(String(entry.review.snapshot?.action || ''))} ${entry.review.snapshot?.subjectId} · ${adSpendPlatformLabel(String(entry.review.snapshot?.platform || ''))}`, meta: entry.requestedAt ? short(entry.requestedAt) : undefined, status: <Inline gap={1}><Badge tone="info">Spend</Badge><Badge tone={spendTone(entry.review)} dot>{spendStatus(entry.review)}</Badge></Inline> }
  : { id: entry.key, title: postName(entry.item), preview: platformNames(entry.item.post.platforms) || 'No platforms', meta: entry.scheduledAt ? short(entry.scheduledAt) : 'No planned time', status: <Badge tone={statusTone(entry.status)} dot>{statusLabel(entry.item)}</Badge> };

export default function ContentApprovals({ projectId, role, currentUserId = '', request, onChanged, onOpenSettings }: Props) {
  const [data, setData] = useState<any>(null), [busy, setBusy] = useState(''), [error, setError] = useState(''), [notice, setNotice] = useState(''), [filter, setFilter] = useState(['owner', 'admin', 'editor'].includes(role) ? 'waiting' : 'all'), [notes, setNotes] = useState<Record<string, string>>({});
  const [openId, setOpenId] = useState(''), advance = useRef<{ id: string; index: number } | null>(null);
  const [selected, setSelected] = useState<string[]>([]), [bulk, setBulk] = useState<{ done: number; total: number } | null>(null), [bulkResult, setBulkResult] = useState<{ decision: string; ok: number; skipped: number; failed: { id: string; name: string; message: string }[] } | null>(null);
  const [sort, setSort] = useState('requested'), [platform, setPlatform] = useState('');
  const [restrictions, setRestrictions] = useState<Record<string, Restriction[]>>({});
  const [spend, setSpend] = useState<any>(null), [noteError, setNoteError] = useState(''), [bulkNote, setBulkNote] = useState('');
  const active = useRef(true), readVersion = useRef(0), spendVersion = useRef(0), shown = useRef(0), focusNext = useRef(''), path = `/projects/${encodeURIComponent(projectId)}/approvals`, canReview = ['owner', 'admin'].includes(role), canRequest = ['owner', 'admin', 'editor'].includes(role);
  function acceptItem(item: any) { if (active.current) setData((previous: any) => previous ? { ...previous, posts: previous.posts.map((entry: any) => entry.post.id === item.post.id ? item : entry) } : previous); }
  async function load() {
    if (!active.current) return; const read = ++readVersion.current;
    try { const result = await request(path + '/posts'); if (active.current && read === readVersion.current) setData(result); }
    catch (err) { if (active.current && read === readVersion.current) throw err; }
  }
  useEffect(() => { active.current = true; const loading = load(), read = readVersion.current; loading.catch(err => { if (active.current && read === readVersion.current) setError(err.message); }); return () => { active.current = false; }; }, [projectId]);
  // Spend reviews share the list. Changing the ad spend setting voids unused approvals and pending requests (council
  // decision on #35 Q1), so the list reloads with it and voided reviews show as changes requested. The first read waits
  // for the queue, which states the setting.
  const required = data ? Boolean(data.requireAdApproval) : null;
  async function loadSpend() {
    const read = ++spendVersion.current, result = await request(path + '/ad-spend');
    if (active.current && read === spendVersion.current) setSpend(result);
  }
  useEffect(() => { if (required !== null) loadSpend().catch(err => { if (active.current) setError(err.message); }); }, [path, required]);
  // A refused approval returns the publishing restrictions that blocked it; keep them beside that post until its next attempt.
  function noteRestrictions(postId: string, failure: unknown) {
    const problem = failure as { code?: string; details?: unknown } | null;
    const rows = problem?.code === 'APPROVAL_POST_RESTRICTIONS' && Array.isArray(problem.details) ? problem.details.filter((row: any) => row && typeof row.message === 'string' && row.message && ['platform', 'field', 'accountId'].every(key => row[key] === undefined || typeof row[key] === 'string')).slice(0, 100) : [];
    setRestrictions(previous => { const { [postId]: _previous, ...rest } = previous; return rows.length ? { ...rest, [postId]: rows } : rest; });
  }
  const rememberFocus = useFocusReturn(busy);
  // Waiting on me (ten98-campaign#125): a review someone else asked an owner or administrator for, or my own request
  // returned with changes. The server still decides who may approve; this only chooses what to show first.
  const requester = (row: any) => String(row?.requestedBy?.id || ''), mine = (entry: any) => Boolean(currentUserId) && entry.requester === currentUserId;
  const waiting = (entry: any) => canReview && entry.status === 'pending' && !mine(entry) || entry.status === 'rejected' && mine(entry);
  const inView = (entry: any, view: string) => view === 'all' || (view === 'waiting' ? waiting(entry) : entry.status === view);
  // Counts, sort and platform filter follow pendpost/pendpost@42ac77b29f7720a912bdce1507b16a2a56fca74f app/src/components/Freigaben.jsx:54-60, 807-833 and 896-920 (MIT):
  // each count uses the list's own platform filter, so a count never promises entries the list hides. Only loaded data is used.
  const inPlatform = (entry: any) => !platform || entry.platforms.includes(platform);
  const time = (value: unknown) => { const parsed = Date.parse(String(value)); return Number.isFinite(parsed) ? parsed : null; };
  const byTime = (left: number | null, right: number | null, newest = false) => left === null ? right === null ? 0 : 1 : right === null ? -1 : newest ? right - left : left - right;
  // "Waiting on me" always puts the soonest planned time first, then the oldest request; other views follow the Sort choice.
  const byReviewOrder = (a: any, b: any) => filter === 'waiting' ? byTime(time(a.scheduledAt), time(b.scheduledAt)) || byTime(time(a.requestedAt), time(b.requestedAt)) : sort === 'planned' ? byTime(time(a.scheduledAt), time(b.scheduledAt)) : byTime(time(a.requestedAt), time(b.requestedAt), true);
  const loaded = (data?.posts || []).map((item: any) => reviewItem(item)).filter((item: any) => !item.post.sample);
  const entries = [
    ...loaded.map((item: any) => ({ key: item.post.id, kind: 'post', item, status: item.status, requester: requester(item.review), requestedAt: item.review?.requestedAt, scheduledAt: item.post.scheduledAt, platforms: item.post.platforms || [] })),
    ...(spend?.reviews || []).filter(Boolean).map((row: any) => ({ key: 'spend:' + row.id, kind: 'spend', review: row, status: row.status, requester: requester(row), requestedAt: row.requestedAt, scheduledAt: undefined, platforms: [row.snapshot?.platform] })),
  ];
  const views = [...(canRequest ? ['waiting'] : []), 'pending', 'rejected', 'approved', 'all'];
  const counts: Record<string, number> = Object.fromEntries(views.map(view => [view, entries.filter(entry => inPlatform(entry) && inView(entry, view)).length]));
  const visible = entries.filter(entry => inPlatform(entry) && inView(entry, filter)).sort(byReviewOrder);
  const platformChoices: string[] = [...new Set([...loaded.flatMap((item: any) => item.post.platforms || []), ...(platform ? [platform] : [])])];
  // The open review: the one chosen, else the entry now at the last open position, so a decided review that leaves the
  // view hands over to the next one. '#list' is the list on its own (narrow screens, after Back).
  let openIndex = visible.findIndex(entry => entry.key === openId);
  if (openIndex < 0 && openId !== '#list') openIndex = Math.min(shown.current, visible.length - 1);
  if (openIndex >= 0) shown.current = openIndex;
  const open = visible[openIndex];
  function switchView(view: string) { setFilter(view); setOpenId(''); shown.current = 0; }
  // A comment is required to request changes; the field says so and takes focus instead of sending.
  function needNote(key: string) { advance.current = null; setNoteError(key); document.getElementById('review-note-' + key)?.focus(); }
  // A failed action also drops a pending keyboard move, so a later refresh cannot jump focus to another card.
  // Focus returns to the clicked control, or to its review card once a review removes that card's buttons.
  // A spend decision leaves the post queue's read in place (`queueRead`), since it does not reload that queue.
  async function action(name: string, run: () => Promise<void>, queueRead = true) {
    if (busy || !active.current) return; rememberFocus(document.getElementById('review-' + name)); if (queueRead) readVersion.current++; setBusy(name); setError(''); setNotice(''); noteRestrictions(name, null);
    try { await run(); } catch (err) { if (active.current) { setError((err as Error).message || 'This review could not be saved.'); noteRestrictions(name, err); } advance.current = null; }
    finally { if (active.current) setBusy(''); }
  }
  async function review(item: any, decision: string) {
    if (decision === 'rejected' && !(notes[item.post.id] || '').trim()) { needNote(item.post.id); return; }
    await action(item.post.id, async () => { const result = await request(`${path}/posts/${encodeURIComponent(item.post.id)}/review`, 'POST', { decision, note: notes[item.post.id] || '', reviewId: item.review.id }); if (!active.current) return; acceptItem(result.item); setNotes(previous => ({ ...previous, [item.post.id]: '' })); setNotice(decision === 'approved' ? 'Post approved. Publishing remains a separate action.' : 'Changes requested. The author can update this draft and request another review.'); await onChanged?.(); await load(); });
  }
  const posts = visible.filter(entry => entry.kind === 'post').map(entry => entry.item);
  async function decideSpend(row: any, decision: string) {
    const key = 'spend:' + row.id;
    if (decision === 'rejected' && !(notes[key] || '').trim()) { needNote(key); return; }
    await action(key, async () => {
      await request(`${path}/ad-spend/review`, 'POST', { reviewId: row.id, decision, note: notes[key] || '' }); if (!active.current) return;
      setNotes(previous => ({ ...previous, [key]: '' })); setNotice(decision === 'approved' ? 'Spend change approved. Make the same change again to send it to the provider.' : 'Changes requested. The spend change was not sent.');
      await onChanged?.(); await loadSpend();
    }, false);
  }
  // Bulk review ported from pendpost/pendpost@42ac77b29f7720a912bdce1507b16a2a56fca74f app/src/components/Freigaben.jsx:1013-1100 and 1213-1276 (MIT):
  // it touches only the visible, actionable, selected posts and sends each one the single-card review request in turn.
  // Spend changes are never bulk reviewed. A hidden or no-longer-pending post can stay in the selection, so every count
  // and the loop use this intersection.
  const actionable = canReview ? posts.filter((item: any) => item.status === 'pending') : [], chosen = actionable.filter((item: any) => selected.includes(item.post.id)), blockedChosen = chosen.filter((item: any) => approveBlocked(item)).length;
  const uncommented = chosen.some((item: any) => !(notes[item.post.id] || '').trim()) && !bulkNote.trim();
  async function bulkReview(decision: string) {
    const targets = decision === 'approved' ? chosen.filter((item: any) => !approveBlocked(item)) : chosen;
    if (!targets.length) return;
    // Requesting changes needs a comment for every post: its own, or the shared comment for the authors.
    if (decision === 'rejected' && !bulkNote.trim() && targets.some((item: any) => !(notes[item.post.id] || '').trim())) { setError('Add a comment for the authors before requesting changes.'); return; }
    await action('bulk', async () => {
      const succeeded: string[] = [], failed: { id: string; name: string; message: string }[] = [];
      setBulkResult(null); setBulk({ done: 0, total: targets.length });
      try {
        for (const item of targets) {
          try { const result = await request(`${path}/posts/${encodeURIComponent(item.post.id)}/review`, 'POST', { decision, note: notes[item.post.id] || (decision === 'rejected' ? bulkNote.trim() : ''), reviewId: item.review.id }); if (!active.current) return; acceptItem(result.item); succeeded.push(item.post.id); }
          catch (err) { if (!active.current) return; noteRestrictions(item.post.id, err); failed.push({ id: item.post.id, name: postName(item), message: (err as Error).message || 'This review could not be saved.' }); }
          setBulk({ done: succeeded.length + failed.length, total: targets.length });
        }
      } finally { if (active.current) setBulk(null); }
      // Failed posts stay selected so they can be retried; skipped (blocked) posts were never sent.
      setSelected(previous => previous.filter(id => !succeeded.includes(id))); setRestrictions(previous => Object.fromEntries(Object.entries(previous).filter(([id]) => !succeeded.includes(id)))); setNotes(previous => ({ ...previous, ...Object.fromEntries(succeeded.map(id => [id, ''])) }));
      if (decision === 'rejected' && !failed.length) setBulkNote('');
      setBulkResult({ decision, ok: succeeded.length, skipped: chosen.length - targets.length, failed });
      await onChanged?.(); await load();
    });
  }
  // Arrow keys on the open review move to the next or previous entry and keep focus on its card.
  function focusCard(index: number) {
    const target = visible[Math.max(0, Math.min(visible.length - 1, index))]; if (!target) return;
    if (target.key === open?.key) { document.getElementById('review-' + target.key)?.focus(); return; }
    focusNext.current = 'review-' + target.key; setOpenId(target.key);
  }
  useEffect(() => { const id = focusNext.current; if (!id) return; focusNext.current = ''; document.getElementById(id)?.focus(); }, [openId]);
  // After a keyboard review settles, move on: a decided review that leaves the view hands its place to the next one;
  // in "All" it stays, so the next entry opens.
  useEffect(() => { const acted = advance.current; if (!acted) return; advance.current = null; const entry = visible.find(row => row.key === acted.id); if (entry?.status === 'pending') return; focusCard(entry ? acted.index + 1 : acted.index); }, [data]);
  function onCardKey(event: KeyboardEvent<HTMLElement>, item: any, index: number) {
    const action = reviewKeyAction(event, canReview && item.status === 'pending' && !busy, approveBlocked(item)); if (!action) return;
    event.preventDefault();
    if (action === 'next' || action === 'previous') { focusCard(index + (action === 'next' ? 1 : -1)); return; }
    advance.current = { id: item.post.id, index }; void review(item, action === 'approve' ? 'approved' : 'rejected');
  }
  function onSpendKey(event: KeyboardEvent<HTMLElement>, index: number) {
    const move = reviewKeyAction(event, false, true); if (!move) return;
    event.preventDefault(); focusCard(index + (move === 'next' ? 1 : -1));
  }
  const setNote = (key: string, value: string) => { setNotes(previous => ({ ...previous, [key]: value })); setNoteError(''); };
  return <Stack gap={4}>
    <Stack gap={2}>
      <Inline justify="between" align="center" gap={3}>
        {data ? <Text tone="muted" size="sm">Publishing approval is <Text as="strong">{data.requireApproval ? 'required' : 'optional'}</Text> · Ad spend approval is <Text as="strong">{data.requireAdApproval ? 'required' : 'optional'}</Text>. Approving never publishes a post or sends a spend change.</Text> : <Text tone="muted" size="sm">Owners and administrators review the exact text, recipients, schedule, creative and spend.</Text>}
        <Inline gap={2}>{canReview && onOpenSettings && <Button variant="ghost" onClick={onOpenSettings}>Change approval settings</Button>}<Button variant="secondary" disabled={Boolean(busy)} onClick={() => action('refresh', async () => { await Promise.all([load(), loadSpend()]); })}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh'}</Button></Inline>
      </Inline>
      {data?.requireApproval && !canReview && <Text tone="muted" size="sm">While approval is required, an owner or administrator must make changes to posts already submitted to a provider. Editors can still cancel or remove copies using the publishing controls.</Text>}
    </Stack>
    {error && <Alert tone="danger">{error}</Alert>}{notice && <StatusLine>{notice}</StatusLine>}
    <SegmentedControl label="Review view" value={filter} onValueChange={switchView} options={views.map(value => ({ value, label: counts[value] ? `${viewLabels[value]} · ${counts[value]}` : viewLabels[value] }))}/>
    {(platformChoices.length > 1 || platform || filter !== 'waiting') && <FeatureControls>
      {(platformChoices.length > 1 || platform) && <Field label="Platform"><Select value={platform} onChange={event => { setPlatform(event.target.value); shown.current = 0; }}><Option value="">All platforms</Option>{platformChoices.map(value => <Option key={value} value={value}>{PLATFORM_RULES[value]?.label || value}</Option>)}</Select></Field>}
      {filter !== 'waiting' && <Field label="Sort"><Select value={sort} onChange={event => setSort(event.target.value)}><Option value="requested">Newest request first</Option><Option value="planned">Planned time, soonest first</Option></Select></Field>}
    </FeatureControls>}
    {canReview && (actionable.length > 1 || chosen.length > 0) && <Stack as="section" gap={3} aria-label="Bulk review">
      <Checkbox label={`Select all ${actionable.length} posts awaiting review in this view`} disabled={Boolean(busy)} checked={chosen.length === actionable.length} onChange={event => setSelected(event.target.checked ? actionable.map((item: any) => item.post.id) : [])}/>
      {chosen.length > 0 && <><StatusLine>{chosen.length} post{chosen.length === 1 ? '' : 's'} selected.{blockedChosen ? ` Approve will skip ${blockedChosen} whose approval is blocked by an unverified queue or a creative not yet approved.` : ''}</StatusLine>
        <Field label="Comment for the authors" description="Sent when you request changes, to each selected post without its own comment."><Textarea rows={2} maxLength={2000} value={bulkNote} onChange={event => setBulkNote(event.target.value)}/></Field>
        <Inline gap={2}><Button disabled={Boolean(busy) || chosen.length === blockedChosen} onClick={() => bulkReview('approved')}>Approve {chosen.length - blockedChosen}</Button><Button variant="secondary" disabled={Boolean(busy) || uncommented} onClick={() => bulkReview('rejected')}>Request changes on {chosen.length}</Button><Button variant="ghost" disabled={Boolean(busy)} onClick={() => setSelected([])}>Clear selection</Button></Inline>
        <Text tone="muted" size="sm">Each post is reviewed separately, in order. Approving never publishes.</Text></>}
      {bulk && <Progress value={bulk.total ? bulk.done / bulk.total * 100 : 0} label={`Reviewed ${bulk.done} of ${bulk.total}`}/>}
    </Stack>}
    {bulkResult && <Alert tone={bulkResult.failed.length ? 'danger' : 'success'} title={`${bulkResult.decision === 'approved' ? 'Approved' : 'Requested changes on'} ${bulkResult.ok} post${bulkResult.ok === 1 ? '' : 's'}${bulkResult.failed.length ? `; ${bulkResult.failed.length} failed` : ''}${bulkResult.skipped ? `; ${bulkResult.skipped} skipped` : ''}`} onDismiss={() => setBulkResult(null)}>{bulkResult.failed.length > 0 ? <Stack gap={1}><Text>These posts were not reviewed and stay selected:</Text><List>{bulkResult.failed.map(row => <ListItem key={row.id}>{row.name} ({row.id}): {row.message}</ListItem>)}</List></Stack> : <Text>{bulkResult.decision === 'approved' ? 'Publishing remains a separate action.' : 'The authors can update these drafts and request another review.'}</Text>}</Alert>}
    {!data && !error && <StatusLine busy>Loading the review queue…</StatusLine>}
    {data && !visible.length && (filter === 'waiting' ? <EmptyState title="Nothing waiting for you" description="Reviews you can decide, and your posts returned with changes, appear here." action={<Button variant="secondary" onClick={() => switchView('all')}>Show all reviews</Button>}/> : <EmptyState title="Nothing in this view" description={canRequest ? 'Create a post in Publishing, then request review here.' : 'Reviews appear here once they are requested.'}/>)}
    {data && visible.length > 0 && <DetailWorkspace label="Review queue" headingLevel={2} listLabel={viewLabels[filter]} detailLabel={open?.kind === 'spend' ? 'Spend change' : 'Post'} selected={Boolean(open)} backLabel="Back to the queue" onBack={() => setOpenId('#list')} emptyMessage="Choose a review from the list."
      list={<SelectableList label={`${viewLabels[filter]} reviews`} selectedId={open?.key ?? null} onSelect={setOpenId} items={visible.map(queueRow)}/>}
      detail={open && (open.kind === 'spend' ? <SpendReview review={open.review} canReview={canReview} busy={Boolean(busy)} note={notes[open.key] || ''} noteError={noteError === open.key} onNote={value => setNote(open.key, value)} onDecide={decision => decideSpend(open.review, decision)} onKeyDown={event => onSpendKey(event, openIndex)}/> : (item => { const post = item.post, reviewData = item.review, edit = item.publishedEdit, proposed = item.proposedUpdate, creative = link(item.asset?.deliveryUrl || item.asset?.url), submitted = item.status === 'submitted' || Boolean(edit || proposed); return <Card as="article" key={post.id} id={'review-' + post.id} tabIndex={0} aria-keyshortcuts={canReview && item.status === 'pending' ? 'A R' : undefined} onKeyDown={event => onCardKey(event, item, openIndex)} headingLevel={4} title={edit ? 'Change to a published post' : proposed ? 'Proposed update to a submitted post' : post.platforms?.length ? platformNames(post.platforms) : 'Social post draft'} description={`${post.queueId && !submitted ? 'Provider queue · next free slot assigned on submission' : post.scheduledAt ? `Planned for ${when(post.scheduledAt)}` : 'No planned publishing time'}${post.accounts?.length ? ` · ${post.accounts.length} selected account${post.accounts.length === 1 ? '' : 's'}` : ''}`} actions={<Inline gap={2} align="center">{canReview && item.status === 'pending' && <Checkbox label="Select" aria-label={`Select ${postName(item)} for bulk review`} disabled={Boolean(busy)} checked={selected.includes(post.id)} onChange={event => setSelected(previous => event.target.checked ? [...previous.filter(id => id !== post.id), post.id] : previous.filter(id => id !== post.id))}/>}<Badge tone={statusTone(item.status)} dot>{statusLabel(item)}</Badge></Inline>}><Stack gap={3}>
        {edit && <PublishedEditComparison post={post} edit={edit}/>}
        {proposed && <ProposedUpdateComparison item={item}/>}
        {item.status === 'stale' && <ReviewedChanges item={item}/>}
        {!!post.accounts?.length && <Text tone="muted" size="sm"><Text as="strong">Selected account IDs:</Text> {post.accounts.join(', ')}</Text>}
        {post.queueId && !submitted && <Stack gap={1}><Text as="strong">{item.queue?.name || 'Publishing queue unavailable'}</Text>{item.queue?.timezone && <Text tone="muted" size="sm">{item.queue.timezone} · {(item.queue.slots || []).map((slot: any) => `${days[slot.dayOfWeek]} ${slot.time}`).join(', ') || 'No weekly slots'}</Text>}<Text tone="muted" size="sm">{item.queue?.ready ? 'These queue settings match the saved post. Zernio reserves the next free slot only when it is submitted.' : item.queue?.message || 'Refresh to verify this queue before approving the post.'}</Text>{!item.queue?.ready && <Text tone="muted" size="sm">Edit the saved post, load its current queue settings and save them before requesting a new review.</Text>}</Stack>}
        <Stack gap={0}>{lines(post.content)}</Stack>
        {Array.isArray(post.tags) && post.tags.length > 0 && <Text tone="muted" size="sm"><Text as="strong">YouTube keywords (all YouTube accounts):</Text> {post.tags.join(', ')}</Text>}
        {Object.entries(post.platformOverrides || {}).map(([platform, variant]: [string, any]) => <Stack as="section" gap={2} key={platform}><Heading level={5}>{PLATFORM_RULES[platform]?.label || platform}</Heading><PostVariantPreview platform={platform} variant={variant} scheduled={!!post.scheduledAt}/>{Object.keys(variant.options || {}).length > 0 && <Disclosure summary="Publishing options"><DescriptionList items={options(platform, variant.options)}/></Disclosure>}</Stack>)}
        {Object.entries(post.accountOverrides || {}).map(([id, variant]: [string, any]) => <Stack as="section" gap={2} key={id}><Heading level={5}>{PLATFORM_RULES[variant.platform]?.label || variant.platform} · Account {id}</Heading><PostVariantPreview platform={variant.platform} accountName={id} variant={variant} scheduled={!!post.scheduledAt}/><Text tone="muted" size="sm">Account schedule: {variant.scheduledAt ? when(variant.scheduledAt) : post.queueId ? 'Next free queue slot' : post.scheduledAt ? when(post.scheduledAt) + ' · Inherited post time' : 'No fixed time'}</Text><Disclosure summary="Account publishing options">{Object.keys(variant.options || {}).length ? <DescriptionList items={options(variant.platform, variant.options)}/> : <Text>Provider defaults</Text>}</Disclosure></Stack>)}
        {post.providerVariants?.map((target: any, index: number) => <Stack as="section" gap={2} key={index}><Heading level={5}>{PLATFORM_RULES[target.platform]?.label || target.platform} · {target.accountId}</Heading><PostVariantPreview platform={target.platform} accountName={target.accountId} variant={{content:target.customContent ?? post.content,mediaItems:target.customMedia ?? post.mediaItems ?? [],options:target.platformSpecificData}}/>{target.scheduledFor && <Text tone="muted" size="sm">Account schedule: {when(target.scheduledFor)}</Text>}{Object.keys(target.platformSpecificData || {}).length > 0 && <Disclosure summary="Account publishing options"><DescriptionList items={options(target.platform, target.platformSpecificData)}/></Disclosure>}<Text tone="muted" size="sm">This account has its own provider settings. They are included in this review.</Text></Stack>)}
        {post.providerFailed && <Text tone="muted" size="sm">Review the latest text and creative before retrying failed copies from Publishing. Published copies are skipped. Refresh the provider status after making any changes in Zernio.</Text>}
        {item.asset && <Text tone="muted" size="sm">Referenced creative: {creativeState(item.asset)}{creative && <> · <Link href={creative} target="_blank" rel="noopener noreferrer">Open creative</Link></>}</Text>}
        {(item.assets || []).filter((asset: any) => asset.id !== item.asset?.id).map((asset: any) => <Text tone="muted" size="sm" key={asset.id}>Platform creative: {creativeState(asset)}{link(asset.deliveryUrl || asset.url) && <> · <Link href={link(asset.deliveryUrl || asset.url)} target="_blank" rel="noopener noreferrer">Open creative</Link></>}</Text>)}
        {!!post.mediaItems?.length && <Inline>{post.mediaItems.map((media: any, index: number) => { const url = link(media.url); return url && <Link key={index} variant="standalone" href={url} target="_blank" rel="noopener noreferrer">View {media.type || 'media'} {index + 1}</Link>; })}</Inline>}
        {reviewData && <Stack gap={1}><Text tone="muted" size="sm">Requested by {reviewData.requestedBy?.name || 'Team member'} · {when(reviewData.requestedAt)}{reviewData.reviewedAt && <> · {label(reviewData.status)} by {reviewData.reviewedBy?.name || 'Administrator'} · {when(reviewData.reviewedAt)}</>}</Text>{reviewData.note && <Stack gap={0}>{lines(reviewData.note)}</Stack>}</Stack>}
        {!submitted && canRequest && !['pending', 'approved'].includes(item.status) && <Inline><Button variant="secondary" disabled={Boolean(busy) || Boolean(post.queueId && !item.queue?.ready)} onClick={() => action(post.id, async () => { const result = await request(`${path}/posts/${encodeURIComponent(post.id)}/request`, 'POST', {}); if (!active.current) return; acceptItem(result.item); setNotice('Review requested. An owner or administrator can approve or request changes.'); await onChanged?.(); await load(); })}>{busy === post.id ? 'Saving…' : 'Request review'}</Button></Inline>}
        {restrictions[post.id] && <ValidationSummary title="Publishing restrictions blocked this approval" items={restrictionTargets(restrictions[post.id])}/>}
        {canReview && item.status === 'pending' && <Stack as="fieldset" gap={3} disabled={Boolean(busy)}><Field label="Comment" description="Required when you request changes." htmlFor={'review-note-' + post.id} error={noteError === post.id ? missingNote : undefined}><Textarea id={'review-note-' + post.id} rows={2} maxLength={2000} value={notes[post.id] || ''} onChange={event => setNote(post.id, event.target.value)}/></Field><FormActions><Button disabled={approveBlocked(item)} onClick={() => review(item, 'approved')}>Approve post</Button><Button variant="secondary" onClick={() => review(item, 'rejected')}>Request changes</Button></FormActions><Text tone="muted" size="sm">Keys: A approves, R requests changes, ↑ and ↓ move between reviews.</Text></Stack>}
      </Stack></Card>; })(open.item))}/>}
  </Stack>;
}
