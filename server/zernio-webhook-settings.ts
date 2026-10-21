import { createHash } from 'node:crypto';
import { IntegrationError, claimFence, fail, operation, releaseFence, reportObject as object } from './provider-core.ts';
import type { OperationContext, ZernioApi } from './provider-core.ts';
import { supportedWebhookEvents } from './webhooks.ts';

const text = (value: any, max: number) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f]/.test(value);
const id = (value: any) => typeof value === 'string' && /^[a-f\d]{24}$/i.test(value);
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const version = (row: any) => createHash('sha256').update(JSON.stringify(row)).digest('hex');

async function endpoints(api: ZernioApi, callback: string, profileId: string) {
  const allowed = new Set(supportedWebhookEvents);
  const response = await api('/webhooks/settings');
  if (!Array.isArray(response.webhooks) || response.webhooks.length > 50) fail(502, 'INVALID_WEBHOOK_RESPONSE', 'Zernio did not return a readable webhook list.');
  const rows = response.webhooks.filter((row: any) => row?.url === callback && Array.isArray(row.profileIds) && same(row.profileIds, [profileId])).map((row: any) => {
    if (!id(row._id) || !text(row.name, 50) || typeof row.isActive !== 'boolean' || !Array.isArray(row.events) || !row.events.length || row.events.length > 100 || row.events.some((event: any) => !text(event, 100)) || new Set(row.events).size !== row.events.length || row.accountIds !== undefined && !Array.isArray(row.accountIds) || row.disabledResourceGroups !== undefined && !Array.isArray(row.disabledResourceGroups)) fail(502, 'INVALID_WEBHOOK_RESPONSE', 'Zernio returned unreadable webhook settings.');
    if ((row.accountIds || []).some((value: any) => !text(value, 200)) || (row.disabledResourceGroups || []).some((value: any) => !text(value, 100))) fail(502, 'INVALID_WEBHOOK_RESPONSE', 'Zernio returned unreadable webhook filters.');
    const result = { id: row._id, name: row.name, url: callback, profileIds: [profileId], events: [...row.events].sort(), isActive: row.isActive };
    const advanced = Boolean(row.accountIds?.length || row.customHeaders && Object.keys(row.customHeaders).length);
    return { ...result, excludedGroups: [...(row.disabledResourceGroups || [])].sort(), editable: !advanced && result.events.every((event: any) => allowed.has(event)), version: version({ ...result, accountIds: row.accountIds || [], disabledResourceGroups: row.disabledResourceGroups || [], customHeaders: row.customHeaders || {} }), failureCount: Number.isSafeInteger(row.failureCount) && row.failureCount >= 0 ? row.failureCount : null, lastFiredAt: typeof row.lastFiredAt === 'string' && Number.isFinite(Date.parse(row.lastFiredAt)) ? row.lastFiredAt : null };
  });
  if (new Set(rows.map((row: any) => row.id)).size !== rows.length) fail(502, 'INVALID_WEBHOOK_RESPONSE', 'Zernio returned duplicate webhook settings.');
  return rows;
}

