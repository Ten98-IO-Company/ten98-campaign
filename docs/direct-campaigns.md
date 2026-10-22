# Direct campaigns

Direct campaigns sends project-scoped transactional email, SMS, and approved WhatsApp templates. It includes contacts, CSV import, consent records, audience previews, scheduling, suppression, and delivery receipts. The [unified inbox](inbox.md) handles connected messages, comments and reviews, durable Twilio SMS conversations, and Messenger contacts without inferred campaign consent. Voice calling and a receiving email inbox are excluded.

## Connect the three channels

An instance operator configures credentials in **Integrations**. Use your own provider accounts; provider access, delivery limits, sender approval and charges apply independently of this application's MIT license.

| Channel | Configuration | Sending behavior |
| --- | --- | --- |
| Email | Amazon SES (region, access key, verified sender, configuration set and SNS topic), or Cloudflare account ID, Email Sending API token and approved sender address; both take an optional sender name and reply-to address | One recipient per send, with a subject, required plain text and optional HTML. Transactional email only; replies go to the external receiving address. |
| SMS | Twilio Account SID, Auth Token, and either an international sender number or Messaging Service SID | Personalized text with an appended STOP instruction. Encoding and segment totals are estimates; Twilio determines delivery and charges. |
| WhatsApp | Zernio credentials, a project profile mapping, an active WhatsApp Business account, and an approved template/language | A scoped broadcast containing the explicitly selected phone numbers. The editor supports text variables, approved image/video/document headers using public HTTPS media URLs, and approved URL-button suffix values. |

