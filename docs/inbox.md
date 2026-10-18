# Unified inbox and Messenger contacts

The unified inbox brings connected messages, comments and reviews into their project's provider scope. Provider accounts must belong to that project's Zernio profile. Inbox replies use the connected provider; an incoming conversation does not grant permission to send a separate email, SMS or WhatsApp campaign.

## Setup and supported actions

Configure Zernio in **Integrations**, map one unique profile to each project, and connect accounts with the provider's messaging/comment/review permissions. Open **Unified inbox**, choose a feed, select an account and load it. Account capabilities control available actions; viewers can read but cannot reply or moderate.

Messages support history, explicit replies, supported public HTTPS attachments, read acknowledgement and archive/reopen. Facebook/Instagram reply windows and non-promotional message tags, WhatsApp's 24-hour window, TikTok's 48-hour/ten-reply limit, platform text limits and supported attachment types are checked before sending. WhatsApp template outreach outside the reply window is available in **Direct campaigns** using an approved template and explicit campaign consent. Encrypted X Chat is unavailable through Zernio.

Comments support published-post feeds, nested threads, public replies, and platform-supported hide/unhide, delete, like/unlike or YouTube moderation. Meta ad comments are resolved through the scoped ad and connected social account. Reviews support Facebook and Google Business Profile, public replies, explicit approval before changing an existing reply, and Google owner-reply removal. A fresh version check blocks stale review edits. Review webhooks currently originate from Google Business Profile.

Writes use the shared durable operation ledger. A lost or malformed acknowledgement stops duplicate submission and remains available for operator reconciliation in Settings. Confirmed replies clear the composer even if refreshing the thread fails; failed replies preserve the draft. Provider acknowledgement does not establish delivery or read status.

## Incoming updates

Register the public HTTPS `/api/webhooks/zernio` address in Zernio and use the same signing secret configured in Integrations. Subscribe to `message.received`, other needed `message.*`/`conversation.*` events, `comment.received`, `review.new` and `review.updated`, alongside existing post subscriptions. Configure the profile filter for this installation.

The raw body is verified before parsing. Event IDs and raw-body hashes prevent replay conflicts; processing, contact identity and the notification commit together. Ambiguous or missing project mappings remain pending. New inbox payloads store routing and contact identity only; message/comment/review bodies and attachments remain at the provider. The browser polls local notifications every five seconds, fetching a provider feed only after relevant activity or an explicit load/refresh.

Messenger/Instagram history imported before an account connects does not emit incoming-message webhooks. Opening verified incoming history supplies the automatic contact path below. Provider history/replay limits still apply. Comment feeds may lag provider changes by up to ten minutes. Instagram connections through Facebook Login omit hidden comments from reads: this app can unhide a comment it previously hid when the exact completed action is among the latest 500 receipts; use the provider dashboard for older hidden comments. Scope scans stop after 2,000 posts/comments or 1,000 reviews and return an explicit limit error for older items.

Contracts: [Zernio unified inbox reference](https://github.com/zernio-dev/unified-inbox), [inbox webhooks](https://docs.zernio.com/webhooks/inbox), [conversations](https://docs.zernio.com/messages/list-inbox-conversations). Provider access and policies can vary by connection.

## Automatic Facebook Messenger contacts

A verified incoming Facebook Messenger message creates a project contact automatically. Signed `message.received` events and inbox history synchronization can create the contact when the incoming sender and account are established. A conversation-start event, outgoing message, comment or review alone does not create a Messenger contact.

Identity is the combination of project, Facebook account and participant ID. Facebook participant IDs are scoped to their page/account, so the same participant string in another account or project remains a separate contact. Replayed events and repeated history synchronization link to the same contact. A display name never merges a Messenger sender with an existing email or phone contact.

These contacts have source `messenger` and a read-only Facebook identity containing the account, participant and latest conversation IDs. Names and public HTTPS avatar URLs may come from the verified provider response. If a user edits the contact's name, later provider renames preserve that edit. Company and tags remain editable. The project's 10,000-contact limit also applies to automatic contacts.

## Campaign consent stays separate

A new Messenger contact has no inferred email address or phone number. Its email, SMS and WhatsApp campaign permissions are all disabled. Receiving a message or replying in the inbox does not enable any of them.

You may add a real email address or E.164 phone number later. Save the new destination first, then record its explicit opt-in and evidence source for each campaign channel. Existing consent evidence, opt-outs and suppression are preserved during Messenger updates. Editing or importing a contact cannot remove suppression.

Contact and identity creation are atomic with webhook processing. If the webhook transaction fails, neither an orphan contact nor its identity link remains. Deleting a contact removes its Messenger lookup; a later verified incoming message can create a new contact. Destination suppression records remain separate and continue protecting previously suppressed email addresses and phone numbers.

See [direct campaigns](direct-campaigns.md) for import hygiene, consent evidence, scheduling and delivery-state limits. Provider credentials and real connected accounts are required for live inbox actions; automated checks use disposable databases and mocked provider responses.
