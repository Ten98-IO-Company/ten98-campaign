import type { KeyboardEvent, ReactNode } from 'react';
import { PLATFORM_RULES } from '../shared/social-posts.ts';
import { type AppliedFilter, AppliedFilters, Badge, badgePalettes, Button, CalendarMonth, type CalendarEntry, Card, Field, Heading, Icon, Inline, Input, PublishingAgenda, type PublishingAgendaEntry, SegmentedControl, Select, Stack, Switch, Text, type Tone } from '@ten98/ui';

type Row = { id: string; [key: string]: any };
type ScheduledPost = { id: string; post: Row; accountId?: string; platform?: string; content: string; scheduledAt: string };
type CalendarView = 'week' | 'month' | 'list';
/** One choice per filter; an absent key shows everything. */
type CalendarFilters = { channel?: string; status?: string; campaign?: string; googleHidden?: boolean };
type DayEntry = CalendarEntry & { network?: string; snippet?: string; status?: string; tone?: Tone; campaign?: Row; event?: Row };
type Props = {
  posts: ScheduledPost[];
  /** All post records. A published post without a schedule entry in `posts` is placed on its `publishedAt`. */
  records?: Row[];
  /** The app has already removed verified Google copies of these posts. */
  googleEvents: Row[];
  month: Date;
  accounts?: Row[];
  /** Campaign names and colours for entries and the campaign filter. */
  campaigns?: Row[];
  canWrite: boolean;
  postLabel: (post: Row) => string;
  onSelect: (post: Row) => void;
  onCreateDay?: (day: string) => void;
  /** Actions for a loaded Google event, such as Open in Google, Edit and Delete. */
  googleEventActions?(event: Row): ReactNode;
  /** Agenda header actions, such as month navigation. */
  actions?: ReactNode;
  /** Week, month grid or list; the app keeps the choice across months. */
  view?: CalendarView;
  /** Week is offered only with onWeekChange; an app that handles weeks also accepts 'week' here. */
  onViewChange?: ((view: CalendarView) => void) | ((view: 'month' | 'list') => void);
  /** Moves the shown month; the grid's own previous, next and today controls use it. */
  onMonthChange?: (month: Date) => void;
  /** Monday of the shown week, YYYY-MM-DD. Defaults to this week in the current month, else the month's first week. */
  weekStart?: string;
  /** Moves the shown week. A week whose Thursday falls in another month also moves the month, so the Google overlay loads for it. */
  onWeekChange?(weekStart: string): void;
  /** Applied filters; the filter row shows only with a change handler. */
  filters?: CalendarFilters;
  onFiltersChange?(filters: CalendarFilters): void;
  /** Approval status text by post id, supplied only when the project requires approval before publishing. */
  postApprovals?: Record<string, string>;
};
const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const dayDate = (day: string) => new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
const addDays = (date: Date, count: number) => new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
const mondayOf = (date: Date) => addDays(date, -((date.getDay() + 6) % 7));
const capital = (value: string) => value[0].toUpperCase() + value.slice(1);
const networkName = (platform?: string) => platform ? PLATFORM_RULES[platform]?.label || platform : '';
// Failure outranks delivery, delivery outranks a missing approval; drafts and cancellations stay neutral.
function statusTone(status: string | undefined, approval: string | undefined): Tone {
  if (status === 'failed' || status === 'partial') return 'danger';
  if (status === 'published') return 'success';
  if (!status || status === 'draft' || status === 'cancelled') return 'neutral';
  return approval && approval !== 'Approved' ? 'warning' : 'info';
}
// The same campaign keeps the same decorative colour across views and reloads.
const campaignPalette = (id: string) => badgePalettes[[...id].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0, 0) % badgePalettes.length];

