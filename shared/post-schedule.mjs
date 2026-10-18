import { resolveVariant } from './social-posts.mjs';

// Keep the parent entry for ordinary posts; account customizations need their own dated copies.
export function postScheduleEntries(post, accounts = []) {
  const selected = [...new Set(Array.isArray(post.accounts) ? post.accounts : Object.keys(post.accountOverrides || {}))];
  const customized = selected.some(id => post.accountOverrides?.[id]);
  const copies = customized ? selected.map(accountId => {
    const platform = post.accountOverrides?.[accountId]?.platform || accounts.find(account => String(account._id || account.id) === accountId)?.platform || post.providerResults?.find(target => String(target.accountId?._id || target.accountId) === accountId)?.platform || (post.platforms?.length === 1 ? post.platforms[0] : '');
    const copy = resolveVariant(post, platform, [], accountId);
    return { id: `${post.id}:${accountId}`, post, accountId, platform, content: platform ? copy.content : '', scheduledAt: copy.scheduledAt || post.scheduledAt };
  }) : [{ id: post.id, post, platform: post.platforms?.[0] || '', content: post.content || '', scheduledAt: post.scheduledAt }];
  return copies.filter(copy => typeof copy.scheduledAt === 'string' && Number.isFinite(Date.parse(copy.scheduledAt)));
}