Cloudflare explicitly limits Email Service to transactional messages. Promotional newsletters and bulk marketing email cannot be sent through this connection, even when a contact has opted in. Review [Cloudflare's current policy](https://developers.cloudflare.com/email-service/reference/faq/) and [sender setup](https://developers.cloudflare.com/email-service/get-started/).

### Amazon SES

Direct email uses whichever of **Amazon SES email** (region, access key, secret and sender address) and Cloudflare is configured. When both are, choose one with **Email provider** in the SES settings (`EMAIL_PROVIDER`, `ses` or `cloudflare`); until then email campaigns cannot be sent (`EMAIL_PROVIDER_REQUIRED`). Each campaign records the provider it was scheduled with, and changing the choice or either provider's settings stops a scheduled campaign for review. Sending uses [SES v2 SendEmail](https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_SendEmail.html) through `@ten98/runtime`, signed with AWS Signature Version 4. Each message carries the delivery ID as an `idempotency-key` tag for reconciliation; SES has no request deduplication, so an unconfirmed send marks the delivery uncertain and stops the campaign instead of resending. Throttling and a suspended, paused or unverified sender also stop the campaign for review.

Feedback arrives through an SNS topic in the same region. Set the topic's `SignatureVersion` to 2, subscribe `https://<your app>/api/webhooks/ses/sns` over HTTPS, and publish Bounce, Complaint and Delivery events to it from the configuration set. The webhook accepts only messages signed by the regional SNS certificate for the configured topic; it confirms that topic's subscription itself and records each message once.

- A permanent bounce or complaint suppresses the address for the project, as a Cloudflare hard bounce does. An unsubscribe recorded by SES applies the existing unsubscribe rule.
- Transient bounces count per recipient; the third within seven days suppresses the address. Each SES event counts once, however often SNS delivers it.
- A 5.7.x policy or reputation rejection describes the sender, so it raises a `policy` alert instead of suppressing the recipient. An undetermined bounce raises an `undetermined` alert and counts toward the transient threshold, but one alone never suppresses. SES alerts lapse a week after the latest report.
- An address already on the SES account suppression list marks the delivery suppressed without a local suppression.

The connection test reads the SES account and the sender domain's identity; it sends no email and does not test the SNS subscription. Use a least-privilege IAM user (`ses:SendEmail`, `ses:GetAccount`, `ses:GetEmailIdentity`).

Set **Reply-to address** in Integrations, or `CLOUDFLARE_EMAIL_REPLY_TO_ADDRESS`, to the address your team already receives. The app sends it using Cloudflare's [`reply_to` field](https://developers.cloudflare.com/api/resources/email_sending/methods/send/). To forward replies through Cloudflare, configure an Email Routing address, verify its group/mailbox destination, and enable that route in Cloudflare's dashboard. See [routing rules and verified destinations](https://developers.cloudflare.com/email-service/configuration/email-routing-addresses/). Google Groups or other group mailboxes must also permit the intended external messages. The app does not create these routing rules, read group mail, or maintain an email inbox. A successful sending connection test does not verify the reply route; test it separately with your receiving system.

WhatsApp templates, recipient tiers and fees depend on the connected account and Meta's rules. Loading a template does not establish that every recipient can receive it. Media must match the approved header format; Drive preview pages are not media files. Dynamic URL buttons accept the approved trailing variable while preserving the fixed public HTTPS origin. Flows, carousels and other advanced template components remain outside this editor. The [Zernio broadcast guide](https://docs.zernio.com/platforms/whatsapp/broadcasts) describes the provider workflow and per-recipient tracking.

## Set the public app address

Before sending, set `APP_URL` to the app's publicly reachable HTTPS origin and restart the service. Keep this origin consistent with your reverse proxy. Local preview addresses cannot provide usable recipient preference links or external delivery callbacks.

For Twilio, copy the project-specific **Incoming-message webhook URL** from **Unified inbox → SMS replies** and configure it on your sender or Messaging Service with HTTP POST:

```text
https://your-app.example/api/webhooks/twilio/inbound/PROJECT_ID
```

The app supplies a delivery-specific status callback URL when submitting SMS messages and inbox replies. Twilio requests are validated against their signature, configured account, exact public URL and intended recipient. Preserve the callback path, query and form data through the proxy. Configure [Twilio opt-out handling](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out) for your sender; Advanced Opt-Out supplies the `OptOutType` field. [Status callbacks](https://www.twilio.com/docs/messaging/guides/outbound-message-status-in-status-callbacks) describe delivery updates, not proof that someone read an SMS.

The legacy `/api/webhooks/twilio/inbound` route also works when the account/sender/recipient and outbound ledger identify exactly one project. If the same phone pair belongs to multiple projects, the global route stores only a hashed, unattributed receipt; it does not copy the message body into either inbox. A project-specific signed callback narrows attribution but still requires a prior outbound message in that project. Unknown senders do not create contacts or acquire consent. See the [SMS inbox guide](inbox.md#twilio-sms-conversations).

Email includes a signed preference link and unsubscribe headers. A GET opens a preference page; the explicit POST records suppression. Suppression is tied to the original destination so deleting or editing a contact cannot silently reactivate that address. Keep the application's session secret stable: replacing it invalidates existing signed links.

## Import and maintain contacts

Each project maintains its own contacts. Email addresses are normalized to lowercase; internationalized domains use their ASCII representation. Phone numbers must use E.164 format, such as `+971501234567`. Formatting checks do not establish that a number is assigned or a mailbox exists.

CSV files use these headers:

```csv
name,email,phone,company,tags
Alex Example,alex@example.com,+971501234567,Example Studio,launch|customer
```

Use at least an email or phone column. Quoted fields, embedded commas and doubled quotes are supported. Separate tags with `|` or `;`. The browser accepts up to 1 MB of CSV; the backend caps an import at 1,000 rows and 2 MB, within the project's 10,000-contact limit. Preview an import before applying it. Invalid rows are reported with row numbers and reasons; a malformed CSV is rejected. A storage failure rolls back the import.

Repeated canonical email addresses or phone numbers update one contact. Empty imported fields preserve existing values. If an email matches one contact and a phone matches another, the row is rejected; import never combines those identities automatically. Replacing an existing non-empty destination requires explicitly editing that contact.

Consent is separate for email, SMS and WhatsApp. Record the source of an explicit opt-in for each enabled channel. CSV columns cannot grant consent; use the import's explicit consent options only when you hold the evidence. Unchecked import options preserve existing consent. Changing an address revokes consent for its affected channels; save the new destination, then record its own opt-in. The app stores the evidence you enter and cannot independently prove consent.

## Check contact hygiene

Syntax checks reject unsupported addresses before saving. A bounded local list flags common disposable domains, common role addresses, and likely domain typos. These heuristics are incomplete. Role addresses are warnings; typo suggestions never rewrite an address automatically. Disposable addresses are excluded from email audiences.

An explicit DNS check processes at most 100 selected contacts, with four workers and a five-second overall deadline. Its outcomes mean:

| Result | Meaning |
| --- | --- |
| `mx` | The domain publishes a mail exchanger. |
| `implicit_mx` | No MX was found, but the domain has an A/AAAA fallback. |
| `null_mx` | The domain explicitly declares no mail service. |
| `nxdomain` | DNS reports that the domain does not exist. |
| `no_mx` | Neither MX nor an address fallback was found conclusively. |
| `unavailable` / `unchecked` | The result is incomplete, temporary, or not yet checked. |

Null MX, nonexistent domains and conclusive missing mail routes are excluded from email audiences. Unknown results remain visibly unverified. DNS never confirms mailbox existence, ownership, consent or eventual delivery. The A/AAAA fallback follows [SMTP routing rules](https://www.rfc-editor.org/rfc/rfc5321#section-5.1); explicit no-service records follow [Null MX](https://www.rfc-editor.org/rfc/rfc7505).

Hard bounces, provider suppression, unsubscribe links, SMS opt-outs and manual suppression prevent further sends on the affected channel. Destination hashes retain suppression through contact deletion and reimport. Editing a contact or importing another opt-in cannot clear it. This release has no automatic resubscribe workflow; resolve provider blocks and obtain fresh evidence through an explicitly reviewed process before any future reactivation feature is used.

Cloudflare lists some suppressions with an expiry: soft bounces for 24 hours and some hard bounces for 7 days. Campaign holds those contacts until the expiry and then sends to them again. It keeps their recorded consent, because the recipient did not withdraw it, and does not add the address to the permanent ledger. Complaints and permanent hard bounces have no expiry and stay permanent. Cloudflare does not document its `policy` reason, so a policy entry may describe the sender rather than the recipient. Campaign does not suppress the contact for it; the direct-messaging status reports it under `deliverabilityAlerts` for the project's owners to investigate with Cloudflare. A send that Cloudflare reports as suppressed is recorded on the delivery only; the next suppression sync applies Cloudflare's own reason and expiry.

Verified SMS STOP requests and Twilio's opt-out rejection retain a phone hash in an installation-wide suppression ledger. It protects current and future projects, campaign sends and individual SMS replies, even after contact deletion, reimport or sender configuration changes. Manual project suppressions remain project-scoped; older local records without verified opt-out provenance are not guessed to be global. The hash is a suppression key, not anonymized visitor analytics; treat it as private data. Receiving another message or START does not automatically reenable consent.

## Preview, schedule and monitor

Create a draft, choose contacts or tags, and preview the eligible audience, exclusions and personalized copy. Supported email/SMS placeholders are `{{name}}`, `{{email}}`, `{{phone}}`, and `{{company}}`. WhatsApp uses the approved template's explicit text values. SMS estimates include personalization and the STOP footer; they are not a price quote.

A campaign accepts 1–500 eligible contacts. Review a fresh preview before confirming provider charges. Email additionally requires confirmation that its content is transactional. A preview becomes stale when its content or relevant audience changes. Scheduling records a UTC instant; the interface accepts local time. Saving a draft or importing contacts does not send anything.

One sending worker runs at a time per installation (a PostgreSQL lease). The local queue checks once per second and handles one email/SMS recipient at a time. WhatsApp hands the approved batch to Zernio; provider pacing governs its subsequent delivery. Consent, suppression, destination, author access, provider credentials and project mapping are checked before dispatch. Connection or access changes stop the campaign for review.

Cancellation stops remaining local work and requests cancellation of an eligible provider broadcast. An already submitted message may still arrive. Accepted, queued, sent, delivered and read are distinct states. A completed local queue does not mean every recipient received a message. Refresh delivery details to read supported provider evidence; Cloudflare suppression refresh does not supply email opens or a complete asynchronous delivery history.

**Open replies** on an SMS or WhatsApp campaign opens its inbox view. Per-recipient navigation supplies a phone-number search, not proof of an exact conversation match. WhatsApp uses the existing Zernio account/feed; some business-specific participant IDs differ from phone numbers, so select the recognized conversation before replying. Outside its free-text reply window, use an approved template through the campaign flow. Twilio replies use durable local history and the original sender, with text-only sending and separate signed delivery updates.

Save an email/SMS draft, then choose **Use short links in message**, or open [Links & tracking](tracking.md), to prepare campaign URLs and downloadable QR codes. Shortening is explicit and affects text URLs, not media delivery URLs. URLs containing personalization placeholders remain unchanged. Review the changed message and audience again before sending. Website event totals and short-link visits are separate from provider delivery evidence.

If a request loses its acknowledgement, review the provider before starting another campaign for those recipients. A restart marks in-flight sends and interrupted WhatsApp preparation as requiring attention; it does not automatically replay them. Check known provider IDs, the actual recipient list and provider charges. Preserve the private database and matching secret in backups. Real delivery acceptance requires your configured credentials and approved sender accounts; automated tests use disposable databases and mocked provider responses.

The contacts-and-campaign workflow takes interface inspiration from [listmonk](https://listmonk.app/). No listmonk source code is copied or embedded. This application's original code remains [MIT licensed](../LICENSE).
