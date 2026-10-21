-- Baseline PostgreSQL schema: the 81 tables the SQLite modules create lazily as of 0.8.12.
-- Value representations are preserved for an ID-preserving import: ISO-8601 timestamps stay text,
-- epoch-millisecond values are bigint, 0/1 flags are boolean, encrypted settings are bytea.
-- JSON documents use json, not jsonb: jsonb reorders object keys, and approvals and recycling
-- fingerprint sha256(JSON.stringify(parsed document)), so a jsonb round trip would mark approved
-- posts stale and raise false APPROVAL_POST_CHANGED errors. json keeps the stored text and still
-- supports ->>. Exact provider evidence, idempotent replay bodies and fingerprinted snapshots stay text.

-- Identity, tenancy and installation (database.ts, invitations.ts)
CREATE TABLE installation (id integer PRIMARY KEY CHECK (id = 1), claimed boolean NOT NULL DEFAULT false);
INSERT INTO installation (id) VALUES (1);
CREATE TABLE users (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE, password text);
CREATE TABLE instance_operators (user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE);
CREATE TABLE instance_operator_audit (id text PRIMARY KEY, user_id text NOT NULL, action text NOT NULL CHECK (action IN ('bootstrap','grant','revoke')), source text NOT NULL CHECK (source IN ('bootstrap','host')), created_at bigint NOT NULL);
CREATE TABLE sessions (token text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at bigint NOT NULL);
CREATE TABLE workspaces (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE memberships (workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, role text NOT NULL CHECK (role IN ('owner','admin','editor','viewer')), PRIMARY KEY (workspace_id, user_id));
CREATE TABLE projects (id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, name text NOT NULL, color text NOT NULL DEFAULT '#5943ce', zernio_profile_id text NOT NULL DEFAULT '', drive_folder_id text NOT NULL DEFAULT '');
CREATE TABLE records (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, collection text NOT NULL, data json NOT NULL);
CREATE INDEX records_project ON records (project_id, collection);
CREATE TABLE activity (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, message text NOT NULL, created_at text NOT NULL, sample boolean NOT NULL DEFAULT false);
CREATE TABLE oidc_flows (state text PRIMARY KEY, browser text NOT NULL, verifier text NOT NULL, nonce text NOT NULL, expires_at bigint NOT NULL);
CREATE TABLE oidc_return_targets (state text PRIMARY KEY REFERENCES oidc_flows(state) ON DELETE CASCADE, invite_token text NOT NULL);
CREATE TABLE oidc_identities (issuer text NOT NULL, subject text NOT NULL, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (issuer, subject));
CREATE TABLE login_limits (key text PRIMARY KEY, count integer NOT NULL, expires_at bigint NOT NULL);
CREATE TABLE workspace_invitations (id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, email text NOT NULL, role text NOT NULL CHECK (role IN ('owner','admin','editor','viewer')), inviter_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, token_hash text NOT NULL UNIQUE, created_at bigint NOT NULL, expires_at bigint NOT NULL, accepted_at bigint, revoked_at bigint);
CREATE INDEX workspace_invitations_workspace ON workspace_invitations (workspace_id, created_at);

-- Provider operations and recovery (provider-core.ts, operation-recovery.ts, integration-settings.ts)
CREATE TABLE integration_operations (id text PRIMARY KEY, project_id text NOT NULL, request_key text NOT NULL, request_hash text NOT NULL, status text NOT NULL, response text, http_status integer, created_at text NOT NULL, action_path text NOT NULL DEFAULT '', run_id text NOT NULL DEFAULT '', resource_key text NOT NULL DEFAULT '', UNIQUE (project_id, request_key));
CREATE INDEX integration_operations_resource ON integration_operations (project_id, resource_key, status);
CREATE TABLE integration_operation_reviews (operation_id text PRIMARY KEY REFERENCES integration_operations(id), project_id text NOT NULL, reviewer_id text NOT NULL, resolution text NOT NULL CHECK (resolution IN ('not_applied','applied')), note text NOT NULL, reference text NOT NULL, reviewed_at text NOT NULL);
CREATE TABLE integration_settings (provider text PRIMARY KEY, nonce bytea NOT NULL, ciphertext bytea NOT NULL, tag bytea NOT NULL, updated_at text NOT NULL);
CREATE TABLE integration_telegram_codes (project_id text PRIMARY KEY, profile_id text NOT NULL, code text NOT NULL, expires_at text NOT NULL);

-- AI agent (agent.ts)
CREATE TABLE agent_runs (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id), user_id text NOT NULL REFERENCES users(id), request_key text NOT NULL, input_hash text NOT NULL, status text NOT NULL, message text NOT NULL, model text NOT NULL, response text, usage json NOT NULL, error text, created_at text NOT NULL, UNIQUE (project_id, user_id, request_key));
CREATE TABLE agent_actions (id text PRIMARY KEY, run_id text NOT NULL REFERENCES agent_runs(id), project_id text NOT NULL, user_id text NOT NULL, collection text NOT NULL, data json NOT NULL, status text NOT NULL, record_id text);

