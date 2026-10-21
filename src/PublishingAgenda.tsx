import type { ReactNode } from 'react';
import { Button, Card, Field, Inline, Input, PublishingAgenda, type PublishingAgendaEntry } from '@ten98/ui';

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
};
const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export default function CampaignPublishingAgenda({ posts, googleEvents, month, accounts = [], canWrite, postLabel, onSelect, onCreateDay, googleEventActions, actions }: Props) {
  const start = new Date(month.getFullYear(), month.getMonth(), 1), end = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const format = new Intl.DateTimeFormat('en', { timeZone: timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  const entries: (PublishingAgendaEntry & { order: number })[] = posts.filter(entry => new Date(entry.scheduledAt) >= start && new Date(entry.scheduledAt) < end).map(entry => ({
    id: `post:${entry.id}`, title: entry.content || (entry.accountId ? 'Selected account post' : postLabel(entry.post)),
    dateTime: entry.scheduledAt, when: format.format(new Date(entry.scheduledAt)), order: Date.parse(entry.scheduledAt),
    status: entry.post.status || 'Status unavailable',
    details: [entry.platform, entry.accountId && (accounts.find(account => String(account._id || account.id) === entry.accountId)?.displayName || entry.accountId)].filter(Boolean).join(' · '),
    actions: <Button variant="secondary" size="sm" onClick={() => onSelect(entry.post)}>{canWrite ? 'Open post' : 'View post'}</Button>,
  }));
  for (const event of googleEvents) {
    const allDay = Boolean(event.start?.date), dateTime = event.start?.date || event.start?.dateTime;
    const date = new Date(allDay ? dateTime + 'T00:00' : dateTime);
    if (!Number.isFinite(date.getTime()) || !(allDay ? event.start.date < localDate(end) && event.end?.date > localDate(start) : date >= start && date < end)) continue;
    entries.push({ id: `google:${event.id}`, title: `Google · ${event.summary}`, dateTime, order: date.getTime(),
      when: allDay ? `${event.start.date} – ${event.end.date}` : format.format(date),
      status: allDay ? 'All day · End date exclusive' : 'Google Calendar event', actions: googleEventActions?.(event),
    });
  }
  entries.sort((left, right) => left.order - right.order);
  return <Card>
    <PublishingAgenda label="Publishing agenda" scope={month.toLocaleDateString('en', { month: 'long', year: 'numeric' })} timezoneLabel={timezone} entries={entries} readOnly={!canWrite} emptyMessage="No scheduled posts or loaded Google events this month." actions={actions}/>
    {canWrite && onCreateDay && <Inline as="form" key={localDate(start)} align="end" onSubmit={event => { event.preventDefault(); const day = String(new FormData(event.currentTarget as HTMLFormElement).get('day') || ''); if (day) onCreateDay(day); }}>
      <Field label="Post date"><Input type="date" name="day" required defaultValue={localDate(start)}/></Field>
      <Button variant="secondary" type="submit">Create post on date</Button>
    </Inline>}
  </Card>;
}
