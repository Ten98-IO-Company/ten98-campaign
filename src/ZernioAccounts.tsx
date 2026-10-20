import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { AppField as Field } from '@ten98/ui/app';
import { publicMediaUrl } from '../shared/social-posts.mjs';

type Health = { status: string; canPost?: boolean; canFetchAnalytics?: boolean; tokenValid?: boolean; tokenExpiresAt?: string; needsReconnect?: boolean; issues: string[]; recommendations: string[]; tokenStatus?: { valid?: boolean; needsRefresh?: boolean; expiresAt?: string; expiresIn?: string }; permissions?: { canPost?: boolean; canFetchAnalytics?: boolean; missingRequired: string[]; posting: Permission[]; analytics: Permission[]; optional: Permission[] }; analyticsSync?: { status: string; lastSyncedAt?: string }; platformConnection?: { status: string; checkedAt?: string; phoneStatus?: string; inboundWebhookSubscribed?: boolean }; messagingRestriction?: { code?: number; subcode?: number; message?: string; firstSeenAt?: string; lastSeenAt?: string; pausedUntil?: string } };
type Permission = { scope: string; granted: boolean; required: boolean };
type Account = { _id: string; platform: string; displayName?: string; username?: string; isActive?: boolean; needsReconnection?: boolean; canReconnect?: boolean; health: Health | null };
type Props = { projectId: string; canManage: boolean; request: (path: string, method?: string, body?: unknown, key?: string) => Promise<any>; onAccountsChanged?: (accounts: Account[]) => void };
type BlueskySettings = { accountId: string; defaultLangs: string[] | null; version: string };
type TelegramCommand = { command: string; description: string };
type TelegramSettings = { accountId: string; commands: TelegramCommand[]; version: string };
type SlackDefaults = { defaultUsername: string; defaultIconUrl: string };
type SlackSettings = SlackDefaults & { accountId: string; channelId: string; channelName: string | null; teamId: string; teamName: string | null; accountVersion: string; version: string };
type DiscordDefaults = { webhookUsername: string; webhookAvatarUrl: string };
type DiscordSettings = DiscordDefaults & { accountId: string; guildId: string; channelId: string; channelType: string; channelName: string | null; accountVersion: string; version: string };
const name = (account: Account) => account.displayName || account.username || account.platform;
const yes = (value?: boolean) => value === undefined || value === null ? 'Not reported' : value ? 'Yes' : 'No';
const when = (value?: string) => value ? new Date(value).toLocaleString() : 'Not reported';

