# Unified inbox, SMS replies and Messenger contacts

The unified inbox brings connected Zernio messages, comments and reviews into their project's provider scope, alongside locally stored Twilio SMS conversations. Zernio accounts must belong to that project's profile. An incoming conversation does not grant permission to send a separate email, SMS or WhatsApp campaign. Email replies are handled by your external receiving mailbox or group, not an email inbox in this app.

## Setup and supported actions

Configure Zernio in **Integrations**, map one unique profile to each project, and connect accounts with the provider's messaging/comment/review permissions. Open **Unified inbox**, choose a feed, select an account and load it. Account capabilities control available actions; viewers can read but cannot reply or moderate.

Messages support history, explicit replies, supported public HTTPS attachments, read acknowledgement and archive/reopen. Facebook/Instagram reply windows and non-promotional message tags, WhatsApp's 24-hour window, TikTok's 48-hour/ten-reply limit, platform text limits and supported attachment types are checked before sending. For an existing WhatsApp conversation outside the reply window, choose **Approved WhatsApp template** in **Reply type**, load that account's approved templates, choose the language, fill all required values and review the preview before sending. Templates support numbered text values, supported media headers and approved URL-button suffixes; advanced formats are marked unavailable. Rejected or uncertain sends retain the draft. Separate template campaign outreach remains in **Direct campaigns** and requires explicit campaign consent. Encrypted X Chat is unavailable through Zernio.

Comments support published-post feeds, nested threads, public replies, and platform-supported hide/unhide, delete, like/unlike or YouTube moderation. Meta ad comments are resolved through the scoped ad and connected social account. Reviews support Facebook and Google Business Profile, public replies, explicit approval before changing an existing reply, and Google owner-reply removal. A fresh version check blocks stale review edits. Review webhooks currently originate from Google Business Profile.

Writes use the shared durable operation ledger. A lost or malformed acknowledgement stops duplicate submission and remains available for operator reconciliation in Settings. Confirmed replies clear the composer even if refreshing the thread fails; failed replies preserve the draft. Provider acknowledgement does not establish delivery or read status.

**Open replies** in Direct campaigns navigates to SMS replies or the campaign's connected WhatsApp account. An optional recipient search helps find a thread; it does not automatically identify or create the conversation. WhatsApp participants may use business-specific identifiers rather than phone numbers, so inspect the thread before sending. Outside the customer-service reply window, send an approved template through Direct campaigns.

## Twilio SMS conversations

Configure Twilio's Account SID, Auth Token and sender number or Messaging Service in **Integrations**. Copy the current project's incoming webhook URL there and configure Twilio to POST to it:

```text
https://your-app.example/api/webhooks/twilio/inbound/PROJECT_ID
```

Use a public HTTPS `APP_URL`. The receiver checks the standard Twilio Auth Token signature against the exact URL and form fields, configured account and sender. Delivery callbacks use a separate per-message URL set by the app. Preserve request bytes and the public path/query through your proxy. Signature verification occurs before any message is attributed or stored.

An incoming message is attributed through a confirmed outbound account/sender/recipient record. The project-specific URL narrows the candidates to that project; it does not bypass the outbound proof. The legacy global `/api/webhooks/twilio/inbound` route accepts a message into history only when one project matches. Unknown or ambiguous messages retain a hashed receipt without their private body or attachments. Message SID and payload-hash checks prevent duplicates and conflicting replay. A signed callback for another project cannot copy a stored message there.

To test attribution, explicitly send an SMS campaign from this project to a test number whose consent you recorded, wait for Twilio's acknowledgement, then reply from that number. This creates the outbound proof the incoming route needs; provider charges may apply.

Attributed SMS bodies, attachment references, incoming/outgoing history and delivery states are stored in the private database and remain available after restart. Incoming attachments download through an authenticated app route restricted to the stored Twilio account/message. The server fetches the protected file without exposing its Twilio credentials, checks current access and allows at most 20 MB of supported media per download. Files are not persisted locally; downloads use private, non-cacheable attachment responses. History reads and five-second polling use local records. No incoming SMS automatically creates a contact, invents an email address or grants campaign permission.

Viewers can read history; editors can explicitly send a text reply of up to 1,600 characters through the original sender. Replies check current project access, credentials, sender mapping and suppression. They can span multiple billable SMS segments. Outbound media, voice calls and an SMS archive/read workflow are not implemented. Delivery callbacks update status separately; an acknowledgement does not mean delivered or read. In-flight replies interrupted by a restart become uncertain and are not replayed automatically.

Verified STOP requests and Twilio opt-out rejections create durable installation-wide phone-hash suppression. It blocks campaigns and replies across existing and future projects, survives contact deletion/reimport and sender configuration changes, and cannot be cleared by importing consent. A later incoming message or START does not automatically resubscribe the recipient. Keep this suppression ledger with the private database backups.

## Incoming updates

Register the public HTTPS `/api/webhooks/zernio` address in Zernio and use the same signing secret configured in Integrations. Subscribe to `message.received`, other needed `message.*`/`conversation.*` events, `comment.received`, `review.new` and `review.updated`, alongside existing post subscriptions. Configure the profile filter for this installation.

The Zernio raw body is verified before parsing. Event IDs and raw-body hashes prevent replay conflicts; processing, contact identity and the notification commit together. Ambiguous or missing project mappings remain pending. Zernio inbox payloads store routing and contact identity only; message/comment/review bodies and attachments remain at the provider. The browser polls local notifications every five seconds, fetching a provider feed only after relevant activity or an explicit load/refresh. Twilio SMS follows the separate durable local-history flow above.

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