export async function handleWebhookSettings(context: OperationContext & { body: any }, api: ZernioApi, profileId: string, action: string) {
  const { req, body, send, project, db, config, user, role, url } = context;
  const allowed = new Set(supportedWebhookEvents);
  if (!user?.isOperator || !['owner', 'admin'].includes(role)) fail(403, 'OPERATOR_REQUIRED', 'An app administrator who manages this workspace must manage provider webhooks.');
  let callback: string;
  try { const origin = new URL(config.appUrl); if (origin.protocol !== 'https:' || origin.username || origin.password) throw new Error(); callback = new URL('/api/webhooks/zernio', origin.origin).href; } catch { fail(409, 'PUBLIC_APP_URL_REQUIRED', 'Configure the public HTTPS app address before setting up webhooks.'); }
  const read = () => endpoints(api, callback, profileId);
  if (!action && req.method === 'GET') { send(200, { url: callback, profileId, events: supportedWebhookEvents, secretConfigured: Boolean(config.env.ZERNIO_WEBHOOK_SECRET), webhooks: await read() }); return true; }
  const match = action.match(/^([a-f\d]{24})\/(logs|update|delete|test|redeliver)$/i);
  if (match?.[2] === 'logs' && req.method === 'GET') {
    if (!(await read()).some((row: any) => row.id === match[1])) fail(404, 'WEBHOOK_NOT_FOUND', 'This project webhook is no longer available.');
    const skip = url.searchParams.get('skip') || '0'; if (!/^(0|[1-9]\d{0,4})$/.test(skip) || Number(skip) > 10000) fail(400, 'INVALID_PAGE', 'Choose a valid delivery page.');
    const result = await api('/webhooks/logs', { webhookId: match[1], skip: Number(skip), limit: 50 });
    if (!Array.isArray(result.logs) || result.logs.length > 50 || !object(result.pagination) || typeof result.pagination.hasMore !== 'boolean') fail(502, 'INVALID_WEBHOOK_LOGS', 'Zernio did not return readable delivery history.');
    const logs = result.logs.map((row: any) => {
      if (!object(row) || row.webhookId !== match[1] || !text(row.eventId, 200) || !text(row.event, 100) || !['success', 'failed'].includes(row.status) || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))) fail(502, 'INVALID_WEBHOOK_LOGS', 'Zernio returned delivery history outside this webhook.');
      return { eventId: row.eventId, event: row.event, status: row.status, createdAt: row.createdAt, test: row.test === true || row.event === 'webhook.test', statusCode: Number.isInteger(row.statusCode) && row.statusCode >= 100 && row.statusCode <= 599 ? row.statusCode : null, attemptNumber: Number.isSafeInteger(row.attemptNumber) && row.attemptNumber > 0 ? row.attemptNumber : null };
    });
    send(200, { logs, skip: Number(skip), hasMore: result.pagination.hasMore }); return true;
  }
  if (req.method !== 'POST' || action !== 'create' && !match || match?.[2] === 'logs') return false;
  const task = action === 'create' ? 'create' : match![2], webhookId = match?.[1];
  const fields = task === 'create' ? ['name', 'events', 'isActive', 'confirm'] : task === 'update' ? ['name', 'events', 'isActive', 'expectedVersion', 'confirm'] : task === 'redeliver' ? ['eventId', 'expectedVersion', 'confirm'] : ['expectedVersion', 'confirm'];
  if (!object(body) || Object.keys(body).some(key => !fields.includes(key)) || body.confirm !== true) fail(400, 'WEBHOOK_REVIEW_REQUIRED', 'Review and confirm this webhook action.');
  let settings: any;
  if (['create', 'update'].includes(task)) {
    if (!text(body.name, 50) || !Array.isArray(body.events) || !body.events.length || body.events.length > supportedWebhookEvents.length || body.events.some((event: any) => !allowed.has(event)) || new Set(body.events).size !== body.events.length || typeof body.isActive !== 'boolean') fail(400, 'INVALID_WEBHOOK_SETTINGS', 'Choose a name, supported events and delivery state.');
    if (!text(config.env.ZERNIO_WEBHOOK_SECRET, 4000) || config.env.ZERNIO_WEBHOOK_SECRET.length < 16) fail(409, 'WEBHOOK_SECRET_REQUIRED', 'Save a webhook signing secret of at least 16 characters in Zernio connection settings first.');
    settings = { name: body.name.trim(), events: [...body.events].sort(), isActive: body.isActive };
  }
  if (task !== 'create' && !/^[a-f\d]{64}$/.test(body.expectedVersion || '')) fail(400, 'WEBHOOK_REVIEW_REQUIRED', 'Refresh and review this webhook before changing it.');
  if (task === 'redeliver' && !text(body.eventId, 200)) fail(400, 'INVALID_EVENT', 'Choose a failed delivery from this webhook.');
  const resource = version({ callback, profileId });
  // A reviewed synthetic test can be deliberately run again; the shared resource fence still blocks unresolved attempts.
  const operationContext = task === 'test' ? { ...context, body: { ...body, testAttempt: req.headers['idempotency-key'] } } : context;
  const outcome = await operation(operationContext, async key => {
    if (!await claimFence(db, 'zernio_webhook_mutations', resource, project.id, key)) fail(409, 'WEBHOOK_PREVIOUS_OUTCOME_UNRESOLVED', 'Review the previous webhook action in provider outcomes before making another change.');
    let uncertain = false, dispatched = false, accepted = false;
    try {
      const before = await read(), current = before.find((row: any) => row.id === webhookId);
      if (task === 'create' && before.length) fail(409, 'WEBHOOK_EXISTS', 'This project already has a webhook for this app. Select and edit it.');
      if (task !== 'create' && (!current || current.version !== body.expectedVersion || !current.editable)) fail(409, 'WEBHOOK_CHANGED', 'The webhook changed or has advanced provider settings. Refresh it; use Zernio for advanced settings.');
      if (task === 'redeliver') {
        const response = await api('/webhooks/logs', { webhookId, eventId: body.eventId, status: 'failed', limit: 1 });
        if (!Array.isArray(response.logs) || !response.logs.some((row: any) => row.webhookId === webhookId && row.eventId === body.eventId && row.status === 'failed' && row.test !== true && row.event !== 'webhook.test')) fail(409, 'FAILED_DELIVERY_REQUIRED', 'Refresh and select a real failed delivery from this webhook.');
      }
      dispatched = true;
      const response = await api(task === 'test' ? '/webhooks/test' : task === 'redeliver' ? '/webhooks/logs/redeliver' : '/webhooks/settings', task === 'delete' ? { webhookId } : {}, task === 'delete' ? undefined : task === 'test' ? { webhookId } : task === 'redeliver' ? { webhookId, eventId: body.eventId } : { ...settings, ...(task === 'create' ? { url: callback, profileIds: [profileId], accountIds: [], disabledResourceGroups: [] } : { webhookId }), secret: config.env.ZERNIO_WEBHOOK_SECRET }, key, task === 'delete' ? 'DELETE' : task === 'update' ? 'PUT' : 'POST');
      accepted = true;
      if (response.success !== true) throw new IntegrationError(502, 'WEBHOOK_NOT_CONFIRMED', 'Zernio has not confirmed this webhook action.', true);
      if (['test', 'redeliver'].includes(task)) return { delivered: true };
      const after = await read();
      if (task === 'delete') { if (after.some((row: any) => row.id === webhookId)) throw new Error(); return { deleted: true }; }
      const savedId = response.webhook?._id, saved = after.find((row: any) => row.id === savedId);
      if (!saved || task === 'update' && savedId !== webhookId || task === 'create' && before.some((row: any) => row.id === savedId) || saved.name !== settings.name || saved.isActive !== settings.isActive || !same(saved.events, settings.events) || !saved.editable) throw new Error();
      return { webhook: saved };
    } catch (error: any) {
      uncertain = accepted || dispatched && (!(error instanceof IntegrationError) || error.uncertain);
      if (uncertain) throw new IntegrationError(409, 'WEBHOOK_NOT_CONFIRMED', 'Review the provider outcome before trying this action again.', true);
      throw error;
    } finally { if (!uncertain) await releaseFence(db, 'zernio_webhook_mutations', resource, project.id, key); }
  }, `webhook:${resource}`);
  send(outcome.status, outcome.data); return true;
}
