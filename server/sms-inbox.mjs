import { createHash, randomUUID } from 'node:crypto';
import { IntegrationError, operation } from './provider-core.ts';
import { sendSmsReply } from './direct-providers.mjs';
import { createContacts } from './contacts.mjs';
import { nextDeliveryStatus } from './direct-campaigns.mjs';

const phone = value => typeof value === 'string' && /^\+[1-9]\d{6,14}$/.test(value);
const sid = (value, prefix) => typeof value === 'string' && new RegExp(`^${prefix}[a-fA-F0-9]{32}$`).test(value);
const fail = (status, code, message, uncertain = false) => { throw new IntegrationError(status, code, message, uncertain); };
const digest = value => createHash('sha256').update(value).digest('hex');
const stopped = form => form.get('OptOutType') === 'STOP' || /^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT|REVOKE|OPT OUT)$/i.test((form.get('Body') || '').trim());
const statuses = new Set(['accepted', 'queued', 'sending', 'sent', 'delivered', 'failed', 'undelivered', 'cancelled']);

export function createSmsInbox({ db, env, appUrl, contacts = createContacts({ db }) }) {
  db.exec(`CREATE TABLE IF NOT EXISTS sms_conversations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,account_sid TEXT NOT NULL,sender TEXT NOT NULL,recipient TEXT NOT NULL,service_sid TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(project_id,account_sid,sender,recipient));
    CREATE TABLE IF NOT EXISTS sms_messages(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,conversation_id TEXT NOT NULL REFERENCES sms_conversations(id) ON DELETE CASCADE,account_sid TEXT NOT NULL,provider_id TEXT,data TEXT NOT NULL,UNIQUE(account_sid,provider_id));
    CREATE INDEX IF NOT EXISTS sms_message_scope ON sms_messages(project_id,conversation_id,sequence);
    CREATE TABLE IF NOT EXISTS sms_inbound_receipts(account_sid TEXT NOT NULL,provider_id TEXT NOT NULL,body_hash TEXT NOT NULL,project_id TEXT,status TEXT NOT NULL,PRIMARY KEY(account_sid,provider_id));`);
  const atomic = run => { db.exec('SAVEPOINT sms_inbox'); try { const value = run(); db.exec('RELEASE SAVEPOINT sms_inbox'); return value; } catch (error) { db.exec('ROLLBACK TO SAVEPOINT sms_inbox; RELEASE SAVEPOINT sms_inbox'); throw error; } };
  const find = (projectId, id) => { const row = db.prepare('SELECT * FROM sms_conversations WHERE project_id=? AND id=?').get(projectId, id); if (!row) fail(404, 'SMS_CONVERSATION_NOT_FOUND', 'This SMS conversation was not found in the project.'); return row; };
  const readMessage = id => { const row = db.prepare('SELECT * FROM sms_messages WHERE id=?').get(id); return row ? { ...row, record: JSON.parse(row.data) } : null; };
  const putMessage = record => { db.prepare('UPDATE sms_messages SET provider_id=?,data=? WHERE id=?').run(record.providerId || null, JSON.stringify(record), record.id); return record; };
  const suppression = (projectId, recipient) => contacts.smsSuppression(recipient) || db.prepare("SELECT reason FROM direct_contact_suppressions WHERE project_id=? AND channel='sms' AND target_hash=?").get(projectId, digest(recipient));
  function conversationView(row) {
    const data = JSON.parse(row.data), contact = contacts.list(row.project_id).find(item => item.phone === row.recipient), block = suppression(row.project_id, row.recipient);
    return { ...data, id: row.id, projectId: row.project_id, platform: 'sms', provider: 'twilio', sender: row.sender, recipient: row.recipient, participantId: row.recipient, participantName: contact?.name || row.recipient, ...(contact ? { contactId: contact.id } : {}), blocked: Boolean(block), blockedReason: block?.reason || '' };
  }
  function conversation(projectId, accountSid, sender, recipient, serviceSid = '') {
    let row = db.prepare('SELECT * FROM sms_conversations WHERE project_id=? AND account_sid=? AND sender=? AND recipient=?').get(projectId, accountSid, sender, recipient);
    if (!row) { const id = randomUUID(), data = { createdAt: new Date().toISOString(), lastMessage: '', lastMessageAt: null }; db.prepare('INSERT INTO sms_conversations VALUES(?,?,?,?,?,?,?)').run(id, projectId, accountSid, sender, recipient, serviceSid, JSON.stringify(data)); row = find(projectId, id); }
    return row;
  }
  function insertMessage(row, message) {
    db.prepare('INSERT INTO sms_messages(id,project_id,conversation_id,account_sid,provider_id,data) VALUES(?,?,?,?,?,?)').run(message.id, row.project_id, row.id, row.account_sid, message.providerId || null, JSON.stringify(message));
    const data = JSON.parse(row.data); Object.assign(data, { lastMessage: message.message, lastMessageAt: message.createdAt }); db.prepare('UPDATE sms_conversations SET data=? WHERE id=?').run(JSON.stringify(data), row.id);
    return message;
  }
  function recordOutbound({ id, projectId, accountSid, sender, recipient, messagingServiceSid = '', providerId, message = '', status = 'accepted', campaignId }) {
    if (!sid(accountSid, 'AC') || !phone(sender) || !phone(recipient) || !sid(providerId, '(?:SM|MM)') || !db.prepare('SELECT id FROM projects WHERE id=?').get(projectId)) return;
    return atomic(() => {
      const row = conversation(projectId, accountSid, sender, recipient, messagingServiceSid), existing = readMessage(id), record = { id, providerId, conversationId: row.id, direction: 'outgoing', message, senderId: sender, recipient, createdAt: existing?.record.createdAt || new Date().toISOString(), status, deliveryStatus: status, attachments: [], ...(campaignId ? { campaignId } : {}) };
      if (row.service_sid !== messagingServiceSid) db.prepare('UPDATE sms_conversations SET service_sid=? WHERE id=?').run(messagingServiceSid, row.id);
      if (existing) { if (existing.project_id !== projectId || existing.conversation_id !== row.id || existing.record.providerId && existing.record.providerId !== providerId) fail(400, 'SMS_DELIVERY_MISMATCH', 'The SMS delivery does not match its conversation.'); record.status = nextDeliveryStatus(existing.record.status, status); record.deliveryStatus = record.status; return putMessage({ ...existing.record, ...record }); }
      return insertMessage(row, record);
    });
  }
  function receiveVerified(form, { projectId } = {}) {
    const accountSid = form.get('AccountSid'), providerId = form.get('MessageSid'), recipient = form.get('From'), sender = form.get('To'), body = form.get('Body') || '', serviceSid = form.get('MessagingServiceSid') || '';
    if (accountSid !== env.TWILIO_ACCOUNT_SID || !sid(providerId, '(?:SM|MM)') || !phone(recipient) || !phone(sender) || body.length > 1600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body) || serviceSid && !sid(serviceSid, 'MG')) fail(400, 'INVALID_SMS_MESSAGE', 'The incoming SMS identity or content is invalid.');
    const hash = digest(JSON.stringify([...form.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))), prior = db.prepare('SELECT * FROM sms_inbound_receipts WHERE account_sid=? AND provider_id=?').get(accountSid, providerId);
    if (prior) { if (prior.body_hash !== hash || projectId && prior.project_id && prior.project_id !== projectId) fail(400, 'SMS_EVENT_CONFLICT', 'This SMS delivery conflicts with its original receipt.'); if (prior.status !== 'unattributed' || !projectId) return { accepted: true, duplicate: true }; }
    else if (db.prepare('SELECT id FROM sms_messages WHERE account_sid=? AND provider_id=?').get(accountSid, providerId)) fail(400, 'SMS_EVENT_CONFLICT', 'This message identifier already belongs to another delivery.');
    const mediaCount = form.get('NumMedia') || '0'; if (!/^\d{1,2}$/.test(mediaCount) || Number(mediaCount) > 10) fail(400, 'INVALID_SMS_MEDIA', 'The incoming media count is invalid.');
    const attachments = Array.from({ length: Number(mediaCount) }, (_, index) => {
      const value = form.get('MediaUrl' + index), contentType = form.get('MediaContentType' + index) || '';
      let url; try { url = new URL(value); } catch { fail(400, 'INVALID_SMS_MEDIA', 'The incoming attachment URL is invalid.'); }
      if (url.protocol !== 'https:' || url.hostname !== 'api.twilio.com' || url.username || url.password || !url.pathname.startsWith(`/2010-04-01/Accounts/${accountSid}/Messages/${providerId}/Media/`) || !/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(contentType)) fail(400, 'INVALID_SMS_MEDIA', 'The incoming attachment is outside the verified Twilio message.');
      return { url: url.href, contentType, type: contentType.startsWith('image/') ? 'image' : contentType.startsWith('video/') ? 'video' : contentType.startsWith('audio/') ? 'audio' : 'file' };
    });
    // STOP takes effect even if retaining the optional conversation subsequently fails.
    if (stopped(form)) contacts.suppressSmsGlobally(recipient, 'Recipient opted out');
    const candidates = db.prepare("SELECT DISTINCT c.project_id FROM sms_conversations c JOIN sms_messages m ON m.conversation_id=c.id WHERE c.account_sid=? AND c.sender=? AND c.recipient=? AND (?='' OR c.service_sid=?) AND m.provider_id IS NOT NULL AND json_extract(m.data,'$.direction')='outgoing' AND (? IS NULL OR c.project_id=?)").all(accountSid, sender, recipient, serviceSid, serviceSid, projectId || null, projectId || null);
    return atomic(() => {
      const target = candidates.length === 1 ? candidates[0].project_id : null;
      db.prepare('INSERT INTO sms_inbound_receipts VALUES(?,?,?,?,?) ON CONFLICT(account_sid,provider_id) DO UPDATE SET project_id=excluded.project_id,status=excluded.status').run(accountSid, providerId, hash, target, target ? 'stored' : 'unattributed');
      if (!target) return { accepted: true, unattributed: true };
      const row = conversation(target, accountSid, sender, recipient, serviceSid), record = { id: randomUUID(), providerId, conversationId: row.id, direction: 'incoming', message: body, senderId: recipient, recipient: sender, createdAt: new Date().toISOString(), status: 'received', deliveryStatus: 'received', attachments };
      insertMessage(row, record); return { accepted: true };
    });
  }
  function receiveStatus(form, id) {
    const entry = readMessage(id); if (!entry) return false;
    const row = find(entry.project_id, entry.conversation_id), providerId = form.get('MessageSid'), status = form.get('MessageStatus') === 'canceled' ? 'cancelled' : form.get('MessageStatus');
    if (entry.record.direction !== 'outgoing' || form.get('AccountSid') !== row.account_sid || form.get('To') !== row.recipient || form.get('From') && form.get('From') !== row.sender || !sid(providerId, '(?:SM|MM)') || entry.record.providerId && entry.record.providerId !== providerId || !statuses.has(status)) fail(400, 'SMS_DELIVERY_MISMATCH', 'The SMS callback does not match this conversation.');
    entry.record.providerId = providerId; entry.record.status = nextDeliveryStatus(entry.record.status, status); entry.record.deliveryStatus = entry.record.status; if (form.get('ErrorCode')) entry.record.errorCode = form.get('ErrorCode').slice(0, 20); putMessage(entry.record);
    if (form.get('ErrorCode') === '21610') contacts.suppressSmsGlobally(row.recipient, 'Recipient opted out');
    return true;
  }
  const page = url => { const cursor = url.searchParams.get('cursor'); if (cursor !== null && (!/^\d{1,16}$/.test(cursor) || !Number.isSafeInteger(Number(cursor)))) fail(400, 'INVALID_SMS_CURSOR', 'Choose a valid SMS page.'); return cursor === null ? Number.MAX_SAFE_INTEGER : Number(cursor); };
  async function handle(context) {
    const { req, url, project, role, body = {}, send } = context, prefix = `/api/projects/${encodeURIComponent(project.id)}/sms-inbox`, path = url.pathname.slice(prefix.length);
    if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return false;
    const media = path.match(/^\/media\/([\w-]+)\/(\d)$/);
    if (media && req.method === 'GET') {
      const entry = readMessage(media[1]), attachment = entry?.record.attachments?.[Number(media[2])];
      if (!entry || entry.project_id !== project.id || !attachment) fail(404, 'SMS_MEDIA_NOT_FOUND', 'This SMS attachment was not found in the project.');
      context.assertIntegrationSettings();
      if (entry.account_sid !== env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) fail(409, 'SMS_CONNECTION_CHANGED', 'The Twilio account changed. Restore its connection before downloading this attachment.');
      const target = new URL(attachment.url), expected = `/2010-04-01/Accounts/${entry.account_sid}/Messages/${entry.provider_id}/Media/`;
      if (target.origin !== 'https://api.twilio.com' || target.username || target.password || !target.pathname.startsWith(expected) || !sid(target.pathname.slice(expected.length), 'ME') || target.search || target.hash) fail(502, 'INVALID_SMS_MEDIA', 'The stored SMS attachment is outside its verified Twilio message.');
      const maximum = 20 * 1024 * 1024, signal = AbortSignal.timeout(15000);
      let response;
      try {
        response = await fetch(target, { headers: { Authorization: 'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64') }, redirect: 'manual', signal });
        context.assertIntegrationSettings();
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = new URL(response.headers.get('location') || '', target);
          if (location.origin !== 'https://mms.twiliocdn.com' || location.username || location.password) fail(502, 'INVALID_SMS_MEDIA', 'Twilio returned an unsupported attachment location.');
          await response.body?.cancel();
          response = await fetch(location, { redirect: 'error', signal });
          context.assertIntegrationSettings();
        }
        if (!response.ok || response.headers.get('content-type')?.split(';')[0].toLowerCase() !== attachment.contentType.toLowerCase() || Number(response.headers.get('content-length') || 0) > maximum) fail(502, 'SMS_MEDIA_UNAVAILABLE', 'Twilio did not return the expected attachment within the 20 MB download limit.');
        const chunks = []; let size = 0;
        for await (const chunk of response.body || []) { size += chunk.length; if (size > maximum) fail(502, 'SMS_MEDIA_UNAVAILABLE', 'This SMS attachment exceeds the 20 MB download limit.'); chunks.push(chunk); }
        context.assertIntegrationSettings();
        const extension = attachment.contentType.split('/')[1].replace(/[^a-z0-9.+-]/gi, '').slice(0, 80), bytes = Buffer.concat(chunks);
        context.res.writeHead(200, { 'Content-Type': attachment.contentType, 'Content-Disposition': `attachment; filename="sms-attachment.${extension}"`, 'Content-Length': bytes.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }); context.res.end(bytes);
      } catch (error) {
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
      const rows = db.prepare('SELECT c.*,max(m.sequence) AS last_sequence FROM sms_conversations c JOIN sms_messages m ON m.conversation_id=c.id WHERE c.project_id=? GROUP BY c.id HAVING last_sequence<? ORDER BY last_sequence DESC LIMIT 101').all(project.id, page(url));
      send(200, { conversations: rows.slice(0, 100).map(conversationView), pagination: { hasMore: rows.length > 100, nextCursor: rows.length > 100 ? String(rows[99].last_sequence) : null } }); return true;
    }
    if (!match) return false;
    const row = find(project.id, match[1]);
    if (match[2] === 'messages' && req.method === 'GET') {
      const rows = db.prepare('SELECT sequence,data FROM sms_messages WHERE project_id=? AND conversation_id=? AND sequence<? ORDER BY sequence DESC LIMIT 101').all(project.id, row.id, page(url));
      send(200, { conversation: conversationView(row), messages: rows.slice(0, 100).map(item => JSON.parse(item.data)), pagination: { hasMore: rows.length > 100, nextCursor: rows.length > 100 ? String(rows[99].sequence) : null } }); return true;
    }
    if (match[2] !== 'reply' || req.method !== 'POST') return false;
    if (!['owner', 'admin', 'editor'].includes(role)) fail(403, 'SMS_WRITE_REQUIRED', 'Editing permission is required to reply.');
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'message') || typeof body.message !== 'string' || !body.message.trim() || body.message.length > 1600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(body.message)) fail(400, 'INVALID_SMS_REPLY', 'Enter one SMS reply of at most 1600 characters.');
    const assertMapping = () => {
      context.assertIntegrationSettings();
      if (row.account_sid !== env.TWILIO_ACCOUNT_SID || row.service_sid !== (env.TWILIO_MESSAGING_SERVICE_SID || '') || !row.service_sid && row.sender !== env.TWILIO_FROM_NUMBER) fail(409, 'SMS_CONNECTION_CHANGED', 'The Twilio sender changed. Review its connection before replying.');
      if (suppression(project.id, row.recipient)) fail(409, 'SMS_RECIPIENT_SUPPRESSED', 'This recipient opted out or was suppressed. Further SMS replies are blocked.');
    };
    assertMapping();
    const outcome = await operation(context, async () => {
      assertMapping(); const id = randomUUID(), message = { id, providerId: null, conversationId: row.id, direction: 'outgoing', message: body.message, senderId: row.sender, recipient: row.recipient, createdAt: new Date().toISOString(), status: 'sending', deliveryStatus: 'sending', attachments: [] };
      atomic(() => insertMessage(row, message));
      try {
        const receipt = await sendSmsReply({ env: { ...env }, sender: row.sender, recipient: row.recipient, message: body.message, appUrl, callbackUrl: `${appUrl}/api/webhooks/twilio/status/${id}`, assertMapping }), latest = readMessage(id).record;
        if (latest.providerId && latest.providerId !== receipt.providerId) fail(502, 'SMS_DELIVERY_MISMATCH', 'The SMS acknowledgement conflicts with a signed callback.', true);
        latest.providerId = receipt.providerId; latest.status = nextDeliveryStatus(latest.status, receipt.status); latest.deliveryStatus = latest.status; putMessage(latest);
        if (receipt.errorCode === '21610') contacts.suppressSmsGlobally(row.recipient, 'Recipient opted out');
        return { sent: true, conversation: conversationView(find(project.id, row.id)), message: latest };
      } catch (error) { if (error.providerCode === 21610) contacts.suppressSmsGlobally(row.recipient, 'Recipient opted out'); const latest = readMessage(id).record; if (!latest.providerId) { latest.status = error.uncertain || !(error instanceof IntegrationError) ? 'uncertain' : 'failed'; latest.deliveryStatus = latest.status; putMessage(latest); } throw error; }
    });
    context.assertIntegrationSettings(); send(outcome.status, outcome.data); return true;
  }
  for (const entry of db.prepare('SELECT data FROM sms_messages').all()) { const message = JSON.parse(entry.data); if (message.status === 'sending') { message.status = 'uncertain'; message.deliveryStatus = 'uncertain'; putMessage(message); } }
  return { handle, receiveVerified, receiveStatus, recordOutbound };
}
