export interface MediaItem { type: 'image' | 'video' | 'gif' | 'document'; url: string; width?: number; height?: number; duration?: number; size?: number; bytes?: number; mimeType?: string; altText?: string; title?: string; filename?: string; thumbnail?: string; instagramThumbnail?: string; subtitles?: { url: string; language: string }[] }
export interface PlatformVariant { content?: string; mediaItems?: MediaItem[]; assetId?: string; options?: Record<string, any> }
export interface AccountVariant extends PlatformVariant { platform: string; scheduledAt?: string }
export interface SocialPost { content?: string; mediaItems?: MediaItem[] | null; assetId?: string; platformOverrides?: Record<string, PlatformVariant>; accountOverrides?: Record<string, AccountVariant>; [key: string]: any }
export interface ResolvedVariant { platform: string; content: string; mediaItems: MediaItem[]; options: Record<string, any>; assetId?: string; scheduledAt?: string }
export interface PlatformOption { key: string; label: string; type: 'text' | 'textarea' | 'boolean' | 'number' | 'select' | 'string-list' | 'json'; values?: (string | number)[]; maxLength?: number; min?: number; max?: number; help?: string; schema: Record<string, any> }
export interface PlatformRule { label: string; captionLimit: number; mediaTypes: string[]; minMedia: number; maxMedia: number; supported: boolean; notice?: string; options: PlatformOption[] }
export interface RestrictionIssue { platform: string; field: string; message: string }
export const PLATFORM_RULES: Record<string, PlatformRule>;
export function publicMediaUrl(value: string): string;
export function normalizeMediaItems(items: unknown): MediaItem[];
export function wireMediaItems(items: unknown): MediaItem[];
export function normalizePlatformOptions(platform: string, options: unknown, config?: { required?: boolean }): Record<string, any>;
export function normalizePostTags(tags?: unknown, config?: { preserve?: boolean }): string[];
export function normalizePostVariants(post: SocialPost, config?: { strict?: boolean }): Record<string, PlatformVariant>;
export function normalizeAccountVariants(post: SocialPost): Record<string, AccountVariant>;
export function validPostInstant(value: unknown): boolean;
export function assertAccountSchedules(post: SocialPost, config?: { publishNow?: boolean; now?: number }): void;
export function resolveVariant(post: SocialPost, platform: string, assets?: any[], accountId?: string): ResolvedVariant;
export function assetDeliveryIssue(asset: any, now?: number): string;
export function providerPostMediaUrls(post: any): Set<string>;
export function buildPlatformEntry(post: SocialPost, platform: string, accountId: string, assets?: any[]): { platform: string; accountId: string; customContent?: string; customMedia?: MediaItem[]; platformSpecificData?: Record<string, any>; scheduledFor?: string };
export function countCaption(content: string, platform: string): number;
export function captionLimitForVariant(variant: ResolvedVariant): number;
export function validatePostForPlatforms(post: SocialPost, platforms: string[], config?: { assets?: any[]; requireMediaMetadata?: boolean; accountId?: string; now?: number; providerOwnedMediaUrls?: Set<string> }): { valid: boolean; errors: RestrictionIssue[]; warnings: RestrictionIssue[]; variants: Record<string, ResolvedVariant> };
