import { useEffect, useState, type ReactNode } from 'react';
import { postDisplayStatus } from '../shared/post-schedule.ts';
import { Button, Card, DataTable, EmptyState, Heading, Icon, Inline, MetricCard, MetricGrid, Popover, SegmentedControl, Stack, Tabs, Text } from '@ten98/ui';

type Row = { id: string; [key: string]: any };
export type CampaignItemKind = 'post' | 'placement' | 'activation';
// What "Add" can create. Kinds without an editor preset open the page where that work happens.
export type CampaignAddKind = CampaignItemKind | 'message' | 'ad' | 'link';
type Item = { kind: CampaignItemKind; row: Row; title: string; status: string; when: string };
type Props = {
  campaign: Row; posts: Row[]; placements: Row[]; activations: Row[]; canWrite: boolean;
  money: (value: unknown, currency?: string) => string; date: (value: string) => string; statusBadge: (status: string) => ReactNode; postTitle: (post: Row) => string;
  onBack: () => void; onEdit: () => void; onAdd: (kind: CampaignAddKind) => void; onOpen: (kind: CampaignItemKind, row: Row) => void;
  // Reads this campaign's link and field results for the Results tab (reads only; nothing is sent to a network).
  projectId?: string; request?: (path: string) => Promise<any>;
};
export type CampaignResult = { label: string; value: number | null; failed?: boolean; hint: string };
// 'failed' marks a read that was refused or errored, so the tab can say so instead of looking like no data.
type Loaded = { links?: { totals?: Row } | null | 'failed'; activations?: Record<string, Row> | null | 'failed' };

// What this campaign has produced, from records that name it. null means "not reported", never 0.
export function campaignResults(campaign: Row, posts: Row[], placements: Row[], activations: Row[], loaded: Loaded): CampaignResult[] {
  const mine = (rows: Row[]) => rows.filter(row => row.campaignId === campaign.id), field = mine(activations);
  const links = loaded.links === 'failed' ? undefined : loaded.links, results = loaded.activations === 'failed' ? undefined : loaded.activations;
  const linksFailed = loaded.links === 'failed', resultsFailed = loaded.activations === 'failed';
  const sum = (rows: Row[], key: string) => rows.reduce((total, row) => total + (Number.isFinite(Number(row[key])) ? Number(row[key]) : 0), 0);
  const counted = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : null;
  return [
    { label: 'Link clicks', value: counted(links?.totals?.clicks), failed: linksFailed, hint: 'Short links in this campaign' },
    { label: 'QR scans', value: counted(links?.totals?.qrScans), failed: linksFailed, hint: 'QR codes in this campaign' },
    { label: 'Leads captured', value: results && field.length ? field.reduce((total, activation) => total + (Number(results[activation.id]?.leads) || 0), 0) : null, failed: resultsFailed && field.length > 0, hint: 'At field activity' },
    { label: 'People reached', value: field.length ? sum(field, 'reached') : null, hint: 'Reported by field teams' },
    { label: 'Posts published', value: mine(posts).filter(post => post.status === 'published').length, hint: 'Across social accounts' },
    { label: 'Billboards booked', value: mine(placements).filter(placement => ['booked', 'live', 'completed'].includes(placement.status)).length, hint: 'Booked, live or finished' },
    { label: 'Impressions', value: counted(campaign.impressions), hint: 'Entered for this campaign' },
    { label: 'Conversions', value: counted(campaign.conversions), hint: 'Entered for this campaign' },
  ];
}

const kindLabel: Record<CampaignItemKind, string> = { post: 'Post', placement: 'Billboard', activation: 'Field activity' };
const filters = [['all', 'All'], ['post', 'Posts'], ['placement', 'Billboards'], ['activation', 'Field activity']];
const addChoices: [CampaignAddKind, string][] = [['post', 'Post'], ['placement', 'Billboard booking'], ['activation', 'Field activity'], ['message', 'Email or SMS'], ['ad', 'Ad'], ['link', 'Link or QR code']];

// Every record that names this campaign, newest plan first. Dates are the moment each item goes out or starts.
export function campaignItems(campaignId: string, posts: Row[], placements: Row[], activations: Row[], postTitle: (post: Row) => string): Item[] {
  return [
    ...posts.filter(post => post.campaignId === campaignId).map(row => ({ kind: 'post' as const, row, title: postTitle(row), status: postDisplayStatus(row), when: row.publishedAt || row.scheduledAt || '' })),
    ...placements.filter(placement => placement.campaignId === campaignId).map(row => ({ kind: 'placement' as const, row, title: row.name || 'Billboard booking', status: row.status || 'draft', when: row.startDate || '' })),
    ...activations.filter(activation => activation.campaignId === campaignId).map(row => ({ kind: 'activation' as const, row, title: row.name || 'Field activity', status: row.status || 'draft', when: row.startAt || '' })),
  ].sort((a, b) => (b.when || '').localeCompare(a.when || ''));
}

