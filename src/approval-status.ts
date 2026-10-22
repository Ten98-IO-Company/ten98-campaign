// The project approvals summary (GET /projects/:id/approvals/summary): read once per state load, no provider calls.
export type ApprovalSummary = { requireApproval: boolean; pending: number; statuses: Record<string, string>; pendingAdSpend?: number };

export const approvalLabels: Record<string, string> = { not_requested: 'Approval not requested', pending: 'Awaiting approval', approved: 'Approved', rejected: 'Changes requested', stale: 'Changed since approval', submitted: 'Submitted to provider' };

const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
export function readableApprovalSummary(value: any): value is ApprovalSummary {
  return !!value && typeof value.requireApproval === 'boolean' && count(value.pending) && (value.pendingAdSpend === undefined || count(value.pendingAdSpend)) && !!value.statuses && typeof value.statuses === 'object' && !Array.isArray(value.statuses);
}

// The sidebar Approvals badge: pending post reviews plus pending ad spend reviews, with a spoken description of both.
export function approvalBadge(summary: ApprovalSummary | null | undefined) {
  const posts = summary?.pending || 0, spend = summary?.pendingAdSpend || 0;
  if (!posts && !spend) return null;
  const parts = [posts && `${posts} post${posts === 1 ? '' : 's'}`, spend && `${spend} ad spend change${spend === 1 ? '' : 's'}`].filter(Boolean);
  return { count: posts + spend, label: `${parts.join(' and ')} awaiting review` };
}

// Mirrors the server: with approval required only 'approved' publishes ('stale' is PUBLISHING_APPROVAL_STALE, the rest
// PUBLISHING_APPROVAL_REQUIRED). Without required approval, or without a readable summary, the card keeps its actions.
export function approvalGate(summary: ApprovalSummary | null | undefined, postId: string) {
  if (!summary?.requireApproval) return null;
  const status = summary.statuses[postId] || 'not_requested';
  const reason = status === 'approved' ? '' : status === 'stale' ? 'This post changed after it was approved. Request a new review before publishing.' : status === 'pending' ? 'This post is waiting for an owner or administrator to approve it.' : status === 'rejected' ? 'Changes were requested. Edit the post and request another review.' : 'This project requires approval before publishing. Request a review first.';
  return { status, label: approvalLabels[status] || status, publishable: status === 'approved', reason };
}

// Ad spend approval (council decision ten98-code-system#35, Q1): the gated actions as the server names them, in plain words.
const adSpendActions: Record<string, string> = {
  'ads/status': 'Activate campaign', 'ads/ad-status': 'Activate ad', 'ads/adset-status': 'Activate ad set', 'ads/adset-budget': 'Raise ad set budget', 'ads/campaign-budget': 'Raise campaign budget',
  'google-native/campaign-status': 'Enable Google Shopping campaign', 'google-native/campaign-budget': 'Raise Google Shopping daily budget',
  'microsoft/campaign-status': 'Activate Microsoft search campaign', 'microsoft/campaign-budget': 'Raise Microsoft search daily budget',
};
export const adSpendActionLabel = (action: string) => adSpendActions[action] || action;
const adPlatforms: Record<string, string> = { facebook: 'Facebook', instagram: 'Instagram', google: 'Google Ads', microsoft: 'Microsoft Advertising', linkedin: 'LinkedIn', tiktok: 'TikTok', pinterest: 'Pinterest', twitter: 'X', reddit: 'Reddit', snapchat: 'Snapchat', openai: 'OpenAI' };
export const adSpendPlatformLabel = (platform: string) => adPlatforms[platform] || platform;
// Review amounts are minor units of the currency (cents for USD, fils for AED); null is a budget the server could not read.
export function formatMinorUnits(amount: unknown, currency: unknown) {
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || typeof currency !== 'string') return 'Not available';
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
    return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount / 10 ** digits);
  } catch { return `${amount} minor units of ${currency}`; }
}

// A refused spend change, as a gated provider write reports it. For a required or mismatched approval the server has
// already opened a review of the exact change; an amount it cannot read exactly cannot be approved in Campaign at all.
export type AdSpendBlock = { code: string; title: string; text: string; review: boolean };
export function adSpendBlock(failure: unknown): AdSpendBlock | null {
  const code = (failure as { code?: unknown } | null)?.code;
  if (code === 'AD_SPEND_APPROVAL_REQUIRED') return { code, review: true, title: 'Sent for approval', text: 'This project requires approval before ads start delivery or budgets go up, so nothing was sent to the provider. A review of this exact change is waiting in Approvals. After an owner or administrator approves it, make the same change again to send it.' };
  if (code === 'AD_SPEND_APPROVAL_MISMATCH') return { code, review: true, title: 'This change differs from the approved one', text: 'An approved spend change exists, but its amount, currency, platform, campaign or action differs from this change, so nothing was sent. A review of this exact change was requested in Approvals.' };
  if (code === 'AD_SPEND_AMOUNT_UNAVAILABLE') return { code, review: false, title: 'The amount cannot be checked exactly', text: 'The budget or currency of this change could not be read exactly, so it cannot be matched to an approval and nothing was sent. Make this change in the provider’s own dashboard.' };
  return null;
}
