import { resolveVariant, type SocialPost } from './social-posts.ts';

export interface PostScheduleEntry<T> { id: string; post: T; scheduledAt: string; content: string; platform: string; accountId?: string }
type ScheduledPost = SocialPost & { id: string };
type AccountReference = { _id?: unknown; id?: unknown; platform?: string; [key: string]: any };

// Keep the parent entry for ordinary posts; account customizations need their own dated copies.
export function postScheduleEntries<T extends ScheduledPost>(post: T, accounts: AccountReference[] = []): PostScheduleEntry<T>[] {
  const selected: string[] = [...new Set<string>(Array.isArray(post.accounts) ? post.accounts : Object.keys(post.accountOverrides || {}))];
  const customized = selected.some(id => post.accountOverrides?.[id]);
  const copies = customized ? selected.map(accountId => {
    const platform: string = post.accountOverrides?.[accountId]?.platform || accounts.find(account => String(account._id || account.id) === accountId)?.platform || post.providerResults?.find((target: any) => String(target.accountId?._id || target.accountId) === accountId)?.platform || (post.platforms?.length === 1 ? post.platforms[0] : '');
    const copy = resolveVariant(post, platform, [], accountId);
    return { id: `${post.id}:${accountId}`, post, accountId, platform, content: platform ? copy.content : '', scheduledAt: copy.scheduledAt || post.scheduledAt };
  }) : [{ id: post.id, post, platform: post.platforms?.[0] || '', content: post.content || '', scheduledAt: post.scheduledAt }];
  return copies.filter((copy): copy is PostScheduleEntry<T> => typeof copy.scheduledAt === 'string' && Number.isFinite(Date.parse(copy.scheduledAt)));
}