export default function ZernioAccounts({ projectId, canManage, request, onAccountsChanged }: Props) {
  const [accounts, setAccounts] = useState<Account[]>([]), [loaded, setLoaded] = useState(false), [selectedId, setSelectedId] = useState(''), [detail, setDetail] = useState<Health | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [authUrl, setAuthUrl] = useState('');
  const [draft, setDraft] = useState({ displayName: '', username: '', analytics: '', inbox: '' });
  const [bluesky, setBluesky] = useState<BlueskySettings | null>(null), [languageText, setLanguageText] = useState(''), [clearLanguages, setClearLanguages] = useState(false), [blueskyReview, setBlueskyReview] = useState<{ settings: BlueskySettings; defaultLangs: string[] | null } | null>(null);
  const [telegram, setTelegram] = useState<TelegramSettings | null>(null), [commandDraft, setCommandDraft] = useState<TelegramCommand[]>([]), [clearCommands, setClearCommands] = useState(false), [telegramReview, setTelegramReview] = useState<{ settings: TelegramSettings; commands: TelegramCommand[]; clear: boolean } | null>(null);
  const [slack, setSlack] = useState<SlackSettings | null>(null), [slackDraft, setSlackDraft] = useState<SlackDefaults>({ defaultUsername: '', defaultIconUrl: '' }), [clearSlackUsername, setClearSlackUsername] = useState(false), [clearSlackIcon, setClearSlackIcon] = useState(false), [slackReview, setSlackReview] = useState<{ settings: SlackSettings; defaults: SlackDefaults; clearUsername: boolean; clearIcon: boolean } | null>(null);
  const [discord, setDiscord] = useState<DiscordSettings | null>(null), [discordDraft, setDiscordDraft] = useState<DiscordDefaults>({ webhookUsername: '', webhookAvatarUrl: '' }), [clearDiscordUsername, setClearDiscordUsername] = useState(false), [clearDiscordAvatar, setClearDiscordAvatar] = useState(false), [discordReview, setDiscordReview] = useState<{ settings: DiscordSettings; defaults: DiscordDefaults; clearUsername: boolean; clearAvatar: boolean; revision: number } | null>(null);
  const discordRevision = useRef(0);
  const selection = useRef(''), manager = useRef(canManage);
  const path = `/projects/${encodeURIComponent(projectId)}/integrations/accounts`, view = useMemo(() => ({}), [path, canManage]);
  const active = useRef(true), scope = useRef(view), busyRef = useRef(false), reads = useRef(0), keys = useRef(new Map<string, string>()), callback = useRef(onAccountsChanged), requester = useRef(request);
  useLayoutEffect(() => {
    if (manager.current !== canManage || scope.current !== view) reads.current++;
    manager.current = canManage; scope.current = view; selection.current = `${path}:${selectedId}`;
    callback.current = onAccountsChanged; requester.current = request;
  }, [canManage, view, path, selectedId, onAccountsChanged, request]);
  const selected = accounts.find(account => account._id === selectedId), current = () => active.current && scope.current === view;
  useEffect(() => {
    active.current = true; busyRef.current = false; setBusy(false); setAccounts([]); setLoaded(false); setSelectedId(''); setDetail(null); setError(''); setNotice(''); setAuthUrl(''); keys.current.clear();
    setBluesky(null); setLanguageText(''); setClearLanguages(false); setBlueskyReview(null);
    setTelegram(null); setCommandDraft([]); setClearCommands(false); setTelegramReview(null);
    setSlack(null); setSlackDraft({ defaultUsername: '', defaultIconUrl: '' }); setClearSlackUsername(false); setClearSlackIcon(false); setSlackReview(null);
    setDiscord(null); setDiscordDraft({ webhookUsername: '', webhookAvatarUrl: '' }); setClearDiscordUsername(false); setClearDiscordAvatar(false); setDiscordReview(null); discordRevision.current++;
    action(loadAccounts);
    return () => { active.current = false; reads.current++; };
  }, [path]);
  useEffect(() => { setBlueskyReview(null); setTelegramReview(null); setSlackReview(null); setDiscordReview(null); }, [canManage]);
  async function action(run: () => Promise<void>) {
    if (!current() || busyRef.current) return;
    busyRef.current = true; setBusy(true); setError(''); setNotice('');
    try { await run(); } catch (failure) { if (current()) setError((failure as Error).message || 'The account action could not be completed.'); }
    finally { if (current()) { busyRef.current = false; setBusy(false); } }
  }
  async function loadAccounts() {
    const read = ++reads.current, response = await requester.current(`${path}/health`);
    if (!current() || reads.current !== read) return;
    if (!Array.isArray(response.accounts)) throw new Error('The connection health list could not be read.');
    setAccounts(response.accounts); setLoaded(true); setDetail(null); setAuthUrl('');
    if (!response.accounts.some((account: Account) => account._id === selectedId)) setSelectedId('');
    callback.current?.(response.accounts);
  }
  function choose(account: Account) {
    reads.current++; selection.current = `${path}:${account._id}`; setBluesky(null); setLanguageText(''); setClearLanguages(false); setBlueskyReview(null);
    setTelegram(null); setCommandDraft([]); setClearCommands(false); setTelegramReview(null);
    setSlack(null); setSlackDraft({ defaultUsername: '', defaultIconUrl: '' }); setClearSlackUsername(false); setClearSlackIcon(false); setSlackReview(null);
    setDiscord(null); setDiscordDraft({ webhookUsername: '', webhookAvatarUrl: '' }); setClearDiscordUsername(false); setClearDiscordAvatar(false); setDiscordReview(null); discordRevision.current++;
    setSelectedId(account._id); setDetail(null); setAuthUrl(''); setError(''); setNotice('');
    setDraft({ displayName: account.displayName || '', username: account.username || '', analytics: '', inbox: '' });
  }
  async function checkSelected() {
    if (!selected) return;
    const accountId = selected._id, read = ++reads.current, response = await requester.current(`${path}/${encodeURIComponent(accountId)}/health`);
    if (!current() || reads.current !== read) return;
    if (response.account?._id !== accountId || response.health?.accountId !== accountId) throw new Error('The selected account health could not be read.');
    setDetail(response.health); setAuthUrl(''); setNotice('Connection health checked.');
  }
  async function write(task: string, body: unknown, validate?: (response: any) => void) {
    if (!selected || !current()) throw new DOMException('The account view changed.', 'AbortError');
    const target = `${path}/${encodeURIComponent(selected._id)}/${task}`, fingerprint = `${target}:${JSON.stringify(body)}`;
    let key = keys.current.get(fingerprint); if (!key) { key = crypto.randomUUID(); keys.current.set(fingerprint, key); }
    try { const response = await requester.current(target, 'POST', body, key); validate?.(response); keys.current.delete(fingerprint); if (!current()) throw new DOMException('The account view changed.', 'AbortError'); return response; }
    catch (failure) { const receipt = failure as Error & { status?: number; code?: string; operation?: { status?: string } }; if (receipt.status && receipt.status < 500 && !['OPERATION_UNCERTAIN', 'OPERATION_IN_PROGRESS', 'OPERATION_PENDING'].includes(receipt.code || '') && !['uncertain', 'pending'].includes(receipt.operation?.status || '')) keys.current.delete(fingerprint); throw failure; }
  }
  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await action(async () => {
      const body: { displayName: string; username: string; xCapabilities?: Record<string, boolean> } = { displayName: draft.displayName, username: draft.username };
      const toggles = Object.fromEntries(['analytics', 'inbox'].filter(key => draft[key as 'analytics' | 'inbox']).map(key => [key, draft[key as 'analytics' | 'inbox'] === 'true']));
      if (selected?.platform === 'twitter' && Object.keys(toggles).length) body.xCapabilities = toggles;
      await write('update', body); if (current()) setNotice('Account settings confirmed with Zernio.'); await loadAccounts();
    });
  }
  async function reconnect() {
    if (!selected) return;
    await action(async () => {
      const response = await requester.current(`${path}/${encodeURIComponent(selected._id)}/reconnect`);
      if (!current()) return;
      let url; try { url = new URL(response.authUrl); } catch { throw new Error('The reconnection link could not be read.'); }
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error('The reconnection link is invalid.');
      setAuthUrl(url.href); setNotice('Continue with the same platform account and accept all requested permissions. Refresh health after returning.');
    });
  }
  async function disconnect() {
    if (!selected || !window.confirm(`Disconnect “${name(selected)}” from Zernio? Scheduled posts, messages and advertising that use this connection may stop working. Existing provider campaigns are not paused by this action.`)) return;
    await action(async () => { await write('disconnect', { confirmAccountId: selected._id }); if (current()) { setSelectedId(''); setNotice('Account disconnected from Zernio.'); } await loadAccounts(); });
  }
  function intendedDiscordDefaults() {
    const webhookUsername = clearDiscordUsername ? '' : discordDraft.webhookUsername, webhookAvatarUrl = clearDiscordAvatar ? '' : discordDraft.webhookAvatarUrl;
    if (!clearDiscordUsername && !webhookUsername.trim() || [...webhookUsername].length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(webhookUsername) || /clyde|discord/i.test(webhookUsername)) throw new Error('Enter an author name of 1 to 80 characters without clyde or discord, or select Clear default author name.');
    if (!clearDiscordAvatar) { try { if (!webhookAvatarUrl || webhookAvatarUrl.length > 4000) throw new Error(); publicMediaUrl(webhookAvatarUrl); } catch { throw new Error('Enter a public HTTPS avatar URL, or select Clear default avatar.'); } }
    return { webhookUsername, webhookAvatarUrl };
  }
  async function readDiscord() {
    if (selected?.platform !== 'discord') throw new Error('Choose a Discord channel account.');
    const accountId = selected._id, response = await requester.current(`${path}/${encodeURIComponent(accountId)}/discord-settings`);
    if (!response || response.accountId !== accountId || !/^[a-f0-9]{64}$/.test(response.version || '') || !/^[a-f0-9]{64}$/.test(response.accountVersion || '') || ['channelId', 'guildId'].some(key => typeof response[key] !== 'string' || !/^[1-9]\d{0,19}$/.test(response[key])) || !['0', '5', '15'].includes(response.channelType) || response.channelName !== null && typeof response.channelName !== 'string' || typeof response.webhookUsername !== 'string' || [...response.webhookUsername].length > 80 || /[\u0000-\u001f\u007f-\u009f]/.test(response.webhookUsername) || /clyde|discord/i.test(response.webhookUsername) || typeof response.webhookAvatarUrl !== 'string' || response.webhookAvatarUrl.length > 4000) throw new Error('The Discord default message identity could not be read.');
    if (response.webhookAvatarUrl) publicMediaUrl(response.webhookAvatarUrl);
    return response as DiscordSettings;
  }
  function editDiscord() { discordRevision.current++; setDiscordReview(null); }
  async function loadDiscord(review = false) {
    if (!selected || !current() || review && !manager.current) return;
    const target = `${path}:${selected._id}`, read = ++reads.current, revision = discordRevision.current, fresh = () => current() && selection.current === target && reads.current === read && discordRevision.current === revision;
    await action(async () => {
      try {
        const defaults = review ? intendedDiscordDefaults() : null, settings = await readDiscord();
        if (!fresh() || review && !manager.current) return;
        setDiscord(settings);
        if (defaults) setDiscordReview({ settings, defaults, clearUsername: clearDiscordUsername, clearAvatar: clearDiscordAvatar, revision });
        else { setDiscordDraft({ webhookUsername: settings.webhookUsername, webhookAvatarUrl: settings.webhookAvatarUrl }); setClearDiscordUsername(settings.webhookUsername === ''); setClearDiscordAvatar(settings.webhookAvatarUrl === ''); setDiscordReview(null); }
      } catch (failure) { if (fresh()) throw failure; }
    });
  }
  async function saveDiscord() {
    if (!selected || !discordReview || !current() || !manager.current || discordReview.settings.accountId !== selected._id || discordRevision.current !== discordReview.revision) return;
    const target = `${path}:${selected._id}`, read = ++reads.current, review = discordReview, fresh = () => current() && selection.current === target && manager.current && reads.current === read && discordRevision.current === review.revision;
    await action(async () => {
      try {
        if (!fresh()) return;
        const response = await write('discord-settings', { ...review.defaults, clearUsername: review.clearUsername, clearAvatar: review.clearAvatar, expectedVersion: review.settings.version, confirmed: true }, saved => {
          if (!saved || saved.operation?.status !== 'complete' || typeof saved.operation?.id !== 'string' || !saved.operation.id || saved.accountId !== selected._id || saved.readback !== true || !/^[a-f0-9]{64}$/.test(saved.version || '') || saved.accountVersion !== review.settings.accountVersion || ['guildId', 'channelId', 'channelType'].some(field => saved[field] !== review.settings[field as keyof DiscordSettings]) || saved.webhookUsername !== review.defaults.webhookUsername || saved.webhookAvatarUrl !== review.defaults.webhookAvatarUrl) throw new Error('The saved Discord message identity could not be verified. Your draft and action key were retained. Review provider outcomes before retrying.');
        });
        if (!fresh()) return;
        setDiscord(response); setDiscordDraft({ webhookUsername: response.webhookUsername, webhookAvatarUrl: response.webhookAvatarUrl }); setClearDiscordUsername(response.webhookUsername === ''); setClearDiscordAvatar(response.webhookAvatarUrl === ''); setDiscordReview(null); setNotice('Discord default message identity confirmed with Zernio.');
      } catch (failure) { if (fresh()) throw failure; }
    });
  }
  function intendedSlackDefaults() {
    const defaultUsername = clearSlackUsername ? '' : slackDraft.defaultUsername, defaultIconUrl = clearSlackIcon ? '' : slackDraft.defaultIconUrl;
    if (!clearSlackUsername && !defaultUsername.trim() || defaultUsername.length > 80 || /[\u0000-\u001f\u007f]/.test(defaultUsername)) throw new Error('Enter an author name of at most 80 characters, or select Clear default author name.');
    if (!clearSlackIcon) {
      let url; try { url = new URL(defaultIconUrl); } catch { throw new Error('Enter a public HTTPS avatar URL, or select Clear default avatar.'); }
      if (url.protocol !== 'https:' || url.username || url.password || defaultIconUrl.length > 4000) throw new Error('Enter a public HTTPS avatar URL, or select Clear default avatar.');
    }
    return { defaultUsername, defaultIconUrl };
  }
  async function readSlack() {
    if (selected?.platform !== 'slack') throw new Error('Choose a Slack channel account.');
    const accountId = selected._id, response = await requester.current(`${path}/${encodeURIComponent(accountId)}/slack-settings`);
    if (!response || response.accountId !== accountId || !/^[a-f0-9]{64}$/.test(response.version || '') || !/^[a-f0-9]{64}$/.test(response.accountVersion || '') || ['channelId', 'teamId'].some(key => typeof response[key] !== 'string' || !response[key]) || ['channelName', 'teamName'].some(key => response[key] !== null && typeof response[key] !== 'string') || typeof response.defaultUsername !== 'string' || response.defaultUsername.length > 80 || typeof response.defaultIconUrl !== 'string') throw new Error('The Slack default message identity could not be read.');
    return response as SlackSettings;
  }
  async function loadSlack(review = false) {
    if (!selected || !current() || review && !manager.current) return;
    const target = `${path}:${selected._id}`, read = ++reads.current, fresh = () => current() && selection.current === target && reads.current === read;
    await action(async () => {
      try {
        const defaults = review ? intendedSlackDefaults() : null, settings = await readSlack();
        if (!fresh() || review && !manager.current) return;
        setSlack(settings);
        if (defaults) setSlackReview({ settings, defaults, clearUsername: clearSlackUsername, clearIcon: clearSlackIcon });
        else { setSlackDraft({ defaultUsername: settings.defaultUsername, defaultIconUrl: settings.defaultIconUrl }); setClearSlackUsername(settings.defaultUsername === ''); setClearSlackIcon(settings.defaultIconUrl === ''); setSlackReview(null); }
      } catch (failure) { if (fresh()) throw failure; }
    });
  }
  async function saveSlack() {
    if (!selected || !slackReview || !current() || !manager.current || slackReview.settings.accountId !== selected._id) return;
    const target = `${path}:${selected._id}`, read = ++reads.current, fresh = () => current() && selection.current === target && manager.current && reads.current === read;
    await action(async () => {
      try {
        if (!fresh()) return;
        const response = await write('slack-settings', { ...slackReview.defaults, clearUsername: slackReview.clearUsername, clearIcon: slackReview.clearIcon, expectedVersion: slackReview.settings.version, confirmed: true }, saved => {
          if (!saved || saved.operation?.status !== 'complete' || typeof saved.operation?.id !== 'string' || !saved.operation.id || saved.accountId !== selected._id || saved.readback !== true || !/^[a-f0-9]{64}$/.test(saved.version || '') || saved.accountVersion !== slackReview.settings.accountVersion || saved.teamId !== slackReview.settings.teamId || saved.channelId !== slackReview.settings.channelId || saved.defaultUsername !== slackReview.defaults.defaultUsername || saved.defaultIconUrl !== slackReview.defaults.defaultIconUrl) throw new Error('The saved Slack message identity could not be verified. Your draft and action key were retained. Review provider outcomes before retrying.');
        });
        if (!fresh()) return;
        setSlack(response); setSlackDraft({ defaultUsername: response.defaultUsername, defaultIconUrl: response.defaultIconUrl }); setClearSlackUsername(response.defaultUsername === ''); setClearSlackIcon(response.defaultIconUrl === ''); setSlackReview(null); setNotice('Slack default message identity confirmed with Zernio.');
      } catch (failure) { if (fresh()) throw failure; }
    });
  }
  function intendedLanguages() {
    if (clearLanguages) return null;
    const values = languageText.split(',').map(value => value.trim());
    try {
      if (values.length < 1 || values.length > 3 || values.some(value => !value || value.length > 100)) throw new Error();
      const canonical = values.map(value => Intl.getCanonicalLocales(value)[0]);
      if (new Set(canonical).size !== values.length) throw new Error();
      return canonical;
    } catch { throw new Error('Enter 1 to 3 distinct BCP-47 language codes separated by commas, or select Clear default languages.'); }
  }
  async function readBluesky() {
    if (selected?.platform !== 'bluesky') throw new Error('Choose a Bluesky account.');
    const accountId = selected._id, response = await requester.current(`${path}/${encodeURIComponent(accountId)}/bluesky-settings`);
    if (response.accountId !== accountId || !/^[a-f0-9]{64}$/.test(response.version || '') || !(response.defaultLangs === null || Array.isArray(response.defaultLangs) && response.defaultLangs.length >= 1 && response.defaultLangs.length <= 3 && response.defaultLangs.every((value: unknown) => typeof value === 'string'))) throw new Error('The Bluesky default languages could not be read.');
    return response as BlueskySettings;
  }
  async function loadBluesky(review = false) {
    if (!selected || !current() || review && !manager.current) return;
    const target = `${path}:${selected._id}`, read = ++reads.current, fresh = () => current() && selection.current === target && reads.current === read;
    await action(async () => {
      try {
        const intended = review ? intendedLanguages() : null, settings = await readBluesky();
        if (!fresh() || review && !manager.current) return;
        setBluesky(settings);
        if (review) setBlueskyReview({ settings, defaultLangs: intended });
        else { setLanguageText(settings.defaultLangs?.join(', ') || ''); setClearLanguages(settings.defaultLangs === null); setBlueskyReview(null); }
      } catch (failure) { if (fresh()) throw failure; }
    });
  }
  async function saveBluesky() {
    if (!selected || !blueskyReview || !current() || !manager.current || blueskyReview.settings.accountId !== selected._id) return;
    const target = `${path}:${selected._id}`, read = ++reads.current, fresh = () => current() && selection.current === target && manager.current && reads.current === read;
    await action(async () => {
      try {
        if (!fresh()) return;
        const response = await write('bluesky-settings', { defaultLangs: blueskyReview.defaultLangs, expectedVersion: blueskyReview.settings.version, confirmed: true }, receipt => {
          if (receipt.accountId !== selected._id || receipt.readback !== true || !/^[a-f0-9]{64}$/.test(receipt.version || '') || JSON.stringify(receipt.defaultLangs) !== JSON.stringify(blueskyReview.defaultLangs)) throw new Error('The saved Bluesky default languages could not be verified. Your draft and action key were retained. Review provider outcomes before retrying.');
        });
        if (!fresh()) return;
        setBluesky(response); setLanguageText(response.defaultLangs?.join(', ') || ''); setClearLanguages(response.defaultLangs === null); setBlueskyReview(null); setNotice('Bluesky default languages confirmed with Zernio.');
      } catch (failure) { if (fresh()) throw failure; }
    });
  }
  function intendedCommands() {
    if (clearCommands) return [];
    if (!commandDraft.length || commandDraft.length > 100 || commandDraft.some(row => !/^[a-z0-9_]{1,32}$/.test(row.command) || !row.description.trim() || [...row.description].length > 256 || /[\u0000-\u001f\u007f]/.test(row.description)) || new Set(commandDraft.map(row => row.command)).size !== commandDraft.length) throw new Error('Enter 1 to 100 distinct command names (lowercase letters, digits or underscores, no slash) with descriptions of 1 to 256 characters, or select Clear all bot commands.');
    return commandDraft.map(row => ({ ...row }));
  }
  async function readTelegram() {
    if (selected?.platform !== 'telegram') throw new Error('Choose a Telegram account.');
    const accountId = selected._id, response = await requester.current(`${path}/${encodeURIComponent(accountId)}/telegram-commands`);
    if (response.accountId !== accountId || !/^[a-f0-9]{64}$/.test(response.version || '') || !Array.isArray(response.commands) || response.commands.length > 100 || response.commands.some((row: TelegramCommand) => !row || typeof row.command !== 'string' || typeof row.description !== 'string')) throw new Error('The Telegram bot commands could not be read.');
    return response as TelegramSettings;
  }
  async function loadTelegram(review = false) {
    if (!selected || !current() || review && !manager.current) return;
    const target = `${path}:${selected._id}`, read = ++reads.current, fresh = () => current() && selection.current === target && reads.current === read;
    await action(async () => {
      try {
        const intended = review ? intendedCommands() : [], settings = await readTelegram();
        if (!fresh() || review && !manager.current) return;
        setTelegram(settings);
        if (review) setTelegramReview({ settings, commands: intended, clear: clearCommands });
        else { setCommandDraft(settings.commands); setClearCommands(false); setTelegramReview(null); }
      } catch (failure) { if (fresh()) throw failure; }
    });
  }
  async function saveTelegram() {
    if (!selected || !telegramReview || !current() || !manager.current || telegramReview.settings.accountId !== selected._id) return;
    const target = `${path}:${selected._id}`, read = ++reads.current, fresh = () => current() && selection.current === target && manager.current && reads.current === read;
    await action(async () => {
      try {
        if (!fresh()) return;
        const response = await write('telegram-commands', { commands: telegramReview.commands, clear: telegramReview.clear, expectedVersion: telegramReview.settings.version, confirmed: true }, saved => {
          if (saved.accountId !== selected._id || saved.readback !== true || !/^[a-f0-9]{64}$/.test(saved.version || '') || JSON.stringify(saved.commands) !== JSON.stringify(telegramReview.commands)) throw new Error('The saved Telegram bot menu could not be verified. The draft and action key were retained; review provider outcomes before retrying.');
        });
        if (!fresh()) return;
        setTelegram(response); setCommandDraft(response.commands); setClearCommands(false); setTelegramReview(null); setNotice('Telegram bot menu confirmed with Zernio.');
      } catch (failure) { if (fresh()) throw failure; }
    });
  }
  const shown = detail || selected?.health;
  return <section className="panel settings-panel">
    <div className="panel-heading"><div><h2>Connection health</h2><p>Check the accounts available to this project and repair access.</p></div><button type="button" className="button" disabled={busy} onClick={() => action(loadAccounts)}>{busy ? 'Working…' : 'Refresh connections'}</button></div>
    {error && <p className="alert" role="alert">{error}</p>}{notice && <p className="helper-note" role="status">{notice}</p>}
    {loaded && !accounts.length && <p>No Zernio accounts are connected to this project.</p>}
    {accounts.length > 0 && <div className="table-scroll"><table><thead><tr><th>Account</th><th>Platform</th><th>Health</th><th>Action</th></tr></thead><tbody>{accounts.map(account => <tr key={account._id}>
      <td><strong>{name(account)}</strong>{account.username && <><br/><small>{account.username}</small></>}</td><td>{account.platform}</td><td>{account.isActive === false ? 'Inactive' : account.health?.status || 'Not checked'}{(account.needsReconnection || account.health?.needsReconnect) && <><br/><small>Reconnection needed</small></>}</td><td><button type="button" className="button" disabled={busy} aria-pressed={selectedId === account._id} aria-label={`Manage ${name(account)}`} onClick={() => choose(account)}>Manage</button></td>
    </tr>)}</tbody></table></div>}
    {selected && <div className="settings-panel">
      <h3>{name(selected)}</h3><button type="button" className="button" disabled={busy} onClick={() => action(checkSelected)}>Check detailed health</button>
      {shown && <>
        <p>Health: <strong>{shown.status}</strong> · Token valid: {yes(detail ? shown.tokenStatus?.valid : shown.tokenValid)} · Can publish: {yes(detail ? shown.permissions?.canPost : shown.canPost)} · Can read analytics: {yes(detail ? shown.permissions?.canFetchAnalytics : shown.canFetchAnalytics)}</p>
        {(shown.tokenStatus?.expiresAt || shown.tokenExpiresAt) && <p className="helper-note">Token expires: {when(shown.tokenStatus?.expiresAt || shown.tokenExpiresAt)}{shown.tokenStatus?.needsRefresh ? ' · Refresh required soon' : ''}</p>}
        {shown.analyticsSync && <p>Analytics synchronization: <strong>{shown.analyticsSync.status.replaceAll('_', ' ')}</strong> · Last success: {when(shown.analyticsSync.lastSyncedAt)}</p>}
        {shown.platformConnection && <><p>WhatsApp platform link: <strong>{shown.platformConnection.status}</strong> · Inbound webhook subscribed: {yes(shown.platformConnection.inboundWebhookSubscribed)}</p><p className="helper-note">Checked {when(shown.platformConnection.checkedAt)}. A valid token alone does not confirm that the WhatsApp number can send or receive. Reconnect if the link is disconnected or the inbound webhook is missing.</p></>}
        {shown.messagingRestriction && <p className="alert">Messaging restriction observed on a previous send: {shown.messagingRestriction.message || shown.messagingRestriction.code || shown.messagingRestriction.subcode || 'Provider restriction'}.{shown.messagingRestriction.pausedUntil && ` Retry paused until ${when(shown.messagingRestriction.pausedUntil)}.`} This is an observed restriction, not a new live send test.</p>}
        {shown.issues.length > 0 && <><h4>Issues</h4><ul>{shown.issues.map((issue, index) => <li key={index}>{issue}</li>)}</ul></>}
        {shown.recommendations.length > 0 && <><h4>Recommended action</h4><ul>{shown.recommendations.map((item, index) => <li key={index}>{item}</li>)}</ul></>}
        {shown.permissions && <details><summary>Permission details</summary>{shown.permissions.missingRequired.length > 0 && <p className="alert">Missing required permissions: {shown.permissions.missingRequired.join(', ')}</p>}<div className="table-scroll"><table><thead><tr><th>Use</th><th>Permission</th><th>Granted</th><th>Required</th></tr></thead><tbody>{(['posting', 'analytics', 'optional'] as const).flatMap(kind => shown.permissions![kind].map(permission => <tr key={kind + ':' + permission.scope}><td>{kind}</td><td>{permission.scope}</td><td>{yes(permission.granted)}</td><td>{yes(permission.required)}</td></tr>))}</tbody></table></div></details>}
      </>}
      {selected.platform === 'facebook' && <FacebookPageSubscription key={`${projectId}:${selected._id}`} projectId={projectId} account={selected} canManage={canManage} request={request}/>}
      {selected.platform === 'whatsapp' && <WhatsAppNumberStatus key={`${projectId}:${selected._id}`} projectId={projectId} account={selected} canManage={canManage} request={request}/>}
      {selected.platform === 'discord' && <div className="settings-panel">
        <h4>Discord default message identity</h4><p>Set the author name and avatar for posts in this connected channel. Per-post author and avatar settings override these defaults.</p>
        <button type="button" className="button" disabled={busy} onClick={() => loadDiscord()}>Load Discord identity</button>
        {discord?.accountId === selected._id && <><p>Server: <strong>{discord.guildId}</strong> · Channel: <strong>{discord.channelName || discord.channelId}</strong> ({discord.channelId})</p><p>Current author: {discord.webhookUsername || 'Zernio (default)'} · Current avatar: {discord.webhookAvatarUrl || 'Default bot avatar'}</p>{canManage && <fieldset disabled={busy}>
          <legend>Edit Discord message identity</legend>
          <Field label="Discord default author name" value={discordDraft.webhookUsername} maxLength={160} disabled={clearDiscordUsername} onChange={event => { editDiscord(); setDiscordDraft({ ...discordDraft, webhookUsername: event.target.value }); }}/>
          <label><input type="checkbox" checked={clearDiscordUsername} onChange={event => { editDiscord(); setClearDiscordUsername(event.target.checked); }}/> Clear default author name</label>
          <Field label="Discord default avatar URL (public HTTPS)" type="url" value={discordDraft.webhookAvatarUrl} maxLength={4000} disabled={clearDiscordAvatar} onChange={event => { editDiscord(); setDiscordDraft({ ...discordDraft, webhookAvatarUrl: event.target.value }); }}/>
          <label><input type="checkbox" checked={clearDiscordAvatar} onChange={event => { editDiscord(); setClearDiscordAvatar(event.target.checked); }}/> Clear default avatar</label>
          <p className="helper-note">Use 1 to 80 characters without clyde or discord. A blank field is not a reset; select Clear for each default you want to remove.</p>
          <button type="button" className="button" onClick={() => loadDiscord(true)}>Review latest Discord identity</button>
          {discordReview && <div role="region" aria-label="Review Discord identity change"><p>Account: <strong>{name(selected)}</strong> · Server: {discordReview.settings.guildId} · Channel: {discordReview.settings.channelName || discordReview.settings.channelId} ({discordReview.settings.channelId})</p><p>Current author: {discordReview.settings.webhookUsername || 'Zernio (default)'} · Current avatar: {discordReview.settings.webhookAvatarUrl || 'Default bot avatar'}</p><p>After saving: author <strong>{discordReview.defaults.webhookUsername || 'Zernio (clear)'}</strong> · avatar <strong>{discordReview.defaults.webhookAvatarUrl || 'Default bot avatar (clear)'}</strong></p><button type="button" className="button primary" onClick={saveDiscord}>Confirm and save Discord identity</button><button type="button" className="button" onClick={() => { editDiscord(); }}>Cancel review</button></div>}
        </fieldset>}</>}
      </div>}
      {selected.platform === 'slack' && <div className="settings-panel">
        <h4>Slack default message identity</h4><p>Set the author name and avatar for messages in this connected channel. Per-post username and icon URL override these defaults. Messages retain Slack’s APP badge; this does not change the app’s global profile.</p>
        <button type="button" className="button" disabled={busy} onClick={() => loadSlack()}>Load Slack identity</button>
        {slack?.accountId === selected._id && <><p>Workspace: <strong>{slack.teamName || slack.teamId}</strong> · Channel: <strong>{slack.channelName || slack.channelId}</strong></p><p>Current author: {slack.defaultUsername || 'App default'} · Current avatar: {slack.defaultIconUrl || 'App default'}</p>{canManage && <fieldset disabled={busy}>
          <legend>Edit default message identity</legend>
          <label className="field"><span>Default author name</span><input value={slackDraft.defaultUsername} maxLength={80} disabled={clearSlackUsername} onChange={event => { setSlackDraft({ ...slackDraft, defaultUsername: event.target.value }); setSlackReview(null); }}/></label>
          <label><input type="checkbox" checked={clearSlackUsername} onChange={event => { setClearSlackUsername(event.target.checked); setSlackReview(null); }}/> Clear default author name</label>
          <label className="field"><span>Default avatar URL (public HTTPS)</span><input type="url" value={slackDraft.defaultIconUrl} maxLength={4000} disabled={clearSlackIcon} onChange={event => { setSlackDraft({ ...slackDraft, defaultIconUrl: event.target.value }); setSlackReview(null); }}/></label>
          <label><input type="checkbox" checked={clearSlackIcon} onChange={event => { setClearSlackIcon(event.target.checked); setSlackReview(null); }}/> Clear default avatar</label>
          <p className="helper-note">A blank field is not a reset. Select Clear for each default you want to remove.</p>
          <button type="button" className="button" onClick={() => loadSlack(true)}>Review latest Slack identity</button>
          {slackReview && <div role="region" aria-label="Review Slack identity change"><p>Account: <strong>{name(selected)}</strong> · Workspace: {slackReview.settings.teamName || slackReview.settings.teamId} · Channel: {slackReview.settings.channelName || slackReview.settings.channelId}</p><p>Current author: {slackReview.settings.defaultUsername || 'App default'} · Current avatar: {slackReview.settings.defaultIconUrl || 'App default'}</p><p>After saving: author <strong>{slackReview.defaults.defaultUsername || 'App default (clear)'}</strong> · avatar <strong>{slackReview.defaults.defaultIconUrl || 'App default (clear)'}</strong></p><button type="button" className="button primary" onClick={saveSlack}>Confirm and save Slack identity</button><button type="button" className="button" onClick={() => setSlackReview(null)}>Cancel review</button></div>}
        </fieldset>}</>}
      </div>}
      {selected.platform === 'telegram' && <div className="settings-panel">
        <h4>Telegram bot commands</h4><p>Replace the bot’s command menu in Telegram chats. Zernio exposes the provider-default menu with no custom scope or locale controls. Commands describe menu entries; they do not add automated replies.</p>
        <button type="button" className="button" disabled={busy} onClick={() => loadTelegram()}>Load bot commands</button>
        {telegram?.accountId === selected._id && <><p>Current menu: {telegram.commands.length ? `${telegram.commands.length} commands` : 'No commands'}</p><ul>{telegram.commands.map(row => <li key={row.command}><strong>/{row.command}</strong> — {row.description}</li>)}</ul>{canManage && <fieldset disabled={busy}>
          <legend>Edit bot command menu</legend>
          <label><input type="checkbox" checked={clearCommands} onChange={event => { setClearCommands(event.target.checked); setTelegramReview(null); }}/> Clear all bot commands</label>
          {!clearCommands && <>{commandDraft.map((row, index) => <div className="form-grid" key={index}>
            <label className="field"><span>Command {index + 1} (without /)</span><input value={row.command} maxLength={32} pattern="[a-z0-9_]+" onChange={event => { setCommandDraft(commandDraft.map((item, itemIndex) => itemIndex === index ? { ...item, command: event.target.value } : item)); setTelegramReview(null); }}/></label>
            <label className="field"><span>Description {index + 1}</span><input value={row.description} maxLength={512} onChange={event => { setCommandDraft(commandDraft.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item)); setTelegramReview(null); }}/></label>
            <button type="button" className="button" aria-label={`Remove command ${index + 1}`} onClick={() => { setCommandDraft(commandDraft.filter((_, itemIndex) => itemIndex !== index)); setTelegramReview(null); }}>Remove</button>
          </div>)}<button type="button" className="button" disabled={commandDraft.length >= 100} onClick={() => { setCommandDraft([...commandDraft, { command: '', description: '' }]); setTelegramReview(null); }}>Add command</button></>}
          <p className="helper-note">Saving replaces every current menu entry. Names use 1 to 32 lowercase letters, digits or underscores; descriptions use 1 to 256 characters. To remove every entry, select Clear all bot commands.</p>
          <button type="button" className="button" onClick={() => loadTelegram(true)}>Review bot menu replacement</button>
          {telegramReview && <div role="region" aria-label="Review Telegram bot menu replacement"><p>Account: <strong>{name(selected)}</strong> · Provider-default scope and locale</p><p>Current menu:</p>{telegramReview.settings.commands.length ? <ul>{telegramReview.settings.commands.map(row => <li key={row.command}>/{row.command} — {row.description}</li>)}</ul> : <p>No commands</p>}<p>After saving: <strong>{telegramReview.clear ? 'Clear all bot commands' : 'Replace entire menu'}</strong></p>{telegramReview.commands.length > 0 && <ul>{telegramReview.commands.map(row => <li key={row.command}>/{row.command} — {row.description}</li>)}</ul>}<button type="button" className="button primary" onClick={saveTelegram}>Confirm and save bot menu</button><button type="button" className="button" onClick={() => setTelegramReview(null)}>Cancel review</button></div>}
        </fieldset>}</>}
      </div>}
      {selected.platform === 'bluesky' && <div className="settings-panel">
        <h4>Bluesky default languages</h4><p>Defaults apply when a future post has no post-specific languages. Existing published posts keep their languages.</p>
        <button type="button" className="button" disabled={busy} onClick={() => loadBluesky()}>Load default languages</button>
        {bluesky?.accountId === selected._id && <><p>Current default: <strong>{bluesky.defaultLangs?.join(', ') || 'No default'}</strong></p>{canManage && <fieldset disabled={busy}>
          <label className="field"><span>Language codes, separated by commas</span><input value={languageText} maxLength={304} disabled={clearLanguages} placeholder="en, pt, en-US" onChange={event => { setLanguageText(event.target.value); setBlueskyReview(null); }}/></label>
          <label><input type="checkbox" checked={clearLanguages} onChange={event => { setClearLanguages(event.target.checked); setBlueskyReview(null); }}/> Clear default languages</label><p className="helper-note">Choose 1 to 3 distinct BCP-47 codes. A blank input is not a reset; select Clear default languages to remove the default.</p>
          <button type="button" className="button" onClick={() => loadBluesky(true)}>Review latest settings</button>
          {blueskyReview && <div role="region" aria-label="Review Bluesky language change"><p>Account: <strong>{name(selected)}</strong></p><p>Current: {blueskyReview.settings.defaultLangs?.join(', ') || 'No default'}</p><p>After saving: <strong>{blueskyReview.defaultLangs?.join(', ') || 'No default (clear)'}</strong></p><button type="button" className="button primary" onClick={saveBluesky}>Confirm and save default languages</button><button type="button" className="button" onClick={() => setBlueskyReview(null)}>Cancel review</button></div>}
        </fieldset>}</>}
      </div>}
      {canManage && <>
        <div className="button-row">{selected.canReconnect && <button type="button" className="button" disabled={busy} onClick={reconnect}>Reconnect account</button>}{authUrl && <a className="button primary" href={authUrl} target="_blank" rel="noopener noreferrer">Continue reconnection</a>}<button type="button" className="button danger" disabled={busy} onClick={disconnect}>Disconnect account</button></div>
        {!selected.canReconnect && <p className="helper-note">This account uses a credential or platform-specific connection flow. Update it in its connection settings.</p>}
        <details><summary>Account settings</summary><form onSubmit={save}><fieldset disabled={busy}>
          <div className="form-grid"><label className="field"><span>Display name override</span><input maxLength={200} value={draft.displayName} onChange={event => setDraft({ ...draft, displayName: event.target.value })}/></label><label className="field"><span>Username override</span><input maxLength={200} value={draft.username} onChange={event => setDraft({ ...draft, username: event.target.value })}/></label></div>
          {selected.platform === 'twitter' && <><p className="helper-note">X background analytics reads and inbox polling incur provider usage charges. Each setting is unchanged unless you choose Enable or Disable. Publishing remains available independently.</p>{(['analytics', 'inbox'] as const).map(key => <label key={key} className="field"><span>{key === 'analytics' ? 'X analytics reads' : 'X inbox polling'}</span><select value={draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.value })}><option value="">Leave unchanged</option><option value="true">Enable paid background reads</option><option value="false">Disable background reads</option></select></label>)}</>}
          <button className="button">Save account settings</button>
        </fieldset></form></details>
      </>}
    </div>}
  </section>;
}

