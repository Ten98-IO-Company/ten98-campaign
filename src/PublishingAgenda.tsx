import { PublishingAgenda, type PublishingAgendaEntry } from '@ten98/ui';
import './publishing-agenda.css';

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
};
const localDate = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

export default function CampaignPublishingAgenda({ posts, googleEvents, month, accounts = [], canWrite, postLabel, onSelect, onCreateDay }: Props) {
  const start = new Date(month.getFullYear(), month.getMonth(), 1), end = new Date(month.getFullYear(), month.getMonth() + 1, 1);
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const format = new Intl.DateTimeFormat('en', { timeZone: timezone, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
  const entries: (PublishingAgendaEntry & { order: number })[] = posts.filter(entry => new Date(entry.scheduledAt) >= start && new Date(entry.scheduledAt) < end).map(entry => ({
    id: `post:${entry.id}`, title: entry.content || (entry.accountId ? 'Selected account post' : postLabel(entry.post)),
    dateTime: entry.scheduledAt, when: format.format(new Date(entry.scheduledAt)), order: Date.parse(entry.scheduledAt),
    status: entry.post.status || 'Status unavailable',
    details: [entry.platform, entry.accountId && (accounts.find(account => String(account._id || account.id) === entry.accountId)?.displayName || entry.accountId)].filter(Boolean).join(' · '),
    actions: <button type="button" className="button" onClick={() => onSelect(entry.post)}>{canWrite ? 'Open post' : 'View post'}</button>,
  }));
  for (const event of googleEvents) {
    const allDay = Boolean(event.start?.date), dateTime = event.start?.date || event.start?.dateTime;
    const date = new Date(allDay ? dateTime + 'T00:00' : dateTime);
    if (!Number.isFinite(date.getTime()) || !(allDay ? event.start.date < localDate(end) && event.end?.date > localDate(start) : date >= start && date < end)) continue;
    entries.push({ id: `google:${event.id}`, title: `Google · ${event.summary}`, dateTime, order: date.getTime(),
      when: allDay ? `${event.start.date} – ${event.end.date}` : format.format(date),
      status: allDay ? 'All day · End date exclusive' : 'Google Calendar event',
    });
  }
  entries.sort((left, right) => left.order - right.order);
  return <div className="panel campaign-publishing-agenda">
    <PublishingAgenda label="Publishing agenda" scope={month.toLocaleDateString('en', { month: 'long', year: 'numeric' })} timezoneLabel={timezone} entries={entries} readOnly={!canWrite} emptyMessage="No scheduled posts or loaded Google events this month."/>
    {canWrite && onCreateDay && <form key={localDate(start)} className="agenda-create" onSubmit={event => { event.preventDefault(); const day = String(new FormData(event.currentTarget).get('day') || ''); if (day) onCreateDay(day); }}>
      <label className="field"><span>Post date</span><input type="date" name="day" required defaultValue={localDate(start)}/></label>
      <button className="button" type="submit">Create post on date</button>
    </form>}
  </div>;
}
