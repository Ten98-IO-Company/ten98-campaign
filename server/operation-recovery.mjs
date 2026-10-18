import { randomUUID } from 'node:crypto';
import { IntegrationError, operation } from './integrations.mjs';
import { transaction } from './database.mjs';

const initialized = new WeakSet(), fail = (status, code, message) => { throw new IntegrationError(status, code, message); };
function initialize(db) {
  operation.runId ||= randomUUID(); operation.active ||= new WeakMap();
  if (initialized.has(db)) return;
  db.exec(`CREATE TABLE IF NOT EXISTS integration_operations(id TEXT PRIMARY KEY,project_id TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,status TEXT NOT NULL,response TEXT,http_status INTEGER,created_at TEXT NOT NULL,action_path TEXT NOT NULL DEFAULT '',run_id TEXT NOT NULL DEFAULT '',UNIQUE(project_id,request_key));
    CREATE TABLE IF NOT EXISTS integration_operation_reviews(operation_id TEXT PRIMARY KEY REFERENCES integration_operations(id),project_id TEXT NOT NULL,reviewer_id TEXT NOT NULL,resolution TEXT NOT NULL CHECK(resolution IN ('not_applied','applied')),note TEXT NOT NULL,reference TEXT NOT NULL,reviewed_at TEXT NOT NULL);`);
  const columns = new Set(db.prepare('PRAGMA table_info(integration_operations)').all().map(column => column.name));
  for (const name of ['action_path', 'run_id']) if (!columns.has(name)) db.exec(`ALTER TABLE integration_operations ADD COLUMN ${name} TEXT NOT NULL DEFAULT ''`);
  initialized.add(db);
}
function eligibility(db, row) {
  if (!['pending', 'uncertain'].includes(row.status)) return { canReview: false, reason: row.status.startsWith('reviewed-') ? 'This review is final.' : 'Only unconfirmed provider outcomes can be reviewed.' };
  if (operation.active.get(db)?.has(row.id)) return { canReview: false, reason: 'This action is still running. Wait for its receipt before reviewing it.' };
  if (row.status === 'pending' && row.run_id === operation.runId && Date.now() - Date.parse(row.created_at) < 10 * 60000) return { canReview: false, reason: 'Wait ten minutes before reviewing an interrupted request from this server session.' };
  return { canReview: true, reason: '' };
}
const reviewView = row => row ? { resolution: row.resolution, note: row.note, reference: row.reference, reviewerId: row.reviewer_id, reviewedAt: row.reviewed_at } : null;
function safeAction(value) { return typeof value === 'string' && /^(POST|PUT|PATCH|DELETE|GET) \/[a-zA-Z/:_-]{1,250}$/.test(value) ? value : 'Earlier provider action'; }
function view(db, row) {
  return { id: row.id, action: safeAction(row.action_path), status: row.status, createdAt: row.created_at, ...eligibility(db, row), error: ['pending', 'uncertain'].includes(row.status) ? { code: 'OPERATION_UNCERTAIN', message: 'The provider outcome has not been confirmed.' } : null, review: reviewView(db.prepare('SELECT * FROM integration_operation_reviews WHERE operation_id=? AND project_id=?').get(row.id, row.project_id)) };
}

export async function handleOperationRecovery(context) {
  const { req, url, body = {}, project, role, user, db, send } = context;
  const prefix = `/api/projects/${encodeURIComponent(project.id)}/operations`;
  if (url.pathname !== prefix && !url.pathname.startsWith(prefix + '/')) return false;
  if (!user?.isOperator || !['owner', 'admin'].includes(role)) fail(403, 'OPERATION_REVIEW_FORBIDDEN', 'Only an instance operator with workspace administration access can review provider outcomes.');
  initialize(db);
  if (url.pathname === prefix && req.method === 'GET') {
    const rows = db.prepare("SELECT * FROM integration_operations WHERE project_id=? ORDER BY CASE WHEN status IN ('pending','uncertain') THEN 0 ELSE 1 END,created_at DESC,rowid DESC LIMIT 100").all(project.id);
    send(200, { operations: rows.map(row => view(db, row)) }); return true;
  }
  const match = url.pathname.slice(prefix.length).match(/^\/([^/]+)\/review$/);
  if (!match || req.method !== 'POST') fail(405, 'INVALID_REVIEW_ACTION', 'This operation review action is unavailable.');
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !['resolution', 'confirmChecked', 'note', 'reference'].includes(key))) fail(400, 'INVALID_REVIEW', 'Use only the fields shown in the review form.');
  if (!['not_applied', 'applied'].includes(body.resolution) || body.confirmChecked !== true) fail(400, 'PROVIDER_REVIEW_REQUIRED', 'Check the provider dashboard and explicitly confirm your review before continuing.');
  if (typeof body.note !== 'string' || body.note.trim().length < 10 || body.note.length > 2000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(body.note)) fail(400, 'REVIEW_NOTE_REQUIRED', 'Describe what you checked using 10 to 2000 characters.');
  if (body.reference !== undefined && (typeof body.reference !== 'string' || body.reference.length > 500 || /[\u0000-\u001f\u007f]/.test(body.reference))) fail(400, 'INVALID_REVIEW_REFERENCE', 'Use a provider reference of at most 500 characters.');
  const note = body.note.trim(), reference = (body.reference || '').trim();
  const reviewed = transaction(db, () => {
    const row = db.prepare('SELECT * FROM integration_operations WHERE id=? AND project_id=?').get(match[1], project.id);
    if (!row) fail(404, 'OPERATION_NOT_FOUND', 'This provider receipt was not found in this project.');
    const previous = db.prepare('SELECT * FROM integration_operation_reviews WHERE operation_id=? AND project_id=?').get(row.id, project.id);
    if (previous) {
      if (previous.reviewer_id === user.id && previous.resolution === body.resolution && previous.note === note && previous.reference === reference) return row;
      fail(409, 'REVIEW_ALREADY_RECORDED', 'This review is final and cannot be changed. Its original receipt and audit record were preserved.');
    }
    const allowed = eligibility(db, row);
    if (!allowed.canReview) fail(409, 'OPERATION_NOT_REVIEWABLE', allowed.reason);
    const status = body.resolution === 'applied' ? 'reviewed-applied' : 'reviewed-not-applied';
    db.prepare('INSERT INTO integration_operation_reviews VALUES(?,?,?,?,?,?,?)').run(row.id, project.id, user.id, body.resolution, note, reference, new Date().toISOString());
    const changed = db.prepare('UPDATE integration_operations SET status=? WHERE id=? AND project_id=? AND status=?').run(status, row.id, project.id, row.status);
    if (!changed.changes) fail(409, 'OPERATION_CHANGED', 'The provider receipt changed. Refresh it before reviewing.');
    return { ...row, status };
  });
  send(200, { operation: view(db, reviewed), message: body.resolution === 'applied' ? 'Your review was recorded. Repeating this request remains blocked. No provider or local campaign result was changed.' : 'Your review was recorded. A new manual request with a new action key is now allowed. The original action key stays closed.' });
  return true;
}