export default function CampaignPublishingAgenda({ posts: scheduled, records = [], googleEvents, month, accounts = [], campaigns = [], canWrite, postLabel, onSelect, onCreateDay, googleEventActions, actions, view = 'list', onViewChange, onMonthChange, weekStart, onWeekChange, filters = {}, onFiltersChange, postApprovals }: Props) {
  // Posts published immediately (and the sample post) have no planned time, so schedules skip them.
  const placed = new Set(scheduled.map(entry => entry.post.id));
  const posts: ScheduledPost[] = [...scheduled, ...records.filter(post => !placed.has(post.id) && Number.isFinite(Date.parse(post.publishedAt))).map(post => ({ id: post.id, post, platform: post.platforms?.[0] || '', content: post.content || '', scheduledAt: post.publishedAt }))];
  const monthStart = new Date(month.getFullYear(), month.getMonth(), 1), monthEnd = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  // Days before today offer no creation: a post cannot be planned in the past.
  const now = new Date(), today = localDate(now);
  const week = weekStart && /^\d{4}-\d{2}-\d{2}$/.test(weekStart) ? dayDate(weekStart) : mondayOf(monthStart <= now && now < monthEnd ? now : monthStart);
  // Entries, counts and filters cover the shown range: the week in week view, otherwise the month.
  const start = view === 'week' ? week : monthStart, end = view === 'week' ? addDays(week, 7) : monthEnd;
  const format = new Intl.DateTimeFormat('en', { timeZone: timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  const approvalLabel = (post: Row) => postApprovals ? postApprovals[post.id] || 'Approval not requested' : undefined;
  const statusText = (post: Row) => (post.status ? capital(post.status) : 'Status unavailable') + (postApprovals ? ' · ' + approvalLabel(post) : '');
  const campaignOf = (post: Row) => post.campaignId ? campaigns.find(campaign => String(campaign.id) === String(post.campaignId)) : undefined;
  const statusBadge = (post: Row) => <Badge tone={statusTone(post.status, approvalLabel(post))} dot>{statusText(post)}</Badge>;
  const timeOnly = new Intl.DateTimeFormat('en', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
  // Grid and week days, keyed by the browser-local date that the agenda's times also use.
  const days = new Map<string, DayEntry[]>(), addDay = (day: string, entry: DayEntry) => days.set(day, [...(days.get(day) || []), entry]);
  const rangePosts = posts.filter(entry => new Date(entry.scheduledAt) >= start && new Date(entry.scheduledAt) < end);
  const visible = (entry: ScheduledPost) => (!filters.channel || entry.platform === filters.channel) && (!filters.status || entry.post.status === filters.status) && (!filters.campaign || String(entry.post.campaignId || '') === filters.campaign);
  const shownPosts = rangePosts.filter(visible);
  // Month stats ported from zernio-dev/latewiz@28dd018 src/app/dashboard/calendar/page.tsx:88-105 (MIT), counting posts rather than account copies.
  const countPosts = (status: string) => new Set(rangePosts.filter(entry => entry.post.status === status).map(entry => entry.post.id)).size;
  const entries: (PublishingAgendaEntry & { order: number })[] = shownPosts.map(entry => ({
    id: `post:${entry.id}`, title: entry.content || (entry.accountId ? 'Selected account post' : postLabel(entry.post)),
    dateTime: entry.scheduledAt, when: format.format(new Date(entry.scheduledAt)), order: Date.parse(entry.scheduledAt),
    status: statusBadge(entry.post),
    details: [networkName(entry.platform), entry.accountId && (accounts.find(account => String(account._id || account.id) === entry.accountId)?.displayName || entry.accountId), campaignOf(entry.post)?.name].filter(Boolean).join(' · '),
    actions: <Button variant="secondary" size="sm" onClick={() => onSelect(entry.post)}>{canWrite ? 'Open post' : 'View post'}</Button>,
  }));
  for (const entry of shownPosts) {
    const snippet = entry.content || (entry.accountId ? 'Selected account post' : postLabel(entry.post)), network = networkName(entry.platform), status = statusText(entry.post);
    addDay(localDate(new Date(entry.scheduledAt)), { id: `post:${entry.id}`, label: [network, snippet, status].filter(Boolean).join(' · '), time: timeOnly.format(new Date(entry.scheduledAt)), onSelect: () => onSelect(entry.post), network, snippet, status, tone: statusTone(entry.post.status, approvalLabel(entry.post)), campaign: campaignOf(entry.post) });
  }
  let googleCount = 0, googleHidden = 0;
  for (const event of googleEvents) {
    const allDay = Boolean(event.start?.date), dateTime = event.start?.date || event.start?.dateTime;
    const date = new Date(allDay ? dateTime + 'T00:00' : dateTime);
    if (!Number.isFinite(date.getTime()) || !(allDay ? event.start.date < localDate(end) && event.end?.date > localDate(start) : date < end && (Date.parse(event.end?.dateTime) || date.getTime()) > start.getTime())) continue;
    googleCount++;
    // The Google overlay toggle hides events without changing what was loaded.
    if (filters.googleHidden) { googleHidden++; continue; }
    entries.push({ id: `google:${event.id}`, title: `Google · ${event.summary}`, dateTime, order: date.getTime(),
      when: allDay ? `${event.start.date} – ${event.end.date}` : format.format(date),
      status: allDay ? 'All day · End date exclusive' : 'Google Calendar event', actions: googleEventActions?.(event),
    });
    // Google entries stay plain text in the grid: their actions live in the list and week views.
    // A timed event that began before the range still shows on its first day.
    if (!allDay) addDay(localDate(date < start ? start : date), { id: `google:${event.id}`, label: `Google · ${event.summary}`, time: timeOnly.format(date), event });
    else for (let day = new Date(Math.max(date.getTime(), start.getTime())); localDate(day) < event.end.date && day < end; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) addDay(localDate(day), { id: `google:${event.id}:${localDate(day)}`, label: `Google · ${event.summary}`, time: 'All day', event });
  }
  entries.sort((left, right) => left.order - right.order);
  const hidden = rangePosts.length - shownPosts.length + googleHidden;

  const creatable = (day: string) => canWrite && Boolean(onCreateDay) && day >= today;
  // Enter or N on a focused day (never on an entry inside it) opens the composer for that day.
  function createKey(day: string | undefined, event: KeyboardEvent<HTMLElement>) {
    if (!day || event.altKey || event.ctrlKey || event.metaKey || !(event.key === 'Enter' || event.key.toLowerCase() === 'n') || !creatable(day)) return;
    event.preventDefault(); onCreateDay!(day);
  }
  function moveWeek(target: Date) {
    onWeekChange?.(localDate(target));
    const thursday = addDays(target, 3);
    if (onMonthChange && (thursday.getFullYear() !== month.getFullYear() || thursday.getMonth() !== month.getMonth())) onMonthChange(new Date(thursday.getFullYear(), thursday.getMonth(), 1));
  }

  const setFilters = (patch: CalendarFilters) => onFiltersChange?.(Object.fromEntries(Object.entries({ ...filters, ...patch }).filter(([, value]) => value)));
  const applied = [
    filters.channel && { id: 'channel', label: 'Channel', value: networkName(filters.channel) },
    filters.status && { id: 'status', label: 'Status', value: capital(filters.status) },
    filters.campaign && { id: 'campaign', label: 'Campaign', value: campaigns.find(campaign => String(campaign.id) === filters.campaign)?.name || filters.campaign },
    filters.googleHidden && { id: 'googleHidden', label: 'Google Calendar', value: 'Hidden' },
  ].filter(Boolean) as AppliedFilter[];
  const options = (values: (string | undefined)[], label: (value: string) => string) => [...new Set(values.filter((value): value is string => Boolean(value)))].map(value => ({ value, label: label(value) })).sort((left, right) => left.label.localeCompare(right.label));
  const filterRow = onFiltersChange && <Stack gap={2}>
    <Inline gap={3} align="end">
      <Field label="Channel"><Select width="auto" value={filters.channel || ''} onChange={event => setFilters({ channel: event.target.value })} options={[{ value: '', label: 'All channels' }, ...options(posts.map(entry => entry.platform), networkName)]}/></Field>
      <Field label="Status"><Select width="auto" value={filters.status || ''} onChange={event => setFilters({ status: event.target.value })} options={[{ value: '', label: 'All statuses' }, ...options(posts.map(entry => entry.post.status), capital)]}/></Field>
      {campaigns.length > 0 && <Field label="Campaign"><Select width="auto" value={filters.campaign || ''} onChange={event => setFilters({ campaign: event.target.value })} options={[{ value: '', label: 'All campaigns' }, ...campaigns.map(campaign => ({ value: String(campaign.id), label: String(campaign.name || campaign.id) }))]}/></Field>}
      <Switch label="Google Calendar" checked={!filters.googleHidden} onCheckedChange={checked => setFilters({ googleHidden: !checked })}/>
    </Inline>
    {applied.length > 0 && <Inline gap={3} align="center" justify="between">
      <AppliedFilters label="Calendar filters" filters={applied} onRemove={id => setFilters({ [id]: undefined })} onClear={() => onFiltersChange({})}/>
      {hidden > 0 && <Text size="sm" tone="muted">{hidden} hidden by filters</Text>}
    </Inline>}
  </Stack>;

  const fullDate = new Intl.DateTimeFormat('en', { dateStyle: 'full' }), weekday = new Intl.DateTimeFormat('en', { weekday: 'short' }), short = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' });
  const weekDays = Array.from({ length: 7 }, (_, index) => localDate(addDays(week, index))), lastDay = addDays(week, 6);
  const range = week.getFullYear() === lastDay.getFullYear() ? `${short.format(week)} – ${short.format(lastDay)}, ${lastDay.getFullYear()}` : `${short.format(week)}, ${week.getFullYear()} – ${short.format(lastDay)}, ${lastDay.getFullYear()}`;
  const weekEmpty = weekDays.every(day => !days.get(day)?.length);
  // Entry anatomy: time, network, one-line snippet, status dot and campaign colour, all part of the accessible name.
  const weekEntry = (item: DayEntry) => item.event ? <Inline key={item.id} gap={2} align="center">
    <Text as="span" size="sm" tone="muted" numeric>{item.time}</Text><Text as="span" size="sm" truncate>{item.label}</Text><Badge tone="neutral" dot>Google Calendar</Badge>{googleEventActions?.(item.event)}
  </Inline> : <Button key={item.id} variant="ghost" size="sm" onClick={item.onSelect}>
    <Text as="span" size="sm" tone="muted" numeric>{item.time}</Text>
    {item.network && <Text as="span" size="sm" weight="semibold">{item.network}</Text>}
    <Text as="span" size="sm" truncate>{item.snippet}</Text>
    <Badge tone={item.tone} dot>{item.status}</Badge>
    {item.campaign && <Badge palette={campaignPalette(String(item.campaign.id))}>{String(item.campaign.name || item.campaign.id)}</Badge>}
  </Button>;
  const weekView = <Stack gap={3}>
    <Inline justify="between" align="center">
      <Stack gap={1}><Heading level={3} size="sm">{range}</Heading><Text size="sm" tone="muted">{timezone}</Text></Stack>
      {onWeekChange && <Inline gap={2} role="group" aria-label="Week navigation">
        <Button variant="secondary" size="sm" aria-label="Previous week" icon={<Icon name="chevron-left" size={16}/>} onClick={() => moveWeek(addDays(week, -7))}/>
        <Button variant="secondary" size="sm" onClick={() => moveWeek(mondayOf(new Date()))}>Today</Button>
        <Button variant="secondary" size="sm" aria-label="Next week" icon={<Icon name="chevron-right" size={16}/>} onClick={() => moveWeek(addDays(week, 7))}/>
      </Inline>}
    </Inline>
    {weekEmpty && <Text size="sm" tone="muted">No posts this week.</Text>}
    <Stack gap={2}>{weekDays.map(day => {
      const items = days.get(day) || [], date = dayDate(day), name = fullDate.format(date);
      return <Stack key={day} role="group" gap={1} tabIndex={0} aria-label={`${name}${day === today ? ', today' : ''}, ${items.length ? `${items.length} ${items.length === 1 ? 'entry' : 'entries'}` : 'no entries'}`} onKeyDown={event => { if (event.target === event.currentTarget) createKey(day, event); }}>
        <Inline gap={2} align="center"><Text as="span" size="sm" weight="semibold" tone={day < today ? 'muted' : 'default'}>{weekday.format(date)} {date.getDate()}</Text>{day === today && <Badge tone="accent">Today</Badge>}</Inline>
        {items.length > 0 ? <Stack gap={1}>{items.map(weekEntry)}</Stack> : weekEmpty && creatable(day) && <Inline><Button variant="ghost" size="sm" icon={<Icon name="plus" size={14}/>} aria-label={`Add a post on ${name}`} onClick={() => onCreateDay!(day)}>Add a post</Button></Inline>}
      </Stack>;
    })}</Stack>
  </Stack>;

  return <Card><Stack gap={4}>
    <Inline justify="between" align="center">
      <Inline gap={4}><Text size="sm"><Text as="strong">{countPosts('scheduled')}</Text> scheduled</Text><Text size="sm"><Text as="strong">{countPosts('published')}</Text> published</Text><Text size="sm"><Text as="strong">{googleCount}</Text> Google events</Text></Inline>
      {onViewChange && <SegmentedControl label="Calendar view" value={view} onValueChange={value => (onViewChange as (view: string) => void)(value)} options={[...onWeekChange ? [{ value: 'week', label: 'Week' }] : [], { value: 'month', label: 'Month' }, { value: 'list', label: 'List' }]}/>}
    </Inline>
    {filterRow}
    {view === 'week' ? weekView : view === 'month' && onMonthChange ? <Stack gap={2} onKeyDown={event => createKey((event.target as HTMLElement).dataset?.date, event)}>
      {!canWrite && <Text size="sm" tone="muted">Read only: your role cannot create posts.</Text>}
      <CalendarMonth month={{ year: month.getFullYear(), month: month.getMonth() + 1 }} weekStartsOn={1} locale="en" today={today} days={days} onPrev={() => onMonthChange(new Date(month.getFullYear(), month.getMonth() - 1, 1))} onNext={() => onMonthChange(new Date(month.getFullYear(), month.getMonth() + 1, 1))} onToday={() => onMonthChange(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}/>
    </Stack> : <PublishingAgenda label="Publishing agenda" scope={month.toLocaleDateString('en', { month: 'long', year: 'numeric' })} timezoneLabel={timezone} entries={entries} readOnly={!canWrite} emptyMessage="No scheduled posts or loaded Google events this month." actions={actions}/>}
    {canWrite && onCreateDay && <Inline as="form" key={localDate(start)} align="end" onSubmit={event => { event.preventDefault(); const day = String(new FormData(event.currentTarget as HTMLFormElement).get('day') || ''); if (day) onCreateDay(day); }}>
      <Field label="Post date"><Input type="date" name="day" required min={today} defaultValue={localDate(start) < today ? today : localDate(start)}/></Field>
      <Button variant="secondary" type="submit">Create post on date</Button>
      {view !== 'list' && <Text size="sm" tone="muted">Or focus a day and press N.</Text>}
    </Inline>}
  </Stack></Card>;
}
