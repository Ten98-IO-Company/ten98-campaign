-- Lookups that used to load whole collections: a webhook's post by provider ID, the scheduler's active campaigns,
-- and a campaign's next pending delivery.
CREATE INDEX records_external_id ON records (project_id, collection, (data->>'externalId')) WHERE data->>'externalId' IS NOT NULL;
CREATE INDEX direct_campaigns_active ON direct_campaigns (seq) WHERE data->>'status' IN ('scheduled', 'sending');
CREATE INDEX direct_deliveries_pending ON direct_deliveries (campaign_id, seq) WHERE data->>'status' = 'pending';