export default function CampaignDetail({ campaign, posts, placements, activations, canWrite, money, date, statusBadge, postTitle, onBack, onEdit, onAdd, onOpen, projectId, request }: Props) {
  const [tab, setTab] = useState('overview'), [filter, setFilter] = useState('all'), [adding, setAdding] = useState(false), [loaded, setLoaded] = useState<Loaded | null>(null);
  // Results load when the tab opens, over the campaign so far (up to a year).
  useEffect(() => {
    if (tab !== 'results' || loaded || !request || !projectId) return;
    let active = true; const project = encodeURIComponent(projectId), started = Date.parse(campaign.startDate || '');
    const days = Math.min(365, Math.max(1, Number.isFinite(started) ? Math.floor((Date.now() - started) / 86400000) + 1 : 30));
    Promise.all([request(`/projects/${project}/links/analytics?days=${days}&campaignId=${encodeURIComponent(campaign.id)}`).catch(() => 'failed' as const), request(`/projects/${project}/activations/results`).then(value => value?.results || null, () => 'failed' as const)])
      .then(([links, results]) => { if (active) setLoaded({ links, activations: results }); });
    return () => { active = false; };
  }, [tab, loaded, request, projectId, campaign.id, campaign.startDate]);
  const results = campaignResults(campaign, posts, placements, activations, loaded || {});
  const items = campaignItems(campaign.id, posts, placements, activations, postTitle), now = Date.now();
  const upNext = items.filter(item => item.when && Date.parse(item.when) > now).sort((a, b) => a.when.localeCompare(b.when)).slice(0, 5);
  // The same dialog opens read-only for viewers and for campaigns an ad network manages, so it is labelled for what it does.
  const editable = canWrite && !campaign.externalId && !campaign.nativeProvider;
  const currency = campaign.currency || 'AED', budget = Number(campaign.budget), spent = Number(campaign.spent);
  const remaining = Number.isFinite(budget) && Number.isFinite(spent) ? budget - spent : NaN;
  const add = canWrite ? <Popover label="Add to this campaign" triggerLabel="Add" triggerIcon="plus" triggerVariant="primary" placement="bottom-end" open={adding} onOpenChange={setAdding}>
    <Stack gap={1}>{addChoices.map(([kind, label]) => <Button key={kind} variant="ghost" onClick={() => { setAdding(false); onAdd(kind); }}>{label}</Button>)}</Stack>
  </Popover> : undefined;
  const table = (rows: Item[], label: string) => <DataTable ariaLabel={label} searchable={false} sortable={false} pagination={false} rows={rows} rowKey={item => item.kind + ':' + item.row.id} columns={[
    { key: 'title', header: 'Item', rowHeader: true, wrap: true, render: item => <Stack gap={0}><Text weight="semibold">{item.title}</Text><Text as="small" size="sm" tone="muted">{kindLabel[item.kind]}</Text></Stack> },
    { key: 'status', header: 'Status', render: item => statusBadge(item.status) },
    { key: 'when', header: 'When', render: item => item.when ? date(item.when) : 'Not scheduled' },
  ]} rowActionsLabel="Actions" rowActions={item => <Button variant="ghost" size="sm" aria-label={'Open ' + item.title} onClick={() => onOpen(item.kind, item.row)}>Open</Button>}
    emptyState={<EmptyState title="Nothing here yet" description="Add a post, billboard booking or field activity to plan it in this campaign." action={canWrite ? <Button variant="secondary" onClick={() => onAdd('post')}>Add a post</Button> : undefined}/>}/>;
  const shown = filter === 'all' ? items : items.filter(item => item.kind === filter);
  return <Stack gap={6}>
    <Inline><Button variant="ghost" icon={<Icon name="chevron-left" size={15}/>} onClick={onBack}>All campaigns</Button></Inline>
    <Inline justify="between" align="start" gap={3}>
      <Stack gap={1}><Inline gap={2} align="center"><Heading level={2}>{campaign.name}</Heading>{statusBadge(campaign.status)}</Inline><Text tone="muted">{date(campaign.startDate)} – {date(campaign.endDate)}</Text></Stack>
      <Inline gap={2}><Button variant="secondary" onClick={onEdit}>{editable ? 'Edit' : 'View details'}</Button>{add}</Inline>
    </Inline>
    <MetricGrid list label="Budget">
      <MetricCard label="Budget" value={money(campaign.budget, currency)}/>
      <MetricCard label="Spent" value={money(campaign.spent, currency)}/>
      <MetricCard label="Remaining" value={money(remaining, currency)}/>
    </MetricGrid>
    <Tabs label="Campaign sections" value={tab} onValueChange={setTab} items={[
      { value: 'overview', label: 'Overview', content: <Card as="section" headingLevel={3} title="Up next">{upNext.length ? table(upNext, 'Up next in ' + campaign.name) : <Text tone="muted">Nothing scheduled yet. {items.length ? 'Schedule an item to see it here.' : 'Add a post, booking or field activity to start.'}</Text>}</Card> },
      { value: 'results', label: 'Results', content: <Stack gap={3}>{loaded ? null : <Text tone="muted">Loading results…</Text>}<MetricGrid list label={'Results for ' + campaign.name}>{results.map(result => <MetricCard key={result.label} label={result.label} hint={result.hint} {...(result.value === null ? { unavailable: result.failed ? 'Couldn’t load' : 'Not reported yet' } : { value: result.value.toLocaleString() })}/>)}</MetricGrid>{canWrite && <Inline><Button variant="ghost" onClick={onEdit}>Update entered totals</Button></Inline>}</Stack> },
      { value: 'items', label: `Items · ${items.length}`, content: <Stack gap={3}><SegmentedControl label="Item type" value={filter} onValueChange={setFilter} options={filters.map(([value, label]) => ({ value, label }))}/>{table(shown, 'Items in ' + campaign.name)}</Stack> },
    ]}/>
  </Stack>;
}
