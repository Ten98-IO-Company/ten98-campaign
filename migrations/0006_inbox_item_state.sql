-- Team-inbox triage overlay (ten98-code-system#35 Q2, ten98-campaign#41 change 1). Rows are keyed on provider IDs only and
-- hold no provider content: no message text, names or derived provider data. Timestamps are ISO 8601 UTC text.
-- updated_at changes only with status, snooze or assignee, so it is the optimistic-concurrency token for those fields.
CREATE TABLE inbox_item_state (project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, profile_id text NOT NULL, account_id text NOT NULL, kind text NOT NULL CHECK (kind IN ('conversation','comment','review','mention')), resource_id text NOT NULL, status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','snoozed','resolved')), snoozed_until text, assignee_id text REFERENCES users(id) ON DELETE SET NULL, waiting_since text, first_reply_at text, last_reply_at text, updated_at text, updated_by text REFERENCES users(id) ON DELETE SET NULL, CONSTRAINT inbox_item_state_snooze_check CHECK ((status = 'snoozed') = (snoozed_until IS NOT NULL)), PRIMARY KEY (project_id, profile_id, account_id, kind, resource_id));
-- "Mine" (assignee = user) and "unassigned" (assignee IS NULL) per project, oldest waiting first; also serves the assignee foreign key.
CREATE INDEX inbox_item_state_assignee ON inbox_item_state (assignee_id, project_id, profile_id, waiting_since);
-- "Oldest waiting" per project.
CREATE INDEX inbox_item_state_waiting ON inbox_item_state (project_id, profile_id, waiting_since) WHERE waiting_since IS NOT NULL;
