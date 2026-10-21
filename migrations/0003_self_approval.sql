-- Council decision ten98-code-system#30: a requester may approve their own review only while they are the
-- project's single active owner or administrator. Such an exempted decision is recorded on the review row.
ALTER TABLE post_approval_reviews ADD COLUMN self_approved boolean NOT NULL DEFAULT false;