type WhatsAppNumberInfo = { accountId: string; platform: 'whatsapp'; loadedAt: string; phone?: { display_phone_number?: string; verified_name?: string; name_status?: string; quality_rating?: string; messaging_limit_tier?: string; status?: string; platform_type?: string; is_official_business_account?: boolean; throughput?: { level?: string } }; waba?: { name?: string; business_verification_status?: string; timezone_id?: string } | null };
function whatsappNumberInfo(value: any, accountId: string): WhatsAppNumberInfo {
  const object = (row: any) => row && typeof row === 'object' && !Array.isArray(row), text = (row: any) => typeof row === 'string' && row.length <= 2000;
  const invalid = () => { throw new Error('The selected WhatsApp number status could not be verified.'); };
  if (!object(value) || value.accountId !== accountId || value.platform !== 'whatsapp' || typeof value.loadedAt !== 'string' || value.loadedAt.length > 100 || !Number.isFinite(Date.parse(value.loadedAt))) invalid();
  for (const [key, fields] of [['phone', ['display_phone_number', 'verified_name', 'name_status', 'quality_rating', 'messaging_limit_tier', 'status', 'platform_type']], ['waba', ['name', 'business_verification_status', 'timezone_id']]] as const) {
    const row = value[key]; if (row === undefined || key === 'waba' && row === null) continue;
    if (!object(row) || fields.some(field => row[field] !== undefined && !text(row[field]))) invalid();
  }
  const phone = value.phone;
  if (phone?.is_official_business_account !== undefined && typeof phone.is_official_business_account !== 'boolean' || phone?.throughput !== undefined && (!object(phone.throughput) || phone.throughput.level !== undefined && !text(phone.throughput.level))) invalid();
  return value;
}

