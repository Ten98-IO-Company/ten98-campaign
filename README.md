# ten98 Campaign

An open-source, self-hosted campaign manager for social publishing, online advertising, messaging, out-of-home media, digital assets, and campaign planning. Workspaces contain projects; workspace membership controls access to every project in that workspace.

Version 0.3 uses Zernio for social, advertising, inbox, and analytics; Google Drive for the DAM; Google Calendar for shared planning; Broadsign for OOH proposals and bookings; Google Maps for locations; and OpenRouter for an optional campaign assistant. It includes integration configuration and connection tests, team invitations, content approvals, and provider-operation reconciliation. The application is [MIT licensed](LICENSE). Provider accounts, API access, media spending, and model usage remain subject to their providers' terms and charges.

![Campaign workspace](docs/preview.png)

## Run locally

Requires **Node.js 22.14+** and npm. The Docker image uses Node 24. SQLite is included with Node; some versions print an experimental SQLite warning.

```sh
npm ci
cp .env.example .env
npm run build
npm start
```

Open [http://127.0.0.1:3018](http://127.0.0.1:3018) and create the first owner account. This account is also the instance operator. Public signup then closes. Optional sample records are marked and excluded from live publishing and calendar-plan sync. Owners/admins can remove all sample data from Project settings; cleanup refuses when your own work still refers to a sample record. Assigned campaigns, assets, and media providers must be unassigned before deletion so drafts and bookings keep valid references.

For development, run `npm run dev` and open [http://127.0.0.1:5178](http://127.0.0.1:5178). The runner starts the API and Vite with the matching browser origin. Configure provider credentials in **Integrations**, or use `.env` as an operator-managed fallback. Changes saved in the app apply immediately; Google Maps browser changes require a page reload. Editing `.env` requires restarting the server. Keep `.env` and `data/` private.

## Included workflows

| Area | Available behavior |
| --- | --- |
| Campaigns | Workspace/project organization, roles, dates, budgets, separate currency totals, local results, and CSV export. |
| Social | Multi-channel drafts, content approvals, explicit publish/schedule submission, provider status reconciliation, rescheduling, cancellation, eligible retries, and supported published-copy changes. Zernio executes submitted schedules. |
| Advertising | Campaign/ad-group/ad reporting; supported status, budget, targeting, and creative changes; paused ad creation and eligible post boosting. |
| Inbox | Project-scoped direct messages, message history, replies and archiving, signed durable webhooks, and manually loaded organic comment/review feeds with supported replies. |
| OOH | Local provider/booking ledger, verified Broadsign inventory, proposals, availability, explicit booking/cancellation, delivery totals, and mapped locations. |
| DAM | Asset links, public delivery URLs, tags, approvals, Google Drive metadata sync, and Shared Drive uploads. Originals remain in Drive. |
| Planning | Local publishing calendar and optional Google Calendar events and campaign-plan publishing. |
| Analytics | Campaign totals and Zernio social dashboards, daily metrics, and top posts; missing live values remain unknown. |
| Assistant | OpenRouter tool calls over the current project, optional inbox snippets, usage reporting, and draft suggestions saved only after review. |
| Team and account | Workspace invitations, roles, local/OIDC sign-in, account details, local password changes, and session revocation. |
| Integrations | Encrypted saved configuration, explicit read-only connection tests, project mappings, and audited handling of uncertain provider outcomes. |

## Integration settings

The **Integrations** page configures Zernio, OpenRouter, Google Drive, Google Calendar, Google Maps, and Broadsign. Only an **instance operator** can read or change installation-wide credentials and run connection tests. Operators also need workspace owner/admin access to change a project's Zernio profile, Drive folder, or shared calendar mapping. Workspace ownership alone does not grant installation credentials access.

Saved fields override their server environment values. A blank secret field keeps its current credential; **Clear this credential** explicitly disables that field, including environment fallback. **Use server environment** removes that provider's saved overrides. Drive and Calendar share one service account, so saving, clearing, or resetting its credentials affects both. Credentials are not returned in settings responses; the Google Maps key is separately available to authorized project members because Google's browser service requires it.

Settings are encrypted in SQLite using AES-256-GCM and a key derived from the instance session secret. Back up the database **with the matching `SESSION_SECRET` or generated `data/session-secret`**. Replacing that secret without preserving its match makes saved integration settings unreadable. Protect the complete data directory, including backups.

**Test connection** runs only when requested. Zernio checks accessible profiles, OpenRouter checks key access without generating a model completion, Drive checks the saved folder, Calendar checks the saved calendar's read access, and Broadsign checks its account/domain. These checks do not publish, send, upload, book, change events, or verify every write permission. Maps performs a browser map-rendering check after any required page reload; configuration alone is not reported as a verified map connection. Save project mapping edits before testing.

## Zernio: social and advertising

Configure Zernio in **Integrations** or set `ZERNIO_API_KEY`. Create a Zernio profile for each project, then have an **instance operator who also administers that workspace** map its profile ID. Connect supported channels in the app; use Zernio's dashboard for provider-specific credential flows, including OpenAI Ads. Load connected accounts before publishing or creating ads.

The ad editor supports these formats, subject to the connected account's permissions and Zernio availability:

| Network | Creation formats |
| --- | --- |
| Meta | Image, video, carousel; supported conversion and lead-form objectives. |
| Google | Search, Display, Performance Max, and Demand Gen image/video/carousel assets. |
| TikTok | Video. |
| LinkedIn | Image and video; supported lead forms. |
| Pinterest | Image. |
| X | Website card. |
| Reddit | Image, video, carousel, and text. |
| OpenAI / ChatGPT | Sponsored card with supported bidding and objectives. |

New ads and boosts start **paused**. Budgets use the advertising account's currency and daily budget rules. Review conversion tracking, targeting, creative approval, and provider-side settings before activation. Supported campaign/ad-group budgets, ad edits, targeting lookup, and status controls are available through Ads manager; unsupported combinations return an error. Lifetime budgets, niche creative types, custom-audience management, conversion installation, and comprehensive bulk editing remain provider-dashboard workflows. The Zernio API supports more options than this editor exposes. [Zernio ad creation contract](https://docs.zernio.com/ad-campaigns/create-standalone-ad).

Every provider action checks project/account scope. Mutating requests use persistent idempotency records; uncertain outcomes block duplicate submissions, including attempts with a fresh key. Use the provider-operation review panel in **Settings** to reconcile an interrupted action after checking the actual provider outcome. See deployment and operations below.

Pinterest, LinkedIn, and X campaign status changes currently show provider acknowledgement without a live status readback; other supported networks return a verified status when available.

Social media and ad creatives need public HTTPS delivery URLs. Private Drive previews remain DAM references and cannot be submitted as publishable binaries. Sample posts and assets cannot be sent to live publishing providers.

## Social post lifecycle and approvals

Submitted posts have provider controls in Publishing. Unpublished provider drafts and schedules can be updated or rescheduled; eligible unpublished copies can be cancelled with explicit confirmation. Only fully failed posts can be retried immediately, with a fresh provider status check to avoid duplicating partially published content.

| Published-copy action | Supported platforms, subject to Zernio and account permissions |
| --- | --- |
| Edit text | X, Discord, Facebook, Reddit, LinkedIn, Telegram, Pinterest, Google Business Profile, YouTube, Slack. |
| Unpublish a selected copy | Threads, Facebook, X, LinkedIn, YouTube, Pinterest, Reddit, Bluesky, Google Business Profile, Telegram. |

Other provider changes remain in the native dashboard. Confirmations distinguish deleting an unpublished provider record from permanently removing a published copy.

**Approvals** has an optional project policy, disabled by default. Owners/admins can require review; editors request it, and owners/admins approve or request changes with an audited actor, time, and note. Review covers the exact content, platforms/accounts, effective media, campaign/asset references, and schedule. Asset delivery/original URLs, approval state, type, and available Drive file version/checksum metadata are included. Relevant changes invalidate approval; cosmetic asset names and tags do not. Referenced assets must also be approved.

Approval never publishes automatically. With the policy enabled, publishing and retries need current approval, while changes to submitted post content are restricted to owners/admins. Editors retain explicitly confirmed stop/removal controls. A provider post with every copy confirmed failed can receive a fresh review after its latest provider content is reconciled; partially live posts cannot use that path.

## Zernio inbox webhooks

Set a strong `ZERNIO_WEBHOOK_SECRET`, then register **`https://your-app.example/api/webhooks/zernio`** in Zernio using the same secret. The endpoint must be publicly reachable over HTTPS. Configure its profile filter to match this installation's projects.

Subscribe to the needed inbox events: `message.received`, `message.sent`, `message.edited`, `message.deleted`, `message.delivered`, `message.read`, `message.played`, `message.failed`, `conversation.started`, and `conversation.control_changed`. Post lifecycle and per-platform terminal events also update existing linked posts. Platform support varies. [Zernio delivery, signatures, and subscriptions](https://docs.zernio.com/webhooks); [inbox payload contracts](https://docs.zernio.com/webhooks/inbox).

The receiver verifies the raw-body HMAC-SHA256 signature before parsing, accepts up to 1 MB, persists events before acknowledgement, and deduplicates by the stable event UUID. A local worker processes pending events and resumes after restart. Use **one unique Zernio profile per project**: unmapped or ambiguous profile mappings stay pending instead of routing messages to another project. Routing uses provider profile IDs, never arbitrary event metadata. Delayed legitimate deliveries remain valid; replay protection comes from durable deduplication.

Cached conversations expose the latest 500 webhook messages; normalized message history and bounded event payloads remain in the private database. REST history reads up to 100 messages per page with explicit older-page loading. Loaded older messages remain visible when webhook updates arrive, and current deletion/receipt updates take precedence. Webhooks do not backfill earlier history. Reactions, test deliveries, and other unsupported events are acknowledged without creating live DMs. Subscribe to `comment.received`, `review.new`, and `review.updated` for durable change notices in their respective feeds; these events never create DMs or trigger paid provider polling. Attachment references are retained; expiring CDN links and authenticated WhatsApp media are not downloaded into permanent storage. Direct messaging includes Messenger through Zernio.

The inbox also has manually refreshed **Comments** and **Reviews** feeds. Organic comments are supported for Facebook, Instagram, X, Bluesky, Threads, YouTube, LinkedIn, Reddit, and TikTok; reviews for Facebook and Google Business Profile. Load the account's feed before opening its threads or replying. Lists and supported thread pages use provider cursors, and reply permissions remain platform-specific. Replies are explicit user actions; replacing an existing review reply requires a separate confirmation. Signed comment/review events show a reload notice for the selected account. Reloading the feed remains an explicit action; ad comments and reactions still require the provider dashboard. Resolved direct-message conversations can be reopened, and replies/archive/reopen require a confirmed provider acknowledgement. [Zernio inbox API](https://docs.zernio.com/).

## Google Drive DAM

Enable the Drive API, configure the service account in **Integrations** (or set `GOOGLE_SERVICE_ACCOUNT_EMAIL` and `GOOGLE_PRIVATE_KEY`), and share a folder with it. An instance operator with workspace administration maps the folder ID. Choose **Sync Drive** in the asset library.

Sync stores metadata and original links without making files public. It lists the mapped folder directly, without recursion, up to 2,000 files across 20 pages; an incomplete search does not produce a partial sync. Uploads require a folder in a **Google Shared Drive** and accept JPG, PNG, WebP, GIF, MP4, PDF, or text up to 5 MB. Tokens stay server-side. [Drive API](https://developers.google.com/workspace/drive/api/guides/about-sdk); [service-account authorization](https://developers.google.com/identity/protocols/oauth2/service-account).

An asset's optional **public delivery URL** supplies publishable media while preserving its Drive original. The app does not grant public Drive permissions or host a delivery CDN. When sync detects changed file metadata/checksum, it resets that asset's approval to pending; associated content approval also becomes stale. Keep public media permissions and usage rights under your control.

## Google Calendar

Enable the Calendar API for the same service account. Share a dedicated calendar with that account and grant event editing permission. In Integrations or Calendar, an instance operator with workspace administration maps its calendar ID; a calendar can belong to only one project.

**Load Google events** reads the selected range. Editors can create events and change or delete events managed by that project; unrelated calendar events are read-only. **Publish campaign plan to Google** explicitly creates or updates dated campaigns, OOH placements, and scheduled posts with stable IDs. Sample records are excluded. It does not delete stale plan events or publish social posts.

The plan is capped at 100 dated records, list reads at 2,500 events, and explicit date windows at 366 days. All-day event end dates are exclusive; inclusive campaign/placement end dates are converted accordingly. Scheduled posts occupy 30-minute planning slots. Writes suppress attendee notifications. [Calendar event API](https://developers.google.com/workspace/calendar/api/guides/create-events).

## Broadsign OOH

Configure Broadsign in Integrations or set `BROADSIGN_API_KEY`, starting with `BROADSIGN_ENVIRONMENT=sandbox`; use `production` only with the corresponding production account. Optionally pin its domain with `BROADSIGN_DOMAIN_ID`. The app uses fixed Broadsign endpoints and API-key authentication. In the OOH provider panel, an instance operator with workspace administration approves the verified domain, client, and an explicit allowlist of up to 100 screen/face IDs. Inventory cannot overlap another project in the same domain/environment. Existing bookings lock changes to that mapping. Sandbox and production resource IDs differ. [Broadsign API keys](https://docs.broadsign.com/broadsign-platform/en/Documentation_Settings/settings-api-keys.html); [campaign API workflow](https://docs.broadsign.com/broadsign-platform/en/Documentation_Gteed_Campaigns/g-c-new-campaign-rest.html).

Sync the approved inventory, select locations, enter the provider quote, and save a proposal. Availability is checked separately. Booking submission requires the user's explicit paid-booking confirmation and rechecks the provider's domain, client, line items, screens, dates, and quote. The provider reports final booking status. Ambiguous or partly created operations require reconciliation in Broadsign.

The integration creates one frequency line item for the selected digital screens or static faces: **one play per loop, every day, full-day scheduling**, with a booking range of at most 366 days. Refreshing delivery reads aggregate impressions/plays and updates project placements. The provider quote belongs to the whole line item; per-screen cost and currency are kept unknown rather than allocated or inferred.

Eligible submitted, booked, or live proposals offer an explicitly confirmed cancellation request. The app reads back the provider status: **12 confirms cancelled; 15 means cancellation is still in progress**. Delivery may continue until confirmation. Charges and refunds depend on the media provider's terms; cancellation does not imply either a refund or no charge.

Use the proposal ID and the in-app handoff to [Broadsign Guaranteed Campaigns](https://app.broadsign.com/campaigns) to upload, approve, and schedule creative bundles in its separate creative module. Raw proof-of-play logs require a separate Broadsign Control/POP integration. Dayparting and broader OOH marketplace/payment APIs remain provider workflows. Local manual bookings and proof links are also available.

## Google Maps

Enable Maps JavaScript API and billing in your Google Cloud project, then configure its browser key and map ID in Integrations or through `GOOGLE_MAPS_BROWSER_API_KEY` / `GOOGLE_MAPS_MAP_ID`. This key is **public in the browser by design**: restrict it to that API and your exact allowed HTTP referrers, including development origins only when needed. Use your own production map ID; the fallback `DEMO_MAP_ID` is for evaluation. Reload the page after saving Maps settings, then choose **Test connection** for a real map-rendering check. [Key restrictions](https://developers.google.com/maps/api-security-best-practices); [map IDs](https://developers.google.com/maps/documentation/javascript/map-ids/mapid-over).

The map shows provider-supplied coordinates and team-entered placement coordinates. Enter both latitude and longitude; no automatic geocoding is performed. Provider locations are labeled separately. When Maps is enabled, the app uses a per-response script nonce and Google-compatible content/referrer policies. The server-side service-account private key is never returned as map configuration.

## OpenRouter campaign assistant

Configure OpenRouter in Integrations or set `OPENROUTER_API_KEY` and a tool-capable `OPENROUTER_MODEL`. The assistant runs orchestration and project tools on this application server; **model inference runs remotely through OpenRouter**. Submitted prompts and requested project context leave the server. Inbox snippets are shared only when the user opts in for that request. [OpenRouter tool calling](https://openrouter.ai/docs/guides/features/tool-calling).

The assistant can read scoped campaign/post/placement/asset data and propose local drafts. It cannot publish, send replies, activate ads, or book inventory. Users review each suggestion before saving it; saved suggestions are validated through the normal record rules. The default request loop allows four model calls and 2,048 completion tokens per call, configurable through `OPENROUTER_MAX_STEPS` (maximum eight) and `OPENROUTER_MAX_TOKENS` (maximum 8,192).

History records the provider-reported token usage and cost; unavailable usage remains unknown. A failed connection can leave a billable outcome uncertain, so duplicate attempts are blocked until the user reviews the request in OpenRouter and marks it reviewed. [Usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting). Model quality and tool support depend on the chosen model.

## Authentication and team access

Roles are owner, admin, editor, and viewer. Workspace owners/admins manage existing members; instance operators separately control shared integration mappings. Local authentication uses password hashes, hashed sessions, and login rate limits. Session and OIDC browser cookies are scoped by configured app origin so separate local instances can coexist. Valid legacy sessions migrate without extending their expiry.

In Settings, owners/admins create **seven-day, single-use invitation links** and copy them to the intended person manually; the app does not send invitation email. Administrators can invite editors/viewers; only owners can grant owner/admin access. A new local member chooses their own password. An existing member must sign in with the matching invited identity; a link cannot replace their password or grant instance-operator authority. Revoked, expired, used, and no-longer-authorized invitations fail closed.

Account settings allow changing a display name, changing a local password after verifying the current password, and signing out other sessions. Local password changes revoke prior sessions and issue a current session. For a forgotten local password, the server operator can use the recovery CLI below; OIDC password recovery and MFA belong to the identity provider.

For OIDC, configure `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, and the exact callback `APP_URL/api/auth/oidc/callback`. Issuers require HTTPS. `OIDC_ALLOWED_EMAILS` allows new accounts with verified email addresses; those accounts receive separate workspaces until invited to a team. An invitation can be resumed after the OIDC redirect. Identities are keyed by issuer and subject. Matching emails do not automatically link local and OIDC accounts. The code uses authorization code flow, PKCE, state, nonce, and token validation through [openid-client](https://github.com/panva/openid-client).

Provision a local account using the operator CLI, supplying one JSON object on standard input:

```sh
node --env-file-if-exists=.env server/cli.mjs create-user
```

Input: `{"name":"Team member","email":"member@example.com","password":"a unique password of at least 12 characters"}`. Use a secure terminal or password-manager pipe, keeping real passwords out of shell arguments and history. The new account has no workspace membership until invited. The `grant-operator` command accepts `{"email":"operator@example.com"}` on standard input and grants instance authority without workspace membership.

To recover a local password, run `node --env-file-if-exists=.env server/cli.mjs reset-password` with `{"email":"member@example.com","password":"a new unique password of at least 12 characters"}` on standard input. It works only for an existing local password account and revokes **all** that account's sessions. It cannot reset an OIDC identity's password. Operator access to the host and private data directory is required.

## Deployment and operations

For Docker, configure `.env`, run `docker compose up --build -d`, and complete first-run setup locally. Compose binds port 3018 to loopback. Place the service behind an HTTPS reverse proxy and set `APP_URL` to the exact public origin before exposure; HTTPS enables secure session cookies. Forward the webhook route without changing its request bytes. The health endpoint is `GET /api/health`.

Run one application process with the current SQLite store. Back up the entire private data directory and matching instance session secret using a consistent SQLite backup or stopping the app before copying files. Event payloads, messages, AI history, invitations, approval snapshots, encrypted credentials, and integration operations are stored there; retention and deletion policies need operator management. Startup, local status checks, and health checks make no paid provider requests; enabling a Google map loads Google's browser service when the map view opens.

The **Settings** provider-operation panel prioritizes unconfirmed requests alongside recent receipts for an instance operator who also administers the workspace. Check the actual provider dashboard before reviewing an uncertain or interrupted outcome, then record a final decision, note, and optional reference. **Applied** keeps repeating that action blocked. **Not applied** permits a new manual attempt with a new action key; the original key remains closed. Reviews do not replay a request, refund a payment, invent a provider result, or update a campaign automatically. Active requests cannot be reviewed; interrupted requests from the same server session have a safety delay. OpenRouter requests use their separate usage-review controls in the assistant.

## Checks and current limits

See the [v0.3.1 verification record](docs/verification.md) for the browser walkthrough and tested scope.

```sh
npm run build
npm test
```

CI builds and runs native Node regression tests against temporary databases/HTTP servers and mocked provider responses. Coverage includes authentication, invitations, session/account controls, encrypted integration settings, project isolation, content approvals, provider reconciliation, engagement replies, signed webhook replay/order/restart behavior, ad formats, Broadsign contracts, Google Calendar/Drive, and agent review/usage flows. **CI makes no paid API calls.** Successful tests verify application behavior and mocked contracts; they do not establish live acceptance by Zernio, an ad account, Google, Broadsign, OpenRouter, or an identity provider. Use the explicit connection tests and verify intended live workflows with your own accounts before production use.

Provider coverage follows the exposed API contracts and account permissions. Rare ad formats, comprehensive bulk/audience tooling, raw OOH proof-of-play, automated retention, and high-availability storage are outside this release. Large views expose pagination or explicit limits. Use the OIDC provider for MFA; local email-based password recovery and automatic invitation delivery are not configured. The application uses one server process with SQLite.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The Zernio [ads dashboard](https://github.com/zernio-dev/ads-dashboard) and [unified inbox](https://github.com/zernio-dev/unified-inbox) informed the workflows; they are referenced rather than embedded as separate applications.
