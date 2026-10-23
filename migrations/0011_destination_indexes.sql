-- Keyed lookups for hot paths that used to load a whole collection and search it (ten98-campaign#54 item 5): contacts by
-- email or phone (webhook opt-outs and opt-ins, suppressions, contact saves, the SMS inbox), and assets by delivery URL
-- (the inbox attachment check).
CREATE INDEX direct_contacts_email ON direct_contacts (project_id, (data->>'email'));
CREATE INDEX direct_contacts_phone ON direct_contacts (project_id, (data->>'phone'));
CREATE INDEX records_delivery_url ON records (project_id, collection, (data->>'deliveryUrl'));