export function WhatsAppNumberStatus({ projectId, account, canManage, request }: { projectId: string; account: Account; canManage: boolean; request: Props['request'] }) {
  const [state, setState] = useState<{ snapshot: WhatsAppNumberInfo | null; busy: boolean; error: string }>({ snapshot: null, busy: false, error: '' });
  const target = `/projects/${encodeURIComponent(projectId)}/integrations/accounts/${encodeURIComponent(account._id)}/whatsapp-number-info`, accountSnapshot = JSON.stringify(account);
  const view = useMemo(() => ({ pending: false }), [target, canManage, account, accountSnapshot]), scope = useRef(view), mounted = useRef(true), reads = useRef(0), requester = useRef(request);
  const current = () => mounted.current && scope.current === view && account.platform === 'whatsapp', generation = reads.current;
  useLayoutEffect(() => { scope.current = view; reads.current++; setState({ snapshot: null, busy: false, error: '' }); }, [view]);
  useLayoutEffect(() => { requester.current = request; }, [request]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; reads.current++; }; }, []);
  async function load() {
    if (!current() || generation !== reads.current || view.pending) return;
    const read = ++reads.current; view.pending = true; setState({ snapshot: null, busy: true, error: '' });
    try {
      const result = await requester.current(target);
      if (!current() || read !== reads.current) return;
      const snapshot = whatsappNumberInfo(result, account._id);
      setState({ snapshot, busy: false, error: '' });
    } catch (failure) { if (current() && read === reads.current) setState({ snapshot: null, busy: false, error: (failure as Error).message || 'WhatsApp number status could not be loaded.' }); }
    finally { view.pending = false; }
  }
  const snapshot = state.snapshot, reported = (value?: string) => value?.trim() ? value : 'Not reported';
  return <section className="settings-panel" aria-label="WhatsApp number status">
    <h4>WhatsApp number status</h4><p>Read this number’s current quality, messaging tier and throughput from Meta.</p>
    <button type="button" className="button" disabled={state.busy} onClick={load}>{snapshot ? 'Refresh WhatsApp number status' : 'Load WhatsApp number status'}</button>
    {state.busy && <p role="status">Loading WhatsApp number status…</p>}{state.error && <p className="alert" role="alert">{state.error}</p>}
    {snapshot && <><p>Connected account: <strong>{name(account)}</strong> · {snapshot.accountId}</p><p className="helper-note">Snapshot loaded {when(snapshot.loadedAt)}.</p><dl>
      {([['Display number', snapshot.phone?.display_phone_number], ['Verified display name', snapshot.phone?.verified_name], ['Display name approval', snapshot.phone?.name_status], ['Quality rating', snapshot.phone?.quality_rating], ['Messaging limit tier', snapshot.phone?.messaging_limit_tier], ['Throughput level', snapshot.phone?.throughput?.level], ['Number connection status', snapshot.phone?.status], ['Platform type', snapshot.phone?.platform_type], ['Business account name', snapshot.waba?.name], ['Business verification status', snapshot.waba?.business_verification_status], ['Meta timezone ID', snapshot.waba?.timezone_id]] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{reported(value)}</dd></div>)}
      <div><dt>Official business account</dt><dd>{yes(snapshot.phone?.is_official_business_account)}</dd></div>
    </dl></>}
    <p className="helper-note">Missing values are not reported. Throughput is the provider’s level, not a measured sending rate. Detailed Meta health signals are not included; this snapshot does not verify message delivery.</p>
  </section>;
}

