import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Checkbox, ConfirmDialog, DataTable, DescriptionList, Disclosure, Field, Fieldset, FormActions, FormGrid, Heading, Inline, Input, Link, List, ListItem, Option, Select, Stack, StatusLine, Text } from '@ten98/ui';
import { publicMediaUrl } from '../shared/social-posts.ts';

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
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [authUrl, setAuthUrl] = useState(''), [confirming, setConfirming] = useState<Account>();
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
    active.current = true; busyRef.current = false; setBusy(false); setAccounts([]); setLoaded(false); setSelectedId(''); setDetail(null); setError(''); setNotice(''); setAuthUrl(''); setConfirming(undefined); keys.current.clear();
    setBluesky(null); setLanguageText(''); setClearLanguages(false); setBlueskyReview(null);
    setTelegram(null); setCommandDraft([]); setClearCommands(false); setTelegramReview(null);
    setSlack(null); setSlackDraft({ defaultUsername: '', defaultIconUrl: '' }); setClearSlackUsername(false); setClearSlackIcon(false); setSlackReview(null);
    setDiscord(null); setDiscordDraft({ webhookUsername: '', webhookAvatarUrl: '' }); setClearDiscordUsername(false); setClearDiscordAvatar(false); setDiscordReview(null); discordRevision.current++;
    action(loadAccounts);
    return () => { active.current = false; reads.current++; };
  }, [path]);
  useEffect(() => { setBlueskyReview(null); setTelegramReview(null); setSlackReview(null); setDiscordReview(null); setConfirming(undefined); }, [canManage]);
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
    setSelectedId(account._id); setDetail(null); setAuthUrl(''); setConfirming(undefined); setError(''); setNotice('');
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
  function disconnect() { if (selected) setConfirming(selected); }
  async function disconnectSelected() {
    if (!selected || confirming?._id !== selected._id) return;
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
  return <Stack as="section" gap={3}>
    <Inline justify="between" align="center"><Stack gap={1}><Heading level={3} size="sm">Connection health</Heading><Text tone="muted">Check the accounts available to this project and repair access.</Text></Stack><Button variant="secondary" disabled={busy} onClick={() => action(loadAccounts)}>{busy ? 'Working…' : 'Refresh connections'}</Button></Inline>
    {error && <Alert tone="danger">{error}</Alert>}{notice && <StatusLine>{notice}</StatusLine>}
    {loaded && !accounts.length && <Text>No Zernio accounts are connected to this project.</Text>}
    {accounts.length > 0 && <DataTable searchable={false} sortable={false} pagination={false} ariaLabel="Connected accounts" rows={accounts} rowKey={account => account._id} columns={[
      { key: 'account', header: 'Account', rowHeader: true, render: account => <Stack gap={0}><Text as="strong">{name(account)}</Text>{account.username && <Text as="small" tone="muted">{account.username}</Text>}</Stack> }, { key: 'platform', header: 'Platform', render: account => account.platform }, { key: 'health', header: 'Health', render: account => <Stack gap={0}><Text as="span">{account.isActive === false ? 'Inactive' : account.health?.status || 'Not checked'}</Text>{(account.needsReconnection || account.health?.needsReconnect) && <Text as="small" tone="muted">Reconnection needed</Text>}</Stack> }
    ]} rowActionsLabel="Action" rowActions={account => <Button variant="secondary" size="sm" disabled={busy} pressed={selectedId === account._id} aria-label={`Manage ${name(account)}`} onClick={() => choose(account)}>Manage</Button>}/>}
    {selected && <Stack gap={3}>
      <Inline justify="between" align="center"><Heading level={4} size="sm">{name(selected)}</Heading><Button variant="secondary" disabled={busy} onClick={() => action(checkSelected)}>Check detailed health</Button></Inline>
      {shown && <>
        <Text>Health: <Text as="strong">{shown.status}</Text> · Token valid: {yes(detail ? shown.tokenStatus?.valid : shown.tokenValid)} · Can publish: {yes(detail ? shown.permissions?.canPost : shown.canPost)} · Can read analytics: {yes(detail ? shown.permissions?.canFetchAnalytics : shown.canFetchAnalytics)}</Text>
        {(shown.tokenStatus?.expiresAt || shown.tokenExpiresAt) && <Text tone="muted">Token expires: {when(shown.tokenStatus?.expiresAt || shown.tokenExpiresAt)}{shown.tokenStatus?.needsRefresh ? ' · Refresh required soon' : ''}</Text>}
        {shown.analyticsSync && <Text>Analytics synchronization: <Text as="strong">{shown.analyticsSync.status.replaceAll('_', ' ')}</Text> · Last success: {when(shown.analyticsSync.lastSyncedAt)}</Text>}
        {shown.platformConnection && <><Text>WhatsApp platform link: <Text as="strong">{shown.platformConnection.status}</Text> · Inbound webhook subscribed: {yes(shown.platformConnection.inboundWebhookSubscribed)}</Text><Text tone="muted">Checked {when(shown.platformConnection.checkedAt)}. A valid token alone does not confirm that the WhatsApp number can send or receive. Reconnect if the link is disconnected or the inbound webhook is missing.</Text></>}
        {shown.messagingRestriction && <Alert tone="warning" role="note">Messaging restriction observed on a previous send: {shown.messagingRestriction.message || shown.messagingRestriction.code || shown.messagingRestriction.subcode || 'Provider restriction'}.{shown.messagingRestriction.pausedUntil && ` Retry paused until ${when(shown.messagingRestriction.pausedUntil)}.`} This is an observed restriction, not a new live send test.</Alert>}
        {shown.issues.length > 0 && <><Heading level={5} size="sm">Issues</Heading><List>{shown.issues.map((issue, index) => <ListItem key={index}>{issue}</ListItem>)}</List></>}
        {shown.recommendations.length > 0 && <><Heading level={5} size="sm">Recommended action</Heading><List>{shown.recommendations.map((item, index) => <ListItem key={index}>{item}</ListItem>)}</List></>}
        {shown.permissions && <Disclosure summary="Permission details"><Stack gap={3}>{shown.permissions.missingRequired.length > 0 && <Alert tone="warning" role="note">Missing required permissions: {shown.permissions.missingRequired.join(', ')}</Alert>}<DataTable searchable={false} sortable={false} pagination={false} ariaLabel="Permissions" rows={(['posting', 'analytics', 'optional'] as const).flatMap(kind => shown.permissions![kind].map(permission => ({ kind, permission })))} rowKey={row => row.kind + ':' + row.permission.scope} columns={[{ key: 'kind', header: 'Use', render: row => row.kind }, { key: 'scope', header: 'Permission', render: row => row.permission.scope }, { key: 'granted', header: 'Granted', render: row => yes(row.permission.granted) }, { key: 'required', header: 'Required', render: row => yes(row.permission.required) }]}/></Stack></Disclosure>}
      </>}
      {selected.platform === 'facebook' && <FacebookPageSubscription key={`${projectId}:${selected._id}`} projectId={projectId} account={selected} canManage={canManage} request={request}/>}
      {selected.platform === 'whatsapp' && <WhatsAppNumberStatus key={`${projectId}:${selected._id}`} projectId={projectId} account={selected} canManage={canManage} request={request}/>}
      {selected.platform === 'discord' && <Stack gap={3}>
        <Stack gap={1}><Heading level={5} size="sm">Discord default message identity</Heading><Text tone="muted">Set the author name and avatar for posts in this connected channel. Per-post author and avatar settings override these defaults.</Text></Stack>
        <FormActions><Button variant="secondary" disabled={busy} onClick={() => loadDiscord()}>Load Discord identity</Button></FormActions>
        {discord?.accountId === selected._id && <><Text>Server: <Text as="strong">{discord.guildId}</Text> · Channel: <Text as="strong">{discord.channelName || discord.channelId}</Text> ({discord.channelId})</Text><Text>Current author: {discord.webhookUsername || 'Zernio (default)'} · Current avatar: {discord.webhookAvatarUrl || 'Default bot avatar'}</Text>{canManage && <Fieldset legend="Edit Discord message identity" disabled={busy}>
          <Field label="Discord default author name"><Input value={discordDraft.webhookUsername} maxLength={160} disabled={clearDiscordUsername} onChange={event => { editDiscord(); setDiscordDraft({ ...discordDraft, webhookUsername: event.target.value }); }}/></Field>
          <Checkbox label="Clear default author name" checked={clearDiscordUsername} onChange={event => { editDiscord(); setClearDiscordUsername(event.target.checked); }}/>
          <Field label="Discord default avatar URL (public HTTPS)"><Input type="url" value={discordDraft.webhookAvatarUrl} maxLength={4000} disabled={clearDiscordAvatar} onChange={event => { editDiscord(); setDiscordDraft({ ...discordDraft, webhookAvatarUrl: event.target.value }); }}/></Field>
          <Checkbox label="Clear default avatar" checked={clearDiscordAvatar} onChange={event => { editDiscord(); setClearDiscordAvatar(event.target.checked); }}/>
          <Text tone="muted">Use 1 to 80 characters without clyde or discord. A blank field is not a reset; select Clear for each default you want to remove.</Text>
          <FormActions><Button variant="secondary" onClick={() => loadDiscord(true)}>Review latest Discord identity</Button></FormActions>
          {discordReview && <Stack as="section" gap={2} aria-label="Review Discord identity change"><Text>Account: <Text as="strong">{name(selected)}</Text> · Server: {discordReview.settings.guildId} · Channel: {discordReview.settings.channelName || discordReview.settings.channelId} ({discordReview.settings.channelId})</Text><Text>Current author: {discordReview.settings.webhookUsername || 'Zernio (default)'} · Current avatar: {discordReview.settings.webhookAvatarUrl || 'Default bot avatar'}</Text><Text>After saving: author <Text as="strong">{discordReview.defaults.webhookUsername || 'Zernio (clear)'}</Text> · avatar <Text as="strong">{discordReview.defaults.webhookAvatarUrl || 'Default bot avatar (clear)'}</Text></Text><FormActions><Button variant="primary" onClick={saveDiscord}>Confirm and save Discord identity</Button><Button variant="secondary" onClick={() => { editDiscord(); }}>Cancel review</Button></FormActions></Stack>}
        </Fieldset>}</>}
      </Stack>}
      {selected.platform === 'slack' && <Stack gap={3}>
        <Stack gap={1}><Heading level={5} size="sm">Slack default message identity</Heading><Text tone="muted">Set the author name and avatar for messages in this connected channel. Per-post username and icon URL override these defaults. Messages retain Slack’s APP badge; this does not change the app’s global profile.</Text></Stack>
        <FormActions><Button variant="secondary" disabled={busy} onClick={() => loadSlack()}>Load Slack identity</Button></FormActions>
        {slack?.accountId === selected._id && <><Text>Workspace: <Text as="strong">{slack.teamName || slack.teamId}</Text> · Channel: <Text as="strong">{slack.channelName || slack.channelId}</Text></Text><Text>Current author: {slack.defaultUsername || 'App default'} · Current avatar: {slack.defaultIconUrl || 'App default'}</Text>{canManage && <Fieldset legend="Edit default message identity" disabled={busy}>
          <Field label="Default author name"><Input value={slackDraft.defaultUsername} maxLength={80} disabled={clearSlackUsername} onChange={event => { setSlackDraft({ ...slackDraft, defaultUsername: event.target.value }); setSlackReview(null); }}/></Field>
          <Checkbox label="Clear default author name" checked={clearSlackUsername} onChange={event => { setClearSlackUsername(event.target.checked); setSlackReview(null); }}/>
          <Field label="Default avatar URL (public HTTPS)"><Input type="url" value={slackDraft.defaultIconUrl} maxLength={4000} disabled={clearSlackIcon} onChange={event => { setSlackDraft({ ...slackDraft, defaultIconUrl: event.target.value }); setSlackReview(null); }}/></Field>
          <Checkbox label="Clear default avatar" checked={clearSlackIcon} onChange={event => { setClearSlackIcon(event.target.checked); setSlackReview(null); }}/>
          <Text tone="muted">A blank field is not a reset. Select Clear for each default you want to remove.</Text>
          <FormActions><Button variant="secondary" onClick={() => loadSlack(true)}>Review latest Slack identity</Button></FormActions>
          {slackReview && <Stack as="section" gap={2} aria-label="Review Slack identity change"><Text>Account: <Text as="strong">{name(selected)}</Text> · Workspace: {slackReview.settings.teamName || slackReview.settings.teamId} · Channel: {slackReview.settings.channelName || slackReview.settings.channelId}</Text><Text>Current author: {slackReview.settings.defaultUsername || 'App default'} · Current avatar: {slackReview.settings.defaultIconUrl || 'App default'}</Text><Text>After saving: author <Text as="strong">{slackReview.defaults.defaultUsername || 'App default (clear)'}</Text> · avatar <Text as="strong">{slackReview.defaults.defaultIconUrl || 'App default (clear)'}</Text></Text><FormActions><Button variant="primary" onClick={saveSlack}>Confirm and save Slack identity</Button><Button variant="secondary" onClick={() => setSlackReview(null)}>Cancel review</Button></FormActions></Stack>}
        </Fieldset>}</>}
      </Stack>}
      {selected.platform === 'telegram' && <Stack gap={3}>
        <Stack gap={1}><Heading level={5} size="sm">Telegram bot commands</Heading><Text tone="muted">Replace the bot’s command menu in Telegram chats. Zernio exposes the provider-default menu with no custom scope or locale controls. Commands describe menu entries; they do not add automated replies.</Text></Stack>
        <FormActions><Button variant="secondary" disabled={busy} onClick={() => loadTelegram()}>Load bot commands</Button></FormActions>
        {telegram?.accountId === selected._id && <><Text>Current menu: {telegram.commands.length ? `${telegram.commands.length} commands` : 'No commands'}</Text><List>{telegram.commands.map(row => <ListItem key={row.command}><Text as="strong">/{row.command}</Text> — {row.description}</ListItem>)}</List>{canManage && <Fieldset legend="Edit bot command menu" disabled={busy}>
          <Checkbox label="Clear all bot commands" checked={clearCommands} onChange={event => { setClearCommands(event.target.checked); setTelegramReview(null); }}/>
          {!clearCommands && <>{commandDraft.map((row, index) => <FormGrid key={index}>
            <Field label={`Command ${index + 1} (without /)`}><Input value={row.command} maxLength={32} pattern="[a-z0-9_]+" onChange={event => { setCommandDraft(commandDraft.map((item, itemIndex) => itemIndex === index ? { ...item, command: event.target.value } : item)); setTelegramReview(null); }}/></Field>
            <Field label={`Description ${index + 1}`}><Input value={row.description} maxLength={512} onChange={event => { setCommandDraft(commandDraft.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item)); setTelegramReview(null); }}/></Field>
            <FormActions><Button variant="secondary" aria-label={`Remove command ${index + 1}`} onClick={() => { setCommandDraft(commandDraft.filter((_, itemIndex) => itemIndex !== index)); setTelegramReview(null); }}>Remove</Button></FormActions>
          </FormGrid>)}<FormActions><Button variant="secondary" disabled={commandDraft.length >= 100} onClick={() => { setCommandDraft([...commandDraft, { command: '', description: '' }]); setTelegramReview(null); }}>Add command</Button></FormActions></>}
          <Text tone="muted">Saving replaces every current menu entry. Names use 1 to 32 lowercase letters, digits or underscores; descriptions use 1 to 256 characters. To remove every entry, select Clear all bot commands.</Text>
          <FormActions><Button variant="secondary" onClick={() => loadTelegram(true)}>Review bot menu replacement</Button></FormActions>
          {telegramReview && <Stack as="section" gap={2} aria-label="Review Telegram bot menu replacement"><Text>Account: <Text as="strong">{name(selected)}</Text> · Provider-default scope and locale</Text><Text>Current menu:</Text>{telegramReview.settings.commands.length ? <List>{telegramReview.settings.commands.map(row => <ListItem key={row.command}>/{row.command} — {row.description}</ListItem>)}</List> : <Text>No commands</Text>}<Text>After saving: <Text as="strong">{telegramReview.clear ? 'Clear all bot commands' : 'Replace entire menu'}</Text></Text>{telegramReview.commands.length > 0 && <List>{telegramReview.commands.map(row => <ListItem key={row.command}>/{row.command} — {row.description}</ListItem>)}</List>}<FormActions><Button variant="primary" onClick={saveTelegram}>Confirm and save bot menu</Button><Button variant="secondary" onClick={() => setTelegramReview(null)}>Cancel review</Button></FormActions></Stack>}
        </Fieldset>}</>}
      </Stack>}
      {selected.platform === 'bluesky' && <Stack gap={3}>
        <Stack gap={1}><Heading level={5} size="sm">Bluesky default languages</Heading><Text tone="muted">Defaults apply when a future post has no post-specific languages. Existing published posts keep their languages.</Text></Stack>
        <FormActions><Button variant="secondary" disabled={busy} onClick={() => loadBluesky()}>Load default languages</Button></FormActions>
        {bluesky?.accountId === selected._id && <><Text>Current default: <Text as="strong">{bluesky.defaultLangs?.join(', ') || 'No default'}</Text></Text>{canManage && <Stack as="fieldset" gap={3} disabled={busy}>
          <Field label="Language codes, separated by commas"><Input value={languageText} maxLength={304} disabled={clearLanguages} placeholder="en, pt, en-US" onChange={event => { setLanguageText(event.target.value); setBlueskyReview(null); }}/></Field>
          <Checkbox label="Clear default languages" checked={clearLanguages} onChange={event => { setClearLanguages(event.target.checked); setBlueskyReview(null); }}/><Text tone="muted">Choose 1 to 3 distinct BCP-47 codes. A blank input is not a reset; select Clear default languages to remove the default.</Text>
          <FormActions><Button variant="secondary" onClick={() => loadBluesky(true)}>Review latest settings</Button></FormActions>
          {blueskyReview && <Stack as="section" gap={2} aria-label="Review Bluesky language change"><Text>Account: <Text as="strong">{name(selected)}</Text></Text><Text>Current: {blueskyReview.settings.defaultLangs?.join(', ') || 'No default'}</Text><Text>After saving: <Text as="strong">{blueskyReview.defaultLangs?.join(', ') || 'No default (clear)'}</Text></Text><FormActions><Button variant="primary" onClick={saveBluesky}>Confirm and save default languages</Button><Button variant="secondary" onClick={() => setBlueskyReview(null)}>Cancel review</Button></FormActions></Stack>}
        </Stack>}</>}
      </Stack>}
      {canManage && <>
        <FormActions>{selected.canReconnect && <Button variant="secondary" disabled={busy} onClick={reconnect}>Reconnect account</Button>}{authUrl && <Link variant="standalone" href={authUrl} target="_blank" rel="noopener noreferrer">Continue reconnection</Link>}<Button variant="danger" disabled={busy} onClick={disconnect}>Disconnect account</Button></FormActions>
        {!selected.canReconnect && <Text tone="muted">This account uses a credential or platform-specific connection flow. Update it in its connection settings.</Text>}
        <Disclosure summary="Account settings"><Stack as="form" onSubmit={save}><Stack as="fieldset" gap={3} disabled={busy}>
          <FormGrid><Field label="Display name override"><Input maxLength={200} value={draft.displayName} onChange={event => setDraft({ ...draft, displayName: event.target.value })}/></Field><Field label="Username override"><Input maxLength={200} value={draft.username} onChange={event => setDraft({ ...draft, username: event.target.value })}/></Field></FormGrid>
          {selected.platform === 'twitter' && <><Text tone="muted">X background analytics reads and inbox polling incur provider usage charges. Each setting is unchanged unless you choose Enable or Disable. Publishing remains available independently.</Text>{(['analytics', 'inbox'] as const).map(key => <Field key={key} label={key === 'analytics' ? 'X analytics reads' : 'X inbox polling'}><Select value={draft[key]} onChange={event => setDraft({ ...draft, [key]: event.target.value })}><Option value="">Leave unchanged</Option><Option value="true">Enable paid background reads</Option><Option value="false">Disable background reads</Option></Select></Field>)}</>}
          <FormActions><Button variant="secondary" type="submit">Save account settings</Button></FormActions>
        </Stack></Stack></Disclosure>
      </>}
    </Stack>}
    {canManage && <ConfirmDialog open={!!confirming} onOpenChange={open => { if (!open) setConfirming(undefined); }} danger title={`Disconnect “${confirming ? name(confirming) : ''}” from Zernio?`} description="Scheduled posts, messages and advertising that use this connection may stop working. Existing provider campaigns are not paused by this action." confirmLabel="Disconnect account" onConfirm={disconnectSelected}/>}
  </Stack>;
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
  return <Stack as="section" gap={3} aria-label="WhatsApp number status">
    <Stack gap={1}><Heading level={5} size="sm">WhatsApp number status</Heading><Text tone="muted">Read this number’s current quality, messaging tier and throughput from Meta.</Text></Stack>
    <FormActions><Button variant="secondary" disabled={state.busy} onClick={load}>{snapshot ? 'Refresh WhatsApp number status' : 'Load WhatsApp number status'}</Button></FormActions>
    {state.busy && <StatusLine busy>Loading WhatsApp number status…</StatusLine>}{state.error && <Alert tone="danger">{state.error}</Alert>}
    {snapshot && <><Text>Connected account: <Text as="strong">{name(account)}</Text> · {snapshot.accountId}</Text><Text tone="muted">Snapshot loaded {when(snapshot.loadedAt)}.</Text><DescriptionList items={[
      ...([['Display number', snapshot.phone?.display_phone_number], ['Verified display name', snapshot.phone?.verified_name], ['Display name approval', snapshot.phone?.name_status], ['Quality rating', snapshot.phone?.quality_rating], ['Messaging limit tier', snapshot.phone?.messaging_limit_tier], ['Throughput level', snapshot.phone?.throughput?.level], ['Number connection status', snapshot.phone?.status], ['Platform type', snapshot.phone?.platform_type], ['Business account name', snapshot.waba?.name], ['Business verification status', snapshot.waba?.business_verification_status], ['Meta timezone ID', snapshot.waba?.timezone_id]] as const).map(([label, value]) => ({ key: label, term: label, description: reported(value) })),
      { key: 'Official business account', term: 'Official business account', description: yes(snapshot.phone?.is_official_business_account) }
    ]}/></>}
    <Text tone="muted">Missing values are not reported. Throughput is the provider’s level, not a measured sending rate. Detailed Meta health signals are not included; this snapshot does not verify message delivery.</Text>
  </Stack>;
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
  const facts = (settings: FacebookSubscription) => <><Text>Account: <Text as="strong">{settings.accountId}</Text> · Native Page ID: <Text as="strong">{settings.pageId}</Text></Text><Text>Zernio subscribed to this Page: <Text as="strong">{yes(settings.appSubscribed)}</Text> · Lead event access: <Text as="strong">{yes(settings.leadgen)}</Text></Text><Text>Returned subscribed fields: {settings.subscribedFields.join(', ') || 'None returned'}</Text>{settings.warning && <Text tone="muted">{settings.warning}</Text>}</>;
  return <Stack as="section" gap={3} aria-label="Facebook Page event access">
    <Stack gap={1}><Heading level={5} size="sm">Facebook Page event access</Heading><Text tone="muted">Inspect the connected Page’s current event subscription with Meta.</Text></Stack>
    {state.error && <Alert tone="danger">{state.error}</Alert>}{state.notice && <StatusLine>{state.notice}</StatusLine>}{state.closed && <StatusLine>{state.closed}</StatusLine>}
    {!attempt && <FormActions><Button variant="secondary" disabled={busy} onClick={() => load()}>{state.snapshot ? 'Refresh Page event access' : 'Load Page event access'}</Button></FormActions>}
    {state.snapshot && facts(state.snapshot)}
    {canManage && !attempt && <Stack as="fieldset" disabled={busy || !state.snapshot}><FormActions><Button variant="secondary" onClick={() => load(true)}>Review Page event repair</Button></FormActions></Stack>}
    {canManage && state.review && state.review.scope === view && state.review.revision === revision.current && <Stack as="section" gap={2} aria-label="Review Facebook Page event repair"><Heading level={6} size="sm">Review Page event repair</Heading><Text>Account: {state.review.accountName}</Text>{facts(state.review.settings)}<Checkbox label="I understand that Zernio requests its event field set, Meta may grant fewer fields, and this does not prove event delivery." checked={state.confirmed} disabled={busy} onChange={event => { if (!current() || generation !== revision.current || !canManage || view.pending || facebookSubscriptionAttempts.has(target) || state.review?.scope !== view || state.review.revision !== revision.current) return; confirmation.current = event.target.checked ? state.review : null; setState(previous => ({ ...previous, confirmed: event.target.checked })); }}/><FormActions><Button variant="primary" disabled={busy || !state.confirmed} onClick={() => resubscribe()}>Resubscribe Page events</Button><Button variant="secondary" disabled={busy} onClick={() => { if (!current() || generation !== revision.current) return; revision.current++; confirmation.current = null; setState(previous => ({ ...previous, review: null, confirmed: false })); }}>Cancel Page event review</Button></FormActions></Stack>}
    {attempt && <Alert tone="warning"><Stack gap={2}><Text>{attempt.pending ? 'The subscription request is in progress.' : 'The outcome is unknown.'} The original Page, review and action key are retained. Check outcome uses that same action. Resolve it in Provider outcomes if operator review is required.</Text>{facts(attempt.review.settings)}<FormActions><Button variant="secondary" disabled={busy || !canManage} onClick={() => resubscribe(attempt)}>{attempt.pending ? 'Checking outcome…' : 'Check outcome'}</Button></FormActions></Stack></Alert>}
  </Stack>;
}
