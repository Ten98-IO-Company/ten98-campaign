export interface PostScheduleEntry<T> { id: string; post: T; scheduledAt: string; content: string; platform: string; accountId?: string }
export function postScheduleEntries<T extends { id: string; [key: string]: any }>(post: T, accounts?: { [key: string]: any }[]): PostScheduleEntry<T>[];
