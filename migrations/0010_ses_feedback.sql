-- Amazon SES feedback (ten98-campaign#77). SNS delivers at least once, so each verified MessageId is claimed once per topic
-- before its outcome is applied. Transient and undetermined bounces are counted per recipient hash until the threshold
-- (3 in 7 days) suppresses the address; each provider event counts once. Feedback names an SES message ID, which the
-- delivery stores as its providerId.
CREATE TABLE ses_notification_receipts (topic_arn text NOT NULL, message_id text NOT NULL, received_at text NOT NULL, PRIMARY KEY (topic_arn, message_id));
CREATE TABLE direct_email_feedback (project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE, provider text NOT NULL, event_id text NOT NULL, target_hash text NOT NULL, category text NOT NULL CHECK (category IN ('transient','undetermined')), sub_type text, occurred_at text NOT NULL, PRIMARY KEY (project_id, provider, event_id, target_hash));
CREATE INDEX direct_email_feedback_recipient ON direct_email_feedback (project_id, target_hash, occurred_at);
CREATE INDEX direct_deliveries_provider_id ON direct_deliveries ((data->>'providerId'));
