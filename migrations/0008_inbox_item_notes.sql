-- Internal team notes on an inbox item (ten98-code-system#35 Q2, ten98-campaign#41 change 3). Keyed like inbox_item_state on
-- provider IDs; the body is the team's own text and is never sent to the provider.
CREATE TABLE inbox_item_notes (id text PRIMARY KEY, project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, profile_id text NOT NULL, account_id text NOT NULL, kind text NOT NULL CHECK (kind IN ('conversation','comment','review','mention')), resource_id text NOT NULL, author_id text REFERENCES users(id) ON DELETE SET NULL, body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000), created_at text NOT NULL);
CREATE INDEX inbox_item_notes_item ON inbox_item_notes (project_id, profile_id, account_id, kind, resource_id, created_at);
