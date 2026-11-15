-- Retained consent history (ten98-campaign#337). One row per permission or suppression change of a direct contact. Rows
-- live as long as their project and are never updated: the trigger below refuses UPDATE, TRUNCATE and any DELETE that is
-- not the project or workspace cascade. contact_id has no foreign key, so a contact's history outlives the contact; the
-- destination is kept only as a keyed hash (see server/consent-history.ts). Free-text evidence, which can hold personal
-- data, sits in its own table and is removed with the contact.
CREATE TABLE direct_consent_events (id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, contact_id text NOT NULL, channel text NOT NULL, action text NOT NULL, source text NOT NULL, actor text NOT NULL, destination_hash text NOT NULL, key_version integer NOT NULL, created_at text NOT NULL, seq bigint GENERATED ALWAYS AS IDENTITY);
CREATE INDEX direct_consent_events_contact ON direct_consent_events (project_id, contact_id, created_at);
CREATE INDEX direct_consent_events_destination ON direct_consent_events (project_id, destination_hash, created_at);
CREATE TABLE direct_consent_evidence (event_id text PRIMARY KEY REFERENCES direct_consent_events(id) ON DELETE CASCADE, contact_id text NOT NULL REFERENCES direct_contacts(id) ON DELETE CASCADE, evidence text NOT NULL);
CREATE INDEX direct_consent_evidence_contact ON direct_consent_evidence (contact_id);

-- A DELETE fired by a foreign-key cascade runs one trigger level down (pg_trigger_depth() > 1); a direct statement does not.
CREATE FUNCTION direct_consent_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'direct_consent_events is append-only (%)', TG_OP USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER direct_consent_events_append_only BEFORE UPDATE OR DELETE ON direct_consent_events FOR EACH ROW EXECUTE FUNCTION direct_consent_events_append_only();
CREATE TRIGGER direct_consent_events_no_truncate BEFORE TRUNCATE ON direct_consent_events FOR EACH STATEMENT EXECUTE FUNCTION direct_consent_events_append_only();
