import React, { useEffect, useRef, useState } from 'react';

type Row = Record<string, any>;
type Props = { projectId: string; canManage: boolean; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any> };
type Intent = { task: 'create' | 'default'; body: Row; summary: string[] };
export default function ZernioDestinations({ projectId, canManage, request }: Props) {
  const path = `/projects/${encodeURIComponent(projectId)}/integrations`, [accounts, setAccounts] = useState<Row[]>([]), [accountId, setAccountId] = useState(''), [snapshot, setSnapshot] = useState<Row | null>(null);
  const [name, setName] = useState(''), [description, setDescription] = useState(''), [privacy, setPrivacy] = useState(''), [defaultId, setDefaultId] = useState('');
  const [intent, setIntent] = useState<Intent | null>(null), [reviewed, setReviewed] = useState<Intent | null>(null), [uncertain, setUncertain] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const requester = useRef(request), mounted = useRef(true), pending = useRef(false), reads = useRef(0), keys = useRef(new Map<string, string>()); requester.current = request;
  const identity = JSON.stringify([path, accountId, canManage]), scope = useRef({ identity }); if (scope.current.identity !== identity) scope.current = { identity };
  const view = scope.current, current = () => mounted.current && scope.current === view, account = accounts.find(row => row._id === accountId), youtube = account?.platform === 'youtube', resource = youtube ? 'youtube-playlists' : 'pinterest-boards', target = `${path}/publishing/accounts/${encodeURIComponent(accountId)}/${resource}`;
  const rows = snapshot?.[youtube ? 'playlists' : 'boards'] || [];
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; reads.current++; }; }, []);
  useEffect(() => { let active = true; setAccounts([]); setAccountId(''); requester.current(path + '/accounts').then(result => { if (active) setAccounts(result.accounts.filter((row: Row) => ['pinterest', 'youtube'].includes(row.platform))); }).catch(failure => { if (active) setError(failure.message); }); return () => { active = false; }; }, [path]);
  useEffect(() => { pending.current = false; reads.current++; setBusy(false); setSnapshot(null); setIntent(null); setReviewed(null); setUncertain(false); setName(''); setDescription(''); setPrivacy(youtube ? 'private' : 'PUBLIC'); setDefaultId(''); setError(''); setNotice(''); if (accountId && account) void action(load); }, [identity, account?.platform]);
  async function action(run: () => Promise<void>) {
    if (!current() || pending.current) return; pending.current = true; setBusy(true); setError('');
    try { await run(); } catch (failure) { if (current() && (failure as Error).name !== 'AbortError') setError((failure as Error).message || 'The destination action could not be confirmed.'); }
    finally { if (current()) { pending.current = false; setBusy(false); } }
  }
  async function load() {
    if (!current() || !accountId) return;
    const read = ++reads.current; setSnapshot(null); setIntent(null); setReviewed(null); setUncertain(false); setDefaultId('');
    const result = await requester.current(target + '/manage');
    if (!current() || reads.current !== read) return;
    if (result.accountId !== accountId || result.platform !== account?.platform || typeof result.version !== 'string' || !Array.isArray(result[youtube ? 'playlists' : 'boards'])) throw new Error('The account’s destination snapshot could not be read.');
    setSnapshot(result);
  }
  function clearReview() { setIntent(null); setReviewed(null); }
  function prepare(event: React.FormEvent<HTMLFormElement>, task: 'create' | 'default') {
    event.preventDefault(); if (!canManage || !snapshot || busy || uncertain || !current()) return;
    if (task === 'create') {
      const settings = { [youtube ? 'title' : 'name']: name.trim(), description, privacy };
      setIntent({ task, body: { expectedVersion: snapshot.version, confirmed: true, settings }, summary: [`Create ${youtube ? 'YouTube playlist' : 'Pinterest board'}: ${name.trim()}`, `Privacy: ${privacy.toLowerCase()}`, `Description: ${description || 'Empty'}`, ...(youtube ? ['This costs 50 YouTube quota units. Creation is not idempotent; an unknown outcome must be reviewed before another attempt.'] : [])] });
    } else {
      const selected = rows.find((row: Row) => row.id === defaultId); if (!selected) return;
      setIntent({ task, body: { expectedVersion: snapshot.version, confirmed: true, destinationId: selected.id }, summary: [`Save account default: ${selected.title || selected.name} (${selected.id})`, youtube ? 'Publishing without a playlist adds none. Choose the saved playlist explicitly in each post.' : 'Pinterest’s current saved default is not exposed by this API contract. Choose a board explicitly when publishing.'] });
    }
    setReviewed(null); setError(''); setNotice('');
  }
  async function write(review: Intent) {
    const route = `${target}/${review.task}`, fingerprint = JSON.stringify([route, review.body]); if (!keys.current.has(fingerprint)) keys.current.set(fingerprint, crypto.randomUUID());
    try {
      const result = await requester.current(route, 'POST', review.body, keys.current.get(fingerprint));
      const valid = result.snapshot?.accountId === accountId && typeof result.snapshot.version === 'string' && (review.task === 'create' ? result.created === true && typeof result.destination?.id === 'string' : result.accepted === true && result.defaultId === review.body.destinationId && typeof result.readback === 'boolean');
      if (result.operation?.status !== 'complete' || !valid) throw new Error('The destination receipt could not be read. Its action key was retained; review provider outcomes.');
      keys.current.delete(fingerprint); return result;
    } catch (failure) { const problem = failure as Error & { status?: number; code?: string; operation?: Row }; if (problem.status && problem.status < 500 && !['OPERATION_UNCERTAIN', 'OPERATION_PENDING', 'OPERATION_IN_PROGRESS'].includes(problem.code || '') && !['pending', 'uncertain'].includes(problem.operation?.status)) keys.current.delete(fingerprint); throw failure; }
  }
  async function save() {
    if (!canManage || !intent || reviewed !== intent || !snapshot || snapshot.version !== intent.body.expectedVersion || !current()) return;
    const review = intent;
    await action(async () => {
      let result; try { result = await write(review); } catch (failure) { const problem = failure as Error & { status?: number; code?: string }; if (current() && (!problem.status || problem.status >= 500 || problem.code === 'OPERATION_UNCERTAIN')) setUncertain(true); throw failure; }
      if (!current()) return; setSnapshot(result.snapshot); setIntent(null); setReviewed(null); setUncertain(false); setDefaultId('');
      setNotice(review.task === 'create' ? `${youtube ? 'Empty YouTube playlist' : 'Pinterest board'} creation confirmed. The account default was kept.` : result.readback ? 'Saved YouTube default verified. Choose it explicitly when publishing a video.' : 'Pinterest accepted the default setting. This contract does not expose the current saved default; choose a board explicitly when publishing.');
    });
  }
  return <section className="panel settings-panel"><div className="panel-heading"><div><h2>Publishing destinations</h2><p>Create Pinterest boards and YouTube playlists, or save an account default.</p></div>{accountId && <button className="button" type="button" disabled={busy} onClick={() => action(load)}>Refresh destinations</button>}</div>{error && <p className="alert" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}{busy && <p role="status">Reading or confirming destinations…</p>}
    <label className="field"><span>Connected account</span><select value={accountId} disabled={busy} onChange={event => setAccountId(event.target.value)}><option value="">Choose Pinterest or YouTube</option>{accounts.map(row => <option key={row._id} value={row._id} disabled={row.isActive === false}>{row.platform === 'youtube' ? 'YouTube' : 'Pinterest'} · {row.displayName || row.username || row._id}</option>)}</select></label>
    {snapshot && <><h3>{snapshot.accountName}</h3><p className="field-help">{youtube ? `Saved default: ${snapshot.defaultReported ? snapshot.defaultPlaylistId ? rows.find((row: Row) => row.id === snapshot.defaultPlaylistId)?.title || snapshot.defaultPlaylistId : 'None' : 'Not reported'}. A saved default is never applied automatically when a post omits a playlist. This API requires a nonempty playlist ID, so clearing the saved default is unavailable.` : 'The current saved Pinterest default is not exposed by this API contract. Select an explicit board on each post.'}</p>{rows.length ? <ul>{rows.map((row: Row) => <li key={row.id}><strong>{row.title || row.name}</strong> · {String(row.privacy).toLowerCase()} · {row.id}{youtube && row.itemCount != null ? ` · ${row.itemCount} videos` : ''}{row.description && <p style={{ whiteSpace: 'pre-wrap' }}>{row.description}</p>}</li>)}</ul> : <p>No destinations were returned for this account.</p>}
      {canManage && <fieldset disabled={busy || uncertain}><form onSubmit={event => prepare(event, 'default')} onInput={clearReview}><label className="field"><span>New saved account default</span><select required value={defaultId} onChange={event => setDefaultId(event.target.value)}><option value="">Choose an existing {youtube ? 'playlist' : 'board'}</option>{rows.map((row: Row) => <option key={row.id} value={row.id}>{row.title || row.name} · {String(row.privacy).toLowerCase()}</option>)}</select></label><button className="button" disabled={!defaultId}>Review default change</button></form><details><summary>Create {youtube ? 'YouTube playlist' : 'Pinterest board'}</summary>{youtube && <p className="field-help">An empty playlist costs 50 YouTube quota units and requires playlist creation permission. Creation is not idempotent: a timeout may still create it. Check provider outcomes and the playlist list before another attempt. Official series settings remain in YouTube’s desktop playlist settings.</p>}<form onSubmit={event => prepare(event, 'create')} onInput={clearReview}><label className="field"><span>{youtube ? 'Playlist title' : 'Board name'}</span><input required maxLength={youtube ? 150 : 180} value={name} onChange={event => setName(event.target.value)}/></label><label className="field"><span>Description (optional)</span><textarea maxLength={5000} value={description} onChange={event => setDescription(event.target.value)}/></label><label className="field"><span>Privacy</span><select required value={privacy} onChange={event => setPrivacy(event.target.value)}>{(youtube ? ['private', 'unlisted', 'public'] : ['PUBLIC', 'PROTECTED', 'SECRET']).map(value => <option key={value} value={value}>{value.toLowerCase()}</option>)}</select></label><button className="button">Review creation</button></form></details></fieldset>}
    </>}{uncertain && <p className="alert">This outcome needs review in provider outcomes. The same action key has been retained. Resolve it and refresh before preparing another destination change.</p>}{intent && <section className="helper-note"><h3>Review destination change</h3><p>{snapshot?.accountName} · Connected account {accountId}</p><ul>{intent.summary.map((line, index) => <li key={index}>{line}</li>)}</ul><label className="checkbox-label"><input type="checkbox" checked={reviewed === intent} disabled={busy || uncertain} onChange={event => setReviewed(event.target.checked ? intent : null)}/>I reviewed this exact account, destination, privacy and shared default setting.</label><div className="button-wrap"><button className="button primary" type="button" disabled={busy || !canManage || reviewed !== intent} onClick={save}>{uncertain ? 'Check the same action again' : 'Apply reviewed change'}</button><button className="button" type="button" disabled={busy} onClick={clearReview}>Close review</button></div></section>}
  </section>;
}