-- Approvals and recycling (approvals.ts, zernio-recycling.ts)
CREATE TABLE project_approval_policy (project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, require_approval boolean NOT NULL, updated_by text NOT NULL REFERENCES users(id), updated_at text NOT NULL);
CREATE TABLE post_approval_reviews (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, post_id text NOT NULL, fingerprint text NOT NULL, snapshot text NOT NULL, status text NOT NULL CHECK (status IN ('pending','approved','rejected')), requested_by text NOT NULL REFERENCES users(id), requested_at text NOT NULL, reviewed_by text REFERENCES users(id), reviewed_at text, note text NOT NULL DEFAULT '');
CREATE INDEX post_approval_reviews_post ON post_approval_reviews (project_id, post_id);
CREATE TABLE post_recycling_reviews (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, post_id text NOT NULL, fingerprint text NOT NULL, snapshot text NOT NULL, configuration text NOT NULL, reviewed_by text NOT NULL REFERENCES users(id), reviewed_at text NOT NULL, UNIQUE (project_id, post_id, fingerprint));

-- Calendar and native ad connections (calendar.ts, native-google-ads.ts, native-microsoft-ads.ts)
CREATE TABLE calendar_connections (project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, calendar_id text NOT NULL UNIQUE);
CREATE TABLE calendar_plan_generations (project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, calendar_id text NOT NULL, collection text NOT NULL, record_id text NOT NULL, account_id text NOT NULL DEFAULT '', generation integer NOT NULL DEFAULT 0, known_generation integer NOT NULL DEFAULT -1, PRIMARY KEY (project_id, calendar_id, collection, record_id, account_id));
CREATE TABLE native_google_connections (project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, customer_id text NOT NULL UNIQUE);
CREATE TABLE microsoft_ad_connections (project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, customer_id text NOT NULL, account_id text NOT NULL UNIQUE, data json NOT NULL);
CREATE TABLE microsoft_ad_reports (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, account_id text NOT NULL, request_id text NOT NULL, data json NOT NULL);

-- Out-of-home media (ooh.ts)
CREATE TABLE project_ooh_connections (project_id text PRIMARY KEY, provider text NOT NULL, external_scope_id text NOT NULL, config_public json NOT NULL);
CREATE TABLE project_ooh_inventory (project_id text NOT NULL, screen_id bigint NOT NULL, data json NOT NULL, PRIMARY KEY (project_id, screen_id));
CREATE TABLE project_ooh_bookings (id text PRIMARY KEY, project_id text NOT NULL, data json NOT NULL);

-- Links and website analytics (links.ts)
CREATE TABLE project_link_settings (project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, short_base_url text NOT NULL, website_origins json NOT NULL, site_token text NOT NULL UNIQUE, domain_token text NOT NULL UNIQUE, updated_at text NOT NULL);
CREATE TABLE campaign_links (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, code text NOT NULL UNIQUE, name text NOT NULL, destination text NOT NULL, campaign_id text NOT NULL DEFAULT '', short_origin text NOT NULL, archived boolean NOT NULL DEFAULT false, created_at text NOT NULL);
CREATE INDEX campaign_links_project ON campaign_links (project_id);
CREATE UNIQUE INDEX campaign_links_active_destination ON campaign_links (project_id, destination, campaign_id) WHERE NOT archived;
CREATE TABLE campaign_link_daily (link_id text NOT NULL REFERENCES campaign_links(id) ON DELETE CASCADE, day text NOT NULL, clicks integer NOT NULL DEFAULT 0, qr_scans integer NOT NULL DEFAULT 0, PRIMARY KEY (link_id, day));
CREATE TABLE website_daily (project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, day text NOT NULL, path text NOT NULL, name text NOT NULL, count integer NOT NULL, PRIMARY KEY (project_id, day, path, name));
CREATE TABLE website_event_ids (project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, event_id text NOT NULL, created_at bigint NOT NULL, PRIMARY KEY (project_id, event_id));
CREATE TABLE website_event_limits (bucket text NOT NULL, minute bigint NOT NULL, count integer NOT NULL, PRIMARY KEY (bucket, minute));

