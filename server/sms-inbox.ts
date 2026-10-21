import { createHash, randomUUID } from 'node:crypto';
import { IntegrationError, fail, operation } from './provider-core.ts';
import { sql } from 'drizzle-orm';
import type { Database, Executor } from './database.ts';
import { sendSmsReply } from './direct-providers.ts';
import { createContacts } from './contacts.ts';
import { nextDeliveryStatus, smsStarted as started } from './direct-campaigns.ts';

const phone = (value: any): value is string => typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value);
const sid = (value: any, prefix: string): value is string => typeof value === 'string' && new RegExp(`^${prefix}[a-fA-F0-9]{32}$`).test(value);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const stopped = (form: URLSearchParams) => form.get('OptOutType') === 'STOP' || /^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|REVOKE|OPT OUT)$/i.test((form.get('Body') || '').trim());
const statuses = new Set(['accepted', 'queued', 'sending', 'sent', 'delivered', 'failed', 'undelivered', 'cancelled']);

const resultRows = async (query: Promise<{ rows: unknown[] }>) => (await query).rows as any[];

export function createSmsInbox({ db, env, appUrl, contacts = createContacts({ db }) }: { db: Database; env: any; appUrl: string; contacts?: ReturnType<typeof createContacts> }) {
  const find = async (projectId: string, id: string, ex: Executor = db): Promise<any> => { const [row] = await resultRows(ex.execute(sql`SELECT * FROM sms_conversations WHERE project_id = ${projectId} AND id = ${id}`)); if (!row) fail(404, 'SMS_CONVERSATION_NOT_FOUND', 'This SMS conversation was not found in the project.'); return row; };
  const readMessage = async (id: string, ex: Executor = db, lock = false): Promise<any> => { const [row] = await resultRows(ex.execute(lock ? sql`SELECT * FROM sms_messages WHERE id = ${id} FOR UPDATE` : sql`SELECT * FROM sms_messages WHERE id = ${id}`)); return row ? { ...row, record: row.data } : null; };
  const putMessage = async (record: any, ex: Executor = db) => { await ex.execute(sql`UPDATE sms_messages SET provider_id = ${record.providerId || null}, data = ${JSON.stringify(record)} WHERE id = ${record.id}`); return record; };
  // Row lock: read-modify-write of one message, so a signed callback and the send acknowledgement cannot overwrite each other.
  const changeMessage = (id: string, change: (record: any) => unknown) => db.transaction(async tx => { const entry = await readMessage(id, tx, true); if (!entry) return null; if (await change(entry.record) !== false) await putMessage(entry.record, tx); return entry.record; });
  const suppression = async (projectId: string, recipient: string): Promise<any> => await contacts.smsSuppression(recipient) || (await resultRows(db.execute(sql`SELECT reason FROM direct_contact_suppressions WHERE project_id = ${projectId} AND channel = 'sms' AND target_hash = ${digest(recipient)}`)))[0];
  async function conversationView(row: any) {
    const data = row.data, contact = (await contacts.list(row.project_id)).find((item: any) => item.phone === row.recipient), block = await suppression(row.project_id, row.recipient);
    return { ...data, id: row.id, projectId: row.project_id, platform: 'sms', provider: 'twilio', sender: row.sender, recipient: row.recipient, participantId: row.recipient, participantName: contact?.name || row.recipient, ...(contact ? { contactId: contact.id } : {}), blocked: Boolean(block), blockedReason: block?.reason || '' };
  }
  // Callers hold a transaction; ON CONFLICT plus FOR UPDATE make concurrent first messages share one conversation row and serialise its lastMessage update.
  async function conversation(tx: Executor, projectId: string, accountSid: string, sender: string, recipient: string, serviceSid = '') {
    await tx.execute(sql`INSERT INTO sms_conversations VALUES (${randomUUID()}, ${projectId}, ${accountSid}, ${sender}, ${recipient}, ${serviceSid}, ${JSON.stringify({ createdAt: new Date().toISOString(), lastMessage: '', lastMessageAt: null })}) ON CONFLICT (project_id, account_sid, sender, recipient) DO NOTHING`);
    return (await resultRows(tx.execute(sql`SELECT * FROM sms_conversations WHERE project_id = ${projectId} AND account_sid = ${accountSid} AND sender = ${sender} AND recipient = ${recipient} FOR UPDATE`)))[0];
  }
  async function insertMessage(tx: Executor, row: any, message: any) {
    await tx.execute(sql`INSERT INTO sms_messages (id, project_id, conversation_id, account_sid, provider_id, data) VALUES (${message.id}, ${row.project_id}, ${row.id}, ${row.account_sid}, ${message.providerId || null}, ${JSON.stringify(message)})`);
    const data = row.data; Object.assign(data, { lastMessage: message.message, lastMessageAt: message.createdAt }); await tx.execute(sql`UPDATE sms_conversations SET data = ${JSON.stringify(data)} WHERE id = ${row.id}`);
    return message;
  }
  async function recordOutbound({ id, projectId, accountSid, sender, recipient, messagingServiceSid = '', providerId, message = '', status = 'accepted', campaignId }: any) {
    await recovery();
    if (!sid(accountSid, 'AC') || !phone(sender) || !phone(recipient) || !sid(providerId, '(?:SM|MM)') || !(await db.execute(sql`SELECT id FROM projects WHERE id = ${projectId}`)).rowCount) return;
    return db.transaction(async tx => {
      const row = await conversation(tx, projectId, accountSid, sender, recipient, messagingServiceSid), existing = await readMessage(id, tx, true), record = { id, providerId, conversationId: row.id, direction: 'outgoing', message, senderId: sender, recipient, createdAt: existing?.record.createdAt || new Date().toISOString(), status, deliveryStatus: status, attachments: [], ...(campaignId ? { campaignId } : {}) };
      if (row.service_sid !== messagingServiceSid) await tx.execute(sql`UPDATE sms_conversations SET service_sid = ${messagingServiceSid} WHERE id = ${row.id}`);
      if (existing) { if (existing.project_id !== projectId || existing.conversation_id !== row.id || existing.record.providerId && existing.record.providerId !== providerId) fail(400, 'SMS_DELIVERY_MISMATCH', 'The SMS delivery does not match its conversation.'); record.status = nextDeliveryStatus(existing.record.status, status); record.deliveryStatus = record.status; return putMessage({ ...existing.record, ...record }, tx); }
      return insertMessage(tx, row, record);
    });
  }
  async function receiveVerified(form: URLSearchParams, { projectId }: { projectId?: string } = {}) {
    await recovery();
    const accountSid = form.get('AccountSid')!, providerId = form.get('MessageSid'), recipient = form.get('From'), sender = form.get('To'), body = form.get('Body') || '', serviceSid = form.get('MessagingServiceSid') || '';
    if (accountSid !== env.TWILIO_ACCOUNT_SID || !sid(providerId, '(?:SM|MM)') || !phone(recipient) || !phone(sender) || body.length > 1600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body) || serviceSid && !sid(serviceSid, 'MG')) fail(400, 'INVALID_SMS_MESSAGE', 'The incoming SMS identity or content is invalid.');
    const hash = digest(JSON.stringify([...form.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))), [prior] = await resultRows(db.execute(sql`SELECT * FROM sms_inbound_receipts WHERE account_sid = ${accountSid} AND provider_id = ${providerId}`));
    if (prior) { if (prior.body_hash !== hash || projectId && prior.project_id && prior.project_id !== projectId) fail(400, 'SMS_EVENT_CONFLICT', 'This SMS delivery conflicts with its original receipt.'); if (prior.status !== 'unattributed' || !projectId) return { accepted: true, duplicate: true }; }
    else if ((await db.execute(sql`SELECT id FROM sms_messages WHERE account_sid = ${accountSid} AND provider_id = ${providerId}`)).rowCount) fail(400, 'SMS_EVENT_CONFLICT', 'This message identifier already belongs to another delivery.');
    const mediaCount = form.get('NumMedia') || '0'; if (!/^\d{1,2}$/.test(mediaCount) || Number(mediaCount) > 10) fail(400, 'INVALID_SMS_MEDIA', 'The incoming media count is invalid.');
    const attachments = Array.from({ length: Number(mediaCount) }, (_, index) => {
      const value = form.get('MediaUrl' + index), contentType = form.get('MediaContentType' + index) || '';
      let url: URL; try { url = new URL(value!); } catch { fail(400, 'INVALID_SMS_MEDIA', 'The incoming attachment URL is invalid.'); }
      if (url.protocol !== 'https:' || url.hostname !== 'api.twilio.com' || url.username || url.password || !url.pathname.startsWith(`/2010-04-01/Accounts/${accountSid}/Messages/${providerId}/Media/`) || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(contentType)) fail(400, 'INVALID_SMS_MEDIA', 'The incoming attachment is outside the verified Twilio message.');
      return { url: url.href, contentType, type: contentType.startsWith('image/') ? 'image' : contentType.startsWith('video/') ? 'video' : contentType.startsWith('audio/') ? 'audio' : 'file' };
    });
    // STOP takes effect even if retaining the optional conversation subsequently fails.
    if (stopped(form)) await contacts.suppressSmsGlobally(recipient, 'Recipient opted out');
    else if (started(form)) await contacts.liftSmsOptOut(recipient);
    const candidates = await resultRows(db.execute(sql`SELECT DISTINCT c.project_id FROM sms_conversations c JOIN sms_messages m ON m.conversation_id = c.id WHERE c.account_sid = ${accountSid} AND c.sender = ${sender} AND c.recipient = ${recipient} AND (${serviceSid}::text = '' OR c.service_sid = ${serviceSid}) AND m.provider_id IS NOT NULL AND m.data->>'direction' = 'outgoing' AND (${projectId || null}::text IS NULL OR c.project_id = ${projectId || null})`));
    return db.transaction(async tx => {
      const target = candidates.length === 1 ? candidates[0].project_id : null;
      // A replayed delivery racing this one waits on the receipt row; the guarded update leaves a stored receipt as it is.
      const receipt = await tx.execute(sql`INSERT INTO sms_inbound_receipts VALUES (${accountSid}, ${providerId}, ${hash}, ${target}, ${target ? 'stored' : 'unattributed'}) ON CONFLICT (account_sid, provider_id) DO UPDATE SET project_id = excluded.project_id, status = excluded.status WHERE sms_inbound_receipts.status = 'unattributed' AND sms_inbound_receipts.body_hash = excluded.body_hash`);
      if (!receipt.rowCount) { if ((await resultRows(tx.execute(sql`SELECT body_hash FROM sms_inbound_receipts WHERE account_sid = ${accountSid} AND provider_id = ${providerId}`)))[0]?.body_hash !== hash) fail(400, 'SMS_EVENT_CONFLICT', 'This SMS delivery conflicts with its original receipt.'); return { accepted: true, duplicate: true }; }
      if (!target) return { accepted: true, unattributed: true };
      const row = await conversation(tx, target, accountSid, sender, recipient, serviceSid), record = { id: randomUUID(), providerId, conversationId: row.id, direction: 'incoming', message: body, senderId: recipient, recipient: sender, createdAt: new Date().toISOString(), status: 'received', deliveryStatus: 'received', attachments };
      await insertMessage(tx, row, record); return { accepted: true };
    });
  }
  async function receiveStatus(form: URLSearchParams, id: string) {
    await recovery();
    const entry = await readMessage(id); if (!entry) return false;
    const row = await find(entry.project_id, entry.conversation_id), providerId = form.get('MessageSid'), status = form.get('MessageStatus') === 'canceled' ? 'cancelled' : form.get('MessageStatus') as string;
    await changeMessage(id, record => {
      if (record.direction !== 'outgoing' || form.get('AccountSid') !== row.account_sid || form.get('To') !== row.recipient || form.get('From') && form.get('From') !== row.sender || !sid(providerId, '(?:SM|MM)') || record.providerId && record.providerId !== providerId || !statuses.has(status as string)) fail(400, 'SMS_DELIVERY_MISMATCH', 'The SMS callback does not match this conversation.');
      record.providerId = providerId; record.status = nextDeliveryStatus(record.status, status); record.deliveryStatus = record.status; if (form.get('ErrorCode')) record.errorCode = form.get('ErrorCode')!.slice(0, 20);
    });
    if (form.get('ErrorCode') === '21610') await contacts.suppressSmsGlobally(row.recipient, 'Recipient opted out');
    return true;
  }
  const page = (url: URL) => { const cursor = url.searchParams.get('cursor'); if (cursor !== null && (!/^\d{1,16}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) fail(400, 'INVALID_SMS_CURSOR', 'Choose a valid SMS page.'); return cursor === null ? Number.MAX_SAFE_INTEGER : Number(cursor); };
  async function handle(context: any) {
    const { req, url, project, role, body = {}, send } = context, prefix = `/api/projects/${encodeURIComponent(project.id)}/sms-inbox`, path = url.pathname.slice(prefix.length);
    if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return false;
    await recovery();
    const media = path.match(/^\/media\/([\w-]+)\/(\d)$/);
    if (media && req.method === 'GET') {
      const entry = await readMessage(media[1]), attachment = entry?.record.attachments?.[Number(media[2])];
      if (!entry || entry.project_id !== project.id || !attachment) fail(404, 'SMS_MEDIA_NOT_FOUND', 'This SMS attachment was not found in the project.');
      await context.assertIntegrationSettings();
      if (entry.account_sid !== env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) fail(409, 'SMS_CONNECTION_CHANGED', 'The Twilio account changed. Restore its connection before downloading this attachment.');
      const target = new URL(attachment.url), expected = `/2010-04-01/Accounts/${entry.account_sid}/Messages/${entry.provider_id}/Media/`;
      if (target.origin !== 'https://api.twilio.com' || target.username || target.password || !target.pathname.startsWith(expected) || !sid(target.pathname.slice(expected.length), 'ME') || target.search || target.hash) fail(502, 'INVALID_SMS_MEDIA', 'The stored SMS attachment is outside its verified Twilio message.');
      const maximum = 20 * 1024 * 1024, signal = AbortSignal.timeout(15000);
      let response: Response | undefined;
      try {
        response = await fetch(target, { headers: { Authorization: 'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64') }, redirect: 'manual', signal });
        await context.assertIntegrationSettings();
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = new URL(response.headers.get('location') || '', target);
          if (location.origin !== 'https://mms.twiliocdn.com' || location.username || location.password) fail(502, 'INVALID_SMS_MEDIA', 'Twilio returned an unsupported attachment location.');
          await response.body?.cancel();
          response = await fetch(location, { redirect: 'error', signal });
          await context.assertIntegrationSettings();
        }
        if (!response.ok || response.headers.get('content-type')?.split(';')[0].toLowerCase() !== attachment.contentType.toLowerCase() || Number(response.headers.get('content-length') || 0) > maximum) fail(502, 'SMS_MEDIA_UNAVAILABLE', 'Twilio did not return the expected attachment within the 20 MB download limit.');
        const chunks: any[] = []; let size = 0;
        for await (const chunk of response.body || []) { size += chunk.length; if (size > maximum) fail(502, 'SMS_MEDIA_UNAVAILABLE', 'This SMS attachment exceeds the 20 MB download limit.'); chunks.push(chunk); }
        await context.assertIntegrationSettings();
        const extension = attachment.contentType.split('/')[1].replace(/[^a-z0-9.+-]/gi, '').slice(0, 80), bytes = Buffer.concat(chunks);
        context.res.writeHead(200, { 'Content-Type': attachment.contentType, 'Content-Disposition': `attachment; filename="sms-attachment.${extension}"`, 'Content-Length': bytes.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); context.res.end(bytes);
      } catch (error: any) {
        response?.body?.cancel().catch(() => {});
        if (error?.status) throw error;
        fail(502, 'SMS_MEDIA_UNAVAILABLE', 'The SMS attachment could not be downloaded from Twilio. Try again later.');
      }
      return true;
    }
    const match = path.match(/^\/conversations\/([\w-]+)\/(messages|reply)$/);
    if (!['/status', '/conversations'].includes(path) && !match) return false;
    if (path === '/status' && req.method === 'GET') { send(200, { configured: Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && (env.TWILIO_FROM_NUMBER || env.TWILIO_MESSAGING_SERVICE_SID)), publicCallbacks: appUrl.startsWith('https://'), callbackUrl: `${appUrl}/api/webhooks/twilio/inbound/${encodeURIComponent(project.id)}`, legacyCallbackUrl: `${appUrl}/api/webhooks/twilio/inbound` }); return true; }
    if (path === '/conversations' && req.method === 'GET') {
      const rows = await resultRows(db.execute(sql`SELECT c.*, max(m.sequence) AS last_sequence FROM sms_conversations c JOIN sms_messages m ON m.conversation_id = c.id WHERE c.project_id = ${project.id} GROUP BY c.id HAVING max(m.sequence) < ${page(url)} ORDER BY last_sequence DESC LIMIT 101`)), conversations = [];
      for (const row of rows.slice(0, 100)) conversations.push(await conversationView(row));
      send(200, { conversations, pagination: { hasMore: rows.length > 100, nextCursor: rows.length > 100 ? String(rows[99].last_sequence) : null } }); return true;
    }
    if (!match) return false;
    const row = await find(project.id, match[1]);
    if (match[2] === 'messages' && req.method === 'GET') {
      const rows = await resultRows(db.execute(sql`SELECT sequence, data FROM sms_messages WHERE project_id = ${project.id} AND conversation_id = ${row.id} AND sequence < ${page(url)} ORDER BY sequence DESC LIMIT 101`));
      send(200, { conversation: await conversationView(row), messages: rows.slice(0, 100).map((item: any) => item.data), pagination: { hasMore: rows.length > 100, nextCursor: rows.length > 100 ? String(rows[99].sequence) : null } }); return true;
    }
    if (match[2] !== 'reply' || req.method !== 'POST') return false;
    if (!['owner', 'admin', 'editor'].includes(role)) fail(403, 'SMS_WRITE_REQUIRED', 'Editing permission is required to reply.');
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'message') || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 1600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.message)) fail(400, 'INVALID_SMS_REPLY', 'Enter one SMS reply of at most 1600 characters.');
    const assertMapping = async () => {
      await context.assertIntegrationSettings();
      if (row.account_sid !== env.TWILIO_ACCOUNT_SID || row.service_sid !== (env.TWILIO_MESSAGING_SERVICE_SID || '') || !row.service_sid && row.sender !== env.TWILIO_FROM_NUMBER) fail(409, 'SMS_CONNECTION_CHANGED', 'The Twilio sender changed. Review its connection before replying.');
      if (await suppression(project.id, row.recipient)) fail(409, 'SMS_RECIPIENT_SUPPRESSED', 'This recipient opted out or was suppressed. Further SMS replies are blocked.');
    };
    await assertMapping();
    const outcome = await operation(context, async () => {
      await assertMapping(); const id = randomUUID(), message = { id, providerId: null, conversationId: row.id, direction: 'outgoing', message: body.message, senderId: row.sender, recipient: row.recipient, createdAt: new Date().toISOString(), status: 'sending', deliveryStatus: 'sending', attachments: [] };
      // Row lock: the conversation's lastMessage is updated from its current data, not the copy read before the send.
      await db.transaction(async tx => insertMessage(tx, (await resultRows(tx.execute(sql`SELECT * FROM sms_conversations WHERE id = ${row.id} FOR UPDATE`)))[0], message));
      try {
        const receipt: any = await sendSmsReply({ env: { ...env }, sender: row.sender, recipient: row.recipient, message: body.message, appUrl, callbackUrl: `${appUrl}/api/webhooks/twilio/status/${id}`, assertMapping });
        const latest = await changeMessage(id, latest => {
          if (latest.providerId && latest.providerId !== receipt.providerId) fail(502, 'SMS_DELIVERY_MISMATCH', 'The SMS acknowledgement conflicts with a signed callback.', true);
          latest.providerId = receipt.providerId; latest.status = nextDeliveryStatus(latest.status, receipt.status); latest.deliveryStatus = latest.status;
        });
        if (receipt.errorCode === '21610') await contacts.suppressSmsGlobally(row.recipient, 'Recipient opted out');
        return { sent: true, conversation: await conversationView(await find(project.id, row.id)), message: latest };
      } catch (error: any) { if (error.providerCode === 21610) await contacts.suppressSmsGlobally(row.recipient, 'Recipient opted out'); await changeMessage(id, latest => { if (latest.providerId) return false; latest.status = error.uncertain || !(error instanceof IntegrationError) ? 'uncertain' : 'failed'; latest.deliveryStatus = latest.status; }); throw error; }
    });
    await context.assertIntegrationSettings(); send(outcome.status, outcome.data); return true;
  }
  let recovered: Promise<void> | undefined;
  // A reply whose send was in flight when the process stopped is never retried. Runs once, before this process receives, records or sends SMS.
  function recovery() {
    return recovered ??= (async () => {
      for (const { id } of await resultRows(db.execute(sql`SELECT id FROM sms_messages WHERE data->>'status' = 'sending' ORDER BY sequence`))) await changeMessage(id, message => { if (message.status !== 'sending') return false; message.status = 'uncertain'; message.deliveryStatus = 'uncertain'; });
    })().catch(error => { recovered = undefined; throw error; });
  }
  return { handle, receiveVerified, receiveStatus, recordOutbound };
}