type FacebookSubscription = { accountId: string; pageId: string; appSubscribed: boolean; leadgen: boolean; subscribedFields: string[]; warning: string | null; accountVersion: string; version: string };
type FacebookSubscriptionReview = { settings: FacebookSubscription; accountName: string; scope: object; revision: number };
type FacebookSubscriptionAttempt = { review: FacebookSubscriptionReview; body: Readonly<{ expectedVersion: string; confirmed: true }>; key: string; pending: boolean; notify?: () => void };
// ponytail: pending actions survive selection changes in session memory; reload recovery uses durable Provider outcomes.
const facebookSubscriptionAttempts = new Map<string, FacebookSubscriptionAttempt>();
function facebookSubscription(value: any, accountId: string): FacebookSubscription {
  const bounded = (text: unknown, limit: number) => typeof text === 'string' && !!text.trim() && text.length <= limit && !/[\u0000-\u001f\u007f-\u009f]/.test(text);
  if (value?.accountId !== accountId || !bounded(value.pageId, 500) || /\s/.test(value.pageId) || /^0+$/.test(value.pageId) || typeof value.appSubscribed !== 'boolean' || typeof value.leadgen !== 'boolean' || !Array.isArray(value.subscribedFields) || value.subscribedFields.length > 200 || value.subscribedFields.some((field: unknown) => !bounded(field, 200)) || new Set(value.subscribedFields).size !== value.subscribedFields.length || value.warning !== null && (typeof value.warning !== 'string' || value.warning.length > 2000) || typeof value.accountVersion !== 'string' || !/^[a-f0-9]{64}$/.test(value.accountVersion) || typeof value.version !== 'string' || !/^[a-f0-9]{64}$/.test(value.version)) throw new Error('The Facebook Page event access response could not be verified.');
  return { accountId: value.accountId, pageId: value.pageId, appSubscribed: value.appSubscribed, leadgen: value.leadgen, subscribedFields: [...value.subscribedFields], warning: value.warning, accountVersion: value.accountVersion, version: value.version };
}