-- Direct contacts, campaigns and SMS (contacts.ts, direct-campaigns.ts, sms-inbox.ts)
CREATE TABLE direct_contacts (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, data json NOT NULL);
CREATE INDEX direct_contacts_project ON direct_contacts (project_id);
CREATE TABLE direct_contact_messenger_identities (project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, account_id text NOT NULL, participant_id text NOT NULL, contact_id text NOT NULL REFERENCES direct_contacts(id) ON DELETE CASCADE, PRIMARY KEY (project_id, account_id, participant_id));
CREATE TABLE direct_contact_suppressions (project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, channel text NOT NULL, target_hash text NOT NULL, reason text NOT NULL, created_at text NOT NULL, PRIMARY KEY (project_id, channel, target_hash));
CREATE TABLE direct_sms_suppressions (target_hash text PRIMARY KEY, reason text NOT NULL, created_at text NOT NULL);
CREATE TABLE direct_campaigns (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, data json NOT NULL);
CREATE INDEX direct_campaigns_project ON direct_campaigns (project_id);
CREATE TABLE direct_deliveries (id text PRIMARY KEY, campaign_id text NOT NULL REFERENCES direct_campaigns(id) ON DELETE CASCADE, contact_id text NOT NULL, data json NOT NULL, UNIQUE (campaign_id, contact_id));
CREATE TABLE sms_conversations (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, account_sid text NOT NULL, sender text NOT NULL, recipient text NOT NULL, service_sid text NOT NULL, data json NOT NULL, UNIQUE (project_id, account_sid, sender, recipient));
CREATE TABLE sms_messages (sequence bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, id text NOT NULL UNIQUE, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, conversation_id text NOT NULL REFERENCES sms_conversations(id) ON DELETE CASCADE, account_sid text NOT NULL, provider_id text, data json NOT NULL, UNIQUE (account_sid, provider_id));
CREATE INDEX sms_message_scope ON sms_messages (project_id, conversation_id, sequence);
CREATE TABLE sms_inbound_receipts (account_sid text NOT NULL, provider_id text NOT NULL, body_hash text NOT NULL, project_id text, status text NOT NULL, PRIMARY KEY (account_sid, provider_id));

-- Webhooks and inbox (webhooks.ts, zernio-ad-events.ts, inbox.ts)
CREATE TABLE webhook_events (id text PRIMARY KEY, event text NOT NULL, payload text NOT NULL, body_hash text NOT NULL, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0, last_error text, next_attempt bigint NOT NULL DEFAULT 0, received_at text NOT NULL, processed_at text);
CREATE INDEX webhook_pending ON webhook_events (status, next_attempt);
CREATE TABLE webhook_inbox_updates (sequence bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, profile_id text NOT NULL, account_id text NOT NULL, event_id text NOT NULL UNIQUE, event text NOT NULL, data json NOT NULL);
CREATE INDEX webhook_inbox_scope ON webhook_inbox_updates (project_id, profile_id, account_id, sequence);
CREATE TABLE webhook_project_bindings (event_id text NOT NULL, profile_id text NOT NULL, project_id text NOT NULL, PRIMARY KEY (event_id, profile_id));
CREATE TABLE webhook_ad_updates (sequence bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, profile_id text NOT NULL, account_id text NOT NULL, platform text NOT NULL, ad_account_id text NOT NULL, event_id text NOT NULL UNIQUE, event_at text NOT NULL, event text NOT NULL, data json NOT NULL);
CREATE INDEX webhook_ad_scope ON webhook_ad_updates (project_id, profile_id, account_id, ad_account_id, sequence);
CREATE TABLE inbox_conversation_deletions (project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, profile_id text NOT NULL, account_id text NOT NULL, conversation_id text NOT NULL, status text NOT NULL, operation_id text NOT NULL DEFAULT '', PRIMARY KEY (project_id, profile_id, account_id, conversation_id));
CREATE TABLE inbox_private_replies (project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, profile_id text NOT NULL, account_id text NOT NULL, post_id text NOT NULL, comment_id text NOT NULL, status text NOT NULL, operation_id text NOT NULL, PRIMARY KEY (project_id, profile_id, account_id, post_id, comment_id));
CREATE TABLE inbox_comment_reactions (operation_id text PRIMARY KEY, platform text NOT NULL, account_id text NOT NULL, native_account_id text NOT NULL, post_id text NOT NULL, comment_id text NOT NULL, action text NOT NULL, reaction_type text NOT NULL);
CREATE INDEX inbox_comment_reactions_target ON inbox_comment_reactions (platform, post_id, comment_id);

