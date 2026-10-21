import { sql } from 'drizzle-orm';
import { bigint, boolean, check, customType, index, integer, json, pgTable, primaryKey, text, unique, uniqueIndex } from 'drizzle-orm/pg-core';

// Drizzle mirror of migrations/*.sql; tests/schema.test.mjs keeps the two in step. Property names
// equal column names so selected rows keep the snake_case shape every module already reads.
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });

// Identity, tenancy and installation (database.ts, invitations.ts)
export const installation = pgTable('installation', {
  id: integer('id').primaryKey(),
  claimed: boolean('claimed').notNull().default(false),
}, t => [
  check('installation_id_check', sql`${t.id} = 1`),
]);
export const users = pgTable('users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique('users_email_key'),
  password: text('password'),
});
export const instanceOperators = pgTable('instance_operators', {
  user_id: text('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
});
export const instanceOperatorAudit = pgTable('instance_operator_audit', {
  id: text('id').primaryKey(),
  user_id: text('user_id').notNull(),
  action: text('action').notNull(),
  source: text('source').notNull(),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
}, t => [
  check('instance_operator_audit_action_check', sql`${t.action} IN ('bootstrap','grant','revoke')`),
  check('instance_operator_audit_source_check', sql`${t.source} IN ('bootstrap','host')`),
]);
export const sessions = pgTable('sessions', {
  token: text('token').primaryKey(),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  expires_at: bigint('expires_at', { mode: 'number' }).notNull(),
});
export const workspaces = pgTable('workspaces', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
});
export const memberships = pgTable('memberships', {
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull(),
}, t => [
  check('memberships_role_check', sql`${t.role} IN ('owner','admin','editor','viewer')`),
  primaryKey({ columns: [t.workspace_id, t.user_id] }),
]);
export const projects = pgTable('projects', {
  id: text('id').primaryKey(),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  color: text('color').notNull().default('#5943ce'),
  zernio_profile_id: text('zernio_profile_id').notNull().default(''),
  drive_folder_id: text('drive_folder_id').notNull().default(''),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
});
export const records = pgTable('records', {
  id: text('id').primaryKey(),
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  collection: text('collection').notNull(),
  data: json('data').notNull(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
}, t => [
  index('records_project').on(t.project_id, t.collection, t.seq),
]);
export const activity = pgTable('activity', {
  id: text('id').primaryKey(),
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  message: text('message').notNull(),
  created_at: text('created_at').notNull(),
  sample: boolean('sample').notNull().default(false),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
}, t => [
  index('activity_project').on(t.project_id, t.seq),
]);
export const oidcFlows = pgTable('oidc_flows', {
  state: text('state').primaryKey(),
  browser: text('browser').notNull(),
  verifier: text('verifier').notNull(),
  nonce: text('nonce').notNull(),
  expires_at: bigint('expires_at', { mode: 'number' }).notNull(),
});
export const oidcReturnTargets = pgTable('oidc_return_targets', {
  state: text('state').primaryKey().references(() => oidcFlows.state, { onDelete: 'cascade' }),
  invite_hash: text('invite_hash').notNull(),
});
export const oidcIdentities = pgTable('oidc_identities', {
  issuer: text('issuer').notNull(),
  subject: text('subject').notNull(),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, t => [
  primaryKey({ columns: [t.issuer, t.subject] }),
]);
export const loginLimits = pgTable('login_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  expires_at: bigint('expires_at', { mode: 'number' }).notNull(),
});
export const workspaceInvitations = pgTable('workspace_invitations', {
  id: text('id').primaryKey(),
  workspace_id: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  email: text('email').notNull(),
  role: text('role').notNull(),
  inviter_id: text('inviter_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  token_hash: text('token_hash').notNull().unique('workspace_invitations_token_hash_key'),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
  expires_at: bigint('expires_at', { mode: 'number' }).notNull(),
  accepted_at: bigint('accepted_at', { mode: 'number' }),
  revoked_at: bigint('revoked_at', { mode: 'number' }),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
}, t => [
  check('workspace_invitations_role_check', sql`${t.role} IN ('owner','admin','editor','viewer')`),
  index('workspace_invitations_workspace').on(t.workspace_id, t.created_at),
]);

// Provider operations and recovery (provider-core.ts, operation-recovery.ts, integration-settings.ts)
export const integrationOperations = pgTable('integration_operations', {
  id: text('id').primaryKey(),
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
  request_hash: text('request_hash').notNull(),
  status: text('status').notNull(),
  response: text('response'),
  http_status: integer('http_status'),
  created_at: text('created_at').notNull(),
  action_path: text('action_path').notNull().default(''),
  run_id: text('run_id').notNull().default(''),
  resource_key: text('resource_key').notNull().default(''),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
}, t => [
  unique('integration_operations_project_id_request_key_key').on(t.project_id, t.request_key),
  index('integration_operations_resource').on(t.project_id, t.resource_key, t.status),
]);
export const integrationOperationReviews = pgTable('integration_operation_reviews', {
  operation_id: text('operation_id').primaryKey().references(() => integrationOperations.id),
  project_id: text('project_id').notNull(),
  reviewer_id: text('reviewer_id').notNull(),
  resolution: text('resolution').notNull(),
  note: text('note').notNull(),
  reference: text('reference').notNull(),
  reviewed_at: text('reviewed_at').notNull(),
}, t => [
  check('integration_operation_reviews_resolution_check', sql`${t.resolution} IN ('not_applied','applied')`),
]);
export const integrationSettings = pgTable('integration_settings', {
  provider: text('provider').primaryKey(),
  nonce: bytea('nonce').notNull(),
  ciphertext: bytea('ciphertext').notNull(),
  tag: bytea('tag').notNull(),
  updated_at: text('updated_at').notNull(),
});
export const integrationTelegramCodes = pgTable('integration_telegram_codes', {
  project_id: text('project_id').primaryKey(),
  profile_id: text('profile_id').notNull(),
  code: text('code').notNull(),
  expires_at: text('expires_at').notNull(),
});

// AI agent (agent.ts)
export const agentRuns = pgTable('agent_runs', {
  id: text('id').primaryKey(),
  project_id: text('project_id').notNull().references(() => projects.id),
  user_id: text('user_id').notNull().references(() => users.id),
  request_key: text('request_key').notNull(),
  input_hash: text('input_hash').notNull(),
  status: text('status').notNull(),
  message: text('message').notNull(),
  model: text('model').notNull(),
  response: text('response'),
  usage: json('usage').notNull(),
  error: text('error'),
  created_at: text('created_at').notNull(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
}, t => [
  unique('agent_runs_project_id_user_id_request_key_key').on(t.project_id, t.user_id, t.request_key),
]);
export const agentActions = pgTable('agent_actions', {
  id: text('id').primaryKey(),
  run_id: text('run_id').notNull().references(() => agentRuns.id),
  project_id: text('project_id').notNull(),
  user_id: text('user_id').notNull(),
  collection: text('collection').notNull(),
  data: json('data').notNull(),
  status: text('status').notNull(),
  record_id: text('record_id'),
});

// Approvals and recycling (approvals.ts, zernio-recycling.ts)
export const projectApprovalPolicy = pgTable('project_approval_policy', {
  project_id: text('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  require_approval: boolean('require_approval').notNull(),
  updated_by: text('updated_by').notNull().references(() => users.id),
  updated_at: text('updated_at').notNull(),
});
export const postApprovalReviews = pgTable('post_approval_reviews', {
  id: text('id').primaryKey(),
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  post_id: text('post_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  snapshot: text('snapshot').notNull(),
  status: text('status').notNull(),
  requested_by: text('requested_by').notNull().references(() => users.id),
  requested_at: text('requested_at').notNull(),
  reviewed_by: text('reviewed_by').references(() => users.id),
  reviewed_at: text('reviewed_at'),
  note: text('note').notNull().default(''),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
  self_approved: boolean('self_approved').notNull().default(false),
}, t => [
  check('post_approval_reviews_status_check', sql`${t.status} IN ('pending','approved','rejected')`),
  index('post_approval_reviews_post').on(t.project_id, t.post_id),
]);
export const postRecyclingReviews = pgTable('post_recycling_reviews', {
  id: text('id').primaryKey(),
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  post_id: text('post_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  snapshot: text('snapshot').notNull(),
  configuration: text('configuration').notNull(),
  reviewed_by: text('reviewed_by').notNull().references(() => users.id),
  reviewed_at: text('reviewed_at').notNull(),
}, t => [
  unique('post_recycling_reviews_project_id_post_id_fingerprint_key').on(t.project_id, t.post_id, t.fingerprint),
]);

// Calendar and native ad connections (calendar.ts, native-google-ads.ts, native-microsoft-ads.ts)
export const calendarConnections = pgTable('calendar_connections', {
  project_id: text('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  calendar_id: text('calendar_id').notNull().unique('calendar_connections_calendar_id_key'),
});
export const calendarPlanGenerations = pgTable('calendar_plan_generations', {
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  calendar_id: text('calendar_id').notNull(),
  collection: text('collection').notNull(),
  record_id: text('record_id').notNull(),
  account_id: text('account_id').notNull().default(''),
  generation: integer('generation').notNull().default(0),
  known_generation: integer('known_generation').notNull().default(-1),
}, t => [
  primaryKey({ columns: [t.project_id, t.calendar_id, t.collection, t.record_id, t.account_id] }),
]);
export const nativeGoogleConnections = pgTable('native_google_connections', {
  project_id: text('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  customer_id: text('customer_id').notNull().unique('native_google_connections_customer_id_key'),
});
export const microsoftAdConnections = pgTable('microsoft_ad_connections', {
  project_id: text('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  customer_id: text('customer_id').notNull(),
  account_id: text('account_id').notNull().unique('microsoft_ad_connections_account_id_key'),
  data: json('data').notNull(),
});
export const microsoftAdReports = pgTable('microsoft_ad_reports', {
  id: text('id').primaryKey(),
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  account_id: text('account_id').notNull(),
  request_id: text('request_id').notNull(),
  data: json('data').notNull(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
});

// Out-of-home media (ooh.ts)
export const projectOohConnections = pgTable('project_ooh_connections', {
  project_id: text('project_id').primaryKey(),
  provider: text('provider').notNull(),
  external_scope_id: text('external_scope_id').notNull(),
  config_public: json('config_public').notNull(),
});
export const projectOohInventory = pgTable('project_ooh_inventory', {
  project_id: text('project_id').notNull(),
  screen_id: bigint('screen_id', { mode: 'number' }).notNull(),
  data: json('data').notNull(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
}, t => [
  primaryKey({ columns: [t.project_id, t.screen_id] }),
]);
export const projectOohBookings = pgTable('project_ooh_bookings', {
  id: text('id').primaryKey(),
  project_id: text('project_id').notNull(),
  data: json('data').notNull(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
});

// Links and website analytics (links.ts)
export const projectLinkSettings = pgTable('project_link_settings', {
  project_id: text('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  short_base_url: text('short_base_url').notNull(),
  website_origins: json('website_origins').notNull(),
  site_token: text('site_token').notNull().unique('project_link_settings_site_token_key'),
  domain_token: text('domain_token').notNull().unique('project_link_settings_domain_token_key'),
  updated_at: text('updated_at').notNull(),
});
export const campaignLinks = pgTable('campaign_links', {
  id: text('id').primaryKey(),
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  code: text('code').notNull().unique('campaign_links_code_key'),
  name: text('name').notNull(),
  destination: text('destination').notNull(),
  campaign_id: text('campaign_id').notNull().default(''),
  short_origin: text('short_origin').notNull(),
  archived: boolean('archived').notNull().default(false),
  created_at: text('created_at').notNull(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
}, t => [
  index('campaign_links_project').on(t.project_id),
  uniqueIndex('campaign_links_active_destination').on(t.project_id, t.destination, t.campaign_id).where(sql`NOT ${t.archived}`),
]);
export const campaignLinkDaily = pgTable('campaign_link_daily', {
  link_id: text('link_id').notNull().references(() => campaignLinks.id, { onDelete: 'cascade' }),
  day: text('day').notNull(),
  clicks: integer('clicks').notNull().default(0),
  qr_scans: integer('qr_scans').notNull().default(0),
}, t => [
  primaryKey({ columns: [t.link_id, t.day] }),
]);
export const websiteDaily = pgTable('website_daily', {
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  day: text('day').notNull(),
  path: text('path').notNull(),
  name: text('name').notNull(),
  count: integer('count').notNull(),
}, t => [
  primaryKey({ columns: [t.project_id, t.day, t.path, t.name] }),
]);
export const websiteEventIds = pgTable('website_event_ids', {
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  event_id: text('event_id').notNull(),
  created_at: bigint('created_at', { mode: 'number' }).notNull(),
}, t => [
  primaryKey({ columns: [t.project_id, t.event_id] }),
]);
export const websiteEventLimits = pgTable('website_event_limits', {
  bucket: text('bucket').notNull(),
  minute: bigint('minute', { mode: 'number' }).notNull(),
  count: integer('count').notNull(),
}, t => [
  primaryKey({ columns: [t.bucket, t.minute] }),
]);

// Direct contacts, campaigns and SMS (contacts.ts, direct-campaigns.ts, sms-inbox.ts)
export const directContacts = pgTable('direct_contacts', {
  id: text('id').primaryKey(),
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  data: json('data').notNull(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
}, t => [
  index('direct_contacts_project').on(t.project_id),
]);
export const directContactMessengerIdentities = pgTable('direct_contact_messenger_identities', {
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  account_id: text('account_id').notNull(),
  participant_id: text('participant_id').notNull(),
  contact_id: text('contact_id').notNull().references(() => directContacts.id, { onDelete: 'cascade' }),
}, t => [
  primaryKey({ columns: [t.project_id, t.account_id, t.participant_id] }),
]);
export const directContactSuppressions = pgTable('direct_contact_suppressions', {
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  channel: text('channel').notNull(),
  target_hash: text('target_hash').notNull(),
  reason: text('reason').notNull(),
  created_at: text('created_at').notNull(),
}, t => [
  primaryKey({ columns: [t.project_id, t.channel, t.target_hash] }),
]);
export const directSmsSuppressions = pgTable('direct_sms_suppressions', {
  target_hash: text('target_hash').primaryKey(),
  reason: text('reason').notNull(),
  created_at: text('created_at').notNull(),
});
export const directCampaigns = pgTable('direct_campaigns', {
  id: text('id').primaryKey(),
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  data: json('data').notNull(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
}, t => [
  index('direct_campaigns_project').on(t.project_id),
]);
export const directDeliveries = pgTable('direct_deliveries', {
  id: text('id').primaryKey(),
  campaign_id: text('campaign_id').notNull().references(() => directCampaigns.id, { onDelete: 'cascade' }),
  contact_id: text('contact_id').notNull(),
  data: json('data').notNull(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
}, t => [
  unique('direct_deliveries_campaign_id_contact_id_key').on(t.campaign_id, t.contact_id),
]);
export const smsConversations = pgTable('sms_conversations', {
  id: text('id').primaryKey(),
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  account_sid: text('account_sid').notNull(),
  sender: text('sender').notNull(),
  recipient: text('recipient').notNull(),
  service_sid: text('service_sid').notNull(),
  data: json('data').notNull(),
}, t => [
  unique('sms_conversations_project_id_account_sid_sender_recipient_key').on(t.project_id, t.account_sid, t.sender, t.recipient),
]);
export const smsMessages = pgTable('sms_messages', {
  sequence: bigint('sequence', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  id: text('id').notNull().unique('sms_messages_id_key'),
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  conversation_id: text('conversation_id').notNull().references(() => smsConversations.id, { onDelete: 'cascade' }),
  account_sid: text('account_sid').notNull(),
  provider_id: text('provider_id'),
  data: json('data').notNull(),
}, t => [
  unique('sms_messages_account_sid_provider_id_key').on(t.account_sid, t.provider_id),
  index('sms_message_scope').on(t.project_id, t.conversation_id, t.sequence),
]);
export const smsInboundReceipts = pgTable('sms_inbound_receipts', {
  account_sid: text('account_sid').notNull(),
  provider_id: text('provider_id').notNull(),
  body_hash: text('body_hash').notNull(),
  project_id: text('project_id'),
  status: text('status').notNull(),
}, t => [
  primaryKey({ columns: [t.account_sid, t.provider_id] }),
]);

// Webhooks and inbox (webhooks.ts, zernio-ad-events.ts, inbox.ts)
export const webhookEvents = pgTable('webhook_events', {
  id: text('id').primaryKey(),
  event: text('event').notNull(),
  payload: text('payload').notNull(),
  body_hash: text('body_hash').notNull(),
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  last_error: text('last_error'),
  next_attempt: bigint('next_attempt', { mode: 'number' }).notNull().default(0),
  received_at: text('received_at').notNull(),
  processed_at: text('processed_at'),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
}, t => [
  index('webhook_pending').on(t.status, t.next_attempt),
]);
export const webhookInboxUpdates = pgTable('webhook_inbox_updates', {
  sequence: bigint('sequence', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  profile_id: text('profile_id').notNull(),
  account_id: text('account_id').notNull(),
  event_id: text('event_id').notNull().unique('webhook_inbox_updates_event_id_key'),
  event: text('event').notNull(),
  data: json('data').notNull(),
}, t => [
  index('webhook_inbox_scope').on(t.project_id, t.profile_id, t.account_id, t.sequence),
]);
export const webhookProjectBindings = pgTable('webhook_project_bindings', {
  event_id: text('event_id').notNull(),
  profile_id: text('profile_id').notNull(),
  project_id: text('project_id').notNull(),
}, t => [
  primaryKey({ columns: [t.event_id, t.profile_id] }),
]);
export const webhookAdUpdates = pgTable('webhook_ad_updates', {
  sequence: bigint('sequence', { mode: 'number' }).generatedByDefaultAsIdentity().primaryKey(),
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  profile_id: text('profile_id').notNull(),
  account_id: text('account_id').notNull(),
  platform: text('platform').notNull(),
  ad_account_id: text('ad_account_id').notNull(),
  event_id: text('event_id').notNull().unique('webhook_ad_updates_event_id_key'),
  event_at: text('event_at').notNull(),
  event: text('event').notNull(),
  data: json('data').notNull(),
}, t => [
  index('webhook_ad_scope').on(t.project_id, t.profile_id, t.account_id, t.ad_account_id, t.sequence),
]);
export const inboxConversationDeletions = pgTable('inbox_conversation_deletions', {
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  profile_id: text('profile_id').notNull(),
  account_id: text('account_id').notNull(),
  conversation_id: text('conversation_id').notNull(),
  status: text('status').notNull(),
  operation_id: text('operation_id').notNull().default(''),
}, t => [
  primaryKey({ columns: [t.project_id, t.profile_id, t.account_id, t.conversation_id] }),
]);
export const inboxPrivateReplies = pgTable('inbox_private_replies', {
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  profile_id: text('profile_id').notNull(),
  account_id: text('account_id').notNull(),
  post_id: text('post_id').notNull(),
  comment_id: text('comment_id').notNull(),
  status: text('status').notNull(),
  operation_id: text('operation_id').notNull(),
}, t => [
  primaryKey({ columns: [t.project_id, t.profile_id, t.account_id, t.post_id, t.comment_id] }),
]);
export const inboxCommentReactions = pgTable('inbox_comment_reactions', {
  operation_id: text('operation_id').primaryKey(),
  platform: text('platform').notNull(),
  account_id: text('account_id').notNull(),
  native_account_id: text('native_account_id').notNull(),
  post_id: text('post_id').notNull(),
  comment_id: text('comment_id').notNull(),
  action: text('action').notNull(),
  reaction_type: text('reaction_type').notNull(),
}, t => [
  index('inbox_comment_reactions_target').on(t.platform, t.post_id, t.comment_id),
]);

// Zernio provider state and receipts (zernio-*.ts, integrations.ts)
export const zernioContactLinks = pgTable('zernio_contact_links', {
  id: text('id').primaryKey(),
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  profile_id: text('profile_id').notNull(),
  account_id: text('account_id').notNull(),
  local_contact_id: text('local_contact_id').notNull().references(() => directContacts.id, { onDelete: 'cascade' }),
  provider_contact_id: text('provider_contact_id').notNull(),
  channel_id: text('channel_id').notNull(),
  platform: text('platform').notNull(),
  identifier: text('identifier').notNull(),
  created_at: text('created_at').notNull(),
}, t => [
  unique('zernio_contact_links_project_id_profile_id_account_id_provider_contact_id_channel_id_key').on(t.project_id, t.profile_id, t.account_id, t.provider_contact_id, t.channel_id),
  unique('zernio_contact_links_project_id_profile_id_account_id_local_contact_id_key').on(t.project_id, t.profile_id, t.account_id, t.local_contact_id),
]);
export const zernioLeadAssociations = pgTable('zernio_lead_associations', {
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  profile_id: text('profile_id').notNull(),
  account_id: text('account_id').notNull(),
  form_id: text('form_id').notNull(),
  lead_id: text('lead_id').notNull(),
  contact_id: text('contact_id').notNull().references(() => directContacts.id, { onDelete: 'cascade' }),
  lead_version: text('lead_version').notNull(),
  imported_at: text('imported_at').notNull(),
}, t => [
  primaryKey({ columns: [t.project_id, t.profile_id, t.account_id, t.form_id, t.lead_id] }),
]);
export const zernioTestLeads = pgTable('zernio_test_leads', {
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  profile_id: text('profile_id').notNull(),
  account_id: text('account_id').notNull(),
  form_id: text('form_id').notNull(),
  lead_id: text('lead_id').notNull(),
  created_at: text('created_at').notNull(),
}, t => [
  primaryKey({ columns: [t.project_id, t.profile_id, t.account_id, t.form_id, t.lead_id] }),
]);
export const zernioLeadMutations = pgTable('zernio_lead_mutations', {
  project_id: text('project_id').primaryKey().references(() => projects.id, { onDelete: 'cascade' }),
  request_key: text('request_key').notNull(),
});
export const zernioMediaUploads = pgTable('zernio_media_uploads', {
  id: text('id').primaryKey(),
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  user_id: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  profile_id: text('profile_id').notNull(),
  asset_id: text('asset_id').notNull(),
  data: json('data').notNull(),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
}, t => [
  index('zernio_media_scope').on(t.project_id, t.user_id, t.profile_id, t.asset_id),
]);
export const zernioExternalPostReferences = pgTable('zernio_external_post_references', {
  project_id: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  profile_id: text('profile_id').notNull(),
  account_id: text('account_id').notNull(),
  native_account_id: text('native_account_id').notNull(),
  platform_post_id: text('platform_post_id').notNull(),
  data: json('data').notNull(),
  campaign_id: text('campaign_id').references(() => records.id, { onDelete: 'set null' }),
  updated_at: text('updated_at').notNull(),
}, t => [
  primaryKey({ columns: [t.project_id, t.profile_id, t.account_id, t.native_account_id, t.platform_post_id] }),
]);
export const zernioCampaignCopyReceipts = pgTable('zernio_campaign_copy_receipts', {
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
  profile_id: text('profile_id').notNull(),
  source_campaign_id: text('source_campaign_id').notNull(),
  platform: text('platform').notNull(),
  account_id: text('account_id').notNull(),
  native_advertiser_id: text('native_advertiser_id').notNull(),
  resource: text('resource').notNull(),
  copied_campaign_id: text('copied_campaign_id'),
  discovery: text('discovery'),
  verification: text('verification').notNull().default('pending'),
  status_read_at: text('status_read_at'),
  seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
}, t => [
  primaryKey({ columns: [t.project_id, t.request_key] }),
]);
export const zernioProductCreateReceipts = pgTable('zernio_product_create_receipts', {
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
  account_id: text('account_id').notNull(),
  native_product_id: text('native_product_id'),
}, t => [
  primaryKey({ columns: [t.project_id, t.request_key] }),
]);
export const zernioWhatsappTemplateOwnership = pgTable('zernio_whatsapp_template_ownership', {
  waba_id: text('waba_id').notNull(),
  template_id: text('template_id').notNull(),
  project_id: text('project_id').notNull(),
  profile_id: text('profile_id').notNull(),
}, t => [
  primaryKey({ columns: [t.waba_id, t.template_id] }),
]);
export const zernioWhatsappTemplateMutations = pgTable('zernio_whatsapp_template_mutations', {
  waba_id: text('waba_id').primaryKey(),
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
});
export const zernioGoogleConversionMutations = pgTable('zernio_google_conversion_mutations', {
  customer_id: text('customer_id').primaryKey(),
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
});

// Single-flight resource fences: one row per provider resource holds the request that owns it.
export const zernioAdsetBudgetClaims = pgTable('zernio_adset_budget_claims', {
  resource: text('resource').primaryKey(),
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
});
export const zernioCampaignBudgetClaims = pgTable('zernio_campaign_budget_claims', {
  resource: text('resource').primaryKey(),
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
});
export const zernioCampaignCopyClaims = pgTable('zernio_campaign_copy_claims', {
  resource: text('resource').primaryKey(),
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
});
export const zernioBlogCreates = pgTable('zernio_blog_creates', {
  resource: text('resource').primaryKey(),
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
});
export const zernioBlogUpdates = pgTable('zernio_blog_updates', {
  resource: text('resource').primaryKey(),
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
});
export const zernioBlueskyMutations = pgTable('zernio_bluesky_mutations', {
  resource: text('resource').primaryKey(),
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
});
export const zernioCollectionUpdates = pgTable('zernio_collection_updates', {
  resource: text('resource').primaryKey(),
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
});
export const zernioContactMutations = pgTable('zernio_contact_mutations', {
  resource: text('resource').primaryKey(),
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
});
export const zernioDestinationMutations = pgTable('zernio_destination_mutations', {
  resource: text('resource').primaryKey(),
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
});
export const zernioDiscordMutations = pgTable('zernio_discord_mutations', {
  resource: text('resource').primaryKey(),
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
});
export const zernioFacebookSubscriptionMutations = pgTable('zernio_facebook_subscription_mutations', {
  resource: text('resource').primaryKey(),
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
});
export const zernioProductCreates = pgTable('zernio_product_creates', {
  resource: text('resource').primaryKey(),
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
});
export const zernioProductUpdates = pgTable('zernio_product_updates', {
  resource: text('resource').primaryKey(),
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
});
export const zernioSlackMutations = pgTable('zernio_slack_mutations', {
  resource: text('resource').primaryKey(),
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
});
export const zernioTelegramMutations = pgTable('zernio_telegram_mutations', {
  resource: text('resource').primaryKey(),
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
});
export const zernioWebhookMutations = pgTable('zernio_webhook_mutations', {
  resource: text('resource').primaryKey(),
  project_id: text('project_id').notNull(),
  request_key: text('request_key').notNull(),
});
