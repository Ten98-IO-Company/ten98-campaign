# Full Zernio feature support: scope and delivery breakdown

Prepared 18 October 2026. Application baseline: **v0.8.4**. Provider baseline: **Zernio OpenAPI 1.292.0**.

Full Zernio support is the target. **The app does not provide it yet.** Existing publishing, ads, inbox and direct-campaign workflows cover useful subsets; the missing workflows below are implementation work, not completed features. The latest audit fixes are released separately in [PR #11](https://github.com/Ten98-IO-Company/ten98-campaign/pull/11).

## Scope and evidence

The target is every available, public, non-deprecated Zernio capability with a usable, permission-checked interface. It includes platform-specific controls, account setup, edits, reporting, webhooks, failures and recovery. An HTTP helper, platform name or API connection alone does not count as full support. Features that the underlying platform does not expose cannot be reproduced by adding a form.

The [official reference](https://docs.zernio.com/api-reference) and [OpenAPI download](https://docs.zernio.com/api/openapi) are the provider sources. The pinned snapshot contains **966 HTTP operations across 631 paths**, including **23 deprecated operations**. These are API counts, not distinct product features or an implementation percentage. Webhook payload schemas are not counted as callable operations. The [complete operation inventory](zernio-api-inventory.csv) records method, path, operation ID, family, resource group and deprecation; it contains no credentials or copied API descriptions.

Snapshot SHA-256: `324a4675b576bbd15f7f1f7c60397d5832b76e49fd976479028b22cd572d728d`.

| Status | Meaning |
| --- | --- |
| Implemented | A named action has a reachable UI and validated server flow. Its wider API family may still be partial. |
| Partial | A working subset exists; the linked breakdown identifies omissions. |
| Missing | The current app has no complete corresponding workflow. |
| Unavailable/gated | Zernio or the platform restricts it; show the reason and required approval rather than a false success. |
| Excluded | An earlier explicit user decision still applies. |

Each domain report below contains current code anchors, capability rows, primary references and acceptance work. Reports are a source-reviewed snapshot, not new live-provider certification.

## Product modules

| Module | Current state | Required completion |
| --- | --- | --- |
| Connections and account administration | Partial | Profile management, complete OAuth/credential/selection flows, reconnect/disconnect, account health, settings and groups. Preserve project isolation when accounts move. [Social breakdown](zernio-social-coverage.md) |
| Social publishing | Partial | Complete all supported platform formats/options, lookups and selectors, external-post discovery/import, bulk operations, provider queues, native edits and supported deletion. Existing separate captions/media, previews, scheduling and approvals remain the foundation. [Social breakdown](zernio-social-coverage.md) |
| Paid ad creation and management | Partial | Extend the eight managed networks beyond the current formats; support full campaign/ad-set/ad hierarchy, duplication, attachments/assets and permitted edits. [Ads breakdown](zernio-ads-coverage.md) |
| Creative library and research | Partial/missing | Reusable creative library, image/video lifecycle, rendered previews, partnership permissions and public ad-library research. Existing media URLs are a subset. [Ads breakdown](zernio-ads-coverage.md) |
| Audiences and targeting | Partial | Customer uploads, supported engagement/website/lookalike/company audiences, saved presets, exclusions, reach/forecast/bid tools and platform-specific selectors. [Ads breakdown](zernio-ads-coverage.md) |
| Pixels, conversions and attribution | Mostly missing | Supported tracking tags/events, installation, diagnostics, matching quality, conversion adjustments and consent-aware server events. Existing UTM/short-link tracking is separate. [Ads breakdown](zernio-ads-coverage.md) |
| Leads and catalogs | Missing | Instant forms, leads/webhooks, catalog/product/feed/set management, store sync and campaign use. Lead capture must create/update a contact without inventing outreach consent. [Ads](zernio-ads-coverage.md), [stores](zernio-commerce-admin-coverage.md) |
| Paid/social analytics | Partial | Account/post/platform specialist reports, demographics, retention, timing, comparisons, breakdowns, asynchronous exports, missing/stale data and provider account operations. [Social](zernio-social-coverage.md), [ads](zernio-ads-coverage.md) |
| Unified inbox | Partial | Complete search, starting conversations, rich messages, supported message edits/deletion/reactions, attachments and control handover. [Messaging breakdown](zernio-messaging-coverage.md) |
| Comments, mentions and reviews | Partial | Supported engagement/moderation actions, private replies, mentions, additional filters and platform-specific actions. [Messaging breakdown](zernio-messaging-coverage.md) |
| WhatsApp suite | Partial | Advanced templates and lifecycle, Flows, interactive/commerce messages, catalogs, business settings, quality/tier health, sandbox, groups and conversion analytics. [Messaging breakdown](zernio-messaging-coverage.md) |
| Contacts and direct campaigns | Partial | Link local identities to Zernio contacts/channels, custom fields/segments and all supported platform broadcasts. Keep local consent, suppression and Twilio delivery paths. [Messaging breakdown](zernio-messaging-coverage.md) |
| Automations | Missing | Sequences, branching workflows, comment-to-DM funnels, run history, versioning, handover and stop conditions. Use Zernio execution; do not create a second automation engine. [Messaging breakdown](zernio-messaging-coverage.md) |
| Community and business profiles | Partial | Discord administration, Telegram/Slack account tools, Google Business location/media/services/menus/attributes/actions/verification and supported social discovery/engagement. [Social](zernio-social-coverage.md), [messaging](zernio-messaging-coverage.md) |
| Blogs and commerce | Missing | Shopify/WordPress onboarding, articles and native scheduling; supported products, variants, stock, collections, discounts, market pricing, custom content and store attribution. [Store breakdown](zernio-commerce-admin-coverage.md) |
| RCS, iMessage and Zernio SMS | Partial basic inbox adapters | Sender/agent lifecycle, rich campaign formats, opt-in audience, compliance states, channel fallback and receipts. Add Zernio SMS alongside Twilio; do not silently migrate existing campaigns. [Additional channels](zernio-commerce-admin-coverage.md) |
| Webhooks and operations | Partial | Endpoint setup/testing/logs/redelivery, every relevant event family, diagnostics, provider usage/billing and public API change tracking. [Messaging](zernio-messaging-coverage.md), [administration](zernio-commerce-admin-coverage.md) |
| Provider support and optional business agent | Missing | Explicit paid support runs and provider-native Meta Business Agent setup/knowledge/tools/evaluation where eligible. Keep these separate from OpenRouter creative drafting. [Administration](zernio-commerce-admin-coverage.md), [messaging](zernio-messaging-coverage.md) |

## Platform coverage target

Social publishing must cover each available format and option for Facebook, Instagram, X, LinkedIn, TikTok, YouTube, Pinterest, Threads, Bluesky, Reddit, Google Business Profile, Telegram, Discord and Slack. WhatsApp uses the dedicated messaging/direct-campaign workflows. Snapchat remains a gated/unavailable connection in the current primary guide; it must not be advertised as generally available. The [platform matrix](zernio-social-coverage.md) separates common posting from specialist actions.

Paid advertising targets **Meta, Google, TikTok, LinkedIn, Pinterest, X, Reddit and OpenAI/ChatGPT**. Coverage is per network and operation, not a promise that every network has the same formats or controls. Additional tracking-only connections such as Whop are separate from managed campaign networks. See the [network matrix](zernio-ads-coverage.md).

RCS and iMessage are messaging products, not extra destinations in a public social-post picker. Shopify and WordPress use store/blog flows. Microsoft Advertising remains the separately approved native integration; it is not a Zernio-managed ninth ad network. [Additional product boundaries](zernio-commerce-admin-coverage.md)

## Delivery sequence

This is the proposed implementation order. No stage below is marked complete by this document. Expand existing components and shared validation/operation helpers; add a module only when the workflow needs a distinct screen.

| Stage | Deliverable | Dependencies and completion check |
| --- | --- | --- |
| 1. Current-contract fixes and connection foundation | Reconcile discovered Reddit pixel/boost gaps, Snapchat availability and platform-limit drift; complete scoped connect/reconnect/health, selectors and capability states. | First resolve conflicting docs against the pinned operation schema. Tests must reject unsupported combinations and wrong-project accounts before a provider write. |
| 2. Complete paid campaign controls | Network-specific objectives/formats, campaign trees, assets/extensions, creative library, duplication and supported bulk operations. | Stage 1. Validate, create paused, reload exact remote IDs/state and preserve partial/uncertain outcomes. Prioritize Google Search/Shopping, Microsoft and ChatGPT regression coverage. |
| 3. Measurement and acquisition | Audiences, pixels/events, server conversions, leads, catalogs and rich ad reports. | Campaign identity plus scoped permissions. Verify installation/event IDs, deduplication, consent, asynchronous report states and lead/contact attribution. Local QR counts must remain distinct. |
| 4. Complete publishing and analytics | Remaining platform-specific content/actions, queues, bulk import, native-post discovery, media workflows and specialist analytics. | Connection capabilities; reuse approval and per-platform snapshot checks. Schedule, edit, cancel, publish/fail/retry and webhook reconciliation must have end-to-end evidence. |
| 5. Engagement and WhatsApp | Rich inbox, search/new conversations, mentions/moderation, advanced templates, Flows, quality settings and business tools. | Account policy/windows and media readiness. Verify replies with the intended sender, template lifecycle and unsupported/expired action states. |
| 6. Contacts and automation | Provider identity mapping, segmentation, broadcasts, sequences, comment automation and workflow runs. | Stage 5 and consent mapping. Verify stop-on-reply/unsubscribe, preview, activation, execution history, version changes and uncertain send recovery. |
| 7. Stores and additional channels | Blogs/commerce, catalog sync, Zernio SMS, RCS and iMessage sender/campaign lifecycle. | Provider capabilities, reviewed grants, approved senders and cost visibility. Test fallback and carrier/store failures with synthetic fixtures; live acceptance uses designated test accounts. |
| 8. Administration and release closure | Complete provider logs/usage/support, webhook administration, change tracking and cross-module acceptance. | All relevant event families and role boundaries. Every included operation must map to a workflow and a test or an explicit unavailable/excluded reason. |

Stage 1 contains newly identified compatibility gaps, not fixes included in v0.8.4. The detailed reports record the evidence and uncertainty for each one.

The next planned implementation increment is deliberately smaller than Stage 1: reconcile the Reddit pixel requirement for existing create paths and Snapchat's advertised availability, with focused request-shape/capability regressions and a browser walkthrough. Do not add unrelated formats or rewrite OAuth in that increment. Resolve the Instagram/Facebook limit disagreements against current provider validation before changing either shared rule. The remaining connection work follows as separate increments.

## UI structure

Use a small stable navigation: **Overview, Campaigns, Publishing, Ads, Engagement, Direct campaigns, Library, Insights and Settings**. Put platform-specific tools inside the selected account or campaign. Put automations under Engagement/Direct campaigns, store content under Library, and provider administration under Settings. This is a proposed structure; this document does not change the current navigation.

Show only relevant controls for the selected platform, format, account permissions and provider availability. Use plain task labels such as **Draft copy**, **Review**, **Schedule**, **Reply** and **Connection health**. An optional model or business agent belongs in its real task, with cost and approval controls; it does not justify extra promotional panels or decorative AI labels.

## Definition of complete

For each included capability, record its API operation and platform/account prerequisites, then provide:

1. A reachable UI with correct fields, preview and restriction checks, plus empty/loading/error states.
2. Server-side project/role/account checks, strict inputs and provider-result validation.
3. Retained action identity, duplicate prevention, partial-result handling and review of uncertain writes. Review alone must never replay an external action.
4. Readback or webhook evidence of the actual provider outcome; a submitted request is not delivery.
5. One small runnable regression for non-trivial logic, plus browser evidence for the complete workflow. Accepted-but-unreadable receipts, stale edits, revoked access and retries are required cases.
6. An explicit live-acceptance record with approved test credentials, or a clearly stated provider block. Passing simulated tests does not establish live campaign delivery.

Keep `dev` and `main` permanent. Publish each independently reviewable increment through a tested pull request, merge it and fast-forward both branches to the same release. A growing endpoint inventory must never be presented as a growing count of working features without this evidence.

## Boundaries retained from earlier instructions

- **Voice calling remains excluded**, including PSTN/WhatsApp calls, softphone, recordings/SIP and branded calling, until explicitly re-enabled. The inventory lists those APIs for completeness. Number/SMS/WhatsApp setup remains eligible work.
- Cloudflare email stays **transactional only**; replies route externally to the mailbox/Google Group. No receiving email inbox is added.
- Organic search performance/Search Console remains in **ten98 Discover**. Paid Google campaigns stay here.
- Google Drive DAM, Google Calendar/Maps, Twilio SMS, OOH/Broadsign, OpenRouter and native Google/Microsoft integrations remain part of this app; they are not replaced by the Zernio expansion.
- A new native platform integration is only proposed when the required capability is absent from Zernio. Ask before adding that integration. API-unavailable features, such as standard native Google Video creation, need an honest provider handoff rather than a simulated control.
- Merchant terms, OAuth permission grants, identity verification, payment setup and carrier/platform approvals stay deliberate account-owner steps. Do not use undocumented provider dashboard APIs to bypass them.

The resource-family index below and linked reports are the scope baseline. Recheck the provider changelog/spec before each implementation increment because availability and schemas can change.


## API resource-family index

Every family in the pinned callable-operation inventory appears below. Counts include deprecated aliases and gated operations; the linked report supplies product status and boundaries. This family map is not an endpoint-by-endpoint field audit or a tested completion score. An operation with multiple tags is counted under its first tag; the CSV preserves all tags. Operations are assigned one primary report here to avoid double counting related workflows.

### Social and account lifecycle

Details: [Social and account lifecycle](zernio-social-coverage.md).

| API family | Operations in snapshot |
| --- | ---: |
| Validate | 4 |
| Analytics | 28 |
| Account Groups | 4 |
| Media | 1 |
| Reddit Search | 3 |
| Posts | 10 |
| Profiles | 5 |
| Accounts | 19 |
| Connect | 58 |
| GMB Reviews | 5 |
| GMB Verifications | 4 |
| GMB Food Menus | 2 |
| GMB Location Details | 2 |
| GMB Media | 3 |
| GMB Attributes | 3 |
| GMB Place Actions | 4 |
| GMB Services | 2 |
| LinkedIn Mentions | 1 |
| Instagram | 6 |
| Queue | 6 |
| Twitter Engagement | 8 |
| Tools | 1 |

### Messaging and engagement

Details: [Messaging and engagement](zernio-messaging-coverage.md).

| API family | Operations in snapshot |
| --- | ---: |
| Inbox Analytics | 7 |
| WhatsApp | 49 |
| Discord | 24 |
| Slack | 1 |
| Messages | 18 |
| Account Settings | 18 |
| Comments | 15 |
| Mentions | 2 |
| Reviews | 3 |
| WhatsApp Templates | 1 |
| WhatsApp Sandbox | 3 |
| WhatsApp Flows | 15 |
| Contacts | 7 |
| Custom Fields | 6 |
| Broadcasts | 10 |
| Workflows | 15 |
| Sequences | 10 |
| Comment Automations | 6 |
| Business Agent | 55 |
| Webhooks | 7 |

### Advertising

Details: [Advertising](zernio-ads-coverage.md).

| API family | Operations in snapshot |
| --- | ---: |
| Ad Campaigns | 64 |
| Ad Insights | 11 |
| Ad Creatives | 18 |
| Tracking Tags | 22 |
| Ad Accounts | 63 |
| Reach and Frequency | 4 |
| Lead Gen | 8 |
| Ad Targeting | 6 |
| Ad Library | 1 |
| Product Catalogs | 19 |
| Ad Audiences | 7 |
| Conversions | 21 |
| Messaging Ads | 3 |

### Stores, administration and additional channels

Details: [Stores, administration and additional channels](zernio-commerce-admin-coverage.md).

| API family | Operations in snapshot |
| --- | ---: |
| Usage | 6 |
| Users | 2 |
| API Keys | 4 |
| Feedback | 1 |
| Connected Apps | 2 |
| Invites | 1 |
| Logs | 1 |
| WhatsApp Calling | 16 |
| Calls | 3 |
| Voice | 18 |
| iMessage | 20 |
| SMS | 22 |
| RCS | 13 |
| Branded Calling | 17 |
| WhatsApp Phone Numbers | 17 |
| Phone Numbers | 31 |
| Support Assistant | 3 |
| Blogs | 10 |
| Products | 3 |
| Commerce | 74 |
| Verify | 3 |
| Changelog | 1 |
