-- Provider deliverability reports that are not a recipient's own suppression (ten98-campaign#77). Cloudflare does not define
-- its `policy` suppression reason, so it may be a sender-side block: Campaign records it here and alerts the project instead
-- of suppressing the contact. Each provider sync replaces the project's set; first_seen_at survives the refresh.
CREATE TABLE direct_deliverability_alerts (project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, provider text NOT NULL, kind text NOT NULL, contact_id text NOT NULL REFERENCES direct_contacts(id) ON DELETE CASCADE, expires_at text, first_seen_at text NOT NULL, last_seen_at text NOT NULL, PRIMARY KEY (project_id, provider, kind, contact_id));