export function FacebookPageSubscription({ projectId, account, canManage, request }: { projectId: string; account: Account; canManage: boolean; request: Props['request'] }) {
  const [state, setState] = useState<{ snapshot: FacebookSubscription | null; review: FacebookSubscriptionReview | null; confirmed: boolean; busy: boolean; error: string; notice: string; closed: string }>({ snapshot: null, review: null, confirmed: false, busy: false, error: '', notice: '', closed: '' });
  const accountSnapshot = JSON.stringify(account), target = `/projects/${encodeURIComponent(projectId)}/integrations/accounts/${encodeURIComponent(account._id)}/webhook-subscription`;
  const view = useMemo(() => ({ pending: false }), [target, canManage, account, accountSnapshot]), scope = useRef(view), mounted = useRef(true), revision = useRef(0), confirmation = useRef<FacebookSubscriptionReview | null>(null), requester = useRef(request);
  const current = () => mounted.current && scope.current === view && account.platform === 'facebook', generation = revision.current, attempt = facebookSubscriptionAttempts.get(target), busy = state.busy || !!attempt?.pending;
  const refreshAttempt = () => { if (current()) setState(previous => ({ ...previous })); };
  useLayoutEffect(() => {
    scope.current = view; revision.current++; confirmation.current = null;
    setState({ snapshot: null, review: null, confirmed: false, busy: false, error: '', notice: '', closed: '' });
    const retained = facebookSubscriptionAttempts.get(target); if (retained) retained.notify = refreshAttempt;
    return () => { if (retained?.notify === refreshAttempt) retained.notify = undefined; };
  }, [view]);
  useLayoutEffect(() => { requester.current = request; }, [request]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; revision.current++; const retained = facebookSubscriptionAttempts.get(target); if (retained?.notify === refreshAttempt) retained.notify = undefined; }; }, [target]);
  async function load(review = false) {
    if (!current() || generation !== revision.current || view.pending || facebookSubscriptionAttempts.has(target) || review && (!canManage || !state.snapshot)) return;
    const read = ++revision.current; view.pending = true; confirmation.current = null;
    setState(previous => ({ ...previous, busy: true, review: null, confirmed: false, error: '', notice: '', closed: '', ...(!review ? { snapshot: null } : {}) }));
    try {
      const fresh = facebookSubscription(await requester.current(target), account._id);
      if (!current() || read !== revision.current) return;
      const reviewed = review ? { settings: fresh, accountName: name(account), scope: view, revision: read } : null;
      setState(previous => ({ ...previous, snapshot: fresh, review: reviewed }));
    } catch (failure) { if (current() && read === revision.current) setState(previous => ({ ...previous, snapshot: null, error: (failure as Error).message || 'Facebook Page event access could not be loaded.' })); }
    finally { view.pending = false; if (current()) setState(previous => ({ ...previous, busy: false })); }
  }
  async function resubscribe(retained?: FacebookSubscriptionAttempt) {
    if (!current() || generation !== revision.current || !canManage || view.pending) return;
    let action = facebookSubscriptionAttempts.get(target);
    if (retained ? action !== retained || action.pending : action || !state.review || state.review.scope !== view || state.review.revision !== revision.current || !state.confirmed || confirmation.current !== state.review) return;
    if (!action) {
      action = { review: state.review!, body: Object.freeze({ expectedVersion: state.review!.settings.version, confirmed: true }), key: crypto.randomUUID(), pending: false };
      facebookSubscriptionAttempts.set(target, action);
    }
    const original = action; original.pending = true; original.notify = refreshAttempt; confirmation.current = null; revision.current++;
    setState(previous => ({ ...previous, review: null, confirmed: false, error: '', notice: '', closed: '' }));
    try {
      const response = await requester.current(target, 'POST', original.body, original.key), result = facebookSubscription(response, original.review.settings.accountId);
      if (result.pageId !== original.review.settings.pageId || result.accountVersion !== original.review.settings.accountVersion || response.readback !== true || response.operation?.status !== 'complete' || typeof response.operation.id !== 'string' || !response.operation.id.trim() || typeof response.resubscribed !== 'boolean') throw new Error('The subscription receipt could not be verified. Check the outcome of the same action before starting another repair.');
      if (facebookSubscriptionAttempts.get(target) === original) facebookSubscriptionAttempts.delete(target);
      if (current()) setState(previous => ({ ...previous, snapshot: result, notice: `Subscription outcome checked · Zernio reported resubscribed: ${yes(response.resubscribed)}` }));
    } catch (failure) {
      const problem = failure as Error & { status?: number; code?: string; operation?: { id?: string; status?: string } };
      const closed = problem.code === 'OPERATION_REVIEWED', unsent = problem.code === 'OPERATION_NOT_SENT' || problem.operation?.status === 'failed', uncertain = !unsent && (!!retained || !problem.status || problem.status >= 500 || ['OPERATION_UNCERTAIN', 'OPERATION_PENDING', 'OPERATION_IN_PROGRESS', 'FACEBOOK_PREVIOUS_OUTCOME_UNRESOLVED'].includes(problem.code || '') || ['pending', 'uncertain'].includes(problem.operation?.status || ''));
      if ((closed || !uncertain) && facebookSubscriptionAttempts.get(target) === original) facebookSubscriptionAttempts.delete(target);
      if (current()) { revision.current++; setState(previous => ({ ...previous, snapshot: null, error: problem.message || 'The subscription outcome could not be confirmed.', closed: closed ? `The prior action is closed after operator review · ${problem.operation?.id || 'Operation ID unavailable'} · ${problem.operation?.status || 'Reviewed'}. Load Page event access and explicitly review a new repair.` : unsent ? 'The earlier request was not sent. Load Page event access and explicitly review a new repair.' : '' })); }
    } finally { original.pending = false; original.notify?.(); original.notify = undefined; }
  }
  const facts = (settings: FacebookSubscription) => <><p>Account: <strong>{settings.accountId}</strong> · Native Page ID: <strong>{settings.pageId}</strong></p><p>Zernio subscribed to this Page: <strong>{yes(settings.appSubscribed)}</strong> · Lead event access: <strong>{yes(settings.leadgen)}</strong></p><p>Returned subscribed fields: {settings.subscribedFields.join(', ') || 'None returned'}</p>{settings.warning && <p className="helper-note">{settings.warning}</p>}</>;
  return <section className="settings-panel" aria-label="Facebook Page event access">
    <h4>Facebook Page event access</h4><p>Inspect the connected Page’s current event subscription with Meta.</p>
    {state.error && <p className="alert" role="alert">{state.error}</p>}{state.notice && <p className="helper-note" role="status">{state.notice}</p>}{state.closed && <p className="helper-note" role="status">{state.closed}</p>}
    {!attempt && <button type="button" className="button" disabled={busy} onClick={() => load()}>{state.snapshot ? 'Refresh Page event access' : 'Load Page event access'}</button>}
    {state.snapshot && facts(state.snapshot)}
    {canManage && !attempt && <fieldset disabled={busy || !state.snapshot}><button type="button" className="button" onClick={() => load(true)}>Review Page event repair</button></fieldset>}
    {canManage && state.review && state.review.scope === view && state.review.revision === revision.current && <section className="helper-note" aria-label="Review Facebook Page event repair"><h5>Review Page event repair</h5><p>Account: {state.review.accountName}</p>{facts(state.review.settings)}<label><input type="checkbox" checked={state.confirmed} disabled={busy} onChange={event => { if (!current() || generation !== revision.current || !canManage || view.pending || facebookSubscriptionAttempts.has(target) || state.review?.scope !== view || state.review.revision !== revision.current) return; confirmation.current = event.target.checked ? state.review : null; setState(previous => ({ ...previous, confirmed: event.target.checked })); }}/> I understand that Zernio requests its event field set, Meta may grant fewer fields, and this does not prove event delivery.</label><button type="button" className="button primary" disabled={busy || !state.confirmed} onClick={() => resubscribe()}>Resubscribe Page events</button><button type="button" className="button" disabled={busy} onClick={() => { if (!current() || generation !== revision.current) return; revision.current++; confirmation.current = null; setState(previous => ({ ...previous, review: null, confirmed: false })); }}>Cancel Page event review</button></section>}
    {attempt && <section className="alert" role="status"><p>{attempt.pending ? 'The subscription request is in progress.' : 'The outcome is unknown.'} The original Page, review and action key are retained. Check outcome uses that same action. Resolve it in Provider outcomes if operator review is required.</p>{facts(attempt.review.settings)}<button type="button" className="button" disabled={busy || !canManage} onClick={() => resubscribe(attempt)}>{attempt.pending ? 'Checking outcome…' : 'Check outcome'}</button></section>}
  </section>;
}
