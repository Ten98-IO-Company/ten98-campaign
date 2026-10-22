// The project approvals summary (GET /projects/:id/approvals/summary): read once per state load, no provider calls.
export type ApprovalSummary = { requireApproval: boolean; pending: number; statuses: Record<string, string> };

export const approvalLabels: Record<string, string> = { not_requested: 'Approval not requested', pending: 'Awaiting approval', approved: 'Approved', rejected: 'Changes requested', stale: 'Changed since approval', submitted: 'Submitted to provider' };

export function readableApprovalSummary(value: any): value is ApprovalSummary {
  return !!value && typeof value.requireApproval === 'boolean' && Number.isSafeInteger(value.pending) && value.pending >= 0 && !!value.statuses && typeof value.statuses === 'object' && !Array.isArray(value.statuses);
}

// Mirrors the server: with approval required only 'approved' publishes ('stale' is PUBLISHING_APPROVAL_STALE, the rest
// PUBLISHING_APPROVAL_REQUIRED). Without required approval, or without a readable summary, the card keeps its actions.
export function approvalGate(summary: ApprovalSummary | null | undefined, postId: string) {
  if (!summary?.requireApproval) return null;
  const status = summary.statuses[postId] || 'not_requested';
  const reason = status === 'approved' ? '' : status === 'stale' ? 'This post changed after it was approved. Request a new review before publishing.' : status === 'pending' ? 'This post is waiting for an owner or administrator to approve it.' : status === 'rejected' ? 'Changes were requested. Edit the post and request another review.' : 'This project requires approval before publishing. Request a review first.';
  return { status, label: approvalLabels[status] || status, publishable: status === 'approved', reason };
}
