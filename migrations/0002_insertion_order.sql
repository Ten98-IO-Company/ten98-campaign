-- PostgreSQL has no rowid. Every table whose rows the SQLite modules order or page by rowid gets an
-- explicit insertion sequence. The SQLite import writes each row's rowid into seq with OVERRIDING
-- SYSTEM VALUE and then advances the sequence, so order and the webhook_events cursor values that
-- clients already hold (zernio-ad-events.ts) stay the same.
ALTER TABLE activity ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE agent_runs ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE campaign_links ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE direct_campaigns ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE direct_contacts ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE direct_deliveries ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE integration_operations ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE microsoft_ad_reports ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE post_approval_reviews ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE project_ooh_bookings ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE project_ooh_inventory ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE projects ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE records ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE webhook_events ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE workspace_invitations ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE workspaces ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE zernio_campaign_copy_receipts ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
ALTER TABLE zernio_media_uploads ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
-- The two per-project newest-first reads (records list, 50-row activity window) use these indexes.
DROP INDEX records_project;
CREATE INDEX records_project ON records (project_id, collection, seq);
CREATE INDEX activity_project ON activity (project_id, seq);
