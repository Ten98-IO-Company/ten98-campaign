-- Council decision ten98-code-system#35 (Q1): ad spend has its own approval setting, separate from post approval.
-- Each existing project copies its post setting, so a project that already required a second person for text
-- requires one for money too; projects without a policy row (and new projects) stay off.
ALTER TABLE project_approval_policy ADD COLUMN require_ad_approval boolean NOT NULL DEFAULT false;
UPDATE project_approval_policy SET require_ad_approval = require_approval;
-- Ad spend reviews share the review table and its decision path. For kind 'ad_spend', post_id holds the subject key
-- (platform, subject id and action) and fingerprint hashes (subject id, platform, action, amount in minor units,
-- currency). An approval covers one provider write: consumed_by names the operation receipt (Idempotency-Key) that
-- used it, and the approval becomes usable again only if that receipt failed.
ALTER TABLE post_approval_reviews ADD COLUMN kind text NOT NULL DEFAULT 'post' CHECK (kind IN ('post','ad_spend'));
ALTER TABLE post_approval_reviews ADD COLUMN consumed_by text;
ALTER TABLE post_approval_reviews ADD COLUMN consumed_at text;
CREATE INDEX post_approval_reviews_fingerprint ON post_approval_reviews (project_id, kind, fingerprint);