-- Zernio provider state and receipts (zernio-*.ts, integrations.ts)
CREATE TABLE zernio_contact_links (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, profile_id text NOT NULL, account_id text NOT NULL, local_contact_id text NOT NULL REFERENCES direct_contacts(id) ON DELETE CASCADE, provider_contact_id text NOT NULL, channel_id text NOT NULL, platform text NOT NULL, identifier text NOT NULL, created_at text NOT NULL, UNIQUE (project_id, profile_id, account_id, provider_contact_id, channel_id), UNIQUE (project_id, profile_id, account_id, local_contact_id));
CREATE TABLE zernio_lead_associations (project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, profile_id text NOT NULL, account_id text NOT NULL, form_id text NOT NULL, lead_id text NOT NULL, contact_id text NOT NULL REFERENCES direct_contacts(id) ON DELETE CASCADE, lead_version text NOT NULL, imported_at text NOT NULL, PRIMARY KEY (project_id, profile_id, account_id, form_id, lead_id));
CREATE TABLE zernio_test_leads (project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, profile_id text NOT NULL, account_id text NOT NULL, form_id text NOT NULL, lead_id text NOT NULL, created_at text NOT NULL, PRIMARY KEY (project_id, profile_id, account_id, form_id, lead_id));
CREATE TABLE zernio_lead_mutations (project_id text PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, request_key text NOT NULL);
CREATE TABLE zernio_media_uploads (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, profile_id text NOT NULL, asset_id text NOT NULL, data json NOT NULL);
CREATE INDEX zernio_media_scope ON zernio_media_uploads (project_id, user_id, profile_id, asset_id);
CREATE TABLE zernio_external_post_references (project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, profile_id text NOT NULL, account_id text NOT NULL, native_account_id text NOT NULL, platform_post_id text NOT NULL, data json NOT NULL, campaign_id text REFERENCES records(id) ON DELETE SET NULL, updated_at text NOT NULL, PRIMARY KEY (project_id, profile_id, account_id, native_account_id, platform_post_id));
CREATE TABLE zernio_campaign_copy_receipts (project_id text NOT NULL, request_key text NOT NULL, profile_id text NOT NULL, source_campaign_id text NOT NULL, platform text NOT NULL, account_id text NOT NULL, native_advertiser_id text NOT NULL, resource text NOT NULL, copied_campaign_id text, discovery text, verification text NOT NULL DEFAULT 'pending', status_read_at text, PRIMARY KEY (project_id, request_key));
CREATE TABLE zernio_product_create_receipts (project_id text NOT NULL, request_key text NOT NULL, account_id text NOT NULL, native_product_id text, PRIMARY KEY (project_id, request_key));
CREATE TABLE zernio_whatsapp_template_ownership (waba_id text NOT NULL, template_id text NOT NULL, project_id text NOT NULL, profile_id text NOT NULL, PRIMARY KEY (waba_id, template_id));
CREATE TABLE zernio_whatsapp_template_mutations (waba_id text PRIMARY KEY, project_id text NOT NULL, request_key text NOT NULL);
CREATE TABLE zernio_google_conversion_mutations (customer_id text PRIMARY KEY, project_id text NOT NULL, request_key text NOT NULL);

-- Single-flight resource fences: one row per provider resource holds the request that owns it.
CREATE TABLE zernio_adset_budget_claims (resource text PRIMARY KEY, project_id text NOT NULL, request_key text NOT NULL);
CREATE TABLE zernio_campaign_budget_claims (resource text PRIMARY KEY, project_id text NOT NULL, request_key text NOT NULL);
CREATE TABLE zernio_campaign_copy_claims (resource text PRIMARY KEY, project_id text NOT NULL, request_key text NOT NULL);
CREATE TABLE zernio_blog_creates (resource text PRIMARY KEY, project_id text NOT NULL, request_key text NOT NULL);
CREATE TABLE zernio_blog_updates (resource text PRIMARY KEY, project_id text NOT NULL, request_key text NOT NULL);
CREATE TABLE zernio_bluesky_mutations (resource text PRIMARY KEY, project_id text NOT NULL, request_key text NOT NULL);
CREATE TABLE zernio_collection_updates (resource text PRIMARY KEY, project_id text NOT NULL, request_key text NOT NULL);
CREATE TABLE zernio_contact_mutations (resource text PRIMARY KEY, project_id text NOT NULL, request_key text NOT NULL);
CREATE TABLE zernio_destination_mutations (resource text PRIMARY KEY, project_id text NOT NULL, request_key text NOT NULL);
CREATE TABLE zernio_discord_mutations (resource text PRIMARY KEY, project_id text NOT NULL, request_key text NOT NULL);
CREATE TABLE zernio_facebook_subscription_mutations (resource text PRIMARY KEY, project_id text NOT NULL, request_key text NOT NULL);
CREATE TABLE zernio_product_creates (resource text PRIMARY KEY, project_id text NOT NULL, request_key text NOT NULL);
CREATE TABLE zernio_product_updates (resource text PRIMARY KEY, project_id text NOT NULL, request_key text NOT NULL);
CREATE TABLE zernio_slack_mutations (resource text PRIMARY KEY, project_id text NOT NULL, request_key text NOT NULL);
CREATE TABLE zernio_telegram_mutations (resource text PRIMARY KEY, project_id text NOT NULL, request_key text NOT NULL);
CREATE TABLE zernio_webhook_mutations (resource text PRIMARY KEY, project_id text NOT NULL, request_key text NOT NULL);
