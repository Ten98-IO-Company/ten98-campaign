-- Retained consent history (ten98-campaign#337). One row per permission or suppression change of a direct contact,
-- appended in the transaction of the change. Rows live as long as their project. contact_id has no foreign key, so a
-- contact's history outlives the contact and still reads as one sequence; the address is kept only as a keyed hash
-- (server/consent-history.ts), which also joins a deleted contact's history to a later contact with the same address.
-- Free-text evidence, which can hold personal data, sits in its own table and is removed with the contact.
-- Row-level security: both tables carry workspace_id and project_id, and will take the standard workspace policy
-- (workspace_id equal to the request's workspace) with the other tenant tables. direct_contacts carries project_id
-- only; that tenant-column question is decided once for it and these tables in the row-level-security migration.
CREATE TABLE direct_consent_events (id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, contact_id text NOT NULL, channel text NOT NULL, action text NOT NULL, source text NOT NULL, actor text NOT NULL, destination_hash text NOT NULL, key_version integer NOT NULL, created_at text NOT NULL, seq bigint GENERATED ALWAYS AS IDENTITY);
CREATE INDEX direct_consent_events_contact ON direct_consent_events (project_id, contact_id, created_at);
CREATE INDEX direct_consent_events_destination ON direct_consent_events (project_id, destination_hash, created_at);
CREATE TABLE direct_consent_evidence (event_id text PRIMARY KEY REFERENCES direct_consent_events(id) ON DELETE CASCADE, workspace_id text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, contact_id text NOT NULL REFERENCES direct_contacts(id) ON DELETE CASCADE, evidence text NOT NULL);
CREATE INDEX direct_consent_evidence_contact ON direct_consent_evidence (contact_id);
-- Lookups of an address's history, limited per member and project (it answers "has this address ever been here"):
-- one cell-rate limiter timestamp per key (server/consent-history.ts).
CREATE TABLE direct_consent_lookup_limits (key text PRIMARY KEY, allowed_at bigint NOT NULL);

-- Events are never updated or deleted, except by the cascade that deletes their project or workspace: inside that
-- cascade's referential trigger the parent row is already gone, which is never true for a direct DELETE or one issued
-- from some other trigger while the project exists.
CREATE FUNCTION direct_consent_events_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 AND (NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id) OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'direct_consent_events is append-only (%)', TG_OP USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER direct_consent_events_guard BEFORE UPDATE OR DELETE ON direct_consent_events FOR EACH ROW EXECUTE FUNCTION direct_consent_events_guard();
CREATE TRIGGER direct_consent_events_no_truncate BEFORE TRUNCATE ON direct_consent_events FOR EACH STATEMENT EXECUTE FUNCTION direct_consent_events_guard();
-- Evidence is never updated; it goes only by cascade, when its contact, its event, or its project or workspace is gone
-- (accepting any of them keeps a project delete working whatever order its cascades fire in).
CREATE FUNCTION direct_consent_evidence_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 AND (NOT EXISTS (SELECT 1 FROM direct_contacts WHERE id = OLD.contact_id) OR NOT EXISTS (SELECT 1 FROM direct_consent_events WHERE id = OLD.event_id) OR NOT EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id) OR NOT EXISTS (SELECT 1 FROM workspaces WHERE id = OLD.workspace_id)) THEN RETURN OLD; END IF;
  RAISE EXCEPTION 'direct_consent_evidence is removed only with its contact or event (%)', TG_OP USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER direct_consent_evidence_guard BEFORE UPDATE OR DELETE ON direct_consent_evidence FOR EACH ROW EXECUTE FUNCTION direct_consent_evidence_guard();
CREATE TRIGGER direct_consent_evidence_no_truncate BEFORE TRUNCATE ON direct_consent_evidence FOR EACH STATEMENT EXECUTE FUNCTION direct_consent_evidence_guard();
