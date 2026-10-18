# Direct campaigns

Direct campaigns sends project-scoped transactional email, SMS, and approved WhatsApp templates. It includes contacts, CSV import, consent records, audience previews, scheduling, suppression, and delivery receipts. Voice calling and a unified inbox are not included. Incoming SMS callbacks retain opt-outs, not conversations.

## Connect the three channels

An instance operator configures credentials in **Integrations**. Use your own provider accounts; provider access, delivery limits, sender approval and charges apply independently of this application's MIT license.

| Channel | Configuration | Sending behavior |
| --- | --- | --- |
| Email | Cloudflare account ID, Email Sending API token, approved sender address, optional sender name | One recipient per send, with a subject, required plain text and optional HTML. This connection supports transactional email only. |
| SMS | Twilio Account SID, Auth Token, and either an international sender number or Messaging Service SID | Personalized text with an appended STOP instruction. Encoding and segment totals are estimates; Twilio determines delivery and charges. |
| WhatsApp | Zernio credentials, a project profile mapping, an active WhatsApp Business account, and an approved template/language | A scoped broadcast containing the explicitly selected phone numbers. The editor supports text variables, approved image/video/document headers using public HTTPS media URLs, and approved URL-button suffix values. |

Cloudflare explicitly limits Email Service to transactional messages. Promotional newsletters and bulk marketing email cannot be sent through this connection, even when a contact has opted in. Review [Cloudflare's current policy](https://developers.cloudflare.com/email-service/reference/faq/) and [sender setup](https://developers.cloudflare.com/email-service/get-started/).

WhatsApp templates, recipient tiers and fees depend on the connected account and Meta's rules. Loading a template does not establish that every recipient can receive it. Media must match the approved header format; Drive preview pages are not media files. Dynamic URL buttons accept the approved trailing variable while preserving the fixed public HTTPS origin. Flows, carousels and other advanced template components remain outside this editor. The [Zernio broadcast guide](https://docs.zernio.com/platforms/whatsapp/broadcasts) describes the provider workflow and per-recipient tracking.

## Set the public app address

Before sending, set `APP_URL` to the app's publicly reachable HTTPS origin and restart the service. Keep this origin consistent with your reverse proxy. Local preview addresses cannot provide usable recipient preference links or external delivery callbacks.

For Twilio, configure the incoming-message webhook on your sender or Messaging Service as:

```text
https://your-app.example/api/webhooks/twilio/inbound
```

The app supplies a delivery-specific status callback URL when submitting SMS messages. Twilio requests are validated against their signature, configured account, exact public URL and intended recipient. Preserve the callback path, query and form data through the proxy. Configure [Twilio opt-out handling](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out) for your sender; Advanced Opt-Out supplies the `OptOutType` field. [Status callbacks](https://www.twilio.com/docs/messaging/guides/outbound-message-status-in-status-callbacks) describe delivery updates, not proof that someone read an SMS.

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

## Preview, schedule and monitor

Create a draft, choose contacts or tags, and preview the eligible audience, exclusions and personalized copy. Supported email/SMS placeholders are `{{name}}`, `{{email}}`, `{{phone}}`, and `{{company}}`. WhatsApp uses the approved template's explicit text values. SMS estimates include personalization and the STOP footer; they are not a price quote.

A campaign accepts 1–500 eligible contacts. Review a fresh preview before confirming provider charges. Email additionally requires confirmation that its content is transactional. A preview becomes stale when its content or relevant audience changes. Scheduling records a UTC instant; the interface accepts local time. Saving a draft or importing contacts does not send anything.

Run one application process with SQLite. The local queue checks once per second and handles one email/SMS recipient at a time. WhatsApp hands the approved batch to Zernio; provider pacing governs its subsequent delivery. Consent, suppression, destination, author access, provider credentials and project mapping are checked before dispatch. Connection or access changes stop the campaign for review.

Cancellation stops remaining local work and requests cancellation of an eligible provider broadcast. An already submitted message may still arrive. Accepted, queued, sent, delivered and read are distinct states. A completed local queue does not mean every recipient received a message. Refresh delivery details to read supported provider evidence; Cloudflare suppression refresh does not supply email opens or a complete asynchronous delivery history.

If a request loses its acknowledgement, review the provider before starting another campaign for those recipients. A restart marks in-flight sends and interrupted WhatsApp preparation as requiring attention; it does not automatically replay them. Check known provider IDs, the actual recipient list and provider charges. Preserve the private database and matching secret in backups. Real delivery acceptance requires your configured credentials and approved sender accounts; automated tests use disposable databases and mocked provider responses.

The contacts-and-campaign workflow takes interface inspiration from [listmonk](https://listmonk.app/). No listmonk source code is copied or embedded. This application's original code remains [MIT licensed](../LICENSE).
