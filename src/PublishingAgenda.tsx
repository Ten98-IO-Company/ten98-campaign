import type { ReactNode } from 'react';
import { Button, CalendarMonth, type CalendarEntry, Card, Field, Inline, Input, PublishingAgenda, type PublishingAgendaEntry, SegmentedControl, Stack, Text } from '@ten98/ui';

type Row = { id: string; [key: string]: any };
type ScheduledPost = { id: string; post: Row; accountId?: string; platform?: string; content: string; scheduledAt: string };
type Props = {
  posts: ScheduledPost[];
  /** The app has already removed verified Google copies of these posts. */
  googleEvents: Row[];
  month: Date;
  accounts?: Row[];
  canWrite: boolean;
  postLabel: (post: Row) => string;
  onSelect: (post: Row) => void;
  onCreateDay?: (day: string) => void;
  /** Actions for a loaded Google event, such as Open in Google, Edit and Delete. */
  googleEventActions?(event: Row): ReactNode;
  /** Agenda header actions, such as month navigation. */
  actions?: ReactNode;
  /** Month grid or list; the app keeps the choice across months. */
  view?: 'month' | 'list';
  onViewChange?: (view: 'month' | 'list') => void;
  /** Moves the shown month; the grid's own previous, next and today controls use it. */
  onMonthChange?: (month: Date) => void;
};
const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export default function CampaignPublishingAgenda({ posts, googleEvents, month, accounts = [], canWrite, postLabel, onSelect, onCreateDay, googleEventActions, actions, view = 'list', onViewChange, onMonthChange }: Props) {
  const start = new Date(month.getFullYear(), month.getMonth(), 1), end = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const format = new Intl.DateTimeFormat('en', { timeZone: timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  const timeOnly = new Intl.DateTimeFormat('en', { timeZone: timezone, hour: '2-digit', minute: '2-digit' });
  // Month grid days, keyed by the browser-local date that the agenda's times also use.
  const days = new Map<string, CalendarEntry[]>(), addDay = (day: string, entry: CalendarEntry) => days.set(day, [...(days.get(day) || []), entry]);
  const monthPosts = posts.filter(entry => new Date(entry.scheduledAt) >= start && new Date(entry.scheduledAt) < end);
  // Month stats ported from zernio-dev/latewiz@28dd018 src/app/dashboard/calendar/page.tsx:88-105 (MIT), counting posts rather than account copies.
  const countPosts = (status: string) => new Set(monthPosts.filter(entry => entry.post.status === status).map(entry => entry.post.id)).size;
  const entries: (PublishingAgendaEntry & { order: number })[] = posts.filter(entry => new Date(entry.scheduledAt) >= start && new Date(entry.scheduledAt) < end).map(entry => ({
    id: `post:${entry.id}`, title: entry.content || (entry.accountId ? 'Selected account post' : postLabel(entry.post)),
    dateTime: entry.scheduledAt, when: format.format(new Date(entry.scheduledAt)), order: Date.parse(entry.scheduledAt),
    status: entry.post.status || 'Status unavailable',
    details: [entry.platform, entry.accountId && (accounts.find(account => String(account._id || account.id) === entry.accountId)?.displayName || entry.accountId)].filter(Boolean).join(' · '),
    actions: <Button variant="secondary" size="sm" onClick={() => onSelect(entry.post)}>{canWrite ? 'Open post' : 'View post'}</Button>,
  }));
  for (const entry of monthPosts) addDay(localDate(new Date(entry.scheduledAt)), { id: `post:${entry.id}`, label: entry.content || (entry.accountId ? 'Selected account post' : postLabel(entry.post)), time: timeOnly.format(new Date(entry.scheduledAt)), onSelect: () => onSelect(entry.post) });
  let googleCount = 0;
  for (const event of googleEvents) {
    const allDay = Boolean(event.start?.date), dateTime = event.start?.date || event.start?.dateTime;
    const date = new Date(allDay ? dateTime + 'T00:00' : dateTime);
    if (!Number.isFinite(date.getTime()) || !(allDay ? event.start.date < localDate(end) && event.end?.date > localDate(start) : date < end && (Date.parse(event.end?.dateTime) || date.getTime()) > start.getTime())) continue;
    entries.push({ id: `google:${event.id}`, title: `Google · ${event.summary}`, dateTime, order: date.getTime(),
      when: allDay ? `${event.start.date} – ${event.end.date}` : format.format(date),
      status: allDay ? 'All day · End date exclusive' : 'Google Calendar event', actions: googleEventActions?.(event),
    });
    googleCount++;
    // Google entries stay plain text in the grid: their actions live in the list view.
    // A timed event that began last month still shows on this month's first day.
    if (!allDay) addDay(localDate(date < start ? start : date), { id: `google:${event.id}`, label: `Google · ${event.summary}`, time: timeOnly.format(date) });
    else for (let day = new Date(Math.max(date.getTime(), start.getTime())); localDate(day) < event.end.date && day < end; day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)) addDay(localDate(day), { id: `google:${event.id}:${localDate(day)}`, label: `Google · ${event.summary}`, time: 'All day' });
  }
  entries.sort((left, right) => left.order - right.order);
  return <Card><Stack gap={4}>
    <Inline justify="between" align="center">
      <Inline gap={4}><Text size="sm"><Text as="strong">{countPosts('scheduled')}</Text> scheduled</Text><Text size="sm"><Text as="strong">{countPosts('published')}</Text> published</Text><Text size="sm"><Text as="strong">{googleCount}</Text> Google events</Text></Inline>
      {onViewChange && <SegmentedControl label="Calendar view" value={view} onValueChange={value => onViewChange(value as 'month' | 'list')} options={[{ value: 'month', label: 'Month' }, { value: 'list', label: 'List' }]}/>}
    </Inline>
    {view === 'month' && onMonthChange ? <CalendarMonth month={{ year: month.getFullYear(), month: month.getMonth() + 1 }} weekStartsOn={1} locale="en" today={localDate(new Date())} days={days} onPrev={() => onMonthChange(new Date(month.getFullYear(), month.getMonth() - 1, 1))} onNext={() => onMonthChange(new Date(month.getFullYear(), month.getMonth() + 1, 1))} onToday={() => onMonthChange(new Date(new Date().getFullYear(), new Date().getMonth(), 1))} onCreateDay={canWrite && onCreateDay ? onCreateDay : undefined} createDisabledReason={canWrite ? undefined : 'Read only: your role cannot create posts.'}/> : <>
    <PublishingAgenda label="Publishing agenda" scope={month.toLocaleDateString('en', { month: 'long', year: 'numeric' })} timezoneLabel={timezone} entries={entries} readOnly={!canWrite} emptyMessage="No scheduled posts or loaded Google events this month." actions={actions}/>
    {canWrite && onCreateDay && <Inline as="form" key={localDate(start)} align="end" onSubmit={event => { event.preventDefault(); const day = String(new FormData(event.currentTarget as HTMLFormElement).get('day') || ''); if (day) onCreateDay(day); }}>
      <Field label="Post date"><Input type="date" name="day" required defaultValue={localDate(start)}/></Field>
      <Button variant="secondary" type="submit">Create post on date</Button>
    </Inline>}</>}
  </Stack></Card>;
}
